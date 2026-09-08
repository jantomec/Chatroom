// Git: project identity, conversation worktrees and refs, snapshots, integrate, sync,
// apply and abort with the pinned invocation, recovery of open operations
// (ARCHITECTURE.md §4.1, §13).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Agent, GitRecord, Log } from "./log.ts";

export interface Run { status: number | null; stdout: string; stderr: string }
export interface Project { gitBin: string; gitVersion: string; commonDir: string; mainWorktree: string; projectId: string; mainBranch: string | null; stateDir: string }

export function findGit(configured: string | null): string {
  if (configured) return configured;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    const p = join(dir, "git");
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  throw new Error("git not found on PATH; set git.binary in the config");
}

export function runGit(bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Run {
  const r = spawnSync(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, input: opts.input, encoding: "utf8", maxBuffer: 64 << 20 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const must = (r: Run, what: string): string => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}`); return r.stdout.trim(); };

export function resolveProject(cwd: string, gitBinary: string | null): Project {
  const gitBin = findGit(gitBinary);
  const gitVersion = must(runGit(gitBin, ["--version"]), "git --version");
  if (must(runGit(gitBin, ["-C", cwd, "rev-parse", "--is-bare-repository"]), "rev-parse") === "true") throw new Error("bare repositories are not supported");
  const commonDir = must(runGit(gitBin, ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]), "not inside a git repository");
  const list = must(runGit(gitBin, ["-C", cwd, "worktree", "list", "--porcelain"]), "worktree list");
  const first = list.split("\n").find((l) => l.startsWith("worktree "));
  if (!first) throw new Error("no worktree found");
  const mainWorktree = first.slice("worktree ".length);
  const projectId = createHash("sha256").update(commonDir).digest("hex").slice(0, 12);
  const branch = runGit(gitBin, [`--git-dir=${commonDir}`, "symbolic-ref", "-q", "--short", "HEAD"]);
  const stateBase = process.env["CHATROOM_STATE_DIR"] ?? process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return { gitBin, gitVersion, commonDir, mainWorktree, projectId, mainBranch: branch.status === 0 ? branch.stdout.trim() : null, stateDir: join(stateBase, "chatroom", projectId) };
}

export interface Conversation { name: string; branches: Record<Agent | "integration", string>; worktrees: Record<Agent | "integration", string>; adminDirs: Record<Agent | "integration", string> }

const identity = { GIT_AUTHOR_NAME: "Chatroom", GIT_AUTHOR_EMAIL: "chatroom@local", GIT_COMMITTER_NAME: "Chatroom", GIT_COMMITTER_EMAIL: "chatroom@local" };

export class Repo {
  readonly p: Project;
  readonly hooksEmpty: string;
  constructor(p: Project) { this.p = p; this.hooksEmpty = join(p.stateDir, "hooks-empty"); mkdirSync(this.hooksEmpty, { recursive: true }); }
  /** Explicit-path git: every command names its repository (G13). */
  git(gitDir: string, workTree: string | null, args: string[], env?: NodeJS.ProcessEnv): Run {
    const a = [`--git-dir=${gitDir}`, ...(workTree ? [`--work-tree=${workTree}`] : []), ...args];
    return runGit(this.p.gitBin, a, { ...(workTree ? { cwd: workTree } : {}), env: { ...process.env, ...identity, ...(env ?? {}) } });
  }
  pinned(gitDir: string, workTree: string, args: string[], env?: NodeJS.ProcessEnv): Run {
    return this.git(gitDir, workTree, ["-c", `core.hooksPath=${this.hooksEmpty}`, "-c", "commit.gpgsign=false", ...args], env);
  }
  merge(gitDir: string, workTree: string, ref: string, message: string | null): Run {
    const args = ["merge", "--no-verify", "--no-gpg-sign", "--no-autostash", "--no-rerere-autoupdate", "--no-ff", ...(message === null ? ["--no-commit"] : ["-m", message]), ref];
    return this.pinned(gitDir, workTree, args);
  }
  refOid(ref: string): string | null { const r = this.git(this.p.commonDir, null, ["rev-parse", "--verify", "-q", ref]); return r.status === 0 ? r.stdout.trim() : null; }
  treeOf(oid: string): string { return must(this.git(this.p.commonDir, null, ["rev-parse", `${oid}^{tree}`]), "tree"); }
  parentsOf(oid: string): string[] { return must(this.git(this.p.commonDir, null, ["rev-list", "--parents", "-n", "1", oid]), "parents").split(" ").slice(1); }
  isAncestor(a: string, b: string): boolean { return this.git(this.p.commonDir, null, ["merge-base", "--is-ancestor", a, b]).status === 0; }
  mainHead(): string {
    if (!this.refOid("HEAD")) throw new Error('this repository has no commits yet; make a first commit (git commit --allow-empty -m "Initial commit" is enough) and run chatroom again');
    return must(this.git(this.p.commonDir, this.p.mainWorktree, ["rev-parse", "HEAD"]), "main HEAD");
  }
  mainBranch(): string | null { const r = this.git(this.p.commonDir, null, ["symbolic-ref", "-q", "--short", "HEAD"]); return r.status === 0 ? r.stdout.trim() : null; }
  headRef(adminDir: string): string | null { const r = this.git(adminDir, null, ["symbolic-ref", "-q", "HEAD"]); return r.status === 0 ? r.stdout.trim() : null; }
  mergeHead(gitDir: string): boolean { return existsSync(join(gitDir, "MERGE_HEAD")); }
  short(oid: string | null): string { return oid ? oid.slice(0, 7) : "-"; }

  /** Create or reuse a conversation's refs and worktrees (§13.1, §4.2). */
  conversation(name: string): Conversation {
    const prefix = `chatroom/${name}`;
    const branches = { claude: `${prefix}/claude`, codex: `${prefix}/codex`, integration: `${prefix}/integration` };
    const base = join(this.p.stateDir, "worktrees", name);
    const worktrees = { claude: join(base, "claude"), codex: join(base, "codex"), integration: join(base, "integration") };
    const head = this.mainHead();
    for (const k of ["claude", "codex", "integration"] as const) {
      if (!this.refOid(`refs/heads/${branches[k]}`)) must(this.git(this.p.commonDir, null, ["update-ref", `refs/heads/${branches[k]}`, head]), `create ${branches[k]}`);
      if (!existsSync(join(worktrees[k], ".git"))) {
        // A registration whose directory is gone (the state directory was deleted) is stale: prune it first.
        runGit(this.p.gitBin, [`--git-dir=${this.p.commonDir}`, "worktree", "prune"]);
        mkdirSync(base, { recursive: true });
        must(runGit(this.p.gitBin, [`--git-dir=${this.p.commonDir}`, "worktree", "add", "-q", worktrees[k], branches[k]]), `worktree add ${k}`);
      }
    }
    const adminDirs = {} as Conversation["adminDirs"];
    for (const k of ["claude", "codex", "integration"] as const) adminDirs[k] = must(runGit(this.p.gitBin, ["-C", worktrees[k], "rev-parse", "--path-format=absolute", "--git-dir"]), `admin dir ${k}`);
    return { name, branches, worktrees, adminDirs };
  }
  removeConversation(c: Conversation): void {
    for (const k of ["claude", "codex", "integration"] as const) {
      if (existsSync(c.worktrees[k])) runGit(this.p.gitBin, [`--git-dir=${this.p.commonDir}`, "worktree", "remove", "--force", c.worktrees[k]]);
      rmSync(c.worktrees[k], { recursive: true, force: true });
      this.git(this.p.commonDir, null, ["update-ref", "-d", `refs/heads/${c.branches[k]}`]);
    }
    runGit(this.p.gitBin, [`--git-dir=${this.p.commonDir}`, "worktree", "prune"]);
    rmSync(join(this.p.stateDir, "worktrees", c.name), { recursive: true, force: true });
  }
  /** Commits on the agent branches that integration lacks, and integration commits main lacks. */
  unintegrated(c: Conversation): { claude: number; codex: number; integration: number } {
    const count = (a: string, b: string) => Number(runGit(this.p.gitBin, [`--git-dir=${this.p.commonDir}`, "rev-list", "--count", `${b}..${a}`]).stdout.trim() || 0);
    return { claude: count(`refs/heads/${c.branches.claude}`, `refs/heads/${c.branches.integration}`), codex: count(`refs/heads/${c.branches.codex}`, `refs/heads/${c.branches.integration}`), integration: count(`refs/heads/${c.branches.integration}`, "HEAD") };
  }
}

export type OpResult = { status: "done" | "skipped" | "refused" | "open" | "failed"; detail: string; oid?: string; paths?: string[] };

/** Snapshots, merges and their records in the log (§13.2 to §13.5). */
export class Workspaces {
  readonly repo: Repo; readonly conv: Conversation; readonly log: Log;
  constructor(repo: Repo, conv: Conversation, log: Log) { this.repo = repo; this.conv = conv; this.log = log; }
  private ref(k: Agent | "integration"): string { return `refs/heads/${this.conv.branches[k]}`; }
  private record(rec: Omit<GitRecord, "id" | "at" | "kind">): void { this.log.append({ kind: "git", ...rec } as any); }

  /** Read every chatroom ref, main and the worktree HEADs; record a `ref` line when something changed. */
  refresh(): { refs: Record<string, string | null>; deviation: string | null } {
    const refs: Record<string, string | null> = {};
    for (const k of ["claude", "codex", "integration"] as const) refs[this.conv.branches[k]] = this.repo.refOid(this.ref(k));
    refs["main"] = this.repo.mainHead();
    const heads: Record<string, string> = {};
    for (const k of ["claude", "codex", "integration"] as const) heads[k] = this.repo.headRef(this.conv.adminDirs[k]) ?? "detached";
    const last = [...this.log.records].reverse().find((r) => r.kind === "ref") as { refs: Record<string, string | null>; heads?: Record<string, string> } | undefined;
    const changed = !last || JSON.stringify(last.refs) !== JSON.stringify(refs) || JSON.stringify(last.heads ?? {}) !== JSON.stringify(heads);
    let deviation: string | null = null;
    if (last && last.refs[this.conv.branches.integration] !== refs[this.conv.branches.integration] && !this.integrationMovedByUs) deviation = `integration moved from ${this.repo.short(last.refs[this.conv.branches.integration] ?? null)} to ${this.repo.short(refs[this.conv.branches.integration] ?? null)} outside the chatroom; /adopt integration or restore it from the reflog`;
    for (const k of ["claude", "codex", "integration"] as const) if (heads[k] === "detached" || heads[k] !== this.ref(k)) deviation = (deviation ? deviation + "; " : "") + `${k} worktree HEAD is ${heads[k]}, expected ${this.ref(k)}`;
    this.integrationMovedByUs = false;
    if (changed) this.log.append({ kind: "ref", refs, heads, ...(deviation ? { deviation } : {}) });
    return { refs, deviation };
  }
  private integrationMovedByUs = false;
  /** The last recorded deviation that has not been adopted. */
  pendingDeviation(): string | null {
    let dev: string | null = null;
    for (const r of this.log.records) { if (r.kind === "ref") dev = r.deviation ?? null; if (r.kind === "git" && r.op === "snapshot" && r.event === "done" && r["adopt"]) dev = null; }
    return dev;
  }
  adopt(what: "main" | "integration"): void {
    this.integrationMovedByUs = true;
    this.log.append({ kind: "git", op: "snapshot", agent: what, event: "done", adopt: true, detail: `adopted ${what} at ${this.repo.short(what === "main" ? this.repo.mainHead() : this.repo.refOid(this.ref("integration")))}` } as any);
    this.refresh();
  }

  workspaceLine(agent: Agent): { own: string; integration: string; peer: string; main: string } {
    const peer = agent === "claude" ? "codex" : "claude";
    return { own: this.repo.short(this.repo.refOid(this.ref(agent))), integration: this.repo.short(this.repo.refOid(this.ref("integration"))), peer: this.repo.short(this.repo.refOid(this.ref(peer))), main: this.repo.short(this.repo.mainHead()) };
  }
  peerChanges(agent: Agent, since: string | null): string[] {
    const peer = agent === "claude" ? "codex" : "claude";
    const r = this.repo.git(this.conv.adminDirs[peer], this.conv.worktrees[peer], ["status", "--porcelain"], { GIT_OPTIONAL_LOCKS: "0" });
    const dirty = r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
    const committed = since ? this.repo.git(this.repo.p.commonDir, null, ["diff", "--name-only", since, this.ref(peer)]).stdout.split("\n").filter(Boolean) : [];
    return [...new Set([...committed, ...dirty])].slice(0, 20);
  }

  /** §13.2: commit the worktree's state on the agent branch, if it changed. */
  snapshot(agent: Agent): OpResult {
    const c = this.conv; const ref = this.ref(agent);
    const tip = this.repo.refOid(ref); if (!tip) return { status: "failed", detail: `${ref} missing` };
    const head = this.repo.headRef(c.adminDirs[agent]);
    if (head !== ref) return { status: "refused", detail: `${agent} worktree HEAD is ${head ?? "detached"}, expected ${ref}; fix it by hand` };
    this.record({ op: "snapshot", agent, event: "started", ref, from: tip });
    const idx = join(this.repo.p.stateDir, `snapshot-${c.name}-${agent}.index`);
    if (existsSync(idx)) rmSync(idx);
    const env = { GIT_INDEX_FILE: idx };
    const g = (args: string[]) => this.repo.git(c.adminDirs[agent], c.worktrees[agent], args, env);
    try {
      must(g(["read-tree", tip]), "read-tree");
      must(g(["add", "-A", "--", "."]), "add");
      const tree = must(g(["write-tree"]), "write-tree");
      if (tree === this.repo.treeOf(tip)) { this.record({ op: "snapshot", agent, event: "skipped", ref, from: tip, detail: "no change" }); return { status: "skipped", detail: "no change", oid: tip }; }
      const oid = must(this.repo.git(this.repo.p.commonDir, null, ["commit-tree", tree, "-p", tip, "-m", `chatroom snapshot of ${agent}`]), "commit-tree");
      must(this.repo.git(this.repo.p.commonDir, null, ["update-ref", ref, oid, tip]), "update-ref");
      must(this.repo.git(c.adminDirs[agent], c.worktrees[agent], ["read-tree", ref]), "align index");
      this.record({ op: "snapshot", agent, event: "done", ref, from: tip, to: oid });
      return { status: "done", detail: `snapshot ${this.repo.short(oid)}`, oid };
    } catch (e) { this.record({ op: "snapshot", agent, event: "failed", ref, detail: String(e) }); return { status: "failed", detail: String(e) }; }
    finally { if (existsSync(idx)) rmSync(idx); }
  }

  /** §13.3: snapshot, then merge the agent branch into the integration worktree. */
  integrate(agent: Agent): OpResult {
    const dev = this.pendingDeviation(); if (dev) return { status: "refused", detail: dev };
    const snap = this.snapshot(agent); if (snap.status === "failed" || snap.status === "refused") return snap;
    return this.mergeInto("integrate", "integration", this.ref(agent), agent);
  }
  /** §13.3: bring main into integration if needed, snapshot, merge integration into the agent branch. */
  sync(agent: Agent): OpResult {
    const dev = this.pendingDeviation(); if (dev) return { status: "refused", detail: dev };
    const main = this.repo.mainHead(); const integ = this.repo.refOid(this.ref("integration"))!;
    if (!this.repo.isAncestor(main, integ)) { const r = this.mergeInto("sync", "integration", main, "main"); if (r.status === "refused" || r.status === "failed") return r; }
    const snap = this.snapshot(agent); if (snap.status === "failed" || snap.status === "refused") return snap;
    return this.mergeInto("sync", agent, this.ref("integration"), "integration");
  }
  private mergeInto(op: "integrate" | "sync", into: Agent | "integration", source: string, label: string): OpResult {
    const c = this.conv; const target = this.ref(into);
    const before = this.repo.refOid(target)!; const src = this.repo.refOid(source) ?? source;
    if (this.repo.isAncestor(src, before)) { this.record({ op, agent: into, event: "skipped", ref: target, from: before, source: src, detail: `${label} already integrated` }); return { status: "skipped", detail: `${label} is already in ${into}`, oid: before }; }
    this.record({ op, agent: into, event: "started", ref: target, from: before, source: src });
    if (into === "integration") this.integrationMovedByUs = true;
    const r = this.repo.merge(c.adminDirs[into], c.worktrees[into], src, `chatroom: merge ${label} into ${into}`);
    if (r.status !== 0) {
      const paths = this.repo.git(c.adminDirs[into], c.worktrees[into], ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
      if (op === "integrate") { this.repo.pinned(c.adminDirs[into], c.worktrees[into], ["merge", "--abort"]); this.record({ op, agent: into, event: "failed", ref: target, from: before, source: src, paths, detail: "conflict; aborted" }); return { status: "refused", detail: `conflict in ${paths.join(", ") || "the merge"}; integration unchanged`, paths }; }
      this.record({ op, agent: into, event: "open", ref: target, from: before, source: src, paths, detail: "conflict" });
      return { status: "open", detail: `conflict in ${paths.join(", ") || "the merge"}; resolve by /sync --abort ${into}`, paths };
    }
    const after = this.repo.refOid(target)!;
    this.record({ op, agent: into, event: "done", ref: target, from: before, to: after, source: src });
    return { status: "done", detail: `${into} at ${this.repo.short(after)}`, oid: after };
  }
  syncAbort(agent: Agent): OpResult {
    const c = this.conv;
    if (!this.repo.mergeHead(c.adminDirs[agent])) return { status: "skipped", detail: "no merge in progress" };
    const r = this.repo.pinned(c.adminDirs[agent], c.worktrees[agent], ["merge", "--abort"]);
    this.record({ op: "sync_abort", agent, event: r.status === 0 ? "done" : "failed", detail: r.stderr.trim() });
    return r.status === 0 ? { status: "done", detail: "sync aborted; the snapshot is the tip" } : { status: "failed", detail: r.stderr.trim() };
  }

  /** §13.4: the collision preflight, then merge --no-commit in the main worktree. */
  apply(agent: Agent | null): OpResult {
    const dev = this.pendingDeviation(); if (dev) return { status: "refused", detail: dev };
    if (agent) { const r = this.integrate(agent); if (r.status === "failed" || r.status === "refused" || r.status === "open") return r; }
    const p = this.repo.p; const tip = this.repo.refOid(this.ref("integration"))!;
    const head = this.repo.mainHead();
    if (this.repo.isAncestor(tip, head)) return { status: "skipped", detail: "main already contains integration" };
    for (const f of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) if (existsSync(join(p.commonDir, f))) return { status: "refused", detail: `${f} exists in the main worktree; finish or abort that first` };
    const branch = this.repo.mainBranch();
    const recorded = this.recordedMainBranch();
    if (recorded && branch !== recorded) return { status: "refused", detail: `main's branch is ${branch ?? "detached"}, the conversation started on ${recorded}; /adopt main to continue` };
    const staged = this.repo.git(p.commonDir, p.mainWorktree, ["diff", "--cached", "--name-only"]).stdout.trim();
    if (staged) return { status: "refused", detail: `staged changes in main: ${staged.split("\n").join(", ")}`, paths: staged.split("\n") };
    const conflicts = this.preflight(tip);
    if (conflicts.length) { this.record({ op: "apply", event: "refused", paths: conflicts, detail: "preflight" }); return { status: "refused", detail: `these paths in main would be overwritten or are in the way: ${conflicts.join(", ")}`, paths: conflicts }; }
    this.record({ op: "apply", event: "started", from: head, source: tip });
    const r = this.repo.merge(p.commonDir, p.mainWorktree, tip, null);
    const index = this.repo.git(p.commonDir, p.mainWorktree, ["ls-files", "-s"]).stdout;
    this.record({ op: "apply", event: r.status === 0 ? "open" : "failed", from: head, source: tip, index, git: (r.stdout + r.stderr).trim().slice(0, 500) });
    if (r.status !== 0) return { status: "failed", detail: (r.stderr || r.stdout).trim() };
    return { status: "open", detail: "merged into main, not committed: review with git diff --cached, then commit, or /apply --abort" };
  }
  /** Paths the merge would add that exist in main, or would change that are dirty against HEAD. */
  preflight(tip: string): string[] {
    const p = this.repo.p;
    const base = must(this.repo.git(p.commonDir, p.mainWorktree, ["merge-base", "HEAD", tip]), "merge-base");
    const changes = this.repo.git(p.commonDir, p.mainWorktree, ["diff", "--name-status", base, tip]).stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
    const dirty = new Set(this.repo.git(p.commonDir, p.mainWorktree, ["status", "--porcelain", "--ignored", "--untracked-files=all"]).stdout.split("\n").filter(Boolean).map((l) => l.slice(3)));
    const out: string[] = [];
    for (const [st, a, b] of changes) {
      const path = (st?.startsWith("R") ? b : a) ?? "";
      if (!path) continue;
      if (st?.startsWith("A") || st?.startsWith("R")) { if (existsSync(join(p.mainWorktree, path))) out.push(path); }
      else if (dirty.has(path)) out.push(path);
    }
    return out;
  }
  private recordedMainBranch(): string | null {
    const r = this.log.records.find((x) => x.kind === "note" && (x as any).main_branch !== undefined) as any;
    return r ? r.main_branch : null;
  }
  /** §13.4: refuse when the index changed or was never recorded; otherwise git merge --abort. */
  applyAbort(): OpResult {
    const p = this.repo.p;
    if (!this.repo.mergeHead(p.commonDir)) return { status: "skipped", detail: "no merge in progress in main" };
    const open = [...this.log.records].reverse().find((r) => r.kind === "git" && r.op === "apply" && r.event === "open") as (GitRecord & { index?: string }) | undefined;
    if (!open || typeof open.index !== "string") return { status: "refused", detail: "the post-merge index was not recorded (the process died between the merge and its record); abort by hand with git merge --abort after checking git status" };
    const now = this.repo.git(p.commonDir, p.mainWorktree, ["ls-files", "-s"]).stdout;
    if (now !== open.index) {
      const a = new Set(open.index.split("\n")); const changed = now.split("\n").filter((l) => l && !a.has(l)).map((l) => l.split("\t")[1]);
      this.record({ op: "apply_abort", event: "refused", paths: changed, detail: "index changed after the merge" });
      return { status: "refused", detail: `the index changed after the merge (${changed.join(", ")}); unstage or commit, then abort by hand`, paths: changed as string[] };
    }
    const r = this.repo.pinned(p.commonDir, p.mainWorktree, ["merge", "--abort"]);
    this.record({ op: "apply_abort", event: r.status === 0 ? "done" : "failed", detail: r.stderr.trim() });
    return r.status === 0 ? { status: "done", detail: "apply aborted; main is back to HEAD" } : { status: "failed", detail: `git merge --abort: ${r.stderr.trim()}` };
  }
  /** Was an open apply completed by the user (a merge commit above the recorded HEAD)? Closes it in the log. */
  settleOpenApply(): string | null {
    const open = this.openOperations().find((o) => o.op === "apply");
    if (!open) return null;
    const p = this.repo.p;
    if (this.repo.mergeHead(p.commonDir)) return `an /apply is open in main: review with git diff --cached, commit, or /apply --abort`;
    const head = this.repo.mainHead();
    if (head !== open.from) { const ps = this.repo.parentsOf(head); if (ps[0] === open.from && ps[1] === open.source) { this.record({ op: "apply", event: "done", from: open.from, source: open.source, to: head, detail: "committed by the user" }); return null; } }
    if (head === open.from) { this.record({ op: "apply", event: "failed", from: open.from, source: open.source, detail: "merge no longer in progress; run /apply again" }); return `an /apply was interrupted before or after its merge; main is at ${this.repo.short(head)} with no merge in progress, run /apply again`; }
    this.record({ op: "apply", event: "failed", from: open.from, source: open.source, detail: `main moved to ${head}` });
    return `an /apply was open and main has moved to ${this.repo.short(head)}; check git log and run /apply again when ready`;
  }
  /** Operations with a start and no end. */
  openOperations(): (GitRecord & { from?: string; source?: string })[] {
    const open = new Map<string, GitRecord>();
    for (const r of this.log.records) {
      if (r.kind !== "git") continue;
      const key = `${r.op}:${r.agent ?? ""}`;
      if (r.event === "started") open.set(key, r); else if (r.event !== "open" || r.op !== "apply") open.delete(key);
      if (r.op === "apply" && r.event === "open") open.set(key, r);
      if (r.op === "apply" && (r.event === "done" || r.event === "failed")) open.delete(key);
    }
    return [...open.values()] as any;
  }
  /** §13.5 on startup: rerun idempotent operations left open; report an open apply. */
  recover(): string[] {
    const notes: string[] = [];
    const c = this.conv;
    for (const k of ["claude", "codex", "integration"] as const) {
      if (this.repo.mergeHead(c.adminDirs[k])) { this.repo.pinned(c.adminDirs[k], c.worktrees[k], ["merge", "--abort"]); notes.push(`aborted a merge left open in the ${k} worktree`); }
    }
    for (const o of this.openOperations()) {
      if (o.op === "apply") continue;
      const agent = (o.agent ?? "") as Agent | "integration";
      this.record({ op: o.op as any, agent, event: "failed", detail: "left open by a crash; rerun" });
      if (o.op === "snapshot" && (agent === "claude" || agent === "codex")) { const r = this.snapshot(agent); notes.push(`reran snapshot of ${agent}: ${r.detail}`); }
      else if (o.op === "integrate" || o.op === "sync") notes.push(`${o.op} of ${agent} was interrupted and its merge undone; run it again`);
    }
    const a = this.settleOpenApply(); if (a) notes.push(a);
    return notes;
  }
  /** Delete the conversation's temporary files. */
  static writeMainBranchNote(log: Log, branch: string | null): void { log.append({ kind: "note", text: `conversation created on main branch ${branch ?? "(detached)"}`, main_branch: branch } as any); }
}

export function shortPath(p: string): string { const h = homedir(); return p.startsWith(h) ? "~" + p.slice(h.length) : p; }
export { basename, resolve, readFileSync, writeFileSync };

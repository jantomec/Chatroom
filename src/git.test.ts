import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Log } from "./log.ts";
import { Repo, Workspaces, resolveProject } from "./git.ts";

const GIT = process.env["CHATROOM_TEST_GIT"] ?? "/opt/homebrew/bin/git";
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, args: string[]) => execFileSync(GIT, args, { cwd, env, encoding: "utf8" }).trim();

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "chatroom-git-"));
  const main = realpathSync(root) + "/repo"; mkdirSync(main);
  sh(main, ["init", "-q", "-b", "main"]);
  writeFileSync(join(main, "README.md"), "# lab\n"); mkdirSync(join(main, "src")); writeFileSync(join(main, "src", "app.txt"), "line1\nline2\n"); writeFileSync(join(main, ".gitignore"), "ignored.txt\n");
  sh(main, ["add", "-A"]); sh(main, ["commit", "-q", "-m", "base"]);
  process.env["CHATROOM_STATE_DIR"] = join(root, "state");
  const project = resolveProject(main, GIT);
  const repo = new Repo(project);
  const conv = repo.conversation("t1");
  const log = new Log(join(root, "log.jsonl"));
  Workspaces.writeMainBranchNote(log, project.mainBranch);
  const ws = new Workspaces(repo, conv, log);
  return { root, main, repo, conv, log, ws, base: sh(main, ["rev-parse", "HEAD"]) };
}
const dirty = (wt: string) => { writeFileSync(join(wt, "src", "app.txt"), "line1\nline2\nagent edit\n"); writeFileSync(join(wt, "new.txt"), "new\n"); writeFileSync(join(wt, "ignored.txt"), "ignored\n"); };

test("an empty repository gets an empty first commit on main; the index is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "chatroom-git-")); const main = realpathSync(root) + "/repo"; mkdirSync(main);
  sh(main, ["init", "-q", "-b", "main"]);
  writeFileSync(join(main, "a.txt"), "a\n"); sh(main, ["add", "a.txt"]);
  process.env["CHATROOM_STATE_DIR"] = join(root, "state");
  const saved = { ...process.env }; Object.assign(process.env, env);   // the user's identity, as git would see it
  try {
    const conv = new Repo(resolveProject(main, GIT)).conversation("t1");
    assert.equal(conv.rootCommit, sh(main, ["rev-parse", "HEAD"]));
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  assert.equal(sh(main, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(sh(main, ["ls-tree", "HEAD"]), "");                        // the commit is empty
  assert.equal(sh(main, ["diff", "--cached", "--name-only"]), "a.txt");   // what was staged is still staged
  assert.equal(sh(main, ["log", "-1", "--format=%an <%ae>"]), "T <t@x>");  // authored as the user
  assert.equal(sh(main, ["worktree", "list"]).split("\n").length, 4);
});
test("project resolution and conversation layout", () => {
  const { repo, conv, main, base } = scratch();
  assert.equal(repo.p.mainWorktree, realpathSync(main)); assert.equal(repo.p.mainBranch, "main");
  for (const k of ["claude", "codex", "integration"] as const) { assert.equal(repo.refOid(`refs/heads/${conv.branches[k]}`), base); assert.ok(existsSync(join(conv.worktrees[k], ".git"))); assert.equal(repo.headRef(conv.adminDirs[k]), `refs/heads/${conv.branches[k]}`); }
  assert.equal(repo.conversation("t1").worktrees.claude, conv.worktrees.claude, "reuse is idempotent");
});

test("snapshot commits the dirty worktree once, skips when unchanged, keeps ignored files out, aligns the index", () => {
  const { repo, conv, ws, base } = scratch();
  dirty(conv.worktrees.claude);
  const r = ws.snapshot("claude");
  assert.equal(r.status, "done"); assert.notEqual(r.oid, base);
  assert.deepEqual(repo.parentsOf(r.oid!), [base]);
  assert.equal(sh(conv.worktrees.claude, ["status", "--porcelain"]), "", "index aligned, tree clean");
  assert.ok(!sh(conv.worktrees.claude, ["ls-tree", "-r", "--name-only", "HEAD"]).includes("ignored.txt"));
  assert.equal(ws.snapshot("claude").status, "skipped");
  assert.equal(ws.log.records.filter((x) => x.kind === "git" && x.op === "snapshot" && x.event === "done").length, 1);
});

test("integrate merges the snapshot into integration; a second integrate is skipped; sync brings integration into the other agent", () => {
  const { repo, conv, ws, base } = scratch();
  dirty(conv.worktrees.claude);
  const r = ws.integrate("claude");
  assert.equal(r.status, "done");
  const integ = repo.refOid(`refs/heads/${conv.branches.integration}`)!;
  const ps = repo.parentsOf(integ);
  assert.equal(ps[0], base); assert.equal(ps[1], repo.refOid(`refs/heads/${conv.branches.claude}`));
  assert.equal(ws.integrate("claude").status, "skipped");
  const s = ws.sync("codex");
  assert.equal(s.status, "done");
  assert.ok(existsSync(join(conv.worktrees.codex, "new.txt")), "codex worktree now has clara's file");
  assert.deepEqual(repo.unintegrated(conv), { claude: 0, codex: 1, integration: 2 }, "sync leaves a merge commit on the codex branch");
});

test("integrate conflict is aborted and reported; sync conflict stays open until /sync --abort", () => {
  const { conv, ws, main } = scratch();
  writeFileSync(join(conv.worktrees.integration, "src", "app.txt"), "line1\nline2\nintegration edit\n");
  sh(conv.worktrees.integration, ["add", "-A"]); sh(conv.worktrees.integration, ["commit", "-q", "-m", "integ"]);
  dirty(conv.worktrees.claude);
  const r = ws.integrate("claude");
  assert.equal(r.status, "refused"); assert.deepEqual(r.paths, ["src/app.txt"]);
  assert.ok(!existsSync(join(conv.adminDirs.integration, "MERGE_HEAD")));
  // sync codex: codex edits the same file, integration has the conflicting commit
  writeFileSync(join(conv.worktrees.codex, "src", "app.txt"), "line1\nline2\ncodex edit\n");
  const s = ws.sync("codex");
  assert.equal(s.status, "open");
  assert.ok(existsSync(join(conv.adminDirs.codex, "MERGE_HEAD")));
  assert.equal(ws.syncAbort("codex").status, "done");
  assert.ok(!existsSync(join(conv.adminDirs.codex, "MERGE_HEAD")));
  void main;
});

test("apply: the six main-worktree states, then abort with an unchanged and a changed index", () => {
  const { conv, ws, main, repo } = scratch();
  dirty(conv.worktrees.claude);
  assert.equal(ws.integrate("claude").status, "done");
  // 1. unstaged edit on a file the tip does not touch: proceeds, edit preserved
  writeFileSync(join(main, "README.md"), "# lab edited\n");
  let r = ws.apply(null);
  assert.equal(r.status, "open", r.detail);
  assert.ok(existsSync(join(repo.p.commonDir, "MERGE_HEAD")));
  assert.equal(sh(main, ["show", ":new.txt"]), "new");
  assert.equal(sh(main, ["diff", "--name-only"]), "README.md", "the user's edit is still unstaged");
  // 5. a previous apply not yet committed: refused
  assert.equal(ws.apply(null).status, "refused");
  // abort with an unchanged index succeeds
  assert.equal(ws.applyAbort().status, "done");
  assert.ok(!existsSync(join(repo.p.commonDir, "MERGE_HEAD")));
  assert.equal(sh(main, ["diff", "--name-only"]), "README.md");
  // 2. unstaged edit on a file the tip changes: refused by preflight
  writeFileSync(join(main, "src", "app.txt"), "line1\nline2\nuser edit\n");
  r = ws.apply(null); assert.equal(r.status, "refused"); assert.deepEqual(r.paths, ["src/app.txt"]);
  sh(main, ["checkout", "--", "src/app.txt"]);
  // 3. untracked and ignored files the tip would create: refused by preflight
  writeFileSync(join(main, "new.txt"), "in the way\n");
  r = ws.apply(null); assert.equal(r.status, "refused"); assert.deepEqual(r.paths, ["new.txt"]);
  execFileSync("rm", [join(main, "new.txt")]);
  // 4. any staged change: refused
  writeFileSync(join(main, "staged.txt"), "s\n"); sh(main, ["add", "staged.txt"]);
  r = ws.apply(null); assert.equal(r.status, "refused"); assert.match(r.detail, /staged/);
  sh(main, ["reset", "-q", "staged.txt"]); execFileSync("rm", [join(main, "staged.txt")]);
  // abort refuses when the index changed after the merge
  assert.equal(ws.apply(null).status, "open");
  writeFileSync(join(main, "unrelated.txt"), "x\n"); sh(main, ["add", "unrelated.txt"]);
  r = ws.applyAbort(); assert.equal(r.status, "refused"); assert.deepEqual(r.paths, ["unrelated.txt"]);
  assert.ok(existsSync(join(repo.p.commonDir, "MERGE_HEAD")));
  sh(main, ["reset", "-q", "unrelated.txt"]); execFileSync("rm", [join(main, "unrelated.txt")]);
  assert.equal(ws.applyAbort().status, "done");
  // 6. previous apply committed, tip advanced on the same file: clean merge
  assert.equal(ws.apply(null).status, "open");
  sh(main, ["commit", "-q", "--no-verify", "-m", "apply"]);
  assert.equal(ws.settleOpenApply(), null);
  writeFileSync(join(conv.worktrees.claude, "src", "app.txt"), "line1\nline2\nagent edit\nmore\n");
  assert.equal(ws.integrate("claude").status, "done");
  r = ws.apply(null); assert.equal(r.status, "open", r.detail);
  sh(main, ["commit", "-q", "--no-verify", "-m", "apply 2"]);
  assert.equal(ws.apply(null).status, "skipped");
});

test("recovery: an open snapshot is rerun, a merge left in a chatroom worktree is aborted, an open apply is reported and settled", () => {
  const { conv, ws, log, repo, main } = scratch();
  dirty(conv.worktrees.claude);
  // a snapshot that started and never ended
  log.append({ kind: "git", op: "snapshot", agent: "claude", event: "started", ref: `refs/heads/${conv.branches.claude}` } as any);
  const notes = ws.recover();
  assert.ok(notes.some((n) => /reran snapshot of claude: snapshot/.test(n)), notes.join("|"));
  assert.equal(ws.openOperations().length, 0);
  // an apply left open, then committed by the user: settled as done
  assert.equal(ws.integrate("claude").status, "done");
  assert.equal(ws.apply(null).status, "open");
  const before = ws.recover(); assert.ok(before.some((n) => /apply is open in main/.test(n)));
  sh(main, ["commit", "-q", "--no-verify", "-m", "user commits the merge"]);
  assert.deepEqual(ws.recover(), []);
  assert.ok(log.records.some((r) => r.kind === "git" && r.op === "apply" && r.event === "done"));
  void repo;
});

test("ref expectations: integration moved outside the chatroom is a deviation until adopted", () => {
  const { conv, ws, repo } = scratch();
  ws.refresh();
  writeFileSync(join(conv.worktrees.integration, "x.txt"), "x\n");
  sh(conv.worktrees.integration, ["add", "-A"]); sh(conv.worktrees.integration, ["commit", "-q", "-m", "someone"]);
  const { deviation } = ws.refresh();
  assert.match(deviation ?? "", /integration moved/);
  assert.equal(ws.integrate("claude").status, "refused");
  ws.adopt("integration");
  assert.equal(ws.pendingDeviation(), null);
  dirty(conv.worktrees.claude);
  assert.equal(ws.integrate("claude").status, "done");
  void repo;
});

// Phase 0 item 7: the §16.7 recovery classification against a crash injected after each
// step of every operation, including a crash between a main merge and its transaction.
// Model-free. Steps run with pinned explicit-path git (§16.0); a "crash" stops execution
// either after the git command but before its step row is recorded (flavor "unrecorded")
// or after recording (flavor "recorded"). Recovery classifies from git state and the rows,
// then resumes; the end state must equal the uncrashed run.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLab, refOid, type Lab } from "./lib/lab.ts";
import { GIT, HOME, Recorder, git, must, run, type RunResult } from "./lib/util.ts";

const rec = new Recorder("07-recovery");
rec.note("git", run(GIT, ["--version"]).stdout.trim());
const LAB_BASE = join(HOME, ".local/state/chatroom-probes");

type StepKind = "tree_write" | "commit_write" | "ref_cas" | "index_align" | "preflight" | "merge" | "abort";
type StepStatus = "planned" | "executing" | "done" | "needs_user" | "failed";
interface Step { kind: StepKind; targetRef?: string | undefined; expectedOldOid?: string | undefined; sourceOid?: string | undefined; candidateOid?: string | undefined; resultOid?: string | undefined; status: StepStatus; message?: string | undefined; postMergeIndex?: string | undefined; recordedHead?: string | undefined; where?: "agent" | "integration" | "main" | undefined }
interface Ctx { lab: Lab; agentDir: string; agentWt: string; integDir: string; integWt: string; tmpIndex: string }
const statusOf = (s: Step): StepStatus => s.status;

const pinned = (gitDir: string, wt: string, lab: Lab) => [`--git-dir=${gitDir}`, `--work-tree=${wt}`, "-c", `core.hooksPath=${join(lab.authority, "hooks-empty")}`, "-c", "commit.gpgsign=false"];
const mergeArgs = (msg: string, ref: string, noCommit: boolean) => ["merge", "--no-verify", "--no-gpg-sign", "--no-autostash", "--no-rerere-autoupdate", "--no-ff", ...(noCommit ? ["--no-commit"] : ["-m", msg]), ref];
const g = (args: string[], env?: NodeJS.ProcessEnv): RunResult => run(GIT, args, env ? { env } : {});
const treeOf = (lab: Lab, oid: string) => must(git(lab.commonDir, null, ["rev-parse", `${oid}^{tree}`]), "tree");
const parentsOf = (lab: Lab, oid: string) => must(git(lab.commonDir, null, ["rev-list", "--parents", "-n", "1", oid]), "parents").split(" ").slice(1);
const objectExists = (lab: Lab, oid: string) => git(lab.commonDir, null, ["cat-file", "-e", oid]).status === 0;
const indexTree = (gitDir: string, wt: string) => must(g([`--git-dir=${gitDir}`, `--work-tree=${wt}`, "write-tree"]), "write-tree");
const lsFilesStaged = (gitDir: string, wt: string) => must(g([`--git-dir=${gitDir}`, `--work-tree=${wt}`, "ls-files", "-s"]), "ls-files");
const mergeHeadPresent = (gitDir: string) => existsSync(join(gitDir, "MERGE_HEAD"));
const mainHead = (lab: Lab) => must(git(lab.commonDir, lab.main, ["rev-parse", "HEAD"]), "head");
const chatroomIdentity = { ...process.env, GIT_AUTHOR_NAME: "Chatroom", GIT_AUTHOR_EMAIL: "chatroom@local", GIT_COMMITTER_NAME: "Chatroom", GIT_COMMITTER_EMAIL: "chatroom@local" };

// ---------- step executors (mutate the step; the caller decides whether the row was "recorded") ----------
function execStep(ctx: Ctx, s: Step, opts: { crashBeforeRecord: boolean }): void {
  const { lab } = ctx;
  s.status = "executing";
  switch (s.kind) {
    case "tree_write": {
      const env = { ...process.env, GIT_INDEX_FILE: ctx.tmpIndex };
      if (existsSync(ctx.tmpIndex)) rmSync(ctx.tmpIndex);
      must(g([`--git-dir=${ctx.agentDir}`, `--work-tree=${ctx.agentWt}`, "read-tree", s.sourceOid!], env), "read-tree");
      must(g([`--git-dir=${ctx.agentDir}`, `--work-tree=${ctx.agentWt}`, "add", "-A", "--", "."], env), "add");
      s.resultOid = must(g([`--git-dir=${ctx.agentDir}`, `--work-tree=${ctx.agentWt}`, "write-tree"], env), "write-tree");
      if (!opts.crashBeforeRecord) s.status = "done"; return;
    }
    case "commit_write": {
      const oid = must(git(lab.commonDir, null, ["commit-tree", s.sourceOid!, "-p", s.expectedOldOid!, "-m", "chatroom snapshot"], { env: chatroomIdentity }), "commit-tree");
      if (opts.crashBeforeRecord) return;            // the candidate object exists, the row never learned its oid
      s.candidateOid = oid; s.status = "done"; return;
    }
    case "ref_cas": {
      const r = git(lab.commonDir, null, ["update-ref", s.targetRef!, s.candidateOid!, s.expectedOldOid!]);
      if (r.status !== 0) { s.status = "needs_user"; s.message = r.stderr.trim(); return; }
      if (opts.crashBeforeRecord) return;
      s.resultOid = s.candidateOid; s.status = "done"; return;
    }
    case "index_align": {
      must(g([`--git-dir=${ctx.agentDir}`, `--work-tree=${ctx.agentWt}`, "read-tree", s.targetRef!]), "read-tree align");
      if (!opts.crashBeforeRecord) s.status = "done"; return;
    }
    case "preflight": {
      const base = must(git(lab.commonDir, lab.main, ["merge-base", "HEAD", s.sourceOid!]), "merge-base");
      const changes = must(git(lab.commonDir, lab.main, ["diff", "--name-status", base, s.sourceOid!]), "diff").split("\n").filter(Boolean).map((l) => l.split("\t"));
      const dirty = must(git(lab.commonDir, lab.main, ["status", "--porcelain", "--ignored", "--untracked-files=all"]), "status").split("\n").filter(Boolean).map((l) => l.slice(3));
      const conflicts = changes.filter(([st, p]) => (st?.startsWith("A") && existsSync(join(lab.main, p!))) || (!st?.startsWith("A") && dirty.includes(p!))).map(([, p]) => p);
      if (conflicts.length) { s.status = "needs_user"; s.message = `preflight: ${conflicts.join(", ")}`; return; }
      if (!opts.crashBeforeRecord) s.status = "done"; return;
    }
    case "merge": {
      if (s.where === "main") {
        s.recordedHead = mainHead(lab);
        const r = g([...pinned(lab.commonDir, lab.main, lab), ...mergeArgs("", s.sourceOid!, true)]);
        s.message = (r.stdout + r.stderr).trim();
        if (opts.crashBeforeRecord) return;          // the crash between the merge and its transaction
        s.postMergeIndex = lsFilesStaged(lab.commonDir, lab.main);
        s.status = r.status === 0 ? "done" : "needs_user"; return;
      }
      const gitDir = s.where === "integration" ? ctx.integDir : ctx.agentDir; const wt = s.where === "integration" ? ctx.integWt : ctx.agentWt;
      const r = g([...pinned(gitDir, wt, lab), ...mergeArgs(`chatroom ${s.where} merge`, s.sourceOid!, false)]);
      s.message = (r.stdout + r.stderr).trim();
      if (r.status !== 0) { s.status = "needs_user"; return; }
      if (opts.crashBeforeRecord) return;
      s.resultOid = refOid(lab, s.targetRef!) ?? undefined; s.status = "done"; return;
    }
    case "abort": {
      if (s.postMergeIndex === undefined) { s.status = "needs_user"; s.message = "post-merge index unrecorded"; return; }
      const current = lsFilesStaged(lab.commonDir, lab.main);
      if (current !== s.postMergeIndex) { s.status = "needs_user"; s.message = "index changed after the merge"; return; }
      const r = g([...pinned(lab.commonDir, lab.main, lab), "merge", "--abort"]);
      if (r.status !== 0) { s.status = "needs_user"; s.message = r.stderr.trim(); return; }
      if (!opts.crashBeforeRecord) s.status = "done"; return;
    }
  }
}

// ---------- the §16.7 classifier ----------
type Classification = "rerun" | "done" | "needs_user" | "abort_failed" | "rerun_after_preflight" | "done_by_user";
function classify(ctx: Ctx, s: Step): Classification {
  const { lab } = ctx;
  if (statusOf(s) === "done") return "done";
  if (statusOf(s) === "needs_user" || statusOf(s) === "failed") return "needs_user";
  switch (s.kind) {
    case "tree_write": case "preflight": return "rerun";
    case "commit_write": return s.candidateOid && objectExists(lab, s.candidateOid) ? "done" : "rerun";
    case "ref_cas": { const cur = refOid(lab, s.targetRef!); if (cur === s.expectedOldOid) return "rerun"; if (cur === s.candidateOid) return "done"; return "needs_user"; }
    case "index_align": { const t = indexTree(ctx.agentDir, ctx.agentWt); return t === treeOf(lab, refOid(lab, s.targetRef!)!) ? "done" : "rerun"; }
    case "merge": {
      if (s.where === "main") {
        if (mergeHeadPresent(lab.commonDir)) return "needs_user";
        const head = mainHead(lab);
        if (head !== s.recordedHead) { const ps = parentsOf(lab, head); if (ps.length === 2 && ps[0] === s.recordedHead && ps[1] === s.sourceOid) return "done_by_user"; return "needs_user"; }
        const idx = indexTree(lab.commonDir, lab.main);
        return idx === treeOf(lab, head) ? "rerun_after_preflight" : "needs_user";
      }
      const gitDir = s.where === "integration" ? ctx.integDir : ctx.agentDir;
      const tip = refOid(lab, s.targetRef!)!;
      if (tip !== s.expectedOldOid) { const ps = parentsOf(lab, tip); if (ps[0] === s.expectedOldOid && ps[1] === s.sourceOid) return "done"; return "needs_user"; }
      if (mergeHeadPresent(gitDir)) return "abort_failed";
      return "rerun";
    }
    case "abort": return mergeHeadPresent(lab.commonDir) ? "rerun" : "done";
  }
}

// ---------- operations as step plans ----------
function snapshotPlan(ctx: Ctx, branchRef: string): Step[] {
  const tip = refOid(ctx.lab, branchRef)!;
  return [
    { kind: "tree_write", sourceOid: tip, status: "planned" },
    { kind: "commit_write", expectedOldOid: tip, status: "planned" },           // sourceOid (tree) filled after tree_write
    { kind: "ref_cas", targetRef: branchRef, expectedOldOid: tip, status: "planned" },
    { kind: "index_align", targetRef: branchRef, status: "planned" },
  ];
}
/** Fill a step's inputs from its predecessors; returns true when the step short-circuits to done. */
function prepareStep(ctx: Ctx, steps: Step[], i: number): boolean {
  const s = steps[i]!;
  if (s.kind === "commit_write") {
    const tw = steps[i - 1]!;
    if (tw.resultOid === treeOf(ctx.lab, tw.sourceOid!)) { s.status = "done"; s.message = "no change"; const rc = steps[i + 1]!; rc.status = "done"; rc.message = "no change"; return true; }
    s.sourceOid = tw.resultOid; s.candidateOid = undefined;
  }
  if (s.kind === "ref_cas") s.candidateOid = steps[i - 1]!.candidateOid;
  return false;
}
/** Run the plan; crash (stop) after step `crashAt`. Returns true when the crash fired. */
function runPlan(ctx: Ctx, steps: Step[], crashAt: number, flavor: "recorded" | "unrecorded", log: string[]): boolean {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (statusOf(s) === "done") continue;
    if (prepareStep(ctx, steps, i)) { log.push(`  step ${i} ${s.kind} -> done (no change)`); continue; }
    const crashNow = i === crashAt;
    execStep(ctx, s, { crashBeforeRecord: crashNow && flavor === "unrecorded" });
    log.push(`  step ${i} ${s.kind}${s.where ? "@" + s.where : ""} -> ${statusOf(s)}${s.message ? " (" + s.message.split("\n")[0] + ")" : ""}`);
    if (statusOf(s) === "needs_user" || statusOf(s) === "failed") return false;
    if (crashNow) return true;
  }
  return false;
}
function recover(ctx: Ctx, steps: Step[], log: string[]): { classifications: Classification[]; outcome: "done" | "needs_user" | "failed" } {
  const classifications: Classification[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const c: Classification = statusOf(s) === "planned" ? "rerun" : classify(ctx, s);
    classifications.push(c);
    log.push(`  recover step ${i} ${s.kind}: ${statusOf(s)} -> ${c}`);
    if (c === "done" || c === "done_by_user") { s.status = "done"; continue; }
    if (c === "needs_user") { s.status = "needs_user"; return { classifications, outcome: "needs_user" }; }
    if (c === "abort_failed") { const gitDir = s.where === "integration" ? ctx.integDir : ctx.agentDir; const wt = s.where === "integration" ? ctx.integWt : ctx.agentWt; g([...pinned(gitDir, wt, ctx.lab), "merge", "--abort"]); s.status = "failed"; return { classifications, outcome: "failed" }; }
    if (c === "rerun_after_preflight") { const pf = steps.find((x) => x.kind === "preflight")!; execStep(ctx, pf, { crashBeforeRecord: false }); log.push(`  fresh preflight -> ${statusOf(pf)}${pf.message ? " (" + pf.message + ")" : ""}`); if (statusOf(pf) !== "done") return { classifications, outcome: "needs_user" }; }
    if (prepareStep(ctx, steps, i)) { log.push(`  rerun step ${i} ${s.kind} -> done (no change)`); continue; }
    execStep(ctx, s, { crashBeforeRecord: false });
    log.push(`  rerun step ${i} ${s.kind} -> ${statusOf(s)}`);
    if (statusOf(s) !== "done") return { classifications, outcome: statusOf(s) === "needs_user" ? "needs_user" : "failed" };
  }
  return { classifications, outcome: "done" };
}

function freshCtx(name: string): Ctx {
  const lab = buildLab(join(LAB_BASE, `lab07-${name}`));
  return { lab, agentDir: lab.adminDirs.claude, agentWt: lab.worktrees.claude, integDir: lab.adminDirs.integration, integWt: lab.worktrees.integration, tmpIndex: join(lab.runtime, "snapshot.index") };
}
function dirtyAgent(ctx: Ctx): void {
  writeFileSync(join(ctx.agentWt, "src", "app.txt"), "line1\nline2\nagent edit\n");
  writeFileSync(join(ctx.agentWt, "new.txt"), "new\n");
  writeFileSync(join(ctx.agentWt, "ignored.txt"), "ignored\n");
}
function stateDigest(ctx: Ctx): Record<string, unknown> {
  const lab = ctx.lab;
  return { claude: refOid(lab, `refs/heads/${lab.branches.claude}`), integration: refOid(lab, `refs/heads/${lab.branches.integration}`), main: refOid(lab, "refs/heads/main"),
    agentIndexTree: indexTree(ctx.agentDir, ctx.agentWt), agentStatus: must(git(ctx.agentDir, ctx.agentWt, ["status", "--porcelain"]), "st"), mainMergeHead: mergeHeadPresent(lab.commonDir), mainIndex: lsFilesStaged(lab.commonDir, lab.main) };
}
const stripOids = (d: Record<string, unknown>) => JSON.stringify(d, (k, v) => (typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? "<oid>" : v));

// ---------- 1. snapshot: crash after each step, both flavors ----------
{
  const ref = (ctx: Ctx) => `refs/heads/${ctx.lab.branches.claude}`;
  const base = freshCtx("snap-base"); dirtyAgent(base);
  const plan0 = snapshotPlan(base, ref(base)); const l0: string[] = [];
  runPlan(base, plan0, -1, "recorded", l0);
  const expected = stateDigest(base);
  rec.note("snapshot_uncrashed", { log: l0, state: expected, tree: treeOf(base.lab, expected["claude"] as string) });
  rec.check("snapshot without crash: branch advanced by one commit whose tree matches the worktree; index aligned; worktree clean of tracked changes", parentsOf(base.lab, expected["claude"] as string)[0] === base.lab.baseOid && expected["agentStatus"] === "", expected);
  for (const flavor of ["unrecorded", "recorded"] as const) for (let crashAt = 0; crashAt < 4; crashAt++) {
    const ctx = freshCtx(`snap-${flavor}-${crashAt}`); dirtyAgent(ctx);
    const plan = snapshotPlan(ctx, ref(ctx)); const log: string[] = [];
    const crashed = runPlan(ctx, plan, crashAt, flavor, log);
    const before = plan.map((s) => `${s.kind}:${s.status}`);
    const rr = recover(ctx, plan, log);
    const after = stateDigest(ctx);
    const same = stripOids(after) === stripOids(expected) && treeOf(ctx.lab, after["claude"] as string) === treeOf(base.lab, expected["claude"] as string);
    rec.check(`snapshot crash after step ${crashAt} (${plan[crashAt]!.kind}, ${flavor}): recovery reaches the uncrashed end state`, crashed && rr.outcome === "done" && same, { rows: before, classifications: rr.classifications, log, after });
    // the ref must have moved exactly once (no double snapshot)
    const commits = must(git(ctx.lab.commonDir, null, ["rev-list", "--count", `${ctx.lab.baseOid}..${ref(ctx)}`]), "count");
    rec.check(`snapshot crash after step ${crashAt} (${flavor}): exactly one snapshot commit on the branch`, commits === "1", commits);
  }
  // ref_cas deviation: someone else moved the ref between commit_write and ref_cas
  const ctx = freshCtx("snap-ref-moved"); dirtyAgent(ctx);
  const plan = snapshotPlan(ctx, ref(ctx)); const log: string[] = [];
  runPlan(ctx, plan, 1, "recorded", log);          // crash after commit_write recorded
  const other = must(git(ctx.lab.commonDir, null, ["commit-tree", treeOf(ctx.lab, ctx.lab.baseOid), "-p", ctx.lab.baseOid, "-m", "agent commit"], { env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@b" } }), "other");
  must(git(ctx.lab.commonDir, null, ["update-ref", ref(ctx), other]), "move");
  const rr = recover(ctx, plan, log);
  rec.check("snapshot: ref moved by someone else before ref_cas -> needs_user with both oids, nothing overwritten", rr.outcome === "needs_user" && refOid(ctx.lab, ref(ctx)) === other, { classifications: rr.classifications, log });
}

// ---------- 2. integrate: snapshot then merge into the integration worktree ----------
function integratePlan(ctx: Ctx): Step[] {
  const lab = ctx.lab;
  return [...snapshotPlan(ctx, `refs/heads/${lab.branches.claude}`), { kind: "merge", where: "integration", targetRef: `refs/heads/${lab.branches.integration}`, expectedOldOid: refOid(lab, `refs/heads/${lab.branches.integration}`)!, status: "planned" }];
}
{
  const base = freshCtx("integ-base"); dirtyAgent(base);
  const plan0 = integratePlan(base); plan0[4]!.sourceOid = undefined;
  const l0: string[] = [];
  // the merge's sourceOid is the snapshot tip: fill it lazily
  const fill = (ctx: Ctx, plan: Step[]) => { plan[4]!.sourceOid = refOid(ctx.lab, `refs/heads/${ctx.lab.branches.claude}`)!; };
  const runInteg = (ctx: Ctx, plan: Step[], crashAt: number, flavor: "recorded" | "unrecorded", log: string[]) => { const crashed = runPlan(ctx, plan.slice(0, 4), crashAt, flavor, log); if (crashed) return true; fill(ctx, plan); return runPlan(ctx, plan, crashAt, flavor, log); };
  runInteg(base, plan0, -1, "recorded", l0);
  const expected = stateDigest(base);
  const integTip = expected["integration"] as string;
  rec.check("integrate without crash: integration is a merge commit with parents (old integration, snapshot)", parentsOf(base.lab, integTip)[0] === base.lab.baseOid && parentsOf(base.lab, integTip)[1] === expected["claude"], parentsOf(base.lab, integTip));
  for (const flavor of ["unrecorded", "recorded"] as const) {
    const ctx = freshCtx(`integ-${flavor}`); dirtyAgent(ctx);
    const plan = integratePlan(ctx); const log: string[] = [];
    const crashed = runInteg(ctx, plan, 4, flavor, log);
    const rr = (() => { if (!plan[4]!.sourceOid) fill(ctx, plan); return recover(ctx, plan, log); })();
    const after = stateDigest(ctx);
    rec.check(`integrate crash after the merge (${flavor}): classified done and end state matches`, crashed && rr.outcome === "done" && stripOids(after) === stripOids(expected), { classifications: rr.classifications, log, after, expected });
  }
  // conflict: integration already has a conflicting change
  const ctx = freshCtx("integ-conflict"); dirtyAgent(ctx);
  writeFileSync(join(ctx.integWt, "src", "app.txt"), "line1\nline2\nintegration edit\n");
  must(git(ctx.integDir, ctx.integWt, ["add", "-A"]), "add"); must(git(ctx.integDir, ctx.integWt, ["-c", "user.name=I", "-c", "user.email=i@b", "commit", "-q", "-m", "integ"]), "commit");
  const plan = integratePlan(ctx); const log: string[] = [];
  const crashed = runInteg(ctx, plan, 4, "unrecorded", log);   // merge conflicts -> needs_user before any crash; simulate crash with MERGE_HEAD present by forcing status executing
  plan[4]!.status = "executing";
  const cls = classify(ctx, plan[4]!);
  rec.check("integrate conflict with MERGE_HEAD present at startup: classified abort/failed", cls === "abort_failed" && mergeHeadPresent(ctx.integDir), { cls, crashed, log });
  const rr = recover(ctx, plan, log);
  rec.check("integrate conflict recovery: abort ran, MERGE_HEAD gone, integration ref unchanged", rr.outcome === "failed" && !mergeHeadPresent(ctx.integDir) && refOid(ctx.lab, `refs/heads/${ctx.lab.branches.integration}`) === plan[4]!.expectedOldOid, { rr, log });
}

// ---------- 3. apply: preflight, merge --no-commit in main; crash between merge and its transaction; abort ----------
function prepareIntegration(ctx: Ctx): string {
  dirtyAgent(ctx);
  const plan = integratePlan(ctx); const log: string[] = [];
  runPlan(ctx, plan.slice(0, 4), -1, "recorded", log); plan[4]!.sourceOid = refOid(ctx.lab, `refs/heads/${ctx.lab.branches.claude}`)!; runPlan(ctx, plan, -1, "recorded", log);
  return refOid(ctx.lab, `refs/heads/${ctx.lab.branches.integration}`)!;
}
function applyPlan(ctx: Ctx, integ: string): Step[] {
  return [{ kind: "preflight", sourceOid: integ, status: "planned" }, { kind: "merge", where: "main", sourceOid: integ, status: "planned" }];
}
{
  const base = freshCtx("apply-base"); const integ = prepareIntegration(base);
  const plan0 = applyPlan(base, integ); const l0: string[] = [];
  runPlan(base, plan0, -1, "recorded", l0);
  const expected = stateDigest(base);
  rec.check("apply without crash: MERGE_HEAD present, index holds the merge, main ref unchanged", expected["mainMergeHead"] === true && expected["main"] === base.lab.baseOid && plan0[1]!.postMergeIndex !== undefined, { log: l0, msg: plan0[1]!.message });
  // crash between the merge and its transaction
  const ctx = freshCtx("apply-unrecorded"); const integ2 = prepareIntegration(ctx);
  const plan = applyPlan(ctx, integ2); const log: string[] = [];
  const crashed = runPlan(ctx, plan, 1, "unrecorded", log);
  const cls = classify(ctx, plan[1]!);
  rec.check("apply: crash between the main merge and its transaction -> MERGE_HEAD present -> needs_user (never rerun, never abort)", crashed && cls === "needs_user" && mergeHeadPresent(ctx.lab.commonDir), { cls, log });
  const abortStep: Step = { kind: "abort", status: "planned", postMergeIndex: plan[1]!.postMergeIndex };
  execStep(ctx, abortStep, { crashBeforeRecord: false });
  rec.check("apply --abort with the post-merge index unrecorded -> needs_user, MERGE_HEAD still present", statusOf(abortStep) === "needs_user" && mergeHeadPresent(ctx.lab.commonDir), abortStep);
  // crash after preflight, before the merge ran: rerun after a fresh preflight
  const ctx2 = freshCtx("apply-before-merge"); const integ3 = prepareIntegration(ctx2);
  const plan2 = applyPlan(ctx2, integ3); const log2: string[] = [];
  runPlan(ctx2, plan2, 0, "recorded", log2);
  plan2[1]!.status = "executing"; plan2[1]!.recordedHead = ctx2.lab.baseOid;   // the row was written as executing, then the process died before git ran
  const cls2 = classify(ctx2, plan2[1]!);
  writeFileSync(join(ctx2.lab.main, "new.txt"), "user created this meanwhile\n");   // the main worktree changed across the crash
  const rr2 = recover(ctx2, plan2, log2);
  rec.check("apply: crash before the merge ran -> rerun after a fresh preflight; the fresh preflight catches a file the user created meanwhile", cls2 === "rerun_after_preflight" && rr2.outcome === "needs_user" && !mergeHeadPresent(ctx2.lab.commonDir), { cls2, rr2, log2 });
  // user committed the merge before restart: done by the user
  const ctx3 = freshCtx("apply-user-committed"); const integ4 = prepareIntegration(ctx3);
  const plan3 = applyPlan(ctx3, integ4); const log3: string[] = [];
  runPlan(ctx3, plan3, 1, "unrecorded", log3);
  must(git(ctx3.lab.commonDir, ctx3.lab.main, ["-c", "user.name=U", "-c", "user.email=u@b", "commit", "-q", "--no-verify", "-m", "user commits the merge"]), "user commit");
  const cls3 = classify(ctx3, plan3[1]!);
  rec.check("apply: user committed the merge before restart -> done by the user", cls3 === "done_by_user", { cls3, head: parentsOf(ctx3.lab, must(git(ctx3.lab.commonDir, ctx3.lab.main, ["rev-parse", "HEAD"]), "h")) });
  // abort: crash after abort ran but before recording -> MERGE_HEAD absent -> done; changed index -> needs_user
  const ctx4 = freshCtx("abort-recorded"); const integ5 = prepareIntegration(ctx4);
  const plan4 = applyPlan(ctx4, integ5); const log4: string[] = [];
  runPlan(ctx4, plan4, -1, "recorded", log4);
  const ab: Step = { kind: "abort", status: "planned", postMergeIndex: plan4[1]!.postMergeIndex };
  execStep(ctx4, ab, { crashBeforeRecord: true });
  rec.check("apply --abort: crash after git merge --abort before recording -> MERGE_HEAD absent -> done; main tree clean", classify(ctx4, ab) === "done" && !mergeHeadPresent(ctx4.lab.commonDir) && must(git(ctx4.lab.commonDir, ctx4.lab.main, ["status", "--porcelain"]), "st") === "", { st: must(git(ctx4.lab.commonDir, ctx4.lab.main, ["status", "--porcelain"]), "st") });
  const ctx5 = freshCtx("abort-index-changed"); const integ6 = prepareIntegration(ctx5);
  const plan5 = applyPlan(ctx5, integ6); const log5: string[] = [];
  runPlan(ctx5, plan5, -1, "recorded", log5);
  writeFileSync(join(ctx5.lab.main, "unrelated.txt"), "staged after the merge\n"); must(git(ctx5.lab.commonDir, ctx5.lab.main, ["add", "unrelated.txt"]), "add");
  const ab5: Step = { kind: "abort", status: "planned", postMergeIndex: plan5[1]!.postMergeIndex };
  execStep(ctx5, ab5, { crashBeforeRecord: false });
  rec.check("apply --abort: index changed after the merge -> needs_user, MERGE_HEAD kept, staged file kept", statusOf(ab5) === "needs_user" && mergeHeadPresent(ctx5.lab.commonDir) && existsSync(join(ctx5.lab.main, "unrelated.txt")), ab5);
}
rec.finish();

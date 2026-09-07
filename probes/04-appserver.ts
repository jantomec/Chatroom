// Phase 0 item 4 (and item 8, Codex side): codex app-server with the §15.2 profile passed
// through the `config` map; effective policy; Auto-review; escalation; native commit;
// turn/steer against a finishing turn; thread/resume in a new process; legacy fallback.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppServer, type Msg } from "./lib/appserver.ts";
import { allRefs, buildLab, refOid, type Lab } from "./lib/lab.ts";
import { CODEX_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv, run, versionOf } from "./lib/util.ts";

const rec = new Recorder("04-appserver");
rec.note("codex_version", versionOf(CODEX_BIN));
rec.note("codex_login", run(CODEX_BIN, ["login", "status"]).stdout.trim() || run(CODEX_BIN, ["login", "status"]).stderr.trim());
const LAB_BASE = join(HOME, ".local/state/chatroom-probes");
const lab = buildLab(join(LAB_BASE, "lab04"));
rec.note("lab", { main: lab.main, codexWorktree: lab.worktrees.codex, commonDir: lab.commonDir, adminDir: lab.adminDirs.codex });

const profileName = "chatroom-p0";
function profileConfig(lab: Lab): Record<string, unknown> {
  const c = lab.commonDir;
  const fs: Record<string, string> = {
    ":root": "read",
    [lab.worktrees.codex]: "write",
    [lab.ipc.codex.drop]: "write",
    [lab.ipc.codex.scratch]: "write",
    [lab.adminDirs.codex]: "write",
    [join(c, "objects")]: "write",
    [join(c, "refs/heads", lab.branches.codex)]: "write",
    [join(c, "refs/heads", lab.branches.codex + ".lock")]: "write",
    [join(c, "logs/refs/heads", lab.branches.codex)]: "write",
    [join(c, "logs/refs/heads", lab.branches.codex + ".lock")]: "write",
    [lab.authority]: "deny",
    [join(lab.ipc.root, "*", "staging")]: "deny",
    [lab.ipc.claude.root]: "deny",
    [lab.secrets]: "deny",
  };
  return {
    default_permissions: profileName,
    permissions: { [profileName]: { filesystem: fs } },
    shell_environment_policy: { ignore_default_excludes: false, set: { CHATROOM_PROBE_SET: "via-config-set", TMPDIR: lab.ipc.codex.scratch, GIT_OPTIONAL_LOCKS: "0" } },
  };
}
const env = cleanEnv({
  CHATROOM_AGENT: "codex", CHATROOM_HANDLE: "phil", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.codex.drop, CHATROOM_DELIVERY_DIR: lab.ipc.codex.deliveries, CHATROOM_RECEIPT_DIR: lab.ipc.codex.receipts,
  CHATROOM_SCRATCH: lab.ipc.codex.scratch, CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  MY_FAKE_TOKEN: "should-be-stripped-by-default-excludes",
});
const approvals: { method: string; params: Msg }[] = [];
let approvalDecision: unknown = { decision: "decline" };
function makeServer(label: string): AppServer {
  return new AppServer({ bin: CODEX_BIN, args: ["app-server"], cwd: lab.worktrees.codex, env, logFile: rec.file(`${label}.jsonl`),
    onServerRequest: (method, params) => {
      approvals.push({ method, params });
      rec.note(`server_request_${approvals.length}`, { method, params });
      if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
      return approvalDecision;
    } });
}
async function handshake(s: AppServer, experimental: boolean): Promise<Msg> {
  const r = await s.request("initialize", { clientInfo: { name: "chatroom-probe", title: "Chatroom probe", version: "0.0.0" }, capabilities: { experimentalApi: experimental } });
  s.notify("initialized", {});
  return r;
}
async function runTurn(s: AppServer, threadId: string, text: string, label: string, timeoutMs = 600_000): Promise<{ turn: Msg; items: Msg[]; notifications: Msg[]; ms: number }> {
  const mark = s.mark(); const t0 = Date.now();
  const started = await s.request("turn/start", { threadId, input: [{ type: "text", text }] });
  const turnId = started.turn.id as string;
  const done = await s.waitForTurnEnd(turnId, mark, timeoutMs);
  const notifications = s.notifications(mark).filter((m) => m["params"]?.turnId === turnId || m["params"]?.turn?.id === turnId || m["method"]?.startsWith("thread/"));
  const items = notifications.filter((m) => m["method"] === "item/completed").map((m) => m["params"].item as Msg);
  const ms = Date.now() - t0;
  const finalText = items.filter((i) => i["type"] === "agentMessage").map((i) => i["text"]).at(-1);
  rec.log(`turn ${label}: ${ms} ms, status=${done["params"].turn.status}, items=${items.map((i) => i["type"]).join(",")}, final=${JSON.stringify(finalText).slice(0, 200)}`);
  return { turn: done["params"].turn, items, notifications, ms };
}
const finalText = (items: Msg[]) => items.filter((i) => i["type"] === "agentMessage").map((i) => String(i["text"])).at(-1) ?? "";

// ---- Process 1: profile through config, four turns ----
const s1 = makeServer("server1");
let threadId = "";
try {
  const init = await handshake(s1, true);
  rec.note("initialize_response", init);
  let startResp: Msg;
  try {
    startResp = await s1.request("thread/start", { cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: profileConfig(lab), serviceName: "chatroom-probe" });
    rec.check("thread/start accepts the §15.2 profile through the nested config map", true);
    rec.note("config_map_format", "nested objects");
  } catch (e) {
    rec.check("thread/start accepts the §15.2 profile through the nested config map", false, String(e));
    throw e;
  }
  threadId = startResp["thread"].id;
  rec.note("thread_start_response", { ...startResp, thread: { id: startResp["thread"].id, cwd: startResp["thread"].cwd, model: startResp["thread"].model, reasoningEffort: startResp["thread"].reasoningEffort, status: startResp["thread"].status, cliVersion: startResp["thread"].cliVersion } });
  rec.check("thread/start response reports cwd equal to the worktree", startResp["cwd"] === lab.worktrees.codex, startResp["cwd"]);
  rec.check("thread/start response carries model and reasoningEffort", typeof startResp["model"] === "string" && typeof startResp["reasoningEffort"] === "string", { model: startResp["model"], effort: startResp["reasoningEffort"] });
  rec.check("thread/start response approvalsReviewer is auto_review and approvalPolicy on-request", startResp["approvalsReviewer"] === "auto_review" && startResp["approvalPolicy"] === "on-request", { reviewer: startResp["approvalsReviewer"], policy: startResp["approvalPolicy"] });
  rec.note("thread_start_legacy_sandbox_field", startResp["sandbox"]);
  const settingsNotes = s1.notifications().filter((m) => m["method"] === "thread/settings/updated");
  rec.note("thread_settings_updated_after_start", settingsNotes.map((m) => m["params"]));
  const active = settingsNotes.map((m) => m["params"]?.threadSettings?.activePermissionProfile).find(Boolean);
  rec.check("effective policy reports the profile (activePermissionProfile.id) with the user's real config.toml present", active?.id === profileName, { active, settingsNotifications: settingsNotes.length });
  try {
    const profiles = await s1.request("permissionProfile/list", { cwd: lab.worktrees.codex });
    rec.note("permissionProfile_list", profiles);
    rec.check("permissionProfile/list includes the config-injected profile", (profiles.data ?? []).some((p: Msg) => p["id"] === profileName), (profiles.data ?? []).map((p: Msg) => p["id"]));
  } catch (e) { rec.note("permissionProfile_list_error", String(e)); }
  try {
    const cfg = await s1.request("config/read", { cwd: lab.worktrees.codex });
    rec.note("config_read", { config: cfg.config, originsKeys: Object.keys(cfg.origins ?? {}) });
  } catch (e) { rec.note("config_read_error", String(e)); }

  // T1: routine command inside the sandbox, environment check, a fact to remember
  const t1 = await runTurn(s1, threadId, "Remember the secret word MANGO for later. Now run exactly this shell command: echo \"$CHATROOM_AGENT|$CHATROOM_PROBE_SET|$MY_FAKE_TOKEN|$TMPDIR\"\nReply with only the command's output, nothing else.", "T1");
  const out1 = finalText(t1.items);
  rec.check("T1 completed", t1.turn["status"] === "completed", t1.turn);
  rec.check("child command sees CHATROOM_AGENT from the app-server environment (inherit)", /codex\|/.test(out1), out1);
  rec.check("shell_environment_policy.set from the config map reaches the command", /via-config-set/.test(out1), out1);
  rec.check("ignore_default_excludes=false strips a *TOKEN* variable", !/should-be-stripped/.test(out1), out1);
  rec.check("TMPDIR set to the scratch root", out1.includes(lab.ipc.codex.scratch), out1);
  const cmd1 = t1.items.filter((i) => i["type"] === "commandExecution");
  rec.note("commandExecution_item_sample", cmd1[0]);
  rec.check("routine command ran without any approval request", approvals.length === 0, approvals.map((a) => a.method));
  const usage = s1.notifications().filter((m) => m["method"] === "thread/tokenUsage/updated").map((m) => m["params"]);
  rec.note("tokenUsage_updated_samples", usage.slice(0, 2).concat(usage.slice(-1)));
  rec.check("thread/tokenUsage/updated carries last.inputTokens and a non-null modelContextWindow during a turn", usage.some((u) => typeof u.tokenUsage?.last?.inputTokens === "number" && typeof u.tokenUsage?.modelContextWindow === "number"), usage.at(-1));
  rec.note("notification_methods_T1", [...new Set(t1.notifications.map((m) => m["method"]))]);
  rec.note("model_rerouted_seen", s1.notifications().filter((m) => m["method"] === "model/rerouted").map((m) => m["params"]));

  // T2: escalation: write into the main tree, sandbox must block, see who reviews
  const escapeFile = join(lab.main, "escape.txt");
  const t2 = await runTurn(s1, threadId, `Run exactly this shell command once: printf x > "${escapeFile}"\nIf the sandbox blocks it, request approval to rerun it outside the sandbox exactly once, then stop. Reply with one line saying whether the file was written.`, "T2");
  rec.note("T2_final", finalText(t2.items));
  rec.note("T2_items", t2.items.map((i) => ({ type: i["type"], status: i["status"], command: i["command"], exitCode: i["exitCode"], output: String(i["aggregatedOutput"] ?? "").slice(0, 300) })));
  const reviews = s1.notifications().filter((m) => /autoApprovalReview/.test(String(m["method"])));
  rec.note("autoApprovalReview_notifications", reviews.map((m) => ({ method: m["method"], params: m["params"] })));
  rec.check("write into the main tree did not land (sandbox or reviewer blocked it)", !existsSync(escapeFile), { exists: existsSync(escapeFile) });
  rec.check("escalation reached item/commandExecution/requestApproval or was reviewed by Auto-review", approvals.some((a) => a.method === "item/commandExecution/requestApproval") || reviews.length > 0, { approvals: approvals.map((a) => a.method), reviews: reviews.length });
  const approvalsAfterT2 = approvals.length;

  // T3: native commit on the own branch without elevation
  const refsBefore = allRefs(lab);
  const t3 = await runTurn(s1, threadId, "Create a file named note.txt containing the single line hi in the current directory, then run: git add note.txt && git commit -q -m probe && git rev-parse HEAD\nReply with only the 40-character commit hash.", "T3");
  const refsAfter = allRefs(lab);
  const codexRef = `refs/heads/${lab.branches.codex}`;
  const moved = Object.keys({ ...refsBefore, ...refsAfter }).filter((r) => refsBefore[r] !== refsAfter[r]);
  rec.note("T3_final", finalText(t3.items));
  rec.check("git commit in the worktree moved only the own branch", moved.length === 1 && moved[0] === codexRef && refsAfter[codexRef] !== lab.baseOid, { moved, before: refsBefore, after: refsAfter });
  rec.check("main did not move", refOid(lab, "refs/heads/main") === lab.baseOid);
  rec.check("commit needed no approval request", approvals.length === approvalsAfterT2, approvals.slice(approvalsAfterT2).map((a) => a.method));
  const reviewsT3 = s1.notifications().filter((m) => /autoApprovalReview/.test(String(m["method"]))).length - reviews.length;
  rec.note("autoApprovalReview_during_commit", reviewsT3);
  rec.check("commit involved no Auto-review elevation", reviewsT3 === 0);

  // T4: steer an active turn, then steer after it finished
  const mark4 = s1.mark();
  const started = await s1.request("turn/start", { threadId, input: [{ type: "text", text: "Run exactly: sleep 6\nThen reply with the word DONE plus any extra word I steer to you while you wait." }] });
  const turnId4 = started.turn.id as string;
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const st = await s1.request("turn/steer", { threadId, expectedTurnId: turnId4, input: [{ type: "text", text: "Steered word: KIWI" }] });
    rec.check("turn/steer accepted against the active turn", st.turnId === turnId4, st);
  } catch (e) { rec.check("turn/steer accepted against the active turn", false, String(e)); }
  const done4 = await s1.waitForTurnEnd(turnId4, mark4, 600_000);
  const items4 = s1.notifications(mark4).filter((m) => m["method"] === "item/completed").map((m) => m["params"].item as Msg);
  rec.note("T4_final", finalText(items4));
  rec.check("steered input reached the model", /KIWI/.test(finalText(items4)), finalText(items4));
  try {
    const st2 = await s1.request("turn/steer", { threadId, expectedTurnId: turnId4, input: [{ type: "text", text: "late" }] });
    rec.check("turn/steer after turn end is rejected", false, st2);
  } catch (e) { rec.check("turn/steer after turn end is rejected", true, String(e)); rec.note("steer_after_end_error", String(e)); }
  rec.note("turn_status_T4", done4["params"].turn.status);
  rec.note("token_usage_final", s1.notifications().filter((m) => m["method"] === "thread/tokenUsage/updated").map((m) => m["params"]).at(-1));
  rec.note("all_notification_methods_server1", [...new Set(s1.notifications().map((m) => m["method"]))]);
  await s1.close();
  const ex = await s1.exited;
  rec.note("server1_exit", ex);
} catch (e) {
  rec.check("process 1 completed", false, String(e) + "\n" + s1.stderr.slice(-1500));
  s1.kill("SIGKILL");
}

// ---- Process 2: resume by id in a fresh process with the same overrides; effort override ----
const s2 = makeServer("server2");
try {
  await handshake(s2, true);
  const cfg = { ...profileConfig(lab), model_reasoning_effort: "low" };
  const resumed = await s2.request("thread/resume", { threadId, cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: cfg });
  rec.note("thread_resume_response", { cwd: resumed.cwd, model: resumed.model, reasoningEffort: resumed.reasoningEffort, sandbox: resumed.sandbox, turns: resumed.thread?.turns?.length, status: resumed.thread?.status });
  rec.check("thread/resume by explicit id in a new process returns the thread with its history", resumed.thread?.id === threadId && (resumed.thread?.turns?.length ?? 0) >= 4, { id: resumed.thread?.id, turns: resumed.thread?.turns?.length });
  rec.check("resume reports the worktree cwd", resumed.cwd === lab.worktrees.codex, resumed.cwd);
  rec.check("model_reasoning_effort in the config map shows as reasoningEffort on the response", resumed.reasoningEffort === "low", resumed.reasoningEffort);
  const t5 = await runTurn(s2, threadId, "What was the secret word I asked you to remember? Reply with only that word.", "T5");
  rec.check("resumed thread remembers the first turn", /MANGO/.test(finalText(t5.items)), finalText(t5.items));
  await s2.close();
} catch (e) {
  rec.check("process 2 completed", false, String(e) + "\n" + s2.stderr.slice(-1500));
  s2.kill("SIGKILL");
}

// ---- Process 3: a profile that cannot load, then the legacy fallback ----
const s3 = makeServer("server3");
try {
  await handshake(s3, false);
  try {
    const bad = await s3.request("thread/start", { cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: { default_permissions: "does-not-exist" } });
    rec.note("thread_start_with_missing_profile", { sandbox: bad.sandbox, settings: s3.notifications().filter((m) => m["method"] === "thread/settings/updated").map((m) => m["params"]?.threadSettings?.activePermissionProfile) });
    rec.check("thread/start with a missing profile fails or reports no such profile", false, "accepted");
  } catch (e) { rec.check("thread/start with a missing profile fails or reports no such profile", true, String(e)); }
  const legacy = await s3.request("thread/start", { cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write",
    config: { sandbox_workspace_write: { writable_roots: [lab.ipc.codex.drop, lab.ipc.codex.scratch] }, shell_environment_policy: { ignore_default_excludes: false } } });
  const legacyId = legacy.thread.id as string;
  rec.note("legacy_thread_start", { sandbox: legacy.sandbox, approvalsReviewer: legacy.approvalsReviewer, model: legacy.model });
  const before = approvals.length;
  const refsBefore = allRefs(lab);
  const t6 = await runTurn(s3, legacyId, "Create a file named legacy.txt containing the single line hi in the current directory, then run: git add legacy.txt && git commit -q -m legacy && git rev-parse HEAD\nIf the commit fails inside the sandbox, request approval to run it outside the sandbox exactly once. Reply with one line: the commit hash, or what failed.", "T6");
  const refsAfter = allRefs(lab);
  const moved = Object.keys({ ...refsBefore, ...refsAfter }).filter((r) => refsBefore[r] !== refsAfter[r]);
  const reviewsLegacy = s3.notifications().filter((m) => /autoApprovalReview/.test(String(m["method"])));
  rec.note("legacy_commit", { final: finalText(t6.items), moved, approvals: approvals.slice(before).map((a) => ({ method: a.method, reason: a.params["reason"], command: a.params["command"] })), autoReviews: reviewsLegacy.map((m) => ({ method: m["method"], action: m["params"]?.action, decision: m["params"]?.review })) });
  rec.check("legacy workspace-write: the commit needed an approval or Auto-review (recorded either way)", true);
  rec.check("legacy workspace-write: main did not move", refOid(lab, "refs/heads/main") === lab.baseOid);
  await s3.close();
} catch (e) {
  rec.check("process 3 completed", false, String(e) + "\n" + s3.stderr.slice(-1500));
  s3.kill("SIGKILL");
}
rec.note("approval_requests_total", approvals.map((a) => ({ method: a.method, reason: a.params["reason"], command: a.params["command"] })));
rec.finish({ threadId, lab: lab.root });

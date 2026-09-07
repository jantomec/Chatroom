// Phase 0 item 6: kill mid-generation and resume on both harnesses; tool-command timeouts.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppServer, type Msg } from "./lib/appserver.ts";
import { ClaudeProcess, resultText } from "./lib/claude.ts";
import { buildLab, type Lab } from "./lib/lab.ts";
import { CLAUDE_BIN, CODEX_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("06-kill-resume");
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab06"));
const which = process.argv[2] ?? "both";

function profileConfig(lab: Lab): Record<string, unknown> {
  const c = lab.commonDir;
  const fs: Record<string, string> = {
    ":root": "read", [lab.worktrees.codex]: "write", [lab.ipc.codex.drop]: "write", [lab.ipc.codex.scratch]: "write",
    [lab.adminDirs.codex]: "write", [join(c, "objects")]: "write",
    [join(c, "refs/heads", lab.branches.codex)]: "write", [join(c, "refs/heads", lab.branches.codex + ".lock")]: "write",
    [join(c, "logs/refs/heads", lab.branches.codex)]: "write", [join(c, "logs/refs/heads", lab.branches.codex + ".lock")]: "write",
    [lab.authority]: "deny", [join(lab.ipc.root, "*", "staging")]: "deny", [lab.ipc.claude.root]: "deny", [lab.secrets]: "deny",
  };
  return { default_permissions: "chatroom-p0", permissions: { "chatroom-p0": { filesystem: fs } }, shell_environment_policy: { set: { TMPDIR: lab.ipc.codex.scratch, GIT_OPTIONAL_LOCKS: "0" } } };
}

// ---------------- Codex app-server ----------------
if (which === "both" || which === "codex") {
  const env = cleanEnv({ CHATROOM_AGENT: "codex", CHATROOM_TURN: "turn0001" });
  const mk = (label: string) => new AppServer({ bin: CODEX_BIN, args: ["app-server"], cwd: lab.worktrees.codex, env, logFile: rec.file(`${label}.jsonl`), onServerRequest: (m, p) => { rec.note(`codex_server_request_${label}`, { m, p }); return { decision: "decline" }; } });
  const hs = async (s: AppServer) => { await s.request("initialize", { clientInfo: { name: "chatroom-probe", version: "0.0.0" }, capabilities: { experimentalApi: true } }); s.notify("initialized", {}); };
  const s1 = mk("codex1");
  let threadId = "";
  try {
    await hs(s1);
    const st = await s1.request("thread/start", { cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: profileConfig(lab) });
    threadId = st.thread.id;
    // tool timeout / long command
    const m0 = s1.mark(); const t0 = Date.now();
    const t1 = await s1.request("turn/start", { threadId, input: [{ type: "text", text: "Run exactly this shell command and wait for it to finish: sleep 25 && echo finished-25\nReply with only the command's output." }] });
    const d1 = await s1.waitForTurnEnd(t1.turn.id, m0, 600_000);
    const items1 = s1.notifications(m0).filter((m) => m["method"] === "item/completed").map((m) => m["params"].item as Msg);
    const cmds1 = items1.filter((i) => i["type"] === "commandExecution").map((i) => ({ command: i["command"], exitCode: i["exitCode"], durationMs: i["durationMs"], status: i["status"], output: String(i["aggregatedOutput"] ?? "").slice(0, 200) }));
    rec.note("codex_long_command_items", cmds1);
    rec.note("codex_long_command_final", items1.filter((i) => i["type"] === "agentMessage").map((i) => i["text"]).at(-1));
    rec.check("codex: a 25 s command completes and its output reaches the model (no hard tool timeout below 25 s)", /finished-25/.test(String(items1.filter((i) => i["type"] === "agentMessage").map((i) => i["text"]).at(-1))), { wallMs: Date.now() - t0, status: d1["params"].turn.status, cmds: cmds1 });
    // kill mid-generation
    const m1 = s1.mark();
    const t2 = await s1.request("turn/start", { threadId, input: [{ type: "text", text: "Run exactly: sleep 20 && echo done-20\nThen reply with only the command's output." }] });
    await s1.waitFor((m) => m["method"] === "item/started" && m["params"]?.item?.type === "commandExecution", m1, 120_000, "command start");
    await new Promise((r) => setTimeout(r, 2000));
    s1.kill("SIGKILL");
    const ex = await s1.exited;
    rec.note("codex_killed", { exit: ex, turnId: t2.turn.id });
    const s2 = mk("codex2");
    await hs(s2);
    const t3 = Date.now();
    const rs = await s2.request("thread/resume", { threadId, cwd: lab.worktrees.codex, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: profileConfig(lab) });
    const turns = (rs.thread?.turns ?? []) as Msg[];
    const last = turns.at(-1);
    rec.note("codex_resume_after_kill", { ms: Date.now() - t3, status: rs.thread?.status, turns: turns.length, lastTurn: last && { id: last["id"], status: last["status"], items: (last["items"] ?? []).map((i: Msg) => i["type"]) } });
    rec.check("codex: thread/resume after SIGKILL returns the thread; the interrupted turn is visible", rs.thread?.id === threadId && turns.length >= 2, { turns: turns.length, lastStatus: last?.["status"] });
    rec.check("codex: interrupted turn is not reported as completed", last?.["status"] !== "completed" || last?.["id"] !== t2.turn.id, { lastId: last?.["id"], killedTurn: t2.turn.id, status: last?.["status"] });
    const m2 = s2.mark();
    const t4 = await s2.request("turn/start", { threadId, input: [{ type: "text", text: "[chatroom] Recovery note: your previous turn was interrupted by a crash. What was the last command you ran, and did you see its output? Answer in one line." }] });
    const d4 = await s2.waitForTurnEnd(t4.turn.id, m2, 600_000);
    const fin = s2.notifications(m2).filter((m) => m["method"] === "item/completed").map((m) => m["params"].item as Msg).filter((i) => i["type"] === "agentMessage").map((i) => i["text"]).at(-1);
    rec.note("codex_recovery_turn", { status: d4["params"].turn.status, final: fin });
    rec.check("codex: recovery turn completes on the resumed thread", d4["params"].turn.status === "completed", fin);
    await s2.close();
  } catch (e) { rec.check("codex part completed", false, String(e) + "\n" + s1.stderr.slice(-800)); s1.kill("SIGKILL"); }
}

// ---------------- Claude ----------------
if (which === "both" || which === "claude") {
  const env = cleanEnv({ CHATROOM_AGENT: "claude", CHATROOM_TURN: "turn0001", CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_NODE: process.execPath, CHATROOM_PROBE_HOOK: join(PROBES_ROOT, "lib", "hook.ts"), CHATROOM_HOOK_LOG: rec.file("hook.jsonl") });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "host", "--append-system-prompt", "You are a probe subject. Answer with exactly what is asked."];
  const sid = randomUUID();
  const a = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...args, "--session-id", sid], cwd: lab.worktrees.claude, env, logFile: rec.file("claude1.jsonl") });
  try {
    // tool timeout: 130 s sleep against the documented 120 s default
    const m0 = a.mark(); const t0 = Date.now();
    a.sendUser("Use the Bash tool to run exactly: sleep 130 && echo finished-130\nDo not set a custom timeout and do not run it in the background. Reply with only the command's output, or the tool's error text verbatim.");
    const r0 = await a.waitForResult(m0, 400_000);
    const tr = a.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_result").at(-1);
    rec.note("claude_long_command", { wallMs: Date.now() - t0, result: resultText(r0).slice(0, 300), toolResult: tr, toolUse: a.events.filter((e) => e["type"] === "assistant").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_use").map((b: any) => b.input) });
    rec.check("claude: a 130 s Bash command hits the tool timeout (documented 120 s default)", /timed out|timeout/i.test(JSON.stringify(tr) + resultText(r0)) && !/finished-130/.test(JSON.stringify(tr)), { wallMs: Date.now() - t0, toolResult: tr });
    // kill mid-generation
    const m1 = a.mark();
    a.sendUser("Use the Bash tool to run exactly: sleep 20 && echo done-20\nThen reply with only the command's output.");
    await a.waitFor((e) => e["type"] === "assistant" && (e["message"]?.content ?? []).some((b: any) => b.type === "tool_use"), m1, 120_000, "tool_use");
    await new Promise((r) => setTimeout(r, 2000));
    a.kill("SIGKILL");
    const ex = await a.exited;
    rec.note("claude_killed", ex);
    const b = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...args, "--resume", sid], cwd: lab.worktrees.claude, env, logFile: rec.file("claude2.jsonl") });
    try {
      const m2 = b.mark(); const t2 = Date.now();
      b.sendUser("[chatroom] Recovery note: your previous turn was interrupted by a crash. What was the last command you ran, and did you see its output? Answer in one line.");
      const r2 = await b.waitForResult(m2, 300_000);
      const init = b.events.find((e) => e["type"] === "system" && e["subtype"] === "init");
      rec.note("claude_resume_after_kill", { ms: Date.now() - t2, session_id: init?.["session_id"], result: resultText(r2).slice(0, 300), firstEvents: b.events.slice(0, 4).map((e) => `${e["type"]}/${e["subtype"] ?? ""}`) });
      rec.check("claude: --resume after SIGKILL keeps the session id and completes a recovery turn", init?.["session_id"] === sid && r2["subtype"] === "success", { got: init?.["session_id"], subtype: r2["subtype"] });
      rec.check("claude: the resumed session recalls the interrupted command", /sleep 20|done-20/.test(resultText(r2)), resultText(r2));
      b.endInput(); await Promise.race([b.exited, new Promise((r) => setTimeout(r, 30_000))]);
    } catch (e) { rec.check("claude resume part completed", false, String(e) + b.stderr.slice(-500)); b.kill("SIGKILL"); }
  } catch (e) { rec.check("claude part completed", false, String(e) + a.stderr.slice(-500)); a.kill("SIGKILL"); }
}
rec.finish({ lab: lab.root });

// Phase 0 items 2 and 8 (Claude side): several sequential turns in one -p stream-json
// process; --resume later; the PostToolUse hook from inline --settings reaches the model;
// control request/response wire shapes; thinking blocks; the login check; status sources.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText, type ClaudeEvent } from "./lib/claude.ts";
import { buildLab } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv, run, versionOf } from "./lib/util.ts";

const rec = new Recorder("02-claude-session");
rec.note("claude_version", versionOf(CLAUDE_BIN));
const auth = run(CLAUDE_BIN, ["auth", "status"]);
let authJson: Record<string, unknown> = {};
try { authJson = JSON.parse(auth.stdout); } catch { /* recorded raw below */ }
rec.note("auth_status", authJson["loggedIn"] === undefined ? auth.stdout : authJson);
rec.check("login check: claude.ai login, first-party provider, no API key", authJson["loggedIn"] === true && authJson["authMethod"] === "claude.ai" && authJson["apiProvider"] === "firstParty");

const LAB_BASE = join(HOME, ".local/state/chatroom-probes");
const lab = buildLab(join(LAB_BASE, "lab02"));
rec.note("lab", { main: lab.main, claudeWorktree: lab.worktrees.claude, commonDir: lab.commonDir });
const stub = join(PROBES_ROOT, "lib", "chatroom-stub.sh");
chmodSync(stub, 0o755);
const hookLog = rec.file("hook-input.jsonl");
writeFileSync(hookLog, "");
const env = cleanEnv({
  CHATROOM_AGENT: "claude", CHATROOM_HANDLE: "clara", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.claude.drop, CHATROOM_DELIVERY_DIR: lab.ipc.claude.deliveries,
  CHATROOM_RECEIPT_DIR: lab.ipc.claude.receipts, CHATROOM_SCRATCH: lab.ipc.claude.scratch,
  CHATROOM_BIN: stub, CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  CHATROOM_NODE: process.execPath, CHATROOM_PROBE_HOOK: join(PROBES_ROOT, "lib", "hook.ts"), CHATROOM_HOOK_LOG: hookLog,
});
const settings = { hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "\"$CHATROOM_BIN\" hook" }] }] } };
const brief = "You are Clara, a probe subject in a test harness. Answer with exactly what is asked and nothing more. Messages marked [chatroom] may arrive in tool results after tool calls; read them.";
const baseArgs = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events",
  "--settings", JSON.stringify(settings), "--permission-prompts", "host", "--append-system-prompt", brief];
const sessionId = randomUUID();
const hookEntries = () => readFileSync(hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
const initOf = (p: ClaudeProcess) => p.events.find((e) => e["type"] === "system" && e["subtype"] === "init");
const shapesSeen = new Map<string, ClaudeEvent>();
const noteShapes = (p: ClaudeProcess) => { for (const e of p.events) { const k = `${e["type"]}${e["subtype"] ? "/" + e["subtype"] : ""}`; if (!shapesSeen.has(k)) shapesSeen.set(k, e); } };
const controlRequests: ClaudeEvent[] = [];

async function turn(p: ClaudeProcess, label: string, text: string, timeoutMs = 300_000): Promise<ClaudeEvent> {
  const mark = p.mark(); const t0 = Date.now();
  p.sendUser(text);
  const r = await p.waitForResult(mark, timeoutMs);
  rec.log(`turn ${label}: ${Date.now() - t0} ms, subtype=${r["subtype"]}, is_error=${r["is_error"]}, result=${JSON.stringify(resultText(r)).slice(0, 200)}`);
  return r;
}

// ---- Session A: long-lived process, three turns, hook delivery ----
const a = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...baseArgs, "--permission-mode", "auto", "--session-id", sessionId], cwd: lab.worktrees.claude, env, logFile: rec.file("sessionA.jsonl"),
  onControlRequest: (req) => { controlRequests.push(req); rec.note("control_request_during_auto", req); return { behavior: "allow" }; } });
try {
  const tA0 = Date.now();
  const r1 = await turn(a, "A1", "Reply with exactly the word READY.");
  const init = initOf(a);
  rec.note("init_event", init);
  rec.check("init event carries session_id equal to --session-id", init?.["session_id"] === sessionId, { got: init?.["session_id"] });
  rec.check("init event cwd equals the worktree", init?.["cwd"] === lab.worktrees.claude, { got: init?.["cwd"] });
  rec.check("init event has model and permissionMode auto", typeof init?.["model"] === "string" && init?.["permissionMode"] === "auto", { model: init?.["model"], permissionMode: init?.["permissionMode"] });
  rec.check("init event omits effort", init !== undefined && !("effort" in init), Object.keys(init ?? {}));
  rec.check("turn A1 answered READY", /READY/.test(resultText(r1)));
  const asst = a.events.filter((e) => e["type"] === "assistant");
  const usage = asst.at(-1)?.["message"]?.["usage"];
  rec.note("assistant_message_model_and_usage", { model: asst.at(-1)?.["message"]?.["model"], usage });
  rec.check("assistant event carries message.usage with the three input fields", usage && ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].every((k) => typeof usage[k] === "number"), usage);
  rec.check("assistant event carries message.model", typeof asst.at(-1)?.["message"]?.["model"] === "string");
  rec.note("result_event_A1", { ...r1, result: resultText(r1).slice(0, 200) });
  const mu = r1["modelUsage"] ?? {};
  const modelKey = Object.keys(mu)[0];
  rec.check("result carries modelUsage[<model>].contextWindow", modelKey !== undefined && typeof mu[modelKey]?.contextWindow === "number", { modelKey, entry: modelKey && mu[modelKey] });
  rec.check("model in modelUsage matches init model", modelKey === init?.["model"], { modelKey, init: init?.["model"] });

  // A2: deliver through the hook
  writeFileSync(join(lab.ipc.claude.deliveries, "d0001.txt"), "[chatroom] You are @clara. 1 new message.\n\n--- #7 · user → @clara · 10:07:12\nThe secret word is PLUM.\n");
  const r2 = await turn(a, "A2", "Use the Bash tool to run exactly: echo hello\nA [chatroom] message will be attached to that tool result. Reply with only the secret word it contains.");
  rec.check("turn A2: the hook's additionalContext reached the model (secret word answered)", /PLUM/i.test(resultText(r2)), resultText(r2));
  const hooks = hookEntries();
  const post = hooks.filter((h) => h["input"]?.hook_event_name === "PostToolUse");
  rec.check("PostToolUse hook fired from inline --settings", post.length >= 1, { fired: hooks.length, post: post.length });
  rec.note("hook_input_PostToolUse_sample", post[0]);
  rec.check("hook input carries cwd equal to the worktree", post[0]?.["input"]?.cwd === lab.worktrees.claude, post[0]?.["input"]?.cwd);
  rec.note("hook_effort_level_with_effort_unset", post.map((h) => h["input"]?.effort ?? null));
  rec.check("hook input carries effort.level with --effort unset", post.some((h) => typeof h["input"]?.effort?.level === "string"), post.map((h) => h["input"]?.effort));
  rec.note("hook_env_seen", post[0]?.["env"]);
  rec.check("delivery consumed and delivery_ack written to the drop root", existsSync(join(lab.ipc.claude.deliveries, "d0001.txt.consumed")) && readdirSync(lab.ipc.claude.drop).some((f) => f.endsWith(".json")), readdirSync(lab.ipc.claude.drop));
  const hookEvents = a.events.filter((e) => /hook/.test(String(e["type"])) || /hook/.test(String(e["subtype"])));
  rec.note("hook_lifecycle_event_types", [...new Set(hookEvents.map((e) => `${e["type"]}/${e["subtype"] ?? ""}`))]);
  rec.note("hook_lifecycle_event_samples", hookEvents.slice(0, 4));
  rec.check("--include-hook-events emits hook lifecycle events", hookEvents.length > 0);
  const toolUse = a.events.filter((e) => e["type"] === "assistant").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_use");
  rec.note("tool_use_blocks", toolUse.map((b: any) => ({ name: b.name, input: b.input })));
  const bashSandboxed = a.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_result");
  rec.note("tool_result_sample", bashSandboxed[0]);

  // A3: memory across turns in one process
  const r3 = await turn(a, "A3", "What exact word did my first message in this conversation ask you to reply with? Reply with only that word.");
  rec.check("turn A3: process remembers turn A1", /READY/.test(resultText(r3)), resultText(r3));
  const thinking = a.events.filter((e) => e["type"] === "assistant").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "thinking" || b.type === "redacted_thinking");
  rec.note("thinking_blocks", { count: thinking.length, sample: thinking[0] ? { ...thinking[0], thinking: String(thinking[0].thinking ?? "").slice(0, 80) } : null });
  rec.note("result_usage_cumulative", a.events.filter((e) => e["type"] === "result").map((r) => ({ usage: r["usage"], modelUsage: r["modelUsage"], total_cost_usd: r["total_cost_usd"], num_turns: r["num_turns"], duration_ms: r["duration_ms"] })));
  noteShapes(a);
  const tClose = Date.now();
  a.endInput();
  const exitA = await Promise.race([a.exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
  rec.check("closing stdin ends the long-lived process", exitA !== null && exitA.code === 0, { exit: exitA, ms: Date.now() - tClose, stderrTail: a.stderr.slice(-300) });
  rec.note("session_A_wall_ms", Date.now() - tA0);
} catch (e) {
  rec.check("session A completed", false, String(e));
  a.kill("SIGKILL");
}

// ---- Session B: --resume by explicit id, --effort low, hook again ----
const b = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...baseArgs, "--permission-mode", "auto", "--resume", sessionId, "--effort", "low"], cwd: lab.worktrees.claude, env: { ...env, CHATROOM_TURN: "turn0002" }, logFile: rec.file("sessionB.jsonl"),
  onControlRequest: (req) => { controlRequests.push(req); return { behavior: "allow" }; } });
try {
  const before = hookEntries().length;
  const r4 = await turn(b, "B1", "Use the Bash tool to run exactly: echo again\nThen reply with only the secret word from the [chatroom] message you received earlier in this conversation.");
  const init = initOf(b);
  rec.note("init_event_resumed", init);
  rec.check("resumed session reports the same session_id", init?.["session_id"] === sessionId, { got: init?.["session_id"] });
  rec.check("resumed session reports the worktree cwd", init?.["cwd"] === lab.worktrees.claude, init?.["cwd"]);
  rec.check("turn B1: resumed session remembers the hook delivery from session A", /PLUM/i.test(resultText(r4)), resultText(r4));
  const post = hookEntries().slice(before).filter((h) => h["input"]?.hook_event_name === "PostToolUse");
  rec.check("hook input effort.level is 'low' with --effort low", post.some((h) => h["input"]?.effort?.level === "low"), post.map((h) => h["input"]?.effort));
  rec.note("resumed_result", { ...b.events.find((e) => e["type"] === "result"), result: resultText(r4).slice(0, 100) });
  noteShapes(b);
  b.endInput();
  const exitB = await Promise.race([b.exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
  rec.check("resumed process exits on stdin close", exitB !== null && exitB.code === 0, exitB);
} catch (e) {
  rec.check("session B completed", false, String(e));
  b.kill("SIGKILL");
}

// ---- Session C: manual mode to capture the control request/response wire shapes ----
const cId = randomUUID();
let pendingDecision: "allow" | "deny" = "allow";
const c = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...baseArgs, "--permission-mode", "manual", "--session-id", cId], cwd: lab.worktrees.claude, env: { ...env, CHATROOM_TURN: "turn0003" }, logFile: rec.file("sessionC.jsonl"),
  onControlRequest: (req) => {
    controlRequests.push(req);
    const input = req["request"]?.input ?? req["request"]?.tool_input;
    return pendingDecision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Probe denies this command." };
  } });
try {
  const r5 = await turn(c, "C1", "Use the Bash tool to run exactly: echo ctl\nReply with only the command's output.", 180_000);
  rec.note("control_request_sample", controlRequests[0]);
  rec.check("manual mode: a control_request arrived on stdout for Bash", controlRequests.some((r) => r["type"] === "control_request"), controlRequests.length);
  rec.check("control_response allow let the command run", /ctl/.test(resultText(r5)), resultText(r5));
  pendingDecision = "deny";
  const n = controlRequests.length;
  const r6 = await turn(c, "C2", "Use the Bash tool to run exactly: echo denied\nIf the tool is refused, reply with the refusal message you received, verbatim.", 180_000);
  rec.check("control_response deny reached the model", controlRequests.length > n && /den/i.test(resultText(r6)), resultText(r6));
  rec.note("permission_denials_on_result", r6["permission_denials"]);
  noteShapes(c);
  c.endInput();
  await Promise.race([c.exited, new Promise((r) => setTimeout(r, 60_000))]);
} catch (e) {
  rec.check("session C completed", false, String(e));
  c.kill("SIGKILL");
}

rec.note("event_shapes_seen", Object.fromEntries([...shapesSeen.entries()].map(([k, v]) => [k, Object.keys(v)])));
writeFileSync(rec.file("event-shapes.json"), JSON.stringify(Object.fromEntries(shapesSeen), null, 2));
rec.finish({ sessionId, lab: lab.root });

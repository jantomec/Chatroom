// Phase 0 item 2 addendum: PostToolUse fires only after a tool call succeeds (docs), so a
// delivery must also ride PostToolUseFailure. Measure: with both hooks registered, does a
// delivery pending during a failing command reach the model through PostToolUseFailure's
// additionalContext, and what does that hook's input look like?
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText } from "./lib/claude.ts";
import { buildLab } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("02e-claude-hook-failure");
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab02e"));
const hookLog = rec.file("hook-input.jsonl"); writeFileSync(hookLog, "");
const env = cleanEnv({
  CHATROOM_AGENT: "claude", CHATROOM_HANDLE: "clara", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.claude.drop, CHATROOM_DELIVERY_DIR: lab.ipc.claude.deliveries, CHATROOM_RECEIPT_DIR: lab.ipc.claude.receipts,
  CHATROOM_SCRATCH: lab.ipc.claude.scratch, CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  CHATROOM_NODE: process.execPath, CHATROOM_PROBE_HOOK: join(PROBES_ROOT, "lib", "hook.ts"), CHATROOM_HOOK_LOG: hookLog,
});
const hook = [{ matcher: "", hooks: [{ type: "command", command: "\"$CHATROOM_BIN\" hook" }] }];
const settings = { hooks: { PostToolUse: hook, PostToolUseFailure: hook } };
const brief = "You are Clara, a probe subject in a test harness. Run exactly the command you are given once, with no retries. Messages marked [chatroom] may arrive in tool results; read them.";
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--settings", JSON.stringify(settings),
  "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--append-system-prompt", brief, "--session-id", randomUUID()];
const p = new ClaudeProcess({ bin: CLAUDE_BIN, args, cwd: lab.worktrees.claude, env, logFile: rec.file("session.jsonl"), onControlRequest: (req) => ({ behavior: "allow", updatedInput: req["request"]?.input }) });
try {
  writeFileSync(join(lab.ipc.claude.deliveries, "d0001.txt"), "[chatroom] You are @clara. 1 new message.\n\n--- #9 · user → @clara · 10:07:12\nThe secret word is QUINCE.\n");
  const mark = p.mark(); const t0 = Date.now();
  p.sendUser("Use the Bash tool to run exactly: cat /nonexistent-probe-file\nIt will fail; do not retry. A [chatroom] message may be attached to the failed tool result. Reply with only the secret word it contains, or NONE if you received no such message.");
  const r = await p.waitForResult(mark, 300_000);
  rec.log(`turn: ${Date.now() - t0} ms, result=${JSON.stringify(resultText(r)).slice(0, 200)}`);
  const hooks = readFileSync(hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const events = p.events.filter((e) => e["subtype"] === "hook_started" || e["subtype"] === "hook_response").map((e) => ({ subtype: e["subtype"], hook_name: e["hook_name"], hook_event: e["hook_event"], output: e["output"], exit_code: e["exit_code"], outcome: e["outcome"] }));
  rec.note("hook_lifecycle_events", events);
  rec.note("hook_inputs", hooks.map((h) => ({ event: h.input?.hook_event_name, tool: h.input?.tool_name, keys: Object.keys(h.input ?? {}), error: h.input?.error, tool_response: h.input?.tool_response, is_interrupt: h.input?.is_interrupt })));
  rec.check("PostToolUseFailure fired for the failing Bash call", hooks.some((h) => h.input?.hook_event_name === "PostToolUseFailure" && h.input?.tool_name === "Bash"), hooks.map((h) => h.input?.hook_event_name));
  rec.check("PostToolUse did not fire for the failing call", !hooks.some((h) => h.input?.hook_event_name === "PostToolUse" && h.input?.tool_name === "Bash"));
  const toolResult = p.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).find((b: any) => b.type === "tool_result");
  rec.note("tool_result", toolResult);
  rec.check("the delivery reached the model through PostToolUseFailure's additionalContext", /QUINCE/.test(resultText(r)), resultText(r));
  p.endInput(); await Promise.race([p.exited, new Promise((res) => setTimeout(res, 30_000))]);
} catch (e) { rec.check("completed", false, String(e) + p.stderr.slice(-500)); p.kill("SIGKILL"); }
rec.finish();

// Phase 0 item 2, control request wire shapes: manual mode with a command outside the
// read-only set, allow once and deny once; the hook still registered.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText, type ClaudeEvent } from "./lib/claude.ts";
import { buildLab } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("02b-claude-control");
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab02b"));
const hookLog = rec.file("hook-input.jsonl"); writeFileSync(hookLog, "");
const env = cleanEnv({
  CHATROOM_AGENT: "claude", CHATROOM_HANDLE: "clara", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.claude.drop, CHATROOM_DELIVERY_DIR: lab.ipc.claude.deliveries, CHATROOM_RECEIPT_DIR: lab.ipc.claude.receipts,
  CHATROOM_SCRATCH: lab.ipc.claude.scratch, CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  CHATROOM_NODE: process.execPath, CHATROOM_PROBE_HOOK: join(PROBES_ROOT, "lib", "hook.ts"), CHATROOM_HOOK_LOG: hookLog,
});
const settings = { hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "\"$CHATROOM_BIN\" hook" }] }] } };
const brief = "You are Clara, a probe subject in a test harness. Answer with exactly what is asked and nothing more.";
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events",
  "--settings", JSON.stringify(settings), "--permission-prompts", "host", "--append-system-prompt", brief, "--permission-mode", "manual", "--session-id", randomUUID()];
const requests: ClaudeEvent[] = [];
let decision: "allow" | "deny" = "allow";
const responses: unknown[] = [];
const c = new ClaudeProcess({ bin: CLAUDE_BIN, args, cwd: lab.worktrees.claude, env, logFile: rec.file("session.jsonl"),
  onControlRequest: (req) => {
    requests.push(req);
    const input = req["request"]?.input;
    const resp = decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Probe denies this command." };
    responses.push(resp);
    return resp;
  } });
async function turn(label: string, text: string): Promise<ClaudeEvent> {
  const mark = c.mark(); const t0 = Date.now();
  c.sendUser(text);
  const r = await c.waitForResult(mark, 180_000);
  rec.log(`turn ${label}: ${Date.now() - t0} ms, subtype=${r["subtype"]}, result=${JSON.stringify(resultText(r)).slice(0, 200)}`);
  return r;
}
try {
  const r1 = await turn("C1", "Use the Bash tool to run exactly: touch ctl-allowed.txt && echo created\nReply with only the command's output.");
  rec.note("control_request_sample", requests[0]);
  rec.note("control_response_sent", responses[0]);
  rec.check("manual mode: a control_request arrived for a non-read-only Bash command", requests.length >= 1, requests.length);
  rec.check("allow response let the command run (file exists)", existsSync(join(lab.worktrees.claude, "ctl-allowed.txt")), resultText(r1));
  decision = "deny";
  const n = requests.length;
  const r2 = await turn("C2", "Use the Bash tool to run exactly: touch ctl-denied.txt && echo created\nIf the tool call is refused, reply with the refusal text you received, verbatim.");
  rec.note("control_request_deny_sample", requests[n]);
  rec.check("deny response: file not created", !existsSync(join(lab.worktrees.claude, "ctl-denied.txt")), resultText(r2));
  rec.check("deny reason reached the model", /Probe denies/i.test(resultText(r2)), resultText(r2));
  const denied = c.events.filter((e) => e["type"] === "system" && e["subtype"] === "permission_denied");
  rec.note("permission_denied_system_events", denied);
  rec.note("permission_denials_on_result", r2["permission_denials"]);
  const toolResults = c.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_result");
  rec.note("tool_result_after_deny", toolResults.at(-1));
  rec.note("event_types", [...new Set(c.events.map((e) => `${e["type"]}/${e["subtype"] ?? ""}`))]);
  c.endInput();
  await Promise.race([c.exited, new Promise((r) => setTimeout(r, 60_000))]);
} catch (e) {
  rec.check("completed", false, String(e));
  c.kill("SIGKILL");
}
rec.finish();

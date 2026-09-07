// Phase 0 item 2, control protocol: does a Bash write inside the worktree run in auto mode
// without a host handshake; does an `initialize` control request enable can_use_tool
// routing in manual mode; the wire shapes of both directions.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText, type ClaudeEvent } from "./lib/claude.ts";
import { buildLab } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("02c-claude-control");
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab02c"));
const hookLog = rec.file("hook-input.jsonl"); writeFileSync(hookLog, "");
const env = cleanEnv({
  CHATROOM_AGENT: "claude", CHATROOM_HANDLE: "clara", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.claude.drop, CHATROOM_DELIVERY_DIR: lab.ipc.claude.deliveries, CHATROOM_RECEIPT_DIR: lab.ipc.claude.receipts,
  CHATROOM_SCRATCH: lab.ipc.claude.scratch, CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  CHATROOM_NODE: process.execPath, CHATROOM_PROBE_HOOK: join(PROBES_ROOT, "lib", "hook.ts"), CHATROOM_HOOK_LOG: hookLog,
});
const settings = { hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "\"$CHATROOM_BIN\" hook" }] }] } };
const brief = "You are Clara, a probe subject in a test harness. Answer with exactly what is asked and nothing more.";
const baseArgs = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events",
  "--settings", JSON.stringify(settings), "--permission-prompts", "host", "--append-system-prompt", brief];
const wt = lab.worktrees.claude;

async function session(label: string, extraArgs: string[], body: (p: ClaudeProcess, requests: ClaudeEvent[]) => Promise<void>, decide?: (req: ClaudeEvent) => unknown): Promise<void> {
  const requests: ClaudeEvent[] = [];
  const p = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...baseArgs, ...extraArgs, "--session-id", randomUUID()], cwd: wt, env, logFile: rec.file(`${label}.jsonl`),
    onControlRequest: (req) => { requests.push(req); rec.note(`${label}_control_request_${requests.length}`, req); return decide ? decide(req) : { behavior: "allow" }; } });
  try { await body(p, requests); } catch (e) { rec.check(`${label} completed`, false, String(e)); }
  p.endInput();
  await Promise.race([p.exited, new Promise((r) => setTimeout(r, 30_000))]);
  if (p.child.exitCode === null) p.kill("SIGKILL");
  rec.note(`${label}_control_responses_and_denials`, { denials: p.events.filter((e) => e["subtype"] === "permission_denied").map((e) => e["message"]), controlResponses: p.events.filter((e) => e["type"] === "control_response") });
}
async function turn(p: ClaudeProcess, label: string, text: string): Promise<ClaudeEvent> {
  const mark = p.mark(); const t0 = Date.now(); p.sendUser(text);
  const r = await p.waitForResult(mark, 180_000);
  rec.log(`turn ${label}: ${Date.now() - t0} ms, subtype=${r["subtype"]}, result=${JSON.stringify(resultText(r)).slice(0, 200)}`);
  return r;
}

// S1: auto mode, no handshake, a write inside the worktree
await session("S1-auto", ["--permission-mode", "auto"], async (p) => {
  await turn(p, "S1", "Use the Bash tool to run exactly: touch auto.txt && echo created\nReply with only the command's output.");
  rec.check("auto mode: touch inside the worktree ran without a host handshake", existsSync(join(wt, "auto.txt")), p.events.filter((e) => e["subtype"] === "permission_denied").map((e) => e["message"]));
});

// S2: manual mode, initialize handshake first, then allow and deny
await session("S2-manual-init", ["--permission-mode", "manual"], async (p, requests) => {
  const mark = p.mark();
  p.write({ type: "control_request", request_id: "probe-init-1", request: { subtype: "initialize" } });
  let initResp: ClaudeEvent | null = null;
  try { initResp = await p.waitFor((e) => e["type"] === "control_response" || e["type"] === "control_request" || (e["type"] === "system" && e["subtype"] !== "init"), mark, 15_000, "initialize response"); } catch (e) { rec.note("S2_initialize_no_response", String(e)); }
  rec.note("S2_initialize_response", initResp);
  rec.check("initialize control request gets a control_response", initResp?.["type"] === "control_response", initResp);
  await turn(p, "S2a", "Use the Bash tool to run exactly: touch manual-allowed.txt && echo created\nReply with only the command's output.");
  rec.check("manual mode after initialize: can_use_tool control_request arrived", requests.some((r) => r["request"]?.subtype === "can_use_tool"), requests.map((r) => r["request"]?.subtype));
  rec.check("allow response let the write happen", existsSync(join(wt, "manual-allowed.txt")));
}, (req) => ({ behavior: "allow", updatedInput: req["request"]?.input }));

const s2ok = rec.checks.find((c) => c.name.startsWith("manual mode after initialize"))?.ok;
if (s2ok) {
  await session("S3-manual-deny", ["--permission-mode", "manual"], async (p, requests) => {
    const mark = p.mark();
    p.write({ type: "control_request", request_id: "probe-init-2", request: { subtype: "initialize" } });
    await p.waitFor((e) => e["type"] === "control_response", mark, 15_000, "initialize response").catch(() => null);
    const r = await turn(p, "S3", "Use the Bash tool to run exactly: touch manual-denied.txt && echo created\nIf the tool call is refused, reply with the refusal text you received, verbatim.");
    rec.check("deny response: file not created", !existsSync(join(wt, "manual-denied.txt")));
    rec.check("deny message reached the model", /Probe denies/i.test(resultText(r)), resultText(r));
    rec.note("S3_permission_denials_on_result", r["permission_denials"]);
    rec.note("S3_tool_result", p.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_result").at(-1));
    rec.check("deny: a can_use_tool request arrived", requests.some((r) => r["request"]?.subtype === "can_use_tool"));
  }, () => ({ behavior: "deny", message: "Probe denies this command." }));
}
rec.finish();

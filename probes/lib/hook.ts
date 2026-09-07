// Probe stand-in for `chatroom hook` (§8.2, §10): records the hook input, drains the
// delivery directory, writes a delivery_ack into the drop directory, and prints
// additionalContext when something was pending.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const raw = readFileSync(0, "utf8");
let hook: Record<string, any> = {};
try { hook = JSON.parse(raw); } catch { hook = { _unparsed: raw }; }

const log = process.env["CHATROOM_HOOK_LOG"];
if (log) appendFileSync(log, JSON.stringify({
  at: new Date().toISOString(), argv: process.argv.slice(2),
  env: { CHATROOM_AGENT: process.env["CHATROOM_AGENT"], CHATROOM_TURN: process.env["CHATROOM_TURN"], CLAUDE_EFFORT: process.env["CLAUDE_EFFORT"], TMPDIR: process.env["TMPDIR"], CLAUDE_PROJECT_DIR: process.env["CLAUDE_PROJECT_DIR"], cwd: process.cwd() },
  input: hook,
}) + "\n");

const deliveryDir = process.env["CHATROOM_DELIVERY_DIR"];
const files: string[] = []; const texts: string[] = [];
if (deliveryDir && existsSync(deliveryDir)) {
  for (const f of readdirSync(deliveryDir).sort()) if (f.endsWith(".txt")) { files.push(f); texts.push(readFileSync(join(deliveryDir, f), "utf8")); }
}
const drop = process.env["CHATROOM_OPERATION_DIR"];
if (drop && existsSync(drop)) {
  const id = randomUUID();
  const tmp = join(drop, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ protocol: 3, operation_id: id, type: "delivery_ack", created_at: new Date().toISOString(),
    payload: { delivered: files, effort: hook["effort"]?.level ?? null, cwd: hook["cwd"] ?? null, hook_event_name: hook["hook_event_name"] ?? null } }));
  renameSync(tmp, join(drop, `${id}.json`));
}
// The orchestrator removes a delivery after the database says it was accepted; the probe
// marks it consumed instead so a second hook invocation does not re-deliver it.
for (const f of files) renameSync(join(deliveryDir!, f), join(deliveryDir!, f + ".consumed"));
if (texts.length > 0) {
  // The CLI rejects output whose hookEventName differs from the event that ran the hook.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hook["hook_event_name"] ?? "PostToolUse", additionalContext: texts.join("\n\n") } }));
}

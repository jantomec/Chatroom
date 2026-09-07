// Phase 0 item 2, control routing variants in manual mode: --permission-prompt-tool stdio,
// the SDK entrypoint variable, and an MCP permission prompt tool.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText, type ClaudeEvent } from "./lib/claude.ts";
import { buildLab } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("02d-claude-control");
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab02d"));
const wt = lab.worktrees.claude;
const brief = "You are Clara, a probe subject in a test harness. Answer with exactly what is asked and nothing more.";
const baseArgs = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--append-system-prompt", brief];
const mcpLog = rec.file("mcp.jsonl"); writeFileSync(mcpLog, "");

async function variant(label: string, extraArgs: string[], extraEnv: Record<string, string>, file: string, handshake: boolean): Promise<void> {
  const requests: ClaudeEvent[] = [];
  const env = cleanEnv({ CHATROOM_AGENT: "claude", CHATROOM_NODE: process.execPath, PROBE_MCP_LOG: mcpLog, ...extraEnv });
  const p = new ClaudeProcess({ bin: CLAUDE_BIN, args: [...baseArgs, ...extraArgs, "--session-id", randomUUID()], cwd: wt, env, logFile: rec.file(`${label}.jsonl`),
    onControlRequest: (req) => { requests.push(req); rec.note(`${label}_control_request`, req); return { behavior: "allow", updatedInput: req["request"]?.input }; } });
  try {
    if (handshake) { const m = p.mark(); p.write({ type: "control_request", request_id: `init-${label}`, request: { subtype: "initialize" } }); await p.waitFor((e) => e["type"] === "control_response", m, 15_000, "init").catch(() => null); }
    const mark = p.mark(); const t0 = Date.now();
    p.sendUser(`Use the Bash tool to run exactly: touch ${file} && echo created\nReply with only the command's output.`);
    const r = await p.waitForResult(mark, 180_000);
    rec.log(`${label}: ${Date.now() - t0} ms result=${JSON.stringify(resultText(r)).slice(0, 160)}`);
    rec.check(`${label}: a can_use_tool control_request reached the host`, requests.some((q) => q["request"]?.subtype === "can_use_tool"), requests.map((q) => q["request"]?.subtype));
    rec.check(`${label}: the write happened after the host allowed it`, existsSync(join(wt, file)), { denials: p.events.filter((e) => e["subtype"] === "permission_denied").map((e) => e["message"]), stderr: p.stderr.slice(-300) });
    rec.note(`${label}_init_mcp_servers`, p.events.find((e) => e["subtype"] === "init")?.["mcp_servers"]);
  } catch (e) { rec.check(`${label} completed`, false, String(e) + p.stderr.slice(-500)); }
  p.endInput(); await Promise.race([p.exited, new Promise((r) => setTimeout(r, 30_000))]); if (p.child.exitCode === null) p.kill("SIGKILL");
}
await variant("V1-prompt-tool-stdio", ["--permission-prompts", "host", "--permission-prompt-tool", "stdio"], {}, "v1.txt", false);
await variant("V2-sdk-entrypoint", ["--permission-prompts", "host"], { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, "v2.txt", true);
const mcpConfig = { mcpServers: { probe: { command: process.execPath, args: [join(PROBES_ROOT, "lib", "permission-mcp.ts")] } } };
await variant("V3-mcp-prompt-tool", ["--permission-prompts", "host", "--mcp-config", JSON.stringify(mcpConfig), "--permission-prompt-tool", "mcp__probe__approve"], {}, "v3.txt", false);
rec.note("mcp_calls", (await import("node:fs")).readFileSync(mcpLog, "utf8").split("\n").filter(Boolean).slice(0, 12).map((l) => JSON.parse(l)));
rec.finish();

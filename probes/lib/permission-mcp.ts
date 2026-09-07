// Minimal MCP stdio server exposing one tool, `approve`, for --permission-prompt-tool.
// Records every call to $PROBE_MCP_LOG and answers allow or deny per $PROBE_MCP_DECISION.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (o: unknown) => { if (process.env["PROBE_MCP_LOG"]) appendFileSync(process.env["PROBE_MCP_LOG"]!, JSON.stringify(o) + "\n"); };
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  log({ dir: "in", m });
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve", description: "Permission prompt handler", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } } } }] } });
  else if (m.method === "tools/call") {
    const deny = process.env["PROBE_MCP_DECISION"] === "deny";
    const body = deny ? { behavior: "deny", message: "Probe MCP denies this command." } : { behavior: "allow", updatedInput: m.params?.arguments?.input ?? {} };
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});

// File IPC between the agents' commands and the orchestrator (ARCHITECTURE.md §8), and the
// agent-side commands themselves: post, reply, ask, inbox, hook.
import { randomUUID } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Participant } from "./log.ts";

export interface Operation { op: string; type: "post" | "reply" | "ask" | "delivery_ack"; at: string; to?: string[]; body?: string; reply_to?: number | null; delivered?: string[]; effort?: string | null; cwd?: string | null }
export interface Receipt { op: string; status: "accepted" | "rejected"; message?: number; reason?: string }

/** Write a file atomically: temp file, sync, rename. */
export function writeAtomic(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  const fd = openSync(tmp, "w"); writeSync(fd, text); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, join(dir, name));
  return join(dir, name);
}

export class Ipc {
  readonly base: string;                 // <state dir>/ipc/<conversation>
  private seen = new Set<string>();      // "<agent>/<file>" already imported
  private deliverySeq = 0;
  constructor(base: string) { this.base = base; }
  dir(agent: Agent): string { return join(this.base, agent); }
  drop(agent: Agent): string { return join(this.base, agent, "from-agent"); }
  scratch(agent: Agent): string { return join(this.base, agent, "scratch"); }
  deliveries(agent: Agent): string { return join(this.base, agent, "to-agent", "deliveries"); }
  receipts(agent: Agent): string { return join(this.base, agent, "to-agent", "receipts"); }
  ensure(agent: Agent): { drop: string; scratch: string } {
    for (const d of [this.drop(agent), this.scratch(agent), this.deliveries(agent), this.receipts(agent)]) mkdirSync(d, { recursive: true, mode: 0o700 });
    return { drop: this.drop(agent), scratch: this.scratch(agent) };
  }
  /** Clear an agent's drop and scratch directories between turns. */
  clear(agent: Agent): void {
    for (const d of [this.drop(agent), this.scratch(agent)]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true, mode: 0o700 }); }
    for (const k of [...this.seen]) if (k.startsWith(agent + "/")) this.seen.delete(k);
  }
  /** Operation files in the agent's drop directory not yet imported, oldest first; unparsable ones are renamed .rejected. */
  poll(agent: Agent): Operation[] {
    const dir = this.drop(agent);
    if (!existsSync(dir)) return [];
    const out: Operation[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const key = `${agent}/${f}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      try {
        const o = JSON.parse(readFileSync(join(dir, f), "utf8")) as Operation;
        if (typeof o.op !== "string" || !["post", "reply", "ask", "delivery_ack"].includes(o.type)) throw new Error("shape");
        if (o.type !== "delivery_ack" && (typeof o.body !== "string" || o.body.length > 64 * 1024)) throw new Error("body");
        out.push(o);
      } catch { try { renameSync(join(dir, f), join(dir, f + ".rejected")); } catch { /* gone */ } }
    }
    return out;
  }
  writeReceipt(agent: Agent, r: Receipt): void { writeAtomic(this.receipts(agent), `${r.op}.json`, JSON.stringify(r)); }
  writeAnswer(agent: Agent, op: string, answer: unknown): void { writeAtomic(this.receipts(agent), `${op}.answer.json`, JSON.stringify(answer)); }
  writeDelivery(agent: Agent, text: string): string {
    const name = `d-${Date.now()}-${String(++this.deliverySeq).padStart(4, "0")}.txt`;
    writeAtomic(this.deliveries(agent), name, text);
    return name;
  }
  removeDelivery(agent: Agent, name: string): void { try { unlinkSync(join(this.deliveries(agent), name)); } catch { /* already gone */ } }
  pendingDeliveries(agent: Agent): string[] { const d = this.deliveries(agent); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".txt")).sort() : []; }
}

// ---------------- agent side ----------------

export interface AgentEnv { agent: Agent; handle: string; drop: string; deliveries: string; receipts: string; askTimeoutMs: number }
export function agentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv | null {
  const need = ["CHATROOM_AGENT", "CHATROOM_HANDLE", "CHATROOM_OPERATION_DIR", "CHATROOM_DELIVERY_DIR", "CHATROOM_RECEIPT_DIR"];
  if (need.some((k) => !env[k])) return null;
  const agent = env["CHATROOM_AGENT"] as Agent;
  if (agent !== "claude" && agent !== "codex") return null;
  return { agent, handle: env["CHATROOM_HANDLE"]!, drop: env["CHATROOM_OPERATION_DIR"]!, deliveries: env["CHATROOM_DELIVERY_DIR"]!, receipts: env["CHATROOM_RECEIPT_DIR"]!, askTimeoutMs: Number(env["CHATROOM_ASK_TIMEOUT"] ?? "60") * 1000 };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function writeOp(e: AgentEnv, o: Operation): void { writeAtomic(e.drop, `${o.op}.json`, JSON.stringify(o)); }
async function waitFile(path: string, timeoutMs: number): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (existsSync(path)) { try { return readFileSync(path, "utf8"); } catch { /* being renamed */ } } await sleep(100); }
  return null;
}

export interface Io { out: (s: string) => void; err: (s: string) => void; stdin: () => string }

function parseTo(args: string[]): { to: string[] | undefined; rest: string[] } {
  const i = args.indexOf("--to");
  if (i < 0) return { to: undefined, rest: args };
  const to = (args[i + 1] ?? "").split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  return { to, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** `chatroom post|reply|ask|inbox|hook`, run inside an agent's turn. Returns the exit code. */
export async function agentCommand(cmd: string, args: string[], e: AgentEnv, io: Io): Promise<number> {
  switch (cmd) {
    case "post": case "reply": case "ask": {
      let replyTo: number | null = null; let a = args;
      if (cmd === "reply") { replyTo = Number(a[0]); if (!Number.isInteger(replyTo)) { io.err("usage: reply <message id> <text>"); return 2; } a = a.slice(1); }
      const { to, rest } = parseTo(a);
      const body = rest.join(" ").trim();
      if (!body) { io.err(`usage: ${cmd} [--to handle[,handle]] <text>`); return 2; }
      const op: Operation = { op: randomUUID(), type: cmd === "reply" ? "reply" : cmd === "ask" ? "ask" : "post", at: new Date().toISOString(), body, reply_to: replyTo };
      if (to) op.to = to;
      writeOp(e, op);
      const receipt = await waitFile(join(e.receipts, `${op.op}.json`), 5000);
      if (!receipt) { io.out(`acceptance unknown (op ${op.op}); retrying with the same op returns the same result`); return 0; }
      const r = JSON.parse(receipt) as Receipt;
      if (r.status !== "accepted") { io.err(`rejected: ${r.reason ?? "unknown"}`); return 1; }
      io.out(`#${r.message}`);
      if (cmd !== "ask") return 0;
      const answer = await waitFile(join(e.receipts, `${op.op}.answer.json`), e.askTimeoutMs);
      if (!answer) { io.out(`no answer within ${Math.round(e.askTimeoutMs / 1000)} s (indeterminate); continue and check "$CHATROOM_BIN" inbox later`); return 0; }
      const ans = JSON.parse(answer) as { status: string; message?: { id: number; from: string; body: string } };
      if (ans.message) io.out(`${ans.status}: #${ans.message.id} ${ans.message.from}: ${ans.message.body}${ans.status === "probable" ? "\n(correlation inferred: this message targets you and came after your question; a later explicit reply may still arrive)" : ""}`);
      return 0;
    }
    case "inbox": case "hook": {
      let hook: Record<string, any> = {};
      if (cmd === "hook") { try { hook = JSON.parse(io.stdin()); } catch { hook = {}; } }
      const files = existsSync(e.deliveries) ? readdirSync(e.deliveries).filter((f) => f.endsWith(".txt")).sort() : [];
      const texts = files.map((f) => readFileSync(join(e.deliveries, f), "utf8"));
      const ack: Operation = { op: randomUUID(), type: "delivery_ack", at: new Date().toISOString(), delivered: files };
      if (cmd === "hook") { ack.effort = hook["effort"]?.level ?? null; ack.cwd = hook["cwd"] ?? null; }
      if (existsSync(e.drop)) writeOp(e, ack);
      if (cmd === "inbox") { io.out(texts.length ? texts.join("\n") : "no new messages"); return 0; }
      if (texts.length) io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: hook["hook_event_name"] ?? "PostToolUse", additionalContext: texts.join("\n") } }));
      return 0;
    }
    default: io.err(`unknown agent command ${cmd}`); return 2;
  }
}

export function participantsFromHandles(handles: string[] | undefined, names: { claude: string; codex: string }): Participant[] | undefined {
  if (!handles) return undefined;
  const out: Participant[] = [];
  for (const h of handles) { const l = h.toLowerCase(); if (l === "user") out.push("user"); else if (l === names.claude.toLowerCase()) out.push("claude"); else if (l === names.codex.toLowerCase()) out.push("codex"); }
  return out;
}

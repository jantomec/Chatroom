// Codex through `codex app-server` (JSON-RPC over stdio), with `codex exec` as the fallback
// (ARCHITECTURE.md §9.3, §9.4).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Capabilities, Driver, DriverEvent, SessionSpec } from "../types.ts";

export interface CodexOptions {
  bin: string;
  config: Record<string, unknown>;                    // the config map of §12.2 (profile, environment set)
  model: string | null; effort: string | null;
  env: () => NodeJS.ProcessEnv;
  scratch: () => string;                              // for exec's -o file
  raw?: ((line: string) => void) | undefined;
  preferAppServer?: boolean;
}

type Msg = Record<string, any>;

export class CodexDriver implements Driver {
  readonly agent = "codex" as const;
  capabilities: Capabilities = { nativeSteering: true, hookDelivery: false, interrupt: true, hostPrompts: true, nativeCommit: true };
  private opts: CodexOptions;
  private handler: ((e: DriverEvent) => void) | null = null;
  private child: ChildProcess | null = null;
  private mode: "app-server" | "exec" = "app-server";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private cwd = ""; private brief = ""; private turn = "t-0000";
  private finalText = "";
  private serverRequests = new Map<string, { id: unknown; method: string; params: Msg }>();
  constructor(opts: CodexOptions) { this.opts = opts; }
  onEvent(h: (e: DriverEvent) => void): void { this.handler = h; }
  private emit(e: DriverEvent): void { this.handler?.(e); }

  // ---------------- app-server transport ----------------
  private async spawnServer(): Promise<void> {
    const child = spawn(this.opts.bin, ["app-server"], { cwd: this.cwd, env: this.opts.env(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p.reject(new Error(`app-server exited (${code ?? signal})`));
      this.pending.clear();
      this.emit({ type: "exit", code, signal: signal as string | null });
      if (stderr.trim()) this.emit({ type: "error", message: stderr.trim().split("\n").slice(-3).join(" | ") });
    });
    await this.request("initialize", { clientInfo: { name: "chatroom", title: "Chatroom", version: "0.0.0" }, capabilities: {} });
    this.notify("initialized", {});
  }
  private write(obj: unknown): void {
    const line = JSON.stringify(obj); this.opts.raw?.("-> " + line);
    if (!this.child?.stdin?.writable) throw new Error("app-server is not running");
    this.child.stdin.write(line + "\n");
  }
  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }); });
  }
  private notify(method: string, params: unknown): void { this.write({ method, params }); }

  private onLine(line: string): void {
    this.opts.raw?.("<- " + line);
    let m: Msg; try { m = JSON.parse(line); } catch { return; }
    if (m["method"] !== undefined && m["id"] !== undefined) { this.onServerRequest(m); return; }
    if (m["id"] !== undefined && this.pending.has(m["id"])) { const p = this.pending.get(m["id"])!; this.pending.delete(m["id"]); if (m["error"]) p.reject(new Error(`${JSON.stringify(m["error"])}`)); else p.resolve(m["result"]); return; }
    if (m["method"]) this.onNotification(m["method"], m["params"] ?? {});
  }
  private onServerRequest(m: Msg): void {
    const method = m["method"] as string; const params = m["params"] ?? {};
    const id = String(m["id"]);
    this.serverRequests.set(id, { id: m["id"], method, params });
    let summary = method;
    if (method === "item/commandExecution/requestApproval") summary = `command: ${params.command ?? ""}${params.reason ? ` (${params.reason})` : ""}`;
    else if (method === "item/fileChange/requestApproval") summary = `file change${params.reason ? `: ${params.reason}` : ""}${params.grantRoot ? ` in ${params.grantRoot}` : ""}`;
    else if (method === "item/permissions/requestApproval") summary = `permissions: ${JSON.stringify(params.permissions ?? {}).slice(0, 160)}${params.reason ? ` (${params.reason})` : ""}`;
    else { this.write({ id: m["id"], result: {} }); this.serverRequests.delete(id); return; }
    this.emit({ type: "prompt", id, summary: summary.slice(0, 200), request: params });
  }
  private onNotification(method: string, p: Msg): void {
    switch (method) {
      case "item/started": { const it = p.item ?? {}; if (it.type === "commandExecution") this.emit({ type: "tool", name: "shell", input: { command: it.command } }); else if (it.type === "fileChange") this.emit({ type: "tool", name: "edit", input: { path: (it.changes ?? []).map((c: Msg) => c.path).join(", ") } }); else if (it.type === "mcpToolCall") this.emit({ type: "tool", name: `${it.server}/${it.tool}`, input: it.arguments }); break; }
      case "item/completed": {
        const it = p.item ?? {};
        if (it.type === "agentMessage" && it.text) { this.finalText = it.text; this.emit({ type: "text", text: it.text }); }
        else if (it.type === "reasoning") { const t = (it.summary ?? []).join(" ").trim(); if (t) this.emit({ type: "reasoning", text: t }); }
        else if (it.type === "commandExecution") this.emit({ type: "tool_result", text: `exit ${it.exitCode ?? "?"}: ${String(it.aggregatedOutput ?? "").slice(0, 300)}`, error: it.exitCode !== 0 });
        break;
      }
      case "item/autoApprovalReview/completed": {
        const r = p.review ?? {};
        const text = "auto-review " + String(r.status ?? "?") + " (risk " + String(r.riskLevel ?? "?") + "): " + String(r.rationale ?? "");
        this.emit({ type: "review", text: text.slice(0, 300) });
        break;
      }
      case "guardianWarning": this.emit({ type: "review", text: String(p.message ?? "").slice(0, 300) }); break;
      case "thread/tokenUsage/updated": { const u = p.tokenUsage ?? {}; this.emit({ type: "status", status: { contextTokens: u.last?.inputTokens ?? null, contextWindow: u.modelContextWindow ?? null } }); break; }
      case "thread/settings/updated": { const s = p.threadSettings ?? {}; this.emit({ type: "status", status: { model: s.model ?? null, effort: s.effort ?? null, cwd: s.cwd ?? null } }); break; }
      case "model/rerouted": this.emit({ type: "status", status: { model: p.toModel ?? null } }); this.emit({ type: "text", text: `model rerouted ${p.fromModel} → ${p.toModel} (${p.reason})` }); break;
      case "turn/completed": {
        const t = p.turn ?? {};
        if (t.id !== this.turnId) break;
        this.turnId = null;
        if (t.status === "failed") this.emit({ type: "error", message: t.error?.message ?? "turn failed" });
        this.emit({ type: "final", text: t.status === "interrupted" ? "" : this.finalText, cost: { status: t.status, duration_ms: t.durationMs } });
        this.finalText = "";
        break;
      }
      case "error": this.emit({ type: "error", message: `${p.error?.message ?? "error"}${p.willRetry ? " (retrying)" : ""}` }); break;
      default: break;
    }
  }

  // ---------------- driver contract ----------------
  async connect(session: SessionSpec): Promise<{ sessionId: string; resumed: boolean }> {
    this.cwd = session.cwd; this.brief = session.brief;
    if (this.opts.preferAppServer !== false) {
      try {
        await this.spawnServer();
        const common = { cwd: this.cwd, approvalPolicy: "on-request", approvalsReviewer: "auto_review", config: this.withEffort(this.opts.config), developerInstructions: this.brief, ...(this.opts.model ? { model: this.opts.model } : {}) };
        let resumed = false; let resp: Msg | null = null;
        if (session.id) { try { resp = await this.request("thread/resume", { threadId: session.id, ...common }); resumed = true; } catch (e) { this.emit({ type: "error", message: `resume failed, starting a new thread: ${String(e).slice(0, 200)}` }); } }
        if (!resp) resp = await this.request("thread/start", { ...common, serviceName: "chatroom" });
        this.threadId = resp!["thread"].id;
        this.emit({ type: "status", status: { model: resp!["model"] ?? null, effort: resp!["reasoningEffort"] ?? null, cwd: resp!["cwd"] ?? null } });
        this.mode = "app-server";
        this.capabilities = { ...this.capabilities, nativeSteering: true, hostPrompts: true };
        return { sessionId: this.threadId!, resumed };
      } catch (e) {
        this.emit({ type: "error", message: `app-server unavailable, falling back to codex exec: ${String(e).slice(0, 200)}` });
        await this.close();
      }
    }
    this.mode = "exec";
    this.capabilities = { ...this.capabilities, nativeSteering: false, hostPrompts: false };
    this.threadId = session.id;
    return { sessionId: session.id ?? "", resumed: session.id !== null };
  }
  private withEffort(config: Record<string, unknown>): Record<string, unknown> { return this.opts.effort ? { ...config, model_reasoning_effort: this.opts.effort } : config; }

  async startTurn(turnId: string, input: string): Promise<void> {
    this.turn = turnId; this.finalText = "";
    if (this.mode === "app-server") {
      if (!this.child) throw new Error("app-server is not running; reconnect");
      const r = await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text: input }] });
      this.turnId = r.turn.id;
      return;
    }
    await this.execTurn(input);
  }
  async steer(input: string): Promise<boolean> {
    if (this.mode !== "app-server" || !this.turnId) return false;
    try { await this.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: "text", text: input }] }); return true; }
    catch { return false; }
  }
  async deliverViaHook(): Promise<void> { /* not used on Codex */ }
  async answerPrompt(id: string, decision: "allow" | "deny"): Promise<void> {
    const r = this.serverRequests.get(id); if (!r) return; this.serverRequests.delete(id);
    let result: unknown;
    if (r.method === "item/permissions/requestApproval") result = decision === "allow" ? { permissions: r.params.permissions ?? {}, scope: "turn" } : { permissions: {} };
    else result = { decision: decision === "allow" ? "accept" : "decline" };
    this.write({ id: r.id, result });
  }
  async interrupt(): Promise<void> {
    if (this.mode === "app-server" && this.turnId) { try { await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }); } catch { /* ignore */ } }
    else if (this.execChild) { this.execChild.kill("SIGTERM"); }
  }
  async close(): Promise<void> {
    const c = this.child; if (c) { this.child = null; c.stdin?.end(); await Promise.race([new Promise((r) => c.on("exit", r)), new Promise((r) => setTimeout(r, 3000))]); if (c.exitCode === null) c.kill("SIGKILL"); }
  }

  // ---------------- exec fallback ----------------
  private execChild: ChildProcess | null = null;
  private async execTurn(input: string): Promise<void> {
    const out = join(this.opts.scratch(), "last-message.txt");
    const cfg: string[] = [];
    for (const [k, v] of Object.entries(this.withEffort(this.opts.config))) cfg.push("-c", `${k}=${toToml(v)}`);
    const args = this.threadId ? ["exec", "resume", this.threadId, ...cfg, "--json", "-o", out, "-"] : ["exec", ...cfg, "--cd", this.cwd, "--json", "-o", out, "-"];
    if (this.opts.model) args.splice(1, 0, "-m", this.opts.model);
    const child = spawn(this.opts.bin, args, { cwd: this.cwd, env: this.opts.env(), stdio: ["pipe", "pipe", "pipe"] });
    this.execChild = child;
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      this.opts.raw?.(line);
      let ev: Msg; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "thread.started" && ev.thread_id) this.threadId = ev.thread_id;
      else if (ev.type === "item.completed") { const it = ev.item ?? {}; if (it.type === "command_execution") this.emit({ type: "tool_result", text: `${it.command}: exit ${it.exit_code}`, error: it.exit_code !== 0 }); else if (it.type === "agent_message" && it.text) this.emit({ type: "text", text: it.text }); }
      else if (ev.type === "item.started" && ev.item?.type === "command_execution") this.emit({ type: "tool", name: "shell", input: { command: ev.item.command } });
      else if (ev.type === "turn.completed") this.emit({ type: "status", status: { contextTokens: ev.usage?.input_tokens ?? null } });
    });
    child.stdin!.end(this.brief ? `${this.brief}\n\n---\n\n${input}` : input);   // exec has no place for the brief but the prompt
    child.on("exit", (code) => {
      this.execChild = null;
      const text = existsSync(out) ? readFileSync(out, "utf8") : "";
      if (code !== 0) this.emit({ type: "error", message: `codex exec exited ${code}: ${stderr.trim().slice(-300)}` });
      this.emit({ type: "final", text, cost: { exit: code } });
    });
  }
}

/** A JSON value as a TOML value for `-c key=value`. */
export function toToml(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(toToml).join(", ") + "]";
  if (v && typeof v === "object") return "{ " + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toToml(x)}`).join(", ") + " }";
  return "\"\"";
}

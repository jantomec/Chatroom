// Claude through `claude -p` with stream-json in and out (ARCHITECTURE.md §9.2).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Capabilities, Driver, DriverEvent, SessionSpec } from "../types.ts";

export interface ClaudeOptions {
  bin: string;
  settings: unknown;                                  // the inline --settings object of §12.1
  model: string | null; effort: string | null;
  env: () => NodeJS.ProcessEnv;                       // the agent's environment (§8.1)
  writeDelivery: (text: string) => string;            // returns the delivery file name
  raw?: ((line: string) => void) | undefined;         // raw stream, for --raw
}

/** Where Claude Code keeps a session's transcript: ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl */
export function sessionFile(cwd: string, id: string): string {
  return join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects", cwd.replace(/[/.]/g, "-"), `${id}.jsonl`);
}

export class ClaudeDriver implements Driver {
  readonly agent = "claude" as const;
  readonly capabilities: Capabilities = { nativeSteering: false, hookDelivery: true, interrupt: true, hostPrompts: true, nativeCommit: true };
  private opts: ClaudeOptions;
  private handler: ((e: DriverEvent) => void) | null = null;
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  private cwd = ""; private brief = "";
  private model: string | null = null;
  private turn: string | null = null;
  private pendingFiles = new Map<string, number[]>();
  private resumeFailed = false;
  constructor(opts: ClaudeOptions) { this.opts = opts; }

  onEvent(h: (e: DriverEvent) => void): void { this.handler = h; }
  private emit(e: DriverEvent): void { this.handler?.(e); }

  async connect(session: SessionSpec): Promise<{ sessionId: string; resumed: boolean }> {
    this.cwd = session.cwd; this.brief = session.brief;
    const resumable = session.id !== null && !this.resumeFailed && existsSync(sessionFile(session.cwd, session.id));
    this.sessionId = resumable ? session.id! : randomUUID();
    await this.spawn(resumable);
    return { sessionId: this.sessionId, resumed: resumable };
  }

  private args(resume: boolean): string[] {
    const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events",
      "--append-system-prompt", this.brief, "--settings", JSON.stringify(this.opts.settings),
      "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
      resume ? "--resume" : "--session-id", this.sessionId!];
    if (this.opts.model) a.push("--model", this.opts.model);
    if (this.opts.effort) a.push("--effort", this.opts.effort);
    return a;
  }

  private async spawn(resume: boolean): Promise<void> {
    const child = spawn(this.opts.bin, this.args(resume), { cwd: this.cwd, env: this.opts.env(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const reap = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    process.once("exit", reap); child.once("exit", () => process.off("exit", reap));
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (resume && code !== 0 && !this.sawInit) this.resumeFailed = true;
      this.emit({ type: "exit", code, signal: signal as string | null });
      if (stderr.trim()) this.emit({ type: "error", message: stderr.trim().split("\n").slice(-3).join(" | ") });
    });
    await new Promise((r) => setTimeout(r, 50));
    if (child.exitCode !== null) throw new Error(`claude exited at start (${child.exitCode}): ${stderr.trim()}`);
  }

  private sawInit = false;
  private write(obj: unknown): void {
    if (!this.child?.stdin?.writable) throw new Error("claude process is not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async startTurn(turnId: string, input: string): Promise<void> {
    this.turn = turnId;
    if (!this.child) await this.spawn(this.sessionId !== null && !this.resumeFailed && existsSync(sessionFile(this.cwd, this.sessionId)));
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: input }] } });
  }
  async steer(): Promise<boolean> { return false; }
  async deliverViaHook(_turn: string, input: string, ids: number[]): Promise<void> {
    const name = this.opts.writeDelivery(input);
    this.pendingFiles.set(name, ids);
  }
  /** Message ids behind the delivery files an acknowledgement names. */
  ackFiles(names: string[]): number[] {
    const ids: number[] = [];
    for (const n of names) { const v = this.pendingFiles.get(n); if (v) { ids.push(...v); this.pendingFiles.delete(n); } }
    return ids;
  }
  async answerPrompt(id: string, decision: "allow" | "deny", reason?: string): Promise<void> {
    const req = this.prompts.get(id); this.prompts.delete(id);
    const response = decision === "allow" ? { behavior: "allow", updatedInput: req?.input ?? {} } : { behavior: "deny", message: reason ?? "denied by the user" };
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }
  async interrupt(): Promise<void> {
    const c = this.child; if (!c) return;
    c.kill("SIGINT");
    setTimeout(() => { if (this.child === c) c.kill("SIGTERM"); }, 5000);
    setTimeout(() => { if (this.child === c) c.kill("SIGKILL"); }, 10000);
  }
  async close(): Promise<void> {
    const c = this.child; if (!c) return;
    this.child = null;
    c.stdin?.end();
    await Promise.race([new Promise((r) => c.on("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
    if (c.exitCode === null) c.kill("SIGKILL");
  }

  private prompts = new Map<string, { input: unknown }>();
  private onLine(line: string): void {
    this.opts.raw?.(line);
    let ev: any; try { ev = JSON.parse(line); } catch { return; }
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") { this.sawInit = true; this.model = ev.model ?? null; this.emit({ type: "status", status: { model: ev.model ?? null, cwd: ev.cwd ?? null } }); }
        else if (ev.subtype === "permission_denied") this.emit({ type: "tool_result", text: `denied: ${ev.message ?? ""}`, error: true });
        else if (ev.subtype === "hook_response" && ev.outcome === "error") this.emit({ type: "error", message: `hook ${ev.hook_name}: ${String(ev.output ?? "").slice(0, 200)}` });
        break;
      case "assistant": {
        const msg = ev.message ?? {};
        for (const b of msg.content ?? []) {
          if (b.type === "text" && b.text) this.emit({ type: "text", text: b.text });
          else if (b.type === "tool_use") this.emit({ type: "tool", name: b.name, input: b.input });
          else if (b.type === "thinking" && b.thinking) this.emit({ type: "reasoning", text: b.thinking });
        }
        const u = msg.usage;
        if (u) this.emit({ type: "status", status: { contextTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) } });
        if (msg.model && msg.model !== this.model) { this.model = msg.model; this.emit({ type: "status", status: { model: msg.model } }); }
        break;
      }
      case "user": {
        for (const b of ev.message?.content ?? []) if (b.type === "tool_result") this.emit({ type: "tool_result", text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), error: b.is_error === true });
        break;
      }
      case "control_request": {
        const r = ev.request ?? {};
        if (r.subtype === "can_use_tool") {
          this.prompts.set(ev.request_id, { input: r.input });
          const detail = r.input?.command ?? r.input?.file_path ?? r.description ?? "";
          this.emit({ type: "prompt", id: ev.request_id, summary: `${r.tool_name}: ${String(detail).slice(0, 160)}`, request: r });
        }
        break;
      }
      case "result": {
        const win = this.model && ev.modelUsage?.[this.model]?.contextWindow;
        if (typeof win === "number") this.emit({ type: "status", status: { contextWindow: win } });
        if (ev.is_error && typeof ev.result === "string" && ev.subtype !== "success") this.emit({ type: "error", message: ev.result.slice(0, 300) });
        this.emit({ type: "final", text: typeof ev.result === "string" ? ev.result : "", cost: { usd: ev.total_cost_usd, duration_ms: ev.duration_ms, usage: ev.usage } });
        break;
      }
      default: break;
    }
  }
}

// Minimal client for `claude -p --input-format stream-json --output-format stream-json`.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type ClaudeEvent = Record<string, any>;

export interface ClaudeOptions {
  bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string;
  onControlRequest?: (req: ClaudeEvent) => Promise<unknown> | unknown;
}

export class ClaudeProcess {
  readonly child: ChildProcess;
  readonly events: ClaudeEvent[] = [];
  stderr = "";
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private listeners: ((e: ClaudeEvent) => void)[] = [];

  readonly opts: ClaudeOptions;
  constructor(opts: ClaudeOptions) {
    this.opts = opts;
    writeFileSync(opts.logFile, "");
    this.child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      appendFileSync(opts.logFile, line + "\n");
      let ev: ClaudeEvent;
      try { ev = JSON.parse(line); } catch { ev = { type: "_unparsed", line }; }
      this.events.push(ev);
      for (const l of this.listeners) l(ev);
      if (ev["type"] === "control_request" && opts.onControlRequest) {
        Promise.resolve(opts.onControlRequest(ev)).then((response) => {
          this.write({ type: "control_response", response: { subtype: "success", request_id: ev["request_id"], response } });
        });
      }
    });
    this.child.stderr!.on("data", (d: Buffer) => { this.stderr += d.toString(); appendFileSync(opts.logFile + ".stderr", d); });
    this.exited = new Promise((res) => this.child.on("exit", (code, signal) => {
      const ev = { type: "_exit", code, signal };
      this.events.push(ev);
      for (const l of this.listeners) l(ev);
      res({ code, signal: signal as string | null });
    }));
  }

  write(obj: unknown): void {
    const line = JSON.stringify(obj);
    appendFileSync(this.opts.logFile + ".stdin", line + "\n");
    this.child.stdin!.write(line + "\n");
  }
  sendUser(text: string): void {
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  }
  mark(): number { return this.events.length; }

  waitFor(pred: (e: ClaudeEvent) => boolean, from: number, timeoutMs: number, what = "event"): Promise<ClaudeEvent> {
    for (let i = from; i < this.events.length; i++) { const e = this.events[i]!; if (pred(e)) return Promise.resolve(e); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); reject(new Error(`timeout waiting for ${what}`)); }, timeoutMs);
      const l = (e: ClaudeEvent) => {
        if (e["type"] === "_exit") { clearTimeout(timer); this.listeners = this.listeners.filter((x) => x !== l); reject(new Error(`process exited while waiting for ${what}: code=${e["code"]} signal=${e["signal"]}\n${this.stderr.slice(-2000)}`)); return; }
        if (pred(e)) { clearTimeout(timer); this.listeners = this.listeners.filter((x) => x !== l); resolve(e); }
      };
      this.listeners.push(l);
    });
  }
  waitForResult(from: number, timeoutMs = 300_000): Promise<ClaudeEvent> {
    return this.waitFor((e) => e["type"] === "result", from, timeoutMs, "result");
  }
  endInput(): void { this.child.stdin!.end(); }
  kill(signal: NodeJS.Signals = "SIGTERM"): void { this.child.kill(signal); }
}

export function resultText(r: ClaudeEvent): string { return typeof r["result"] === "string" ? r["result"] : JSON.stringify(r["result"]); }

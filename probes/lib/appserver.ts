// Minimal JSON-RPC client for `codex app-server` over stdio (newline-delimited JSON,
// jsonrpc header omitted on the wire per the app-server docs).
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type Msg = Record<string, any>;
export interface AppServerOptions {
  bin: string; args?: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string;
  onServerRequest?: (method: string, params: Msg, id: unknown) => Promise<unknown> | unknown;
}

export class AppServer {
  readonly child: ChildProcess;
  readonly messages: Msg[] = [];        // everything received, in order
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderr = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners: ((m: Msg) => void)[] = [];

  readonly opts: AppServerOptions;
  constructor(opts: AppServerOptions) {
    this.opts = opts;
    writeFileSync(opts.logFile, "");
    this.child = spawn(opts.bin, opts.args ?? ["app-server"], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      appendFileSync(opts.logFile, "<- " + line + "\n");
      let m: Msg;
      try { m = JSON.parse(line); } catch { m = { _unparsed: line }; }
      this.messages.push(m);
      for (const l of this.listeners) l(m);
      if (m["method"] !== undefined && m["id"] !== undefined) {
        // server-initiated request
        const handler = opts.onServerRequest;
        Promise.resolve(handler ? handler(m["method"], m["params"] ?? {}, m["id"]) : undefined).then(
          (result) => this.writeRaw({ id: m["id"], result: result ?? {} }),
          (err) => this.writeRaw({ id: m["id"], error: { code: -32000, message: String(err) } }),
        );
      } else if (m["id"] !== undefined && typeof m["id"] === "number" && this.pending.has(m["id"])) {
        const p = this.pending.get(m["id"])!; this.pending.delete(m["id"]);
        if (m["error"]) p.reject(new Error(`${p.method}: ${JSON.stringify(m["error"])}`)); else p.resolve(m["result"]);
      }
    });
    this.child.stderr!.on("data", (d: Buffer) => { this.stderr += d.toString(); appendFileSync(opts.logFile + ".stderr", d); });
    this.exited = new Promise((res) => this.child.on("exit", (code, signal) => {
      const m = { _exit: true, code, signal }; this.messages.push(m); for (const l of this.listeners) l(m);
      for (const [, p] of this.pending) p.reject(new Error(`app-server exited: ${code} ${signal}`));
      res({ code, signal: signal as string | null });
    }));
  }
  private writeRaw(obj: unknown): void {
    const line = JSON.stringify(obj);
    appendFileSync(this.opts.logFile, "-> " + line + "\n");
    this.child.stdin!.write(line + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.writeRaw({ id, method, params }); });
  }
  notify(method: string, params: unknown = {}): void { this.writeRaw({ method, params }); }
  mark(): number { return this.messages.length; }
  notifications(from = 0): Msg[] { return this.messages.slice(from).filter((m) => m["method"] !== undefined && m["id"] === undefined); }
  waitFor(pred: (m: Msg) => boolean, from: number, timeoutMs: number, what = "message"): Promise<Msg> {
    for (let i = from; i < this.messages.length; i++) { const m = this.messages[i]!; if (pred(m)) return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); reject(new Error(`timeout waiting for ${what}`)); }, timeoutMs);
      const l = (m: Msg) => {
        if (m["_exit"]) { clearTimeout(timer); this.listeners = this.listeners.filter((x) => x !== l); reject(new Error(`app-server exited while waiting for ${what}\n${this.stderr.slice(-2000)}`)); return; }
        if (pred(m)) { clearTimeout(timer); this.listeners = this.listeners.filter((x) => x !== l); resolve(m); }
      };
      this.listeners.push(l);
    });
  }
  waitForTurnEnd(turnId: string, from: number, timeoutMs = 300_000): Promise<Msg> {
    return this.waitFor((m) => m["method"] === "turn/completed" && m["params"]?.turn?.id === turnId, from, timeoutMs, `turn/completed ${turnId}`);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void { this.child.kill(signal); }
  async close(): Promise<void> { this.child.stdin!.end(); await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]); if (this.child.exitCode === null) this.child.kill("SIGKILL"); }
}

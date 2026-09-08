// The conversation log: one JSON object per line, appended and synced before it is used.
// The whole room state is a fold over it (ARCHITECTURE.md §5).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

export type Participant = "user" | "claude" | "codex" | "chatroom";
export type Agent = "claude" | "codex";

export interface Base { id: number; at: string; kind: string }
export interface MessageRecord extends Base {
  kind: "message"; from: Participant; to: Participant[]; body: string;
  via?: "repl" | "post" | "reply" | "final" | "summary"; turn?: string; op?: string; reply_to?: number;   // summary: the chatroom's own lines, or an agent's wrap-up for the user
  credit?: boolean;            // true when this message used one autonomy credit
  held?: boolean;              // true when its agent delivery was held for lack of credit
}
export interface TurnRecord extends Base {
  kind: "turn"; agent: Agent; turn: string;
  event: "started" | "delivered" | "acked" | "ended" | "failed" | "interrupted" | "released";
  inputs?: number[]; reason?: string; final?: number; cost?: unknown;
}
export interface MarkerRecord extends Base { kind: "marker"; message: number; marker: string; task: number; effect: string; from: Participant }
export interface SessionRecord extends Base { kind: "session"; agent: Agent; event: "started" | "resumed" | "rebuilt" | "closed"; session?: string; note?: string }
export interface GitRecord extends Base { kind: "git"; op: "snapshot" | "integrate" | "sync" | "apply" | "apply_abort" | "sync_abort"; agent?: string; event: "started" | "done" | "skipped" | "refused" | "failed" | "open"; [k: string]: unknown }
export interface RefRecord extends Base { kind: "ref"; refs: Record<string, string | null>; heads?: Record<string, string>; deviation?: string }
export interface PermissionRecord extends Base { kind: "permission"; agent: Agent; prompt: string; event: "asked" | "answered"; decision?: "allow" | "deny"; reason?: string; summary?: string; request?: unknown }
export interface BudgetRecord extends Base { kind: "budget"; event: "reset" | "limit" | "released"; limit?: number; messages?: number[] }
export interface StatusRecord extends Base { kind: "status"; agent: Agent; model?: string | null; effort?: string | null; cwd?: string | null; contextTokens?: number | null; contextWindow?: number | null }
export interface NoteRecord extends Base { kind: "note"; text: string; [k: string]: unknown }
/** The user pressed Esc: turns were interrupted; user messages no agent had read are withdrawn, other unread messages held until the user's next message. */
export interface InterruptRecord extends Base { kind: "interrupt"; retracted: { message: number; from: Agent[] }[]; held: { message: number; for: Agent[] }[] }
export type LogRecord = MessageRecord | TurnRecord | MarkerRecord | SessionRecord | GitRecord | RefRecord | PermissionRecord | BudgetRecord | StatusRecord | NoteRecord | InterruptRecord;
export type NewRecord = { [K in LogRecord["kind"]]: Omit<Extract<LogRecord, { kind: K }>, "id" | "at"> }[LogRecord["kind"]];

/** A record's time as the local clock shows it, HH:MM. */
export function clock(at: string): string { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; }

export class Log {
  readonly path: string;
  readonly records: LogRecord[] = [];
  readonly skipped: number[] = [];      // 1-based line numbers that did not parse at startup
  private fd: number;
  private nextId = 1;

  constructor(path: string) {
    this.path = path;
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const [i, line] of lines.entries()) {
      try {
        const r = JSON.parse(line) as LogRecord;
        if (typeof r.id !== "number" || typeof r.kind !== "string") throw new Error("shape");
        this.records.push(r);
        this.nextId = Math.max(this.nextId, r.id + 1);
      } catch { this.skipped.push(i + 1); }
    }
    this.fd = openSync(path, "a");
    if (text.length > 0 && !text.endsWith("\n")) { writeSync(this.fd, "\n"); fsyncSync(this.fd); }
    if (this.skipped.length > 0) this.append({ kind: "note", text: `startup skipped ${this.skipped.length} unparsable line(s)`, lines: this.skipped });
  }

  /** Append one record, synced to disk before it is returned. */
  append<R extends NewRecord>(record: R): Extract<LogRecord, { kind: R["kind"] }> {
    const full = { id: this.nextId++, at: new Date().toISOString(), ...record } as unknown as Extract<LogRecord, { kind: R["kind"] }>;
    writeSync(this.fd, JSON.stringify(full) + "\n");
    fsyncSync(this.fd);
    this.records.push(full);
    return full;
  }

  close(): void { closeSync(this.fd); }
  get lastId(): number { return this.nextId - 1; }
}

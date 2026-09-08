// The terminal interface (ARCHITECTURE.md §14): the transcript flows down from where the
// cursor was, a bordered input box and the status lines sit right under it, and once the
// screen is full the box stays at the bottom while the transcript scrolls above it, the
// way Claude Code's screen behaves. Raw keystrokes, a scroll region, no library.
import { appendFileSync } from "node:fs";
import type { Agent } from "./log.ts";
import { AGENTS, type Room } from "./room.ts";
import { shortPath } from "./git.ts";

export interface BarInfo { branch: Record<Agent, string>; directory: Record<Agent, string>; mainBranch: string; mainPath: string; integrationAhead: number; conversation: string }

export interface SelectOption { label: string; value: string; note?: string | undefined }

export interface ReplOptions {
  room: Room;
  names: { claude: string; codex: string };
  statusBar: boolean;
  bar: () => BarInfo;
  command: (line: string) => Promise<boolean | string>;   // slash commands; true handled, false unknown, string = reply
  onQuit: () => Promise<void>;
  interrupt?: () => Promise<string | null>;               // Esc; resolves to a withdrawn message body to put back into the box
  input?: NodeJS.ReadStream; output?: NodeJS.WriteStream;
  traceFile?: string;                                     // screen trace, one line per operation; CHATROOM_TUI_TRACE overrides
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`, DIM = `${ESC}2m`, BOLD = `${ESC}1m`;
const FG: Record<string, string> = { claude: `${ESC}38;5;209m`, codex: `${ESC}38;5;78m`, user: `${ESC}38;5;75m`, chatroom: `${ESC}38;5;141m`, green: `${ESC}32m`, yellow: `${ESC}33m`, red: `${ESC}31m`, cyan: `${ESC}36m` };
const BADGE: Record<string, string> = { claude: `${ESC}48;5;209m${ESC}30m`, codex: `${ESC}48;5;78m${ESC}30m`, user: `${ESC}48;5;75m${ESC}30m`, chatroom: `${ESC}48;5;141m${ESC}30m` };
const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
/** The first `n` visible characters of a styled string, its color codes kept. */
function cutVisible(s: string, n: number): string {
  let out = "", seen = 0, i = 0;
  while (i < s.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    if (seen >= n) break;
    out += s[i]; seen++; i++;
  }
  return out;
}

/** A path with $HOME as ~ and its middle components elided first when it is long. */
export function elidePath(p: string, max = 34): string {
  const s = shortPath(p); if (s.length <= max) return s;
  const parts = s.split("/"); if (parts.length <= 3) return s;
  const head = parts[0] === "~" ? "~" : "";
  let tail = parts.slice(-2).join("/");
  for (let i = 3; i <= parts.length - 1 && (head + "/…/" + parts.slice(-i).join("/")).length <= max; i++) tail = parts.slice(-i).join("/");
  return `${head}/…/${tail}`;
}
/** Ten blocks, colored by use, like the user's own Claude Code status line. */
export function contextBar(tokens: number | null, window: number | null): string {
  if (tokens === null) return `${DIM}░░░░░░░░░░ n/a${RESET}`;
  if (!window) return `${DIM}░░░░░░░░░░${RESET} ${tokens} tok`;
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  const filled = Math.round(pct / 10);
  const color = pct >= 90 ? FG["red"] : pct >= 70 ? FG["yellow"] : FG["green"];
  return `${color}${"█".repeat(filled)}${"░".repeat(10 - filled)}${RESET} ${pct}%`;
}

export class Repl {
  private opts: ReplOptions;
  private out: NodeJS.WriteStream;
  private inp: NodeJS.ReadStream;
  private tty: boolean;
  private rows = 24; private cols = 80;
  private text = ""; private cursor = 0;
  private history: string[] = []; private histIdx = -1; private histDraft = "";
  private show: "quiet" | "activity" | "full" = "activity";
  private closed = false;
  private started = false;
  private contentRow = 1;               // the row the next transcript line goes to (1-based)
  private cursorReply: ((row: number) => void) | null = null;
  private lastCtrlC = 0;
  private lastFooterHeight = 0;
  private dead = false;                 // the terminal went away: write nothing more
  private transcript: string[] = [];    // every transcript line printed, styled but not wrapped: the source for a redraw
  private ownsScreen = false;           // true once nothing but the chatroom is on screen (the region has scrolled, or the screen was redrawn)
  private resizing: NodeJS.Timeout | null = null;   // set while resize events are still arriving
  private banner: string | null = null;             // one line under the status lines, e.g. an available update
  private selector: { question: string; options: SelectOption[]; index: number; resolve: (v: string | null) => void } | null = null;   // a list drawn in place of the input
  private textPrompt: { question: string; resolve: (v: string | null) => void } | null = null;                                          // a one-line question answered in the input
  /** Append one line per screen operation to the trace file: the geometry and what caused it. */
  private trace(kind: string, extra = ""): void {
    const f = process.env["CHATROOM_TUI_TRACE"] ?? this.opts.traceFile; if (!f) return;
    try { appendFileSync(f, `${new Date().toISOString().slice(11, 23)} ${kind} contentRow=${this.contentRow} rows=${this.rows} cols=${this.cols} out=${this.out.rows}x${this.out.columns} h=${this.footerHeight()} text=${this.text.length} cursor=${this.cursor} owns=${this.ownsScreen} resizing=${this.resizing !== null} closed=${this.closed} ${extra}\n`); } catch { /* tracing never fails the session */ }
  }
  /** Every write to the terminal goes through here; a failure (EIO, EPIPE) ends the session quietly. */
  private write(s: string): void {
    if (this.dead) return;
    try { this.out.write(s); } catch { this.dead = true; void this.quit(); }
  }
  private onData = (chunk: Buffer) => this.feed(chunk);
  private resize = () => this.onResize();
  private pending = Buffer.alloc(0);
  private pasting: string | null = null;

  constructor(opts: ReplOptions) {
    this.opts = opts;
    this.out = opts.output ?? process.stdout;
    this.inp = opts.input ?? process.stdin;
    this.tty = Boolean(this.out.isTTY && this.inp.isTTY);
    if (this.tty) { this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80; }
  }
  setShow(level: "quiet" | "activity" | "full"): void { this.show = level; }
  get interactive(): boolean { return this.tty; }
  /** A list to pick from, drawn in place of the input box: up/down or j/k move, Enter picks, a digit picks directly, Esc cancels. */
  select(question: string, options: SelectOption[], initial = 0): Promise<string | null> {
    if (!this.tty || options.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => { this.selector = { question, options, index: Math.max(0, Math.min(initial, options.length - 1)), resolve }; this.drawFooter(); });
  }
  /** One line of free text asked in the input box: Enter answers, Esc cancels. */
  prompt(question: string): Promise<string | null> {
    if (!this.tty) return Promise.resolve(null);
    return new Promise((resolve) => { this.textPrompt = { question, resolve }; this.text = ""; this.cursor = 0; this.drawFooter(); });
  }
  private endSelector(v: string | null): void { const s = this.selector; this.selector = null; this.drawFooter(); s?.resolve(v); }
  private endPrompt(v: string | null): void { const p = this.textPrompt; this.textPrompt = null; this.text = ""; this.cursor = 0; this.drawFooter(); p?.resolve(v); }
  /** Show a line under the status lines; without a terminal it is printed once. */
  setBanner(text: string): void {
    if (this.closed) return;
    if (!this.tty) { this.write(text + "\n"); return; }
    this.banner = text; this.trace("banner"); this.drawFooter();
  }
  private badge(who: string): string { const key = who === this.opts.names.claude ? "claude" : who === this.opts.names.codex ? "codex" : who; return `${BADGE[key] ?? BADGE["chatroom"]} ${who} ${RESET}`; }

  // ---------------- transcript ----------------

  /** Print a block of text into the transcript; activity lines follow the display level. */
  print(block: string): void {
    const lines = block.replace(/\n$/, "").split("\n");
    const isActivity = /^\s+·/.test(lines[0] ?? "");
    if (isActivity && this.show === "quiet") return;
    if (isActivity && this.show === "activity" && /thinks:/.test(lines[0] ?? "")) return;
    if (!this.tty) { this.write(lines.join("\n") + "\n"); return; }
    const kept = lines.map((l) => this.style(l));
    this.transcript.push(...kept);
    if (this.transcript.length > 4000) this.transcript.splice(0, this.transcript.length - 4000);
    if (this.resizing) return;                                   // the redraw after the resize prints it
    const styled = kept.flatMap((l) => this.wrap(l, this.cols));
    if (!this.started) { this.write(styled.join("\n") + "\n"); return; }
    const maxRow = this.rows - this.footerHeight();
    this.trace("print", `lines=${styled.length} first=${JSON.stringify(lines[0]?.slice(0, 40))}`);
    let s = `${ESC}?25l`;
    for (const l of styled) {
      if (this.contentRow > maxRow) { s += `${ESC}${maxRow};1H\n${ESC}2K` + l; this.ownsScreen = true; }   // the region scrolls
      else { s += `${ESC}${this.contentRow};1H${ESC}2K` + l; this.contentRow++; }
    }
    this.write(s);
    this.drawFooter();
  }
  private style(line: string): string {
    const names = this.opts.names;
    let m = /^#(\d+) (\S+) → (.*?)  (\d\d:\d\d)  (\w*)(.*)$/.exec(line);
    if (m) {
      const who = m[2]!; const agent = who === names.claude ? "claude" : who === names.codex ? "codex" : who;
      return `${this.badge(who)}${DIM} → ${m[3]}  #${m[1]} ${m[4]}${m[6] ? " " + m[6].trim() : ""}${RESET}`.replace(/^/, agent === "user" ? "" : "");
    }
    m = /^\s+· (\S+?): (.*)$/.exec(line);
    if (m && (m[1] === names.claude || m[1] === names.codex)) return `${DIM}  ⎿ ${FG[m[1] === names.claude ? "claude" : "codex"]}${m[1]}${RESET}${DIM} ${m[2]}${RESET}`;
    if (/^\s+·/.test(line)) return `${DIM}  ⎿ ${line.replace(/^\s+· /, "")}${RESET}`;
    if (/^!/.test(line)) return `${FG["chatroom"]}${line}${RESET}`;
    if (/^(error|warning):/.test(line)) return `${FG["red"]}${line}${RESET}`;
    return line;
  }
  /** Wrap a styled line at word boundaries into rows of at most `width` visible characters;
   *  continuation rows keep the line's indentation, and colors carry across rows. */
  private wrap(line: string, width: number): string[] {
    const items: { ansi: string; ch: string }[] = []; let pending = ""; let i = 0;
    while (i < line.length) {
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) { pending += m[0]; i += m[0].length; continue; }
      items.push({ ansi: pending, ch: line[i]! }); pending = ""; i++;
    }
    const plain = items.map((x) => x.ch).join("");
    if (plain.length <= width) return [line];
    const lead = /^\s*/.exec(plain)![0].length + (/^\s*⎿/.test(plain) ? 2 : 0);
    const indent = " ".repeat(Math.min(lead, Math.max(0, width - 20)));
    const rows: string[] = []; let start = 0;
    const render = (a: number, b: number, first: boolean) => (first ? "" : indent + items.slice(0, a).map((x) => x.ansi).join("")) + items.slice(a, b).map((x) => x.ansi + x.ch).join("") + RESET;
    while (start < plain.length) {
      const first = rows.length === 0;
      const avail = first ? width : width - indent.length;
      if (plain.length - start <= avail) { rows.push(render(start, plain.length, first) + pending); break; }
      const space = plain.lastIndexOf(" ", start + avail);
      if (space > start) { rows.push(render(start, space, first)); start = space + 1; }   // the space itself is dropped
      else { rows.push(render(start, start + avail, first)); start += avail; }
    }
    return rows;
  }
  /** Contiguous slices of a plain line, cut at spaces where possible. */
  private wrapPlain(text: string, width: number): string[] {
    const out: string[] = []; let i = 0;
    while (text.length - i > width) { let cut = text.lastIndexOf(" ", i + width); cut = cut <= i ? i + width : cut + 1; out.push(text.slice(i, cut)); i = cut; }
    out.push(text.slice(i));
    return out;
  }

  // ---------------- footer: input box and status lines ----------------

  private innerWidth(): number { return Math.max(10, this.cols - 6); }
  /** The input as displayed rows, each a slice of a logical line, plus where the cursor is. */
  private inputRows(): { rows: string[]; cursorRow: number; cursorCol: number } {
    const w = this.innerWidth(); const rows: string[] = []; let cursorRow = 0, cursorCol = 0; let pos = 0;
    for (const line of this.text.split("\n")) {
      const chunks = this.wrapPlain(line, w);
      for (const [ci, chunk] of chunks.entries()) {
        const start = pos; const end = pos + chunk.length;
        const last = ci === chunks.length - 1;
        if (this.cursor >= start && (this.cursor < end || (last && this.cursor === end))) { cursorRow = rows.length; cursorCol = this.cursor - start; }
        rows.push(chunk); pos = end;
      }
      pos++;   // the newline
    }
    return { rows, cursorRow, cursorCol };
  }
  private boxRows(): number { return this.selector ? Math.min(1 + this.selector.options.length, 14) : this.textPrompt ? 1 : Math.min(this.inputRows().rows.length, 8); }
  private footerHeight(): number { return this.boxRows() + 2 + (this.opts.statusBar ? 3 : 0) + (this.banner ? 1 : 0); }
  private layout(): void {
    if (!this.tty) return;
    this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80;
    const maxRow = this.rows - this.footerHeight();
    this.trace("layout", `maxRow=${maxRow}`);
    let s = `${ESC}1;${maxRow}r`;
    while (this.contentRow > maxRow + 1) { s += `${ESC}${maxRow};1H\n`; this.contentRow--; this.ownsScreen = true; }
    this.write(s);
    this.drawFooter();
  }
  /** A resize: the terminal has already reflowed what was on screen, so row positions are stale and
   *  every redraw during a drag would leave another copy of the box behind. Draw nothing until the
   *  events stop, then redraw the screen once from the kept transcript. */
  private onResize(): void {
    if (!this.started || this.closed) return;
    this.trace("resize");
    if (!this.resizing) this.write(`${ESC}?25l`);
    else clearTimeout(this.resizing);
    this.resizing = setTimeout(() => { this.resizing = null; this.redrawScreen(); }, 120);
  }
  private redrawScreen(): void {
    if (this.closed || this.dead) return;
    this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80;
    const h = this.footerHeight(); this.lastFooterHeight = h;
    const maxRow = Math.max(1, this.rows - h);
    const shown: string[] = [];
    for (let i = this.transcript.length - 1; i >= 0 && shown.length < maxRow; i--) shown.unshift(...this.wrap(this.transcript[i]!, this.cols));
    const tail = shown.slice(-maxRow);
    this.trace("redraw", `tail=${tail.length} maxRow=${maxRow}`);
    let s = `${ESC}?25l${ESC}r`;
    if (!this.ownsScreen) s += `${ESC}${this.rows};1H` + "\n".repeat(this.rows);   // what the shell printed before stays reachable in the scrollback
    s += `${ESC}2J`;
    for (const [i, l] of tail.entries()) s += `${ESC}${i + 1};1H` + l;
    s += `${ESC}1;${maxRow}r`;
    this.contentRow = tail.length + 1; this.ownsScreen = true;
    this.write(s);
    this.drawFooter();
  }
  redraw(): void { if (this.tty) this.drawFooter(); }
  private drawFooter(): void {
    if (this.closed || this.resizing) return;
    const h = this.footerHeight();
    if (h !== this.lastFooterHeight && this.lastFooterHeight !== 0) { this.lastFooterHeight = h; this.layout(); return; }
    this.lastFooterHeight = h;
    const top = Math.min(this.contentRow, this.rows - h + 1); const w = this.cols;
    this.trace("footer", `top=${top}`);
    const fit = (s: string) => { const v = visibleLength(s); return v > w ? cutVisible(s, Math.max(0, w - 1)) + "…" + RESET : s + " ".repeat(w - v); };
    let shown: string[]; let cursorRow = 0, cursorCol = 0, first = 0; let cursorLine = 0;
    const sel = this.selector;
    if (sel) {   // the question, then the options, the chosen one marked; the cursor sits on it
      first = Math.max(0, Math.min(sel.index - 11, sel.options.length - 13));
      shown = [`${BOLD}${sel.question}${RESET}`, ...sel.options.slice(first, first + 13).map((o, i) => { const on = first + i === sel.index; return `${on ? FG["cyan"] + "●" : DIM + "○"}${RESET} ${on ? BOLD : ""}${o.label}${RESET}${o.note ? `  ${DIM}${o.note}${RESET}` : ""}`; })];
      cursorLine = sel.index - first + 1; cursorCol = -2; first = 0;
    } else if (this.textPrompt) {
      shown = [`${DIM}${this.textPrompt.question}:${RESET} ${this.text}`]; cursorCol = this.textPrompt.question.length + 2 + this.cursor;
    } else {
      const r = this.inputRows(); cursorRow = r.cursorRow; cursorCol = r.cursorCol;
      first = Math.max(0, Math.min(cursorRow - 7, r.rows.length - 8));
      shown = r.rows.slice(first, first + 8); cursorLine = cursorRow - first;
    }
    let s = `${ESC}?25l${ESC}${top};1H${ESC}J`;
    s += fit(`${DIM}╭${"─".repeat(Math.max(0, w - 2))}╮${RESET}`) + "\n";
    for (const [i, l] of shown.entries()) {
      const glyph = !sel && first + i === 0 ? `${FG["user"]}❯${RESET}` : sel && i === 0 ? `${FG["user"]}❯${RESET}` : " ";
      const body = `${DIM}│${RESET} ${glyph} ${l}`;
      s += `${body}${" ".repeat(Math.max(0, w - 1 - visibleLength(body)))}${DIM}│${RESET}\n`;
    }
    s += fit(`${DIM}╰${"─".repeat(Math.max(0, w - 2))}╯${RESET}`);
    if (this.opts.statusBar) for (const l of this.statusLines()) s += "\n" + fit(l);
    if (this.banner) s += "\n" + fit(`${FG["yellow"]}${this.banner}${RESET}`);
    const row = top + 1 + cursorLine; const col = 5 + cursorCol;
    s += `${ESC}${row};${col}H${ESC}?25h`;
    this.write(s);
  }
  statusLines(): string[] {
    const s = this.opts.room.state; const info = this.opts.bar(); const names = this.opts.names;
    const cell = (a: Agent) => {
      const st = s.status[a];
      let state = `${DIM}○ idle   ${RESET}`;
      const prompt = [...s.prompts.entries()].find(([, p]) => p.agent === a);
      if (prompt) state = `${FG["yellow"]}◐ waiting${RESET}`;
      else if (s.turns[a]) state = `${FG["green"]}● working${RESET}`;
      else if (s.heldFor[a].size) state = `${FG["yellow"]}◌ held   ${RESET}`;
      else if (s.sessions[a].state === "rebuilt") state = `${DIM}○ rebuilt${RESET}`;
      const model = `${FG["cyan"]}[${st.model ?? "default"} · ${st.effort ?? "default"}]${RESET}`;
      return `${this.badge(names[a])} ${state} ${contextBar(st.contextTokens, st.contextWindow)}  ${model} 🌿 ${info.branch[a]} 📁 ${elidePath(info.directory[a], 30)}`;
    };
    const task = [...s.tasks.values()].filter((t) => t.state !== "accepted").at(-1);
    const budget = s.creditsUsed >= s.limit ? `${FG["red"]}budget ${s.creditsUsed}/${s.limit}${RESET}` : `budget ${s.creditsUsed}/${s.limit}`;
    return [
      cell("claude"),
      cell("codex"),
      `${BADGE["chatroom"]} ${info.conversation} ${RESET} 🌿 ${info.mainBranch} 📁 ${elidePath(info.mainPath, 30)} ${DIM}|${RESET} ${budget} ${DIM}|${RESET} integration +${info.integrationAhead}${task ? ` ${DIM}|${RESET} task #${task.id} ${task.state.replace("_", " ")}` : ""} ${DIM}| /help${RESET}`,
    ];
  }

  // ---------------- input ----------------

  async start(): Promise<void> {
    if (!this.tty) { this.startPlain(); return; }
    this.inp.setRawMode(true); this.inp.resume();
    this.inp.on("data", this.onData);
    this.inp.on("error", () => { this.dead = true; void this.quit(); });   // the terminal is gone (EIO)
    this.inp.on("end", () => { void this.quit(); });
    this.out.on("error", () => { this.dead = true; void this.quit(); });
    this.out.on("resize", this.resize);
    this.write(`${ESC}?2004h`);   // bracketed paste: a pasted block arrives as one unit
    this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80;
    const row = await new Promise<number>((resolve) => {
      const t = setTimeout(() => { this.cursorReply = null; resolve(this.rows); }, 400);
      this.cursorReply = (r) => { clearTimeout(t); this.cursorReply = null; resolve(r); };
      this.write(`${ESC}6n`);
    });
    this.contentRow = Math.max(1, Math.min(row, this.rows));
    this.started = true;
    this.trace("start", `reply=${row}`);
    this.layout();
  }
  private startPlain(): void {
    let buf = "";
    this.inp.setEncoding("utf8");
    this.inp.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); void this.submit(line); } });
    this.inp.on("end", () => { void this.waitIdleThenQuit(); });
  }
  private async waitIdleThenQuit(): Promise<void> {
    for (let i = 0; i < 1200; i++) { await this.opts.room.idle(); if (!AGENTS.some((a) => this.opts.room.state.turns[a])) break; await new Promise((r) => setTimeout(r, 500)); }
    await this.quit();
  }

  private insert(s: string): void {
    if (this.selector) {
      const n = Number(s); const len = this.selector.options.length;
      if (s.length === 1 && n >= 1 && n <= len) { const v = this.selector.options[n - 1]!.value; this.selector.index = n - 1; this.endSelector(v); }
      else if (s === "j") { this.selector.index = (this.selector.index + 1) % len; this.drawFooter(); }
      else if (s === "k") { this.selector.index = (this.selector.index + len - 1) % len; this.drawFooter(); }
      return;
    }
    if (this.textPrompt && s.includes("\n")) s = s.replace(/\n/g, " ");
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor); this.cursor += s.length;
  }
  private wordLeft(): number { let i = this.cursor; while (i > 0 && /\s/.test(this.text[i - 1]!)) i--; while (i > 0 && !/\s/.test(this.text[i - 1]!)) i--; return i; }
  private wordRight(): number { let i = this.cursor; while (i < this.text.length && /\s/.test(this.text[i]!)) i++; while (i < this.text.length && !/\s/.test(this.text[i]!)) i++; return i; }
  private lineStart(): number { const i = this.text.lastIndexOf("\n", this.cursor - 1); return i < 0 ? 0 : i + 1; }
  private lineEnd(): number { const i = this.text.indexOf("\n", this.cursor); return i < 0 ? this.text.length : i; }
  private moveLine(dir: -1 | 1): boolean {
    const lines = this.text.split("\n"); let pos = 0; let row = 0, col = 0;
    for (const [i, l] of lines.entries()) { if (this.cursor <= pos + l.length) { row = i; col = this.cursor - pos; break; } pos += l.length + 1; }
    const target = row + dir; if (target < 0 || target >= lines.length) return false;
    let start = 0; for (let i = 0; i < target; i++) start += lines[i]!.length + 1;
    this.cursor = start + Math.min(col, lines[target]!.length); return true;
  }

  /** Decode raw terminal bytes into keys; the terminal's escape sequences are parsed here, not by readline. */
  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.trace("input", JSON.stringify(chunk.toString("utf8")));
    let buf = Buffer.concat([this.pending, chunk]); this.pending = Buffer.alloc(0);
    let text = buf.toString("utf8");
    // keep an incomplete multibyte character for the next chunk
    if (text.endsWith("\uFFFD") && buf.length > 0) { for (let n = 1; n <= 3 && n < buf.length; n++) { const t = buf.subarray(0, buf.length - n).toString("utf8"); if (!t.endsWith("\uFFFD")) { this.pending = buf.subarray(buf.length - n); text = t; break; } } }
    let i = 0;
    while (i < text.length) {
      if (this.pasting !== null) { const end = text.indexOf("\x1b[201~", i); if (end < 0) { this.pasting += text.slice(i); return; } this.pasting += text.slice(i, end); this.insert(this.pasting.replace(/\r\n?/g, "\n")); this.pasting = null; i = end + 6; this.drawFooter(); continue; }
      const c = text[i]!;
      if (c === "\x1b") {
        const rest = text.slice(i);
        let m = /^\x1b\[([0-9;?]*)([A-Za-z~@])/.exec(rest);
        if (m) { i += m[0].length; this.csi(m[1]!, m[2]!); continue; }
        m = /^\x1bO([A-Za-z])/.exec(rest);
        if (m) { i += m[0].length; this.csi("", m[1]!); continue; }
        if (rest.length === 1) { this.pending = Buffer.from(rest); setTimeout(() => { if (this.pending.length === 1 && this.pending[0] === 0x1b) { this.pending = Buffer.alloc(0); this.key("escape", {}); } }, 60); return; }   // a lone escape (Esc), or a prefix cut by the chunk boundary
        const next = rest[1]!; i += 2;
        if (next === "\r" || next === "\n") this.key("return", { meta: true });
        else if (next === "\x7f" || next === "\b") this.key("backspace", { meta: true });
        else if (next === "\x1b") this.key("escape", {});
        else this.key(next.toLowerCase(), { meta: true });
        continue;
      }
      i++;
      if (c === "\r") this.key("return", {});
      else if (c === "\n") this.key("newline", {});
      else if (c === "\x7f" || c === "\b") this.key("backspace", {});
      else if (c === "\t") { /* ignore */ }
      else if (c < " ") this.key(String.fromCharCode(c.charCodeAt(0) + 96), { ctrl: true });
      else { let j = i; while (j < text.length && text[j]! >= " " && text[j] !== "\x7f") j++; this.insert(text.slice(i - 1, j)); i = j; this.drawFooter(); }
    }
  }
  private csi(params: string, final: string): void {
    const p = params.split(";").map((x) => Number(x));
    const mod = (p[1] ?? 1) - 1; const meta = Boolean(mod & 2), ctrl = Boolean(mod & 4), shift = Boolean(mod & 1);
    switch (final) {
      case "A": return this.key("up", { meta, ctrl, shift });
      case "B": return this.key("down", { meta, ctrl, shift });
      case "C": return this.key("right", { meta, ctrl, shift });
      case "D": return this.key("left", { meta, ctrl, shift });
      case "H": return this.key("home", {});
      case "F": return this.key("end", {});
      case "R": this.cursorReply?.(p[0] ?? this.rows); return;
      case "u": if (p[0] === 13) return this.key("return", { meta, ctrl, shift }); return;
      case "~": {
        const n = p[0];
        if (n === 200) { this.pasting = ""; return; }
        if (n === 1 || n === 7) return this.key("home", {});
        if (n === 4 || n === 8) return this.key("end", {});
        if (n === 3) return this.key("delete", {});
        if (n === 27 && p[2] === 13) { const m2 = (p[1] ?? 1) - 1; return this.key("return", { meta: Boolean(m2 & 2), ctrl: Boolean(m2 & 4), shift: Boolean(m2 & 1) }); }
        return;
      }
      default: return;
    }
  }
  private key(name: string, k: { meta?: boolean; ctrl?: boolean; shift?: boolean }): void {
    const meta = Boolean(k.meta), ctrl = Boolean(k.ctrl), shift = Boolean(k.shift);
    if (this.selector) {
      const s = this.selector; const n = s.options.length;
      if (name === "up" || (name === "k" && !ctrl && !meta)) s.index = (s.index + n - 1) % n;
      else if (name === "down" || (name === "j" && !ctrl && !meta)) s.index = (s.index + 1) % n;
      else if (name === "return") { this.endSelector(s.options[s.index]!.value); return; }
      else if (name === "escape" || (ctrl && name === "c")) { this.endSelector(null); return; }
      else return;
      this.drawFooter(); return;
    }
    if (this.textPrompt) {
      if (name === "return") { this.endPrompt(this.text.trim()); return; }
      if (name === "escape" || (ctrl && name === "c")) { this.endPrompt(null); return; }
      if (name === "newline" || (ctrl && name === "j")) return;
    }
    if (ctrl && name === "c") { if (this.text) { this.text = ""; this.cursor = 0; this.drawFooter(); return; } if (Date.now() - this.lastCtrlC < 3000) { void this.quit(); return; } this.lastCtrlC = Date.now(); this.print(`${DIM}press ctrl-c again to quit${RESET}`); return; }
    if (ctrl && name === "d") { if (!this.text) void this.quit(); return; }
    if (name === "escape") { void this.opts.interrupt?.().then((body) => { if (body !== null && !this.text) { this.text = body; this.cursor = body.length; } this.drawFooter(); }); return; }
    if (name === "newline" || (ctrl && name === "j") || (name === "return" && (meta || shift))) { this.insert("\n"); this.drawFooter(); return; }
    if (name === "return") {
      if (this.text.endsWith("\\")) { this.text = this.text.slice(0, -1); this.cursor = Math.min(this.cursor, this.text.length); this.insert("\n"); this.drawFooter(); return; }
      const t = this.text; this.text = ""; this.cursor = 0; this.histIdx = -1;
      this.drawFooter();
      if (t.trim()) { this.history.push(t); void this.submit(t); }
      return;
    }
    if (name === "backspace") { if (meta || ctrl) { const i = this.wordLeft(); this.text = this.text.slice(0, i) + this.text.slice(this.cursor); this.cursor = i; } else if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } }
    else if (name === "delete") { this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1); }
    else if (name === "left") { this.cursor = meta || ctrl ? this.wordLeft() : Math.max(0, this.cursor - 1); }
    else if (name === "right") { this.cursor = meta || ctrl ? this.wordRight() : Math.min(this.text.length, this.cursor + 1); }
    else if (meta && name === "b") this.cursor = this.wordLeft();
    else if (meta && name === "f") this.cursor = this.wordRight();
    else if (name === "home" || (ctrl && name === "a")) this.cursor = this.lineStart();
    else if (name === "end" || (ctrl && name === "e")) this.cursor = this.lineEnd();
    else if (ctrl && name === "u") { const s0 = this.lineStart(); this.text = this.text.slice(0, s0) + this.text.slice(this.cursor); this.cursor = s0; }
    else if (ctrl && name === "k") { this.text = this.text.slice(0, this.cursor) + this.text.slice(this.lineEnd()); }
    else if (ctrl && name === "w") { const i = this.wordLeft(); this.text = this.text.slice(0, i) + this.text.slice(this.cursor); this.cursor = i; }
    else if (name === "up") { if (!this.moveLine(-1) && this.history.length) { if (this.histIdx === -1) { this.histDraft = this.text; this.histIdx = this.history.length; } if (this.histIdx > 0) this.histIdx--; this.text = this.history[this.histIdx] ?? ""; this.cursor = this.text.length; } }
    else if (name === "down") { if (!this.moveLine(1) && this.histIdx >= 0) { this.histIdx++; if (this.histIdx >= this.history.length) { this.histIdx = -1; this.text = this.histDraft; } else this.text = this.history[this.histIdx] ?? ""; this.cursor = this.text.length; } }
    else return;
    this.drawFooter();
  }
  private async submit(text: string): Promise<void> {
    if (this.closed) return;
    if (text.startsWith("/")) {
      this.print(this.tty ? `${FG["user"]}❯${RESET} ${text}` : `❯ ${text}`);
      try { const r = await this.opts.command(text); if (r === false) this.print(`unknown command ${text.split(" ")[0]}; /help lists them`); else if (typeof r === "string") this.print(r); }
      catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
      return;
    }
    try { await this.opts.room.postUser(text); } catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
  }
  /** Quit without writing to the terminal, for a hang-up or a dead descriptor. */
  hangup(): void { this.dead = true; void this.quit(); }
  async quit(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => process.exit(1), 8000).unref();   // whatever close() does, the process ends
    if (this.tty) {
      this.inp.off("data", this.onData); this.out.off("resize", this.resize);
      if (this.resizing) { clearTimeout(this.resizing); this.resizing = null; }
      try { this.inp.setRawMode(false); } catch { /* not a tty */ }
      try { this.inp.pause(); } catch { /* gone */ }
      if (!this.dead) this.write(`${ESC}?2004l${ESC}r${ESC}${this.rows};1H${ESC}?25h\n`);
    }
    await this.opts.onQuit();
  }
  close(): void { void this.quit(); }
}
export { AGENTS };

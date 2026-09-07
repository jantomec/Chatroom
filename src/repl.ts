// The terminal interface (ARCHITECTURE.md §14): the transcript scrolls in the upper part
// of the screen, a bordered input box and the status lines stay at the bottom, the way
// Claude Code's own screen is laid out. Raw keystrokes, a scroll region, no library.
import { emitKeypressEvents } from "node:readline";
import type { Agent } from "./log.ts";
import { AGENTS, type Room } from "./room.ts";
import { shortPath } from "./git.ts";

export interface BarInfo { branch: Record<Agent, string>; directory: Record<Agent, string>; mainBranch: string; mainPath: string; integrationAhead: number; conversation: string }

export interface ReplOptions {
  room: Room;
  names: { claude: string; codex: string };
  statusBar: boolean;
  bar: () => BarInfo;
  command: (line: string) => Promise<boolean | string>;   // slash commands; true handled, false unknown, string = reply
  onQuit: () => Promise<void>;
  input?: NodeJS.ReadStream; output?: NodeJS.WriteStream;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`, DIM = `${ESC}2m`, BOLD = `${ESC}1m`;
const COLOR: Record<string, string> = { claude: `${ESC}38;5;173m`, codex: `${ESC}38;5;72m`, user: `${ESC}38;5;39m`, chatroom: `${ESC}38;5;135m` };
const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
/** A path with $HOME as ~ and its middle components elided first when it is long. */
export function elidePath(p: string, max = 34): string {
  const s = shortPath(p); if (s.length <= max) return s;
  const parts = s.split("/"); if (parts.length <= 3) return s;
  const head = parts[0] === "~" ? "~" : "";
  let tail = parts.slice(-2).join("/");
  for (let i = 3; i <= parts.length - 1 && (head + "/…/" + parts.slice(-i).join("/")).length <= max; i++) tail = parts.slice(-i).join("/");
  return `${head}/…/${tail}`;
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
  private lastCtrlC = 0;
  private keypress = (str: string | undefined, key: any) => this.onKey(str, key);
  private resize = () => this.layout();

  constructor(opts: ReplOptions) {
    this.opts = opts;
    this.out = opts.output ?? process.stdout;
    this.inp = opts.input ?? process.stdin;
    this.tty = Boolean(this.out.isTTY && this.inp.isTTY);
    if (this.tty) { this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80; }
  }
  private started = false;
  setShow(level: "quiet" | "activity" | "full"): void { this.show = level; }

  // ---------------- output ----------------

  /** Print a block of text into the transcript; activity lines follow the display level. */
  print(block: string): void {
    const lines = block.replace(/\n$/, "").split("\n");
    const isActivity = /^\s+·/.test(lines[0] ?? "");
    if (isActivity && this.show === "quiet") return;
    if (isActivity && this.show === "activity" && /thinks:/.test(lines[0] ?? "")) return;
    if (!this.tty) { this.out.write(lines.join("\n") + "\n"); return; }
    const styled = lines.map((l) => this.style(l));
    if (!this.started) { this.out.write(styled.join("\n") + "\n"); return; }
    const bottom = this.rows - this.footerHeight();
    let s = `${ESC}?25l${ESC}${bottom};1H`;
    for (const l of styled) s += "\n" + l;
    this.out.write(s);
    this.drawFooter();
  }
  private style(line: string): string {
    const names = this.opts.names;
    let m = /^#(\d+) (\S+) → (.*?)  (\d\d:\d\d)  (\w*)(.*)$/.exec(line);
    if (m) {
      const who = m[2]!; const agent = who === names.claude ? "claude" : who === names.codex ? "codex" : who;
      const color = COLOR[agent] ?? "";
      const glyph = agent === "user" ? "❯" : agent === "chatroom" ? "◆" : "⏺";
      return `${color}${BOLD}${glyph} ${who}${RESET}${DIM} → ${m[3]}  #${m[1]} ${m[4]}${m[6] ? " " + m[6].trim() : ""}${RESET}`;
    }
    m = /^\s+· (\S+?): (.*)$/.exec(line);
    if (m && (m[1] === names.claude || m[1] === names.codex)) return `${DIM}  ⎿ ${m[1]} ${m[2]}${RESET}`;
    if (/^\s+·/.test(line)) return `${DIM}  ⎿ ${line.replace(/^\s+· /, "")}${RESET}`;
    if (/^!/.test(line)) return `${COLOR["chatroom"]}${line}${RESET}`;
    if (/^(error|warning):/.test(line)) return `${ESC}38;5;203m${line}${RESET}`;
    return line;
  }

  // ---------------- footer ----------------

  private inputLines(): string[] { return this.text.split("\n"); }
  private footerHeight(): number { return Math.min(this.inputLines().length, 8) + 2 + (this.opts.statusBar ? 3 : 0); }
  private layout(): void {
    if (!this.tty) return;
    this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80;
    const bottom = this.rows - this.footerHeight();
    this.out.write(`${ESC}${1};${bottom}r${ESC}${bottom};1H`);
    this.drawFooter();
  }
  redraw(): void { if (this.tty) this.drawFooter(); }
  private drawFooter(): void {
    if (this.closed) return;
    const h = this.footerHeight(); const top = this.rows - h + 1; const w = this.cols;
    const fit = (s: string) => { const v = visibleLength(s); return v > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s + " ".repeat(w - v); };
    let s = `${ESC}?25l${ESC}${top};1H${ESC}J`;
    s += fit(`${DIM}╭${"─".repeat(Math.max(0, w - 2))}╮${RESET}`) + "\n";
    const lines = this.inputLines().slice(-8);
    for (const [i, l] of lines.entries()) s += fit(`${DIM}│${RESET} ${i === 0 ? `${COLOR["user"]}❯${RESET}` : " "} ${l}`) + "\n";
    s += fit(`${DIM}╰${"─".repeat(Math.max(0, w - 2))}╯${RESET}`);
    if (this.opts.statusBar) for (const l of this.statusLines()) s += "\n" + fit(`${DIM}${l}${RESET}`);
    // cursor into the input
    const before = this.text.slice(0, this.cursor).split("\n");
    const row = top + 1 + Math.min(before.length - 1, 7); const col = 5 + (before[before.length - 1]?.length ?? 0);
    s += `${ESC}${row};${col}H${ESC}?25h`;
    this.out.write(s);
  }
  statusLines(): string[] {
    const s = this.opts.room.state; const info = this.opts.bar(); const names = this.opts.names;
    const cell = (a: Agent) => {
      const st = s.status[a];
      let state = "○ idle";
      const prompt = [...s.prompts.entries()].find(([, p]) => p.agent === a);
      if (prompt) state = `◐ waiting ${prompt[0].slice(0, 4)}`;
      else if (s.turns[a]) state = "● working";
      else if (s.heldFor[a].size) state = "◌ held";
      else if (s.sessions[a].state === "rebuilt") state = "○ rebuilt";
      const ctx = st.contextTokens === null ? "" : st.contextWindow ? ` · ctx ${Math.round((st.contextTokens / st.contextWindow) * 100)}%` : ` · ctx ${st.contextTokens}`;
      return `${names[a].padEnd(6)} ${state.padEnd(11)} ${st.model ?? "default"} · ${st.effort ?? "default"}${ctx} · ${info.branch[a]} · ${elidePath(info.directory[a])}`;
    };
    const task = [...s.tasks.values()].filter((t) => t.state !== "accepted").at(-1);
    return [
      cell("claude"),
      cell("codex"),
      `${"main".padEnd(6)} ${info.conversation.padEnd(11)} ${info.mainBranch} · ${elidePath(info.mainPath)} · budget ${s.creditsUsed}/${s.limit} · integration +${info.integrationAhead}${task ? ` · task #${task.id} ${task.state.replace("_", " ")}` : ""} · /help`,
    ];
  }

  // ---------------- input ----------------

  start(): void {
    if (!this.tty) { this.startPlain(); return; }
    emitKeypressEvents(this.inp);
    this.inp.setRawMode(true); this.inp.resume();
    this.inp.on("keypress", this.keypress);
    this.out.on("resize", this.resize);
    this.rows = this.out.rows ?? 24; this.cols = this.out.columns ?? 80;
    // make room for the footer below whatever is on screen, then reserve it
    this.out.write("\n".repeat(this.footerHeight()));
    this.started = true;
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
  private onKey(str: string | undefined, key: any): void {
    if (this.closed) return;
    const name = key?.name as string | undefined;
    if (key?.ctrl && name === "c") { if (this.text) { this.text = ""; this.cursor = 0; this.layout(); return; } if (Date.now() - this.lastCtrlC < 3000) { void this.quit(); return; } this.lastCtrlC = Date.now(); this.print(`${DIM}press ctrl-c again to quit${RESET}`); return; }
    if (key?.ctrl && name === "d") { if (!this.text) { void this.quit(); } return; }
    if (name === "return" || name === "enter") {
      if (this.text.endsWith("\\")) { this.text = this.text.slice(0, -1) + "\n"; this.cursor = this.text.length; this.layout(); return; }
      const t = this.text; this.text = ""; this.cursor = 0; this.histIdx = -1;
      this.layout();
      if (t.trim()) { this.history.push(t); void this.submit(t); }
      return;
    }
    if (name === "backspace") { if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } }
    else if (name === "delete") { this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1); }
    else if (name === "left") { if (this.cursor > 0) this.cursor--; }
    else if (name === "right") { if (this.cursor < this.text.length) this.cursor++; }
    else if (name === "home" || (key?.ctrl && name === "a")) this.cursor = 0;
    else if (name === "end" || (key?.ctrl && name === "e")) this.cursor = this.text.length;
    else if (key?.ctrl && name === "u") { this.text = this.text.slice(this.cursor); this.cursor = 0; }
    else if (key?.ctrl && name === "k") { this.text = this.text.slice(0, this.cursor); }
    else if (key?.ctrl && name === "w") { const before = this.text.slice(0, this.cursor).replace(/\S+\s*$/, ""); this.text = before + this.text.slice(this.cursor); this.cursor = before.length; }
    else if (name === "up" && !this.text.includes("\n")) { if (this.history.length) { if (this.histIdx === -1) { this.histDraft = this.text; this.histIdx = this.history.length; } if (this.histIdx > 0) this.histIdx--; this.text = this.history[this.histIdx] ?? ""; this.cursor = this.text.length; } }
    else if (name === "down" && !this.text.includes("\n")) { if (this.histIdx >= 0) { this.histIdx++; if (this.histIdx >= this.history.length) { this.histIdx = -1; this.text = this.histDraft; } else this.text = this.history[this.histIdx] ?? ""; this.cursor = this.text.length; } }
    else if (str && !key?.ctrl && !key?.meta && str !== "\r") { const ins = str.replace(/\r\n?/g, "\n"); this.text = this.text.slice(0, this.cursor) + ins + this.text.slice(this.cursor); this.cursor += ins.length; }
    else return;
    const before = this.footerHeight();
    if (this.footerHeight() !== before) this.layout(); else this.drawFooter();
  }
  private async submit(text: string): Promise<void> {
    if (this.closed) return;
    if (text.startsWith("/")) {
      this.print(this.tty ? `${COLOR["user"]}❯${RESET} ${text}` : `❯ ${text}`);
      try { const r = await this.opts.command(text); if (r === false) this.print(`unknown command ${text.split(" ")[0]}; /help lists them`); else if (typeof r === "string") this.print(r); }
      catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
      return;
    }
    try { await this.opts.room.postUser(text); } catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async quit(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.tty) {
      this.inp.off("keypress", this.keypress); this.out.off("resize", this.resize);
      try { this.inp.setRawMode(false); } catch { /* not a tty */ }
      this.inp.pause();
      this.out.write(`${ESC}r${ESC}${this.rows};1H${ESC}?25h\n`);
    }
    await this.opts.onQuit();
  }
  close(): void { void this.quit(); }
}
export { AGENTS };

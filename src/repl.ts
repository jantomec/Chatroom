// The line-oriented REPL with the status bar (ARCHITECTURE.md §14, §14.1).
import { createInterface, type Interface } from "node:readline";
import type { Agent } from "./log.ts";
import { AGENTS, type Room } from "./room.ts";
import { shortPath } from "./git.ts";

export interface BarInfo { branch: Record<Agent, string>; directory: Record<Agent, string>; mainBranch: string; mainPath: string; integrationAhead: number }

export interface ReplOptions {
  room: Room;
  names: { claude: string; codex: string };
  statusBar: boolean;
  bar: () => BarInfo;
  command: (line: string) => Promise<boolean | string>;   // slash commands; true handled, false unknown, string = reply
  onQuit: () => Promise<void>;
  input?: NodeJS.ReadStream; output?: NodeJS.WriteStream;
}

export class Repl {
  private rl: Interface;
  private out: NodeJS.WriteStream;
  private opts: ReplOptions;
  private barLines = 0;
  private fence: string[] | null = null;
  private tty: boolean;
  private show: "quiet" | "activity" | "full" = "activity";
  constructor(opts: ReplOptions) {
    this.opts = opts;
    this.out = opts.output ?? process.stdout;
    this.tty = Boolean(this.out.isTTY);
    this.rl = createInterface({ input: opts.input ?? process.stdin, output: this.out, prompt: "> ", terminal: this.tty });
  }
  setShow(level: "quiet" | "activity" | "full"): void { this.show = level; }

  /** Print a line above the prompt; activity lines (starting with spaces and a dot) follow the display level. */
  print(line: string): void {
    const activity = /^\s+·/.test(line);
    if (activity && this.show === "quiet") return;
    if (activity && this.show === "activity" && /thinks:/.test(line)) return;
    this.clearBar();
    this.out.write(line.replace(/\n?$/, "\n"));
    this.drawBar();
  }
  private clearBar(): void {
    if (!this.tty) return;
    // erase the prompt line and the bar above it
    this.out.write("\r\x1b[2K");
    for (let i = 0; i < this.barLines; i++) this.out.write("\x1b[1A\x1b[2K");
    this.barLines = 0;
  }
  private drawBar(): void {
    if (!this.tty) { this.rl.prompt(true); return; }
    if (this.opts.statusBar) {
      const lines = this.barText();
      for (const l of lines) this.out.write(l + "\n");
      this.barLines = lines.length;
    }
    this.rl.prompt(true);
  }
  redraw(): void { this.clearBar(); this.drawBar(); }

  barText(): string[] {
    const width = this.out.columns ?? 100;
    const s = this.opts.room.state; const info = this.opts.bar();
    const fit = (text: string) => text.length > width ? text.slice(0, width - 1) + "…" : text;
    const elide = (p: string, max: number) => { if (p.length <= max) return p; const parts = p.split("/"); while (parts.length > 3 && parts.join("/").length > max) parts.splice(1, 1, "…"), parts.splice(2, 1); return parts.join("/").slice(-max); };
    const cells = (a: Agent) => {
      const st = s.status[a];
      let state = "idle";
      const prompt = [...s.prompts.entries()].find(([, p]) => p.agent === a);
      if (prompt) state = `waiting ${prompt[0].slice(0, 4)}`;
      else if (s.turns[a]) state = "working";
      else if (s.heldFor[a].size) state = "held";
      else if (s.sessions[a].state === "rebuilt") state = "rebuilt";
      const model = st.model ?? "default"; const effort = st.effort ?? "default";
      const ctx = st.contextTokens === null ? "n/a" : st.contextWindow ? `ctx ${Math.round((st.contextTokens / st.contextWindow) * 100)}%` : `ctx ${st.contextTokens}`;
      return fit(`${this.opts.names[a].padEnd(6)} ${state.padEnd(12)} ${model} · ${effort}  ${info.branch[a]}  ${elide(shortPath(info.directory[a]), 28)}  ${ctx}`);
    };
    const task = [...s.tasks.values()].filter((t) => t.state !== "accepted").at(-1);
    const room = fit(`main   ${info.mainBranch}  ${elide(shortPath(info.mainPath), 28)}   budget ${s.creditsUsed}/${s.limit} · integration +${info.integrationAhead}${task ? ` · task #${task.id} ${task.state.replace("_", " ")}` : ""}`);
    return [cells("claude"), cells("codex"), room];
  }

  start(): void {
    this.rl.on("line", (raw) => { void this.onLine(raw); });
    this.rl.on("close", () => { void this.opts.onQuit(); });
    this.drawBar();
  }
  private async onLine(raw: string): Promise<void> {
    if (this.fence) { if (raw.trim() === '"""') { const body = this.fence.join("\n"); this.fence = null; await this.submit(body); } else this.fence.push(raw); this.drawBar(); return; }
    const line = raw.trim();
    if (!line) { this.redraw(); return; }
    if (line === '"""') { this.fence = []; this.rl.setPrompt("… "); this.rl.prompt(); return; }
    await this.submit(line);
  }
  private async submit(text: string): Promise<void> {
    this.rl.setPrompt("> ");
    if (text.startsWith("/")) {
      try { const r = await this.opts.command(text); if (r === false) this.print(`unknown command ${text.split(" ")[0]}; /help lists them`); else if (typeof r === "string") this.print(r); }
      catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
      this.redraw(); return;
    }
    try { await this.opts.room.postUser(text); } catch (e) { this.print(`error: ${e instanceof Error ? e.message : String(e)}`); }
    this.redraw();
  }
  close(): void { this.rl.close(); }
}
export { AGENTS };

// The chatroom command: project setup, configuration, conversations, the session that
// wires the log, room, IPC, drivers, git and REPL together, and the agent commands.
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, rmSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { NAMES_DEFAULT, brief as makeBrief } from "./brief.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { liveScript, staticChecks } from "./drivers/doctor.ts";
import { agentVars, scrubEnv } from "./drivers/env.ts";
import { Repo, Workspaces, resolveProject, shortPath, type Conversation, type Project } from "./git.ts";
import { Ipc, agentCommand, agentEnv, participantsFromHandles } from "./ipc.ts";
import { Log, type Agent, type MessageRecord } from "./log.ts";
import { Repl } from "./repl.ts";
import { AGENTS, Room } from "./room.ts";
import { CONFIG_DEFAULTS, type Config } from "./types.ts";

const USAGE = `chatroom                      open the current conversation
chatroom new [name]           create a conversation and open it
chatroom list                 list conversations
chatroom continue <name>      make a conversation current and open it
chatroom delete <name> [--yes]
chatroom log [name] [--json]  print a conversation's log
chatroom doctor [--live]      check the installation; --live runs one turn per agent
chatroom --raw ...            also keep the raw vendor streams under the conversation directory`;

// ---------------- configuration ----------------
const KEYS: Record<string, (c: Config, v: any) => void> = {
  "autonomy.limit": (c, v) => { c.autonomyLimit = Number(v); },
  "ask.timeout_seconds": (c, v) => { c.askTimeoutSeconds = Number(v); },
  "task.review_rounds": (c, v) => { c.reviewRounds = Number(v); },
  "agents.claude.handle": (c, v) => { c.names = { ...c.names, claude: String(v) }; },
  "agents.codex.handle": (c, v) => { c.names = { ...c.names, codex: String(v) }; },
  "driver.claude.model": (c, v) => { c.claudeModel = String(v); },
  "driver.codex.model": (c, v) => { c.codexModel = String(v); },
  "driver.claude.effort": (c, v) => { c.claudeEffort = String(v); },
  "driver.codex.effort": (c, v) => { c.codexEffort = String(v); },
  "git.binary": (c, v) => { c.gitBinary = String(v); },
  "security.extra_write_roots": (c, v) => { c.extraWriteRoots = (v as string[]).map(String); },
  "security.env_allow": (c, v) => { c.envAllow = (v as string[]).map(String); },
  "display.status_bar": (c, v) => { c.statusBar = Boolean(v); },
  "brief.extra": (c, v) => { c.briefExtra = String(v); },
};
function flatten(o: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(o)) { const key = prefix ? `${prefix}.${k}` : k; if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v as Record<string, unknown>, key)); else out.push([key, v]); }
  return out;
}
export function loadConfig(files: string[]): Config {
  const c: Config = { ...CONFIG_DEFAULTS, names: { ...NAMES_DEFAULT } };
  for (const [i, f] of files.entries()) {
    if (!existsSync(f)) continue;
    const parsed = parseToml(readFileSync(f, "utf8")) as Record<string, unknown>;
    for (const [k, v] of flatten(parsed)) {
      const apply = KEYS[k];
      if (!apply) { if (i === files.length - 1) throw new Error(`${f}: unknown key ${k}`); continue; }
      apply(c, v);
    }
  }
  return c;
}

// ---------------- project ----------------
interface ProjectContext { project: Project; repo: Repo; root: string; config: Config; raw: boolean }
function findOnPath(name: string, fallback: string): string {
  for (const d of (process.env["PATH"] ?? "").split(":")) { const p = join(d, name); try { accessSync(p, constants.X_OK); return p; } catch { /* next */ } }
  return fallback;
}
function openProject(raw: boolean): ProjectContext {
  const cwd = process.cwd();
  let project = resolveProject(cwd, null);
  const root = join(project.mainWorktree, ".chatroom");
  const config = loadConfig([join(homedir(), ".config", "chatroom", "config.toml"), join(root, "config.toml")]);
  if (config.gitBinary) project = resolveProject(cwd, config.gitBinary);
  if (resolve(cwd).startsWith(join(project.stateDir, "worktrees"))) throw new Error("chatroom does not start from one of its own worktrees; run it from the main worktree");
  mkdirSync(join(root, "conversations"), { recursive: true, mode: 0o700 });
  const exclude = join(project.commonDir, "info", "exclude");
  mkdirSync(join(project.commonDir, "info"), { recursive: true });
  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!lines.split("\n").includes("/.chatroom/")) appendFileSync(exclude, (lines.endsWith("\n") || lines === "" ? "" : "\n") + "/.chatroom/\n");
  const repo = new Repo(project);
  return { project, repo, root, config, raw };
}
const currentFile = (root: string) => join(root, "current");
function currentName(root: string): string { const f = currentFile(root); return existsSync(f) ? readFileSync(f, "utf8").trim() || "default" : "default"; }
function listConversations(root: string): string[] { const d = join(root, "conversations"); return existsSync(d) ? readdirSync(d).filter((n) => existsSync(join(d, n, "log.jsonl"))).sort() : []; }

// ---------------- session ----------------
class Session {
  readonly ctx: ProjectContext; readonly name: string; readonly conv: Conversation; readonly dir: string;
  readonly log: Log; readonly ws: Workspaces; readonly ipc: Ipc; readonly room: Room;
  readonly claude: ClaudeDriver; readonly codex: CodexDriver;
  repl: Repl | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lockFile: string;
  private rawFiles: Record<Agent, string> | null = null;
  next: string | null = null;

  constructor(ctx: ProjectContext, name: string, transient = false) {
    this.ctx = ctx; this.name = name;
    const { project, repo, config } = ctx;
    this.lockFile = join(project.stateDir, "lock");
    mkdirSync(project.stateDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.lockFile)) { const pid = Number(readFileSync(this.lockFile, "utf8").trim()); if (pid && alive(pid)) throw new Error(`another chatroom (pid ${pid}) is running in this project; if that terminal is gone, run: kill ${pid}`); }
    writeFileSync(this.lockFile, String(process.pid));
    this.conv = repo.conversation(name);
    this.dir = join(ctx.root, "conversations", name);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(join(this.dir, "log.jsonl"));
    this.log = new Log(join(this.dir, "log.jsonl"));
    if (fresh) Workspaces.writeMainBranchNote(this.log, project.mainBranch);
    if (!transient) writeFileSync(currentFile(ctx.root), name + "\n");
    this.ws = new Workspaces(repo, this.conv, this.log);
    this.ipc = new Ipc(join(project.stateDir, "ipc", name));
    for (const a of AGENTS) this.ipc.ensure(a);
    if (ctx.raw) this.rawFiles = { claude: join(this.dir, "raw-claude.jsonl"), codex: join(this.dir, "raw-codex.jsonl") };
    const bin = resolve(process.argv[1] ?? "chatroom");
    const baseEnv = (a: Agent) => ({ ...scrubEnv(process.env, config.envAllow), ...agentVars({ agent: a, handle: config.names[a], conversation: name, drop: this.ipc.drop(a), deliveries: this.ipc.deliveries(a), receipts: this.ipc.receipts(a), scratch: this.ipc.scratch(a), bin, askTimeoutSeconds: config.askTimeoutSeconds }) });
    this.claude = new ClaudeDriver({ bin: findOnPath("claude", join(homedir(), ".local", "bin", "claude")), settings: this.claudeSettings(), model: config.claudeModel, effort: config.claudeEffort, env: () => baseEnv("claude"), writeDelivery: (t) => this.ipc.writeDelivery("claude", t), raw: this.rawFiles ? (l) => appendFileSync(this.rawFiles!.claude, l + "\n") : undefined });
    this.codex = new CodexDriver({ bin: findOnPath("codex", "codex"), config: this.codexConfig(), model: config.codexModel, effort: config.codexEffort, env: () => baseEnv("codex"), scratch: () => this.ipc.scratch("codex"), raw: this.rawFiles ? (l) => appendFileSync(this.rawFiles!.codex, l + "\n") : undefined });
    this.room = new Room(this.log, config, { claude: this.claude, codex: this.codex }, {
      output: (line) => this.print(line),
      prompt: (agent, id, summary) => this.print(`!${id.slice(0, 8)} ${config.names[agent]} asks: ${summary}   (/allow ${id.slice(0, 8)} or /deny ${id.slice(0, 8)} [reason])`),
      context: (agent) => ({ workspace: this.ws.workspaceLine(agent), peerChanges: this.ws.peerChanges(agent, null) }),
      afterTurn: (agent) => { this.ws.refresh(); this.ipc.clear(agent); this.barCache = null; },
      status: () => this.repl?.redraw(),
      session: (agent) => ({ cwd: this.conv.worktrees[agent], brief: makeBrief({ agent, names: config.names, myWorktree: this.conv.worktrees[agent], peerWorktree: this.conv.worktrees[agent === "claude" ? "codex" : "claude"], mainTree: project.mainWorktree, myBranch: this.conv.branches[agent], nativeCommit: true, extra: config.briefExtra }) }),
    });
  }
  private print(line: string): void { if (this.repl) this.repl.print(line); else process.stdout.write(line + "\n"); }

  claudeSettings(): unknown {
    const { project, config } = this.ctx; const c = this.conv; const g = project.commonDir;
    const hook = [{ matcher: "", hooks: [{ type: "command", command: "\"$CHATROOM_BIN\" hook" }] }];
    return {
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        filesystem: {
          allowWrite: [this.ipc.drop("claude"), this.ipc.scratch("claude"), ...config.extraWriteRoots],
          denyWrite: [c.adminDirs.codex, c.adminDirs.integration, ...(project.mainBranch ? [join(g, "refs", "heads", project.mainBranch)] : []), join(g, "refs", "heads", c.branches.codex), join(g, "refs", "heads", c.branches.integration), join(g, "packed-refs")],
          denyRead: [this.ipc.dir("codex")],
        },
      },
      permissions: { deny: [
        `Edit(//${c.worktrees.codex}/**)`, `Write(//${c.worktrees.codex}/**)`, `Edit(//${c.worktrees.integration}/**)`, `Write(//${c.worktrees.integration}/**)`,
        `Edit(//${this.ipc.dir("codex")}/**)`, `Write(//${this.ipc.dir("codex")}/**)`, `Edit(//${join(this.ipc.dir("claude"), "to-agent")}/**)`, `Write(//${join(this.ipc.dir("claude"), "to-agent")}/**)`,
      ] },
      hooks: { PostToolUse: hook, PostToolUseFailure: hook },
    };
  }
  codexConfig(): Record<string, unknown> {
    const { project, config } = this.ctx; const c = this.conv; const g = project.commonDir;
    const fs: Record<string, string> = { ":root": "read", [c.worktrees.codex]: "write", [this.ipc.drop("codex")]: "write", [this.ipc.scratch("codex")]: "write", [c.adminDirs.codex]: "write", [join(g, "objects")]: "write" };
    for (const suffix of ["", ".lock"]) { fs[join(g, "refs", "heads", c.branches.codex + suffix)] = "write"; fs[join(g, "logs", "refs", "heads", c.branches.codex + suffix)] = "write"; }
    for (const r of config.extraWriteRoots) fs[r] = "write";
    fs[this.ipc.dir("claude")] = "deny";
    return { default_permissions: "chatroom", permissions: { chatroom: { filesystem: fs } }, shell_environment_policy: { set: { TMPDIR: this.ipc.scratch("codex"), GIT_OPTIONAL_LOCKS: "0" } } };
  }

  /** Import the agents' operation files and answer them. */
  private async pollIpc(): Promise<void> {
    const { config } = this.ctx;
    for (const a of AGENTS) {
      for (const op of this.ipc.poll(a)) {
        try {
          if (op.type === "delivery_ack") {
            const ids = this.claude.ackFiles(op.delivered ?? []);
            for (const f of op.delivered ?? []) this.ipc.removeDelivery(a, f);
            await this.room.ackDelivery(a, ids);
            if (op.effort !== undefined || op.cwd !== undefined) this.room.reportStatus(a, { effort: op.effort ?? null, cwd: op.cwd ?? null });
            continue;
          }
          if (!this.room.state.turns[a]) { this.ipc.writeReceipt(a, { op: op.op, status: "rejected", reason: "no turn is active" }); continue; }
          const to = participantsFromHandles(op.to, config.names);
          const m = await this.room.postAgent(a, { op: op.op, body: op.body ?? "", ...(to ? { to } : {}), ...(op.reply_to ? { replyTo: op.reply_to } : {}), turn: this.room.state.turns[a]!.id, via: op.type === "reply" ? "reply" : "post" });
          this.ipc.writeReceipt(a, { op: op.op, status: "accepted", message: m.id });
          if (op.type === "ask") void this.room.waitForAnswer(m.id, a, config.askTimeoutSeconds * 1000).then((r) => this.ipc.writeAnswer(a, op.op, { status: r.status, message: r.message ? { id: r.message.id, from: config.names[r.message.from as Agent] ?? r.message.from, body: r.message.body } : undefined }));
        } catch (e) { this.ipc.writeReceipt(a, { op: op.op, status: "rejected", reason: String(e) }); }
      }
    }
  }

  async start(): Promise<string | null> {
    const { config, project } = this.ctx;
    for (const n of this.ws.recover()) this.print(`  · recovery: ${n}`);
    this.ws.refresh();
    this.repl = new Repl({
      room: this.room, names: config.names, statusBar: config.statusBar,
      bar: () => this.barInfo(),
      command: (line) => this.command(line),
      onQuit: () => this.close(),
    });
    const onSignal = () => { void this.repl?.quit(); };
    const onHangup = () => { this.repl?.hangup(); };
    process.once("SIGTERM", onSignal); process.once("SIGHUP", onHangup);
    let reporting = false;
    const onError = (e: unknown) => {
      if (reporting) return; reporting = true;          // never let an error in the report loop back here
      try { this.print(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); } catch { this.repl?.hangup(); }
      reporting = false;
    };
    process.on("uncaughtException", onError); process.on("unhandledRejection", onError);
    await this.repl.start();
    this.print(`chatroom · conversation "${this.name}" · ${shortPath(project.mainWorktree)} · ${config.names.claude} (Claude) and ${config.names.codex} (Codex) · /help for commands`);
    const recent = [...this.room.state.messages.values()].slice(-5);
    for (const m of recent) this.print(`#${m.id} ${config.names[m.from as Agent] ?? m.from} → ${m.to.map((t) => "@" + (config.names[t as Agent] ?? t)).join(" ")}  ${m.at.slice(11, 16)}  ${m.via ?? ""}\n  ${m.body.split("\n").join("\n  ")}`);
    this.poll = setInterval(() => { void this.pollIpc(); }, 150);
    void this.room.warm().then(() => this.repl?.redraw());
    await this.room.tick();
    await new Promise<void>((r) => { this.done = r; });
    process.off("SIGTERM", onSignal); process.off("SIGHUP", onHangup); process.off("uncaughtException", onError); process.off("unhandledRejection", onError);
    return this.next;
  }
  private done: (() => void) | null = null;
  private closing = false;
  private barCache: { at: number; info: import("./repl.ts").BarInfo } | null = null;
  /** The git-derived status values, refreshed at most every three seconds so a keystroke never runs git. */
  private barInfo(force = false): import("./repl.ts").BarInfo {
    if (!force && this.barCache && Date.now() - this.barCache.at < 3000) return this.barCache.info;
    const info = { branch: { claude: this.branchCell("claude"), codex: this.branchCell("codex") }, directory: { claude: this.conv.worktrees.claude, codex: this.conv.worktrees.codex }, mainBranch: this.ctx.repo.mainBranch() ?? "detached", mainPath: this.ctx.project.mainWorktree, integrationAhead: this.ctx.repo.unintegrated(this.conv).integration, conversation: this.name };
    this.barCache = { at: Date.now(), info };
    return info;
  }
  private branchCell(a: Agent): string { const h = this.ctx.repo.headRef(this.conv.adminDirs[a]); return h === `refs/heads/${this.conv.branches[a]}` ? this.conv.branches[a].replace(`chatroom/${this.name}/`, "chatroom/…/") : "detached"; }

  async close(): Promise<void> {
    if (this.closing) return; this.closing = true;
    const dbg = (m: string) => { if (process.env["CHATROOM_DEBUG"]) appendFileSync(process.env["CHATROOM_DEBUG"], `${new Date().toISOString()} close: ${m}\n`); };
    dbg("begin");
    if (this.poll) clearInterval(this.poll); this.poll = null;
    try { for (const a of AGENTS) if (this.room.state.turns[a]) await this.room.stop(a); } catch (e) { dbg(`stop failed: ${String(e)}`); }
    dbg("stopped");
    try { await this.room.close(); } catch (e) { dbg(`drivers close failed: ${String(e)}`); }
    dbg("drivers closed");
    this.log.close();
    try { if (readFileSync(this.lockFile, "utf8").trim() === String(process.pid)) rmSync(this.lockFile); } catch { /* ignore */ }
    dbg("done");
    this.done?.();
  }

  private agentArg(s: string | undefined): Agent | "all" | null {
    if (!s) return null; const l = s.toLowerCase(); const n = this.ctx.config.names;
    if (l === "all") return "all"; if (l === "claude" || l === n.claude.toLowerCase()) return "claude"; if (l === "codex" || l === n.codex.toLowerCase()) return "codex"; return null;
  }
  private async command(line: string): Promise<boolean | string> {
    const [cmd, ...args] = line.slice(1).split(/\s+/);
    const room = this.room; const names = this.ctx.config.names;
    const each = async (arg: string | undefined, f: (a: Agent) => string): Promise<string> => { const a = this.agentArg(arg); if (!a) return `which agent? ${names.claude}, ${names.codex} or all`; const list = a === "all" ? AGENTS : [a]; for (const x of list) if (room.state.turns[x]) return `${names[x]} has a turn in flight; wait or /stop ${names[x]}`; return list.map((x) => `${names[x]}: ${f(x)}`).join("\n"); };
    switch (cmd) {
      case "help": return `commands: /budget [N] · /status · /stop <agent|all> · /allow <id> · /deny <id> [reason] · /snapshot <agent|all> · /integrate <agent> · /sync <agent|all> · /sync --abort <agent> · /import <src> <dst> · /apply [agent] · /apply --abort · /adopt main|integration · /tasks · /reply <id> <text> · /show quiet|activity|full · /history [N] · /conversations · /new <name> · /switch <name> · /doctor · /quit\nplain text is a message; @${names.claude} @${names.codex} @all address; shift-enter, option-enter, ctrl-j or a trailing \\ add a line; option/ctrl with arrows move by word; ctrl-c twice quits`;
      case "budget": { if (args[0]) { await room.setBudget(Number(args[0])); } return `budget ${room.state.creditsUsed}/${room.state.limit}`; }
      case "status": return this.statusText();
      case "stop": { const a = this.agentArg(args[0]); if (!a) return "which agent?"; for (const x of a === "all" ? AGENTS : [a]) await room.stop(x); return "stop requested"; }
      case "allow": case "deny": { const id = [...room.state.prompts.keys()].find((k) => k.startsWith(args[0] ?? "")); if (!id) return `no pending prompt ${args[0] ?? ""}`; await room.answerPrompt(id, cmd === "allow" ? "allow" : "deny", args.slice(1).join(" ") || undefined); return `${cmd}: ${id.slice(0, 8)}`; }
      case "snapshot": return each(args[0], (a) => this.ws.snapshot(a).detail);
      case "integrate": return each(args[0], (a) => this.ws.integrate(a).detail);
      case "sync": if (args[0] === "--abort") return each(args[1], (a) => this.ws.syncAbort(a).detail); return each(args[0], (a) => this.ws.sync(a).detail);
      case "import": { const s = this.agentArg(args[0]); const d = this.agentArg(args[1]); if (!s || !d || s === "all" || d === "all") return "usage: /import <src agent> <dst agent>"; const r = this.ws.integrate(s); if (r.status !== "done" && r.status !== "skipped") return r.detail; return `${r.detail}; ${this.ws.sync(d).detail}`; }
      case "apply": { if (args[0] === "--abort") return this.ws.applyAbort().detail; const a = this.agentArg(args[0]); if (args[0] && (!a || a === "all")) return "usage: /apply [agent]"; const agent = a === "all" ? null : a; if (agent && room.state.turns[agent]) return `${names[agent]} has a turn in flight`; return this.ws.apply(agent).detail; }
      case "adopt": { if (args[0] !== "main" && args[0] !== "integration") return "usage: /adopt main|integration"; this.ws.adopt(args[0]); return `adopted ${args[0]}`; }
      case "tasks": return this.tasksText();
      case "reply": { const id = Number(args[0]); const m = room.state.messages.get(id); if (!m) return `no message #${args[0]}`; await room.postUser(args.slice(1).join(" "), [m.from], id); return true; }
      case "show": { const l = args[0] as "quiet" | "activity" | "full"; if (!["quiet", "activity", "full"].includes(l)) return "usage: /show quiet|activity|full"; this.repl?.setShow(l); return `showing ${l}`; }
      case "history": { const n = Number(args[0] ?? 20); return [...room.state.messages.values()].slice(-n).map((m) => `#${m.id} ${names[m.from as Agent] ?? m.from} → ${m.to.map((t) => "@" + (names[t as Agent] ?? t)).join(" ")}  ${m.at.slice(11, 16)}\n  ${m.body}`).join("\n"); }
      case "conversations": return listConversations(this.ctx.root).map((n) => (n === this.name ? `* ${n}` : `  ${n}`)).join("\n") || "(none)";
      case "new": case "switch": { const n = args[0]; if (!n || !/^[\w.-]+$/.test(n)) return `usage: /${cmd} <name>`; this.next = n; await this.close(); return true; }
      case "doctor": return staticChecks({ claude: findOnPath("claude", join(homedir(), ".local", "bin", "claude")), codex: findOnPath("codex", "codex"), git: this.ctx.project.gitBin, gitVersion: this.ctx.project.gitVersion }).map((c) => `${c.ok ? "ok " : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
      case "quit": case "exit": await this.close(); return true;
      default: return false;
    }
  }
  private statusText(): string {
    const s = this.room.state; const names = this.ctx.config.names; const lines: string[] = [];
    for (const a of AGENTS) {
      const st = s.status[a]; const ses = s.sessions[a];
      lines.push(`${names[a]}: ${s.turns[a] ? `turn ${s.turns[a]!.id}` : "idle"} · session ${ses.state}${ses.id ? ` ${ses.id.slice(0, 8)}` : ""} · model ${st.model ?? "default"} · effort ${st.effort ?? "default"} · cwd ${st.cwd ? shortPath(st.cwd) : "n/a"} · context ${st.contextTokens ?? "n/a"}${st.contextWindow ? `/${st.contextWindow}` : ""} (reported ${st.at ? st.at.slice(11, 19) : "never"}) · held ${s.heldFor[a].size}`);
    }
    for (const [id, p] of s.prompts) lines.push(`prompt ${id.slice(0, 8)} from ${names[p.agent]}: ${p.summary}`);
    const refs = this.ws.refresh();
    lines.push(`refs: ${Object.entries(refs.refs).map(([k, v]) => `${k.replace(`chatroom/${this.name}/`, "…/")}=${this.ctx.repo.short(v)}`).join(" ")}${refs.deviation ? `\ndeviation: ${refs.deviation}` : ""}`);
    lines.push(`git ${this.ctx.project.gitBin} (${this.ctx.project.gitVersion}) · budget ${s.creditsUsed}/${s.limit} · log ${shortPath(this.log.path)}`);
    return lines.join("\n");
  }
  private tasksText(): string {
    const s = this.room.state; const out: string[] = [];
    for (const t of s.tasks.values()) {
      const m = s.messages.get(t.id);
      out.push(`#${t.id} ${t.state.replace("_", " ")} · lead ${t.lead ?? "-"} · criteria ${t.criteria ? "#" + t.criteria : "none"} · blockers ${t.blockers}/${this.ctx.config.reviewRounds}${t.settled.length ? ` · settled ${t.settled.map((i) => "#" + i).join(",")}` : ""}${t.assumptions.length ? ` · assumptions ${t.assumptions.map((i) => "#" + i).join(",")}` : ""}${t.suggestions.length ? ` · suggestions ${t.suggestions.map((i) => "#" + i).join(",")}` : ""}${t.questions.length ? ` · questions ${t.questions.map((i) => "#" + i).join(",")}` : ""}\n  ${m?.body.split("\n")[0]?.slice(0, 100) ?? ""}`);
    }
    return out.join("\n") || "no tasks yet";
  }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---------------- live doctor ----------------
async function liveDoctor(ctx: ProjectContext): Promise<number> {
  const name = `doctor-${Date.now().toString(36)}`;
  const s: Session = new Session(ctx, name, true);
  const results: string[] = [];
  const out: string[] = [];
  s.room.hooks.output = (l) => { out.push(l); process.stdout.write(l + "\n"); };
  const files = { main: join(ctx.project.mainWorktree, "chatroom-doctor-main.txt"), ipc: join(ctx.project.stateDir, "ipc", name, "chatroom-doctor-ipc.txt") };
  const before = { main: ctx.repo.mainHead(), claude: ctx.repo.refOid(`refs/heads/${s.conv.branches.claude}`), codex: ctx.repo.refOid(`refs/heads/${s.conv.branches.codex}`) };
  const poll = setInterval(() => { void (s as any).pollIpc(); }, 150);
  try {
    for (const a of AGENTS) {
      const peer = a === "claude" ? "codex" : "claude";
      const text = liveScript({ agent: a, own: s.conv.worktrees[a], main: ctx.project.mainWorktree, peer: s.conv.worktrees[peer], ipcRoot: join(ctx.project.stateDir, "ipc", name), commonDir: ctx.project.commonDir, ownRef: "", peerRef: "", mainRef: "" });
      await s.room.postUser(text.replace("[chatroom doctor]", `@${ctx.config.names[a]} [chatroom doctor]`), [a]);
    }
    // a mid-turn message while both run
    await new Promise((r) => setTimeout(r, 4000));
    const mid = await s.room.postUser(`@${ctx.config.names.claude} @${ctx.config.names.codex} also: after the commands, end your reply with the word MANGO.`);
    const t0 = Date.now();
    while ((s.room.state.turns.claude || s.room.state.turns.codex) && Date.now() - t0 < 600_000) { await new Promise((r) => setTimeout(r, 500)); await s.room.idle(); }
    const replies = [...s.room.state.messages.values()].filter((m) => m.from === "claude" || m.from === "codex");
    const check = (name: string, ok: boolean, detail = "") => results.push(`${ok ? "ok " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    check("both agents replied (post or final)", replies.some((m) => m.from === "claude") && replies.some((m) => m.from === "codex"), [...new Set(replies.map((m) => m.from))].join(","));
    check("mid-turn message reached both (MANGO from each after it)", AGENTS.every((a) => replies.some((m) => m.from === a && m.id > mid.id && /MANGO/.test(m.body))));
    check("own worktree writes landed", existsSync(join(s.conv.worktrees.claude, "chatroom-doctor-own.txt")) && existsSync(join(s.conv.worktrees.codex, "chatroom-doctor-own.txt")));
    check("main tree untouched", !existsSync(files.main) && ctx.repo.mainHead() === before.main);
    check("peer worktrees untouched", !existsSync(join(s.conv.worktrees.codex, "chatroom-doctor-peer.txt")) && !existsSync(join(s.conv.worktrees.claude, "chatroom-doctor-peer.txt")));
    check("IPC root untouched", !existsSync(files.ipc));
    check("claude committed on its own branch only", ctx.repo.refOid(`refs/heads/${s.conv.branches.claude}`) !== before.claude, "nativeCommit");
    check("codex committed on its own branch only", ctx.repo.refOid(`refs/heads/${s.conv.branches.codex}`) !== before.codex, "nativeCommit");
    check("main ref unchanged", ctx.repo.mainHead() === before.main);
    const st = s.room.state.status;
    check("status bar sources", st.claude.model !== null && st.codex.model !== null && st.claude.contextTokens !== null && st.codex.contextWindow !== null, `claude ${st.claude.model}/${st.claude.effort}/${st.claude.contextTokens}/${st.claude.contextWindow} codex ${st.codex.model}/${st.codex.effort}/${st.codex.contextTokens}/${st.codex.contextWindow}`);
  } finally {
    clearInterval(poll);
    await s.close();
    try { rmSync(files.main, { force: true }); } catch { /* none */ }
    ctx.repo.removeConversation(s.conv);
    for (const d of [join(ctx.root, "conversations", name), join(ctx.project.stateDir, "ipc", name)]) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { results.push(`note: could not remove ${d}: ${String(e)}`); } }
  }
  process.stdout.write("\n" + results.join("\n") + "\n");
  return results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}

// ---------------- entry ----------------
export async function main(argv: string[]): Promise<number> {
  const env = agentEnv();
  const [first] = argv;
  if (env && first && ["post", "reply", "ask", "inbox", "hook"].includes(first)) {
    return agentCommand(first, argv.slice(1), env, { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n"), stdin: () => { try { return readFileSync(0, "utf8"); } catch { return ""; } } });
  }
  const raw = argv.includes("--raw"); const args = argv.filter((a) => a !== "--raw");
  const cmd = args[0];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { process.stdout.write(USAGE + "\n"); return 0; }
  const ctx = openProject(raw);
  switch (cmd) {
    case undefined: return runSessions(ctx, currentName(ctx.root));
    case "new": { const n = args[1] ?? `c${listConversations(ctx.root).length + 1}`; if (!/^[\w.-]+$/.test(n)) throw new Error("a conversation name is letters, digits, dots, dashes and underscores"); return runSessions(ctx, n); }
    case "continue": { if (!args[1]) throw new Error("usage: chatroom continue <name>"); return runSessions(ctx, args[1]); }
    case "list": { const cur = currentName(ctx.root); for (const n of listConversations(ctx.root)) process.stdout.write(`${n === cur ? "*" : " "} ${n}\n`); return 0; }
    case "log": { const n = args[1] && !args[1].startsWith("--") ? args[1] : currentName(ctx.root); const p = join(ctx.root, "conversations", n, "log.jsonl"); if (!existsSync(p)) throw new Error(`no conversation ${n}`); const text = readFileSync(p, "utf8"); if (args.includes("--json")) { process.stdout.write(text); return 0; } for (const line of text.split("\n").filter(Boolean)) { let r: any; try { r = JSON.parse(line); } catch { continue; } if (r.kind === "message") process.stdout.write(`#${r.id} ${r.at.slice(11, 19)} ${ctx.config.names[r.from as Agent] ?? r.from} → ${(r.to as string[]).map((t) => "@" + (ctx.config.names[t as Agent] ?? t)).join(" ")}${r.held ? " (held)" : ""}\n  ${String(r.body).split("\n").join("\n  ")}\n`); else if (r.kind !== "status") process.stdout.write(`   ${r.at.slice(11, 19)} ${r.kind}${r.event ? " " + r.event : ""}${r.agent ? " " + r.agent : ""}${r.op ? " " + r.op : ""}${r.marker ? ` [${r.marker}] #${r.task} ${r.effect}` : ""}${r.detail ? " " + r.detail : ""}${r.text ? " " + r.text : ""}\n`); } return 0; }
    case "delete": { const n = args[1]; if (!n) throw new Error("usage: chatroom delete <name> [--yes]"); const conv = ctx.repo.conversation(n); const u = ctx.repo.unintegrated(conv); process.stdout.write(`will remove: worktrees under ${shortPath(join(ctx.project.stateDir, "worktrees", n))}, refs chatroom/${n}/{claude,codex,integration}, ${shortPath(join(ctx.root, "conversations", n))}\ncommits not in integration: claude ${u.claude}, codex ${u.codex}; integration commits not in main: ${u.integration}\n`); if (!args.includes("--yes")) { process.stdout.write("run again with --yes to delete\n"); return 1; } ctx.repo.removeConversation(conv); rmSync(join(ctx.root, "conversations", n), { recursive: true, force: true }); rmSync(join(ctx.project.stateDir, "ipc", n), { recursive: true, force: true }); if (currentName(ctx.root) === n) rmSync(currentFile(ctx.root), { force: true }); process.stdout.write("deleted\n"); return 0; }
    case "doctor": { const checks = staticChecks({ claude: findOnPath("claude", join(homedir(), ".local", "bin", "claude")), codex: findOnPath("codex", "codex"), git: ctx.project.gitBin, gitVersion: ctx.project.gitVersion }); for (const c of checks) process.stdout.write(`${c.ok ? "ok " : "FAIL"} ${c.name}: ${c.detail}\n`); if (args.includes("--live")) return liveDoctor(ctx); return checks.every((c) => c.ok) ? 0 : 1; }
    default: process.stdout.write(USAGE + "\n"); return 2;
  }
}
async function runSessions(ctx: ProjectContext, name: string): Promise<number> {
  let next: string | null = name;
  while (next) { const session: Session = new Session(ctx, next); next = await session.start(); }
  return 0;
}
export type { MessageRecord };

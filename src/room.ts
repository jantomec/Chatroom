// The room: a fold over the log, addressing and the budget, the scheduler, turns, and the
// collaboration protocol's four behaviours (ARCHITECTURE.md §6, §7, §10, §11.3).
import { formatDelivery, parseMarker, resolveTargets, type Marker } from "./brief.ts";
import { clock, type Agent, type Log, type LogRecord, type MessageRecord, type Participant } from "./log.ts";
import type { Config, Driver, DriverEvent, Status } from "./types.ts";

export type TaskState = "open" | "done_claimed" | "accepted" | "waiting_user" | "escalated";
export interface Task {
  id: number; state: TaskState; lead: Agent | null; claimant: Agent | null; criteria: number | null;
  blockers: number; settled: number[]; assumptions: number[]; suggestions: number[]; questions: number[]; done: number | null; accept: number | null;
}
export interface TurnState { id: string; agent: Agent; inputs: number[]; explicitReply: boolean }

export interface RoomState {
  messages: Map<number, MessageRecord>;
  ops: Set<string>;                              // "<from>:<op>" seen
  received: Record<Agent, Set<number>>;          // message ids each agent has received
  retracted: Record<Agent, Set<number>>;         // user messages withdrawn by Esc before that agent read them
  overrides: Record<Agent, { model: string | null; effort: string | null }>;   // /model and /effort choices; null = vendor default
  heldFor: Record<Agent, Set<number>>;           // message ids held for an agent (budget or task)
  turns: Record<Agent, TurnState | null>;        // active turn
  turnCount: number;
  lastUserMessage: number;                        // id, 0 if none
  creditsUsed: number;                            // agent-to-agent activations since the last user message
  limit: number;
  tasks: Map<number, Task>;
  sessions: Record<Agent, { id: string | null; state: "none" | "started" | "resumed" | "rebuilt" }>;
  status: Record<Agent, Status & { at: string | null }>;
  prompts: Map<string, { agent: Agent; summary: string; request: unknown }>;
  lastRefs: Record<string, string | null> | null;
  interrupted: Record<Agent, { id: string; inputs: number[] } | null>;   // turns found open at startup
  exchange: { agentMessages: number; lastSpeaker: Agent | null; held: boolean; summaryRequested: boolean; summaryPosted: boolean };   // since the user's last message
}

export const AGENTS: Agent[] = ["claude", "codex"];
export const peerOf = (a: Agent): Agent => (a === "claude" ? "codex" : "claude");
const emptyStatus = () => ({ model: null, effort: null, cwd: null, contextTokens: null, contextWindow: null, at: null });

export function fold(records: LogRecord[], limit: number): RoomState {
  const s: RoomState = {
    messages: new Map(), ops: new Set(), received: { claude: new Set(), codex: new Set() }, retracted: { claude: new Set(), codex: new Set() }, overrides: { claude: { model: null, effort: null }, codex: { model: null, effort: null } }, heldFor: { claude: new Set(), codex: new Set() },
    turns: { claude: null, codex: null }, turnCount: 0, lastUserMessage: 0, creditsUsed: 0, limit, tasks: new Map(),
    sessions: { claude: { id: null, state: "none" }, codex: { id: null, state: "none" } },
    status: { claude: emptyStatus(), codex: emptyStatus() }, prompts: new Map(), lastRefs: null, interrupted: { claude: null, codex: null },
    exchange: { agentMessages: 0, lastSpeaker: null, held: false, summaryRequested: false, summaryPosted: false },
  };
  const pendingHook: Record<Agent, number[]> = { claude: [], codex: [] };
  for (const r of records) {
    switch (r.kind) {
      case "message": {
        s.messages.set(r.id, r);
        if (r.op) s.ops.add(`${r.from}:${r.op}`);
        if (r.from === "user") { s.lastUserMessage = r.id; s.creditsUsed = 0; s.exchange = { agentMessages: 0, lastSpeaker: null, held: false, summaryRequested: false, summaryPosted: false }; }
        else if (r.from === "claude" || r.from === "codex") {
          if (r.credit) s.creditsUsed++;
          if (r.to.includes(peerOf(r.from))) s.exchange.agentMessages++;
          s.exchange.lastSpeaker = r.from;
          if (r.held) s.exchange.held = true;
          if (r.via === "summary" ) s.exchange.summaryPosted = true;
        }
        if (r.held) for (const t of r.to) if (t === "claude" || t === "codex") s.heldFor[t].add(r.id);
        break;
      }
      case "turn": {
        const a = r.agent;
        if (r.event === "started") { s.turns[a] = { id: r.turn, agent: a, inputs: r.inputs ?? [], explicitReply: false }; s.turnCount++; for (const i of r.inputs ?? []) s.received[a].add(i); if (r.reason === "summary") s.exchange.summaryRequested = true; }
        else if (r.event === "delivered") { for (const i of r.inputs ?? []) s.received[a].add(i); }
        else if (r.event === "acked") { for (const i of r.inputs ?? []) s.received[a].add(i); pendingHook[a] = pendingHook[a].filter((i) => !(r.inputs ?? []).includes(i)); }
        else if (r.event === "released") { /* nothing: ids were never in received */ }
        else { s.turns[a] = null; s.interrupted[a] = null; pendingHook[a] = []; }
        break;
      }
      case "marker": applyMarker(s, r.marker as Marker, r.task, r.message, r.from, r.effect); break;
      case "session": { if (r.event === "closed") s.sessions[r.agent] = { id: s.sessions[r.agent].id, state: "none" }; else s.sessions[r.agent] = { id: r.session ?? s.sessions[r.agent].id, state: r.event }; break; }
      case "budget": {
        if (r.event === "limit" && typeof r.limit === "number") s.limit = r.limit;
        if (r.event === "released") for (const id of r.messages ?? []) for (const a of AGENTS) s.heldFor[a].delete(id);
        break;
      }
      case "config": {
        if (r.model !== undefined) s.overrides[r.agent].model = r.model;
        if (r.effort !== undefined) s.overrides[r.agent].effort = r.effort;
        break;
      }
      case "interrupt": {
        for (const x of r.retracted) for (const a of x.from) s.retracted[a].add(x.message);
        for (const x of r.held) for (const a of x.for) s.heldFor[a].add(x.message);
        for (const a of AGENTS) pendingHook[a] = [];
        s.exchange.summaryRequested = true;          // the user stopped the exchange: no summary until the next message
        break;
      }
      case "status": { const st = s.status[r.agent]; for (const k of ["model", "effort", "cwd", "contextTokens", "contextWindow"] as const) if (r[k] !== undefined) (st as any)[k] = r[k]; st.at = r.at; break; }
      case "permission": { if (r.event === "asked") s.prompts.set(r.prompt, { agent: r.agent, summary: r.summary ?? "", request: r.request }); else s.prompts.delete(r.prompt); break; }
      case "ref": s.lastRefs = r.refs; break;
      default: break;
    }
  }
  // A turn still open at the end of the log was interrupted by a crash.
  for (const a of AGENTS) if (s.turns[a]) { s.interrupted[a] = { id: s.turns[a]!.id, inputs: s.turns[a]!.inputs }; }
  return s;
}

function task(s: RoomState, id: number): Task {
  let t = s.tasks.get(id);
  if (!t) { t = { id, state: "open", lead: null, claimant: null, criteria: null, blockers: 0, settled: [], assumptions: [], suggestions: [], questions: [], done: null, accept: null }; s.tasks.set(id, t); }
  return t;
}
/** Replays a marker record's recorded effect onto the task table. */
function applyMarker(s: RoomState, marker: Marker, taskId: number, message: number, from: Participant, effect: string): void {
  const t = task(s, taskId);
  const agent = from === "claude" || from === "codex" ? from : null;
  switch (effect) {
    case "criteria": t.criteria = message; if (!t.lead && agent) t.lead = agent; if (t.state === "waiting_user" || t.state === "escalated") { /* unchanged */ } break;
    case "done_claimed": t.state = "done_claimed"; t.claimant = agent; t.done = message; if (!t.lead && agent) t.lead = agent; break;
    case "accepted": t.state = "accepted"; t.accept = message; break;
    case "blocker": t.state = "open"; t.blockers++; break;
    case "escalated": t.state = "escalated"; t.blockers++; t.suggestions.push(message); break;
    case "waiting_user": t.state = "waiting_user"; t.questions.push(message); break;
    case "reopened": t.state = "open"; break;
    case "settled": t.settled.push(message); break;
    case "assumption": t.assumptions.push(message); break;
    case "suggestion": t.suggestions.push(message); break;
    default: break;
  }
  void marker;
}

export interface RoomHooks {
  output?: (line: string) => void;                                    // transcript and activity lines
  prompt?: (agent: Agent, id: string, summary: string) => void;       // a relayed prompt
  context?: (agent: Agent) => { workspace?: { own: string; integration: string; peer: string; main: string }; peerChanges?: string[] } | undefined;
  afterTurn?: (agent: Agent) => Promise<void> | void;                  // e.g. refresh ref expectations
  session?: (agent: Agent) => { cwd: string; brief: string };          // what a driver needs to connect
  status?: () => void;                                                 // a status value changed; repaint
}

export class Room {
  readonly log: Log;
  readonly config: Config;
  readonly drivers: Record<Agent, Driver>;
  readonly hooks: RoomHooks;
  state: RoomState;
  private starting: Record<Agent, boolean> = { claude: false, codex: false };
  private connected: Record<Agent, boolean> = { claude: false, codex: false };
  private connecting: Record<Agent, Promise<void> | null> = { claude: null, codex: null };
  private reconnect: Record<Agent, boolean> = { claude: false, codex: false };   // a /model or /effort change waits for the turn to end
  private pendingHook: Record<Agent, number[]> = { claude: [], codex: [] };
  private explicitReply: Record<Agent, boolean> = { claude: false, codex: false };
  private askWaiters = new Map<number, { agent: Agent; resolve: (r: { status: string; message?: MessageRecord }) => void }>();
  private chain: Promise<void> = Promise.resolve();
  /** Resolves when every driver event received so far has been handled. */
  idle(): Promise<void> { return this.chain; }

  constructor(log: Log, config: Config, drivers: Record<Agent, Driver>, hooks: RoomHooks = {}) {
    this.log = log; this.config = config; this.drivers = drivers; this.hooks = hooks;
    this.state = fold(log.records, config.autonomyLimit);
    const interrupted = this.state.interrupted;
    for (const a of AGENTS) {
      if (interrupted[a]) { this.log.append({ kind: "turn", agent: a, turn: interrupted[a]!.id, event: "interrupted", reason: "found open at startup" }); }
      drivers[a].onEvent((e) => { this.chain = this.chain.then(() => this.onDriverEvent(a, e)).catch((err) => this.say(`  · error handling ${e.type} from ${a}: ${String(err)}`)); });
    }
    this.refold();
    this.state.interrupted = interrupted;
    for (const a of AGENTS) { const o = this.state.overrides[a]; if (o.model !== null) this.drivers[a].setModel(o.model); if (o.effort !== null) this.drivers[a].setEffort(o.effort); }   // choices recorded in the log outlive the session
  }
  private limitFromLog(): number { let l = this.config.autonomyLimit; for (const r of this.log.records) if (r.kind === "budget" && r.event === "limit" && typeof r.limit === "number") l = r.limit; return l; }
  private refold(): void { const interrupted = this.state.interrupted; this.state = fold(this.log.records, this.config.autonomyLimit); this.state.limit = this.limitFromLog(); this.state.interrupted = interrupted; }
  private say(line: string): void { this.hooks.output?.(line); }
  private handle(p: Participant): string { return p === "claude" ? this.config.names.claude : p === "codex" ? this.config.names.codex : p; }

  // ---------------- messages ----------------

  /** A user message from the REPL. */
  async postUser(body: string, override?: Participant[], replyTo?: number): Promise<MessageRecord> {
    const { to, unknown } = resolveTargets("user", body, this.config.names, override);
    for (const u of unknown) this.say(`warning: unknown handle @${u}`);
    const m = this.log.append({ kind: "message", from: "user", to, body, via: "repl", ...(replyTo ? { reply_to: replyTo } : {}) });
    this.refold();
    this.releaseHeldFor(to, `user addressed ${to.join(",")}`);
    this.applyMarkerFor(m);
    this.releaseTaskHolds(m);
    this.say(this.renderMessage(m));
    await this.tick();
    return m;
  }

  /** An agent message from `post`/`reply` (idempotent by op) or a final reply. */
  async postAgent(agent: Agent, p: { op?: string; body: string; to?: Participant[]; replyTo?: number; turn?: string; via?: "post" | "reply" | "final" | "summary" }): Promise<MessageRecord> {
    if (p.op) { const key = `${agent}:${p.op}`; if (this.state.ops.has(key)) { for (const m of this.state.messages.values()) if (m.from === agent && m.op === p.op) return m; } }
    let to: Participant[] = ["user"];
    if (p.via === "summary") to = ["user"];
    else if (p.replyTo && !p.to && p.via !== "final") { const target = this.state.messages.get(p.replyTo)?.from; to = target && target !== agent ? [target] : resolveTargets(agent, p.body, this.config.names).to; }
    else to = resolveTargets(agent, p.body, this.config.names, p.to).to;
    const marker = parseMarker(p.body);
    const taskId = this.taskOf(p.body, p.replyTo, marker?.task ?? null);
    // protocol triggers: [done] reaches the peer, [blocker] reaches the claimant, [ask-user] goes to the user
    if (marker?.marker === "done" && !to.includes(peerOf(agent))) to = [...to, peerOf(agent)];
    if (marker?.marker === "blocker" && taskId) { const t = this.state.tasks.get(taskId); if (t?.claimant && t.claimant !== agent && !to.includes(t.claimant)) to = [...to, t.claimant]; }
    if (marker?.marker === "ask-user") to = ["user"];
    const peer = peerOf(agent);
    let credit = false, held = false;
    if (to.includes(peer)) {
      const t = taskId ? this.state.tasks.get(taskId) : undefined;
      if (t && (t.state === "waiting_user" || t.state === "escalated") && marker?.marker !== "ask-user") held = true;
      else if (this.state.creditsUsed < this.state.limit) credit = true;
      else held = true;
    }
    const rec: any = { kind: "message", from: agent, to, body: p.body, via: p.via ?? (p.replyTo ? "reply" : "post") };
    if (p.op) rec.op = p.op; if (p.replyTo) rec.reply_to = p.replyTo; if (p.turn) rec.turn = p.turn; if (credit) rec.credit = true; if (held) rec.held = true;
    const m = this.log.append(rec) as MessageRecord;
    if (p.replyTo && p.via !== "final") this.explicitReply[agent] = true;
    this.refold();
    this.say(this.renderMessage(m));
    if (held) this.say(`  · held for @${this.handle(peer)}: ${this.state.creditsUsed >= this.state.limit ? `budget ${this.state.creditsUsed}/${this.state.limit} used; /budget N or address @${this.handle(peer)} to release` : "task waits for the user"}`);
    this.applyMarkerFor(m, taskId);
    this.resolveAsk(m);
    if (held && this.state.creditsUsed >= this.state.limit) this.budgetSummary();
    await this.tick();
    return m;
  }

  private renderMessage(m: MessageRecord): string {
    const to = m.to.map((t) => "@" + this.handle(t)).join(" ");
    const tag = m.held ? " (held)" : "";
    return `#${m.id} ${this.handle(m.from)} → ${to}  ${clock(m.at)}  ${m.via ?? ""}${tag}\n  ${m.body.split("\n").join("\n  ")}`;
  }

  /** The task a message belongs to: the marker's #t, else the reply chain's user message, else none. */
  private taskOf(body: string, replyTo: number | undefined, explicit: number | null, author?: Participant): number | null {
    if (explicit && this.state.messages.get(explicit)?.from === "user") return explicit;
    if (author === "user") for (const m of body.matchAll(/#(\d+)\b/g)) { const id = Number(m[1]); if (this.state.tasks.has(id)) return id; }
    let cur = replyTo; const seen = new Set<number>();
    while (cur && !seen.has(cur)) { seen.add(cur); const m = this.state.messages.get(cur); if (!m) break; if (m.from === "user") return m.id; cur = m.reply_to; }
    return null;
  }

  // ---------------- protocol (§11.3) ----------------

  private applyMarkerFor(m: MessageRecord, taskId?: number | null): void {
    const marker = parseMarker(m.body);
    if (m.from === "user") {
      // a user message into a waiting or escalated task reopens it
      const t = taskId ?? this.taskOf(m.body, m.reply_to, marker?.task ?? null, "user");
      if (t) { const task = this.state.tasks.get(t); if (task && (task.state === "waiting_user" || task.state === "escalated")) { this.record(m, "reply", t, "reopened"); } }
      return;
    }
    if (!marker) return;
    const agent = m.from as Agent;
    const tid = taskId ?? this.taskOf(m.body, m.reply_to, marker.task);
    if (!tid) { this.say(`  · [${marker.marker}] without a task it resolves to; recorded as a note`); this.log.append({ kind: "note", text: `marker [${marker.marker}] in #${m.id} resolves to no task` }); return; }
    const t = this.state.tasks.get(tid);
    const st = t?.state ?? "open";
    switch (marker.marker) {
      case "criteria": this.record(m, marker.marker, tid, "criteria"); break;
      case "assumption": this.record(m, marker.marker, tid, "assumption"); break;
      case "settled": this.record(m, marker.marker, tid, "settled"); break;
      case "suggestion": this.record(m, marker.marker, tid, "suggestion"); break;
      case "ask-user": if (st !== "accepted") this.record(m, marker.marker, tid, "waiting_user"); else this.record(m, marker.marker, tid, "suggestion"); break;
      case "done": if (st === "accepted") this.record(m, marker.marker, tid, "suggestion"); else this.record(m, marker.marker, tid, "done_claimed"); break;
      case "accept": {
        if (st === "done_claimed" && t?.claimant && t.claimant !== agent) { this.record(m, marker.marker, tid, "accepted"); this.completionSummary(tid); }
        else this.record(m, marker.marker, tid, "suggestion");
        break;
      }
      case "blocker": {
        if (st === "done_claimed" && t?.claimant && t.claimant !== agent) {
          if ((t?.blockers ?? 0) < this.config.reviewRounds) this.record(m, marker.marker, tid, "blocker");
          else { this.record(m, marker.marker, tid, "escalated"); this.escalationSummary(tid); }
        } else this.record(m, marker.marker, tid, "suggestion");
        break;
      }
    }
  }
  private record(m: MessageRecord, marker: string, taskId: number, effect: string): void {
    this.log.append({ kind: "marker", message: m.id, marker, task: taskId, effect, from: m.from });
    this.refold();
    this.say(`  · [${marker}] #${taskId}: ${effect.replace("_", " ")}`);
  }
  private releaseTaskHolds(userMessage: MessageRecord): void {
    const tid = this.taskOf(userMessage.body, userMessage.reply_to, parseMarker(userMessage.body)?.task ?? null, "user");
    if (!tid) return;
    const ids: number[] = [];
    for (const a of AGENTS) for (const id of this.state.heldFor[a]) { const m = this.state.messages.get(id); if (m && this.taskOf(m.body, m.reply_to, parseMarker(m.body)?.task ?? null) === tid) ids.push(id); }
    if (ids.length) { this.log.append({ kind: "budget", event: "released", messages: ids }); this.refold(); }
  }
  private summary(body: string): void {
    this.log.append({ kind: "message", from: "chatroom", to: ["user"], body, via: "summary" });
    this.refold();
    this.say(this.renderMessage(this.state.messages.get(this.log.lastId)!));
  }
  private completionSummary(tid: number): void {
    const t = this.state.tasks.get(tid)!;
    const body = [
      `Task #${tid} accepted by @${this.handle(t.accept ? this.state.messages.get(t.accept)!.from : "chatroom")}.`,
      t.criteria ? `Criteria: #${t.criteria}. Done claim: #${t.done}. Acceptance: #${t.accept}.` : `No criteria were posted; the task was checked against #${tid}.`,
      t.assumptions.length ? `Assumptions: ${t.assumptions.map((i) => "#" + i).join(", ")}.` : "",
      t.suggestions.length ? `Suggestions: ${t.suggestions.map((i) => "#" + i).join(", ")}.` : "",
      `The result is in the ${this.handle(t.claimant ?? "claude")} worktree. To bring it in: /apply ${t.claimant ?? "claude"}`,
    ].filter(Boolean).join("\n");
    this.summary(body);
  }
  private escalationSummary(tid: number): void {
    const t = this.state.tasks.get(tid)!;
    this.summary(`Task #${tid} goes to you: ${t.blockers} blockers were raised, the cap is ${this.config.reviewRounds}. Criteria: #${t.criteria ?? "none"}; done claim: #${t.done ?? "none"}; the last blocker is recorded as a suggestion. Read the last exchange and answer with a message into the task, or /reply <id> …`);
  }
  private budgetSummary(): void {
    const waiting = AGENTS.filter((a) => this.state.heldFor[a].size > 0).map((a) => `@${this.handle(a)} has ${this.state.heldFor[a].size} held`).join("; ");
    this.summary(`Budget ${this.state.creditsUsed}/${this.state.limit} used. ${waiting}. A summary of the exchange follows once both are idle; address an agent to release its messages, or /budget N.`);
  }
  private releaseHeldFor(to: Participant[], why: string): void {
    const ids: number[] = [];
    for (const a of AGENTS) if (to.includes(a)) ids.push(...this.state.heldFor[a]);
    if (ids.length) { this.log.append({ kind: "budget", event: "released", messages: ids }); this.refold(); this.say(`  · released ${ids.length} held message(s): ${why}`); }
  }
  async setBudget(limit: number): Promise<void> {
    this.log.append({ kind: "budget", event: "limit", limit }); this.refold();
    const ids: number[] = [];
    for (const a of AGENTS) for (const id of [...this.state.heldFor[a]].sort((x, y) => x - y)) if (this.state.creditsUsed + ids.length < limit) ids.push(id);
    if (ids.length) { this.log.append({ kind: "budget", event: "released", messages: ids }); this.refold(); }
    await this.tick();
  }

  // ---------------- scheduler (§7) ----------------

  private batchFor(a: Agent): number[] {
    const ids = [...this.state.messages.keys()].sort((x, y) => x - y);
    const unread = (id: number) => { const m = this.state.messages.get(id)!; return m.from !== a && !this.state.received[a].has(id) && !this.state.retracted[a].has(id) && !this.state.heldFor[a].has(id) && !this.pendingHook[a].includes(id); };
    const triggers = ids.filter((id) => unread(id) && this.state.messages.get(id)!.to.includes(a));
    if (triggers.length === 0) return [];
    const newest = triggers[triggers.length - 1]!;
    return ids.filter((id) => id <= newest && unread(id)).slice(-64);
  }
  async tick(): Promise<void> {
    await Promise.all(AGENTS.map((a) => this.tickAgent(a)));
    await this.maybeSummary();
  }
  /** When an exchange between the agents has paused, ask the last speaker for one message to the user. */
  private async maybeSummary(): Promise<void> {
    const x = this.state.exchange;
    if (x.summaryRequested || x.summaryPosted || !x.lastSpeaker) return;
    if (AGENTS.some((a) => this.state.turns[a] || this.starting[a] || this.batchFor(a).length > 0)) return;
    const reason = x.held ? "the autonomy budget is used up and a message to the other agent is being held" : x.agentMessages >= 3 ? "you and the other agent have both gone idle" : null;
    if (!reason) return;
    const a = x.lastSpeaker;
    const text = `[chatroom] The exchange has paused: ${reason}. Post one message to @user, at most eight lines, with: what was done and where (files, branch); what you two agreed; what is still open; what you need from the user, if anything. No mentions of the other agent. Then end with [silent].`;
    await this.startTurn(a, [], text, "summary");
  }
  private async tickAgent(a: Agent): Promise<void> {
    if (this.starting[a]) return;
    const batch = this.batchFor(a);
    if (batch.length === 0) return;
    const turn = this.state.turns[a];
    if (!turn) { await this.startTurn(a, batch); return; }
    const d = this.drivers[a];
    if (d.capabilities.nativeSteering) {
      const ok = await d.steer(this.deliveryText(a, batch));
      if (ok) { this.log.append({ kind: "turn", agent: a, turn: turn.id, event: "delivered", inputs: batch }); this.refold(); this.say(`  · steered ${batch.length} message(s) into @${this.handle(a)}'s turn`); }
    } else if (d.capabilities.hookDelivery) {
      this.pendingHook[a].push(...batch);
      await d.deliverViaHook(turn.id, this.deliveryText(a, batch), batch);
      this.say(`  · ${batch.length} message(s) waiting for @${this.handle(a)}'s next tool call`);
    }
  }
  private deliveryText(a: Agent, batch: number[], recovery?: string): string {
    const ctx = this.hooks.context?.(a);
    return formatDelivery({ agent: a, names: this.config.names, messages: batch.map((id) => this.state.messages.get(id)!), workspace: ctx?.workspace, peerChanges: ctx?.peerChanges, tasks: this.tasksLine(a), recovery });
  }
  tasksLine(a: Agent): string | undefined {
    const parts: string[] = [];
    for (const t of this.state.tasks.values()) {
      if (t.state === "accepted") continue;
      const touches = t.lead === a || t.claimant === a || (this.state.messages.get(t.id)?.to ?? []).includes(a);
      if (!touches) continue;
      parts.push(`#${t.id} ${t.state.replace("_", " ")}${t.criteria ? ` · criteria #${t.criteria}` : ""} · blockers ${t.blockers}/${this.config.reviewRounds}${t.questions.length ? ` · waiting: #${t.questions[t.questions.length - 1]}` : ""}`);
    }
    return parts.length ? parts.join(" | ") : undefined;
  }

  /** Connect a driver to its session (resuming the recorded id) once per process. */
  async ensureConnected(a: Agent): Promise<void> {
    if (this.connected[a]) return;
    if (this.connecting[a]) return this.connecting[a]!;
    this.connecting[a] = (async () => {
      const wanted = this.state.sessions[a].id;
      const spec = this.hooks.session?.(a) ?? { cwd: process.cwd(), brief: "" };
      const res = await this.drivers[a].connect({ id: wanted, cwd: spec.cwd, brief: spec.brief });
      this.connected[a] = true;
      const event = res.resumed ? "resumed" : (wanted ? "rebuilt" : "started");
      this.log.append({ kind: "session", agent: a, event, session: res.sessionId });
      this.refold();
    })();
    try { await this.connecting[a]; } finally { this.connecting[a] = null; }
  }
  /** Connect both drivers now, so the status bar reports before the first turn; no model call is made. */
  async warm(): Promise<void> {
    for (const a of AGENTS) { try { await this.ensureConnected(a); } catch (e) { this.say(`  · ${this.handle(a)} could not connect: ${String(e)}`); } }
  }
  private async startTurn(a: Agent, batch: number[], extraText?: string, reason?: string): Promise<void> {
    this.starting[a] = true;
    try {
      const d = this.drivers[a];
      const interrupted = this.state.interrupted[a];
      let recovery: string | undefined;
      if (this.reconnect[a] && this.connected[a]) { await this.drivers[a].close(); this.connected[a] = false; }   // a /model or /effort change: resume the session with the new flags
      this.reconnect[a] = false;
      await this.ensureConnected(a);
      if (interrupted) {
        recovery = `[chatroom] Recovery note: your previous turn ${interrupted.id} was interrupted (messages ${interrupted.inputs.map((i) => "#" + i).join(", ")} had reached you). Inspect the worktree before repeating commands or edits.`;
        this.state.interrupted[a] = null;
      }
      const id = `t-${String(this.state.turnCount + 1).padStart(4, "0")}`;
      this.log.append({ kind: "turn", agent: a, turn: id, event: "started", inputs: batch, ...(reason ? { reason } : {}) });
      this.explicitReply[a] = false;
      this.refold();
      this.say(reason === "summary" ? `  · @${this.handle(a)} is asked to summarize the exchange for you` : `  · @${this.handle(a)} starts turn ${id} with ${batch.length} message(s)`);
      const input = batch.length ? this.deliveryText(a, batch, recovery) : [recovery, extraText].filter(Boolean).join("\n\n");
      try { await d.startTurn(id, input); }
      catch (e) {
        this.log.append({ kind: "turn", agent: a, turn: id, event: "failed", reason: `start: ${String(e)}` });
        this.refold();
        this.say(`  · @${this.handle(a)} turn ${id} failed to start: ${String(e)}`);
      }
    } finally { this.starting[a] = false; }
  }

  // ---------------- driver events ----------------

  private async onDriverEvent(a: Agent, e: DriverEvent): Promise<void> {
    const turn = this.state.turns[a];
    switch (e.type) {
      case "text": this.say(`    · ${this.handle(a)}: ${e.text.split("\n")[0]?.slice(0, 160)}`); break;
      case "reasoning": this.say(`    · ${this.handle(a)} thinks: ${e.text.split("\n")[0]?.slice(0, 160)}`); break;
      case "tool": this.say(`    · ${this.handle(a)}: ${e.name} ${summarizeInput(e.input)}`); break;
      case "tool_result": if (e.error) this.say(`    · ${this.handle(a)}: ${e.text.split("\n")[0]?.slice(0, 160)}`); break;
      case "review": this.say(`    · ${this.handle(a)} ✓ ${e.text.slice(0, 200)}`); break;
      case "prompt": this.log.append({ kind: "permission", agent: a, prompt: e.id, event: "asked", summary: e.summary, request: e.request }); this.refold(); this.hooks.prompt?.(a, e.id, e.summary); break;
      case "status": {
        const cur = this.state.status[a]; const changed: any = {};
        for (const k of ["model", "effort", "cwd", "contextTokens", "contextWindow"] as const) if (e.status[k] !== undefined && e.status[k] !== cur[k]) changed[k] = e.status[k];
        if (Object.keys(changed).length) { this.log.append({ kind: "status", agent: a, ...changed }); this.refold(); this.hooks.status?.(); }
        break;
      }
      case "final": await this.endTurn(a, e.text, e.cost); break;
      case "error": this.say(`    · ${this.handle(a)} error: ${e.message}`); if (turn) { this.log.append({ kind: "turn", agent: a, turn: turn.id, event: "failed", reason: e.message }); this.returnPendingHook(a); this.refold(); await this.tick(); } break;
      case "exit": this.connected[a] = false; if (turn) { this.log.append({ kind: "turn", agent: a, turn: turn.id, event: "failed", reason: `driver exited ${e.code ?? e.signal}` }); this.returnPendingHook(a); this.log.append({ kind: "session", agent: a, event: "closed" }); this.refold(); await this.tick(); } break;
    }
  }
  private returnPendingHook(a: Agent): void {
    if (this.pendingHook[a].length) { this.log.append({ kind: "turn", agent: a, turn: this.state.turns[a]?.id ?? "?", event: "released", inputs: this.pendingHook[a] }); this.pendingHook[a] = []; }
  }
  /** A status report that did not come through the driver's event stream (the hook's effort and cwd). */
  reportStatus(a: Agent, status: Partial<Status>): void {
    const cur = this.state.status[a]; const changed: any = {};
    for (const k of ["model", "effort", "cwd", "contextTokens", "contextWindow"] as const) if (status[k] !== undefined && status[k] !== cur[k]) changed[k] = status[k];
    if (Object.keys(changed).length) { this.log.append({ kind: "status", agent: a, ...changed }); this.refold(); this.hooks.status?.(); }
  }
  /** `chatroom hook`/`inbox` acknowledged a delivery: those messages now count as received. */
  async ackDelivery(a: Agent, ids: number[]): Promise<void> {
    const turn = this.state.turns[a]; if (!turn || ids.length === 0) return;
    const known = ids.filter((i) => this.pendingHook[a].includes(i));
    if (known.length === 0) return;
    this.pendingHook[a] = this.pendingHook[a].filter((i) => !known.includes(i));
    this.log.append({ kind: "turn", agent: a, turn: turn.id, event: "acked", inputs: known }); this.refold();
  }
  private async endTurn(a: Agent, text: string, cost: unknown): Promise<void> {
    const turn = this.state.turns[a]; if (!turn) return;
    const body = text.trim();
    let finalId: number | undefined;
    if (body && body !== "[silent]") {
      const newest = turn.inputs.length ? Math.max(...turn.inputs) : undefined;
      const isSummary = turn.inputs.length === 0 && this.log.records.some((r) => r.kind === "turn" && r.turn === turn.id && r.event === "started" && r.reason === "summary");
      const m = await this.postAgentNoTick(a, { body, via: isSummary ? "summary" : "final", turn: turn.id, replyTo: this.explicitReply[a] ? undefined : newest });
      finalId = m.id;
    }
    this.returnPendingHook(a);
    const rec: any = { kind: "turn", agent: a, turn: turn.id, event: "ended" }; if (finalId) rec.final = finalId; if (cost !== undefined) rec.cost = cost;
    this.log.append(rec); this.refold();
    this.say(`  · @${this.handle(a)} ended turn ${turn.id}`);
    await this.hooks.afterTurn?.(a);
    await this.tick();
  }
  private async postAgentNoTick(a: Agent, p: { body: string; via: "final" | "summary"; turn: string; replyTo?: number | undefined }): Promise<MessageRecord> {
    // same as postAgent but without scheduling; the caller ticks after the turn record
    const saved = this.tick; this.tick = async () => {}; try { return await this.postAgent(a, { body: p.body, via: p.via, turn: p.turn, ...(p.replyTo ? { replyTo: p.replyTo } : {}) }); } finally { this.tick = saved; }
  }

  // ---------------- prompts, ask, stop ----------------

  async answerPrompt(id: string, decision: "allow" | "deny", reason?: string): Promise<boolean> {
    const p = this.state.prompts.get(id); if (!p) return false;
    await this.drivers[p.agent].answerPrompt(id, decision, reason);
    this.log.append({ kind: "permission", agent: p.agent, prompt: id, event: "answered", decision, ...(reason ? { reason } : {}) }); this.refold();
    return true;
  }
  /** `ask`: wait for an answer to message `question` up to the configured timeout. */
  waitForAnswer(question: number, agent: Agent, timeoutMs: number): Promise<{ status: "answered" | "probable" | "indeterminate"; message?: MessageRecord }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.askWaiters.delete(question); resolve({ status: "indeterminate" }); }, timeoutMs);
      this.askWaiters.set(question, { agent, resolve: (r) => { clearTimeout(timer); this.askWaiters.delete(question); resolve(r as any); } });
    });
  }
  private resolveAsk(m: MessageRecord): void {
    for (const [q, w] of this.askWaiters) {
      const question = this.state.messages.get(q); if (!question) continue;
      if (m.reply_to === q) { w.resolve({ status: "answered", message: m }); continue; }
      if (question.to.includes(m.from) && m.to.includes(w.agent) && m.id > q) w.resolve({ status: "probable", message: m });
    }
  }
  async stop(a: Agent): Promise<void> {
    const turn = this.state.turns[a]; if (!turn) return;
    await this.drivers[a].interrupt();
  }
  /** Esc: interrupt every active turn. A user message no agent has read yet is withdrawn and returned for
   *  editing; any other unread message is held until the user's next message to that agent, so nothing
   *  restarts on its own. Returns the withdrawn message body when there is one to edit. */
  async interruptByUser(): Promise<string | null> {
    const active = AGENTS.filter((a) => this.state.turns[a] || this.starting[a]);
    const retracted: { message: number; from: Agent[] }[] = []; const held: { message: number; for: Agent[] }[] = [];
    for (const m of this.state.messages.values()) {
      const unread = m.to.filter((t): t is Agent => (t === "claude" || t === "codex") && t !== m.from && !this.state.received[t].has(m.id) && !this.state.retracted[t].has(m.id) && !this.state.heldFor[t].has(m.id));
      if (unread.length === 0) continue;
      if (m.from === "user") retracted.push({ message: m.id, from: unread }); else held.push({ message: m.id, for: unread });
    }
    if (active.length === 0 && retracted.length === 0 && held.length === 0) return null;
    this.log.append({ kind: "interrupt", retracted, held }); this.refold();
    for (const a of AGENTS) { this.pendingHook[a] = []; this.drivers[a].dropDeliveries?.(); }
    for (const a of active) await this.stop(a);
    const last = [...this.state.messages.values()].filter((m) => m.from === "user").at(-1);
    const back = last && retracted.find((r) => r.message === last.id && r.from.length === last.to.filter((t) => t !== "user").length) ? last : null;
    const parts = [active.length ? `interrupted ${active.map((a) => "@" + this.handle(a)).join(" and ")}` : "nothing was running"];
    if (back) parts.push(`#${back.id} had not been read and is back in the input box`);
    for (const r of retracted) if (r.message !== back?.id) parts.push(`#${r.message} withdrawn from ${r.from.map((a) => "@" + this.handle(a)).join(" and ")}`);
    if (held.length) parts.push(`${held.length} unread message(s) held until your next message`);
    this.say(`  · ${parts.join("; ")}`);
    return back ? back.body : null;
  }
  /** /model and /effort: record the choice, hand it to the driver, and apply it from the next turn. */
  async setOverride(a: Agent, patch: { model?: string | null; effort?: string | null }): Promise<string> {
    this.log.append({ kind: "config", agent: a, ...patch }); this.refold();
    let needs = false;
    if (patch.model !== undefined) needs = this.drivers[a].setModel(patch.model) || needs;
    if (patch.effort !== undefined) needs = this.drivers[a].setEffort(patch.effort) || needs;
    const what = Object.entries(patch).map(([k, v]) => `${k} ${v ?? "default"}`).join(", ");
    let when = "from the next turn";
    if (needs) {
      if (this.connected[a] && !this.state.turns[a] && !this.starting[a]) { await this.drivers[a].close(); this.connected[a] = false; when = "from the next turn, the session is resumed with it"; }
      else if (this.connected[a]) { this.reconnect[a] = true; when = "after the current turn, the session is then resumed with it"; }
    }
    const line = `@${this.handle(a)}: ${what}, ${when}`;
    this.say(`  · ${line}`);
    return line;
  }
  async close(): Promise<void> { for (const a of AGENTS) await this.drivers[a].close(); }
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") { const o = input as Record<string, unknown>; const v = o["command"] ?? o["file_path"] ?? o["path"] ?? o["pattern"] ?? o["query"] ?? ""; return String(v).split("\n")[0]?.slice(0, 120) ?? ""; }
  return "";
}

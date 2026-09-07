// A driver for tests: records what it was asked, emits what the test decides.
import type { Agent } from "./log.ts";
import type { Capabilities, Driver, DriverEvent, SessionSpec } from "./types.ts";

export class FakeDriver implements Driver {
  readonly agent: Agent;
  capabilities: Capabilities;
  turns: { turn: string; input: string }[] = [];
  steers: string[] = [];
  hooks: { turn: string; input: string; ids: number[] }[] = [];
  prompts: { id: string; decision: string; reason?: string | undefined }[] = [];
  connects: SessionSpec[] = [];
  acceptSteer = true;
  failResume = false;
  interrupted = 0;
  private handler: ((e: DriverEvent) => void) | null = null;
  constructor(agent: Agent, caps: Partial<Capabilities> = {}) {
    this.agent = agent;
    this.capabilities = { nativeSteering: agent === "codex", hookDelivery: agent === "claude", interrupt: true, hostPrompts: true, nativeCommit: true, ...caps };
  }
  async connect(session: SessionSpec) { this.connects.push(session); const resumed = session.id !== null && !this.failResume; return { sessionId: resumed ? session.id! : `s-${this.agent}-${this.connects.length}`, resumed }; }
  async startTurn(turn: string, input: string) { this.turns.push({ turn, input }); }
  async steer(input: string) { this.steers.push(input); return this.acceptSteer; }
  async deliverViaHook(turn: string, input: string, ids: number[]) { this.hooks.push({ turn, input, ids }); }
  async answerPrompt(id: string, decision: "allow" | "deny", reason?: string) { this.prompts.push({ id, decision, reason }); }
  async interrupt() { this.interrupted++; }
  onEvent(h: (e: DriverEvent) => void) { this.handler = h; }
  async close() {}
  emit(e: DriverEvent) { this.handler?.(e); }
  final(text: string) { this.emit({ type: "final", text }); }
  get lastTurn() { return this.turns[this.turns.length - 1]!; }
}

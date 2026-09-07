// Shared types between the room, the drivers and the REPL (§9.1).
import type { Agent } from "./log.ts";

export interface Capabilities {
  nativeSteering: boolean;   // input accepted into a running turn (Codex app-server)
  hookDelivery: boolean;     // hook injection (Claude)
  interrupt: boolean;
  hostPrompts: boolean;      // prompts the harness cannot settle reach the REPL
  nativeCommit: boolean;     // doctor: a native commit lands on the own branch only
}
export interface Status { model: string | null; effort: string | null; cwd: string | null; contextTokens: number | null; contextWindow: number | null }

export type DriverEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; text: string; error?: boolean }
  | { type: "prompt"; id: string; summary: string; request: unknown }
  | { type: "review"; text: string }                        // Auto-review decision, as evidence
  | { type: "status"; status: Partial<Status> }
  | { type: "final"; text: string; cost?: unknown }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

export interface SessionSpec { id: string | null; cwd: string; brief: string }

export interface Driver {
  readonly agent: Agent;
  readonly capabilities: Capabilities;
  connect(session: SessionSpec): Promise<{ sessionId: string; resumed: boolean }>;
  startTurn(turnId: string, input: string): Promise<void>;
  steer(input: string): Promise<boolean>;
  deliverViaHook(turnId: string, input: string, messageIds: number[]): Promise<void>;
  answerPrompt(id: string, decision: "allow" | "deny", reason?: string): Promise<void>;
  interrupt(): Promise<void>;
  onEvent(handler: (event: DriverEvent) => void): void;
  close(): Promise<void>;
}

export interface Config {
  autonomyLimit: number;          // autonomy.limit
  askTimeoutSeconds: number;      // ask.timeout_seconds
  reviewRounds: number;           // task.review_rounds
  names: { claude: string; codex: string };
  claudeModel: string | null; codexModel: string | null; claudeEffort: string | null; codexEffort: string | null;
  gitBinary: string | null;
  extraWriteRoots: string[];
  envAllow: string[];
  statusBar: boolean;
  briefExtra: string;
}
export const CONFIG_DEFAULTS: Config = {
  autonomyLimit: 6, askTimeoutSeconds: 60, reviewRounds: 2, names: { claude: "clara", codex: "phil" },
  claudeModel: null, codexModel: null, claudeEffort: null, codexEffort: null, gitBinary: null,
  extraWriteRoots: [], envAllow: [], statusBar: true, briefExtra: "",
};

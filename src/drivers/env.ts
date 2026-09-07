// The environment an agent process receives (ARCHITECTURE.md §8.1): the user's, minus
// credential-shaped names, plus the CHATROOM_* variables.
const DENY = ["*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*", "*PASSWD*", "*CREDENTIAL*", "AWS_*", "GOOGLE_APPLICATION_CREDENTIALS", "GH_*", "GITHUB_*", "NPM_CONFIG_*AUTH*", "OPENAI_*", "ANTHROPIC_*"];
const toRe = (glob: string) => new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
const DENY_RE = DENY.map(toRe);
// This process's own Claude Code variables must not leak into a nested agent.
const OWN_RE = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^CLAUDE_PID$/, /^CLAUDE_EFFORT$/, /^CLAUDE_CONFIG_DIR$/];

export function scrubEnv(base: NodeJS.ProcessEnv, allow: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (allow.includes(k)) { out[k] = v; continue; }
    if (DENY_RE.some((re) => re.test(k)) || OWN_RE.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

export interface AgentVars { agent: "claude" | "codex"; handle: string; conversation: string; drop: string; deliveries: string; receipts: string; scratch: string; bin: string; askTimeoutSeconds: number }
export function agentVars(v: AgentVars): Record<string, string> {
  return {
    CHATROOM_AGENT: v.agent, CHATROOM_HANDLE: v.handle, CHATROOM_CONVERSATION: v.conversation,
    CHATROOM_OPERATION_DIR: v.drop, CHATROOM_DELIVERY_DIR: v.deliveries, CHATROOM_RECEIPT_DIR: v.receipts, CHATROOM_SCRATCH: v.scratch,
    CHATROOM_BIN: v.bin, CHATROOM_ASK_TIMEOUT: String(v.askTimeoutSeconds), TMPDIR: v.scratch, GIT_OPTIONAL_LOCKS: "0",
  };
}

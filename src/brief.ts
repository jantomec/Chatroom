// The brief the agents receive on every process start, the delivery format, and the
// mention and marker parsing that both the room and the agent commands share (§6, §11).
import type { Agent, MessageRecord, Participant } from "./log.ts";

export interface Names { claude: string; codex: string }   // handles, e.g. clara, phil
export const NAMES_DEFAULT: Names = { claude: "clara", codex: "phil" };
export const DISPLAY: Record<Agent, string> = { claude: "Clara", codex: "Phil" };

export function handleOf(p: Participant, names: Names): string {
  return p === "claude" ? names.claude : p === "codex" ? names.codex : p;
}
export function participantOf(handle: string, names: Names): Participant | "all" | null {
  const h = handle.toLowerCase();
  if (h === "user") return "user";
  if (h === "all") return "all";
  if (h === names.claude.toLowerCase()) return "claude";
  if (h === names.codex.toLowerCase()) return "codex";
  return null;
}

/** Mentions outside inline and fenced code, at word boundaries, case-insensitive. */
export function mentions(body: string, names: Names): { targets: Set<Participant | "all">; unknown: string[] } {
  const stripped = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const targets = new Set<Participant | "all">(); const unknown: string[] = [];
  for (const m of stripped.matchAll(/(^|[^\w@])@([A-Za-z][\w-]*)/g)) {
    const p = participantOf(m[2]!, names);
    if (p) targets.add(p); else unknown.push(m[2]!);
  }
  return { targets, unknown };
}

/** Resolve targets per the table in §6. */
export function resolveTargets(author: Participant, body: string, names: Names, override?: Participant[]): { to: Participant[]; unknown: string[] } {
  if (override && override.length > 0) return { to: override.filter((p) => p !== author), unknown: [] };
  const { targets, unknown } = mentions(body, names);
  const others = (["user", "claude", "codex"] as Participant[]).filter((p) => p !== author);
  if (targets.has("all")) return { to: others, unknown };
  const named = others.filter((p) => targets.has(p));
  if (named.length > 0) return { to: named, unknown };
  if (author === "user") return { to: ["claude", "codex"], unknown };
  return { to: ["user"], unknown };
}

export const MARKERS = ["criteria", "assumption", "settled", "done", "accept", "blocker", "suggestion", "ask-user"] as const;
export type Marker = (typeof MARKERS)[number];
/** A message may begin with one marker in square brackets, optionally followed by #<task>. */
export function parseMarker(body: string): { marker: Marker; task: number | null } | null {
  const m = /^\s*\[(criteria|assumption|settled|done|accept|blocker|suggestion|ask-user)\]\s*(?:#(\d+))?/i.exec(body);
  if (!m) return null;
  return { marker: m[1]!.toLowerCase() as Marker, task: m[2] ? Number(m[2]) : null };
}

export interface BriefParams {
  agent: Agent; names: Names; myWorktree: string; peerWorktree: string; mainTree: string; myBranch: string;
  nativeCommit: boolean; extra?: string;
}

export function brief(p: BriefParams): string {
  const me = p.names[p.agent]; const other = p.agent === "claude" ? "codex" : "claude";
  const otherHandle = p.names[other];
  const commitNote = p.nativeCommit
    ? "Commit on it if and when you like; Chatroom snapshots uncommitted work when it integrates. A `packed-refs.lock` error from `git commit` is harmless."
    : "Committing is unavailable in this session; Chatroom snapshots your work when it integrates.";
  let text = `You are ${DISPLAY[p.agent]}, @${me} in a project chat with @user and ${DISPLAY[other]}, @${otherHandle}. Solve the
user's task together. Everything posted is visible to all three of you.

Coordination
- On a task sent to both agents, immediately claim a concrete, non-overlapping part:
  "$CHATROOM_BIN" post "@${otherHandle} I'll take …". Resolve overlaps in the chat, then work.
- Mention @${otherHandle} only when you intend to activate them. A message without mentions goes
  to the user.
- "$CHATROOM_BIN" reply <id> "…" answers a specific message. "$CHATROOM_BIN" ask "@${otherHandle} …"
  waits briefly for an answer; continue after its timeout.
- New messages reach you after tool calls, marked [chatroom]. Read them before your next
  step. "$CHATROOM_BIN" inbox shows them on demand.
- Your final response is also posted. If your posts already said everything, end with [silent].
- Keep chat messages short; code and detailed results belong in the worktree.

Working together
- Decide implementation details between yourselves: naming, file layout, test structure,
  libraries the project already uses, and any ambiguity that has a reasonable default. Take
  the default and post one line: "[assumption] …". Do not ask the user about these.
- When you disagree, each of you argues the point once, with evidence: a measurement, a
  failing case, a quoted source. If you still disagree, the one who raised it posts
  "[ask-user]" with both options and a recommendation, and you both move on to other work
  until the user answers.
- Record decisions you agree on as "[settled] …" and do not reopen them. If you later think
  a settled decision is wrong, say so once, in one line, and continue under it.
- Do not take a claim on trust because the other agent made it; ask for the evidence, and
  give yours unasked. Disagreement stated plainly is useful. Agreement stated to be
  agreeable is noise, and so is praise.

Finishing
- When you claim a task, post "[criteria] #<task>" with three to seven numbered, checkable
  statements of what done means. When you receive criteria, check them against what the
  user asked: if they miss part of the request, or a statement cannot be verified, amend
  them, once. After that the criteria stand; the user may amend at any time.
- When you believe the criteria are met, post "[done] #<task>" and say, per criterion, how
  you verified it: the command you ran and what it showed.
- Checking the other's work means verifying the criteria yourself, not reading the claim.
  Read the diff. Run what can be run: read-only checks in the other's worktree, or merge
  their branch into your own worktree, which is allowed, and run the suite there. Then
  answer with evidence either way. "[accept]" lists each criterion and how you verified
  it. "[blocker]" names the criterion that fails, shows the failing case, and proposes a
  fix. Agreeing without checking and objecting without a failing case are the same
  failure; an accept without evidence does not count and a blocker without a failing case
  is a suggestion.
- Everything that is not a failed criterion is "[suggestion]", which never reopens the
  work. A working result that meets the criteria beats a better one that does not exist.
  A task allows two blockers; after that the chatroom hands it to the user. Do not keep
  improving past that.

Escalating
- Bring to the user only: behaviour the user will see that the task does not imply;
  interface, dependency or scope changes beyond the ask; anything irreversible;
  conflicting instructions; a disagreement that survived two exchanges. Post "[ask-user]"
  with the question, the options and your recommendation, in at most five lines, then
  work on something else.

Workspace
- Write only in ${p.myWorktree} and the per-turn scratch directory.
- Read ${p.peerWorktree} and the user's main tree ${p.mainTree} when useful; never write there,
  and do not run git commands that modify them. Either may be mid-edit; the chat is where
  intent is stated.
- Do not read ~/.claude or ~/.codex; they hold other projects' sessions.
- Your branch is ${p.myBranch}. ${commitNote} You may merge the other agent's branch into
  your own branch to verify their work. Never modify, merge into, rebase or reset the
  other agent's branch, main, integration, or any other ref; the user runs integration.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.`;
  if (p.extra && p.extra.trim()) text += `\n\nProject guidance (from chatroom config, brief.extra)\n${p.extra.trim().slice(0, 8000)}`;
  return text;
}

export interface DeliveryContext {
  agent: Agent; names: Names; messages: MessageRecord[];
  workspace?: { own: string; integration: string; peer: string; main: string } | undefined;
  peerChanges?: string[] | undefined;
  tasks?: string | undefined;        // the tasks line, already formatted
  recovery?: string | undefined;     // a recovery note, if any
}

const hhmmss = (iso: string) => iso.slice(11, 19);

/** The delivery format of §11.1: readable records, a header that repeats the rules. */
export function formatDelivery(c: DeliveryContext): string {
  const me = c.names[c.agent];
  const n = c.messages.length;
  const lines: string[] = [];
  lines.push(`[chatroom] You are @${me}. ${n} new message${n === 1 ? "" : "s"}. Act on those addressed to you; read the rest as context.`);
  lines.push(`Speak with "$CHATROOM_BIN" post "..."; ask with "$CHATROOM_BIN" ask "..."; reply exactly [silent] if your posts said everything.`);
  if (c.recovery) { lines.push(""); lines.push(c.recovery); }
  for (const m of c.messages) {
    const to = m.to.map((t) => "@" + handleOf(t, c.names)).join(" ");
    const reply = m.reply_to ? ` · reply to #${m.reply_to}` : "";
    lines.push("");
    lines.push(`--- #${m.id} · ${handleOf(m.from, c.names)} → ${to} · ${hhmmss(m.at)}${reply}`);
    lines.push(m.body);
  }
  lines.push("");
  if (c.workspace) lines.push(`workspace: own=${c.workspace.own} integration=${c.workspace.integration} peer=${c.workspace.peer} main=${c.workspace.main}`);
  if (c.peerChanges && c.peerChanges.length) lines.push(`peer changes since your previous input: ${c.peerChanges.join(", ")}`);
  if (c.tasks) lines.push(`tasks: ${c.tasks}`);
  return lines.join("\n").trimEnd() + "\n";
}

# Chatroom Architecture v9

Status: implementation baseline, 2026-09-05. Standalone; supersedes `ARCHITECTURE.md` (v1)
and `ARCHITECTURE_V2.md` through `ARCHITECTURE_V8.md`. v8 is kept in `history/` as the
hardened design; any of its mechanisms can be reintroduced independently if the posture
below ever changes. No code exists yet. Implementation starts with Phase 0 (§22).

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0,
git 2.54.0 (Homebrew) and 2.50.1 (Apple), both on `PATH`.

How to read this document:

- **Comment** blocks explain why a decision stands.
- **Guard** blocks mark decisions that a later revision must not reverse without the user's
  explicit approval, each citing a user decision, a measurement on this machine, or a quoted
  documentation sentence. Section 0.1 indexes them; section 0.2 lists the guards retired
  with the posture change so they are not reintroduced by accident.
- **Proposed** marks items the user has not explicitly decided.

---

## 0. Posture and changes from v8

### 0.0 The posture: parity

An agent inside the chatroom has the same capabilities and the same risks as the same
harness run by the user directly in the same repository: Claude Code in auto mode, Codex
with Auto-review, the user's own customization, tools and network. The chatroom adds only
what is needed so that two agents and an orchestrator can share one repository without
corrupting each other's work or the user's tree. Everything else that v4 through v8 added
in the name of a hardened posture is removed.

Three things change when two agents share a repository, and each has a proportionate rule:

1. **Two writers corrupt each other.** Each agent writes only its own worktree. This rule is
   hard: both sandboxes bound shell writes to the working directory by default, and two
   permission rules bound Claude's native edits.
2. **A third party merges.** The orchestrator snapshots, integrates, syncs and applies with
   pinned git invocations and explicit paths, records what it expects each of its refs to
   be, and refuses to run over a state it did not expect.
3. **One model's output is the other's input.** The autonomy budget and the "claim before
   build" norm bound the loop.

> **Guard G0.** The posture is parity with solo use. A revision or review that wants a
> stricter boundary than the user runs daily must argue a coordination failure or data loss
> inside the parity model, not a different threat model. The user chose this on 2026-09-05
> after the review loop of v4 to v8 had added a mechanism per round to keep a hardened
> posture self-consistent.

### 0.1 Guards kept

| Guard | Decision | Evidence |
|---|---|---|
| G0 | Parity posture, above. | User decision. |
| G1 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; SDK docs: "Anthropic does not allow third party developers to offer claude.ai login … including agents built on the Claude Agent SDK." |
| G2 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G3 | Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, falling back to the user visibly. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G4 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: "queued messages … process sequentially"; `additionalContext` "appended to the tool result". |
| G7 | Worktrees and IPC live outside the main tree, because Claude permission rules are deny-wins and the main-tree Edit deny would cover a nested worktree. | Claude permissions docs. |
| G8 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G9 | No commit norms. Agents may commit on their own branch with native git, or not. | User decision. |
| G10 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G11 | When both agents answer at once, both replies are recorded. | User decision. |
| G12 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G13 | `/apply` and `/sync` are native `git merge` operations with the pinned invocation of §16.0, explicit paths, Chatroom's own collision preflight, and an abort that refuses when the index changed after the merge. | Measured, §19. |
| G14 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency. |
| G16 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex sandbox denies Unix-socket connections. |
| G17 | Zero footprint in tracked files, CLAUDE.md, AGENTS.md, `.claude/`, `.codex/`, `.gitignore`. | User decision. |
| G18 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | Both harnesses persist turns incrementally. |
| G19 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry. |
| G20 | First-release cut line: Phase 0, phases 1 to 5. | Scope control. |
| G23 | `.chatroom/` lives in the main worktree resolved from the common git directory; the lock in the runtime root. | `git rev-parse --show-toplevel` differs per linked worktree. |
| G26 | The git binary is resolved once at startup, recorded, and used by path. | Two binaries on this machine. |
| G27 | Every orchestrator git mutation is an intent row with oids; startup classifies by comparing refs. | Codex reviews of v6 and v7. |
| G29 | The orchestrator's git never discovers a repository; every command carries recorded absolute paths. | Measured: a rewritten `.git` pointer redirects discovery; explicit paths ignore it. Kept because it costs nothing. |

### 0.2 Guards retired with the posture

| Retired | Was | Why it goes |
|---|---|---|
| G5, G6 | Native tools stay, reads denylisted with per-surface levels | Native tools stay trivially; reads are as in solo use. The secret-path denylist survives as a plain config default. |
| G15 | Three modes | One posture. |
| G21 | Shared git directory read-only; commit broker | Agents commit natively on their own branch, as Claude does for the user today. Other refs are protected by detection and the reflog, as in solo use. |
| G22 | Environment scrubbing as a guarantee | Survives as a config default, not a probed guarantee. |
| G24, G25 | MCP, apps, browser, web tools, nested agents disabled; strict network allowlist | The user's customization loads as in solo use. |
| G28, G31 | Backup ref, two-state abort, own collision preflight as a guarantee | Abort refuses on a changed index, which covers the one measured data-loss case; the collision preflight stays as a check. |
| G30 | `gitWrites` enforced or refuse; detached checkout | No git write scope to enforce. |

### 0.3 What this removes from v8

The commit broker, pointer verification, the detached checkout, the git write scope,
the three modes, the twelve guarantee levels and their probes, MCP, web, browser and
subagent disabling, strict network allowlisting, escalation proofs, the backup ref, the
`apply_paths` table and the two-state abort, and the auto-review escalation policy.
Roughly half of v8.

---

## 1. Purpose

Chatroom is a terminal group chat with three participants: the user; Claude, through the
Claude Code CLI in auto mode; Codex, through the Codex App Server with Auto-review, with the
Codex CLI as fallback. All participants see every message. Addressing says who is expected
to act. Claude and Codex work concurrently in their own worktrees, coordinate through the
chat while working, and inspect one another's work and the user's main tree.

`chatroom` is one globally installed command. A repository opts in when the command is run
inside it. Chatroom keeps its authority under `.chatroom/` in the main worktree, agent
runtime data under the platform's per-user state directory, and Chatroom-owned refs and
worktrees. It does not change tracked files, `CLAUDE.md`, `AGENTS.md`, `.claude/`,
`.codex/` or `.gitignore`.

### 1.1 Non-goals for the first release

More than two agents; a full-screen interface; remote rooms; exactly-once tool execution;
isolation from a hostile local process; native Windows; source review, checkpoints,
archive and `gc`; resolving sync conflicts in place.

---

## 2. Principles

1. **One durable authority.** SQLite wins over any derived file.
2. **One database writer.**
3. **Monotonic room order.**
4. **At-least-once transport, idempotent acceptance.**
5. **No state rollback.** Recovery moves forward from durable facts.
6. **No orchestrator writes under agent control.**
7. **A message is durable before it is visible.**
8. **A budget decision is deterministic.**
9. **Stable session and workspace identities.**
10. **Main-tree mutation is explicit and native**, through `git merge`.
11. **Parity.** (G0)
12. **Zero footprint.** (G17)
13. **Subscription-preserving.** (G1)
14. **Every orchestrator git mutation is an intent with oids before it is a command.** (G27)
15. **The orchestrator's git never discovers.** (G29)

---

## 3. System overview

```text
 ┌────────────────────────────── chatroom process ──────────────────────────────┐
 │  REPL: transcript · activity · permissions · status · slash commands         │
 │                         │                                      ▲             │
 │                         ▼                                      │             │
 │  Orchestrator: room order · scheduler · budget · recovery · integration      │
 │        │                 │                   │                               │
 │        ▼                 ▼                   ▼                               │
 │  Store               IPC dispatcher       Workspace manager                  │
 │  (node:sqlite, WAL   (files + receipts)   (snapshot / integrate / sync /     │
 │   + JSONL mirror)                          apply; pinned, explicit-path git) │
 │        ▲                 ▲                   ▲                               │
 │  ┌─────┴────────────┐    │          ┌────────┴────────┐                      │
 │  │ Claude driver    │    │          │ Codex driver    │                      │
 │  │ claude -p, auto  │    │          │ codex app-server│   auto-review        │
 │  └─────┬────────────┘    │          └────────┬────────┘                      │
 └────────┼─────────────────┼───────────────────┼───────────────────────────────┘
          │ stdin turns +   │ agent-side files  │ turn/start, turn/steer
          │ PostToolUse hook│                   │
          ▼                 ▼                   ▼
   Claude worktree     from-agent/to-agent   Codex worktree
```

| Component | Responsibility |
|---|---|
| REPL | Input, transcript, activity, relayed prompts, commands. |
| Orchestrator | The single state machine and database writer. |
| Store | Schema, migrations, transactions, JSONL mirror. |
| IPC dispatcher | Imports agent operations, writes receipts and deliveries, enforces idempotency and limits. |
| Driver | Starts or resumes one vendor session, submits turns, delivers mid-turn messages, normalizes events, relays approvals. |
| Workspace manager | Snapshots, merges, ref expectations, intent rows, recovery, always through recorded absolute paths. |
| Agent-side command | `post`, `reply`, `ask`, `inbox`, `hook`. |

---

## 4. Project identity and layout

### 4.1 Identity and the main worktree

Chatroom resolves `git rev-parse --path-format=absolute --git-common-dir`, hashes it into
`project_id`, and resolves the main worktree as the entry of `git worktree list` whose git
directory is the common directory. Bare repositories are refused. Authority lives in the
main worktree whichever checkout `chatroom` was started from; the lock is an advisory OS
lock at `<runtime root>/lock`. Chatroom refuses to start from one of its own worktrees.

> **Guard G23.** Authority in the main worktree, lock in the runtime root.

### 4.2 Files

```text
<install>/chatroom                                   executable
~/.config/chatroom/config.toml                       optional defaults

<main worktree>/.chatroom/                           authority; excluded via .git/info/exclude
  config.toml
  chatroom.sqlite3, -wal, -shm
  transcript/<conversation-id>.jsonl                 derived mirror
  logs/<conversation-id>/                            raw vendor events, opt-in
  hooks-empty/                                       empty directory used as core.hooksPath
  worktrees -> <runtime root>/worktrees              proposed convenience symlink

<platform-state>/chatroom/projects/<project-id>/     runtime root
  lock
  ipc/{claude,codex}/
    from-agent/<turn-id>-<nonce>/                    exact agent-writable drop root
    to-agent/{deliveries,receipts}/                  orchestrator-owned, agent-readable
    scratch/<turn-id>-<nonce>/                       agent-writable temp root
    staging/                                         orchestrator-owned quarantine
  worktrees/<conversation-id>/{claude,codex}/
  integration/<conversation-id>/                     temporary integration worktree
```

> **Guard G7.** Worktrees stay outside the main tree.

---

## 5. Durable storage

`node:sqlite`, WAL, `synchronous = FULL`, `foreign_keys = ON`, `busy_timeout = 5000`; one
write connection; migrations under an exclusive lock with a backup. The JSONL mirror is
appended after every committed transaction that creates entries, fully validated on startup
and on `chatroom log --verify`, rewritten from SQLite on discrepancy, never read by recovery.

```sql
projects(id PK, main_worktree, git_common_dir, runtime_root, git_binary, git_version,
  created_at, current_conversation_id)
conversations(id PK, project_id FK, name, created_at, last_used_at, status,
  autonomy_limit, autonomy_used, main_branch_ref)
entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)   -- message | event
messages(entry_id PK FK, author, via, body, turn_id, operation_id, reply_to FK, causal_root FK,
  UNIQUE(author, operation_id))                        -- via: repl | post | reply | final | recovery
message_targets(message_id FK, participant, expects_action, PK(message_id, participant))
events(entry_id PK FK, type, agent, turn_id, payload_json)
agent_sessions(conversation_id FK, agent, vendor_session_id, generation, status,
  last_confirmed_entry_id, capabilities_json, PK(conversation_id, agent))
                                                       -- status: absent | healthy | suspect | recovering | lost
turns(id PK, conversation_id FK, agent, attempt, status, vendor_turn_id, session_generation,
  started_at, ended_at, final_message_id, error_json, cost_json)
turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
deliveries(id PK, conversation_id FK, agent, message_id FK, status, transport, attempt,
  autonomy_charged, accepted_at, UNIQUE(agent, message_id))
agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))                             -- type: post | reply | delivery_ack
permissions(id PK, turn_id FK, agent, vendor_request_id, status, reviewer, summary,
  request_json, decision_json, rationale, created_at, resolved_at)
workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, admin_dir,
  last_seen_oid, last_snapshot_oid, status, PK(conversation_id, owner))
                                                       -- owner: claude | codex | integration
main_observations(conversation_id FK, observed_oid, observed_branch_ref, observed_at)
git_operations(id PK, conversation_id FK, type, status, created_at, finished_at, details_json)
                                                       -- type: snapshot | integrate | sync | apply | apply_abort
                                                       -- status: planned | executing | done | needs_user | failed
git_steps(id PK, operation_id FK, ordinal, kind, target_ref, expected_old_oid, source_oid,
  candidate_oid, result_oid, status, message)
                                                       -- kind: tree_write | commit_write | ref_cas | index_align
                                                       --       | merge | preflight | abort
```

Transaction boundaries: a message with targets, deliveries and credit; a turn with its
inputs; a delivery acceptance; a final reply and turn end; an agent operation and its
receipt; a permission decision; a git operation with its steps; a step's result.

---

## 6. Messages and addressing

Handles `user`, `claude`, `codex`. A mention is `@` plus a handle or `all`, at a word
boundary, case-insensitive, outside code. `@all` is everyone but the author.

| Author | No mention | Mentions |
|---|---|---|
| user | Claude and Codex | the mentioned agents |
| agent | user | the mentioned participants except the author |

`--to` overrides. Targets are rows, never reconstructed from text, always shown. Every
message is visible immediately; a delivery row exists for each non-author agent; a
non-target delivery waits for the next triggering message. Agent-side commands carry a
random `operation_id`, reused on retry. Messages may carry `reply_to` and `causal_root`.
Limits: body 64 KiB, operation file 96 KiB, 100 posts per turn, batch 64 messages.

> **Guard G10.** `@handle` is the one convention.

---

## 7. Autonomy budget and scheduling

A user message resets `autonomy_used`. An agent message targeting the other agent reserves
one credit at commit; with none left, its delivery is `held` and stays visible to the user.
Held deliveries are released, charged once, when the user addresses the held recipient or
raises `/budget`; a user message to one agent does not release the other's.

States per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. One active turn per agent; the two run concurrently.

```text
for each agent A:
    triggers = undelivered messages targeted at A, not held
    if none: continue
    batch = every undelivered message visible to A through the newest trigger
    if A idle:                          create a turn with batch; start it
    elif A running and nativeSteering:  steer; accepted on protocol ack, else back to queued
    elif A running and hookDelivery:    write delivery files; accepted on delivery_ack, else back to queued at turn end
    else:                               leave queued
```

Both agents start in the same tick when both have work; batches are bounded; every post
gets a receipt.

> **Guard G19, G12, G11.** Asymmetry intentional; no turn-taking; no discarded replies.

---

## 8. File IPC

> **Guard G16.** Files, never sockets.

### 8.1 Per-turn environment

The user's environment, minus variables matching `security.env_deny_patterns` (default
`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GH_*`, `GITHUB_*`, `NPM_CONFIG_*AUTH*`, `OPENAI_*`,
`ANTHROPIC_*`) except names on `security.env_allow`, plus:

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT`, `CHATROOM_CONVERSATION`, `CHATROOM_TURN` | identities |
| `CHATROOM_OPERATION_DIR` | exact agent-writable drop directory for this turn |
| `CHATROOM_DELIVERY_DIR`, `CHATROOM_RECEIPT_DIR` | orchestrator-owned, agent-readable |
| `CHATROOM_SCRATCH` | per-turn temp directory, also exported as `TMPDIR` |
| `CHATROOM_BIN`, `CHATROOM_PROTOCOL` | executable path, protocol version |

The Anthropic key removal is what keeps Claude on the subscription; the rest is a cheap
default. Nothing in the agent's git environment is altered.

### 8.2 Operations, receipts, deliveries, `ask`

`post`, `reply` and `delivery_ack` share one envelope
`{protocol, operation_id, type, created_at, payload}`, written by temp-file-and-rename
into the drop directory. A poller is authoritative. The dispatcher moves each file to
`staging/`, validates it with no-follow checks, imports transactionally or returns the
previous result for a duplicate id, and writes a receipt by rename. `chatroom post` waits
briefly and prints the message id. Before a turn ends, the drop root is closed, drained and
retired after a grace period. Hook deliveries are one atomic file per batch under
`to-agent/deliveries/`, acknowledged by a `delivery_ack`, never moved by agents.

`ask` posts, then waits up to `ask.timeout_seconds`: an explicit `reply_to` resolves it
(`answered`); the first message from an asked party targeting the asker is returned at once
as `probable`; otherwise `indeterminate`.

> **Guard G14.** Return early on a probable candidate.

---

## 9. Driver contract

```ts
type DriverCapabilities = {
  persistentSession: boolean; longLivedProcess: boolean; nativeSteering: boolean;
  hookDelivery: boolean; interrupt: boolean; hostApprovals: boolean;
  autoReviewer: "claude_auto" | "codex_auto_review" | "none";
  inspectTurnState: boolean; structuredEvents: boolean; maxDeliveryBytes?: number;
  writeBoundary: boolean;   // doctor: a write inside the worktree succeeds, outside it fails
};

interface AgentDriver {
  probe(): Promise<ProbeReport>;
  connect(session: SessionSpec): Promise<DriverCapabilities>;
  startTurn(turn: TurnSpec, input: DeliveryBatch): Promise<VendorTurn>;
  steer(turn: VendorTurn, input: DeliveryBatch): Promise<AcceptedInput>;
  deliverViaHook(turn: VendorTurn, input: DeliveryBatch): Promise<void>;
  inspectTurn(turn: VendorTurn): Promise<TurnReconciliation>;
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(turn: VendorTurn): Promise<void>;
  events(): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
```

`chatroom doctor` checks: both executables and versions; the git binary; Claude's login is
the subscription; a session starts and resumes; the hook fires; steering or hook delivery
works; a shell write inside the worktree succeeds and one into the main tree and the peer
worktree fails; a native edit of the main tree is refused. `writeBoundary` false refuses
that agent, because rule 1 of §0.0 is hard. Nothing else is probed.

---

## 10. Claude driver

```text
claude -p --session-id <uuid> | --resume <uuid> \
  --input-format stream-json --output-format stream-json --verbose --include-hook-events \
  --append-system-prompt "<brief>" \
  --settings '<inline JSON, §15.1>' \
  --permission-mode auto --permission-prompts host [--model <model>]
```

Working directory: the conversation's Claude worktree. One `user` message per turn on
stdin; the CLI queues further input, so the driver writes input only when a turn starts.
`longLivedProcess` true; `nativeSteering` false; `hookDelivery` true. Reply text and cost
from `result`; activity from `assistant` events. The user's settings, hooks, MCP servers and
`CLAUDE.md` load as they would in solo use.

Hook, registered in the inline settings:
`{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}`.
`chatroom hook` drains the delivery directory, writes a `delivery_ack`, and prints
`hookSpecificOutput.additionalContext` with the delivery text.

Auto mode: the classifier decides routine actions; the rest arrive as control requests,
are shown in the REPL with a short id, and answered on stdin.

Fallback: one process per turn with the same flags if the long-lived process fails Phase 0.

> **Guard G1, G2, G4.** CLI on the subscription; `auto` with host-relayed prompts; the hook
> is the injection channel.

---

## 11. Codex driver

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the profile of §15.2 and the environment policy. `turn/start`; `turn/steer`
with `expectedTurnId`; `turn/interrupt`. Approval requests reach the REPL when Auto-review
escalates or is unavailable; `item/autoApprovalReview/*` notifications are recorded as
evidence when they parse. Names confirmed in the schema generated by
`codex app-server generate-json-schema` on 0.153.3. Authentication is the user's existing
Codex login.

Fallback: `codex exec --json -o <file> -c … -` and `codex exec resume <id> --json -o <file>
-c … -`, with the same overrides through `-c`; no approvals, Auto-review or steering; hook
delivery only when Chatroom's hook is the sole non-managed hook source.

> **Guard G3.** `auto_review` with `on-request`, user fallback.

---

## 12. Turn lifecycle

Start: in one transaction select the batch, create the turn, mark deliveries `publishing`;
create drop and scratch directories; ensure the session is connected; submit through the
native channel, never as an argument; on acknowledgment mark `accepted` and `running`.
During: posts imported independently; steering or hook delivery per capability; approvals
stop only the requesting operation; `/stop` is interrupt, SIGTERM, SIGKILL. End: close and
drain the drop root; append the final reply with key `final:<turn-id>` or `silent`; return
unacknowledged hook deliveries to `queued`; retire directories; run the scheduler. A
steering or hook race returns the batch to `queued`; the credit stays charged.

---

## 13. Sessions and recovery

Session ids are explicit; a picker, `--last` or `--continue` is never used. A resumed
session must report the expected id and directory. A `suspect` session (crash, kill,
transport loss) is snapshotted, inspected where the protocol allows, resumed, moved to
`recovering`, given a recovery note as its first input with no queued work attached, and
marked `healthy` only after that turn completes; otherwise `lost` and rebuilt from the
brief, transcript tail and workspace state. Startup marks interrupted turns, verifies the
runtime root, reconciles IPC by id, classifies git steps (§16.7), validates the mirror,
reconnects last.

> **Guard G18.** Resume before rebuild.

---

## 14. What agents receive

### 14.1 Delivery format

```text
[chatroom] You are @claude. 2 new messages. Act on those addressed to you; read the rest as context.
Speak now with "$CHATROOM_BIN" post "..."; ask with "$CHATROOM_BIN" ask "..."; reply exactly [silent] if your posts said everything.

--- #41 · user → @claude @codex · 10:07:12
Implement X.

--- #42 · codex → @claude · 10:07:40 · reply to #41
@claude I'll take the parser; can you take the CLI?

workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230
peer changes since your previous input: src/parser.ts, test/parser.test.ts
```

### 14.2 Brief

```text
You are @{me} in a project chat with @user and @{other}. Solve the user's task together.
Everything posted is visible to all three of you.

Coordination
- On a task sent to both agents, immediately claim a concrete, non-overlapping part:
  "$CHATROOM_BIN" post "@{other} I'll take …". Resolve overlaps in the chat, then work.
- Mention @{other} only when you intend to activate them. A message without mentions goes
  to the user.
- "$CHATROOM_BIN" reply <id> "…" answers a specific message. "$CHATROOM_BIN" ask "@{other} …"
  waits briefly for an answer; continue after its timeout.
- New messages reach you after tool calls, marked [chatroom]. Read them before your next
  step. "$CHATROOM_BIN" inbox shows them on demand.
- Your final response is also posted. If your posts already said everything, end with [silent].
- Keep chat messages short; code and detailed results belong in the worktree.

Workspace
- Write only in {my_worktree} and the per-turn scratch directory.
- Read {peer_worktree} and the user's main tree {main_tree} when useful; never write there.
  Either may be mid-edit; the chat is where intent is stated.
- Your branch is {my_branch}. Commit on it if and when you like; Chatroom snapshots
  uncommitted work when it integrates. Do not touch other branches, tags or refs, and do
  not run merge, rebase or reset against them; the user runs integration.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

> **Guard G8 and G9.** Main and peer readable, own worktree writable, commits optional and
> native.

---

## 15. The boundary

One rule is hard: an agent writes only its own worktree, the drop root and the scratch
root. Everything else is parity with solo use.

### 15.1 Claude

```json
{
  "sandbox": {
    "enabled": true, "failIfUnavailable": true,
    "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyRead":  ["<security.secret_paths…>", "<main>/.chatroom", "<ipc root>/*/staging", "<ipc root>/<peer>"]
    }
  },
  "permissions": {
    "deny": ["Edit(//<main>/**)", "Write(//<main>/**)",
             "Edit(//<peer worktree>/**)", "Write(//<peer worktree>/**)",
             "Read(//<main>/.chatroom/**)"]
  }
}
```

- The sandbox's default write scope is the working directory, added directories and the
  session temp directory, plus, for a linked worktree, the shared `.git` directory so that
  `git commit` works. That is exactly the boundary wanted: own worktree, own commits.
- `allowUnsandboxedCommands: false` is the one setting that keeps the rule hard; without it
  the classifier could approve a rerun outside the sandbox.
- The two Edit and Write deny rules bound the native tools the sandbox does not cover.
- `denyRead` on the secret paths and on Chatroom's own directories is a config default,
  the same dozen paths on both harnesses: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
  `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`,
  `~/.codex`, `~/.config/chatroom`. It exists because the harness homes hold every other
  project's transcripts, which solo use never puts in front of a second model.
- Network, web tools, MCP servers, subagents: as configured by the user for solo use.

### 15.2 Codex

Passed through the `config` map; shown as TOML with top-level keys first:

```toml
default_permissions = "chatroom-<nonce>"

[shell_environment_policy]
ignore_default_excludes = false
# set = { CHATROOM_AGENT = "codex", …, TMPDIR = "<scratch root>" }

[permissions.chatroom-<nonce>.filesystem]
":root"                 = "read"
"<own worktree>"        = "write"
"<drop root>"           = "write"
"<scratch root>"        = "write"
"<extra write root…>"   = "write"
"<main>/.chatroom"      = "deny"
"<ipc root>/*/staging"  = "deny"
"<ipc root>/<peer>"     = "deny"
"<secret path…>"        = "deny"
```

Measured under `codex sandbox` on 0.153.3: `:root` and `/` are both accepted as read
entries, a deny inside the root read holds, and a profile without a system read grant
cannot start `sh`. If the profile fails to load, the driver falls back to legacy
`workspace-write` with `writable_roots`, measured to enforce the write boundary, and says so
once in the transcript. Network, web search, apps, MCP servers, nested agents: as the user
configured Codex for solo use.

The shared git directory is writable by Codex only through the worktree's own admin
directory and the common object and ref stores, as for any Codex session in a linked
worktree.

### 15.3 What is deliberately not here

No read allowlist, no modes, no guarantee levels, no network allowlist, no hosted-tool
disabling, no escalation policy, no commit broker, no pointer verification, no detached
checkout. The user runs these harnesses with the same exposure every day; the chatroom's
only new exposure, the harness homes, is covered by the denylist above.

---

## 16. Workspaces and Git integration

### 16.0 Git invocation

The orchestrator resolves `git` on `PATH` once (or `git.binary`), records path and
version, and uses that path. Every command names its repository explicitly:

```text
<git> --git-dir=<recorded admin dir or common dir> --work-tree=<recorded worktree> \
      -c core.hooksPath=<main>/.chatroom/hooks-empty -c commit.gpgsign=false \
      merge --no-verify --no-gpg-sign --no-autostash --no-rerere-autoupdate --no-ff -m "<message>" <ref>
```

The merge into the user's main worktree is the same with `--no-commit` and no `-m`.
Measured on git 2.54.0: a `pre-merge-commit` hook runs on an unpinned merge and not with
this invocation; with `merge.autoStash` inherited and no `--no-autostash`, an overlapping
edit that must be refused is stashed and the file overwritten; a rewritten `.git` pointer
redirects discovery while explicit `--git-dir` ignores it. Snapshots use `read-tree`,
`add`, `write-tree`, `commit-tree` and `update-ref` under `GIT_INDEX_FILE`.

> **Guard G26, G29, G13.** Pinned binary, explicit paths, pinned flags.

### 16.1 Refs and expectations

Per conversation: `refs/heads/chatroom/<p>/<c>/{claude,codex,integration}`, starting at
main's HEAD; `conversations.main_branch_ref` records main's symbolic branch.

| Ref | Moved by | Chatroom's expectation | On deviation |
|---|---|---|---|
| agent branches | the agent's own commits, and Chatroom's snapshots | `last_seen_oid`, refreshed before every operation | adopt: an agent committed |
| integration | Chatroom only | `last_seen_oid` | `ref_moved` event; integration for the conversation waits for `/adopt-ref` or a restore from the reflog |
| main | the user | `main_observations` | adopt on `/sync`; a changed symbolic branch blocks `/apply` until `/adopt-main` |

An agent moving `main`, the peer's branch or integration is a norm violation, detectable
by the same reflog the user relies on alone. It is not prevented, by design (G0).

### 16.2 Snapshot

With the agent's turn not in flight, or on the agent's behalf inside `/integrate` and
`/sync`: `tree_write` (temporary index from the branch's current oid, add tracked and
non-ignored untracked files, `write-tree`), `commit_write` (`commit-tree`; the candidate
oid is persisted before the next step), `ref_cas` (`update-ref` with the expected old oid),
`index_align` (align the worktree's index without touching files). Ignored files are not
captured. If the agent has its own commits, the snapshot sits on top of them.

### 16.3 `/integrate <agent>`

Refuses while the agent runs. Snapshot; merge the agent branch into integration in the
integration worktree with the single pinned form; record the oid. Conflict: abort,
`needs_user`, paths reported.

### 16.4 `/sync <agent|all>`

Refuses while the agent runs. If main's observed HEAD is not an ancestor of integration,
merge main into integration first and record the observation. Snapshot; merge integration
into the agent branch in the agent's worktree. Conflict: `needs_user`; `/sync --abort
<agent>` is the only resolution in the first release. `/import <src> <dst>` is integrate
then sync.

### 16.5 `/apply [agent]`

`/apply <agent>` is integrate then apply. In the user's main worktree:

1. **Preconditions**: integration is not an ancestor of HEAD; the index equals HEAD; no
   `MERGE_HEAD`, `REBASE_HEAD` or `CHERRY_PICK_HEAD`; main's symbolic branch equals the
   recorded one, else `needs_user` until `/adopt-main`.
2. **Preflight**: every path the merge would add or rename to must not exist in the working
   tree, tracked, untracked or ignored; every path it would modify or delete must be clean
   against HEAD. Measured: git alone overwrote an ignored file in the way with and without
   `--no-overwrite-ignore`, so this check is Chatroom's. The main worktree is assumed
   quiescent between preflight and merge.
3. **Merge** with the pinned invocation and `--no-commit`; record the post-merge index
   (`ls-files -s`, including stages). Status `needs_user` while `MERGE_HEAD` exists.

Measured with git 2.54.0:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Proceeds; edit preserved; tip changes staged |
| Unstaged edit on a file the tip changes | Refused by preflight and by git; tree unchanged |
| Untracked or ignored file the tip would create | Refused by preflight |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge |

The user reviews with `git diff --cached` and commits, or runs `/apply --abort`.

**`/apply --abort`**: compare the current index with the recorded post-merge index; if it
differs, stop with `needs_user` and list the paths, because git's abort discards changes
staged after the merge. Measured: a change staged to an unrelated file after the merge was
silently discarded by `git merge --abort`, and so was a pre-existing dirty file staged after
the merge; unstaged changes to unrelated files survived. If the index is unchanged, run
`git merge --abort`. The man page's warning that abort "will in some cases be unable to
reconstruct the original (pre-merge) changes" applies to unusual dirty-tree states; those
are the user's to manage, as with git alone. `/apply --commit` (**proposed**) commits at
once.

> **Guard G13.** Native merge, pinned, explicit paths, own collision preflight, abort
> refuses on a changed index. No synthetic commit, applied-oid marker, journal, backup ref
> or per-path state.

### 16.6 `/adopt-main`, `/adopt-ref`, cleanup

`/adopt-main` records main's current branch and HEAD as the new baseline in one
transaction. `/adopt-ref integration` records integration's current oid as expected after
the user has inspected it. `chatroom clean` snapshots and removes worktrees, keeping
conversations and refs; `chatroom reset` removes everything Chatroom owns after
confirmation, refusing while any worktree is dirty and unsnapshotted.

### 16.7 Recovery

| Step | Classification on startup |
|---|---|
| `tree_write`, `preflight` | rerun |
| `commit_write` | `candidate_oid` recorded and the object exists: done; else rerun |
| `ref_cas` | ref equals expected old: rerun with the candidate; equals candidate: done; else `needs_user` |
| `index_align` | index tree equals the ref's tree: done; else rerun |
| `merge` in a Chatroom worktree | merge commit with the expected parents: done; `MERGE_HEAD`: abort, `failed`; ref unchanged, no `MERGE_HEAD`: rerun |
| `merge` in main | `MERGE_HEAD`: `needs_user`; a merge with the tip as second parent above the recorded HEAD: done by the user; HEAD unchanged and index equals HEAD: rerun; else `needs_user` |
| `abort` | `MERGE_HEAD` absent: done; else rerun the index check and abort |

A `MERGE_HEAD` in main with no Chatroom operation is never touched.

> **Guard G27.** Classify by oids; never assume an abort is possible.

---

## 17. Conversations, REPL, configuration

Conversations: `chatroom` opens the current one; `new [name]`, `list`, `continue`, `delete`.
Switching stops turns, snapshots, disconnects. One session per harness per conversation.

REPL: line-oriented; `"""` fences multi-line input; relayed approvals get short ids.

| Command | Effect |
|---|---|
| `/budget [N]` | Autonomy credit limit. |
| `/status` | Agents, sessions, turns, held deliveries, permissions, refs and expectations, main's branch, git binary. |
| `/stop <agent\|all>` | Interrupt, SIGTERM, SIGKILL. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Relayed approvals. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot`, `/integrate`, `/sync`, `/sync --abort`, `/import`, `/apply`, `/apply --abort`, `/apply --commit`, `/adopt-main`, `/adopt-ref` | §16 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>`, `/history [N]` | Display. |
| `/doctor` | §9 checks. |
| `/quit` | Stop, flush, unlock. |

Configuration (TOML; project overrides global):

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Cross-agent activations after user input. |
| `turn.timeout_minutes`, `turn.stop_grace_seconds` | `30`, `5` | Turn limits. |
| `ask.timeout_seconds` | `60` | Below the measured tool timeout. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.long_lived` | `true` | One process per session. |
| `driver.codex.prefer_app_server` | `true` | App-server before `exec`. |
| `driver.codex.approval_policy`, `driver.codex.approvals_reviewer` | `on-request`, `auto_review` | G3. |
| `git.binary` | resolved | Override the git executable. |
| `security.secret_paths` | §15.1 list | Denied read paths, both harnesses. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_deny_patterns`, `security.env_allow` | §8.1 defaults, empty | Environment scrub. |
| `logging.raw_events`, `logging.retention_days` | `false`, `30` | Raw vendor streams. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Project guidance appended to both briefs. |
| `workspace.state_dir`, `workspace.link_worktrees` | platform default, `true` | Runtime root; proposed symlink. |

Activity kinds: `text`, `reasoning_summary`, `tool`, `tool_result`, `permission`, from
`assistant` events on Claude and `item.*` events on Codex. Raw streams off by default.

---

## 18. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crash during a turn | Suspect; resume and recovery turn; rebuild if that fails. |
| Crash during a git operation | Steps classified per §16.7; nothing reset. |
| Agent moved integration or main | `ref_moved`; integration waits for `/adopt-ref` or a reflog restore; nothing reset. |
| Main worktree on another branch | `/apply` waits for `/adopt-main`. |
| Apply refused by preflight or git | Main unchanged; paths or git's message shown. |
| Index changed after the merge | `/apply --abort` refuses and lists paths. |
| Write-boundary or login check fails | That agent does not start. |
| Codex profile fails to load | Legacy `workspace-write` with `writable_roots`, noted once. |
| Auto-review unavailable | User review, visibly. |
| Budget exhausted | Trigger held; count shown. |
| Database corruption | Stop; never rebuild from the mirror. |
| Disk full | Stop accepting messages before acknowledging them. |

---

## 19. Verification ledger

### Measured on the development machine

- Codex 0.146.0 and 0.153.3 `workspace-write`: cwd writes succeed, outside fail,
  `writable_roots` opens a directory, reads succeed anywhere, Unix sockets denied.
- `codex exec resume` has no `--cd` or `--sandbox`. App-server schema on 0.153.3 defines
  the thread, turn, steer, interrupt, approval and auto-review methods used here.
- Claude 2.1.261 flags as in §10. `node:sqlite` loads on Node 25.1.0.
- git 2.54.0: the seven `/apply` cases; autostash defeats the overlap refusal without
  `--no-autostash`; hooks run unpinned and not pinned; an ignored file in the way is
  overwritten with and without `--no-overwrite-ignore`; abort discards changes staged after
  the merge and keeps unstaged ones; explicit `--git-dir` ignores a rewritten pointer.
- Codex 0.153.3 under `codex sandbox`: `:root` and `/` accepted; deny inside read holds;
  a profile without a system read grant cannot start `sh`.

### Documented

- Claude: SDK login statement; streaming input queues; `PostToolUse` `additionalContext`;
  inline `--settings`; sandbox Bash-only with default write scope and the linked-worktree
  allowance; `Read(//path)`, `Edit(//path)` rules with deny precedence; `--continue` scoped
  to the directory.
- Codex: `approvals_reviewer` and the interactive-approvals requirement; `shell_environment_policy`
  defaults; profile keys and precedence, Beta; app-server experimental.
- git-merge: `--abort` "will in some cases be unable to reconstruct the original (pre-merge)
  changes"; `--no-overwrite-ignore` documented to abort.

### Phase 0

1. `node:sqlite` on the oldest supported Node LTS.
2. Claude: sequential turns in one `-p` stream-json process; `--resume` later; the hook fires
   from inline `--settings` and reaches the model; control request and response shapes;
   `thinking` blocks; the login check.
3. Claude boundary: shell write inside the worktree succeeds, into main and peer fails;
   native Edit of main and peer refused; `git commit` in the worktree works.
4. App-server: the §15.2 overrides accepted through `config`; Auto-review accepted; a
   routine command auto-approved; an escalation reaches `requestApproval`; `turn/steer`
   against a finishing turn; the legacy fallback when the profile fails.
5. Codex `exec` fallback with `-c` on start and resume.
6. Kill mid-generation and resume on both harnesses; tool-command timeouts.
7. Recovery classification against a crash after each step.

---

## 20. Testing

Model-free core tests with fake drivers under crash injection; IPC security cases; the
write-boundary check on both harnesses; the Git matrix: file kinds, snapshots over agent
commits, integrations, both agents on the same and different files, main advancing before
`/sync` and `/apply`, the seven `/apply` cases, abort with a changed and an unchanged index,
crash after each step; mirror validation; driver fixtures; a vendor event-shape change
disables the adapter until its fixture passes.

---

## 21. Implementation

TypeScript on the Phase-0-verified Node LTS; `node:sqlite` if it passes.

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, doctor.ts, env.ts
  workspace/  git.ts, repository.ts, snapshot.ts, merge.ts, refs.ts, apply.ts, steps.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, activity.ts
  test-support/ fake-driver.ts, crash-injector.ts, scratch-repo.ts
```

---

## 22. Build order

0. **Spikes** for every Phase 0 item, later folded into `doctor`.
1. **Durable room core**: schema, mirror, targets, deliveries, budget, reconciliation, property
   tests. Exit: crash injection cannot lose or duplicate messages.
2. **IPC and agent commands**: the five commands, receipts, quarantine, security cases.
3. **Drivers**: Claude in auto mode with the hook; Codex app-server with Auto-review and
   steering; `exec` fallback; scrubbed environment; minimal recovery. Exit: both agents chat
   concurrently and receive a mid-turn message.
4. **Worktrees and the boundary**: runtime roots, Claude settings, Codex profile with legacy
   fallback, the doctor checks. Exit: each agent edits, tests and commits in its own
   worktree and cannot write main or the peer.
5. **Git collaboration**: pinned explicit-path git, snapshots, `/integrate`, `/sync`,
   `/import`, `/apply` with preflight and abort, adopt commands, step recovery, the Git
   matrix.
6. **Later**: sync conflict resolution through the orchestrator; checkpoints; archive and
   `gc`; `/review`; rendering polish.

> **Guard G20.** Keep the cut line.

---

## 23. Open decisions

1. `/apply --commit` (proposed) and its message format.
2. Raw activity defaults during adapter development.
3. Sync conflict resolution route for a later release.
4. Inactive worktree policy.
5. Convenience symlink (proposed).
6. Whether to prefer `/` over `:root` in the Codex profile once app-server confirms both.

---

## 24. References

- Claude Code: https://code.claude.com/docs/en/cli-reference, `/hooks`, `/sandboxing`,
  `/permissions`, `/sessions`, `/headless`; Agent SDK overview
  https://code.claude.com/docs/en/agent-sdk/overview
- Codex: https://learn.chatgpt.com/docs/app-server, `/permissions`,
  `/sandboxing/auto-review`, `/config-file/config-reference`, `/non-interactive-mode`
- git-merge and git-worktree manuals

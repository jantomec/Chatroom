# Chatroom Architecture

Status: implementation baseline, 2026-09-07. No code exists yet. Implementation starts with
Phase 0 (§22), whose purpose is to answer the open items in §19 before any scheduler code
is written.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0,
git 2.54.0 (Homebrew) and 2.50.1 (Apple), both on `PATH`. Versions are evidence for the
smoke tests, not compatibility promises.

How to read this document:

- **Comment** blocks explain why a decision stands.
- **Guard** blocks mark decisions that must not be reversed without the user's explicit
  approval. Each cites its evidence: a user decision, a measurement on this machine, or a
  quoted documentation sentence. A revision or review that believes a guarded decision is
  wrong must say so and quote the guard, rather than designing around it. Section 0.2
  indexes them.
- **Proposed** marks items the user has not explicitly decided; they can be dropped.

---

## 0. Posture

### 0.1 Parity

An agent inside the chatroom has the same capabilities and the same risks as the same
harness run by the user directly in the same repository: Claude Code in auto mode, Codex
with Auto-review, the user's own customization, tools and network. The chatroom adds only
what is needed so that two agents and an orchestrator can share one repository without
corrupting each other's work or the user's tree.

Three things change when two agents share a repository, and each has a proportionate rule:

1. **Two writers corrupt each other.** Each agent writes only its own worktree. This rule is
   hard for working-tree files: both sandboxes bound shell writes to the working directory
   by default, and permission rules bound Claude's native edits. For git metadata the rule
   is enforced where the harness allows scoping and otherwise held by norm and detection,
   as it is when the user runs the harness alone (§15.4).
2. **A third party merges.** The orchestrator snapshots, integrates, syncs and applies with
   pinned git invocations and explicit paths, records what it expects each of its refs to
   be, and refuses to run over a state it did not expect.
3. **One model's output is the other's input.** The autonomy budget and the "claim before
   build" norm bound the loop, and the collaboration protocol of §14.3 gives the agents an
   explicit way to finish, to settle disagreements, and to hand the user only the
   questions that are the user's to answer.

Chatroom's own coordination state, the IPC directories and the integration worktree, is a
surface that solo use does not have, so it is protected from both agents by the same
means as the peer worktree.

> **Guard G1.** The posture is parity with solo use. A stricter boundary than the user runs
> daily must be argued as a coordination failure or data loss inside the parity model, not
> as a different threat model. User decision, 2026-09-05.

### 0.2 Guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Parity posture. | User decision. |
| G2 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; Agent SDK docs: "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." |
| G3 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G4 | On app-server, Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, with visible fallback to the user. Under the `codex exec` fallback there are no approvals: actions that would need one fail and the user performs them. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G5 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: streaming input has "queued messages … process sequentially"; hook `additionalContext` is "appended to the tool result". |
| G6 | Worktrees and IPC live outside the main tree. | Claude permissions docs: deny rules take precedence, so a main-tree Edit deny would cover a nested worktree. |
| G7 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G8 | No commit norms. Agents may commit on their own branch with native git, or not. | User decision. |
| G9 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G10 | When both agents answer at once, both replies are recorded. | User decision. |
| G11 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G12 | `/apply` and `/sync` are native `git merge` operations with the pinned invocation of §16.0, explicit paths, Chatroom's own collision preflight, and an abort that refuses when the index changed after the merge. | Measured, §19. |
| G13 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency. |
| G14 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex's sandbox denies Unix-socket connections. |
| G15 | Zero footprint in tracked files, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.gitignore`. | User decision. |
| G16 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | Both harnesses persist turns incrementally. |
| G17 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry, §7. |
| G18 | First-release cut line: Phase 0 and phases 1 to 5. | Scope control. |
| G19 | `.chatroom/` lives in the main worktree resolved from the common git directory; the lock lives in the runtime root. | `git rev-parse --show-toplevel` differs per linked worktree. |
| G20 | The git binary is resolved once at startup, recorded with its version, and used by path. | Two binaries on this machine. |
| G21 | Every orchestrator git mutation is an intent row with oids; startup classifies by comparing refs and states; a recovered main merge reruns its preflight. | Measured recovery cases, §19. |
| G22 | The orchestrator's git never discovers a repository; every command carries recorded absolute paths. | Measured: a rewritten `.git` pointer redirects discovery; explicit paths ignore it. |
| G23 | The hard boundary covers working-tree files. Git metadata is scoped where the harness allows it and otherwise protected by norm and detection; that limitation is stated, not hidden, and does not justify a commit broker or clones. | User decision; measured scoping on Codex, §19. |
| G24 | The agents manage completion themselves: criteria, acceptance, settled decisions and escalation follow the protocol of §14.3, and the user is consulted only for the cases it names. No user checkpoint is added to the normal flow. | User decision, 2026-09-07. |

---

## 1. Purpose

Chatroom is a terminal group chat with three participants: the user; Clara, a Claude agent
running through the Claude Code CLI in auto mode; and Phil, a Codex agent running through
the Codex App Server with Auto-review, with the Codex CLI as fallback. All participants see
every message. Addressing says who is expected
to act; it does not make a message private. Claude and Codex work concurrently in their own
worktrees, coordinate through the chat while working, and inspect one another's work and
the user's main tree.

`chatroom` is one globally installed command. A repository opts in when the command is run
inside it. Chatroom keeps its authority under `.chatroom/` in the main worktree, agent
runtime data under the platform's per-user state directory, and Chatroom-owned refs and
worktrees. It does not change tracked files, `CLAUDE.md`, `AGENTS.md`, `.claude/`,
`.codex/` or `.gitignore`. Plain `claude` and `codex` sessions remain independent, and
Claude keeps running on the user's subscription.

### 1.1 Non-goals for the first release

More than two agents; a full-screen interface; remote rooms; exactly-once tool execution;
isolation from a hostile local process; native Windows; source review, checkpoints,
archive and `gc`; resolving sync conflicts in place.

---

## 2. Principles

1. **One durable authority.** SQLite wins over any derived file.
2. **One database writer.** Only the orchestrator connection mutates the database.
3. **Monotonic room order.** Every message and event receives one increasing `entry_id`.
4. **At-least-once transport, idempotent acceptance.**
5. **No state rollback.** Recovery moves forward from durable facts.
6. **No orchestrator writes under agent control.**
7. **A message is durable before it is visible.**
8. **A budget decision is deterministic.**
9. **Stable session and workspace identities.** Session resume never guesses.
10. **Main-tree mutation is explicit and native**, through `git merge`.
11. **Parity.** (G1)
12. **Zero footprint.** (G15)
13. **Subscription-preserving.** (G2)
14. **Every orchestrator git mutation is an intent with oids before it is a command.** (G21)
15. **The orchestrator's git never discovers.** (G22)

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
| Orchestrator | The single state machine and database writer. Resolves targets, schedules work, reserves autonomy credits, coordinates recovery. |
| Store | Schema, migrations, transactions, JSONL mirror. |
| IPC dispatcher | Imports agent operations, writes receipts and deliveries, enforces idempotency and limits. |
| Driver | Starts or resumes one vendor session, submits turns, delivers mid-turn messages, normalizes events, relays approvals. |
| Workspace manager | Snapshots, merges, ref expectations, intent rows, recovery, always through recorded absolute paths. |
| Agent-side command | `post`, `reply`, `ask`, `inbox`, `hook`; uses only paths supplied in its environment. |

---

## 4. Project identity and layout

### 4.1 Identity and the main worktree

Chatroom resolves `git rev-parse --path-format=absolute --git-common-dir`, hashes it into
`project_id`, and resolves the **main worktree** as the entry of `git worktree list` whose
git directory is the common directory. Bare repositories are refused. Authority lives in
the main worktree whichever checkout `chatroom` was started from. The project lock is an
advisory OS lock on an open file descriptor at `<runtime root>/lock`. Chatroom refuses to
start from one of its own managed worktrees.

> **Guard G19.** Authority in the main worktree, lock in the runtime root. Keying authority
> by the current checkout's toplevel would fork the database across the user's own linked
> worktrees.

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
    from-agent/<turn-id>-<nonce>/                    exact agent-writable drop root for a turn
    to-agent/{deliveries,receipts}/                  orchestrator-owned, agent-readable
    scratch/<turn-id>-<nonce>/                       agent-writable temp root; never imported
    staging/                                         orchestrator-owned quarantine
  worktrees/<conversation-id>/{claude,codex}/
  integration/<conversation-id>/                     temporary integration worktree
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a
real directory. Authority is mode `0700`, files `0600`. Every orchestrator-owned ancestor
under the runtime root is a real directory owned by the user, opened with no-follow
checks; the runtime path is stored in the database and must map back to the canonical
common directory before reuse.

> **Guard G6.** Worktrees stay outside the main tree.

---

## 5. Durable storage

The store uses `node:sqlite`, present on the development machine's Node with an
experimental-feature warning. One write connection; read-only diagnostics may open a
read-only connection.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations run under an exclusive lock and keep a pre-migration backup. The JSONL mirror is
appended after every committed transaction that creates entries, outside the transaction;
on startup and on `chatroom log --verify` it is scanned in full, every line must parse and
the `entry_id` sequence must equal the database query; any discrepancy causes a rewrite
through a sibling temporary file, `fsync` and rename. Recovery never reads the mirror.

```sql
projects(id PK, main_worktree, git_common_dir, runtime_root, git_binary, git_version,
  created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                                  -- active | archived | deleting
  autonomy_limit, autonomy_used, main_branch_ref)

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)   -- message | event

messages(entry_id PK FK, author, via, body, turn_id, operation_id,
  reply_to FK, causal_root FK, UNIQUE(author, operation_id))
                                           -- author: user | claude | codex | chatroom
                                           -- via: repl | post | reply | final | recovery | system
message_targets(message_id FK, participant, expects_action, PK(message_id, participant))
events(entry_id PK FK, type, agent, turn_id, payload_json)

tasks(id PK FK messages, conversation_id FK, criteria_message_id FK, lead_agent,
  status,                                  -- open | done_claimed | accepted | waiting_user | escalated
  review_rounds_used, created_at, closed_at)
task_markers(message_id PK FK, task_id FK, marker)
                                           -- marker: criteria | assumption | settled | done | accept
                                           --         | blocker | suggestion | ask_user

agent_sessions(conversation_id FK, agent, vendor_session_id, generation,
  status,                                  -- absent | healthy | suspect | recovering | lost
  last_confirmed_entry_id, capabilities_json, PK(conversation_id, agent))

turns(id PK, conversation_id FK, agent, attempt, status, vendor_turn_id, session_generation,
  started_at, ended_at, final_message_id, error_json, cost_json)
                                           -- status: preparing | running | ending | ended | failed | interrupted
turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
                                           -- transport: start | steer | hook | boundary
deliveries(id PK, conversation_id FK, agent, message_id FK,
  status,                                  -- queued | held | publishing | accepted | superseded
  transport, attempt, autonomy_charged, accepted_at, UNIQUE(agent, message_id))
agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))                 -- type: post | reply | delivery_ack
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
                                           --       | preflight | merge | abort
                                           -- status: planned | executing | done | needs_user | failed
```

Transaction boundaries, one each: a message with targets, delivery rows and credit
reservation; a turn with its input set; a delivery acceptance; a final reply and turn end;
an agent operation and its receipt result; a permission decision; a git operation with all
its steps; a step's result, including the candidate oid of a `commit_write` and the
post-merge index of a main `merge`.

---

## 6. Messages and addressing

The two agents have names. The Claude Code agent is **Clara**, handle `clara`; the Codex
agent is **Phil**, handle `phil`. Handles are configuration (`agents.claude.handle`,
`agents.codex.handle`) and appear only where people and models read: mentions, delivery
headers, the brief, the REPL. Everything the machine keys on, paths, refs, schema columns
and `CHATROOM_AGENT`, uses the harness id, `claude` or `codex`, which never changes; a
rename is a config change with no migration.

Handles: `user`, `clara`, `phil`. A mention is `@` followed by a handle or `all`, at a
word boundary, case-insensitive, anywhere in the body outside inline and fenced code.
`@all` means every participant except the author. Unknown handles produce a warning and
do not broaden the audience.

| Author | No mention | Mentions |
|---|---|---|
| user | Clara and Phil | the mentioned agents |
| agent | user | the mentioned participants except the author |

Agent-side commands accept `--to <handle>[,<handle>]` as an override; when both are
present, `--to` wins and the body is stored as written. Resolved targets are rows, never
reconstructed from text, and always shown in the REPL and the delivery header.

Every message is visible in the user's transcript immediately after commit. A delivery row
is created for each agent other than the author, target or not; a non-target delivery
waits until that agent next receives a triggering message, which preserves "everyone sees
everything" without waking an agent for status chatter.

Agent-side commands generate a random UUID `operation_id` before writing anything; a retry
reuses it; `(agent, operation_id)` is unique. Messages may carry `reply_to`, `causal_root`
and `turn_id`. `chatroom reply <id> <body>` sets `reply_to` and targets that message's
author unless `--to` overrides. A turn's final reply is linked to its newest triggering
input unless the agent already posted an explicit reply.

A message may begin with one **marker** in square brackets, one of `[criteria]`,
`[assumption]`, `[settled]`, `[done]`, `[accept]`, `[blocker]`, `[suggestion]` and
`[ask-user]`, optionally followed by `#<task id>`. The orchestrator parses it like a
mention and records it against a task (§14.3). The task is the one named, else the
`causal_root` of the reply chain, else the author's most recently claimed open task.

Messages authored by `chatroom` are orchestrator summaries (§14.3): they target the user,
cost no credit, and never trigger an agent.

Limits, configurable within hard caps: body 64 KiB; operation file 96 KiB; posts per turn
100; unprocessed operation files per turn 256; delivery batch 64 messages and a
driver-specific token budget.

> **Guard G9.** `@handle` is the one convention. Do not instruct agents to prefer `--to`.

---

## 7. Autonomy budget and scheduling

The budget limits how many agent-authored messages may activate the other agent after the
most recent user message.

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery is `held`; the message stays visible to the user.
- Messages to the user cost nothing. One message costs at most one credit.

Held deliveries are released, and charged once, when the user addresses the held recipient
or everyone, in which case they join that batch free, or when the user raises `/budget`,
in which case they are released in entry order while credit lasts. A user message that
addresses only one agent does not release the other agent's held deliveries.

> **Guard G17.** The asymmetry is intentional: "held" means the other agent tried to activate
> a recipient while the room was out of credit, and only the user re-opening that recipient
> or a deliberate budget change ends it.

States per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. At most one turn is active per agent and conversation; the two
agents run concurrently.

```text
for each agent A:
    triggers = undelivered messages targeted at A, not held
    if triggers is empty: continue
    batch = every undelivered message visible to A through the newest trigger

    if A is idle:
        transactionally create a turn with batch as start inputs; start it
    else if A is running and driver.nativeSteering:
        mark batch publishing; steer the active vendor turn
        on protocol acceptance mark accepted; on rejection return to queued
    else if A is running and driver.hookDelivery:
        mark batch publishing; write delivery files
        accepted when the agent's delivery_ack arrives; returned to queued at turn end if not
    else:
        leave batch queued for the next turn boundary
```

Native acceptance means the vendor process accepted the input, not that the model acted on
it. Both agents start in the same event-loop tick when both have eligible work. Messages
coalesce into bounded batches. Every post gets a receipt even when its target is held.

A task in state `waiting_user` or `escalated` holds agent-to-agent deliveries whose
`causal_root` is that task, with reason `waiting_user`, so no credit is spent circling a
question only the user can answer. They are released, like budget holds, when the user
posts into that task.

> **Guard G11 and G10.** No turn-taking; no discarded replies. When both agents answer at
> once, both replies are recorded and each then receives the other's as its next delivery.

---

## 8. File IPC

> **Guard G14.** Files, never sockets. Measured: a Unix-socket connection from inside the
> Codex sandbox fails with "Operation not permitted", while a file write under a granted
> directory succeeds.

### 8.1 Per-turn environment

The driver builds the child environment from the user's environment, minus every variable
whose name matches `security.env_deny_patterns` (default `*KEY*`, `*SECRET*`, `*TOKEN*`,
`*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`,
`GH_*`, `GITHUB_*`, `NPM_CONFIG_*AUTH*`, `OPENAI_*`, `ANTHROPIC_*`) except names on
`security.env_allow`, plus:

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT` | harness id, `claude` or `codex` |
| `CHATROOM_HANDLE` | the agent's name as mentioned in the chat, `clara` or `phil` |
| `CHATROOM_CONVERSATION` | conversation UUID |
| `CHATROOM_TURN` | Chatroom turn UUID |
| `CHATROOM_OPERATION_DIR` | absolute, exact agent-writable drop directory for this turn |
| `CHATROOM_DELIVERY_DIR` | absolute orchestrator-owned directory, agent-readable |
| `CHATROOM_RECEIPT_DIR` | absolute orchestrator-owned receipt directory |
| `CHATROOM_SCRATCH` | absolute per-turn temp directory, also exported as `TMPDIR` |
| `CHATROOM_BIN` | absolute path of the running executable |
| `CHATROOM_PROTOCOL` | integer agent-command protocol version |
| `GIT_OPTIONAL_LOCKS` | `0`: read-only git commands do not rewrite an index |

The Anthropic key removal is what keeps Claude on the subscription; the rest is a cheap
default. `GIT_OPTIONAL_LOCKS=0` matters for coordination: measured on git 2.54.0, after a
file in the peer's worktree is touched, `git status` run there rewrites the peer's index
without the variable and leaves it alone with it. The Codex driver additionally sets
`shell_environment_policy.ignore_default_excludes = false` and matching filters. The turn's
random directory nonce is part of the path rather than trusted from a payload; identity is
assigned from the driver and the fixed drop root, never from a field in a file.

### 8.2 Operations, receipts, deliveries

`post`, `reply` and `delivery_ack` use one envelope:

```json
{
  "protocol": 3,
  "operation_id": "f7515aa7-ff20-4b9e-807d-12f66157b282",
  "type": "post",
  "created_at": "2026-09-07T10:07:40Z",
  "payload": {"to": ["phil"], "body": "@phil Parser interface is ready.", "reply_to": null}
}
```

The command writes a unique temporary regular file in `CHATROOM_OPERATION_DIR`, fsyncs it,
and renames it to `<operation-id>.json`. Filesystem notifications are latency hints; a
poller is authoritative. The dispatcher renames each entry into `staging/`, checks with
no-follow semantics that it is one bounded regular file, validates protocol, id, turn,
type, targets and UTF-8, imports it transactionally or returns the previous result for a
duplicate id, and writes a receipt `{"protocol": 3, "operation_id": "…", "status":
"accepted", "message_id": 42}` under `to-agent/receipts/` by temp-file-and-rename.
`chatroom post` waits briefly for the receipt and prints `#42`; a local timeout means
"acceptance unknown" and a retry with the same id returns the same result. Before a turn
is finalized, the orchestrator closes the drop root to new imports, drains published files,
waits a short grace period, then retires the directory.

For the hook transport, the orchestrator writes one atomic file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack` operation into the current drop directory; they never move or delete the
delivery file. The orchestrator removes it after the database says it was accepted.

### 8.3 `ask` and `reply`

```sh
"$CHATROOM_BIN" ask "@phil list or iterator?"
"$CHATROOM_BIN" reply 52 "It returns an iterator."
```

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`. A message whose `reply_to`
is the question id resolves it durably (`answered`). The first message from one of the
asked parties that targets the asker after the question is returned immediately as
`probable`, with a note that the correlation is inferred; the question stays open and a
later explicit reply still resolves it. On timeout with no candidate, `indeterminate`. The
timeout is kept below the measured tool-command timeout of each driver.

> **Guard G13.** Return early on the first probable candidate; never let it mark the
> question resolved.

---

## 9. Driver contract and doctor

```ts
type DriverCapabilities = {
  persistentSession: boolean;     // resume by explicit id
  longLivedProcess: boolean;      // several turns per process
  nativeSteering: boolean;        // input accepted into a running turn
  hookDelivery: boolean;          // PostToolUse hook injection
  interrupt: boolean;
  hostApprovals: boolean;         // some approvals reach the REPL
  autoReviewer: "claude_auto" | "codex_auto_review" | "none";
  inspectTurnState: boolean;      // reconcile an ambiguously accepted turn
  structuredEvents: boolean;
  maxDeliveryBytes?: number;
  writeBoundary: boolean;         // doctor: §9.1
  nativeCommit: boolean;          // doctor: a native commit lands on the own branch only
};

interface AgentDriver {
  probe(): Promise<ProbeReport>;
  connect(session: SessionSpec): Promise<DriverCapabilities>;
  startTurn(turn: TurnSpec, input: DeliveryBatch): Promise<VendorTurn>;
  steer(turn: VendorTurn, input: DeliveryBatch): Promise<AcceptedInput>;   // if nativeSteering
  deliverViaHook(turn: VendorTurn, input: DeliveryBatch): Promise<void>;   // if hookDelivery
  inspectTurn(turn: VendorTurn): Promise<TurnReconciliation>;             // if inspectTurnState
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(turn: VendorTurn): Promise<void>;
  events(): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
```

### 9.1 What `chatroom doctor` checks

- Both executables and versions; the git binary and version; `node:sqlite`.
- Claude's session is authenticated with the user's login, not an API key.
- A session starts, ends a turn, and resumes by id; the hook fires and its context reaches
  the model; steering or hook delivery works.
- **Write boundary**, through a shell command and through the harness's native file tool:
  a write inside the own worktree succeeds; writes into the main tree, the peer worktree,
  the integration worktree and the IPC directories fail. `writeBoundary` false refuses that
  agent, because rule 1 of §0.1 is hard for working-tree files.
- **Native commit**: `git commit` in the own worktree lands on the own branch; `main`, the
  peer's branch and the integration ref do not move; whether an approval or Auto-review
  elevation was involved is recorded. `nativeCommit` false does not refuse the agent; it is
  shown in `/status` and the agent is told in its brief that commits are unavailable.

Nothing else is probed.

---

## 10. Claude driver

```text
claude -p \
  --session-id <uuid> | --resume <uuid> \
  --input-format stream-json --output-format stream-json --verbose --include-hook-events \
  --append-system-prompt "<brief>" \
  --settings '<inline JSON, §15.1>' \
  --permission-mode auto --permission-prompts host [--model <model>]
```

Working directory: the conversation's Claude worktree. Environment: §8.1. A turn is one
`user` message on stdin and the `result` event that ends it; the CLI queues further input,
so the driver writes input only when the scheduler starts a turn. `longLivedProcess` true,
so resume happens once per chatroom run; if the process dies the driver reconnects with
`--resume` and reports `session: suspect`. `nativeSteering` false; `hookDelivery` true.
Reply text and cost come from `result`; activity from `assistant` events: `text` blocks,
`tool_use` blocks, `thinking` blocks if present. The system prompt and settings are not
persisted with the session and are passed on every process start. The user's settings,
hooks, MCP servers and `CLAUDE.md` load as they would in solo use.

The hook, registered in the inline settings:

```json
{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` reads the hook event on stdin, drains `CHATROOM_DELIVERY_DIR`, writes a
`delivery_ack`, and if anything was pending prints
`{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<delivery text>"}}`.
Hooks run as ordinary child processes of Claude Code, outside the Bash sandbox, with the
driver's environment. An agent generating text without tool calls hears nothing until its
next tool call or the end of its turn, in which case the batch returns to `queued`.

Auto mode: the classifier decides routine actions; the rest arrive as control requests on
stdout, are recorded with `reviewer: user`, shown in the REPL with a short id, and answered
on stdin. Fallback: one process per turn with the same flags if the long-lived process
fails Phase 0.

> **Guard G2, G3, G5.** CLI on the subscription; `auto` with host-relayed prompts; the hook
> is the injection channel. Everything the Agent SDK offers is a wrapper around these flags,
> and the SDK docs direct SDK users to API keys.

---

## 11. Codex driver

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the profile of §15.2 and the environment policy of §8.1. `turn/start`;
`turn/steer` with `expectedTurnId`; `turn/interrupt`. Streamed items become driver events:
`reasoning` for summaries, `agent_message` for interim text, `command_execution` and
`file_change` for tool activity. Approval requests `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval` and `item/permissions/requestApproval` reach the REPL
when Auto-review escalates or is unavailable; `item/autoApprovalReview/started` and
`/completed` are recorded as evidence when they parse. All names were confirmed in the
schema generated by `codex app-server generate-json-schema` on 0.153.3. Authentication is
the user's existing Codex login, shared by the CLI, app-server and desktop app.

Auto-review is the closest equivalent to Claude's auto mode. Docs: "Auto-review only applies
when approvals are interactive"; with `never` "there is nothing to review". Decisions are
recorded with rationale when observable and as `rationale: unavailable` otherwise;
escalation and unavailability fall back to the user visibly.

Fallback, if app-server probing fails: `codex exec --json -o <file> -c … -` and
`codex exec resume <thread-id> --json -o <file> -c … -`, with the same overrides passed
through `-c`; `exec resume` has no `--cd`, so the working directory comes from spawning in
the worktree. There are no approvals, Auto-review or steering on this path: an action that
would need approval fails, the agent reports it, and the user performs it. Hook delivery
is enabled only when Chatroom's hook is the sole non-managed hook source, because the trust
bypass runs every enabled hook from every layer.

> **Guard G4.** `auto_review` with `on-request` and user fallback on app-server; no
> approvals under `exec`. Do not set `never` on app-server, and do not make the unstable
> Auto-review notifications a precondition for using it.

---

## 12. Turn lifecycle

**Start.** In one transaction, select every undelivered message through the newest
eligible trigger, create the turn, attach ordered `turn_inputs`, mark those deliveries
`publishing`, append `turn_started`. Create the drop and scratch directories. Ensure the
vendor session is connected, resuming by explicit id if needed, and verify its working
directory. Submit the input through the native channel, never as an argument. On
acknowledgment store vendor ids, mark deliveries `accepted`, set the turn `running`. If
spawning or submission fails, the same transaction returns deliveries to `queued`.

**During.** Agent-side posts are imported independently of model output. Eligible messages
for a running agent are steered or hook-delivered per capability. Approval requests stop
only the requesting operation. `/stop` requests protocol interruption, then SIGTERM, then
SIGKILL after grace periods.

**End.** Receive the terminal event and final reply; close and drain the drop root; in one
transaction append the non-empty final reply with idempotency key `final:<turn-id>` and
`via: final`, or `silent` when the reply is empty or exactly `[silent]`, store cost, mark
the turn ended; write pending receipts; return unacknowledged hook deliveries to `queued`;
retire per-turn directories; refresh ref expectations (§16.1); process any marker on the
posted messages (§14.3) and post the summaries it calls for; run the scheduler. A final
reply with no mention targets the user. If the vendor reports no matching active turn for a
steer, or a hook delivery is unacknowledged at turn end, the batch returns to `queued` and
the credit stays charged.

---

## 13. Sessions and recovery

Room transcript, accepted deliveries and workspace snapshots are durable truth. Vendor
sessions are caches with a `generation`. Session ids are always explicit; a picker,
`--last` or `--continue` is never used. A resumed session must report the expected id and
working directory, else it is `lost`.

A session becomes `suspect` when Chatroom cannot prove how an in-flight request ended:
orchestrator crash, SIGKILL, transport loss after acceptance, malformed terminal output.
Recovery: snapshot the worktree; record the interrupted turn and accepted ids; inspect
vendor turn state where the protocol allows; resume by explicit id and verify identity and
directory, which moves the session to `recovering`; send a recovery note as the first
input, listing the interrupted turn, accepted message ids and current workspace diff, with
no queued room work attached; mark `healthy` only after that turn reaches a valid terminal
event; otherwise `lost` and rebuild as a new generation from the brief, the transcript tail
that fits, referenced messages and workspace state, storing the new id after
acknowledgment.

Startup: mark turns left `preparing` or `running` as interrupted; verify the runtime root;
reconcile staged IPC by id; recreate missing delivery or receipt files; quarantine orphans;
classify every `planned` or `executing` git operation step by step (§16.7); refresh ref
expectations and observe `main`; validate the mirror; reconnect sessions last.

> **Guard G16.** Resume before rebuild. Both harnesses write their session logs
> incrementally; discarding a session on every orchestrator crash would throw away the
> agent's working memory for no correctness gain. The recovery turn is the health check.

---

## 14. What agents receive

### 14.1 Delivery format

Used for turn inputs, steering, hook injection and `chatroom inbox`. Readable records, not
JSON; targets remain metadata rows. The header repeats on every delivery so the rules
survive vendor compaction.

```text
[chatroom] You are @clara. 2 new messages. Act on those addressed to you; read the rest as context.
Speak now with "$CHATROOM_BIN" post "..."; ask with "$CHATROOM_BIN" ask "..."; reply exactly [silent] if your posts said everything.

--- #41 · user → @clara @phil · 10:07:12
Implement X.

--- #42 · phil → @clara · 10:07:40 · reply to #41
@clara I'll take the parser; can you take the CLI?

workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230
peer changes since your previous input: src/parser.ts, test/parser.test.ts
tasks: #41 open · criteria #42 · rounds 0/2 · waiting: none
```

The `tasks` line lists every open task touching this agent with its state, so the protocol
of §14.3 survives compaction without the agent keeping its own bookkeeping.

### 14.2 Brief

Supplied on every process start.

```text
You are {Name}, @{me} in a project chat with @user and {Other}, @{other}. Solve the
user's task together. Everything posted is visible to all three of you.

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
- When you claim a task, post "[criteria] #<task>" with three to seven checkable statements
  of what done means. When you receive criteria, check them against what the user asked:
  if they miss part of the request, or a statement cannot be verified, amend them, once.
  After that the criteria stand; the user may amend at any time.
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
  A task allows two blockers; a third is recorded as a suggestion and the chatroom hands
  the task to the user. Do not keep improving past that.

Escalating
- Bring to the user only: behaviour the user will see that the task does not imply;
  interface, dependency or scope changes beyond the ask; anything irreversible;
  conflicting instructions; a disagreement that survived two exchanges. Post "[ask-user]"
  with the question, the options and your recommendation, in at most five lines, then
  work on something else.

Workspace
- Write only in {my_worktree} and the per-turn scratch directory.
- Read {peer_worktree} and the user's main tree {main_tree} when useful; never write there,
  and do not run git commands that modify them. Either may be mid-edit; the chat is where
  intent is stated.
- Your branch is {my_branch}. {commit_note} You may merge the other agent's branch into
  your own branch to verify their work. Never modify, merge into, rebase or reset the
  other agent's branch, main, integration, or any other ref; the user runs integration.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`{commit_note}` is "Commit on it if and when you like; Chatroom snapshots uncommitted work
when it integrates." when `nativeCommit` probed true, and "Committing is unavailable in
this session; Chatroom snapshots your work when it integrates." otherwise. `brief.extra`
from configuration is appended with a visible label, size-capped, never interpolated into
shell code.

> **Guard G7 and G8.** Main and peer readable, own worktree writable, commits optional and
> native. Do not replace main-tree reads with object-id inspection, and do not add commit
> prohibitions or commit-often norms.

### 14.3 Collaboration protocol

The agents run their own work to completion; the user is consulted by rule, not by
default. The protocol has three parts: the norms in the brief above, the markers the
orchestrator recognizes, and four orchestrator behaviours. Nothing in it needs a new
channel: markers are ordinary message text, and summaries are ordinary messages.

**Why it is shaped this way.** Two models asked to review each other's work do not converge
on their own: the verb "review" makes findings the deliverable, "more careful" is always
available, and severity labels drift upward to be heard. The opposite failure is as
likely: a model that is told acceptance is welcome will accept to be agreeable. The
protocol counters both with the same rule, that a verdict must be earned. A blocker costs a
demonstrated failing case and a proposed fix; an accept costs verification of every
criterion, stated per criterion, by the checker's own hands. Neither is the cheap answer,
so the honest answer is the cheapest. Around that rule: criteria are explicit before work
starts and may be challenged once; rounds are capped; and everything the agents should
not decide goes to the user in a form the user can answer in one line.

**Markers.**

| Marker | Meaning | Effect |
|---|---|---|
| `[criteria] #t` | proposed acceptance criteria for task `t` | recorded as the task's criteria; the peer may amend once by posting a new `[criteria]`; the user may amend at any time |
| `[assumption]` | a routine judgment call taken without asking | recorded; visible to the user; no other effect |
| `[settled]` | a decision the agents agree not to reopen | recorded and listed in `/tasks`; the brief forbids reopening |
| `[done] #t` | the author claims the criteria are met and states, per criterion, how it verified them | task `done_claimed`; the peer is triggered to check, whether or not it was mentioned |
| `[accept] #t` | the checker verified every criterion itself and says how, per criterion | task `accepted`; completion summary. An accept that does not address every criterion is recorded as `accept_unverified`: the task stays `done_claimed` and the checker is triggered again, at the normal credit cost, with the missing criterion numbers named in its delivery |
| `[blocker] #t` | a named criterion fails, with the failing case and a proposed fix | task `open`; `review_rounds_used` incremented; the message targets and triggers the done claimant, at the normal credit cost, whether or not it was mentioned. The third blocker on a task is recorded as a suggestion and the task is escalated. A blocker without a failing case is recorded as a suggestion |
| `[suggestion]` | an improvement outside the criteria | collected for the user; never reopens |
| `[ask-user] #t` | a question only the user can answer, with options and a recommendation | task `waiting_user`; the message targets the user regardless of mentions |

**Tasks.** A task is a user message that assigns work, identified by its message id and
carried by `causal_root`. The row is created lazily, by the first valid task marker that
resolves to that user message. The author of the first valid `[criteria]` is the lead;
criteria are numbered, because the evidence gate matches accept notes by number, and an
unnumbered `[criteria]` is rejected with a nudge. When one agent works alone, it posts
`[done]` and the peer performs the acceptance check. A task that never received criteria is
checked against the user's message.

**Transitions.**

| From | Marker | By | To |
|---|---|---|---|
| none | `[criteria]` or `[done]` resolving to a user message | either agent | `open` (row created; first criteria author is lead) |
| `open` | `[done]` | either agent | `done_claimed`; the other agent is the checker |
| `done_claimed` | `[accept]` with a note per criterion | the checker only | `accepted`, terminal |
| `done_claimed` | `[accept]` missing notes | the checker only | `done_claimed`; checker re-triggered |
| `done_claimed` | `[blocker]` with a failing case, rounds used < cap | the checker only | `open`; claimant triggered; rounds + 1 |
| `done_claimed` | `[blocker]`, rounds used = cap | the checker only | `escalated`; recorded as suggestion; summary to user |
| any but `accepted` | `[ask-user]` | either agent | `waiting_user`; agent-to-agent deliveries for the task held |
| `waiting_user` or `escalated` | a user message into the task | user | `open`; holds released |
| `accepted` | any marker | anyone | unchanged; a late or concurrent `[done]` does not reopen; the marker is recorded as a suggestion |

A `[done]`, `[accept]` or `[blocker]` from the wrong author, for example the claimant
accepting its own claim, is recorded as a suggestion and does not transition. `[settled]`
and `[assumption]` never transition.

**Orchestrator behaviours.**

1. **Acceptance trigger.** `[done]` triggers the peer even without a mention, at the usual
   credit cost, because acceptance is part of the work, not a favour.
2. **Evidence gate.** Both verdicts are earned. The check is textual and deliberately
   shallow: an `[accept]` must contain a verification note for each criterion, numbered as
   in the `[criteria]` message, and a `[blocker]` must contain a failing case; the
   orchestrator does not judge the quality of either. Its purpose is to make
   rubber-stamping cost the same effort as checking, and objecting cost the same as
   demonstrating. What it cannot do is make a lazy verification note true; the brief's
   instruction to verify by hand, and the user's reading of the completion summary, do
   that.
3. **Round cap.** A task allows `task.review_rounds` blockers (default 2). The next one is
   recorded as a suggestion and the task is escalated: the orchestrator posts a summary to
   the user with the criteria, what was accepted, the open disagreement, and both agents'
   recommendations.
4. **Completion summary.** On `[accept]`, the orchestrator posts a summary to the user: the
   task, each criterion with the author's and the checker's verification notes side by
   side, the assumptions and suggestions collected, which worktrees hold the result, and
   the `/apply` command that would bring it in. With `task.auto_integrate` (**proposed**,
   default off) it first runs `/integrate` for both agents, so `/apply` is one step. Main
   is never touched without the user.
5. **Escalation and budget summaries.** `[ask-user]` holds that task's agent-to-agent
   deliveries (§7). When the autonomy budget runs out, the orchestrator posts a summary of
   who is waiting on whom and why, instead of leaving held messages silent. Both summaries
   end with what the user can type to continue.

**What goes to the user, by rule.** Behaviour the user will see that the task does not
imply; interface, dependency or scope changes beyond the ask; anything irreversible;
conflicting or ambiguous instructions where reasonable defaults differ; a disagreement
still open after two exchanges. **What does not:** implementation choices, naming, layout,
test structure, and any ambiguity with a reasonable default, taken and recorded as
`[assumption]`.

**What the user sees.** Summaries, `[ask-user]` questions, and the transcript. The user
answers with a plain message into the task, or `/reply <id> …`. `/tasks` lists open tasks,
their criteria, rounds used, settled decisions and pending questions.

> **Guard G24.** The agents manage completion; the user is consulted only for the listed
> cases. Do not add a user checkpoint to the normal flow, do not make acceptance depend on
> the user, do not let a `[suggestion]` reopen a task, and do not make either verdict the
> default: an accept needs per-criterion evidence exactly as a blocker needs a failing case.

---

## 15. The boundary

One rule is hard: an agent writes working-tree files only in its own worktree, the drop
root and the scratch root, and never in Chatroom's coordination state. Everything else is
parity with solo use.

### 15.1 Claude

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyWrite": ["<git common dir>/worktrees/<peer admin dir>",
                    "<git common dir>/worktrees/<integration admin dir>",
                    "<git common dir>/refs/heads/<main branch>",
                    "<git common dir>/refs/heads/chatroom/<p>/<c>/<peer>",
                    "<git common dir>/refs/heads/chatroom/<p>/<c>/integration",
                    "<git common dir>/packed-refs"],
      "denyRead":  ["<security.secret_paths…>", "<main>/.chatroom",
                    "<ipc root>/*/staging", "<ipc root>/<peer>"]
    }
  },
  "permissions": {
    "deny": [
      "Edit(//<main>/**)",            "Write(//<main>/**)",
      "Edit(//<peer worktree>/**)",   "Write(//<peer worktree>/**)",
      "Edit(//<integration worktree>/**)", "Write(//<integration worktree>/**)",
      "Edit(//<ipc root>/**)",        "Write(//<ipc root>/**)",
      "Edit(//<git common dir>/**)",  "Write(//<git common dir>/**)",
      "Read(//<main>/.chatroom/**)",
      "Read(//<secret path>/**)", "…"
    ]
  }
}
```

- **Shell writes** are bounded by the sandbox's default scope, which the docs describe as
  the working directory, added directories and the session temp directory, plus, for a
  linked worktree, "the main repository's shared `.git` directory so commands such as
  `git commit` can update refs and the index. Writes to `hooks/` and `config` inside that
  directory remain denied." That is what makes native commits work.
  `allowUnsandboxedCommands: false` is the one setting that keeps the rule hard; without it
  the classifier could approve a rerun outside the sandbox.
- **`denyWrite` inside the shared `.git`** narrows the allowance to the agent's own admin
  directory, the object store and its own ref. Whether these entries take effect inside
  the automatic allowance is a Phase 0 item; if they do not, git metadata on Claude is
  protected by norm and detection only, and `/status` says so (§15.4).
- **Native tool writes** are denied for the main tree, the peer and integration worktrees,
  the IPC root and the git directory. The agent's own drop file is written by
  `chatroom post` through the Bash allowance, so the IPC deny costs nothing.
- **Native tool reads** of the secret paths and of `.chatroom/` are denied by `Read` rules,
  matching the Bash `denyRead` list; the docs say a Read deny also blocks Edit and Write on
  the same path, and that Grep and Glob honour Read denies on a best-effort basis.
- **Subagents** share the process, rules and sandbox. Network, web tools and MCP servers are
  as the user configured them for solo use.

Default `security.secret_paths`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
`~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`, `~/.codex`,
`~/.config/chatroom`. The two harness homes are the one exposure the chatroom creates that
solo use does not: they hold every other project's transcripts, and here a second model can
read them.

### 15.2 Codex

Passed through the `config` map on `thread/start` and `thread/resume`, or `-c` on `exec`.
Shown as TOML with top-level keys first:

```toml
default_permissions = "chatroom-<nonce>"

[shell_environment_policy]
ignore_default_excludes = false
# filters = { … §8.1 patterns … }
# set = { CHATROOM_AGENT = "codex", …, TMPDIR = "<scratch root>", GIT_OPTIONAL_LOCKS = "0" }

[permissions.chatroom-<nonce>.filesystem]
":root"                                            = "read"
"<own worktree>"                                   = "write"
"<drop root>"                                      = "write"
"<scratch root>"                                   = "write"
"<extra write root…>"                              = "write"
"<git common dir>/worktrees/<own admin dir>"       = "write"
"<git common dir>/objects"                         = "write"
"<git common dir>/refs/heads/chatroom/<p>/<c>/codex"      = "write"
"<git common dir>/refs/heads/chatroom/<p>/<c>/codex.lock" = "write"
"<git common dir>/logs/refs/heads/chatroom/<p>/<c>/codex"      = "write"
"<git common dir>/logs/refs/heads/chatroom/<p>/<c>/codex.lock" = "write"
"<main>/.chatroom"                                 = "deny"
"<ipc root>/*/staging"                             = "deny"
"<ipc root>/<peer>"                                = "deny"
"<secret path…>"                                   = "deny"
```

Measured on 0.153.3 under `codex sandbox`: without the six git entries, `git add` in a
linked worktree fails because the index lock lives in the admin directory outside the
worktree, under the legacy `workspace-write` sandbox and under a worktree-only profile
alike; with them, `git commit` succeeds and `main` does not move. `:root` and `/` are both
accepted as read entries; a deny inside the root read holds; a read entry for a file inside
a write region holds; a profile without a system read grant cannot start `sh`. Precedence
per the docs: "More specific entries override broader entries … deny takes precedence over
write, and write takes precedence over read."

If the profile fails to load, the driver falls back to legacy `workspace-write` with
`writable_roots`, measured to enforce the working-tree boundary; native commits then need
an approval, which Auto-review or the user decides, and `nativeCommit` reflects the
result. Network, web search, apps, MCP servers and nested agents: as the user configured
Codex for solo use.

### 15.3 What is deliberately not here

No read allowlist, no operating modes, no probed guarantee levels beyond §9.1, no network
allowlist, no hosted-tool disabling, no escalation policy, no commit broker, no pointer
verification, no clones. The user runs these harnesses with the same exposure every day.

### 15.4 Git metadata: the stated limitation

Working-tree files are the hard boundary. Git metadata is different: a linked worktree
needs the shared `.git` directory to commit, and that directory also holds the peer's admin
directory, every ref and the object store. Chatroom scopes writes there where the harness
allows it, measured on Codex through the profile, to be measured on Claude through
`denyWrite`, and otherwise relies on the brief's instruction not to touch other refs, on
`GIT_OPTIONAL_LOCKS=0` so that read-only commands do not rewrite a peer's index, on the
expectation checks of §16.1, and on the reflog for recovery. An agent moving another ref
is a norm violation of the same kind the user accepts when running the harness alone.

> **Guard G23 and G1.** State this limitation; do not close it with a commit broker, a
> read-only git directory, a detached checkout or per-agent clones. Those were considered
> and rejected as disproportionate to the parity posture.

---

## 16. Workspaces and Git integration

### 16.0 Git invocation

At startup the orchestrator resolves `git` on `PATH` to a real path (or `git.binary` from
config), records path and version, and uses that path for every command. Every command
names its repository explicitly and never discovers:

```text
<git> --git-dir=<recorded admin dir or common dir> --work-tree=<recorded worktree> \
      -c core.hooksPath=<main>/.chatroom/hooks-empty -c commit.gpgsign=false \
      merge --no-verify --no-gpg-sign --no-autostash --no-rerere-autoupdate --no-ff -m "<message>" <ref>
```

The merge into the user's main worktree is the same with `--no-commit` and no `-m`.
Measured on git 2.54.0: a `pre-merge-commit` hook runs on an unpinned merge and does not
run with this invocation; with `merge.autoStash=true` inherited and no `--no-autostash`, an
overlapping edit that must be refused is stashed and the file overwritten; after rewriting
a worktree's `.git` pointer to a fake repository, discovery follows it while explicit
`--git-dir` does not. Snapshots use `read-tree`, `add`, `write-tree`, `commit-tree` and
`update-ref` under `GIT_INDEX_FILE`, which run no hooks.

> **Guard G20, G22, G12.** Pinned binary, explicit paths, pinned flags.

### 16.1 Refs and expectations

Per conversation: `refs/heads/chatroom/<p>/<c>/{claude,codex,integration}`, all starting
at main's HEAD; `conversations.main_branch_ref` records the main worktree's symbolic
branch at creation. Before every git operation and after every turn, the workspace
manager refreshes its expectations and checks that each agent worktree's `HEAD` still
names its assigned branch.

| Ref | Moved by | Expectation | On deviation |
|---|---|---|---|
| an agent's branch | that agent's commits, and Chatroom's snapshots | `last_seen_oid`, refreshed before each operation | adopted as agent activity. The author cannot be attributed, since both agents commit with the user's identity; movement by the peer is a norm violation recoverable from the reflog. |
| integration | Chatroom only | `last_seen_oid` | `ref_moved` event; integration for the conversation waits for `/adopt-ref integration` or a reflog restore |
| main | the user | `main_observations` | adopted on `/sync`; a changed symbolic branch blocks `/apply` until `/adopt-main` |
| a worktree's `HEAD` | never, once created | the assigned branch | `worktree_detached` event; snapshots and merges for that agent wait for the user |

### 16.2 Snapshot

Used by `/snapshot`, and by `/integrate`, `/sync` and `/apply` as their first step.
User-initiated snapshots refuse while the agent has a turn in flight. Steps, each a
`git_steps` row: `tree_write` (temporary index from the branch's current oid, add the
worktree's tracked and non-ignored untracked files, `write-tree`); if the resulting tree
equals the branch tip's tree, the snapshot is complete with no new commit; otherwise
`commit_write` (`commit-tree` with the message; the candidate oid is persisted before the
next step), `ref_cas` (`update-ref` with the expected old oid), `index_align` (align the
worktree's index without touching files). Ignored files are not captured; staging state is
not preserved. If the agent has its own commits, the snapshot sits on top of them.

### 16.3 `/integrate <agent>`

Refuses while the agent has a turn in flight. Snapshot the agent; in the integration
worktree, merge the agent branch with the single pinned form and a generated message;
record the oid and refresh expectations. Conflict: `abort` step in the integration
worktree, operation `needs_user`, paths reported.

### 16.4 `/sync <agent|all>`

Refuses while the agent has a turn in flight. If main's observed HEAD is not an ancestor of
integration, merge `main` into integration first and record the observation. Snapshot the
agent; merge integration into the agent branch in the agent's worktree with the single
pinned form. A conflict is `needs_user`; in the first release the only resolution is
`/sync --abort <agent>`, which runs the abort step and leaves the pre-sync snapshot as the
branch tip. Manual resolution in the agent worktree is not supported, because committing it
would move a Chatroom ref outside the orchestrator. `/import <source> <destination>` is
integrate source, then sync destination.

### 16.5 `/apply [agent]`

`/apply <agent>` is integrate then apply. Steps in the user's main worktree, invoked with
`--git-dir=<common dir> --work-tree=<main worktree>`:

1. **Preconditions**, for clear messages only: the integration ref exists and is not an
   ancestor of HEAD; the index equals HEAD; no `MERGE_HEAD`, `REBASE_HEAD` or
   `CHERRY_PICK_HEAD`; main's symbolic branch equals the recorded one, else `needs_user`
   until `/adopt-main`; integration matches its expectation.
2. **Preflight** (`preflight` step): compute the paths the merge would change from the
   merge base to the tip. Every path it would add or rename to must not exist in the
   working tree, whether tracked, untracked or ignored; every path it would modify or
   delete must be clean against HEAD. Measured: git alone overwrote an ignored file in the
   way of a tracked path, with and without `--no-overwrite-ignore`, under both merge
   strategies, so this check is Chatroom's own. The main worktree is assumed quiescent
   between preflight and merge within one process; across a crash it is not, and recovery
   reruns preflight (§16.7).
3. **Merge** (`merge` step): the pinned invocation with `--no-commit`. Record git's outcome
   verbatim and the post-merge index (`ls-files -s`, including conflict stages) in the same
   transaction as the step result. Operation `needs_user` while `MERGE_HEAD` exists.

Measured with git 2.54.0 and the pinned invocation:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Proceeds; edit preserved; tip changes staged |
| Unstaged edit on a file the tip changes | Refused by preflight and by git: "Your local changes … would be overwritten"; tree unchanged |
| Untracked or ignored file the tip would create | Refused by preflight; git alone would overwrite the ignored case |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge; ancestry is shared |

The user reviews with `git diff --cached` and commits, or runs `/apply --abort`.

**`/apply --abort`**: compare the current index with the recorded post-merge index. If no
post-merge index was recorded, because the process died between the merge and its
transaction, stop with `needs_user`. If the index differs, stop with `needs_user` and list
the paths. Measured: `git merge --abort` silently discards a change staged after the merge
to an unrelated file, and likewise discards a pre-existing dirty file that was staged after
the merge; unstaged changes to unrelated files survive; an unstaged edit to a file the merge
changed makes abort fail with "not uptodate". If the index is unchanged, run
`git merge --abort`; a nonzero exit is `needs_user` with git's message, never a retry. The
man page's warning that abort "will in some cases be unable to reconstruct the original
(pre-merge) changes" applies to unusual dirty-tree states; those are the user's to manage,
as with git alone. `/apply --commit` (**proposed**) commits at once.

> **Guard G12.** Native merge, pinned, explicit paths, Chatroom's own collision preflight,
> abort refuses on a changed or unrecorded index. No synthetic commit, applied-oid marker,
> per-path journal, backup ref or per-path state: each was considered and each is
> disproportionate under G1.

### 16.6 `/adopt-main`, `/adopt-ref`, cleanup

`/adopt-main` records main's current branch and HEAD as the new baseline in one
transaction. `/adopt-ref integration` records integration's current oid as expected after
the user has inspected it. `chatroom clean` snapshots and removes worktrees, keeping
conversations and refs; `chatroom reset` removes everything Chatroom owns after
confirmation, refusing while any worktree is dirty and unsnapshotted.

### 16.7 Recovery

On startup, for every operation left `planned` or `executing`, each step is classified:

| Step | Classification |
|---|---|
| `tree_write`, `preflight` | rerun |
| `commit_write` | `candidate_oid` recorded and the object exists: done; else rerun |
| `ref_cas` | ref equals expected old: rerun with the candidate; equals candidate: done; else `needs_user` with both oids |
| `index_align` | index tree equals the ref's tree: done; else rerun |
| `merge` in a Chatroom worktree | merge commit with the expected parents: done; `MERGE_HEAD` present: abort, `failed`; ref unchanged, no `MERGE_HEAD`: rerun |
| `merge` in main | `MERGE_HEAD` present: `needs_user`; a merge commit with the tip as second parent exists on the branch above the recorded HEAD: done by the user; HEAD unchanged and index equals HEAD: rerun **after a fresh preflight**; else `needs_user` |
| `abort` | `MERGE_HEAD` absent: done; else rerun the index check and, if it passes, abort; nonzero exit is `needs_user` |

A `MERGE_HEAD` in main with no Chatroom operation is not Chatroom's and is never touched.

> **Guard G21.** Classify by oids and recorded states; never assume an abort is possible;
> never rerun a main merge without a fresh preflight.

---

## 17. Conversations, REPL, configuration

Conversations: `chatroom` opens the current one, creating one when none exists;
`chatroom new [name]` creates a conversation, its refs and worktrees and records main's
branch; `list`, `continue <name-or-id>`. Switching stops or waits for active turns,
snapshots both worktrees, and disconnects drivers.

`chatroom delete <name-or-id>` is destructive and follows the posture of `reset`: it stops
both agents; snapshots each dirty worktree, or refuses if a snapshot fails; verifies every
Chatroom ref against its expectation and refuses on a mismatch; reports the commits on the
agent branches that integration does not contain and the integration commits that main
does not contain; shows the exact worktree paths and refs to be removed; and requires
explicit confirmation, or `--yes` in a non-interactive shell. Only then does it remove the
worktrees, the refs, the IPC and log directories, and the rows. One session per harness
per conversation; sessions are isolated from the user's own because they live in
conversation worktrees and are resumed only by explicit id, and the docs state that
`--continue` finds the most recent session in the current directory.

REPL: line-oriented; concurrent output redraws the input line without losing text; plain
input is a user message; multi-line input is fenced with a line containing only `"""`;
relayed approvals get short ids and are answered asynchronously.

```text
#42 phil → @clara                                         10:07  post
  @clara Parser interface is ready; can you take the CLI?
    · clara: Edit src/cli.ts
    · phil ✓ auto-review approved: npm test (low risk)

!p3 phil requests network access to registry.npmjs.org
clara: working · phil: waiting p3 · budget 1/6 · integration +2 · parser
> _
```

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, turns, held deliveries, permissions, refs and expectations, worktree attachment, main's branch, git binary, native-commit availability. |
| `/stop <agent\|all>` | Protocol interrupt, then SIGTERM, then SIGKILL. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a relayed approval request. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2; refuses while the agent runs. |
| `/integrate <agent>` | §16.3 |
| `/sync <agent\|all>`, `/sync --abort <agent>`, `/import <src> <dst>` | §16.4 |
| `/apply [agent]`, `/apply --abort`, `/apply --commit` | §16.5 |
| `/adopt-main`, `/adopt-ref integration` | §16.6 |
| `/tasks` | Open tasks with criteria, rounds used, settled decisions, assumptions, suggestions and pending questions (§14.3). |
| `/reply <id> <text>` | Answer a specific message, typically an `[ask-user]` question; releases that task's held deliveries. |
| `/show quiet\|activity\|full`, `/focus <agent\|all>`, `/history [N]` | Display. |
| `/doctor` | §9.1 |
| `/quit` | Stop turns, flush, release the lock. |

External: `chatroom log [--jsonl] [--verify]`, `doctor`, `clean`, `reset`, and the
agent-only `post`, `reply`, `ask`, `inbox`, `hook`, which refuse to run unless every
required `CHATROOM_*` variable and the protocol version are present.

Configuration, TOML, project overriding global:

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Cross-agent activations after user input. |
| `turn.timeout_minutes`, `turn.stop_grace_seconds` | `30`, `5` | Turn limits. |
| `ask.timeout_seconds` | `60` | Below the measured tool timeout. |
| `task.review_rounds` | `2` | Blockers per task before escalation to the user (§14.3). |
| `task.auto_integrate` | `false` | Proposed: run `/integrate` for both agents on acceptance. |
| `agents.claude.handle`, `agents.codex.handle` | `clara`, `phil` | The agents' names in the chat (§6). Paths and refs use the harness ids. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.long_lived` | `true` | One process per session. |
| `driver.codex.prefer_app_server` | `true` | App-server before `exec`. |
| `driver.codex.approval_policy`, `driver.codex.approvals_reviewer` | `on-request`, `auto_review` | G4. |
| `git.binary` | resolved from `PATH` | Override the git executable. |
| `security.secret_paths` | §15.1 list | Denied read paths, both harnesses, shell and native. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_deny_patterns`, `security.env_allow` | §8.1 defaults, empty | Environment scrub. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; `autoAllowBashIfSandboxed`. |
| `logging.raw_events`, `logging.retention_days` | `false`, `30` | Raw vendor streams. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Project guidance appended to both briefs. |
| `workspace.state_dir`, `workspace.link_worktrees` | platform default, `true` | Runtime root; proposed symlink. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn.

Activity kinds: `text`, `reasoning_summary`, `tool`, `tool_result`, `permission`, from
`assistant` events on Claude and `item.*` events on Codex. Raw vendor streams are off by
default, size-capped, and removable. Chatroom never records environment-variable values.

---

## 18. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Session suspect; resume and recovery turn; rebuild if that fails. |
| Crash after message commit, before scheduling | Rows remain queued. |
| Crash during a git operation | Steps classified per §16.7; nothing reset; a main merge is never rerun without a fresh preflight. |
| Duplicate event or post retry | Original receipt returned. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, rejection event. |
| Steering or hook delivery races turn end | Return to queued; no second charge. |
| Driver exits nonzero | Preserve stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild as a new generation. |
| Integration or main moved unexpectedly | `ref_moved`; integration waits for `/adopt-ref` or a reflog restore; `/apply` waits for `/adopt-main`. |
| Agent worktree detached from its branch | `worktree_detached`; that agent's git operations wait for the user. |
| Apply refused by preflight or git | Main unchanged; paths or git's message shown. |
| Index changed or unrecorded after the merge | `/apply --abort` refuses and lists paths or asks for manual abort. |
| `git merge --abort` exits nonzero | `needs_user` with git's message. |
| Sync conflict | `needs_user`; `/sync --abort` only in the first release. |
| Write-boundary or login check fails | That agent does not start. |
| Native commit unavailable | Shown in `/status`; the brief tells the agent. |
| Codex profile fails to load | Legacy `workspace-write` with `writable_roots`, noted once; commits need approval. |
| Auto-review unavailable on app-server | User review, visibly. |
| Approval needed under `codex exec` | The action fails; the user performs it. |
| Budget exhausted | Trigger held; a summary of who waits on whom is posted to the user. |
| Task exceeds the review-round cap | Further blockers become suggestions; the task is escalated with a summary. |
| `[ask-user]` posted | Task waits; its agent-to-agent deliveries are held until the user posts into it. |
| Agents disagree past two exchanges | The raiser escalates by rule; the brief tells both to move on meanwhile. |
| Database corruption | Stop; preserve files; never rebuild authority from the mirror. |
| JSONL mirror inconsistent | Rewrite from SQLite. |
| Disk full | Stop accepting messages before acknowledging them. |

---

## 19. Verification ledger

### Measured on the development machine

- **Codex 0.146.0 and 0.153.3, legacy `workspace-write`:** writes inside cwd succeed;
  outside fail; under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; in a linked
  worktree, `git add` fails because the index lock lives in the admin directory.
- **Codex 0.153.3 profiles, under `codex sandbox`:** `:root` and `/` accepted as read
  entries; a deny inside the root read holds; a read entry for a file inside a write
  region holds; a profile without a system read grant cannot start `sh`; a worktree-only
  profile cannot `git add` in a linked worktree; a profile that also grants the own admin
  directory, `objects/` and the own ref and reflog commits successfully and `main` does not
  move; a `default_permissions` override took effect with `sandbox_mode` loaded from the
  config file.
- **Codex 0.153.3 CLI:** `codex exec resume` has no `--cd` or `--sandbox`; the app-server
  schema defines `thread/start`, `thread/resume`, `turn/start`, `turn/steer` with
  `expectedTurnId`, `turn/interrupt`, the three `requestApproval` methods, the
  `autoApprovalReview` notifications, and `ApprovalsReviewer` with `auto_review`.
- **Claude 2.1.261:** flags `--settings`, `--permission-prompts host|none`,
  `--permission-mode auto`, `--include-hook-events`, `--session-id`, `--resume`,
  `--input-format stream-json`.
- **Node 25.1.0:** `node:sqlite` loads with an experimental warning.
- **git 2.54.0:** the six `/apply` states; `merge.autoStash` defeats the overlap refusal
  without `--no-autostash`; a `pre-merge-commit` hook runs unpinned and not pinned; an
  ignored file in the way is overwritten with and without `--no-overwrite-ignore`; abort
  discards changes staged after the merge and keeps unstaged ones, and fails on an unstaged
  edit to an affected file; explicit `--git-dir` ignores a rewritten `.git` pointer; a
  broker-style snapshot through explicit paths works; `git status` in a touched peer
  worktree rewrites its index without `GIT_OPTIONAL_LOCKS=0` and not with it. Two git
  binaries on `PATH`, 2.50.1 and 2.54.0.

### Documented

- **Claude Code sandboxing:** Bash-only OS sandbox; default write scope is the working
  directory, added directories and the session temp directory; the linked-worktree
  allowance quoted in §15.1; "When read rules overlap, the more specific path wins";
  `allowWrite` accepts absolute and `~/` paths.
- **Claude Code permissions:** `Read(//path)` and `Edit(//path)` rules; "A Read deny rule
  also blocks the Edit and Write tools on the same path"; Grep and Glob apply Read denies
  best-effort; deny rules take precedence over allow.
- **Claude Code hooks and headless:** inline `--settings` JSON; `PostToolUse`
  `additionalContext` appended to the tool result; streaming input queues messages.
- **Claude Code sessions:** per-working-directory storage; `--continue` scoped to the
  directory.
- **Claude Agent SDK:** claude.ai login not permitted for SDK agents.
- **Codex configuration:** `shell_environment_policy.inherit` default `all`;
  `ignore_default_excludes` default true, "Keep variables containing KEY, SECRET, or
  TOKEN"; `mcp_servers.<id>.enabled`; `apps.<id>.enabled`; `web_search`; `agents.enabled`.
- **Codex permissions:** `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; the precedence sentence quoted in §15.2; Beta; "Configure either
  `default_permissions` and `[permissions]`, or `sandbox_mode` … but not both."
- **Codex Auto-review:** requires interactive approvals; `never` leaves nothing to review.
- **Codex app-server:** experimental; the per-thread `permissions` parameter is
  experimental and is not used.
- **git-merge:** `--abort` "will in some cases be unable to reconstruct the original
  (pre-merge) changes"; `--no-overwrite-ignore` is documented to abort.

### Phase 0

1. `node:sqlite` durability suite on the oldest supported Node LTS.
2. Claude: several sequential turns in one `-p` stream-json process; `--resume` later; the
   hook fires from inline `--settings` and reaches the model; control request and response
   wire shapes; `thinking` blocks; the login check.
3. Claude boundary: a shell write inside the worktree succeeds, into main, peer,
   integration and IPC fails; native Edit of those refused; native Read of a secret path
   refused; `git commit` in the worktree works and only the own branch moves; whether the
   `denyWrite` entries inside the shared `.git` take effect.
4. App-server: the §15.2 overrides accepted through `config`; the effective policy reports
   the profile with the user's real `config.toml` present; Auto-review accepted; a routine
   command auto-approved; an escalation reaches `requestApproval`; `git commit` in the
   worktree works without an elevation and only the own branch moves; `turn/steer` against
   a finishing turn; the legacy fallback when the profile fails, including whether a commit
   then needs approval.
5. Codex `exec` fallback with `-c` on start and resume, including the commit test.
6. Kill mid-generation and resume on both harnesses; tool-command timeouts.
7. Recovery classification against a crash injected after each step of every operation,
   including a crash between a main merge and its transaction.

---

## 20. Testing

- **Model-free core tests** with fake drivers: the invariants of §2 under crash injection at
  every boundary.
- **IPC security tests**: partial, duplicate, hard-linked, symlinked, directory, FIFO,
  sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn cases.
- **Boundary tests**: the write-boundary and native-commit checks of §9.1 on both harnesses,
  positive and negative, through shell and native tools.
- **Git matrix**: file kinds including symlinks, mode changes and deletions; snapshots over
  agent commits, including the no-change case producing no commit; sequential integrations;
  both agents on the same and different files; main advancing before `/sync` and before
  `/apply`; the six `/apply` states; repeated apply after commit; abort with a changed, an
  unchanged and an unrecorded index, and with a nonzero git exit; sync conflicts and their
  abort; a detached worktree; crash after each step of every operation with §16.7
  classification; hooks never run; autostash never engages; signing never attempted;
  discovery never used.
- **Protocol tests** with fake drivers: marker parsing, lazy task creation and lead
  selection; every row of the transition table, including wrong-author markers and a late
  `[done]` on an accepted task; `[done]` triggers the peer and a valid `[blocker]` triggers
  the claimant without a mention; an `[accept]` missing a criterion's note is recorded as
  unverified and re-triggers the checker with the numbers; a `[blocker]` without a failing
  case becomes a suggestion; the third blocker becomes a suggestion and escalates;
  `[ask-user]` holds that task's deliveries and a user reply releases them; summaries
  target the user, cost nothing and trigger nobody.
- **Mirror tests**: partial lines, malformed JSON, missing or duplicate records, rewrite.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 21. Implementation

TypeScript on the Phase-0-verified Node LTS range; `node:sqlite` if it passes. Vendor types
stop at the adapter boundary.

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

The agent-command entry path imports neither the REPL, the drivers, the workspace manager,
nor a writable database connection.

---

## 22. Build order

**First usable release: phases 0 to 5.**

0. **Spikes** for every Phase 0 item in §19, later folded into `doctor`. Exit: every
   first-release driver claim has a recorded fixture.
1. **Durable room core**: schema, migrations, mirror, targets, deliveries, budget, startup
   reconciliation, fake drivers, property tests. Exit: crash injection cannot lose or
   duplicate logical messages.
2. **IPC and agent commands**: layout, import, receipts, retry, limits, quarantine, the five
   agent commands, security suite. Exit: every accepted operation has one durable result
   and no orchestrator path can be redirected by an agent-controlled entry.
3. **Drivers**: Claude in auto mode with the hook; Codex app-server with Auto-review and
   steering; `exec` fallback; scrubbed environment; minimal recovery. Exit: both agents
   chat concurrently and receive a mid-turn message.
4. **Worktrees and the boundary**: runtime roots, Claude settings, Codex profile with legacy
   fallback, the doctor checks. Exit: each agent edits, tests and commits in its own
   worktree, cannot write main, the peer, integration or IPC, and only its own branch moves.
5. **Git collaboration**: pinned explicit-path git, snapshots, `/integrate`, `/sync`,
   `/import`, `/apply` with preflight and abort, adopt commands, step recovery, the Git
   matrix. Exit: the six `/apply` states behave as measured and every abort either
   succeeds cleanly or stops with the reason.
6. **Later**: sync conflict resolution through the orchestrator; checkpoints; archive and
   `gc`; `/review`; `/apply --commit`; rendering polish.

> **Guard G18.** Keep the cut line.

---

## 23. Open decisions

1. `/apply --commit` (proposed) and its message format.
2. Raw activity defaults during adapter development.
3. Sync conflict resolution route for a later release: `/sync --resolve <agent>`, where the
   user resolves files and the orchestrator commits, versus a `/resolve` agent turn.
4. Inactive worktree policy.
5. Convenience symlink (proposed).
6. Whether to prefer `/` over `:root` in the Codex profile once app-server confirms both.
7. Whether `security.secret_paths` should include `.env` files outside the worktrees.

---

## 24. References

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex permission profiles: https://learn.chatgpt.com/docs/permissions
- Codex Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- git-merge and git-worktree manuals: `git merge --help`, `git worktree --help`

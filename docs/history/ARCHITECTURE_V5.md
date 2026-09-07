# Chatroom Architecture v5

Status: design draft, 2026-09-04. Standalone; supersedes `ARCHITECTURE.md` (v1),
`ARCHITECTURE_V2.md`, `ARCHITECTURE_V3.md` and `ARCHITECTURE_V4.md`. No code exists yet.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0.
Versions are evidence for the smoke tests, not compatibility promises. Section 22 lists what
was measured, what is documented, and what remains to be verified.

How to read this document:

- **Comment** blocks explain why a decision stands or what changed from an earlier revision.
- **Guard** blocks mark decisions that a later revision must not reverse without the user's
  explicit approval. Each cites its evidence: a user decision, a measurement on this machine,
  or a quoted documentation sentence. If a later revision believes a guarded decision is
  wrong, it must say so in its change list and quote the guard, rather than silently
  redesigning around it. Section 0.1 indexes all guards.
- **Proposed** marks items the user has not explicitly decided; they can be dropped.

---

## 0. Changes from v4

1. **Read boundary is a denylist, not an allowlist.** v4 denied reads of the whole filesystem
   and re-opened a minimal set. Toolchains on this machine live in the home directory and
   package managers need writable caches, so v4's strict mode could not build a real project
   and the user would have fallen back to compatible mode, where v4 guaranteed nothing. v5
   denies known secret locations and keeps toolchains readable; caches are made writable by
   configuration.
2. **Claude's native file tools stay enabled.** v4 disabled Read, Grep, Glob, Edit and Write
   in strict mode on the claim that they had no verifiable boundary. The permissions docs
   provide path-scoped `Read(...)` and `Edit(...)` deny rules with absolute-path syntax, state
   that a Read deny also blocks Edit and Write, and that Grep and Glob honour Read denies.
3. **The external runtime root stays, for a different reason.** v4 moved worktrees and IPC
   out of the repository because "deny-first permission systems cannot reliably reopen
   children". For the OS sandbox that is false: both vendors document that a narrower entry
   re-opens a denied region. It is nevertheless right to keep worktrees outside the main tree,
   because Claude's *permission rules* are deny-wins: an `Edit(//<main>/**)` deny would also
   cover a worktree nested beneath it. A convenience symlink is proposed for discoverability.
4. **Main tree readable; commits allowed.** v4 hid the main tree behind object ids and forbade
   commits. Both contradict user decisions. Agents read main and the peer worktree, write only
   their own, and may commit or not.
5. **Codex runs on Auto-review; Claude on auto mode.** User decision. Codex's
   `approvals_reviewer = "auto_review"` with `approval_policy = "on-request"` is the closest
   equivalent to Claude's `auto` permission mode: routine actions are decided automatically,
   the rest reach the user. Human review is the fallback when Auto-review is unavailable.
6. **Strict mode is defined on stable interfaces and degrades visibly.** v4 made the default
   mode depend on app-server (experimental), permission profiles (beta), the experimental
   per-thread `permissions` parameter and unstable Auto-review notifications, and refused to
   start if any failed. v5 passes the profile through ordinary config overrides, treats
   Auto-review rationale as optional evidence, and lets strict mode run with a visible list
   of which guarantees are active.
7. **`/apply` without the synthetic commit.** The dirty-path rule already rejects any path the
   user modified, so merging the integration tip into a clean checkout of main's HEAD yields
   the same delta on every accepted path. The private object overlay is dropped. The per-path
   journal and crash classification stay.
8. **`ask` returns early on a probable answer** instead of holding until timeout. Durable
   resolution still requires an explicit `reply <id>`.
9. **Source review moves out of the first release.** `/review` and Auto-review are different
   features; only the latter is in scope now.
10. **Regression guards added** throughout, indexed below.

Kept from v4 without change of substance: SQLite authority with full mirror validation,
delivery records, idempotent operations and receipts, split-ownership IPC, capability
probing, per-conversation workspaces, snapshots, integration branch, `/sync` with main
fold-in, journaled apply, suspect-session recovery with a recovery turn, Phase 0, and the
autonomy budget.

### 0.1 Regression guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; SDK docs: "Anthropic does not allow third party developers to offer claude.ai login … including agents built on the Claude Agent SDK." |
| G2 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G3 | Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, falling back to the user visibly. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G4 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: streaming input "queued messages … process sequentially"; hook `additionalContext` "appended to the tool result". |
| G5 | Claude's native Read, Grep, Glob, Edit and Write stay enabled; the boundary is path deny rules. | Claude permissions docs: `Read(//path)` and `Edit(//path)` rules exist; "A Read deny rule also blocks the Edit and Write tools on the same path"; Grep and Glob honour Read denies. |
| G6 | Reads are denylisted, not allowlisted; toolchains stay readable; caches writable via config. | Usability; Claude docs: "the deny holds inside a wider allow"; Codex docs: "deny takes precedence over write, and write takes precedence over read." |
| G7 | Worktrees and IPC live outside the main tree. Reason: Claude permission rules are deny-wins, so a main-tree Edit deny would cover a nested worktree. Not because of sandbox precedence. | Claude permissions docs: deny rules take precedence; sandboxing docs: "the narrower allow re-opens that part of the denied region." |
| G8 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G9 | No commit norms. Agents may commit or not; Chatroom snapshots regardless. | User decision. |
| G10 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G11 | When both agents answer at once, both replies are recorded; none is discarded. | User decision. |
| G12 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G13 | `/sync` folds main into integration; `/apply` merges the tip into a clean checkout of HEAD and applies the delta under the dirty-disjoint rule; no synthetic commit of the dirty tree. | Analysis in §16.5. |
| G14 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency; v4's correlation invariant kept. |
| G15 | Strict mode never depends on an experimental parameter or an unstable notification to start; it degrades visibly. | Docs: app-server "experimental … not supported for production workloads"; profiles "Beta … may change"; schema: auto-review notifications "[UNSTABLE]". |
| G16 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex sandbox denies Unix-socket connections. |
| G17 | Zero footprint: nothing written to tracked files, CLAUDE.md, AGENTS.md, `.claude/`, `.codex/` or `.gitignore`. | User decision. |
| G18 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | v3 review; both harnesses persist turns incrementally. |
| G19 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry, §7.1. |
| G20 | First-release cut line: Phase 0, phases 1 to 4, snapshot, integrate, apply. Source review, checkpoints and archive come later. | Scope control. |

---

## 1. Purpose

Chatroom is a terminal group chat with three participants:

- the user;
- Claude, through the Claude Code CLI in auto mode;
- Codex, through the Codex App Server with Auto-review, with the Codex CLI as fallback.

All participants see every message. Addressing says who is expected to act; it does not
make a message private. Claude and Codex work concurrently, coordinate while working, and
inspect one another's work and the user's main tree. Each agent writes only to its own Git
worktree.

`chatroom` is one globally installed command. A repository opts in when the command is run
inside it. Chatroom creates durable authority under `.chatroom/`, agent runtime data under
the platform's per-user state directory, and Chatroom-owned Git refs and worktrees. It does
not change tracked project files, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, or
`.gitignore`. Plain `claude` and `codex` sessions remain independent, and Claude keeps
running on the user's subscription.

### 1.1 Non-goals for the first release

- More than Claude and Codex as agents.
- A graphical or full-screen interface.
- Remote or multi-user chatrooms.
- Exactly-once execution of model tool calls.
- Isolation from a deliberately hostile operating-system user.
- Native Windows. Supported targets are macOS, Linux and WSL2.
- Source review (`/review`), checkpoints, archive and `gc` (later phases, §25).

---

## 2. Principles and invariants

These are implementation requirements.

1. **One durable authority.** SQLite wins over any derived file, including the JSONL mirror.
2. **One database writer.** Only the orchestrator connection mutates the database.
3. **Monotonic room order.** Every message and event receives one increasing `entry_id` in
   the transaction that creates it. Display order is `entry_id`, never wall-clock time.
4. **At-least-once transport, idempotent acceptance.**
5. **No state rollback.** Recovery moves forward from durable facts.
6. **No orchestrator writes under agent control.**
7. **A message is durable before it is visible.**
8. **A budget decision is deterministic.**
9. **A conversation maps to stable session and workspace identities.** Session resume
   never guesses by recency or working directory.
10. **Main-tree mutation is explicit and recoverable.** `/apply` is the only normal
    operation that edits the user's main worktree.
11. **Safety settings are pinned and probed.** A driver's effective boundary is verified by
    read and write attempts through both shell and native tools.
12. **Adapters are capability-based.** Vendor versions are diagnostics; behaviours are
    probed and recorded.
13. **Zero footprint.** Briefs, hooks, settings and sandbox configuration reach each harness
    through its invocation. (G17)
14. **Subscription-preserving.** The Claude driver uses the same login and billing as the
    user's own `claude` sessions. (G1)
15. **Reviewers are not boundaries.** Human approval and Codex Auto-review decide only
    within independently enforced path, network and ownership rules.
16. **Secrets denied, tools open.** Strict mode denies reads of known secret locations and
    writes outside the declared boundary. It does not restrict toolchains, caches or the
    project's own files. (G6)
17. **Native tools stay native.** Claude's built-in file tools are constrained by path rules,
    not disabled. (G5)
18. **Unstable interfaces are optional capabilities.** Strict mode can start on stable
    interfaces alone; experimental parameters and unstable notifications add evidence, not
    prerequisites. (G15)

---

## 3. System overview

```text
 ┌────────────────────────────── chatroom process ──────────────────────────────┐
 │                                                                              │
 │  REPL                                                                        │
 │    transcript · activity · permissions · status · slash commands             │
 │                         │                                      ▲             │
 │                         ▼                                      │             │
 │  Orchestrator                                                                │
 │    room order · scheduler · autonomy budget · recovery · integration         │
 │        │                 │                   │                               │
 │        ▼                 ▼                   ▼                               │
 │  Store               IPC dispatcher       Workspace manager                  │
 │  (node:sqlite, WAL   (files + receipts)   (snapshot/integrate/sync/apply)    │
 │   + JSONL mirror)                                                            │
 │        ▲                 ▲                   ▲                               │
 │  ┌─────┴────────────┐    │          ┌────────┴────────┐                      │
 │  │ Claude driver    │    │          │ Codex driver    │                      │
 │  │ claude -p, auto  │    │          │ codex app-server│                      │
 │  │ stream-json i/o  │    │          │ JSON-RPC stdio  │                      │
 │  └─────┬────────────┘    │          └────────┬────────┘   auto-review        │
 └────────┼─────────────────┼───────────────────┼───────────────────────────────┘
          │ stdin turns +   │ agent-side files  │ turn/start, turn/steer
          │ PostToolUse hook│                   │
          ▼                 ▼                   ▼
   Claude worktree     from-agent/to-agent   Codex worktree
```

### 3.1 Components

| Component | Responsibility |
|---|---|
| REPL | User input, transcript rendering, activity streams, permission decisions, commands. |
| Orchestrator | The single state machine and database writer. Resolves targets, schedules work, reserves autonomy credits, coordinates recovery. |
| Store | Schema, migrations, transactions, queries, JSONL mirror. |
| IPC dispatcher | Imports agent operations, writes receipts and deliveries, enforces idempotency and limits, retires turn directories. |
| Driver | Starts or resumes one vendor session, submits turns, delivers mid-turn messages by the means the harness supports, normalizes events, relays approvals, stops work. |
| Workspace manager | Creates conversation worktrees, snapshots uncommitted changes, merges into and out of the integration branch, performs journaled main-tree updates. |
| Agent-side command | A fast subcommand of the same executable: `post`, `reply`, `ask`, `inbox`, `hook`. Uses only paths and capabilities supplied in its environment. |

---

## 4. Project identity, locking, and disk layout

### 4.1 Project identity

Chatroom resolves `git rev-parse --show-toplevel` and
`git rev-parse --path-format=absolute --git-common-dir`. The canonical common Git directory
is hashed into a `project_id`, so a symlinked path or linked worktree cannot create a second
orchestrator for the same repository. Chatroom refuses to start from one of its own managed
worktrees.

The project lock is an advisory OS lock held on an open file descriptor. A second process
fails immediately with the owner's information.

### 4.2 Global files

```text
<install>/chatroom                         executable or launcher
~/.config/chatroom/config.toml             optional defaults
<platform-state>/chatroom/projects/        runtime roots by project id
```

The orchestrator resolves its own real executable path at startup and passes it to agents
as `CHATROOM_BIN`. Hooks never rely on an unqualified `chatroom` found through a
project-controlled `PATH`.

### 4.3 Per-project authority (`.chatroom/`)

```text
<project>/
  .chatroom/
    lock
    config.toml
    chatroom.sqlite3                       authority
    chatroom.sqlite3-wal / -shm
    transcript/<conversation-id>.jsonl     derived mirror, appended on every commit
    logs/<conversation-id>/                raw vendor events, opt-in
    recovery/<operation-id>/               manifest and patch of an apply in progress
    worktrees -> <runtime root>/worktrees  proposed: convenience symlink for the user
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a
real directory beneath the project root. The directory is mode `0700`; database and log
files are `0600`. Agents have no read access to `.chatroom/` (§15).

### 4.4 Per-project runtime root

`<platform-state>` is the OS per-user state directory, resolved without consulting the
project environment. The runtime root is keyed by `project_id`:

```text
<platform-state>/chatroom/projects/<project-id>/
  ipc/
    claude/
      from-agent/<turn-id>-<nonce>/        exact agent-writable drop root for a turn
      to-agent/deliveries/                 orchestrator-owned, agent-readable
      to-agent/receipts/                   orchestrator-owned, agent-readable
      scratch/<turn-id>-<nonce>/           agent-writable temp root; never imported
      staging/                             orchestrator-owned quarantine
    codex/  (same)
  worktrees/<conversation-id>/{claude,codex}/
  integration/<conversation-id>/           temporary integration worktree when needed
  apply/<operation-id>/                    temporary merge worktree for /apply
```

The runtime root and every orchestrator-owned ancestor are real directories owned by the
user, mode `0700`, opened with no-follow checks. The runtime path is stored in the database
and must map back to the canonical Git common directory before reuse. Cleanup covers both
roots. `chatroom gc` reports runtime roots whose repository no longer exists.

> **Guard G7.** Worktrees and IPC stay outside the main tree. The reason is Claude's
> permission-rule precedence: the permissions docs state that deny rules take precedence over
> allow rules, so an `Edit(//<main>/**)` deny, which §15.2 needs, would also cover any
> worktree nested under the main tree. v4 gave a different reason, that deny-first systems
> cannot re-open children, and that reason is wrong for the OS sandbox: the sandboxing docs
> say "the narrower allow re-opens that part of the denied region", and the Codex permissions
> docs say "More specific entries override broader entries." Do not move worktrees back under
> `.chatroom/`, and do not cite sandbox precedence for keeping them out.

> **Comment.** The symlink `.chatroom/worktrees` is **proposed** so the user can list agent
> work without knowing the state directory. Chatroom itself never traverses it; agents use the
> real path as their working directory, and deny rules match the real path.

---

## 5. Durable storage

### 5.1 Engine and settings

The store uses `node:sqlite`, present on the development machine's Node with an
experimental-feature warning. Phase 0 runs the durability suite on the oldest supported
Node LTS; if it fails there, the binding is replaced before core code depends on it. One
write connection; read-only diagnostics may open a read-only connection when no migration
is pending.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations run under an exclusive lock and keep a pre-migration backup.

### 5.2 JSONL mirror

After every committed transaction that creates entries, the store appends them to
`transcript/<conversation-id>.jsonl` in `entry_id` order, outside the transaction. On
startup and on `chatroom log --verify`, the whole mirror is scanned: every line must parse
and the ordered `entry_id` sequence must equal the database query for that conversation.
Any discrepancy causes a rewrite through a sibling temporary file, `fsync` and rename. The
mirror is never read by recovery.

### 5.3 Schema

Logical SQL; exact indexes and constraints belong in migrations.

```sql
projects(id PK, root_path, git_common_dir, runtime_root, created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                        -- active | archived | deleting
  autonomy_limit, autonomy_used,
  latest_checkpoint_entry_id, applied_integration_oid,
  integration_base_oid)          -- main HEAD last merged into integration

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)
                                 -- kind: message | event

messages(entry_id PK FK, author, via, body, turn_id, operation_id,
  reply_to FK, causal_root FK, UNIQUE(author, operation_id))
                                 -- via: repl | post | reply | final | recovery

message_targets(message_id FK, participant, expects_action, PK(message_id, participant))

events(entry_id PK FK, type, agent, turn_id, payload_json)

agent_sessions(conversation_id FK, agent, vendor_session_id, generation,
  status,                        -- absent | healthy | suspect | recovering | lost
  last_confirmed_entry_id, capabilities_json, PK(conversation_id, agent))

turns(id PK, conversation_id FK, agent, attempt, status, vendor_turn_id,
  session_generation, started_at, ended_at, final_message_id, error_json, cost_json)
                                 -- status: preparing | running | ending | ended | failed | interrupted

turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
                                 -- transport: start | steer | hook | boundary

deliveries(id PK, conversation_id FK, agent, message_id FK,
  status,                        -- queued | held | publishing | accepted | superseded
  transport,                     -- turn | steer | hook
  attempt, autonomy_charged, accepted_at, UNIQUE(agent, message_id))

agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))       -- type: post | reply | delivery_ack

permissions(id PK, turn_id FK, agent, vendor_request_id, status, reviewer, summary,
  request_json, decision_json, rationale, created_at, resolved_at)
                                 -- reviewer: user | auto_review | claude_auto | managed | none

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, base_oid,
  head_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))
                                 -- owner: claude | codex | integration

integration_operations(id PK, conversation_id FK, type, status, manifest_json,
  created_at, finished_at)       -- type: snapshot | integrate | sync | apply | remove

checkpoints(id PK, conversation_id FK, through_entry_id, summary,
  workspace_manifest_json, created_at)   -- later phase

reviews(...)                     -- later phase; see v4 §5.3 for the intended shape
```

### 5.4 Transaction boundaries

Each of these is one transaction: append a message with targets, delivery rows and credit
reservation; create a turn with its input set; accept a delivery; append a final reply and
end its turn; import an agent operation and its receipt result; record a permission
decision; plan or finish a Git integration operation. Crossings into child processes,
filesystem renames and Git use an intent record followed by reconciliation.

---

## 6. Messages, targets, and causality

### 6.1 Participants and addressing

Handles: `user`, `claude`, `codex`. A mention is `@` followed by a handle or `all`, at a
word boundary, case-insensitive, anywhere in the body outside inline and fenced code.
`@all` means every participant except the author. Unknown handles produce a warning and
do not broaden the audience.

| Author | No mention | Mentions |
|---|---|---|
| user | Claude and Codex | the mentioned agents |
| agent | user | the mentioned participants except the author |

Agent-side commands accept `--to <handle>[,<handle>]` as an explicit override; when both
are present, `--to` wins and the body is stored as written. Resolved targets are separate
rows, never reconstructed from text later, and always shown in the REPL and delivery header.

> **Guard G10.** `@handle` is the one convention for humans and agents. Do not instruct
> agents to prefer `--to`; do not remove mention parsing from agent messages.

### 6.2 Visibility and delivery rows

Every message is visible in the user's transcript immediately after commit. A delivery row
is created for each agent other than the author, target or not. A non-target delivery waits
until that agent next receives a triggering message.

### 6.3 Operation and causal identifiers

Agent-side commands generate a random UUID `operation_id` before writing anything; a retry
reuses it; `(agent, operation_id)` is unique. Messages may carry `reply_to`, `causal_root`
and `turn_id`. `chatroom reply <id> <body>` sets `reply_to` and targets that message's
author unless `--to` overrides. A turn's final reply is linked to its newest triggering
input unless the agent already posted an explicit reply.

### 6.4 Limits

Defaults, configurable within hard caps: body 64 KiB; operation file 96 KiB; posts per turn
100; unprocessed operation files per turn 256; delivery batch 64 messages and a
driver-specific token budget; receipt retention seven days after archive.

---

## 7. Autonomy budget and scheduling

### 7.1 Meaning of the budget

The budget limits how many agent-authored messages may activate the other agent after the
most recent user message. It is a credit counter.

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery to that agent is `held`; the message stays visible to the
  user.
- Messages to the user cost nothing. One message costs at most one credit.

Held deliveries are released, and charged once, by either: the user addressing the held
recipient or everyone, in which case they join that batch free; or the user raising
`/budget`, in which case they are released in entry order while credit lasts. A user
message that addresses only one agent does not release the other agent's held deliveries.

> **Guard G19.** The asymmetry is intentional: "held" means the other agent tried to activate
> a recipient while the room was out of credit, and only the user re-opening that recipient or
> a deliberate budget change ends it. Do not make a user message to one agent release the
> other agent's held deliveries.

### 7.2 Scheduler states

Per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. At most one turn is active per agent and conversation; the two
agents run concurrently.

> **Guard G12.** Agents work in parallel with per-agent inboxes. Do not reintroduce
> sequential turn-taking, and do not discard the slower of two simultaneous replies (G11).

### 7.3 Scheduling rule

Run after a message commit, turn completion, delivery acceptance, budget change, driver
reconnect, or recovery:

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

### 7.4 Fairness and backpressure

Both agents start in the same event-loop tick when both have eligible work. If a sender
posts faster than the recipient can process, messages stay durable and coalesce into
bounded batches. Every post gets a receipt even when its target is held.

---

## 8. File IPC protocol

File IPC carries everything that originates inside an agent's tool shell, and deliveries
for the hook transport.

> **Guard G16.** Measured on Codex 0.146.0 and 0.153.3: a Unix-socket connection from inside
> the `workspace-write` sandbox fails with "Operation not permitted", while a file write under
> `sandbox_workspace_write.writable_roots` succeeds. Do not replace the file channel with a
> socket or a local TCP port.

### 8.1 Per-turn environment

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT` | `claude` or `codex` |
| `CHATROOM_CONVERSATION` | conversation UUID |
| `CHATROOM_TURN` | Chatroom turn UUID |
| `CHATROOM_OPERATION_DIR` | absolute, exact agent-writable drop directory for this turn |
| `CHATROOM_DELIVERY_DIR` | absolute orchestrator-owned directory, agent-readable |
| `CHATROOM_RECEIPT_DIR` | absolute orchestrator-owned receipt directory |
| `CHATROOM_SCRATCH` | absolute per-turn temp directory, also exported as `TMPDIR` |
| `CHATROOM_BIN` | absolute path of the running executable |
| `CHATROOM_PROTOCOL` | integer agent-command protocol version |

The driver does not alter the agent's Git environment. The user's global Git configuration,
identity and global excludes apply inside the worktree as they would for the user.

> **Guard G9.** Agents may commit, stash or branch inside their own worktree; Chatroom
> snapshots the worktree regardless. Do not add "do not commit" to the brief, do not deny
> writes to the worktree's Git metadata, and do not blank the global Git configuration.

The turn's random directory nonce is part of the path rather than trusted from a payload.
Identity is assigned from the driver and the fixed drop root, never from a field in a file.

### 8.2 Writing an operation

`post`, `reply` and `delivery_ack` use one envelope:

```json
{
  "protocol": 3,
  "operation_id": "f7515aa7-ff20-4b9e-807d-12f66157b282",
  "type": "post",
  "created_at": "2026-09-04T21:07:40Z",
  "payload": {"to": ["codex"], "body": "@codex Parser interface is ready.", "reply_to": null}
}
```

The command writes a unique temporary regular file in `CHATROOM_OPERATION_DIR`, fsyncs it,
and renames it to `<operation-id>.json`. Filesystem notifications are latency hints; a
poller is authoritative. The dispatcher renames each entry into `staging/`, checks with
no-follow semantics that it is one bounded regular file, validates it, imports it
transactionally or returns the previous result for a duplicate id, and writes a receipt
under `to-agent/receipts/` by temp-file-and-rename.

### 8.3 Receipts

```json
{"protocol": 3, "operation_id": "f7515aa7-…", "status": "accepted", "message_id": 42}
```

`chatroom post` waits briefly for the receipt and prints `#42`. A local timeout means
"acceptance unknown". Before a turn is finalized, the orchestrator closes the drop root to
new imports, drains published files, waits a short grace period, then retires the directory.

### 8.4 Deliveries and acknowledgment

For the hook transport, the orchestrator writes one atomic file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack` operation into the current drop directory; they never move or delete the
delivery file. The orchestrator removes it after the database says it was accepted.

### 8.5 `ask` and `reply`

```sh
"$CHATROOM_BIN" ask "@codex list or iterator?"
"$CHATROOM_BIN" reply 52 "It returns an iterator."
```

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`, for an answer.

- A message whose `reply_to` is the question id resolves the question durably; `ask`
  returns it with `status: answered`.
- A message from one of the asked parties that targets the asker and was committed after
  the question is a candidate. `ask` returns the first candidate immediately with
  `status: probable`, telling the agent the correlation is inferred. The question stays open
  in the database; a later explicit reply still resolves it.
- On timeout with no candidate, `status: indeterminate`; the agent continues.

Other incoming messages are printed while waiting. The timeout is kept below the measured
tool-command timeout of each driver.

> **Guard G14.** Return early on the first probable candidate. Do not hold the caller until
> timeout when a plausible answer is already on screen. Do not let a probable candidate mark
> the question resolved.

---

## 9. Driver contract

```ts
type DriverCapabilities = {
  persistentSession: boolean;     // resume by explicit id
  longLivedProcess: boolean;      // several turns per process
  nativeSteering: boolean;        // input accepted into a running turn
  hookDelivery: boolean;          // PostToolUse hook injection
  interrupt: boolean;
  hostApprovals: boolean;         // some approvals reach the REPL
  autoReviewer: "claude_auto" | "codex_auto_review" | "none";
  autoReviewRationale: boolean;   // reviewer decisions and rationale are observable
  inspectTurnState: boolean;      // reconcile an ambiguously accepted turn
  secretReadDenial: boolean;      // configured secret paths are unreadable to tools
  structuredEvents: boolean;
  sandboxVerified: boolean;
  maxDeliveryBytes?: number;
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

The scheduler branches only on recorded capabilities.

### 9.1 Capability probing

`chatroom doctor` records, per driver: executable real path and version; protocol
initialization; session start, resume and interruption; steering or hook delivery during a
harmless turn; the effective approval reviewer and whether its decisions are observable;
working directory; write success in the worktree, drop root and scratch; write failure in
the main tree, peer worktree, inbound IPC, `.chatroom/` and a random outside path, through
both shell commands and the harness's native file tools; read failure on configured secret
paths through both; network policy; loaded settings, hook, plugin and MCP sources where the
vendor reports them; and, for Claude, that the session is authenticated with the user's
login rather than an API key.

Only probe results enable a capability. Results are cached with executable hash, version,
platform, config fingerprint and expiry.

---

## 10. Claude driver

### 10.1 Transport

The driver runs the Claude Code CLI as a long-lived child process per agent session while
the chatroom is open:

```text
claude -p \
  --session-id <uuid>            first run of this conversation
  --resume <uuid>                later runs
  --input-format stream-json --output-format stream-json --verbose \
  --include-hook-events \
  --append-system-prompt "<brief>" \
  --settings '<inline JSON: hooks, sandbox, permissions.deny; see §15.2>' \
  --permission-mode auto --permission-prompts host \
  [--setting-sources <per §15.5>] [--model <model>]
```

Working directory: the conversation's Claude worktree. Environment: §8.1, with any
`ANTHROPIC_API_KEY` removed so the CLI uses the user's login.

- A turn is one `user` message on stdin and the `result` event that ends it. Messages
  written while a turn runs are queued by the CLI; the driver therefore writes a turn's
  input only when the scheduler starts a turn.
- `longLivedProcess` true; resume happens once per chatroom run. If the process dies, the
  driver reconnects with `--resume` and reports `session: suspect`.
- `nativeSteering` false; `hookDelivery` true (§10.2).
- Reply text and cost come from the `result` event. Activity comes from `assistant`
  events: `text`, `tool_use`, and `thinking` blocks if present.
- The system prompt and settings are not persisted with the session; they are passed on
  every process start.

> **Guard G1.** The Claude driver is the CLI, never the Agent SDK. The SDK overview states:
> "Anthropic does not allow third party developers to offer claude.ai login or rate limits for
> their products, including agents built on the Claude Agent SDK. Use the API key
> authentication methods." Everything the SDK offers, streaming input, permission callbacks
> and hooks, is a wrapper around these CLI flags. Do not reintroduce the SDK as the primary or
> preferred driver.

### 10.2 Mid-turn delivery: PostToolUse hook

The inline settings register one hook:

```json
{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` reads the hook event JSON on stdin, reads pending files in
`CHATROOM_DELIVERY_DIR`, writes a `delivery_ack` operation, and if anything was pending
prints:

```json
{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<delivery text, §14.1>"}}
```

Hooks run as ordinary child processes of Claude Code, outside the Bash sandbox, with the
driver's environment. An agent generating text without tool calls hears nothing until its
next tool call or the end of its turn, in which case the batch is returned to `queued`.

> **Guard G4.** The streaming-input docs describe "queued messages: send multiple messages
> that process sequentially". Streaming is a queue, not injection. The hooks docs state that
> `additionalContext` from a `PostToolUse` hook is appended to the tool result. Do not remove
> the hook in favour of streaming input, and do not describe streaming input as mid-turn
> delivery.

### 10.3 Auto mode and approvals

Claude runs with `--permission-mode auto`: Claude Code's own classifier decides routine
actions and asks for the rest. With `--permission-prompts host`, whatever it would ask is
sent to the driver as a control request on stdout. The driver records a `permissions` row
with `reviewer: claude_auto` for decisions the classifier made when the stream exposes them,
and `reviewer: user` for relayed prompts, which the REPL shows with a short id; the answer
returns on stdin as a control response. Hard path denials (§15.2) are enforced by the
sandbox and the deny rules before any prompt is generated.

> **Guard G2.** Claude's permission mode is `auto` with host-relayed prompts. Do not replace
> it with `bypassPermissions`, `acceptEdits` or `dontAsk`, and do not route prompts to `none`.

### 10.4 Fallback

If the long-lived process misbehaves in Phase 0, the driver runs one process per turn with
the same flags; only `longLivedProcess` changes.

---

## 11. Codex driver

### 11.1 Transport

The driver runs `codex app-server` as a child process over stdio and speaks JSON-RPC:

- new or resumed Chatroom session to `thread/start` or `thread/resume`, with the
  conversation's Codex worktree as `cwd`, `approvalPolicy: "on-request"`,
  `approvalsReviewer: "auto_review"`, and the permission profile of §15.3 passed through the
  `config` override map;
- a turn to `turn/start`; mid-turn batches to `turn/steer` with `expectedTurnId`;
- `/stop` to `turn/interrupt`;
- streamed items to driver events: `reasoning` for summaries, `agent_message` for interim
  text, `command_execution` and `file_change` for tool activity;
- approval requests `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval` and `item/permissions/requestApproval`, which reach the
  REPL only when Auto-review escalates or is unavailable (§11.2);
- `item/autoApprovalReview/started` and `.../completed` as reviewer evidence when present.

Authentication is the user's existing Codex login, shared by the CLI, app-server and
desktop app.

All of the above method and parameter names were confirmed in the protocol schema generated
by `codex app-server generate-json-schema` on 0.153.3.

### 11.2 Auto-review

Codex's Auto-review is the closest equivalent to Claude's auto mode: with
`approval_policy = "on-request"`, each request that would otherwise interrupt the user is
reviewed by a Codex-side model, which approves, denies or escalates. The docs state
"Auto-review only applies when approvals are interactive" and "With `approval_policy =
"never"`, there is nothing to review."

Driver behaviour:

1. `approvalsReviewer: "auto_review"` is set on `thread/start`, `thread/resume` and
   `turn/start`. The thread's effective reviewer is read back where the protocol reports it
   and shown in `/status`.
2. When `item/autoApprovalReview/*` notifications arrive and parse, the driver records
   `reviewer: auto_review`, the decision, `riskLevel` and `rationale`. When they do not parse,
   the row records `reviewer: auto_review, rationale: unavailable`. Approvals still happen
   inside Codex either way; the notifications are evidence, not the mechanism.
3. A request that Auto-review escalates, or any request when Auto-review is unavailable,
   arrives as a `requestApproval` method and is relayed to the REPL with a short id.
4. If the reviewer cannot be set, the driver falls back to `user` with a visible event.

Hard-denied paths (§15.3) fail inside the profile before either reviewer is consulted.

> **Guard G3.** Codex's reviewer is `auto_review` with `on-request`, falling back to `user`
> visibly. Do not set `approval_policy = "never"`, which disables both reviewers, and do not
> make Auto-review's unstable notifications a precondition for using it. The schema marks
> `GuardianApprovalReviewStatus` "[UNSTABLE]"; the config key and thread parameter are the
> stable part.

### 11.3 Source review (later phase)

App-server's `review/start` exists with `target: {type: "commit", sha}` and `delivery:
"detached"`, confirmed in the schema. It is unrelated to Auto-review. A `/review` command
over snapshot commits and integration tips is a later-phase feature (§25) and never a
precondition for `/apply` in the first release.

### 11.4 Fallback: `codex exec`

If app-server probing fails:

```text
codex exec --json -o <file> \
  -c 'default_permissions="chatroom-<nonce>"' -c 'permissions.chatroom-<nonce>…' \
  -c 'approval_policy="never"' \
  -c 'shell_environment_policy.set={…}' \
  [-c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust] -      (prompt on stdin)
codex exec resume <thread-id> --json -o <file> -c … -
```

`exec resume` has no `--cd`; the working directory comes from spawning in the worktree.
`--sandbox` is not passed: the docs say `sandbox_mode` and `default_permissions` cannot both
be set. There is no Auto-review, human approval or steering on this path. If the installed
Codex cannot load the profile, the driver uses legacy `workspace-write` with
`writable_roots`, measured to work, and reports `secretReadDenial: false`.

Hook delivery is enabled only when `doctor` finds no hook source other than Chatroom's,
because the trust bypass runs every enabled hook from every layer.

---

## 12. Turn lifecycle

### 12.1 Starting a turn

1. In one transaction: select every undelivered message through the newest eligible
   trigger, create the turn, attach ordered `turn_inputs`, mark those deliveries
   `publishing`, append `turn_started`.
2. Create exact per-turn drop and scratch directories.
3. Ensure the vendor session is connected, resuming by explicit id if needed, and verify
   its working directory.
4. Submit the input through the native channel, never as an argument.
5. On acknowledgment, store vendor ids, mark deliveries `accepted`, set the turn `running`.
6. Stream normalized activity to the REPL and, if enabled, the raw log.

If spawning or submission fails, the same transaction returns `publishing` deliveries to
`queued`.

### 12.2 During a turn

Agent-side posts are imported independently of model output. Eligible messages for a
running agent are steered or hook-delivered per capability. Approval requests stop only the
requesting operation; a human decision is durable before the driver receives it; an
Auto-review decision is recorded when its evidence arrives. `/stop` requests protocol
interruption, then SIGTERM, then SIGKILL after grace periods.

### 12.3 Ending a turn

1. Receive the terminal event and final reply.
2. Close the drop root and drain published operations.
3. In one transaction: append the non-empty final reply with idempotency key
   `final:<turn-id>` and `via: final`, or append `silent` when the reply is empty or
   exactly `[silent]`; store cost; mark the turn ended.
4. Write pending receipts, return unacknowledged hook deliveries to `queued`, retire
   per-turn directories, run the scheduler.

A final reply with no mention targets the user.

### 12.4 Steering and hook races

If the vendor reports no matching active turn, or a hook delivery is unacknowledged at turn
end, the batch returns to `queued` and leads the next turn. The autonomy credit stays
charged.

---

## 13. Sessions and recovery

### 13.1 Sessions are caches

Room transcript, accepted deliveries and workspace snapshots are durable truth. Vendor
sessions are performance caches with a `generation`. Session ids are always explicit; a
picker, `--last` or `--continue` is never used. A resumed session must report the expected
id and working directory, else it is `lost`.

### 13.2 Suspect sessions

A session becomes `suspect` when Chatroom cannot prove how an in-flight request ended.
Recovery:

1. Inspect and snapshot the agent worktree; record the interrupted turn and accepted ids.
2. If `inspectTurnState` is available, query the vendor thread and turn before sending
   anything.
3. Resume by explicit id and verify identity and directory. Success moves the session to
   `recovering`, not `healthy`.
4. Send a recovery note as the first new input: interrupted turn, accepted message ids,
   reconciled vendor evidence, current workspace diff, and the instruction to inspect side
   effects before repeating anything. No queued room work is attached to this turn.
5. Mark `healthy` only after the recovery turn reaches a valid terminal event. Otherwise
   mark `lost` and rebuild (§13.3).

> **Guard G18.** Try to resume before rebuilding. Both harnesses write session logs
> incrementally and are resumed after kills routinely; discarding the session on every
> orchestrator crash throws away the agent's working memory for no correctness gain. The
> recovery turn is the health check.

### 13.3 Lost session rebuild

Mark the old generation `lost`, create a new one, build a bounded prompt from the brief,
the transcript tail that fits, referenced earlier messages and workspace state, start a
fresh session, store the new id after acknowledgment, append `session_rebuilt`. Checkpoints
(later phase) shorten the tail; until then, if the tail does not fit, ask the user to split
the conversation.

### 13.4 Startup reconciliation

Before scheduling: mark turns left `preparing` or `running` as interrupted; verify the
runtime root is owned, no-follow and mapped to the same Git common directory; reconcile
staged IPC operations by id; recreate missing delivery or receipt files from rows;
quarantine orphan files; reconcile every `planned` or `executing` Git operation via its
manifest; verify worktree paths, refs, oids and ownership tokens; validate and if needed
rebuild the JSONL mirror; reconnect sessions only after workspace reconciliation succeeds.
Ambiguous main-tree changes cause a hard stop with a precise recovery command.

---

## 14. What agents receive

### 14.1 Delivery format

Used for turn inputs, steering, hook injection and `chatroom inbox`.

```text
[chatroom] You are @claude. 2 new messages. Act on those addressed to you; read the rest as context.
Speak now with "$CHATROOM_BIN" post "..."; ask with "$CHATROOM_BIN" ask "..."; reply exactly [silent] if your posts said everything.

--- #41 · user → @claude @codex · 21:07:12
Implement X.

--- #42 · codex → @claude · 21:07:40 · reply to #41
@claude I'll take the parser; can you take the CLI?

workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230
peer changes since your previous input: src/parser.ts, test/parser.test.ts
```

Changed paths are advisory. The header repeats on every delivery so the rules survive
vendor compaction. Records are readable text, not JSON; targets remain metadata rows.

### 14.2 Brief

Supplied on every process start, repeated compactly in the delivery header:

```text
You are @{me} in a project chat with @user and @{other}. Solve the user's task together.
Everything posted is visible to all three of you.

Coordination
- On a task sent to both agents, immediately claim a concrete, non-overlapping part:
  "$CHATROOM_BIN" post "@{other} I'll take …". Resolve overlaps in the chat, then work.
- Mention @{other} only when you intend to activate them: a question, a handoff, a review.
  A message without mentions goes to the user.
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
- You may commit in your worktree, but you do not need to. Chatroom snapshots all
  non-ignored changes and owns integration; do not touch Chatroom's refs.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`brief.extra` from configuration is appended with a visible label, size-capped, never
interpolated into shell code.

> **Guard G8 and G9.** The workspace section says agents read the peer worktree and the main
> tree, write only their own, and may commit. Do not replace main-tree reads with "inspect
> immutable oids", and do not add commit prohibitions or commit-often norms.

---

## 15. Sandboxing, approvals, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, reads of known secret locations, malformed IPC files, duplicate operations, and
common path and symlink attacks. Strict mode assumes anything a model tool can read may
reach that model's provider, so the secret denylist is part of the security boundary. It is
a denylist: the repository, the user's toolchains and caches, and the peer's work are
intentionally readable. Compatible mode may widen this with a visible warning.

### 15.2 Claude

Claude Code's OS sandbox covers Bash commands only, using Seatbelt on macOS and bubblewrap
on Linux. Its default write scope is "the current working directory and its
subdirectories, any directories you've added … plus the session temp directory that
`$TMPDIR` points to". Native Read, Grep, Glob, Edit and Write are governed by permission
rules. Strict mode pins both layers through inline `--settings`:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyRead":  ["<security.secret_paths…>", "<project>/.chatroom",
                    "<ipc root>/*/staging", "<ipc root>/<peer>"]
    },
    "network": {"allowUnixSockets": [], "allowedDomains": ["<security.network_domains…>"]}
  },
  "permissions": {
    "deny": [
      "Read(//<secret path>/**)", "…",
      "Read(//<project>/.chatroom/**)",
      "Edit(//<project>/**)",       "Write(//<project>/**)",
      "Edit(//<peer worktree>/**)", "Write(//<peer worktree>/**)",
      "Edit(//<ipc root>/**)",      "Write(//<ipc root>/**)"
    ]
  }
}
```

Why this is sufficient and why each part is there:

- **Shell writes** are bounded by the default scope plus `allowWrite`. No `denyWrite` is
  needed for the main tree or `.chatroom/`, neither is inside the worktree. No allow/deny
  precedence question arises for writes, which is deliberate: that precedence is
  undocumented.
- **Shell reads** are open except the denylist. The sandboxing docs: "the deny holds inside
  a wider allow, so a broad allow can't silently re-expose a secret." The harness homes
  `~/.claude` and `~/.codex` are in the default secret list: the harness processes read them
  outside the sandbox, but the agent's shell must not read other sessions' transcripts or
  the vendor credentials.
- **Native tool writes** are denied for the main tree, peer worktree and IPC root. The
  worktree is not beneath any of them (G7), so deny-wins precedence cannot hit it.
- **Native tool reads** of secrets and `.chatroom/` are denied; "A Read deny rule also
  blocks the Edit and Write tools on the same path."
- **`autoAllowBashIfSandboxed`** lets commands inside the boundary run without prompts,
  which is what unattended auto mode needs. It does not permit unsandboxed fallback.

Default `security.secret_paths`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
`~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`,
`~/.codex`, `~/.config/chatroom`. A configured secret path that overlaps a required
readable view is a configuration error.

> **Guard G5 and G6.** Keep the native tools enabled and the read boundary a denylist. The
> permissions docs give `//path` absolute syntax for `Read` and `Edit` rules and state that
> Grep and Glob apply `Read` deny rules on a best-effort basis. Do not deny reads of `/` and
> re-open a "minimal runtime" set: it is undocumented for Claude, it breaks every toolchain
> that lives in the home directory, and it forces the user into compatible mode.

### 15.3 Codex

Strict mode uses a generated permission profile with a random name, supplied through the
`config` override map on `thread/start` and `thread/resume`, or `-c` on `exec`. Profiles are
documented as "Beta … may change" and as exclusive with `sandbox_mode`.

```toml
default_permissions = "chatroom-<nonce>"

[permissions.chatroom-<nonce>.filesystem]
":root"                 = "read"      # toolchains, caches, project, peer stay readable (G6)
"<own worktree>"        = "write"
"<drop root>"           = "write"
"<scratch root>"        = "write"
"<extra write root…>"   = "write"
"<project>/.chatroom"   = "deny"
"<ipc root>/*/staging"  = "deny"
"<ipc root>/<peer>"     = "deny"
"<secret path…>"        = "deny"

[permissions.chatroom-<nonce>.network]
enabled = false                         # or the configured proxy policy
```

The docs' precedence rule, "More specific entries override broader entries. When two entries
target the same path, deny takes precedence over write, and write takes precedence over
read", makes the denylist shape well-defined. `TMPDIR` is set to the scratch root through
`shell_environment_policy.set`. The random profile name prevents user configuration from
extending it. The effective profile is read back where the protocol reports it and
fingerprinted with the turn.

If the installed Codex cannot load the profile, strict mode falls back to legacy
`workspace-write` with `writable_roots`, which was measured to enforce the write boundary,
and reports `secretReadDenial: false` in `/status`. It does not refuse to start.

Never used: `danger-full-access`, the approvals-and-sandbox bypass, or the experimental
per-thread `permissions` parameter, which requires the experimental-API capability.

> **Guard G15.** The profile goes through `config` overrides, not the experimental
> `permissions` parameter; Auto-review evidence is optional; profile failure degrades to the
> measured legacy sandbox with a visible flag. Do not make strict mode refuse to start on any
> of: app-server experimental status, profile beta status, unparsable Auto-review
> notifications. Refusal is reserved for a failed write-boundary probe or a failed login probe.

### 15.4 Approval and review boundaries

Claude's classifier and relayed prompts, and Codex's Auto-review and relayed requests,
decide only within the boundaries above. A request touching a hard-denied path fails before
any reviewer sees it. Negative tests exercise both layers so a vendor update cannot turn a
denial into a prompt.

### 15.5 Customization modes

| Mode | Behaviour |
|---|---|
| `strict` (default) | Project `CLAUDE.md` and `AGENTS.md` load as they would for the user. Claude: `--setting-sources user` so project and local settings, including their hooks, do not load; the chatroom hook arrives via `--settings`. Whether this combination keeps `CLAUDE.md` loading is a Phase 0 item. Codex app-server: hooks Codex does not trust are skipped by Codex itself, so no bypass flag is passed. Codex `exec` fallback: the chatroom hook is enabled only when it is the sole non-managed hook source. `/status` lists active guarantees: write boundary, secret reads, network, reviewer. |
| `compatible` | Load normal vendor customization. Show every detected source in `/status`; warn when one widens hooks, tools, readable data, network or writable paths. |

Managed organization policy always remains in force.

### 15.6 Identity

Sender identity comes from the driver and the fixed drop root, never from a payload.
Processes share one OS account; this is not isolation from a malicious local process.

---

## 16. Conversation workspaces and Git integration

### 16.1 One workspace set per conversation

A conversation owns three refs, named with opaque ids:

```text
refs/heads/chatroom/<project-short>/<conversation-short>/claude
refs/heads/chatroom/<project-short>/<conversation-short>/codex
refs/heads/chatroom/<project-short>/<conversation-short>/integration
```

All begin at main's HEAD when the conversation is created, recorded as
`integration_base_oid`. Worktrees live under the runtime root (§4.4) at stable paths, which
preserves vendor session identity. Inactive conversations may be archived (later phase).

### 16.2 Snapshotting uncommitted work

With the agent stopped, `/snapshot <agent>` captures tracked and non-ignored untracked
files: write an intent with expected oids; build a temporary index from the agent branch
HEAD; add the worktree through it; `git write-tree` and `git commit-tree` with hooks and
signing bypassed; update the Chatroom-owned ref with its expected old oid; align the
worktree's index without touching files; record the oid. If the agent has made its own
commits, they are simply the branch history the snapshot sits on top of.

### 16.3 `/integrate <agent>`

Refuse while the agent runs; snapshot; merge the agent branch into integration in a
temporary worktree with no hooks or signing; on success record the oid; on conflict abort
with nothing changed and report files.

### 16.4 `/sync <agent|all>`

1. If main's HEAD is not an ancestor of the integration branch, merge main's HEAD into
   integration first and record it as `integration_base_oid`. On conflict, stop and report.
2. Snapshot the agent, then merge integration into the agent branch. On conflict the agent
   worktree enters a documented conflict state with its pre-sync snapshot safe.

`/import <source> <destination>` is integrate source, then sync destination.

### 16.5 `/apply [agent]`

`/apply` materializes the integration tip's changes in the user's main worktree;
`/apply <agent>` is integrate then apply. `applied_integration_oid` is a high-water mark
only, never a patch base.

Preconditions: no prior apply needs recovery; the tip is a descendant of the recorded
marker when one exists; the tip differs from the marker.

Preflight:

1. Create a temporary worktree under the runtime root, detached at main's HEAD. Merge the
   integration tip into it with normal ancestry, hooks and signing disabled. A conflict
   removes the worktree and changes nothing.
2. Take the merged tree `R`. The candidate delta is `HEAD..R`, binary, with renames. If it
   is empty, advance the marker with a no-op event and stop.
3. Compute main's dirty set against HEAD: staged, unstaged, intent-to-add, non-ignored
   untracked, rename sources and destinations, submodules. Reject if any candidate path
   intersects it, ancestor-aware and normalization-aware. An untracked path the delta would
   create is in the dirty set.
4. Persist the patch and an `executing` manifest with main HEAD, `R`, the tip, and each
   affected path's expected before and after blob, mode and type.

Mutation is journaled but not globally atomic: revalidate HEAD and every affected path
against the manifest immediately before writing; materialize each regular-file replacement
through a sibling temporary file, `fsync` and rename; journal deletions, renames, symlinks
and submodules the same way; leave the index unchanged so edits are unstaged; record the
tip as applied. Startup classifies every affected path after a crash: all `before`, retry or
abandon; all `after`, complete the record; a mixture, stop with a forward-completion
manifest; any `neither`, stop because something else changed the path. Chatroom never rolls
main backward.

> **Guard G13.** No synthetic commit of the dirty tree and no private object overlay. On every
> path that passes the dirty-disjoint rule, main's HEAD content equals the working-tree
> content, so merging into HEAD yields the same result as merging into a snapshot of the
> dirty tree; on every path that fails the rule, apply aborts regardless. The synthetic commit
> therefore cannot change any accepted outcome. Do not reintroduce it. Do keep `/sync`'s main
> fold-in and never use the marker as a patch base; that was the real v3 bug v4 found.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees and retired IPC, keeping
conversations, authority and refs. `chatroom reset` removes both roots and owned refs only
after all agents stop, every dirty worktree is snapshotted or explicitly discarded, each
ref matches its ownership token, and no non-Chatroom worktree depends on it. Destructive
commands show exact roots and refs and require confirmation.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees. Sessions start lazily. |
| `chatroom list` | Conversations, agents, workspace state, integration and apply status. |
| `chatroom continue <name-or-id>` | Verify worktrees and open. |
| `chatroom delete <name-or-id>` | Remove worktrees, owned refs, IPC, logs and rows after confirmation. |

Switching stops or waits for active turns, snapshots both worktrees, and disconnects
drivers. A conversation holds one session per harness; ids change only through §13.3.
Sessions are isolated from the user's own because they live in conversation worktrees and
are resumed only by explicit id; the sessions docs state that `--continue` finds the most
recent session in the current directory.

---

## 18. REPL and commands

Line-oriented. Concurrent output redraws the input line without losing text.

```text
#42 codex → @claude                                       21:07  post
  @claude Parser interface is ready; can you take the CLI?
    · claude: Edit src/cli.ts
    · codex ~ checking how the CLI parses arguments before…
    · codex ✓ auto-review approved: npm test (low risk)

!p3 codex requests network access to registry.npmjs.org
claude: working · codex: waiting p3 · budget 1/6 · integration pending 7b88c12 · parser
> _
```

Plain input is a user message. Multi-line input is fenced with a line containing only
`"""`. Relayed approval requests get short ids and are answered asynchronously with
`/allow p3 once`. Auto-review and classifier decisions appear as activity with their
rationale when available.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit; releases held deliveries in order. |
| `/status` | Agents, sessions, capabilities, active guarantees, reviewer, turns, held deliveries, permissions, workspaces, integration and apply state, detected customization sources. |
| `/stop <agent\|all>` | Protocol interrupt, then bounded termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a relayed approval request. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2 |
| `/integrate <agent>` | §16.3 |
| `/sync <agent\|all>`, `/import <src> <dst>` | §16.4 |
| `/apply [agent]` | §16.5 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and boundary diagnostics. |
| `/quit` | Stop turns, flush, release the lock. |

Later phase: `/review`, `/archive`, `chatroom gc`.

External commands: `chatroom log [--jsonl] [--verify]`, `doctor`, `clean`, `reset`, and the
agent-only `post`, `reply`, `ask`, `inbox`, `hook`, which refuse to run unless every required
`CHATROOM_*` variable and the protocol version are present.

---

## 19. Configuration

TOML; project overrides global; managed vendor policy can only narrow.

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Agent-authored cross-agent activations after user input. |
| `turn.timeout_minutes` | `30` | Hard turn timeout. |
| `turn.stop_grace_seconds` | `5` | Grace between interrupt, SIGTERM and SIGKILL. |
| `ask.timeout_seconds` | `60` | Agent-side answer wait; kept below the measured tool timeout. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.permission_mode` | `auto` | Fixed to `auto` in strict mode (G2). |
| `driver.claude.long_lived` | `true` | One process per session rather than per turn. |
| `driver.codex.prefer_app_server` | `true` | App-server before `exec` fallback. |
| `driver.codex.approval_policy` | `on-request` | Required for Auto-review (G3). |
| `driver.codex.approvals_reviewer` | `auto_review` | `auto_review` or `user`; effective value in `/status`. |
| `security.mode` | `strict` | `strict` or `compatible`. |
| `security.shell_network` | `false` | Network from sandboxed shell commands. |
| `security.network_domains` | empty | Domains allowed when shell network is enabled. |
| `security.secret_paths` | §15.2 defaults | Denied read paths, both harnesses. |
| `security.extra_write_roots` | empty | Additional writable roots, for package caches and build outputs. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; §15.2. |
| `logging.raw_events` | `false` | Persist vendor raw streams. |
| `logging.retention_days` | `30` | Raw log and retired receipt retention. |
| `logging.max_mib` | `256` | Per-project raw-log cap. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |
| `workspace.state_dir` | platform default | Parent for per-project runtime roots. |
| `workspace.link_worktrees` | `true` | Proposed: create the `.chatroom/worktrees` convenience symlink. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn.

---

## 20. Activity, logs, and privacy

| Kind | Claude source | Codex source |
|---|---|---|
| `text` | `assistant` text blocks | `agent_message` items except the final one |
| `reasoning_summary` | `thinking` blocks, if present | `reasoning` items |
| `tool` | `tool_use` blocks | `command_execution`, `file_change`, `mcp_tool_call`, `web_search` |
| `tool_result` | `tool_result` blocks, bounded | `aggregated_output`, `exit_code`, bounded |
| `permission` | control requests and classifier decisions where exposed | `requestApproval` methods and `autoApprovalReview` notifications |

Raw vendor streams are off by default, size-capped, and removable. Permission events store a
redacted summary, reviewer and available rationale. Chatroom never records
environment-variable values.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Turn interrupted, session suspect; reconcile; resume and run a recovery turn; rebuild only if that fails. |
| Crash after message commit, before scheduling | Rows remain queued; startup scheduler handles them. |
| Duplicate filesystem event or post retry | Unique operation id returns the original receipt. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, rejection event, no message. |
| Steering or hook delivery races turn end | Return to queued; lead the next turn; no second charge. |
| Driver process exits nonzero | Preserve bounded stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild as a new generation. |
| Write-boundary probe fails | Strict mode refuses to start that agent. |
| Secret-read probe fails, profile unavailable | Strict mode starts with `secretReadDenial: false` shown in `/status`. |
| Auto-review unavailable or unparsable | Fall back to user review visibly; or record decisions without rationale. |
| Extra hooks or config widen policy | Strict excludes them; compatible warns with the source. |
| `ANTHROPIC_API_KEY` present or login probe fails | Claude driver refuses to start and says why. |
| Budget exhausted | Cross-agent trigger held; status shows the count. |
| Integration or sync conflict | Nothing changed in main or integration; paths reported; agent worktree keeps its pre-sync snapshot. |
| Apply preflight conflict, stale HEAD, overlapping dirty path | Main tree unchanged; paths listed. |
| Crash during apply | Classify each affected path; complete, retry or stop with a forward-recovery manifest. |
| Ref, ownership or runtime-root mismatch | Refuse the action; show expected and actual values. |
| Database corruption | Stop; preserve files; integrity diagnostics; never rebuild authority from the mirror automatically. |
| JSONL mirror inconsistent | Rewrite from SQLite. |
| Disk full | Stop accepting messages before acknowledging them. |

---

## 22. Verification ledger

### Measured on the development machine, 2026-09-04

- Codex 0.146.0 and 0.153.3, `workspace-write`: writes inside cwd succeed; outside fail;
  under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; environment
  variables reach commands under `codex sandbox`.
- `codex exec resume` has `--json` and `-o` but no `--cd` or `--sandbox` (0.153.3).
- `codex app-server` lists `stdio://` as its default transport; its generated schema on
  0.153.3 defines `thread/start` and `thread/resume` with `cwd`, `approvalPolicy`,
  `approvalsReviewer`, `sandbox` and free-form `config`; `turn/start` with `sandboxPolicy`;
  `turn/steer` with `expectedTurnId`; `turn/interrupt`; `review/start` with
  `delivery: inline | detached`; `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`;
  `item/autoApprovalReview/started` and `/completed`; `ApprovalsReviewer` enum
  `user | auto_review | guardian_subagent`; `GuardianApprovalReviewStatus` marked
  "[UNSTABLE]".
- `codex features list`: `hooks` stable; `steer` graduated.
- Claude 2.1.261 flags: `--settings` file-or-JSON, `--setting-sources user,project,local`,
  `--permission-prompts host|none`, `--permission-mode auto`, `--include-hook-events`,
  `--session-id`, `--resume`, `--input-format stream-json`.
- `node:sqlite` loads on Node 25.1.0 with an experimental warning.

### Documented

- Claude Code sandboxing: Bash-only OS sandbox; default write scope is cwd, added
  directories and the session temp directory; "When read rules overlap, the more specific
  path wins"; "the narrower allow re-opens that part of the denied region"; "the deny holds
  inside a wider allow"; `allowWrite` accepts absolute and `~/` paths.
- Claude Code permissions: `Read(...)` and `Edit(...)` rules with `//` absolute, `~/` home and
  relative forms; "A Read deny rule also blocks the Edit and Write tools on the same path";
  Grep and Glob apply Read deny rules best-effort; deny rules take precedence over allow.
- Claude Code hooks and headless: inline `--settings` JSON; `PostToolUse`
  `additionalContext` appended to the tool result; streaming input queues messages.
- Claude Code sessions: per-working-directory storage; `--continue` scoped to the working
  directory.
- Claude Agent SDK: claude.ai login not permitted for SDK agents.
- Codex permissions: `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; "More specific entries override broader entries … deny takes
  precedence over write, and write takes precedence over read"; `:root` is a valid path
  key; "Beta. Permission profiles are under active development and may change"; exclusive
  with `sandbox_mode`.
- Codex Auto-review: `approvals_reviewer = "auto_review"`; requires interactive approvals;
  `never` leaves nothing to review.
- Codex app-server: "experimental and aren't supported for production workloads"; the
  per-thread `permissions` parameter is experimental and cannot be combined with `sandbox`.
- Codex non-interactive: `--json` events; `thread_id` in `thread.started`; resume by UUID
  without cwd filtering.

### Phase 0: verify before building the scheduler

1. `node:sqlite` and the durability tests pass on the oldest supported Node LTS.
2. The Claude CLI in `-p --input-format stream-json` accepts several sequential turns in one
   process; `--resume` on a later process continues the session.
3. A `PostToolUse` hook from inline `--settings` fires in `-p` mode and its
   `additionalContext` reaches the model; whether `--setting-sources user` filters it.
4. The Claude permission control request and response wire shape, including
   deny-with-message, and whether classifier decisions are visible in the stream.
5. `thinking` blocks in the Claude stream; whether `--verbose` is needed.
6. Claude boundary: shell writes succeed in worktree, drop and scratch and fail in main,
   peer and `.chatroom`; native Edit is denied on main and peer; native and shell reads of
   secret paths are denied; toolchains in the home directory remain readable and a package
   install with an extra write root succeeds.
7. `--setting-sources user` keeps project `CLAUDE.md` loading.
8. The Claude login probe: detecting subscription authentication from `system/init` or
   elsewhere.
9. App-server: profile accepted through `config` overrides; `approvalsReviewer:
   auto_review` accepted and reported; a routine command is auto-approved; an escalated one
   reaches `requestApproval`; `turn/steer` acceptance against a finishing turn.
10. Codex boundary under the profile: shell and file-change writes succeed only in declared
    roots; secret reads are denied; a hard-denied path cannot be turned into a prompt.
11. Codex `exec` fallback: profile via `-c` on start and resume; legacy fallback reports
    `secretReadDenial: false`.
12. What each harness records after a kill mid-generation; a resume stays `recovering`
    until the recovery turn completes.
13. Effective tool-command timeouts of both harnesses.

---

## 23. Verification and testing strategy

- **Model-free core tests** with fake drivers: increasing ids; one delivery per
  `(agent, message)`; one logical message per accepted operation; autonomy use never
  exceeds the limit; retries never charge again; at most one active turn per agent; every
  ended turn has a terminal event; no orchestrator write under an agent-writable root;
  recovery reaches the same logical state after a crash at any injected boundary.
- **IPC security tests**: partial, duplicate, hard-linked, symlinked, directory, FIFO,
  sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn and
  duplicate-notification cases.
- **Boundary matrix**: allowed and denied shell and native reads and writes on both
  harnesses; secret paths; toolchain and cache access; attempts to request a hard-denied
  path through either reviewer; external customization sources.
- **Git matrix**: file kinds, agent commits plus uncommitted changes, sequential snapshots
  and integrations, both agents on the same and different files, main advancing before
  `/sync` and before `/apply`, a main change folded beside an unapplied agent change,
  repeated apply after the user commits, dirty and untracked collisions, conflicts and
  aborts, crash before and after every affected path. Main stays byte-identical on every
  failed preflight; a dirty-but-disjoint main applies correctly.
- **Mirror tests**: partial final lines, malformed JSON, missing or duplicate records,
  deterministic rewrite.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 24. Implementation approach

TypeScript on the Phase-0-verified Node LTS range; `node:sqlite` if it passes that range.
Vendor types stop at the adapter boundary.

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, probes.ts
  security/   profiles.ts, boundaries.ts, customization.ts
  workspace/  repository.ts, snapshot.ts, integration.ts, sync.ts, apply.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, activity.ts
  test-support/ fake-driver.ts, crash-injector.ts
```

The agent-command entry path initializes quickly and imports neither the REPL, the drivers,
the workspace manager, nor a writable database connection.

---

## 25. Build order

**First usable release: phase 0, phases 1 to 4, and the marked items of phase 5.**

0. **Vendor and runtime spikes.** Disposable probes for every item in §22, later folded
   into `doctor --smoke`. Exit: every first-release driver claim has a recorded fixture and
   every hard denial has a negative test.
1. **Durable room core.** Schema, migrations, mirror; target resolution; delivery records
   and budget; startup reconciliation; fake drivers and property tests. Exit: crash
   injection cannot lose or duplicate logical messages.
2. **IPC and agent commands.** Layout, import, receipts, retry, limits, quarantine; `post`,
   `reply`, `ask`, `inbox`, `hook`; security suite. Exit: every accepted operation has one
   durable result and no orchestrator path can be redirected by an agent-controlled entry.
3. **Drivers, read-only.** Claude CLI in auto mode with hook delivery; Codex app-server with
   Auto-review and steering; `exec` fallback; minimal recovery. Exit: both agents chat
   concurrently and receive a mid-turn message.
4. **Strict sandboxed work.** Runtime roots; Claude sandbox and deny rules; Codex profile
   with legacy fallback; negative probes; approval relay; interruption. Exit: each agent
   edits and tests its own worktree, reads main, peer and toolchains, cannot read secrets,
   and cannot write main, peer, IPC or the database through any tool or reviewer.
5. **Git collaboration.** *First release:* snapshots, `/integrate`, journaled `/apply` with
   the dirty-disjoint rule and crash classification. *Later:* `/sync` with main fold-in,
   `/import`, conflict states, the full Git matrix.
6. **Later.** Suspect-session refinements; checkpoints; archive and delete; retention and
   `gc`; `/review` via `review/start`; asynchronous rendering polish.

> **Guard G20.** Keep the cut line. Source review, checkpoints, archive and `gc` are not
> first-release work. Do not add them back to phases 3 to 5.

---

## 26. Open decisions

1. **Claude strict-mode setting sources.** If `--setting-sources user` drops `CLAUDE.md`,
   choose between loading project settings with a warning and passing `CLAUDE.md` content
   through the brief.
2. **Checkpoint producer** (later phase).
3. **Raw activity defaults.** Off, with a temporary on-with-cap during adapter development.
4. **Apply UX.** Whether `/apply` may optionally commit on a user-named branch.
5. **Conflict resolution.** A `/resolve` agent turn versus manual resolution.
6. **Inactive worktree policy.** Automatic snapshot-and-archive after dependency-cache
   behaviour is measured.
7. **Fallback support floor.** Whether environments without app-server are compatible-mode
   only or supported in strict mode with the legacy sandbox and `secretReadDenial: false`.
8. **Convenience symlink** (§4.3), proposed.
9. **`/tmp` under the Codex profile.** Left open for tools that hard-code it; scratch is
   preferred via `TMPDIR`. Deny it if Phase 0 shows no tool needs it.

---

## 27. References

Explanatory, not substitutes for probes.

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Agent SDK streaming input (queue semantics; SDK not used):
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Agent SDK overview (authentication statement):
  https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex permission profiles: https://learn.chatgpt.com/docs/permissions
- Codex Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex hooks: https://learn.chatgpt.com/docs/hooks

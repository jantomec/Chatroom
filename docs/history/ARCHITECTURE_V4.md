# Chatroom Architecture v4

Status: design draft, 2026-09-04. Standalone; supersedes `ARCHITECTURE.md` (v1),
`ARCHITECTURE_V2.md` and `ARCHITECTURE_V3.md`. No code exists yet.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0.
Versions are evidence for the smoke tests, not compatibility promises. Section 22 lists what
was measured, what is documented, and what remains to be verified.

How to read this document: blocks marked **Comment** explain why a decision stands, or what
changed in earlier revisions and why. They are not requirements. Items marked **proposed**
were not explicitly decided by the user and can be dropped.

---

## 0. Changes from v3

1. **`/apply` no longer patches from one integration oid to another.** Because `/sync`
   folds main into integration, that range can contain user changes already present in main.
   V4 snapshots the actual main worktree into a temporary commit, merges the integration tip
   into it, and exports only the resulting snapshot-to-merge delta.
2. **Main-tree updates are journaled, not described as atomic.** The apply manifest contains
   before and after identities for every affected path. A changed main worktree aborts before
   mutation; a crash can leave a prefix applied, which recovery classifies without resetting
   user files.
3. **Strict mode has an explicit read and write boundary.** Agent worktrees and writable IPC
   move to a platform state directory outside the repository, while durable authority remains
   in `.chatroom/`. This avoids placing an allowed child beneath a denied main-tree ancestor.
4. **Approval review is separate from the sandbox boundary.** Codex may use `user` or
   `auto_review` as the reviewer for eligible escalation requests, but neither reviewer may
   override Chatroom's hard path denials. The effective reviewer is probed and visible.
5. **Source review is a separate capability.** Codex App Server's `review/start` backs an
   optional `/review` command for snapshot commits and integration tips. It is evidence for
   the user, not a correctness or security boundary.
6. **Recovery remains `recovering` until proved healthy.** Accepting a resume is insufficient;
   the driver first reconciles vendor turn state and completes a recovery turn.
7. **A Phase 0 precedes the scheduler.** Protocol, subscription-authentication, sandbox,
   approval, steering, hook and supported-Node-LTS assumptions are tested before core code is
   built. Minimal crash recovery is part of the first usable release.
8. **Probable `ask` answers are candidates, not correlation.** Only an explicit `reply_to`
   resolves the question durably; a probable answer is returned to the waiting caller with
   its uncertainty preserved.
9. **The JSONL mirror is fully validated.** Startup checks syntax, increasing ids and database
   agreement rather than comparing only its final record.

Kept from v3 without change of substance: the Claude Code CLI subscription path and
`PostToolUse` delivery, Codex App Server with `exec` fallback, SQLite authority, delivery
records, idempotent agent operations and receipts, the autonomy budget, per-conversation
workspaces, snapshot commits, integration and sync, readable delivery records, and the
first-release cut line.

---

## 1. Purpose

Chatroom is a terminal group chat with three participants:

- the user;
- Claude, through the Claude Code CLI;
- Codex, through the Codex App Server, with the Codex CLI as fallback.

All participants see every message. Addressing says who is expected to act; it does not
make a message private. Claude and Codex work concurrently, coordinate while working, and
inspect one another's work. Each agent writes only to its own Git worktree.

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
- Exactly-once execution of model tool calls. Delivery is durable and idempotent, but a
  process can crash after a side effect and before reporting it.
- Isolation from a deliberately hostile operating-system user. Agents and Chatroom run
  under the same local account.
- Native Windows. Supported targets are macOS, Linux and WSL2.

---

## 2. Principles and invariants

These are implementation requirements.

1. **One durable authority.** SQLite wins over any derived file, including the JSONL mirror.
2. **One database writer.** Only the orchestrator connection mutates the database.
   Agent-side subcommands never open it for writing.
3. **Monotonic room order.** Every message and event receives one increasing `entry_id` in
   the transaction that creates it. Display order is `entry_id`, never wall-clock time.
4. **At-least-once transport, idempotent acceptance.** A transport may retry. A logical
   delivery or agent operation is accepted once.
5. **No state rollback.** Recovery moves forward from durable facts.
6. **No orchestrator writes under agent control.** Agent-writable paths are drop boxes and
   scratch only. Receipts and deliveries live under orchestrator-owned paths.
7. **A message is durable before it is visible.** UI and scheduler observe committed
   entries only.
8. **A budget decision is deterministic.** It depends on committed message order and
   targets, not on watcher timing, batching, or whether an agent happened to be busy.
9. **A conversation maps to stable session and workspace identities.** Session resume
   never guesses by recency or working directory.
10. **Main-tree mutation is explicit and recoverable.** `/apply` is the only normal
    operation that edits the user's main worktree.
11. **Safety settings are pinned and probed.** A driver's effective filesystem boundary is
    verified through read and write attempts, not inferred from a permission mode name.
12. **Adapters are capability-based.** Vendor versions are diagnostics; behaviours are
    probed and recorded.
13. **Zero tracked or vendor-config footprint.** Briefs, hooks, settings and sandbox
    configuration reach each harness through its invocation. `.chatroom/` is hidden from Git
    and writable runtime state stays in the platform state directory.
14. **Subscription-preserving.** The Claude driver uses the same login and billing as the
    user's own `claude` sessions.
15. **Reviewers are not boundaries.** Human approval, Codex Auto-review and source review
    operate inside independently enforced path, network and ownership rules.
16. **Least-readable by default.** Strict mode exposes the repository views and runtime paths
    an agent needs, not the rest of the user's home directory. Compatible mode may widen this
    only with a visible warning.

> **Comment.** Principles 15 and 16 are new in v4. V3 correctly pinned writable roots but
> treated globally readable files and approval handling as outside the write boundary. That
> is insufficient against prompt-injected secret reads or an autonomous approval mistake.

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
 │  │ claude -p        │    │          │ codex app-server│                      │
 │  │ stream-json i/o  │    │          │ JSON-RPC stdio  │                      │
 │  └─────┬────────────┘    │          └────────┬────────┘                      │
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
| Store | Schema, migrations, transactions, queries, checkpoints, JSONL mirror. |
| IPC dispatcher | Imports agent operations, writes receipts and deliveries, enforces idempotency and limits, retires turn directories. |
| Driver | Starts or resumes one vendor session, submits turns, delivers mid-turn messages by the means the harness supports, normalizes events, relays permissions, stops work. |
| Workspace manager | Creates conversation worktrees, snapshots uncommitted changes, merges into and out of the integration branch, and performs journaled main-tree updates. |
| Agent-side command | A fast subcommand of the same executable: `post`, `reply`, `ask`, `inbox`, `hook`. Uses only paths and capabilities supplied in its environment. |

---

## 4. Project identity, locking, and disk layout

### 4.1 Project identity

Chatroom resolves `git rev-parse --show-toplevel` and
`git rev-parse --path-format=absolute --git-common-dir`. The canonical common Git directory
is hashed into a `project_id`, so a symlinked path or linked worktree cannot create a second
orchestrator for the same repository. Chatroom refuses to start from one of its own managed
worktrees.

The project lock is an advisory OS lock held on an open file descriptor. PID and start time
are diagnostic fields. A second process fails immediately with the owner's information.

### 4.2 Global files

```text
<install>/chatroom                         executable or launcher
~/.config/chatroom/config.toml             optional defaults
<platform-state>/chatroom/projects/         untracked runtime roots by project id
```

The orchestrator resolves its own real executable path at startup and passes it to agents
as `CHATROOM_BIN`. Hooks and shell integration never rely on an unqualified `chatroom`
found through a project-controlled `PATH`.

### 4.3 Per-project files

```text
<project>/
  .chatroom/
    lock
    config.toml
    chatroom.sqlite3                       authority
    chatroom.sqlite3-wal / -shm
    transcript/
      <conversation-id>.jsonl              derived mirror, appended on every commit
    logs/
      <conversation-id>/
        <turn-id>.<agent>.jsonl            raw vendor events, opt-in
        <turn-id>.<agent>.stderr
    recovery/
      <operation-id>/
        manifest.json                     paths, hashes and before/after identities
        candidate.patch                   exact main-tree mutation
        objects/                          private Git object overlay while apply is recoverable
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a
real directory beneath the project root. The directory is mode `0700`; database and log
files are `0600`, subject to platform support. Agents receive no read or write access to
this directory in strict mode.

### 4.4 Per-project runtime files

`<platform-state>` is the operating system's per-user state directory, resolved without
consulting the project environment. The project runtime root is keyed by `project_id`:

```text
<platform-state>/chatroom/projects/<project-id>/
  ipc/
    claude/
      from-agent/<turn-id>-<nonce>/        exact agent-writable drop root for a turn
      to-agent/deliveries/                 orchestrator-owned, agent-readable
      to-agent/receipts/                   orchestrator-owned, agent-readable
      scratch/<turn-id>-<nonce>/           agent-writable temp root; never imported
      staging/                             orchestrator-owned quarantine
    codex/
      (same)
  worktrees/
    <conversation-id>/
      claude/
      codex/
  integration/
    <conversation-id>/                     temporary integration worktree when needed
```

The project runtime root and every orchestrator-owned ancestor are real directories owned
by the current user, mode `0700`, and opened with no-follow checks. IPC files are `0600`.
The runtime path is stored in the database and must map back to the canonical Git common
directory before reuse. Cleanup covers both the repository-local authority and this runtime
root.

> **Comment.** V3 nested writable worktrees and IPC below `.chatroom/` while also denying
> writes to the main tree and `.chatroom/`. Deny-first permission systems cannot reliably
> reopen such children. Separating authority from runtime makes `.chatroom/` wholly denied,
> keeps the main worktree read-only to agents, and leaves only exact external roots writable.

> **Comment.** `transcript/<id>.jsonl` exists so the
> user can `tail -f` or grep a conversation without the tool. It is regenerable from the
> database and is never read by recovery.

---

## 5. Durable storage

### 5.1 Engine and settings

The store uses `node:sqlite`, which is present in the Node release on the development
machine with an experimental-feature warning. Phase 0 must also pass the database suite on
the oldest supported Node LTS; otherwise the binding is replaced before implementation is
based on it. One write connection; read-only diagnostic commands may open a read-only
connection when no migration is pending.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations run under an exclusive lock and keep a pre-migration backup.

> **Comment.** v2 recommended "a mature binding with packaged native binaries" and flagged
> distribution as a risk. `node:sqlite` removes it. If its experimental status bites, the
> schema and transaction boundaries do not change; only the binding does.

### 5.2 JSONL mirror

After every committed transaction that creates entries, the store appends the new entries
to `transcript/<conversation-id>.jsonl` in `entry_id` order. This append is deliberately
outside the database transaction; the file is a derived view and may lag or end in a partial
line after a crash.

On startup, and on `chatroom log --verify`, scan the whole mirror: every line must parse and
the ordered `entry_id` sequence must exactly equal the database query for that conversation
(global ids may legitimately skip because other conversations have entries). The count and
final id must also agree with SQLite. Any malformed, missing,
duplicated or extra line causes a rewrite through a sibling temporary file, `fsync`, and
rename. `chatroom log --jsonl` prints the same canonical content. Large-log optimization may
add chunk hashes later; checking only the final record is never sufficient.

### 5.3 Schema

Logical SQL; exact indexes and check constraints belong in migrations.

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
                                 -- reviewer: user | auto_review | managed | none

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, base_oid,
  head_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))
                                 -- owner: claude | codex | integration

integration_operations(id PK, conversation_id FK, type, status, manifest_json,
  created_at, finished_at)       -- type: snapshot | integrate | sync | apply | remove

reviews(id PK, conversation_id FK, requested_by, target_type, target_oid,
  status, reviewer_thread_id, findings_json, created_at, finished_at)
                                 -- target: snapshot commit or integration tip

checkpoints(id PK, conversation_id FK, through_entry_id, summary,
  workspace_manifest_json, created_at)
```

> **Comment.** `agent_sessions.status` keeps `suspect` in place of v2's `tainted`, because
> Chatroom tries to resume a suspect session instead of discarding it (§13.3). `turn_inputs`
> and `deliveries` gain the `hook` transport for Claude's mid-turn path.

### 5.4 Transaction boundaries

Each of these is one transaction:

- append a message, resolve targets, create delivery rows, reserve autonomy credits;
- create a turn, attach its initial input set, set the agent to `preparing`;
- accept a delivery and mark its messages delivered;
- append an agent's final reply and end its turn;
- import an agent operation and write its logical receipt result;
- record a permission decision;
- start or finish a source review tied to its immutable target oid;
- plan or finish a Git integration operation.

Crossings into child processes, filesystem renames and Git use an intent record followed
by reconciliation, so recovery can tell "not started", "completed", and "in between".

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

Agent-side commands accept `--to <handle>[,<handle>]` as an explicit override. When both
are present, `--to` wins and the body is stored as written.

The body is stored exactly as authored. Resolved targets are separate rows, never
reconstructed from text later. The REPL and the delivery header always show the resolved
targets.

> **Comment.** v2 told agents to use `--to` and reserved mentions for humans. That put two
> conventions in one room and let an agent message carry a target with no visible mention.
> The user chose `@handle`; V3 made it the single convention and V4 keeps `--to` as an
> escape hatch, since v2's point that metadata must not be reconstructed from text stands.

### 6.2 Visibility and delivery rows

Every message is visible in the user's transcript immediately after commit. A delivery row
is created for each agent other than the author, target or not. A non-target delivery waits
until that agent next receives a triggering message, which preserves "everyone sees
everything" without waking an agent for status chatter.

### 6.3 Operation and causal identifiers

Agent-side commands generate a random UUID `operation_id` before writing anything. A retry
uses the same id. `(agent, operation_id)` is unique.

Messages may carry `reply_to` (the message being answered), `causal_root` (normally the
user message that began the piece of work), and `turn_id`. `chatroom reply <id> <body>`
sets `reply_to` explicitly and targets that message's author unless `--to` overrides. A
turn's final reply is linked to its newest triggering input unless the agent already posted
an explicit reply. Causal fields support `ask` and diagnostics; they never affect order.

### 6.4 Limits

Defaults, configurable within hard caps: message body 64 KiB; operation file 96 KiB; posts
per turn 100; unprocessed operation files per turn 256; delivery batch 64 messages and a
driver-specific token budget; receipt retention seven days after archive. Oversized content
is rejected before it reaches the transcript.

---

## 7. Autonomy budget and scheduling

### 7.1 Meaning of the budget

The budget limits how many agent-authored messages may activate the other agent after the
most recent user message. It is a credit counter, not graph depth.

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery to that agent is `held`. The message is still visible to the
  user.
- Messages to the user cost nothing.
- One message costs at most one credit, whatever the transport or batching does.

Held deliveries are released by either of two things, and charged once when released:

- the user addresses the held recipient, or everyone; the held messages join that batch and
  cost nothing, because the user has explicitly reactivated the recipient;
- the user raises `/budget`; held deliveries are released in entry order while credit lasts.

A user message that addresses only one agent does not release the other agent's held
deliveries, even though it resets the counter.

> **Comment.** v2 had this behaviour but did not say the asymmetry was intentional. It is.
> "Held" means "the other agent tried to activate you while the room was out of credit";
> only the user re-opening that recipient, or a deliberate budget change, should end it.
> The counter reset exists so that new agent-to-agent traffic after the user speaks starts
> from zero.

### 7.2 Scheduler states

Per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. At most one turn is active per agent and conversation. Claude
and Codex may each have one active turn concurrently.

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
    else if A is running and driver.can_steer:
        mark batch publishing; steer the active vendor turn
        on protocol acceptance mark accepted; on rejection return to queued
    else if A is running and driver.can_hook_deliver:
        mark batch publishing; write delivery files
        accepted when the agent's delivery_ack arrives; returned to queued at turn end if not
    else:
        leave batch queued for the next turn boundary
```

Native acceptance means the vendor process accepted the input, not that the model acted on
it. Hook acceptance means the hook ran and acknowledged. Both are what Chatroom can prove.

### 7.4 Fairness and backpressure

Both agents start in the same event-loop tick when both have eligible work. The scheduler
never waits for one agent to claim work before starting the other; the brief requires
immediate claims and mid-turn delivery carries them. If a sender posts faster than the
recipient can process, messages stay durable and are coalesced into bounded batches. Every
post gets a receipt even when its target is held.

---

## 8. File IPC protocol

File IPC carries everything that originates inside an agent's tool shell, and deliveries
for the hook transport. Native protocols carry orchestrator-to-model input whenever the
harness has one.

### 8.1 Per-turn environment

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT` | `claude` or `codex` |
| `CHATROOM_CONVERSATION` | conversation UUID |
| `CHATROOM_TURN` | Chatroom turn UUID |
| `CHATROOM_OPERATION_DIR` | absolute, exact agent-writable drop directory for this turn |
| `CHATROOM_DELIVERY_DIR` | absolute orchestrator-owned directory, agent-readable |
| `CHATROOM_RECEIPT_DIR` | absolute orchestrator-owned receipt directory |
| `CHATROOM_SCRATCH` | absolute per-turn temp directory |
| `CHATROOM_BIN` | absolute path of the running executable |
| `CHATROOM_PROTOCOL` | integer agent-command protocol version |

Strict-mode driver environments also set `GIT_OPTIONAL_LOCKS=0`,
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. Agents may inspect immutable
oids and worktree state, but Git must not refresh indexes, run user aliases, or modify refs.

The turn's random directory nonce is part of the path rather than trusted from a payload.
The parent of the writable directory is not writable by the agent, so the agent cannot
replace the granted root. Identity is assigned from the driver and the fixed drop root,
never from a field in a file.

Measured for V3's legacy Codex fallback: `workspace-write` blocks writes outside the working
directory, opens explicit `writable_roots`, allows reads anywhere, and denies Unix-socket
connections. V4's strict profile narrows reads, but the no-socket result remains why files
are the common agent-side IPC channel.

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

The command opens a unique temporary regular file in `CHATROOM_OPERATION_DIR`, writes and
fsyncs it, then renames it to `<operation-id>.json`. Filesystem notifications are latency
hints; a poller is authoritative. The dispatcher renames each entry into `staging/`, checks
with no-follow semantics that it is one bounded regular file, validates protocol, id, turn,
type, targets and UTF-8, imports it transactionally or returns the previous result for a
duplicate id, and writes a receipt under `to-agent/receipts/` by temp-file-and-rename.

### 8.3 Receipts

```json
{"protocol": 3, "operation_id": "f7515aa7-…", "status": "accepted", "message_id": 42}
```

`chatroom post` waits briefly for the receipt and prints `#42`. A local timeout means
"acceptance unknown", not failure; the command prints the operation id, and a retry with
that id returns the same result.

Before a turn is finalized, the orchestrator closes the drop root to new imports, drains
files already published, waits a short grace period, then retires the directory. This
removes the process-exit race for a final `post`.

### 8.4 Deliveries and acknowledgment

For the hook transport, the orchestrator writes one atomic file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack` operation into the current drop directory. They never move or delete the
delivery file; the orchestrator removes it after the database says it was accepted.
Parallel readers are safe because acknowledgment is idempotent.

### 8.5 `ask` and `reply`

```sh
"$CHATROOM_BIN" ask "@codex list or iterator?"
"$CHATROOM_BIN" reply 52 "It returns an iterator."
```

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`, for an answer. Only a
message whose `reply_to` is the question id durably resolves it. A later message from one of
the asked parties that targets the asker is displayed and retained as a `probable` candidate,
but it does not close the question or satisfy any correlation invariant.

If the timeout expires with exactly one candidate, the command returns that message with
`status: probable` and tells the agent it may use the content while preserving the
uncertainty. With no candidate or several candidates it returns `status: indeterminate`.
Other incoming messages are printed while waiting. The question stays durable in every
case, and a later explicit reply can still resolve it. The configured timeout must be below
the effective tool-command timeout measured for that driver, with a safety margin; there is
no assumed vendor default.

> **Comment.** Models often answer with a plain post. V3 treated the first matching post as
> the answer, which can mis-correlate concurrent status traffic. V4 keeps the useful text but
> reserves durable resolution for an explicit reply id.

---

## 9. Driver contract

Drivers expose semantic capabilities, not CLI flags:

```ts
type DriverCapabilities = {
  persistentSession: boolean;   // resume by explicit id
  longLivedProcess: boolean;    // several turns per process
  nativeSteering: boolean;      // input accepted into a running turn
  hookDelivery: boolean;        // PostToolUse hook injection
  interrupt: boolean;
  hostApprovals: boolean;
  approvalReviewers: Array<"user" | "auto_review">;
  inspectTurnState: boolean;    // reconcile an ambiguously accepted turn
  sourceReview: boolean;        // review a commit or integration tip
  fineGrainedFilesystem: boolean;
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
  review(target: ReviewTarget): Promise<ReviewResult>;                    // if sourceReview
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(turn: VendorTurn): Promise<void>;
  events(): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
```

Calling an unsupported optional method is a programmer error. The scheduler branches only
on recorded capabilities.

### 9.1 Capability probing

`chatroom doctor` records, per driver: executable real path and version; supported commands
and flags; protocol initialization; session start, resume and interruption; native steering
or hook delivery during a harmless turn; ambiguous-turn inspection where supported;
permission request, human-review and Auto-review flows; source review where supported;
effective working directory; read and write success only in the declared roots; denied
secret reads; write failure in the main tree, peer worktree, inbound IPC, database and a
random outside path, through both shell commands and the harness's own file tools; effective
network and Unix-socket policy; loaded instruction, settings, hook, plugin, app and MCP
sources where the vendor reports them; and, for Claude, that the session is authenticated
with the user's login rather than an API key.

Only probe results enable a capability. Results are cached with executable hash, version,
platform, config fingerprint and expiry.

> **Comment.** A shell probe and a native file-tool probe test different mechanisms. Read
> denials are tested too: blocking writes while allowing arbitrary reads is not strict mode.
> The authentication probe exists because principle 14 is easy to violate silently, for
> example by an `ANTHROPIC_API_KEY` in the environment.

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

Working directory: the conversation's Claude worktree. Environment: the variables of §8.1,
with any `ANTHROPIC_API_KEY` removed so the CLI uses the user's login.

- A turn is one `user` message written on stdin and the `result` event that ends it.
  Further messages written while a turn runs are queued by the CLI and processed
  sequentially; the driver therefore writes a turn's input only when the scheduler starts
  a turn, so the CLI's queue never holds more than the current turn.
- `longLivedProcess` is true: the process stays up between turns, so resume happens once
  per chatroom run, not per turn. If the process dies, the driver reconnects with
  `--resume` and reports `session: suspect` (§13.3).
- `nativeSteering` is false. `hookDelivery` is true (§10.2).
- Reply text comes from the `result` event, which also carries duration and cost.
- Activity comes from `assistant` events: `text` blocks as interim narration, `tool_use`
  blocks as tool activity, `thinking` blocks as reasoning if the stream includes them.
- The system prompt and settings are not part of the persisted session, so they are passed
  on every process start.

> **Comment.** v2 used the Agent SDK for the same protocol. The SDK docs say
> "Anthropic does not allow third party developers to offer claude.ai login … including
> agents built on the Claude Agent SDK" and direct SDK users to API keys. The CLI is the
> supported way to use the subscription. The SDK's streaming input, permission callbacks and
> hooks are wrappers around exactly these CLI flags. The doc that "messages process
> sequentially" also settles that streaming is a queue, which is why mid-turn delivery
> needs the hook below.

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

Claude Code documents that `additionalContext` from a `PostToolUse` hook is appended to the
tool result, so the model reads it before its next step. Hooks run as ordinary child
processes of Claude Code, outside the Bash sandbox, with the driver's environment.

Limits: an agent that is generating text without tool calls hears nothing until its next
tool call or the end of its turn, in which case the batch is returned to `queued` and leads
its next turn. Delivery text is kept under `maxDeliveryBytes`, with long bodies truncated
and a note to run `chatroom inbox`.

### 10.3 Permissions

`--permission-prompts host` routes anything `auto` mode would ask to the driver as a
control request on stdout. The driver records a `permissions` row, the REPL shows it with a
short id, and the answer goes back on stdin as a control response. The wire shapes are not
in the official docs; `doctor --smoke` confirms them against a recorded fixture.

### 10.4 Fallback

If the long-lived process misbehaves in the smoke test, the driver runs one process per
turn with the same flags. Nothing else changes; `longLivedProcess` becomes false.

---

## 11. Codex driver

### 11.1 Transport

The driver runs `codex app-server` as a child process over stdio, which is the transport
its help lists as default, and speaks JSON-RPC:

- new or resumed Chatroom session to `thread/start` or `thread/resume`, with the
  conversation's Codex worktree as working directory and the sandbox configuration of §15.3
  supplied per thread;
- a turn to `turn/start`; mid-turn batches to `turn/steer` with the expected vendor turn id;
- `/stop` to `turn/interrupt`;
- streamed items and deltas to common driver events; `reasoning` items give reasoning
  summaries, `agent_message` interim text, `command_execution` and `file_change` tool
  activity;
- eligible approval requests to the configured reviewer (§11.2), with human requests sent
  to the REPL;
- commit and branch review through `review/start` (§11.3).

Authentication is the user's existing Codex login in `~/.codex/auth.json`, which the CLI,
app-server and desktop app share.

`nativeSteering`, `interrupt`, `hostApprovals`, `inspectTurnState` and `sourceReview` are true
only if their probes pass; `hookDelivery` is false and unnecessary on this path.

### 11.2 Approval review

Three concepts stay separate:

1. The permission profile defines which reads, writes and network destinations are possible
   without escalation, and which paths are hard-denied.
2. `approval_policy` decides which otherwise eligible boundary crossings create a request.
3. `approvals_reviewer` decides whether the user or Codex Auto-review evaluates that request.

Chatroom accepts `inherit`, `user` and `auto_review`. `inherit` reads the effective Codex
configuration after managed policy is applied. Auto-review requires `on-request` or a
granular policy that still surfaces the category; with `never` there is nothing to review.
Availability is account- and organization-dependent, so a requested but unavailable
reviewer falls back to `user` with a visible event unless managed policy requires failure.

Hard-denied reads and writes—especially main, peer and integration writes; `.chatroom/`;
other project runtime roots; vendor authentication; and configured secret paths—must fail
before either reviewer is consulted. Strict mode refuses startup unless a negative probe
confirms that an explicit permission request cannot grant those paths. Reviewable examples
are a narrowly identified package-registry connection or a configured external build cache.

For a human-reviewed request, the driver writes a pending `permissions` row and sends it to
the REPL. For Auto-review, it records the reviewer, decision and rationale exposed by App
Server; if a version exposes only the resulting tool status, the row says that the rationale
was unavailable rather than inventing one. A denial is shown as activity and returned to the
working agent. Auto-review is advisory automation, not a deterministic security guarantee.

### 11.3 Source review

App Server's `review/start` is unrelated to approval Auto-review. `/review` snapshots the
selected agent if necessary, resolves an immutable commit or integration oid, and requests
`delivery: "detached"` so review narration does not alter the working agent's thread. The
review turn uses a generated read-only profile with access to the target Git objects and no
writable agent worktree. If the installed App Server cannot prove that override, the
`sourceReview` capability is disabled. The driver records the review thread id, exact target
oid, terminal status and final findings.

A completed review never means “safe” or “approved” by itself. It is review evidence tied to
one oid; any later integration invalidates it for the new tip. An optional policy may require
a completed review of the exact integration tip before `/apply`, but findings remain for the
user to judge. The first release exposes manual `/review`; automatic gating is later work.

### 11.4 Fallback: `codex exec`

If app-server probing fails:

```text
codex exec --json -o <file> \
  -c 'default_permissions="<generated-chatroom-profile>"' \
  -c 'shell_environment_policy.set={…}' \
  [-c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust] -         (prompt on stdin)
codex exec resume <thread-id> --json -o <file> -c 'default_permissions="…"' … -
```

`exec resume` has no `--cd`; the working directory comes from spawning in the worktree and
the generated permission profile from `-c`. Passing `--sandbox` here would select the legacy
sandbox and disable the profile. There are no approvals, Auto-review, source review or native
steering on this path. In strict mode, a version that cannot load and enforce the generated
fine-grained profile is unsupported; compatible mode may use the legacy `workspace-write`
fallback after warning that reads are broad.

Hook delivery is enabled only when `doctor` finds no hook source other than Chatroom's,
because the trust bypass runs every enabled hook from every configuration layer. If any
other source exists, the fallback runs without mid-turn delivery and says so in `/status`.

> **Comment.** v2 forbade the hook on this path. The objection was correct: the bypass flag
> is not scoped to our hook. Gating on "no other hook sources" keeps the objection's
> substance while preserving the only mid-turn channel the fallback has. App-server is
> still labelled experimental in the CLI, so the fallback may be the path that actually
> runs on some versions.

---

## 12. Turn lifecycle

### 12.1 Starting a turn

1. In one transaction: select every undelivered message through the newest eligible
   trigger, create the turn, attach ordered `turn_inputs`, mark those deliveries
   `publishing`, append `turn_started`.
2. Create exact per-turn drop and scratch directories.
3. Ensure the vendor session is connected, resuming by explicit id if needed, and verify
   its working directory.
4. Submit the input through the native channel: stdin for Claude, `turn/start` for
   app-server, stdin for `exec`. Never as an argument.
5. On acknowledgment, store vendor turn and session ids, mark deliveries `accepted`, set
   the turn `running`.
6. Stream normalized activity to the REPL and, if enabled, the raw log.

If spawning or submission fails, the same transaction that records failure returns
`publishing` deliveries to `queued`.

### 12.2 During a turn

- Agent-side posts are imported independently of model output.
- Eligible messages for a running agent are steered or hook-delivered per capability.
- Permission requests stop only the requesting operation; the other agent and the REPL
  stay live. A human decision is durable before the driver receives it. An App Server
  Auto-review decision is recorded immediately when its observable event arrives.
- `/stop` requests protocol interruption first, then SIGTERM, then SIGKILL after grace
  periods.

### 12.3 Ending a turn

1. Receive the terminal event and final reply.
2. Close the drop root to new files and drain published operations.
3. In one transaction: append the non-empty final reply with idempotency key
   `final:<turn-id>` and `via: final`, or append `silent` when the reply is empty or
   exactly `[silent]`; store cost; mark the turn ended; clear the active-turn reference.
4. Write pending receipts, return unacknowledged hook deliveries to `queued`, retire
   per-turn directories, run the scheduler.

A final reply with no mention targets the user. A final reply that merely repeats an
accepted `post` should be `[silent]`; no textual deduplication is attempted.

### 12.4 Steering and hook races

If the vendor reports no matching active turn, or a hook delivery is unacknowledged at turn
end, the batch returns to `queued` and leads the next turn. The autonomy credit stays
charged; transport retries never charge again.

---

## 13. Sessions, checkpoints, and recovery

### 13.1 Sessions are caches

Room transcript, accepted deliveries, workspace snapshots and checkpoints are durable
truth. Vendor sessions are performance caches with a `generation`. Session ids are always
explicit. A picker, `--last` or `--continue` is never used. A resumed session must report
the expected id and working directory, else it is `lost`.

### 13.2 Checkpoints

After configurable growth, Chatroom asks one agent or a dedicated summarization turn for a
checkpoint: decisions and open questions; work claimed and completed per agent; relevant
message ids; workspace and integration oids; test and build status as reported in the room;
nothing untraceable to messages or Git. Stored with `through_entry_id`. Rebuilding uses the
newest checkpoint plus later messages and a fresh workspace manifest.

### 13.3 Suspect sessions

A session becomes `suspect` when Chatroom cannot prove how an in-flight request ended:
orchestrator crash, SIGKILL, transport loss after acceptance, malformed terminal output.

Recovery:

1. Inspect and snapshot the agent worktree.
2. Record the interrupted turn and the accepted input ids.
3. If `inspectTurnState` is available, query the exact vendor thread and turn before sending
   anything. Reconcile a terminal turn from its history; reconnect to a still-active turn
   when the protocol supports that; otherwise retain the ambiguity in the interrupted row.
4. Attempt a resume by explicit session id and verify the reported id and working directory.
   A successful resume changes `suspect` to `recovering`, not `healthy`.
5. As the first new input, send a recovery note containing the interrupted turn, accepted
   message ids, reconciled vendor evidence and current workspace diff, with the instruction
   to inspect side effects before repeating anything. Do not attach new queued room work to
   this recovery turn.
6. Mark the session `healthy` and advance `last_confirmed_entry_id` only after the recovery
   input is accepted and its turn reaches a valid terminal event. If resume is refused, the
   identity or directory is wrong, or the recovery turn cannot complete, keep it suspect or
   mark it `lost` and rebuild from checkpoint and tail as a new generation (§13.4).

> **Comment.** V3's decision to try resume before rebuild is retained, but accepting a resume
> proves only that the session id exists. The recovery turn is the health check. Keeping new
> work out of it also prevents an ambiguous old side effect from being confused with a fresh
> request.

### 13.4 Lost session rebuild

Mark the old generation `lost`, create a new one, build a bounded prompt from brief,
latest checkpoint, later messages, referenced earlier messages and workspace state, start a
fresh session, store the new id after acknowledgment, append `session_rebuilt`. If the
checkpoint plus required tail exceeds the driver's budget, stop and ask the user to archive
or split the conversation.

### 13.5 Startup reconciliation

Before scheduling: mark turns left `preparing` or `running` as interrupted and in-flight
reviews as failed; verify that the external runtime root is owned, no-follow and mapped to
the same canonical Git common directory; reconcile staged IPC operations by id; recreate
missing delivery or receipt files from rows; quarantine files that belong to no active or
recoverable turn; reconcile every `planned` or `executing` Git operation path-by-path via its
manifest; verify worktree paths, refs, oids, ownership tokens and main tree status; fully
validate and, if necessary, rebuild the JSONL mirror; reconnect sessions only after workspace
reconciliation succeeds. Suspect and recovering sessions cannot receive queued room work.
Ambiguous main-tree changes cause a hard stop with a precise recovery command.

---

## 14. What agents receive

### 14.1 Delivery format

Used for turn inputs, steering, hook injection and `chatroom inbox`. A short invariant
header, then one record per message.

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

Changed paths are advisory; agents inspect files before relying on them. The header is
repeated on every delivery so the rules survive vendor compaction.

> **Comment.** V2 rendered records as JSON lines to keep body text from being confused with
> metadata. V3 returned to readable records because bodies often contain code, JSON
> escaping makes that hard to read, and Codex caps hook-injected context at 2500 tokens by
> default. The `--- #id` delimiter is a convention, not a security boundary; targets are
> still metadata rows.

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
- Read {peer_worktree} when useful; never write there. The peer may be mid-edit, so the chat
  is where intent is stated. Main and integration are immutable oids in the header; inspect
  them with `git show` or `git diff` from your own worktree, not through the user's main path.
- Do not commit, merge, rebase, reset or edit Git refs. Chatroom snapshots all non-ignored
  changes and owns integration.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`brief.extra` from configuration is appended with a visible label, size-capped, never
interpolated into shell code.

---

## 15. Sandboxing, permissions, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected reads of undeclared user data,
writes outside an agent's assigned workspace, malformed IPC files, duplicate operations,
and common path and symlink attacks. Strict mode assumes anything a model tool can read may
reach that model's provider, even when command network access is disabled. Its read boundary
is therefore part of the security boundary, not a privacy footnote.

The repository is assumed trusted enough to run its normal build and test tooling inside
the declared boundary. Chatroom does not isolate a deliberately malicious process running
as the same operating-system user, guarantee that an allowed dependency is benign, or hide
source files the user intentionally makes readable to an agent. Compatible mode may expose
more user configuration or filesystem data, but must enumerate the difference before work
starts.

### 15.2 Claude

Claude Code's sandbox covers Bash commands, using Seatbelt on macOS and bubblewrap on
Linux. Built-in Read, Grep, Glob, Edit and Write tools are governed separately by permission
rules. Strict mode therefore pins both layers through inline `--settings` JSON. Logical
placeholders below expand to canonical absolute paths using the syntax probed for the
installed CLI:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "denyRead": ["/"],
      "allowRead": ["<platform minimal runtime>", "<own worktree>",
                    "<peer worktree>", "<git common dir>",
                    "<delivery root>", "<receipt root>", "<drop root>",
                    "<scratch root>", "<CHATROOM_BIN and runtime>"],
      "allowWrite": ["<drop root>", "<scratch root>"],
      "denyWrite": ["<own worktree>/.git", "<main tree>", "<peer worktree>",
                    "<git common dir>", "<integration runtime>",
                    "<project>/.chatroom"]
    },
    "network": {"allowUnixSockets": []}
  },
  "permissions": {
    "deny": ["Read", "Grep", "Glob", "Edit", "Write"]
  }
}
```

The current native file tools do not expose a probe-verified allowlist boundary equivalent
to the Bash sandbox. Strict mode disables them and has the agent read and edit through
ordinary sandboxed commands. A future CLI may re-enable them only after negative read and
write probes prove the same boundary. Compatible mode may retain native tools and their
normal approval flow with a warning.

The sandbox re-allows a probe-generated platform runtime set, the own and peer worktrees,
Git object database, exact IPC views and the resolved Chatroom launcher/runtime inside the
otherwise denied filesystem. Main and integration contents are read through
their immutable oids in that object database; the user's actual main path and temporary
integration worktree are not readable to the model. Global Git configuration is disabled in
the driver environment. Any additional toolchain or cache root must be configured explicitly.
Exact path semantics,
symlink targets, shell reads and writes, and native-tool denials are smoke-tested.
`autoAllowBashIfSandboxed` lets commands already inside this boundary run unattended; it
does not permit fallback to unsandboxed execution.

Own, peer and Git-history content is intentionally readable as project source. A configured
secret path that overlaps one of those required views is a strict-mode configuration error
unless the installed harness proves a narrower deny; Chatroom never silently claims that a
broad allowed ancestor still protects the child.

### 15.3 Codex

Strict mode uses a uniquely named, generated Codex permission profile rather than the
legacy `sandbox_mode` settings; the two systems must never be supplied together. The
profile grants:

```text
read   platform minimal runtime, Chatroom executable/runtime, peer worktree, Git common
       objects and metadata, delivery root and receipt root; own worktree is included by write
write  own worktree, current drop root and current scratch/TMPDIR root
deny   own-worktree .git link, actual main tree, integration runtime, <project>/.chatroom,
       other projects' runtime roots, vendor-authentication paths,
       configured secret paths, /tmp and ambient temp roots other than CHATROOM_SCRATCH
network disabled, or enabled only through the configured domain proxy policy
```

The more-specific Git-common read reopens only repository objects and metadata inside the
otherwise denied main root; `.chatroom` remains denied. Runtime state is denied by default
and only the current conversation's exact paths are opened. A random profile name prevents
lower-precedence user configuration from extending the same profile;
the definition is supplied through an ephemeral invocation/session configuration layer and
is never written to user or project Codex files. The effective profile is read back from App
Server and fingerprinted with the turn.

Permission profiles are capability-gated because their interface is beta. If the installed
Codex cannot enforce the generated profile through shell commands, file-change tools and
explicit permission requests, strict mode refuses to start that driver. Compatible mode may
fall back to legacy `workspace-write`, but must report that reads outside the project are
broad. Chatroom never uses `danger-full-access`, `--yolo`, or an approvals-and-sandbox
bypass.

### 15.4 Approval and review boundaries

Human approval and Codex Auto-review operate only on categories the hard profile marks as
reviewable (§11.2). Requests involving a hard-denied path are rejected before review. Source
review (§11.3) reads an immutable Git object and produces findings; it grants no permission
and changes no integration or apply state. Negative tests exercise all three layers so a
vendor update cannot silently turn a denial into a reviewable prompt.

### 15.5 Customization modes

| Mode | Behaviour |
|---|---|
| `strict` (default) | The orchestrator reads project `CLAUDE.md` and `AGENTS.md` as text and supplies the applicable content in the brief. Vendor project/local settings, user/project hooks, plugins, apps, dynamic tools and MCP servers are disabled unless explicitly allowlisted. Claude uses a probe-verified setting-source combination that preserves login without loading executable customization. Codex App Server uses managed-hooks-only behavior and an explicit tool allowlist. The `exec` fallback requires that Chatroom's hook is the only non-managed hook. Refuse startup when a harness cannot separate authentication and instructions from execution-extending configuration. |
| `compatible` | Load normal vendor customization. Show every detected source in `/status`; warn when one widens hooks, tools, commands, readable data, network or writable paths. Database, IPC and ref ownership checks still apply, but filesystem isolation is explicitly not guaranteed when an external hook or tool runs outside the pinned sandbox. |

Managed organization policy always remains in force.

### 15.6 Identity

Sender identity comes from the driver and the fixed drop root, never from a payload. The
random turn path and operation id prevent cross-turn reuse. Processes share one OS account,
so this is not isolation from a deliberately malicious local process.

---

## 16. Conversation workspaces and Git integration

### 16.1 One workspace set per conversation

A conversation owns three refs, named with opaque ids:

```text
refs/heads/chatroom/<project-short>/<conversation-short>/claude
refs/heads/chatroom/<project-short>/<conversation-short>/codex
refs/heads/chatroom/<project-short>/<conversation-short>/integration
```

All begin at main's HEAD when the conversation is created; that oid is recorded as
`integration_base_oid`. Claude and Codex have stable worktree paths under
`<platform-state>/chatroom/projects/<project-id>/worktrees/<conversation-id>/`, which
preserves vendor session identity without placing writable paths below the denied main tree.
The integration ref normally has no worktree; a temporary one is created under the same
runtime root for merges.

Inactive conversations may be archived: snapshot, `git worktree remove`, keep refs,
transcript, sessions and path metadata. Continuing recreates the worktrees at the same
paths before sessions resume.

> **Comment.** V1 proposed one worktree pair shared by all conversations. V2's argument for
> per-conversation worktrees, that a resumed session must never find another conversation's
> files in its working directory, is right. The cost is disk and dependency setup per
> conversation, mitigated by archiving.

### 16.2 Snapshotting uncommitted work

With the agent stopped, `/snapshot <agent>` captures tracked and non-ignored untracked
files: write an intent with expected oids; build a temporary index from the agent branch
HEAD; add the worktree through it, not through the agent's real index; `git write-tree` and
`git commit-tree`, bypassing hooks and signing; update the Chatroom-owned ref with its
expected old oid; align the worktree's index to the new commit without touching files;
record the oid. Ignored files are not captured. Staging state is not preserved.

### 16.3 `/integrate <agent>`

Refuse while the agent runs; snapshot; create or refresh the integration worktree; merge
the agent branch into integration with normal ancestry, no hooks, no signing; on success
record the oid and remove the temporary worktree; on conflict abort with nothing changed
and report files. Later integrations contain only new snapshots.

### 16.4 `/sync <agent|all>`

1. If main's HEAD is not an ancestor of the integration branch, merge main's HEAD into
   integration first and record it as the new `integration_base_oid`. On conflict, stop and
   report; nothing else changes.
2. Snapshot the agent, then merge integration into the agent branch. On conflict the agent
   worktree enters a documented conflict state with its pre-sync snapshot safe; Chatroom
   will not start a normal turn there until the user resolves it or aborts to the snapshot.

`/import <source> <destination>` is integrate source, then sync destination.

> **Comment.** V3 introduced step 1 so agent branches do not drift after the user commits
> applied work. V4 keeps it but no longer treats the raw integration range as an exportable
> patch: that range may now contain main commits (§16.5).

### 16.5 `/apply [agent]`

`/apply` materializes the integration tip's changes in the user's current main worktree;
`/apply <agent>` is integrate then apply. `applied_integration_oid` is an audit/high-water
marker only. It decides whether a newer integration tip exists but is never used as a raw
patch base, because the intervening history may include main commits folded in by `/sync`.

Preconditions: no prior apply needs recovery; the integration tip is a descendant of the
recorded applied marker when one exists; any configured review requirement is satisfied for
that exact tip; and main's Git metadata, index and working tree can be fingerprinted. No
involved path may resolve through a symlink outside the repository.

Preflight:

1. Create a private Git object directory under `.chatroom/recovery/<operation-id>/`, with the
   repository object database configured as a read-only alternate. Record main HEAD, index
   state, tracked working-tree contents and file types. Inventory untracked paths separately;
   do not copy their contents. A temporary index writes new blobs and trees only to the
   private object directory. Create synthetic commit `S` there, parented by main HEAD, whose
   tree contains the user's actual tracked contents. Uncommitted user bytes never enter the
   repository's normal object database. An untracked or ignored path that the merge would
   create, replace or traverse is a collision and aborts.
2. In a temporary merge worktree backed by the same private object overlay, merge the
   immutable integration tip using normal Git ancestry, with hooks and signing disabled. A
   conflict removes the temporary worktree and private overlay and changes nothing in main.
3. Write the merged result as tree `R` and generate the binary candidate delta `S..R`. If it
   is empty—typically because `/sync` imported only changes already present in main—advance
   `applied_integration_oid` with a no-op event and do not touch the worktree.
4. Compute the main dirty set against main HEAD, including staged, unstaged, intent-to-add,
   non-ignored untracked, rename source and destination, submodule and file/directory cases.
   Reject if it intersects an affected candidate path. Intersection is ancestor-aware and
   uses the filesystem's case and Unicode-normalization behavior, not string equality alone.
5. Before any main-tree write, persist and `fsync` the candidate patch and private object
   overlay, then durably record an `executing` manifest containing main HEAD, `S`, `R`,
   integration tip, index fingerprint, candidate patch hash, affected paths, and each path's
   expected before and after blob, mode and type.

Mutation is journaled but not globally atomic. Revalidate main HEAD, the index, affected
paths and their parents against the manifest immediately before writing. Materialize each
regular-file replacement through a sibling temporary file, `fsync` and rename; journal
deletions, renames, symlinks and submodules with the same before/after identities. Leave the
index unchanged so resulting edits are unstaged. After every affected path matches `R`,
record the integration tip as applied and finish the operation. The private object overlay
is removed after the durable completion record; a crash retains it with the manifest until
recovery.

A user edit can still race a multi-file apply. Startup classifies every affected path:

- all `before`: no main mutation completed; the operation may be abandoned or retried;
- all `after`: verify tree and index fingerprints, then complete the durable record;
- a mixture of exact `before` and `after`: stop with a resumable forward-completion manifest;
- any `neither`: stop because the user or another process changed the path.

Chatroom never automatically rolls main backward. A normal preflight conflict changes
nothing; a process crash may leave individually atomic path updates partially completed,
which is why the recovery manifest is required.

> **Comment.** A clean-main requirement blocks the intended workflow. The synthetic commit
> lets Git reason about the real dirty tree while the intersection rule guarantees Chatroom
> does not overwrite a user-modified affected path. It also removes V3's double-application
> case: if main change `U` was merged into integration beside agent change `A`, `S` already
> contains `U`, so the candidate delta contains only `A`.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees and retired IPC from the external
runtime root, while keeping conversations, durable authority and refs. `chatroom reset`
removes the repository-local authority, that project's external runtime root and owned refs
only after all agents stop, every dirty worktree is snapshotted or explicitly discarded,
each ref matches its ownership token, and Git confirms no non-Chatroom worktree depends on
it. Destructive commands show both exact roots and every ref and require confirmation.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees. Sessions start lazily. |
| `chatroom list` | Conversations, agents, workspace state, integration tip and apply status. |
| `chatroom continue <name-or-id>` | Recreate archived worktrees if needed, verify, open. |
| `chatroom archive <name-or-id>` | Stop turns, snapshot, remove worktrees, keep history and refs. |
| `chatroom delete <name-or-id>` | Remove worktrees, owned refs, IPC, logs and rows after confirmation; report vendor sessions it could not remove. |

Switching stops or waits for active turns, snapshots both worktrees, and disconnects
drivers. A conversation holds exactly one session per harness; ids change only through
§13.4. Sessions are isolated from the user's own because they live in conversation
worktrees and are resumed only by explicit id.

---

## 18. REPL and commands

Line-oriented. Concurrent output redraws the input line without losing text.

```text
#42 codex → @claude                                       21:07  post
  @claude Parser interface is ready; can you take the CLI?
    · claude: Edit src/cli.ts
    · codex ~ checking how the CLI parses arguments before…

!p3 codex requests network access to registry.npmjs.org
claude: working · codex: waiting p3 · budget 1/6 · integration pending 7b88c12 · parser
> _
```

Plain input is a user message. Multi-line input is fenced with a line containing only
`"""`. Human-reviewed permission requests get short ids so the user can keep typing and
answer asynchronously with `/allow p3 once`. Auto-review decisions appear as activity with
their reviewer and available rationale but do not create a pending `/allow` id.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit; releases held deliveries in order. |
| `/status` | Agents, sessions, capabilities, turns, held deliveries, effective approval reviewer, permissions, reviews, filesystem exposure, workspaces, integration/apply state and detected customization sources. |
| `/stop <agent\|all>` | Protocol interrupt, then bounded termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a permission request. |
| `/new`, `/switch`, `/conversations`, `/rename`, `/archive` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2 |
| `/integrate <agent>` | §16.3 |
| `/sync <agent\|all>` | §16.4 |
| `/import <source> <destination>` | §16.4 |
| `/review <agent\|integration>` | Snapshot if needed and run detached Codex source review for the exact oid (§11.3). |
| `/apply [agent]` | §16.5 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and sandbox diagnostics. |
| `/quit` | Stop turns, flush, release the lock. |

External commands: `chatroom log [--jsonl] [--verify]`, `doctor`, `gc`, `clean`, `reset`, and the
agent-only `post`, `reply`, `ask`, `inbox`, `hook`, which refuse to run unless every
required `CHATROOM_*` variable and the protocol version are present.

---

## 19. Configuration

Global and project configuration use TOML; project overrides global; managed vendor policy
can only narrow.

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Agent-authored cross-agent activations after user input. |
| `turn.timeout_minutes` | `30` | Hard turn timeout. |
| `turn.stop_grace_seconds` | `5` | Grace between interrupt, SIGTERM and SIGKILL. |
| `ask.timeout_seconds` | `60` | Agent-side answer wait. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.long_lived` | `true` | One process per session rather than per turn. |
| `driver.codex.prefer_app_server` | `true` | App-server before `exec` fallback. |
| `driver.codex.approval_policy` | `on-request` | Interactive or granular policy; `never` disables both human and Auto-review requests. |
| `driver.codex.approvals_reviewer` | `inherit` | `inherit`, `user`, or `auto_review`; effective value appears in `/status`. |
| `security.mode` | `strict` | `strict` or `compatible`. |
| `security.shell_network` | `false` | Network from sandboxed shell commands. |
| `security.network_domains` | empty | Exact domains allowed when shell network and the domain proxy are enabled. |
| `security.extra_read_roots` | empty | Canonical paths intentionally exposed to both agents in strict mode. |
| `security.secret_paths` | platform defaults | Additional denied paths; overlap with a required readable project view fails strict startup unless a narrower denial is probed. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; see §15.2. |
| `review.require_before_apply` | `false` | Require a completed Codex review of the exact integration tip. |
| `logging.raw_events` | `false` | Persist vendor raw streams. |
| `logging.retention_days` | `30` | Raw log and retired receipt retention. |
| `logging.max_mib` | `256` | Per-project raw-log cap. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |
| `workspace.archive_inactive` | `false` | Remove worktrees after snapshot on switch or archive. |
| `workspace.state_dir` | platform default | Parent for external per-project runtime roots; resolved before project environment loading. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn.

---

## 20. Activity, logs, and privacy

Normalized activity is ephemeral UI data unless `logging.raw_events` is on. Durable room
messages and lifecycle events stay in SQLite and the JSONL mirror.

| Kind | Claude source | Codex source |
|---|---|---|
| `text` | `assistant` text blocks | `agent_message` items except the final one |
| `reasoning_summary` | `thinking` blocks, if present in the stream | `reasoning` items |
| `tool` | `tool_use` blocks | `command_execution`, `file_change`, `mcp_tool_call`, `web_search` |
| `tool_result` | `tool_result` blocks, bounded | `aggregated_output`, `exit_code`, bounded |
| `permission` | control requests | app-server approval requests |
| `review` | unavailable | `enteredReviewMode`, `exitedReviewMode` and detached review turn status |

Raw vendor streams can contain source, command output and secrets. They are off by default,
size-capped, and removable with `chatroom gc --raw-logs`. Permission events store a redacted
summary, reviewer and available rationale by default; source reviews store their findings.
Chatroom never records environment-variable values. Strict-mode read denials reduce exposure
but do not sanitize content intentionally read from allowed project files.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Turn interrupted, session suspect; reconcile vendor evidence, IPC and workspace; remain recovering until a dedicated recovery turn completes; rebuild if resume or recovery fails. |
| Crash after message commit, before scheduling | Rows remain queued; startup scheduler handles them. |
| Crash after native input accepted, before acknowledgment | Reconcile against vendor turn history when available; otherwise suspect, resume with the ambiguity recorded. |
| Duplicate filesystem event or post retry | Unique operation id returns the original receipt. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, bounded rejection event, no message. |
| Agent floods the drop directory | Per-turn limits close imports; warn or stop the turn. |
| Steering or hook delivery races turn end | Return to queued; lead the next turn; no second charge. |
| Driver process exits nonzero | Preserve bounded stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild from checkpoint and tail as a new generation. |
| Read, write, permission-profile or sandbox probe fails | Strict mode refuses to start that agent; the other may continue if the user chooses. |
| Requested Auto-review is unavailable | Fall back visibly to the user reviewer unless managed policy requires failure. |
| Source review fails or targets a stale oid | Preserve the review error; never satisfy `review.require_before_apply`. |
| Extra hooks or config widen policy | Strict refuses; compatible warns with the exact source. |
| `ANTHROPIC_API_KEY` present or login probe fails | Claude driver refuses to start and says why. |
| Budget exhausted | Cross-agent trigger held; status shows the count. |
| Integration conflict | Main and integration unchanged; report paths. |
| Sync conflict, main into integration | Stop; nothing else changes; report paths. |
| Sync conflict, integration into agent | Pre-sync snapshot safe; worktree in conflict state. |
| Apply preflight conflict, stale main snapshot, or overlapping dirty path | Main tree unchanged; overlapping paths listed. |
| Crash during apply | Classify every affected path as before, after or neither; complete only when all are after, retry only when all are before, otherwise stop with a forward-recovery manifest. |
| Ref or ownership mismatch | Refuse destructive or integration action; show expected and actual oids. |
| Runtime root ownership or project mapping mismatch | Refuse reuse or cleanup; show the canonical expected and actual paths. |
| Database corruption | Stop; preserve files; integrity diagnostics and documented backup recovery; never rebuild authority from the mirror automatically. |
| JSONL mirror malformed or inconsistent | Rewrite it from SQLite; it never becomes recovery authority. |
| Disk full | Stop accepting messages before acknowledging them; keep committed state; persistent fatal status. |

---

## 22. Verification ledger

### Measured on the development machine, 2026-09-04

- Codex 0.146.0 and 0.153.3, `workspace-write`: writes inside cwd succeed; outside fail;
  under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; environment
  variables reach commands under `codex sandbox`. This establishes the legacy fallback but
  does not satisfy v4 strict mode because its reads are broad.
- `codex exec resume` has `--json` and `-o` but no `--cd` or `--sandbox` (0.153.3).
- `codex app-server` lists `stdio://` as its default transport (0.153.3).
- `codex features list` shows `hooks` stable; `steer` graduated.
- Claude 2.1.261 flags: `--settings` file-or-JSON, `--setting-sources user,project,local`,
  `--permission-prompts host|none`, `--permission-mode auto`, `--include-hook-events`,
  `--session-id`, `--resume`, `--input-format stream-json`.
- `node:sqlite` loads on Node 25.1.0 with an experimental warning.

### Documented

- Claude Code: `--settings` accepts inline JSON; hook output
  `hookSpecificOutput.additionalContext` on `PostToolUse` is appended to the tool result;
  hooks may be supplied in settings; sandbox `denyRead`, `allowRead`, `denyWrite` and
  `allowWrite` paths; Bash-only OS sandbox coverage; deny-first native tool permissions;
  Seatbelt and bubblewrap; session storage per working directory; `--continue` scoped to the
  working directory; streaming input queues extra messages and processes them sequentially.
- Claude Agent SDK: claude.ai login is not permitted for SDK agents; API keys are the
  documented method. The SDK bundles its own Claude Code binary.
- Codex: hook events including `PostToolUse` and `Stop`, `additionalContext` injection with
  a 2500-token default cap, hook trust and the bypass flag's scope; `--json` event types and
  `thread_id` in `thread.started`; fine-grained permission profiles with `read`, `write` and
  `deny` entries, which do not compose with legacy `sandbox_mode`; `approval_policy` and
  `approvals_reviewer = "auto_review"`; `shell_environment_policy`; resume by UUID without
  cwd filtering; app-server `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`, approval requests and detached `review/start`.

### Phase 0: verify before building the scheduler

The spike harness later becomes `doctor --smoke`; the checks themselves are built first:

1. `node:sqlite` and the durability tests pass on the oldest and newest supported Node LTS.
2. The Claude CLI in `-p --input-format stream-json` accepts several sequential turns in one
   process, and `--resume` on a later process continues the same session.
3. A `PostToolUse` hook from inline `--settings` fires in `-p` mode and its
   `additionalContext` reaches the model.
4. The Claude permission control request and response wire shape, including
   deny-with-message.
5. `thinking` blocks in the Claude stream, and whether `--verbose` is needed.
6. Claude's root-level `denyRead` plus exact `allowRead` paths work through Bash; native
   Read/Grep/Glob/Edit/Write are disabled; shell writes work in own/drop/scratch and fail in
   main, peer, integration and `.chatroom`; symlinks cannot cross either boundary.
7. A Claude setting-source combination preserves subscription login while excluding
   executable user/project/local customization; the orchestrator-supplied instruction text
   still reaches the model.
8. The Claude login probe: how to detect subscription authentication from the `system/init`
   event or elsewhere.
9. App Server loads the generated fine-grained profile without a legacy sandbox key; shell,
   file-change and explicit permission requests can access exactly the declared paths and
   cannot turn a hard denial into a prompt.
10. Human and Auto-review approval flows, effective managed-policy precedence, observable
    reviewer decisions and rationales, and fallback when Auto-review is unavailable.
11. Detached `review/start` honors the read-only review profile, reviews the requested
    immutable commit and yields a terminal result tied to the same oid.
12. App-server approval request method names and `turn/steer` acceptance against a finishing
    turn.
13. Codex `exec` fallback loads the generated permission profile and environment on resume;
    its optional hook loads only when Chatroom's is the sole non-managed source.
14. What each harness records after a kill mid-generation; a resume remains `recovering`
    until the isolated recovery turn completes.
15. Effective tool-command timeouts of both harnesses, keeping `ask.timeout_seconds` below
    them with a safety margin.

---

## 23. Verification and testing strategy

- **Model-free core tests** with fake drivers: increasing ids; one delivery per
  `(agent, message)`; one logical message per accepted operation; autonomy use never
  exceeds the limit; retries never charge again; at most one active turn per agent; every
  ended turn has a terminal event; no orchestrator write target under an agent-writable
  root; recovery reaches the same logical state after a crash at any injected boundary.
- **IPC security tests**: regular, partial, duplicate, hard-linked, symlinked, directory,
  FIFO, sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn and
  duplicate-notification cases.
- **Permission matrix**: allowed shell reads/writes and denied native tools in Claude strict
  mode; shell and native file changes under the Codex profile; exact allowed roots;
  home secrets; main, peer, integration and authority writes; symlink targets; human and
  Auto-review attempts to request hard-denied paths; external customization sources.
- **Git matrix**: file kinds, sequential agent snapshots, sequential integrations,
  and integrations, both agents on the same and different files, main advancing before
  `/sync` and before `/apply`, main change `U` folded beside unapplied agent change `A`,
  repeated apply after the user commits, dirty/staged/untracked collisions, conflicts and
  aborts, and a crash before or after every affected path. Main stays byte-identical on every
  failed preflight; a dirty-but-disjoint main applies correctly; recovery classifies every
  path without rollback.
- **Review tests**: exact target oid, detached thread isolation, stale-review invalidation,
  failed review never satisfying an apply gate.
- **Mirror tests**: partial final lines, malformed JSON, missing or duplicate middle records,
  stale tails and deterministic rewrite from SQLite.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 24. Implementation approach

### 24.1 Language

TypeScript on the Phase-0-verified Node LTS range: JSON-RPC and stream-json map
to typed unions, child-process streaming and readline are straightforward, fake drivers are
cheap, one npm-installed command supplies the agent-side subcommands. `node:sqlite` for
storage only if it passes that range. Vendor types stop at the adapter boundary.

### 24.2 Modules

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, review.ts, probes.ts
  security/   profiles.ts, boundaries.ts, customization.ts
  workspace/  repository.ts, snapshot.ts, integration.ts, sync.ts, apply.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, reviews.ts, activity.ts
  test-support/ fake-driver.ts, crash-injector.ts
```

The agent-command entry path initializes quickly and imports neither the REPL, the drivers,
the workspace manager, nor a writable database connection.

---

## 25. Build order

**First usable release: phase 0, phases 1 to 4, and the marked items of phase 5.**

0. **Vendor and runtime spikes.** Build disposable probes for §22 before the scheduler:
   supported Node LTS and SQLite; generated App Server schemas; Claude subscription login,
   long-lived stream-json and hook injection; strict read/write boundaries; human and
   Auto-review approvals; Codex steering, recovery inspection and source review. Exit: every
   first-release driver claim has a recorded fixture and every hard denial has a negative
   test. An unverified claim is removed or the affected mode is declared unsupported.
1. **Durable room core.** Schema, migrations, mirror; target resolution; delivery records and
   deterministic budget; startup reconciliation; fake drivers and scheduler property tests.
   Exit: crash injection cannot lose or duplicate logical messages.
2. **IPC and agent commands.** Split-ownership layout; import, receipts, retry, limits,
   quarantine; `post`, `reply`, `ask`, `inbox`, `hook` against fake agents; security suite.
   Exit: every accepted operation has one durable result and no orchestrator path can be
   redirected by an agent-controlled entry.
3. **Drivers, read-only.** Turn the Phase-0 spikes into adapters: Claude CLI with hook
   delivery; Codex App Server with steering; constrained `exec` fallback; fixtures. Include
   minimal recovery that marks ambiguous turns suspect and rebuilds a lost session from a
   bounded transcript. Exit: both agents chat concurrently, receive a mid-turn message when
   their capability allows it, and restart without silently reclassifying ambiguous input.
4. **Strict sandboxed work.** External runtime roots; generated Codex profile; Claude
   sandbox and native-tool restrictions; negative read/write and ungrantable-denial probes;
   human permission relay, Auto-review, interruption. Exit: each agent edits and tests only
   its own worktree, reads only declared views, and cannot read secrets or write main, peer,
   integration, inbound IPC or database through any tool or approval path.
5. **Git collaboration.** *First release:* snapshots, `/integrate`, manual detached `/review`,
   and journaled `/apply` with the synthetic-main merge, dirty-path rule and crash
   classification. *Later:* `/sync` with main fold-in, `/import`, conflict states, optional
   review gate, and the full Git matrix.
6. **Advanced recovery and polish.** Suspect-session resume with isolated recovery turns;
   checkpoints and lost-session rebuild optimization; archive and delete; retention, `gc`,
   the user-facing `doctor --smoke`; asynchronous rendering and permission history.

> **Comment.** V3 correctly added a release cut but put the probe command and session
> recovery after the first release. V4 separates a disposable Phase-0 harness from the later
> polished doctor command and includes conservative recovery in the driver milestone. Fancy
> resume preserves context; it is not required to preserve correctness.

---

## 26. Open decisions

1. **Claude native file tools.** Keep Read/Grep/Glob/Edit/Write disabled in strict mode until
   a version exposes a probe-verifiable allowlist, or accept the ergonomics cost permanently.
2. **Checkpoint producer.** Claude, Codex, the less busy agent, or a dedicated cheap turn.
3. **Raw activity defaults.** Off, with a temporary on-with-cap during adapter development.
4. **Apply UX.** Whether `/apply` may optionally commit on a user-named branch. Unstaged
   stays the safe default.
5. **Conflict resolution.** A `/resolve <operation>` agent turn versus manual resolution
   and `/sync` retry. Manual is enough for the first release.
6. **Inactive worktree policy.** Automatic snapshot-and-archive after dependency-cache
   behaviour is measured.
7. **Fallback support floor.** Whether environments without App Server and fine-grained
   profiles are compatible-mode-only or rejected entirely.
8. **Delivery record format.** Readable records are chosen (§14.1); revisit if body text is
   ever confused with metadata in practice.
9. **Review gate semantics.** Whether a completed review is enough for a configured gate or
   the user must explicitly acknowledge its findings. The latter is safer.

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
- Codex agent approvals and security: https://learn.chatgpt.com/docs/agent-approvals-security
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex hooks: https://learn.chatgpt.com/docs/hooks

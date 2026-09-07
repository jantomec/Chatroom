# Chatroom Architecture v3

Status: design draft, 2026-09-04. Standalone; supersedes `ARCHITECTURE.md` (v1) and
`ARCHITECTURE_V2.md`. No code exists yet.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0.
Versions are evidence for the smoke tests, not compatibility promises. Section 22 lists what
was measured, what is documented, and what remains to be verified.

How to read this document: blocks marked **Comment** explain why a decision stands, or what
changed from v2 and why. They are not requirements. Items marked **proposed** were not
explicitly decided by the user and can be dropped.

---

## 0. Changes from v2

1. **Claude runs through the Claude Code CLI, not the Agent SDK.** The SDK documentation
   says Anthropic does not allow claude.ai login for agents built on the SDK and directs
   developers to API-key authentication. The CLI uses the user's subscription. Everything
   v2 wanted from the SDK is available from the CLI over its stream-json protocol.
2. **Mid-turn delivery to Claude uses a `PostToolUse` hook again.** The streaming-input
   docs say extra messages are queued until the turn completes, so streaming is not an
   injection channel. A hook returning `additionalContext` is the documented one. The hook
   is supplied inline with `--settings`, so no file is written anywhere.
3. **Main flows back into the conversation.** `/sync` merges main's HEAD into the
   integration branch before merging integration into an agent branch. v2 had no path for
   main to reach the agents, so branches drifted after every `/apply`.
4. **`/apply` tolerates a dirty main tree** as long as no dirty path intersects the patch.
   Requiring a clean tree defeated the point of letting the user keep working in it.
5. **Interrupted sessions are resumed, not abandoned.** Both harnesses persist turns
   incrementally and are resumed after crashes routinely. A session is rebuilt only when
   the harness refuses to resume it or the probe shows it is broken.
6. **One addressing convention.** `@handle` mentions everywhere, for humans and agents.
   `--to` remains as an explicit override. Resolved targets are stored as rows and shown in
   the header regardless of how they were expressed.
7. **The Codex `exec` fallback may use a hook**, gated by a doctor check that no other hook
   source exists, instead of being forbidden outright.
8. **`ask` accepts probable answers.** A message from the asked party that targets the asker
   resolves the wait, marked as probable, in addition to an explicit `reply <id>`.
9. **Storage uses Node's built-in SQLite** and keeps an always-on JSONL mirror of the
   transcript. v2's native-binding concern goes away; the user's original wish for a
   readable file is met.
10. **A first-release cut line** is drawn through the build order. v2's full scope is kept
    as the target, but the document says which parts a usable first version needs.

Kept from v2 without change of substance: SQLite as the transactional authority, delivery
records instead of a cursor, idempotent agent operations with receipts, split-ownership
IPC, capability probing, per-conversation workspaces, snapshot commits, the integration
branch, the autonomy budget charged per message, and the testing strategy.

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
inside it. Chatroom creates local data under `.chatroom/` and Chatroom-owned Git refs and
worktrees. It does not change tracked project files, `CLAUDE.md`, `AGENTS.md`, `.claude/`,
`.codex/`, or `.gitignore`. Plain `claude` and `codex` sessions remain independent, and
Claude keeps running on the user's subscription.

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
    verified by writing, not inferred from a permission mode name.
12. **Adapters are capability-based.** Vendor versions are diagnostics; behaviours are
    probed and recorded.
13. **Zero footprint.** Briefs, hooks, settings and sandbox configuration reach each harness
    through its invocation. `.chatroom/` is hidden from git via `.git/info/exclude`.
14. **Subscription-preserving.** The Claude driver uses the same login and billing as the
    user's own `claude` sessions.

> **Comment.** Principle 14 is new. It rules out the Agent SDK as a primary driver and is
> the single biggest change from v2. Principle 13 was implicit in v2 and is now stated,
> because the hook route depends on it.

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
| Workspace manager | Creates conversation worktrees, snapshots uncommitted changes, merges into and out of the integration branch, applies reviewed deltas. |
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
    ipc/
      claude/
        from-agent/<turn-id>-<nonce>/      exact agent-writable drop root for a turn
        to-agent/deliveries/               orchestrator-owned, agent-readable
        to-agent/receipts/                 orchestrator-owned, agent-readable
        scratch/<turn-id>-<nonce>/         agent-writable temp root; never imported
        staging/                           orchestrator-owned quarantine
      codex/
        (same)
    worktrees/
      <conversation-id>/
        claude/
        codex/
    integration/
      <conversation-id>/                   temporary integration worktree when needed
    recovery/
      <operation-id>/                      patches and manifests for interrupted Git ops
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a
real directory beneath the project root. The directory is mode `0700`; database, logs and
IPC files are `0600`, subject to platform support.

> **Comment.** `transcript/<id>.jsonl` is the one addition to v2's layout. It exists so the
> user can `tail -f` or grep a conversation without the tool. It is regenerable from the
> database and is never read by recovery.

---

## 5. Durable storage

### 5.1 Engine and settings

The store uses `node:sqlite`, which is present in the Node release on the development
machine with an experimental-feature warning. One write connection; read-only diagnostic
commands may open a read-only connection when no migration is pending.

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
to `transcript/<conversation-id>.jsonl` in `entry_id` order. The mirror is rewritten from the
database on startup if its last entry does not match. `chatroom log --jsonl` prints the
same content.

### 5.3 Schema

Logical SQL; exact indexes and check constraints belong in migrations. Unchanged from v2
except where noted.

```sql
projects(id PK, root_path, git_common_dir, created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                        -- active | archived | deleting
  autonomy_limit, autonomy_used,
  latest_checkpoint_entry_id, applied_integration_oid,
  integration_base_oid)          -- v3: main HEAD last merged into integration

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)
                                 -- kind: message | event

messages(entry_id PK FK, author, via, body, turn_id, operation_id,
  reply_to FK, causal_root FK, UNIQUE(author, operation_id))
                                 -- via: repl | post | reply | final | recovery

message_targets(message_id FK, participant, expects_action, PK(message_id, participant))

events(entry_id PK FK, type, agent, turn_id, payload_json)

agent_sessions(conversation_id FK, agent, vendor_session_id, generation,
  status,                        -- absent | healthy | suspect | lost
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

permissions(id PK, turn_id FK, agent, vendor_request_id, status, summary,
  request_json, decision_json, created_at, resolved_at)

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, base_oid,
  head_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))
                                 -- owner: claude | codex | integration

integration_operations(id PK, conversation_id FK, type, status, manifest_json,
  created_at, finished_at)       -- type: snapshot | integrate | sync | apply | remove

checkpoints(id PK, conversation_id FK, through_entry_id, summary,
  workspace_manifest_json, created_at)
```

> **Comment.** `agent_sessions.status` gains `suspect` in place of v2's `tainted`, because
> v3 tries to resume a suspect session instead of discarding it (§13.3). `turn_inputs`
> and `deliveries` gain the `hook` transport for Claude's mid-turn path.

### 5.4 Transaction boundaries

Each of these is one transaction:

- append a message, resolve targets, create delivery rows, reserve autonomy credits;
- create a turn, attach its initial input set, set the agent to `preparing`;
- accept a delivery and mark its messages delivered;
- append an agent's final reply and end its turn;
- import an agent operation and write its logical receipt result;
- record a permission decision;
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
> The user chose `@handle`; v3 makes it the single convention and keeps `--to` as an
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

The turn's random directory nonce is part of the path rather than trusted from a payload.
The parent of the writable directory is not writable by the agent, so the agent cannot
replace the granted root. Identity is assigned from the driver and the fixed drop root,
never from a field in a file.

Measured: Codex's `workspace-write` sandbox blocks writes outside the working directory,
allows them under `sandbox_workspace_write.writable_roots`, allows reads anywhere, and
denies Unix-socket connections. Files are therefore the only viable channel from inside a
Codex tool shell.

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

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`, for an answer. An answer
is a message whose `reply_to` is the question id, or, marked `probable`, a message from a
targeted party that targets the asker and was committed after the question. Other incoming
messages are printed while waiting but never mistaken for the answer. On timeout the
command returns an indeterminate result and tells the agent to continue; the question stays
durable. The timeout stays under both harnesses' default tool-command timeouts.

> **Comment.** v2 resolved `ask` only on an explicit `reply <id>`. Models often answer with
> a plain post; v3 accepts that as a probable answer rather than timing out with the answer
> already on screen.

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
or hook delivery during a harmless turn; permission request and response flow; effective
working directory; write success in the worktree, drop root and scratch; write failure in
the main tree, peer worktree, inbound IPC, database and a random outside path, through
both shell commands and the harness's own file tools; effective network and Unix-socket
policy; loaded instruction, settings, hook, plugin and MCP sources where the vendor reports
them; and, for Claude, that the session is authenticated with the user's login rather than
an API key.

Only probe results enable a capability. Results are cached with executable hash, version,
platform, config fingerprint and expiry.

> **Comment.** The two probes added over v2 are "file tools, not just shell" and the
> authentication check. Claude's sandbox covers Bash commands only (§15.2), so a write probe
> through the Edit tool tests a different mechanism than one through Bash. The
> authentication probe exists because principle 14 is easy to violate silently, for example
> by an `ANTHROPIC_API_KEY` in the environment.

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
  [--setting-sources <per §15.4>] [--model <model>]
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
- approval requests to the REPL, as for Claude.

Authentication is the user's existing Codex login in `~/.codex/auth.json`, which the CLI,
app-server and desktop app share.

`nativeSteering`, `interrupt` and `hostApprovals` are true if the probes pass;
`hookDelivery` is false and unnecessary on this path.

### 11.2 Fallback: `codex exec`

If app-server probing fails:

```text
codex exec --json --sandbox workspace-write -o <file> \
  -c 'sandbox_workspace_write.writable_roots=[…]' -c 'shell_environment_policy.set={…}' \
  [-c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust] -         (prompt on stdin)
codex exec resume <thread-id> --json -o <file> -c 'sandbox_mode="workspace-write"' … -
```

`exec resume` has no `--cd` or `--sandbox`; the working directory comes from spawning in
the worktree and the sandbox from `-c`. There are no approvals on this path. Hook delivery
is enabled only when `doctor` finds no hook source other than Chatroom's, because the trust
bypass runs every enabled hook from every configuration layer. If any other source exists,
the fallback runs without mid-turn delivery and says so in `/status`.

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
  stay live. A decision is durable before the driver receives it.
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
3. Attempt a resume by explicit id. If the harness resumes, send a recovery note as the next
   turn's first input: the interrupted turn, the accepted message ids, and the current
   workspace diff, with the instruction to inspect side effects before repeating anything.
   Mark the session `healthy`.
4. Only if the harness refuses, or the resumed session reports the wrong id or directory,
   mark it `lost` and rebuild from checkpoint and tail as a new generation (§13.4).

> **Comment.** v2 never resumed a tainted session. That discards the agent's working memory
> on every orchestrator crash, while both harnesses write their session logs incrementally
> and are resumed after kills as a matter of routine. v3 resumes and tells the agent what
> happened. The rebuild path is unchanged, just demoted to second choice.

### 13.4 Lost session rebuild

Mark the old generation `lost`, create a new one, build a bounded prompt from brief,
latest checkpoint, later messages, referenced earlier messages and workspace state, start a
fresh session, store the new id after acknowledgment, append `session_rebuilt`. If the
checkpoint plus required tail exceeds the driver's budget, stop and ask the user to archive
or split the conversation.

### 13.5 Startup reconciliation

Before scheduling: mark turns left `preparing` or `running` as interrupted; reconcile staged
IPC operations by id; recreate missing delivery or receipt files from rows; quarantine files
that belong to no active or recoverable turn; reconcile every `planned` or `executing` Git
operation via its manifest; verify worktree paths, refs, oids, ownership tokens and main
tree status; rebuild the JSONL mirror if stale; reconnect sessions only after workspace
reconciliation succeeds. Ambiguous main-tree changes cause a hard stop with a precise
recovery command.

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

> **Comment.** v2 rendered records as JSON lines to keep body text from being confused with
> metadata. v3 goes back to readable records because bodies often contain code, JSON
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
- Read {peer_worktree}, {integration_view} and {main_tree} when useful; never write there.
  The peer worktree may be mid-edit; the chat is where intent is stated.
- Do not merge, rebase, reset or edit Chatroom-owned refs. The user runs integration.
- You may commit, but you do not need to. Chatroom snapshots all non-ignored changes.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`brief.extra` from configuration is appended with a visible label, size-capped, never
interpolated into shell code.

---

## 15. Sandboxing, permissions, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, malformed IPC files, duplicate operations, and common path and symlink attacks.
It does not protect secrets that agents are allowed to read from disclosure through model
APIs or enabled network tools. The repository is assumed trusted enough to run its normal
build and test tooling.

### 15.2 Claude

Claude Code's sandbox covers Bash commands, using Seatbelt on macOS and bubblewrap on
Linux. The built-in Read, Edit and Write tools are governed by permission rules instead.
Chatroom therefore pins two things through the inline `--settings` JSON:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {"allowWrite": ["<drop root>", "<scratch root>"]},
    "network": {"allowUnixSockets": []}
  },
  "permissions": {
    "deny": ["Edit(<main tree>/**)", "Write(<main tree>/**)",
             "Edit(<peer worktree>/**)", "Write(<peer worktree>/**)",
             "Edit(<.chatroom>/**)", "Write(<.chatroom>/**)"]
  }
}
```

The sandbox keys are documented; the exact path syntax of `Edit`/`Write` deny rules for
absolute paths is to be verified by the probe, which writes through both Bash and Edit.
Network policy is chosen by configuration. `autoAllowBashIfSandboxed` is **proposed**: it
lets sandboxed commands run without prompts, which is the point of running `auto` mode
unattended; the user can turn it off.

> **Comment.** v2 said "Claude runs with its native sandbox enabled" and treated that as the
> write boundary. It is, for Bash. For Edit and Write the boundary is a permission rule, so
> the probe and the settings both have to cover that path explicitly.

### 15.3 Codex

Per thread or turn, Chatroom supplies: `sandbox_mode = "workspace-write"`;
`sandbox_workspace_write.writable_roots` limited to the drop and scratch roots;
`exclude_slash_tmp = true` and `exclude_tmpdir_env_var = true` with `TMPDIR` set to the
scratch root; `network_access = false` unless configured; `shell_environment_policy.set`
carrying the §8.1 variables. No approvals-and-sandbox bypass.

Measured on 0.153.3: `writable_roots` opens exactly the listed directory; `/tmp` is
writable by default and `exclude_slash_tmp` closes it; reads succeed anywhere; Unix-socket
connections are denied.

### 15.4 Customization modes

| Mode | Behaviour |
|---|---|
| `strict` (default) | Load project instruction files, but exclude configuration layers that can widen the boundary. Claude: `--setting-sources user` so project and local settings, including their hooks, are not loaded; the effect on CLAUDE.md loading is to be verified. Codex: refuse to start if `<repo>/.codex/hooks.json` or other non-Chatroom hook sources are detected on the `exec` fallback; on app-server, report detected sources. Refuse startup if the boundary cannot be verified. |
| `compatible` | Load normal vendor customization. Show every detected source in `/status`; warn when one widens hooks, commands, network or writable paths. |

Managed organization policy always remains in force.

### 15.5 Identity

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
`.chatroom/worktrees/<conversation-id>/`, which preserves vendor session identity. The
integration ref normally has no worktree; a temporary one is created for merges.

Inactive conversations may be archived: snapshot, `git worktree remove`, keep refs,
transcript, sessions and path metadata. Continuing recreates the worktrees at the same
paths before sessions resume.

> **Comment.** v1 proposed one worktree pair shared by all conversations. v2's argument for
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

> **Comment.** Step 1 is new. In v2 nothing ever merged main into integration, so after the
> user committed applied work on main, agent branches drifted further with every apply and
> long conversations ended in conflicts. Now "main advanced" is folded in at the same place
> agents already receive each other's work.

### 16.5 `/apply [agent]`

`/apply` applies the unapplied integration delta to the main worktree; `/apply <agent>` is
integrate then apply. Preconditions: no prior apply needs recovery; the integration branch
has unapplied commits; no dirty path in the main tree intersects a path in the delta; no
involved path resolves through a symlink outside the repository.

Procedure: record an intent with main HEAD, old and new integration oids, patch hash and
pre-operation status; generate the binary delta from the last applied integration oid to
the new tip; apply and merge-test it in a temporary worktree based on main HEAD; if the
preflight succeeds, apply atomically to the main worktree; leave files unstaged for review;
record the applied oid and status fingerprint.

Abort before writing if main HEAD changed after preflight. A conflict changes nothing. A
crash after applying and before recording is reconciled at startup by comparing the stored
patch and fingerprint; on exact match the record is completed, otherwise Chatroom stops
with the recovery manifest and never resets user files.

> **Comment.** v2 required a clean main tree. The user works in the main tree while agents
> work in theirs, so that precondition would block `/apply` exactly when it is wanted. The
> disjoint-paths rule keeps the safety property that matters: Chatroom never overwrites a
> file the user has uncommitted changes in.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees, keeps conversations and refs.
`chatroom reset` removes all Chatroom data and owned refs only after all agents stop, every
dirty worktree is snapshotted or explicitly discarded, each ref matches its ownership token,
and Git confirms no non-Chatroom worktree depends on it. Destructive commands show exact
paths and refs and require confirmation.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees. Sessions start lazily. |
| `chatroom list` | Conversations, agents, workspace state, unapplied integration count. |
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
claude: working · codex: waiting p3 · budget 1/6 · integration +2 · parser
> _
```

Plain input is a user message. Multi-line input is fenced with a line containing only
`"""`. Permission requests get short ids so the user can keep typing and answer
asynchronously with `/allow p3 once`.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit; releases held deliveries in order. |
| `/status` | Agents, sessions, capabilities, turns, held deliveries, permissions, workspaces, integration and apply state, detected customization sources. |
| `/stop <agent\|all>` | Protocol interrupt, then bounded termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a permission request. |
| `/new`, `/switch`, `/conversations`, `/rename`, `/archive` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2 |
| `/integrate <agent>` | §16.3 |
| `/sync <agent\|all>` | §16.4 |
| `/import <source> <destination>` | §16.4 |
| `/apply [agent]` | §16.5 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and sandbox diagnostics. |
| `/quit` | Stop turns, flush, release the lock. |

External commands: `chatroom log [--jsonl]`, `doctor`, `gc`, `clean`, `reset`, and the
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
| `security.mode` | `strict` | `strict` or `compatible`. |
| `security.shell_network` | `false` | Network from sandboxed shell commands. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; see §15.2. |
| `logging.raw_events` | `false` | Persist vendor raw streams. |
| `logging.retention_days` | `30` | Raw log and retired receipt retention. |
| `logging.max_mib` | `256` | Per-project raw-log cap. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |
| `workspace.archive_inactive` | `false` | Remove worktrees after snapshot on switch or archive. |

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

Raw vendor streams can contain source, command output and secrets. They are off by default,
size-capped, and removable with `chatroom gc --raw-logs`. Permission events store a redacted
summary by default. Chatroom never records environment-variable values.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Turn interrupted, session suspect; reconcile IPC and workspace; resume with recovery note, rebuild only if resume is refused. |
| Crash after message commit, before scheduling | Rows remain queued; startup scheduler handles them. |
| Crash after native input accepted, before acknowledgment | Reconcile against vendor turn history when available; otherwise suspect, resume with the ambiguity recorded. |
| Duplicate filesystem event or post retry | Unique operation id returns the original receipt. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, bounded rejection event, no message. |
| Agent floods the drop directory | Per-turn limits close imports; warn or stop the turn. |
| Steering or hook delivery races turn end | Return to queued; lead the next turn; no second charge. |
| Driver process exits nonzero | Preserve bounded stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild from checkpoint and tail as a new generation. |
| Sandbox probe fails | Strict mode refuses to start that agent; the other may continue if the user chooses. |
| Extra hooks or config widen policy | Strict refuses; compatible warns with the exact source. |
| `ANTHROPIC_API_KEY` present or login probe fails | Claude driver refuses to start and says why. |
| Budget exhausted | Cross-agent trigger held; status shows the count. |
| Integration conflict | Main and integration unchanged; report paths. |
| Sync conflict, main into integration | Stop; nothing else changes; report paths. |
| Sync conflict, integration into agent | Pre-sync snapshot safe; worktree in conflict state. |
| Apply conflict, stale main HEAD, or overlapping dirty path | Main tree unchanged; overlapping paths listed. |
| Crash during apply | Compare intent fingerprints; complete the record only on exact match, else stop for recovery. |
| Ref or ownership mismatch | Refuse destructive or integration action; show expected and actual oids. |
| Database corruption | Stop; preserve files; integrity diagnostics and documented backup recovery; never rebuild authority from the mirror automatically. |
| Disk full | Stop accepting messages before acknowledging them; keep committed state; persistent fatal status. |

---

## 22. Verification ledger

### Measured on the development machine, 2026-09-04

- Codex 0.146.0 and 0.153.3, `workspace-write`: writes inside cwd succeed; outside fail;
  under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; environment
  variables reach commands under `codex sandbox`.
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
  hooks may be supplied in settings; sandbox keys as in §15.2, Bash-only coverage, Seatbelt
  and bubblewrap; session storage per working directory; `--continue` scoped to the
  working directory; streaming input queues extra messages and processes them sequentially.
- Claude Agent SDK: claude.ai login is not permitted for SDK agents; API keys are the
  documented method. The SDK bundles its own Claude Code binary.
- Codex: hook events including `PostToolUse` and `Stop`, `additionalContext` injection with
  a 2500-token default cap, hook trust and the bypass flag's scope; `--json` event types and
  `thread_id` in `thread.started`; config keys `sandbox_mode`,
  `sandbox_workspace_write.writable_roots`, `exclude_slash_tmp`, `exclude_tmpdir_env_var`,
  `network_access`, `shell_environment_policy.set` and `inherit` defaulting to `all`;
  resume by UUID without cwd filtering; app-server `thread/start`, `thread/resume`,
  `turn/start`, `turn/steer`, `turn/interrupt` and approval requests.

### To verify in `doctor --smoke` before building the scheduler

1. The CLI in `-p --input-format stream-json` accepts several sequential turns in one
   process, and `--resume` on a later process continues the same session.
2. A `PostToolUse` hook from inline `--settings` fires in `-p` mode and its
   `additionalContext` reaches the model.
3. The wire shape of the permission control request and response, including
   deny-with-message.
4. `thinking` blocks in the Claude stream, and whether `--verbose` is needed.
5. `Edit`/`Write` deny-rule syntax for absolute paths, and that a denied Edit is reported
   to the model rather than silently dropped.
6. `--setting-sources user` still loads the project's CLAUDE.md.
7. The Claude login probe: how to detect subscription authentication from the `system/init`
   event or elsewhere.
8. App-server: thread configuration fields for cwd, sandbox and writable roots; approval
   request method names; `turn/steer` acceptance semantics against a finishing turn.
9. Codex `exec` fallback: `-c hooks.PostToolUse` loads with the bypass flag;
   `shell_environment_policy.set` delivers variables; `writable_roots` via `-c` on resume.
10. What each harness's session contains after a kill mid-generation, and that resume then
    works with the recovery note.
11. Default tool-command timeouts of both harnesses, to keep `ask.timeout_seconds` below.

---

## 23. Verification and testing strategy

Unchanged from v2 in substance.

- **Model-free core tests** with fake drivers: increasing ids; one delivery per
  `(agent, message)`; one logical message per accepted operation; autonomy use never
  exceeds the limit; retries never charge again; at most one active turn per agent; every
  ended turn has a terminal event; no orchestrator write target under an agent-writable
  root; recovery reaches the same logical state after a crash at any injected boundary.
- **IPC security tests**: regular, partial, duplicate, hard-linked, symlinked, directory,
  FIFO, sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn and
  duplicate-notification cases.
- **Git matrix**: file kinds, agent commits plus uncommitted changes, sequential snapshots
  and integrations, both agents on the same and different files, main advancing before
  `/sync` and before `/apply`, repeated apply after the user commits, conflicts and aborts,
  crash at every boundary, pre-existing similar refs. Main stays byte-identical on every
  failed preflight, and a dirty-but-disjoint main is applied to correctly.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 24. Implementation approach

### 24.1 Language

TypeScript on a supported Node LTS, for the reasons v2 gave: JSON-RPC and stream-json map
to typed unions, child-process streaming and readline are straightforward, fake drivers are
cheap, one npm-installed command supplies the agent-side subcommands. `node:sqlite` for
storage. Vendor types stop at the adapter boundary.

### 24.2 Modules

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, probes.ts
  workspace/  repository.ts, snapshot.ts, integration.ts, sync.ts, apply.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, activity.ts
  test-support/ fake-driver.ts, crash-injector.ts
```

The agent-command entry path initializes quickly and imports neither the REPL, the drivers,
the workspace manager, nor a writable database connection.

---

## 25. Build order

**First usable release: phases 1 to 4 plus the marked items of phase 5.**

1. **Durable room core.** Schema, migrations, mirror; target resolution; delivery records and
   deterministic budget; fake drivers and scheduler property tests. Exit: crash injection
   cannot lose or duplicate logical messages.
2. **IPC and agent commands.** Split-ownership layout; import, receipts, retry, limits,
   quarantine; `post`, `reply`, `ask`, `inbox`, `hook` against fake agents; security suite.
   Exit: every accepted operation has one durable result and no orchestrator path can be
   redirected by an agent-controlled entry.
3. **Drivers, read-only.** Probes including the login check; Claude CLI long-lived process
   with hook delivery; Codex app-server with steering; `exec` fallback; fixtures. Exit: both
   agents chat concurrently in a temporary repository, and a message reaches a working
   agent mid-turn on both sides.
4. **Sandboxed work.** Conversation worktrees; pinned sandbox and deny rules; negative write
   probes through shell and file tools; permission relay; interruption. Exit: each agent
   edits and tests its own worktree and cannot write the main tree, peer tree, inbound IPC
   or database.
5. **Git collaboration.** *First release:* snapshots, `/integrate`, `/apply` with the
   disjoint-dirty rule, crash reconciliation of apply. *Later:* `/sync` with main fold-in,
   `/import`, conflict states, the full Git matrix.
6. **Recovery and polish.** Suspect-session resume and lost-session rebuild; checkpoints;
   archive and delete; retention, `gc`, `doctor --smoke`; asynchronous permissions and
   rendering.

> **Comment.** v2's phases are kept; the cut line is new. Without it the design's scope,
> several times v1's, risks never producing a room the user can sit in. Phases 1 to 4 give
> a working, sandboxed, mid-turn-capable chat; snapshot-and-apply gives a way to take work
> out. Everything below the line improves robustness of a thing that already works.

---

## 26. Open decisions

1. **Strict mode on Claude.** Whether `--setting-sources user` keeps CLAUDE.md and
   `.mcp.json` behaviour the user expects. If not, decide between loading project settings
   with a warning and failing strict mode.
2. **Checkpoint producer.** Claude, Codex, the less busy agent, or a dedicated cheap turn.
3. **Raw activity defaults.** Off, with a temporary on-with-cap during adapter development.
4. **Apply UX.** Whether `/apply` may optionally commit on a user-named branch. Unstaged
   stays the safe default.
5. **Conflict resolution.** A `/resolve <operation>` agent turn versus manual resolution
   and `/sync` retry. Manual is enough for the first release.
6. **Inactive worktree policy.** Automatic snapshot-and-archive after dependency-cache
   behaviour is measured.
7. **Fallback support floor.** Whether environments without a working app-server are
   supported with reduced capability or rejected.
8. **Delivery record format.** Readable records are chosen (§14.1); revisit if body text is
   ever confused with metadata in practice.

---

## 27. References

Explanatory, not substitutes for probes.

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Agent SDK streaming input (queue semantics; SDK not used):
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Agent SDK overview (authentication statement):
  https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex hooks: https://learn.chatgpt.com/docs/hooks

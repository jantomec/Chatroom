# Chatroom Architecture v2

Status: alternative design draft, 2026-09-04. This document is standalone and does not
replace `ARCHITECTURE.md`. It keeps the original product idea while changing persistence,
delivery, driver integration, sandboxing, and Git integration where the first design had
ambiguous crash or security behaviour.

Observed while drafting: Claude Code 2.1.261 and Codex CLI 0.153.3. These versions are
evidence for the smoke tests, not hard-coded compatibility promises. Chatroom detects
capabilities at runtime and fails closed when a required safety capability is unavailable.

---

## 1. Purpose

Chatroom is a terminal group chat with three participants:

- the user;
- Claude, through Claude Code or the Claude Agent SDK;
- Codex, through the Codex App Server or Codex CLI.

All participants eventually see every message. Addressing says who is expected to act; it
does not make a message secret. Claude and Codex may work concurrently, coordinate while
working, and inspect one another's work. Each agent writes only to its own Git worktree.

`chatroom` is one globally installed command. A repository opts in when the command is run
inside it. Chatroom creates local data under `.chatroom/` and local Git refs and worktrees.
It does not change tracked project files, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`,
or `.gitignore`. Plain `claude` and `codex` sessions remain independent.

### 1.1 Non-goals for the first v2 implementation

- More than Claude and Codex as agents.
- A graphical or full-screen interface.
- Remote or multi-user chatrooms.
- Exactly-once execution of model tool calls. Delivery is durable and idempotent, but a
  process can crash after a side effect and before reporting it.
- Isolation from a deliberately hostile operating-system user. The agents and Chatroom run
  under the same local account.
- Transparent merging into a dirty main worktree. Applying integrated work requires the
  user's main worktree to be clean.
- Native Windows. The supported targets are macOS, Linux, and WSL2; native Windows can be
  added after its process, lock, and sandbox semantics have dedicated tests.

---

## 2. What changes from the first design

1. **SQLite is authoritative.** Messages, events, turns, deliveries, budgets, sessions,
   permissions, and integration operations are committed transactionally. JSONL is an
   export, not the primary database.
2. **Deliveries are records, not a scalar cursor.** Every agent/message pair has an explicit
   state. There is no cursor rollback.
3. **Every agent-side operation has an idempotency key and receipt.** `post` can truthfully
   report the assigned message id, and retries cannot duplicate messages.
4. **IPC is split by ownership.** The orchestrator never writes below an agent-writable
   directory. Agents acknowledge incoming files rather than moving them.
5. **Native interactive protocols are preferred.** Codex App Server steering and Claude
   Agent SDK streaming input carry mid-turn messages. Hooks are not required for baseline
   correctness.
6. **Both agents run with OS-enforced write boundaries.** Permission prompts decide whether
   an operation is allowed; the sandbox decides where it can write if allowed.
7. **Conversations own workspaces.** Each conversation has its own agent branches and stable
   worktree paths, so an old session never silently resumes in another conversation's tree.
8. **An integration branch sits between agents and the main tree.** Chatroom snapshots agent
   work without requiring commits, merges snapshots into the integration branch, and only
   mutates the main tree on explicit `/apply`.
9. **The hop counter becomes an autonomy budget.** Charging is tied to accepted messages,
   not filesystem timing or batching.
10. **Recovery is bounded.** A transcript remains the audit truth, while session rebuilding
    uses durable checkpoints plus a tail that fits the target model's context.

---

## 3. Architectural principles and invariants

These are implementation requirements.

1. **One durable authority.** If SQLite and a derived file disagree, SQLite wins unless a
   documented external-operation recovery procedure says otherwise.
2. **One database writer.** Only the orchestrator connection mutates the database. Agent-side
   subcommands never open it for writing.
3. **Monotonic room order.** Every message and event receives one increasing `entry_id` in
   the same transaction that creates it. Display order is `entry_id`, never wall-clock time.
4. **At-least-once delivery, idempotent acceptance.** A transport may retry. A logical
   delivery or agent operation is accepted once.
5. **No state rollback.** Recovery moves state forward from durable facts. It never lowers a
   global cursor and hopes newer work can be replayed safely.
6. **No orchestrator writes under agent control.** Agent-writable paths are drop boxes and
   scratch space only. Receipts and deliveries live under orchestrator-owned paths.
7. **A message is durable before it is visible.** The UI and scheduler only observe committed
   entries.
8. **A budget decision is deterministic.** It depends on committed message order and target,
   not watcher timing, batching, or whether an agent happened to be busy.
9. **A conversation maps to stable session and workspace identities.** Session resume never
   guesses by recency or current directory.
10. **Main-tree mutation is explicit and recoverable.** Agent work reaches a conversation
    integration branch first. `/apply` is the only normal operation that edits the user's
    main worktree.
11. **Safety settings are pinned.** A driver's effective filesystem and network boundary is
    verified, not inferred from a permission mode name.
12. **Adapters are capability-based.** Vendor versions are diagnostic data; required
    behaviours are probed and recorded.

---

## 4. System overview

```text
 ┌────────────────────────────── chatroom process ──────────────────────────────┐
 │                                                                               │
 │  REPL                                                                         │
 │    transcript · activity · permissions · status · slash commands              │
 │                         │                                      ▲                │
 │                         ▼                                      │                │
 │  Orchestrator                                                                  │
 │    room order · scheduler · autonomy budget · recovery · integration           │
 │        │                 │                   │                                 │
 │        ▼                 ▼                   ▼                                 │
 │  SQLite writer       IPC dispatcher       Git workspace manager               │
 │  (WAL)               (files + receipts)   (snapshot/integrate/apply)           │
 │        ▲                 ▲                   ▲                                 │
 │        │                 │                   │                                 │
 │  ┌─────┴────────────┐    │          ┌────────┴────────┐                        │
 │  │ Claude driver    │    │          │ Codex driver    │                        │
 │  │ Agent SDK stream │    │          │ App Server RPC  │                        │
 │  └─────┬────────────┘    │          └────────┬────────┘                        │
 └────────┼─────────────────┼───────────────────┼─────────────────────────────────┘
          │ native input    │ agent-side files │ native steer
          ▼                 ▼                  ▼
   Claude worktree     from-agent/to-agent   Codex worktree
```

The drivers may use different vendor transports. They expose the same logical operations to
the orchestrator. Native mid-turn injection is an optional capability; turn-boundary
delivery is always available.

### 4.1 Components

| Component | Responsibility |
|---|---|
| REPL | User input, transcript rendering, activity streams, permission decisions, commands. |
| Orchestrator | The single state machine and database writer. Resolves targets, schedules work, reserves autonomy credits, and coordinates recovery. |
| Store | SQLite schema, migrations, transactions, queries, checkpoints, and JSONL export. |
| IPC dispatcher | Imports agent operations, writes receipts, enforces idempotency and limits, and cleans retired turn directories. |
| Driver | Starts or resumes one vendor session, sends turns or steering input, normalizes events, handles permissions, and stops work. |
| Workspace manager | Creates conversation worktrees, snapshots uncommitted changes, merges agent branches into the integration branch, and applies reviewed integration deltas. |
| Agent-side command | A fast subcommand of the same executable: `post`, `reply`, `ask`, or `inbox`. It only uses paths and capabilities supplied in its environment. |

---

## 5. Project identity, locking, and disk layout

### 5.1 Project identity

Chatroom resolves:

```sh
git rev-parse --show-toplevel
git rev-parse --path-format=absolute --git-common-dir
```

The canonical absolute common Git directory is hashed into a `project_id`. This prevents a
symlinked path or linked worktree from accidentally creating a second orchestrator for the
same repository. Chatroom refuses to start recursively from one of its own managed
worktrees.

The project lock is an advisory operating-system lock held on an open file descriptor, not
only a PID written to a file. PID and start time are diagnostic fields. A second process
fails immediately with the owning process information.

### 5.2 Global files

```text
<install>/chatroom                         executable or launcher
~/.config/chatroom/config.toml             optional defaults
```

The orchestrator resolves its own real executable path on startup and passes that absolute
path to agents as `CHATROOM_BIN`. Hook or shell integration never relies on an unqualified
`chatroom` found through project-controlled `PATH` entries.

### 5.3 Per-project files

```text
<project>/
  .chatroom/
    lock
    config.toml
    chatroom.sqlite3
    chatroom.sqlite3-wal
    chatroom.sqlite3-shm
    logs/
      <conversation-id>/
        <turn-id>.<agent>.jsonl
        <turn-id>.<agent>.stderr
    ipc/
      claude/
        from-agent/
          <turn-id>-<nonce>/               exact agent-writable root for a turn
        to-agent/
          deliveries/                      orchestrator-owned, agent-readable
          receipts/                        orchestrator-owned, agent-readable
        scratch/
          <turn-id>-<nonce>/               agent-writable temp root; never imported
        staging/                            orchestrator-owned quarantine
      codex/
        from-agent/
        to-agent/
        scratch/
        staging/
    worktrees/
      <conversation-id>/
        claude/
        codex/
    integration/
      <conversation-id>/                   temporary integration worktree when needed
    recovery/
      <operation-id>/                      patches and manifests for interrupted Git ops
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a real
directory beneath the project root, not a symlink. The directory is mode `0700`; database,
logs, messages, and receipts are mode `0600`, subject to platform support.

Worktree administrative records and Chatroom-owned refs also exist in the Git common
directory. Their exact names and ownership tokens are recorded in SQLite. Teardown deletes
only refs whose recorded current value and ownership both match.

---

## 6. Durable storage

### 6.1 SQLite settings

On open, the store enables:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Only the orchestrator holds a write connection. Read-only diagnostic commands may open a
read-only connection when no migration is pending. Schema migrations run under an exclusive
lock and always preserve a pre-migration backup.

JSONL transcript output is generated by `chatroom log --jsonl`. It is deterministic and can
be regenerated from the database; it is not tailed as an input to recovery.

### 6.2 Core schema

The following is logical SQL. Exact indexes and check constraints belong in migrations.

```sql
projects(
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  current_conversation_id TEXT
)

conversations(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  status TEXT NOT NULL,                 -- active | archived | deleting
  autonomy_limit INTEGER NOT NULL,
  autonomy_used INTEGER NOT NULL,
  latest_checkpoint_entry_id INTEGER,
  applied_integration_oid TEXT
)

entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,                   -- message | event
  created_at TEXT NOT NULL
)

messages(
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id),
  author TEXT NOT NULL,                 -- user | claude | codex
  via TEXT NOT NULL,                    -- repl | post | reply | recovery
  body TEXT NOT NULL,
  turn_id TEXT,
  operation_id TEXT,
  reply_to INTEGER REFERENCES messages(entry_id),
  causal_root INTEGER REFERENCES messages(entry_id),
  UNIQUE(author, operation_id)
)

message_targets(
  message_id INTEGER NOT NULL REFERENCES messages(entry_id),
  participant TEXT NOT NULL,
  expects_action INTEGER NOT NULL,
  PRIMARY KEY(message_id, participant)
)

events(
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id),
  type TEXT NOT NULL,
  agent TEXT,
  turn_id TEXT,
  payload_json TEXT NOT NULL
)

agent_sessions(
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent TEXT NOT NULL,
  vendor_session_id TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- absent | healthy | tainted | lost
  last_confirmed_entry_id INTEGER,
  capabilities_json TEXT NOT NULL,
  PRIMARY KEY(conversation_id, agent)
)

turns(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- preparing | running | ending | ended | failed | interrupted
  vendor_turn_id TEXT,
  session_generation INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  final_message_id INTEGER,
  error_json TEXT,
  cost_json TEXT
)

turn_inputs(
  turn_id TEXT NOT NULL REFERENCES turns(id),
  message_id INTEGER NOT NULL REFERENCES messages(entry_id),
  ordinal INTEGER NOT NULL,
  transport TEXT NOT NULL,              -- start | steer | boundary-replay
  PRIMARY KEY(turn_id, message_id)
)

deliveries(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(entry_id),
  status TEXT NOT NULL,                 -- queued | held | publishing | accepted | superseded
  transport TEXT,                       -- turn | steer | file
  attempt INTEGER NOT NULL DEFAULT 0,
  autonomy_charged INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  UNIQUE(agent, message_id)
)

agent_operations(
  operation_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- post | reply | delivery_ack
  status TEXT NOT NULL,                 -- imported | accepted | rejected
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(agent, operation_id)
)

permissions(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  agent TEXT NOT NULL,
  vendor_request_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending | allowed | denied | cancelled
  summary TEXT NOT NULL,
  request_json TEXT,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
)

workspaces(
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  owner TEXT NOT NULL,                  -- claude | codex | integration
  branch_ref TEXT NOT NULL UNIQUE,
  worktree_path TEXT,
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  last_snapshot_oid TEXT,
  ownership_token TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(conversation_id, owner)
)

integration_operations(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  type TEXT NOT NULL,                   -- snapshot | integrate | sync | apply | remove
  status TEXT NOT NULL,                 -- planned | executing | committed | needs_recovery | failed
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
)

checkpoints(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  through_entry_id INTEGER NOT NULL,
  summary TEXT NOT NULL,
  workspace_manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

### 6.3 Transaction boundaries

These operations are each one database transaction:

- append a message, resolve targets, create delivery rows, and reserve autonomy credits;
- create a turn, attach its initial input set, and change the agent to `preparing`;
- accept a native delivery and mark its messages delivered;
- append an agent's final reply and end its turn;
- import an agent operation and write its logical receipt result;
- record a permission decision;
- plan or finish a Git integration operation.

SQLite cannot be atomic with child processes, filesystem renames, or Git. Those crossings use
an intent record followed by reconciliation. Recovery can therefore answer whether an
operation was not started, completed, or left between the two.

---

## 7. Messages, targets, and causality

### 7.1 Participants

The fixed handles are `user`, `claude`, and `codex`. `@all` means every participant except
the author.

Every message is visible in the user's transcript immediately after commit. A delivery row
is created for each agent other than the author, even when that agent is not a target. A
non-target delivery waits until that agent next receives a triggering message; this preserves
"everyone sees everything" without waking an agent for status chatter.

### 7.2 Target resolution

Explicit transport metadata wins over body parsing:

```sh
"$CHATROOM_BIN" post --to codex "Parser interface is ready."
"$CHATROOM_BIN" post --to user "Parser is complete."
"$CHATROOM_BIN" post --to all "I changed the shared format."
```

For REPL messages, agent final replies, and compatibility with `chatroom post "@codex ..."`,
mentions are parsed outside inline and fenced code. Unknown handles produce a warning and do
not silently broaden the audience.

| Author | No explicit target or mention | Explicit targets |
|---|---|---|
| user | Claude and Codex | Named agents |
| agent | user | Named participants except the author |

The body is stored exactly as authored. Resolved targets are separate rows and are never
reconstructed later from text.

### 7.3 Operation and causal identifiers

Agent-side commands generate a random UUID `operation_id` before writing anything. A retry
uses the same id. `(agent, operation_id)` is unique.

Messages may have:

- `reply_to`: the direct question or message being answered;
- `causal_root`: normally the user message that began the current piece of work;
- `turn_id`: the model turn in which an agent authored the message.

`chatroom reply <message-id> <body>` sets `reply_to` explicitly. A turn's final reply is
linked automatically to its newest triggering input unless the agent already posted an
explicit reply. `reply` targets the original message's author unless `--to` overrides it.
Causal fields support `ask`, diagnostics, and future per-task budgets; they do not determine
room ordering.

### 7.4 Limits

Defaults, configurable downward or upward within hard implementation caps:

- message body: 64 KiB UTF-8;
- operation file: 96 KiB;
- agent posts per turn: 100;
- unprocessed operation files per turn: 256;
- delivery batch: 64 messages and a driver-specific token budget;
- receipt retention: seven days after the conversation is archived.

Oversized content is rejected before it reaches the transcript. Long tool output is never a
chat message unless the agent deliberately summarizes or attaches it by path.

---

## 8. Autonomy budget and scheduling

### 8.1 Meaning of the budget

The budget limits how many agent-authored messages may autonomously activate the other agent
after the most recent user message. It is a credit counter, not graph depth.

- A user-authored trigger costs zero and resets `autonomy_used` to zero.
- An agent-authored message targeting the other agent reserves one credit when committed.
- Messages to the user cost zero.
- One message costs at most one credit, independent of watcher events or delivery batching.
- If no credit remains, the target delivery is `held`; the message is still visible to the
  user and will be included when that recipient is next activated by the user.
- Increasing `/budget` releases held triggers in entry order and charges each released
  message exactly once.

If the user addresses only Claude, held Codex work remains held. A new user message does not
globally wake an unrelated recipient.

### 8.2 Scheduler states

For each agent:

```text
idle
preparing
running
waiting_for_permission
stopping
recovering
unavailable
```

At most one model turn is active per agent and conversation. Claude and Codex may each have
one turn active concurrently.

### 8.3 Scheduling rule

After a message commit, turn completion, budget change, driver reconnect, or recovery:

```text
for each agent A:
    triggers = undelivered messages targeted at A and not held
    if triggers is empty:
        continue

    batch = every undelivered message visible to A through the newest trigger

    if A is idle:
        transactionally create a turn with batch as start inputs
        start the driver turn
    else if A is running and driver.can_steer:
        transactionally mark batch as publishing
        steer the active vendor turn
        on protocol acceptance, mark batch accepted
        on rejection, return batch to queued
    else:
        leave batch queued for the next turn boundary
```

A user trigger may include older held agent messages in the same batch without spending new
credits: the user has explicitly reactivated that recipient. Held messages alone never start
a turn.

Native protocol acceptance means the vendor process accepted the input, not that the model
acted on it. This is the delivery acknowledgment Chatroom can actually prove.

### 8.4 Fairness and backpressure

The scheduler alternates agents when both have eligible work and starts both in the same
event-loop tick when resources permit. It does not wait for one agent to claim work before
starting the other. The brief requires immediate claims; native steering delivers those
claims during the peer's active turn.

If an agent posts faster than the recipient can process, messages remain durable and are
coalesced into a bounded delivery batch. The sender receives a receipt for every post even
when its target is held.

---

## 9. File IPC protocol

File IPC is used for operations initiated by tools inside an agent sandbox. Native driver
protocols carry orchestrator-to-model messages whenever possible.

### 9.1 Per-turn environment

The driver supplies:

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT` | `claude` or `codex` |
| `CHATROOM_CONVERSATION` | Stable conversation UUID |
| `CHATROOM_TURN` | Stable Chatroom turn UUID |
| `CHATROOM_OPERATION_DIR` | Absolute, exact agent-writable drop directory for this turn |
| `CHATROOM_DELIVERY_DIR` | Absolute orchestrator-owned directory, readable by the agent |
| `CHATROOM_RECEIPT_DIR` | Absolute orchestrator-owned receipt directory |
| `CHATROOM_SCRATCH` | Absolute per-turn temp directory |
| `CHATROOM_BIN` | Absolute path to the running compatible executable |
| `CHATROOM_PROTOCOL` | Integer agent-command protocol version |

The turn's random directory nonce is part of the path rather than trusted from an operation
payload. The parent of the writable directory is not writable by the agent, so the agent
cannot replace the granted root.

### 9.2 Writing an operation

`post`, `reply`, and delivery acknowledgments use the same envelope:

```json
{
  "protocol": 2,
  "operation_id": "f7515aa7-ff20-4b9e-807d-12f66157b282",
  "type": "post",
  "created_at": "2026-09-04T21:07:40Z",
  "payload": {
    "targets": ["codex"],
    "body": "Parser interface is ready.",
    "reply_to": null
  }
}
```

The command opens a unique temporary regular file in `CHATROOM_OPERATION_DIR`, writes and
fsyncs it, then renames it to `<operation-id>.json`. It never follows a path supplied by the
message body.

Filesystem notifications are latency hints only. A poller is authoritative. The dispatcher:

1. atomically renames an entry from the fixed drop root into orchestrator-owned `staging/`;
2. uses `lstat`/no-follow semantics and rejects anything except one bounded regular file;
3. validates protocol, operation id, current turn, type, targets, and UTF-8 body;
4. imports it transactionally or returns the previous result for a duplicate operation id;
5. writes a receipt to a temporary file under `to-agent/receipts/` and renames it into place.

The orchestrator never opens a symlink target and never creates a file below
`from-agent/` or `scratch/`.

### 9.3 Receipts

```json
{
  "protocol": 2,
  "operation_id": "f7515aa7-ff20-4b9e-807d-12f66157b282",
  "status": "accepted",
  "message_id": 42
}
```

`chatroom post` waits briefly for this receipt and prints `#42`. A local timeout means
"acceptance unknown", not failure. It prints the operation id, and retrying with that id
returns the same logical result.

Before a turn is finalized, the orchestrator closes the agent operation root to new imports,
drains files already atomically published, waits a short bounded grace period, and only then
retires the directory. This removes the process-exit race for a final `post`.

### 9.4 Incoming file fallback

When native steering is unavailable, the normal behaviour is to wait for the next turn. A
driver may additionally expose file delivery as a capability. The orchestrator writes an
atomic file under `to-agent/deliveries/`; `chatroom inbox` reads it and writes a
`delivery_ack` operation into the current drop directory. It never moves or deletes the
delivery file.

Parallel `inbox` invocations are safe because acknowledgment is idempotent. The orchestrator
removes a delivery file only after the database says it was accepted.

### 9.5 `ask` and `reply`

```sh
"$CHATROOM_BIN" ask --to codex "List or iterator?"
"$CHATROOM_BIN" reply 52 "It returns an iterator."
```

`ask` is `post` followed by waiting for a message whose `reply_to` equals the accepted
question id. It may print other incoming messages while waiting but never mistakes them for
the answer. On timeout it returns an indeterminate result and tells the agent to continue;
the question remains durable.

---

## 10. Driver contract

Drivers expose semantic capabilities rather than CLI flags:

```ts
type DriverCapabilities = {
  persistentSession: boolean;
  nativeSteering: boolean;
  interrupt: boolean;
  hostApprovals: boolean;
  structuredEvents: boolean;
  sandboxVerified: boolean;
  maxSteerBytes?: number;
};

interface AgentDriver {
  probe(): Promise<ProbeReport>;
  connect(session: SessionSpec): Promise<DriverCapabilities>;
  startTurn(turn: TurnSpec, input: DeliveryBatch): Promise<VendorTurn>;
  steer(turn: VendorTurn, input: DeliveryBatch): Promise<AcceptedInput>;
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(turn: VendorTurn): Promise<void>;
  events(): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
```

Calling an unsupported optional method is a programmer error. The scheduler branches only
on recorded capabilities.

### 10.1 Preferred Claude driver

Use the TypeScript Claude Agent SDK in streaming input mode. It provides a long-lived
interactive session, runtime permission callbacks, session management, and programmatic
hooks. The Chatroom brief is supplied by invocation options, not a project file.

The driver:

- starts or resumes by explicit session id;
- sets the exact conversation worktree as `cwd`;
- keeps the input stream open during an active turn;
- sends addressed mid-turn messages through the SDK stream when supported;
- maps `canUseTool` calls to Chatroom permission requests;
- normalizes assistant text, tool activity, results, costs, and session identifiers;
- applies strict sandbox settings described in section 14.

If the SDK's streaming behaviour fails its smoke test, Claude falls back to one-shot
`claude -p` turns with explicit session ids. Mid-turn messages then wait for the next turn.
Baseline correctness never depends on a `PostToolUse` hook.

Reference: [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
and [runtime permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

### 10.2 Preferred Codex driver

Run `codex app-server` as a child process and speak JSON-RPC over stdio. The driver maps:

- new/resumed Chatroom session to `thread/start` or `thread/resume`;
- a turn to `turn/start`;
- addressed mid-turn messages to `turn/steer` with the expected vendor turn id;
- `/stop` to `turn/interrupt`;
- streamed items and deltas to common driver events;
- command and file approval requests to the REPL.

The official App Server protocol documents thread resume, active-turn steering,
interruption, and host approval requests. Those are a closer fit for Chatroom than parsing
one process per reply.

Reference: [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server).

If App Server probing fails, use `codex exec --json` and `codex exec resume` with prompts on
stdin (`-`), explicit ids, pinned sandbox configuration, and `-o` for the final message.
The fallback has no mid-turn injection and no Codex approval relay. It does not install or
bypass-trust a lifecycle hook.

Reference: [OpenAI Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

### 10.3 Capability probing

`chatroom doctor` records, per driver:

- executable real path and version;
- supported commands and flags;
- protocol initialization and schema version;
- session start, resume, and interruption;
- native steering during a harmless turn;
- permission request and response flow;
- effective working directory;
- write success in the worktree, outbound drop, and scratch directory;
- write failure in the main tree, peer worktree, inbound IPC, and a random outside path;
- effective network and Unix-socket policy where the platform can test them;
- loaded instruction, settings, hook, plugin, and MCP sources where the vendor reports them.

Version checks select likely probes; only probe results enable a capability. Results are
cached with executable hash, version, platform, config fingerprint, and expiry.

---

## 11. Turn lifecycle

### 11.1 Starting a turn

1. In one transaction, select every undelivered message through the newest eligible trigger,
   create the turn, attach ordered `turn_inputs`, mark those deliveries `publishing`, and
   append `turn_started`.
2. Create exact per-turn outbound and scratch directories.
3. Connect or resume the vendor session and verify its workspace identity.
4. Submit the prompt through the native API or stdin. Never put a transcript-sized prompt in
   an argument.
5. When the vendor acknowledges the turn, store its turn/session id, mark input deliveries
   `accepted`, and set the turn `running`.
6. Stream normalized activity to the REPL and optional raw log.

If spawning or submission fails, the same transaction that records failure returns
`publishing` deliveries to `queued`. No cursor changes.

### 11.2 During a turn

- Agent-side posts are imported independently of model output.
- Eligible messages for a running agent are steered natively when possible.
- Permission requests stop only the requesting operation. The other agent and the REPL stay
  live.
- A permission decision is durable before the driver receives it.
- `/stop` first requests protocol interruption, then sends SIGTERM and finally SIGKILL if the
  child does not stop within configured grace periods.

### 11.3 Ending a turn

1. Receive the vendor's terminal event and final reply.
2. Close the operation root to new files and drain operations already published.
3. In one transaction:
   - append the non-empty final reply with idempotency key `final:<turn-id>`;
   - or append `silent` when the reply is empty or exactly `[silent]`;
   - store cost and result metadata;
   - mark the turn ended and clear the agent's active-turn reference.
4. Write any pending receipts, retire per-turn writable directories, and run the scheduler.

An agent final reply with no explicit mention targets the user. A final reply that merely
duplicates an already accepted explicit `post` should be `[silent]`; no automatic textual
deduplication is attempted.

### 11.4 Mid-turn steering failure

`turn/steer` or streaming input can race with turn completion. If the vendor says there is
no matching active turn, Chatroom returns those deliveries to `queued` and includes them in
the next turn. The autonomy credit remains charged because the logical agent-to-agent
activation was accepted; transport retries do not charge again.

---

## 12. Sessions, checkpoints, and crash recovery

### 12.1 Sessions are caches

The room transcript, accepted deliveries, workspace snapshots, and checkpoints are durable
truth. Vendor sessions are performance caches. Each session record has a `generation`.

Session ids are always explicit. A picker, `--last`, or `--continue` is never used by the
orchestrator. A resumed vendor session must report the expected id and conversation
worktree. Otherwise it is rejected as lost.

### 12.2 Checkpoints

A full transcript may not fit in a future context window. After a configurable amount of
conversation growth, Chatroom asks one agent or a dedicated summarization turn to produce a
checkpoint containing:

- decisions and unresolved questions;
- work claimed and completed by each agent;
- relevant message ids;
- workspace branch, head, and integration oids;
- test/build status explicitly reported in the room;
- no facts that are not traceable to messages or Git state.

The checkpoint is stored with `through_entry_id`. Rebuilding uses the newest valid checkpoint
plus later messages and a fresh workspace manifest. The raw transcript remains queryable and
exportable; the summary is a replaceable cache.

### 12.3 Lost session rebuild

1. Mark the old generation `lost` and retain its id for diagnostics.
2. Create a new generation.
3. Build a bounded prompt from the brief, latest checkpoint, messages after it, any specifically
   referenced earlier messages, and current workspace state.
4. Start a fresh vendor session and store the new id only after protocol acknowledgment.
5. Append `session_rebuilt` with old/new generation and checkpoint id.

If even the checkpoint plus required tail exceeds the driver's budget, stop and ask the user
to archive or split the conversation rather than silently truncating recent instructions.

### 12.4 Interrupted turns and tainted sessions

A session is `tainted` when Chatroom cannot prove whether an in-flight model request ended.
Examples include orchestrator crash, SIGKILL, transport loss after input acceptance, and
malformed terminal output.

Chatroom does not blindly resume a tainted session and resend the same prompt. The default
recovery is:

1. inspect and snapshot the agent worktree;
2. record the interrupted turn and exact accepted input ids;
3. start a new session generation from the latest checkpoint and transcript tail;
4. include a recovery note listing the interrupted turn, accepted message ids, and current
   workspace diff;
5. ask the agent to inspect existing side effects before continuing.

A driver may offer a proven safe fork-before-incomplete-turn operation. It can be used only
when the probe confirms that the fork excludes the incomplete turn.

### 12.5 Startup reconciliation

On startup, before scheduling new work:

- mark database turns left `preparing` or `running` as interrupted;
- reconcile staged IPC operations by operation id;
- recreate missing delivery or receipt files from database rows;
- quarantine files that do not belong to an active or recoverable turn;
- reconcile every `planned` or `executing` Git operation using its manifest;
- verify worktree paths, refs, oids, ownership tokens, and main-tree status;
- rebuild or reconnect sessions only after workspace reconciliation succeeds.

Recovery actions are appended as events. Ambiguous main-tree changes cause a hard stop with a
precise recovery command; Chatroom never resets the user's work to guess its way forward.

---

## 13. What agents receive

### 13.1 Delivery format

Prompts contain a short invariant header followed by JSON records. JSON escaping prevents a
message body from being confused with transport metadata.

```text
[chatroom delivery v2]
You are @claude. Messages are ordered by id. Resolved targets are metadata, not inferred
from body text. Act on messages where expects_action is true; read the others as room context.

{"id":41,"from":"user","targets":["claude","codex"],"expects_action":true,
 "time":"2026-09-04T21:07:12Z","reply_to":null,"body":"Implement X."}
{"id":42,"from":"codex","targets":["claude"],"expects_action":true,
 "time":"2026-09-04T21:07:40Z","reply_to":41,
 "body":"I'll take the parser; can you take the CLI?"}
```

The delivery also includes a compact workspace manifest:

```text
workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230
peer changes since your previous accepted input: src/parser.ts, test/parser.test.ts
```

Changed paths are advisory. Agents inspect files before relying on them.

### 13.2 Brief

The brief is supplied by the driver on every new session and repeated compactly after vendor
compaction where supported:

```text
You are @{me} in a project chat with @user and @{other}. Solve the user's task together.
Everything posted is visible to the user and eventually to both agents.

Coordination
- On a task sent to both agents, immediately claim a concrete, non-overlapping part with:
  "$CHATROOM_BIN" post --to {other} "..."
- Use "$CHATROOM_BIN" reply <message-id> "..." for a direct answer.
- Use "$CHATROOM_BIN" ask --to {other} "..." only when work is genuinely blocked on a
  short answer. Continue after its bounded timeout.
- A final response with no mention reports to the user. Mention the other agent only when
  you intend to activate it. If your explicit posts said everything, end with [silent].
- Keep chat messages short; code and detailed results belong in the worktree.

Workspace
- Write only in {my_worktree} and the supplied per-turn scratch/drop directories.
- Read {peer_worktree}, {integration_view}, and {main_tree} when useful, but never write
  there.
- Do not merge, rebase, reset, or edit Chatroom-owned refs. Ask the user to run Chatroom
  integration commands.
- You may commit, but you do not need to. Chatroom snapshots all non-ignored changes.

Recovery
- Message ids are stable. A recovery prompt may describe a prior interrupted attempt.
  Inspect the current worktree before repeating commands or edits.
```

Project-specific `brief.extra` is appended with a visible label. It is size-capped and is
never interpolated into shell code.

---

## 14. Sandboxing, permissions, and trust

### 14.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, malformed IPC files, duplicate operations, and common path/symlink attacks. It
does not protect secrets that agents are explicitly allowed to read from disclosure through
model APIs or other enabled network tools.

The repository is assumed trusted enough to read and execute its normal build/test tooling.
"Run Chatroom in an unknown repository to see what happens" is outside the safe model.

### 14.2 Required write boundary

For each active turn, the only intended writable locations are:

- the agent's conversation worktree;
- its exact `from-agent/<turn>-<nonce>` drop root;
- its exact `scratch/<turn>-<nonce>` temp root;
- vendor-owned session/cache locations required by the harness, outside model-generated
  commands.

The main tree, peer worktree, integration worktree, database, inbound deliveries, receipts,
and recovery manifests must fail a write probe.

### 14.3 Claude

Claude runs with its native sandbox enabled. Chatroom pins, through invocation settings:

- sandbox enabled;
- fail if the sandbox is unavailable;
- no unsandboxed retry escape hatch;
- additional write paths limited to the exact outbound and scratch roots;
- network policy chosen by Chatroom configuration;
- permission callbacks routed to the REPL.

Permission `auto` or a user approval is not treated as filesystem isolation. The operating
system sandbox remains active after permission is granted. Built-in file tools remain
constrained by Claude's path permissions.

Reference: [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing).

### 14.4 Codex

Codex uses workspace-write sandboxing with safety-relevant fields supplied explicitly for
each thread or turn. The effective policy must provide:

- worktree write access;
- additional writable roots only for outbound IPC and per-turn scratch;
- shell network disabled unless the user opted into a configured policy;
- global `/tmp` and inherited `$TMPDIR` excluded where supported;
- `TMPDIR` set to Chatroom's per-turn scratch root;
- no approvals-and-sandbox bypass.

Reference: [OpenAI Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The baseline App Server design does not need a lifecycle hook or
`--dangerously-bypass-hook-trust`. If a future optional hook transport is added, `doctor`
must enumerate every hook source because Codex combines matching hooks from multiple config
layers. A trust bypass must never be described as applying only to Chatroom's hook unless
other sources are provably disabled.

Reference: [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks).

### 14.5 Customization modes

Chatroom exposes two explicit modes:

| Mode | Behaviour |
|---|---|
| `strict` (default) | Load project instruction files, but disable optional user/project lifecycle hooks, plugins, or configuration sources that can widen the verified sandbox where the driver supports doing so. Refuse startup if the effective boundary cannot be verified. |
| `compatible` | Load normal vendor customization sources. Show every detected source in `/status` and warn when it widens hooks, commands, network, or writable paths. |

Managed organization policy always remains in force. Chatroom never attempts to bypass it.
If vendor configuration merging makes a strict guarantee impossible, `strict` fails with a
diagnostic instead of quietly behaving like `compatible`.

### 14.6 Identity and capabilities

Sender identity is assigned from the currently active driver and the fixed drop root, never
from a `from` field. The random turn path and operation id prevent accidental cross-turn
reuse. Because processes share one OS account, this is not cryptographic isolation from a
deliberately malicious local process; stronger isolation would require separate OS users or
containers.

---

## 15. Conversation workspaces and Git integration

### 15.1 One workspace set per conversation

A conversation owns three Chatroom refs:

```text
refs/heads/chatroom/<project-short>/<conversation-short>/claude
refs/heads/chatroom/<project-short>/<conversation-short>/codex
refs/heads/chatroom/<project-short>/<conversation-short>/integration
```

All begin at the main tree's HEAD when the conversation is created. Branch names include
opaque ids, not unsanitized conversation names. Chatroom refuses to reuse a pre-existing ref
unless its ownership token and recorded oid match.

Claude and Codex have stable worktree paths below
`.chatroom/worktrees/<conversation-id>/`. Stable paths preserve vendor session/cwd identity.
The integration ref normally needs no checked-out worktree; Chatroom creates a temporary one
only for merge or conflict inspection.

Inactive conversations may be archived. Archiving snapshots cleanly, removes physical agent
worktrees with `git worktree remove`, and retains refs, transcript, sessions, and stable path
metadata. Continuing recreates the worktrees at the same paths before sessions resume.

### 15.2 Snapshotting uncommitted work

Agents may commit, but Chatroom never requires them to. With the agent stopped, `/snapshot`
captures all tracked and non-ignored untracked files:

1. Write an `integration_operations` intent with expected branch and worktree oids.
2. Build a temporary Git index from the agent branch HEAD.
3. Add the worktree through the temporary index, without using the user's real index.
4. Write a tree and create a synthetic commit with `git commit-tree`, bypassing project
   commit hooks and signing configuration.
5. Atomically update the Chatroom-owned ref using its expected old oid.
6. Align the managed worktree index to the new snapshot without changing files.
7. Record the new oid and finish the operation.

Ignored dependency/build files are not captured. Staging state is not preserved across a
snapshot; managed agent worktrees promise content preservation, not human staging semantics.

### 15.3 Integrating an agent

`/integrate <agent>`:

1. refuses while that agent is running;
2. snapshots it;
3. creates or refreshes the isolated integration worktree;
4. merges the agent branch into the integration branch using normal Git ancestry;
5. runs no project hooks and performs no signing;
6. on success, creates an integration commit, updates the recorded oid, and removes the
   temporary worktree;
7. on conflict, aborts without changing the integration ref or main tree and reports files.

Because the integration branch records prior merges, later integrations contain only new
agent snapshots. Already accepted changes are not reapplied.

`/merge <agent>` may exist as an alias for `/integrate <agent>` but the UI should use
"integrate" to avoid implying that the main branch changes.

### 15.4 Synchronizing an agent

`/sync <agent>` first snapshots the agent and then merges the conversation's integration
branch into that agent branch. This is how Claude consumes Codex's integrated parser, or
Codex consumes Claude's CLI work.

If the merge conflicts, the agent worktree is left in a documented conflict state with its
pre-sync snapshot safely committed. Chatroom will not start a normal turn there; the user may
start a dedicated conflict-resolution turn or abort back to the recorded snapshot.

`/import <source> <destination>` is shorthand for integrate source, then sync destination.

### 15.5 Applying to the user's main tree

`/apply` is the only normal Chatroom command that modifies the main working tree.

Preconditions:

- the main tree and index are clean;
- no prior apply needs recovery;
- the integration branch has unapplied commits;
- no path involved is outside the repository or resolves through a symlinked control path.

Procedure:

1. Record an `apply` intent containing main HEAD, old applied integration oid, new integration
   oid, patch hash, and pre-operation status.
2. Generate the full-index binary delta from the last applied integration oid to the new tip.
3. Apply and merge-test the delta in a temporary worktree based on current main HEAD.
4. If the preflight succeeds, run an atomic apply against the still-clean main worktree.
5. Leave the resulting files unstaged for user review.
6. Record the applied integration oid, resulting status fingerprint, and completed event.

If the main HEAD changed after preflight, abort before writing. A conflict changes nothing in
the main tree. If Chatroom crashes after applying files but before committing the database
record, startup compares the stored patch and expected status fingerprint. It can complete
the record when they match exactly; otherwise it stops with the recovery manifest and never
resets user files.

The user may then inspect, test, stage, commit, or discard the changes normally. A future
`/apply` uses only the delta after the recorded integration oid, so previously applied work
is not repeated even when the user committed it under a different commit id.

### 15.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees but keeps conversations and refs.
`chatroom reset` removes all Chatroom data and owned refs only after:

- all agents stop;
- every dirty worktree is snapshotted or explicitly discarded by the user;
- each ref matches its recorded ownership token and expected namespace;
- Git confirms no non-Chatroom worktree depends on it.

Destructive subcommands show exact paths and refs and require confirmation unless an explicit
non-interactive confirmation flag is supplied.

---

## 16. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, workspace refs, and worktrees. Sessions start lazily. |
| `chatroom list` | Show conversations, agents, workspace state, and unapplied integration count. |
| `chatroom continue <name-or-id>` | Recreate archived worktrees if needed, verify them, and open the conversation. |
| `chatroom archive <name-or-id>` | Stop turns, snapshot, remove physical worktrees, retain history and refs. |
| `chatroom delete <name-or-id>` | Remove sessions where supported, worktrees, owned refs, IPC, logs, and database rows after confirmation. |

Switching conversations stops or waits for active turns, snapshots both agent worktrees, and
disconnects drivers. Because worktree paths are conversation-specific, a resumed session
cannot observe another conversation's files.

Conversation deletion reports vendor sessions it could not remove. It never claims that
vendor-retained data was deleted when only local Chatroom metadata was removed.

---

## 17. REPL and commands

The UI remains line-oriented. Concurrent output redraws the input line without losing text.

```text
#42 codex -> claude                                      21:07  post
  Parser interface is ready; can you take the CLI?
    · claude: editing src/cli.ts
    · codex: pytest -q

claude: working · codex: working · budget 1/6 · integration +2 · parser
> _
```

Plain input is a user message. Fenced multiline input remains available. Permission requests
are assigned short ids so the user can continue typing messages and answer asynchronously:

```text
!p3 codex requests network access to registry.npmjs.org
/allow p3 once
```

### 17.1 Slash commands

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, capabilities, turns, held deliveries, permissions, workspaces, integration/apply state. |
| `/stop <agent-or-all>` | Protocol interrupt followed by bounded process termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a permission request. |
| `/new`, `/switch`, `/conversations`, `/rename`, `/archive` | Conversation lifecycle. |
| `/snapshot <agent-or-all>` | Persist current non-ignored agent work to its branch. |
| `/integrate <agent>` | Merge an agent snapshot into the conversation integration branch. |
| `/sync <agent-or-all>` | Bring integrated work into agent branches. |
| `/import <source> <destination>` | Integrate source, then sync destination. |
| `/apply` | Apply the unapplied integration delta to a clean main worktree, unstaged. |
| `/show quiet\|activity\|full`, `/focus <agent-or-all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and sandbox diagnostics. |
| `/quit` | Stop or detach according to policy, flush state, release lock. |

External commands include `chatroom log`, `doctor`, `gc`, `clean`, and `reset`, plus the
agent-only `post`, `reply`, `ask`, and `inbox`. Agent-only commands refuse to run unless every
required `CHATROOM_*` variable and protocol version is present.

---

## 18. Configuration

Global and project configuration use TOML. Project values override global values, except
that managed vendor policy can only narrow what Chatroom may do.

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Agent-authored cross-agent activations after user input. |
| `turn.timeout_minutes` | `30` | Hard turn timeout. |
| `turn.stop_grace_seconds` | `5` | Grace between protocol interrupt, SIGTERM, and SIGKILL. |
| `ask.timeout_seconds` | `60` | Agent-side direct-answer wait. |
| `driver.claude.model` | vendor default | Optional model override. |
| `driver.codex.model` | vendor default | Optional model override. |
| `driver.prefer_native` | `true` | Prefer Agent SDK/App Server over one-shot CLI. |
| `security.mode` | `strict` | `strict` or `compatible`. |
| `security.shell_network` | `false` | Permit network from sandboxed shell commands. |
| `security.read_secrets` | `warn` | `warn` or driver-supported deny policy. |
| `logging.raw_events` | `false` | Persist vendor raw streams. Normalized activity still displays. |
| `logging.retention_days` | `30` | Raw log and retired receipt retention. |
| `logging.max_mib` | `256` | Per-project raw-log cap. |
| `display.level` | `activity` | `quiet`, `activity`, or `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |
| `workspace.archive_inactive` | `false` | Remove physical worktrees after safe snapshot on switch/archive. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn
so a diagnostic can explain changed behaviour.

---

## 19. Activity, logs, and privacy

Normalized activity is ephemeral UI data unless `logging.raw_events` is enabled. Durable
room messages and lifecycle events stay in SQLite.

Display kinds:

| Kind | Example |
|---|---|
| `text` | Interim assistant narration. |
| `reasoning_summary` | Vendor-provided summary only, never assumed to be raw reasoning. |
| `tool` | Tool name and bounded input summary. |
| `tool_result` | Bounded result summary and status. |
| `permission` | Redacted request and durable decision. |

Raw vendor streams can contain source, command output, prompts, and secrets. They are off by
default, private to the user, size-capped, and removable with `chatroom gc --raw-logs`.
Permission events store a redacted summary by default; full request JSON follows the raw-log
policy. Chatroom never records environment-variable values merely to make diagnostics easier.

Database exports warn that they may contain user and agent messages copied from private
source files.

---

## 20. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Mark turn interrupted and session tainted; reconcile IPC and workspace; rebuild or proven-safe fork. |
| Crash after message commit, before scheduling | Message and delivery rows remain queued; startup scheduler handles them. |
| Crash after native input accepted, before DB acknowledgment | Reconcile against vendor turn history when available; otherwise taint session and rebuild with accepted-input ambiguity recorded. |
| Duplicate filesystem event or post retry | Unique operation id returns the original receipt. |
| Operation file is malformed, large, symlinked, or stale | Quarantine, bounded rejection event, no message. |
| Agent floods drop directory | Per-turn count/byte limit closes imports and stops or warns the turn. |
| Native steering races turn completion | Return delivery to queued; include it in next turn; no second budget charge. |
| Driver process exits nonzero | Preserve bounded stderr, fail turn, taint only when input acceptance was ambiguous. |
| Session cannot resume | Rebuild from checkpoint and tail with a new generation. |
| Sandbox probe fails | Strict mode refuses to start that agent. Other agent may continue if the user chooses. |
| Extra hooks or config widen policy | Strict mode refuses; compatible mode displays warning and exact source. |
| Budget exhausted | Cross-agent trigger stays held; user sees it and status reports count. |
| Integration conflict | Main tree unchanged; integration ref unchanged; report paths and preserve recovery worktree when useful. |
| Sync conflict | Agent's pre-sync snapshot is safe; worktree enters conflict-resolution state. |
| Apply conflict or stale main HEAD | Main tree unchanged. |
| Crash during apply | Compare intent patch/status fingerprints; complete record only on exact match, otherwise stop for user recovery. |
| Branch/ref mismatch | Refuse destructive or integration action; show expected and actual oids. |
| Database corruption | Stop, preserve files, attempt SQLite integrity diagnostics and documented backup recovery; never reconstruct authoritative state from raw logs automatically. |
| Disk full | Stop accepting messages before acknowledging them; keep already committed state; surface a persistent fatal status. |

---

## 21. Verification and testing strategy

### 21.1 Model-free core tests

Most correctness is testable without vendor calls. Fake drivers provide deterministic start,
steer, reply, permission, crash, and malformed-event scenarios.

Property tests assert:

- entry ids are increasing and never reused;
- one `(agent, message)` delivery exists at most once;
- accepted operations produce one logical message and stable receipt;
- autonomy use never exceeds the configured limit;
- transport retry never charges again;
- an agent has at most one active turn;
- every ended turn has a terminal event;
- no orchestrator write target is beneath an agent-writable root;
- recovery reaches the same logical state after a crash at any injected boundary.

The test harness kills the orchestrator after every persistence, rename, spawn, protocol
acceptance, and Git step, then restarts and checks invariants.

### 21.2 IPC security tests

Test regular files, partial files, duplicate operation ids, hard links, symlinks, directory
entries, FIFOs, huge sparse files, path traversal strings, replaced subdirectories, parallel
readers, stale turn paths, and notification duplication. Verify the orchestrator never reads
or writes through an attacker-chosen path.

### 21.3 Git matrix

Exercise:

- tracked, untracked, deleted, renamed, executable, symlink, and binary files;
- agent commits plus uncommitted changes;
- sequential snapshots and integrations;
- both agents editing the same and different files;
- main advancing before `/apply`;
- repeated apply after the user commits prior output;
- conflict and abort paths;
- crash at every intent/command/ref/database boundary;
- pre-existing similarly named refs and linked worktrees.

The main tree must remain byte-for-byte unchanged on every failed preflight.

### 21.4 Driver contract fixtures

Record sanitized vendor event streams as fixtures. Parser tests do not call live models.
Live smoke tests are opt-in because they may cost money and change vendor session state.

`chatroom doctor --smoke` uses a temporary Git repository and harmless prompts to verify the
capabilities listed in section 10.3. It prints what was measured, what official documentation
claims, and what remains unverified.

### 21.5 Compatibility policy

Support is expressed as a matrix of passing capabilities, with tested version ranges shown
for troubleshooting. A vendor upgrade that changes an event shape disables that adapter
until its probe and parser pass; it does not silently fall through to guessed parsing.

---

## 22. Implementation approach

### 22.1 Language

Recommendation: TypeScript on a supported Node.js LTS release.

Reasons:

- the Claude Agent SDK is first-class in TypeScript;
- Codex App Server is JSON-RPC/JSONL and maps cleanly to typed discriminated unions;
- child process streaming, readline integration, filesystem watching, and async queues are
  straightforward;
- fake drivers and protocol fixtures are inexpensive to build;
- a single npm-installed command naturally supplies the agent-side subcommands.

The Codex adapter should be generated from or checked against the App Server schema when
available, but vendor types stop at the adapter boundary. The scheduler depends only on
Chatroom's own types.

SQLite should use a mature binding with transactions, WAL support, and packaged native
binaries for supported platforms. If distribution of native bindings becomes the dominant
problem, reassess the runtime before weakening the transactional design.

### 22.2 Suggested modules

```text
src/
  cli/
    main.ts
    repl.ts
    agent-command.ts
  core/
    orchestrator.ts
    scheduler.ts
    addressing.ts
    budget.ts
    recovery.ts
  store/
    database.ts
    migrations/
    queries.ts
    export.ts
  ipc/
    protocol.ts
    importer.ts
    receipts.ts
    paths.ts
  drivers/
    types.ts
    claude-sdk.ts
    claude-cli.ts
    codex-app-server.ts
    codex-cli.ts
    probes.ts
  workspace/
    repository.ts
    snapshot.ts
    integration.ts
    apply.ts
    recovery.ts
  ui/
    renderer.ts
    permissions.ts
    activity.ts
  test-support/
    fake-driver.ts
    crash-injector.ts
```

The agent-command entry path must initialize quickly and must not import the REPL, vendor
SDKs, Git manager, or writable database connection.

---

## 23. Build order

### Phase 1: Durable room core

- SQLite schema and migrations.
- Message/target resolution.
- Delivery records and deterministic autonomy budget.
- Fake drivers and scheduler property tests.
- JSONL export.

Exit criterion: crash injection cannot lose or duplicate logical messages.

### Phase 2: IPC and agent commands

- Split-ownership directory layout.
- Operation import, receipts, retry, limits, and quarantine.
- `post`, `reply`, `ask`, and `inbox` against fake agents.
- Symlink/race/security test suite.

Exit criterion: every accepted operation has one durable result and no orchestrator path can
be redirected by an agent-controlled directory entry.

### Phase 3: Read-only drivers

- Capability probes.
- Claude SDK and Codex App Server session start/resume.
- Turn streaming and final replies without filesystem writes.
- Recorded protocol fixtures.

Exit criterion: both agents can chat concurrently in a temporary repository.

### Phase 4: Sandboxed work

- Conversation worktrees.
- Strict sandbox profiles and negative write probes.
- Permission relay for both native drivers.
- Native steering and turn interruption.

Exit criterion: each agent can edit and test its own worktree but cannot write the main tree,
peer tree, inbound IPC, or database.

### Phase 5: Git collaboration

- Synthetic snapshots.
- Integration branch and `/integrate`.
- `/sync`, `/import`, and conflict states.
- Recoverable `/apply`.
- Full Git/crash matrix.

Exit criterion: sequential work from both agents can be integrated and applied once, while
every conflict leaves the main tree unchanged.

### Phase 6: Recovery and operational polish

- Tainted session rebuild.
- Checkpoints and bounded catch-up.
- Conversation archive/delete.
- Log retention, `gc`, `doctor --smoke`, and compatibility reporting.
- REPL rendering and asynchronous permissions.

---

## 24. Open decisions

1. **Strict customization implementation.** Determine the exact vendor-specific way to load
   project instruction files while excluding lifecycle sources that can widen the sandbox.
   If either harness cannot prove that split, document the limitation and fail strict mode.
2. **Checkpoint producer.** Decide whether Claude, Codex, the less-busy agent, or a dedicated
   low-cost model turn creates summaries. The schema does not depend on the choice.
3. **Raw activity defaults.** The design recommends transient activity and raw logs off, but
   early adapter development may temporarily prefer raw logs on with a small cap.
4. **Apply UX.** Decide whether `/apply` should optionally create a normal commit on a user-
   named branch. Leaving changes unstaged remains the safe default.
5. **Conflict resolution.** A dedicated `/resolve <operation>` agent turn could be useful,
   but manual inspection and explicit `/sync` retry are sufficient for the first release.
6. **Inactive worktree policy.** Per-conversation worktrees are correct but consume disk.
   Automatic snapshot-and-archive can be added after dependency cache behaviour is measured.
7. **One-shot driver support floor.** Decide whether environments without native Claude
   streaming or Codex App Server are supported with reduced capabilities or rejected by v2.

---

## 25. External protocol references

These links explain current adapter choices. They are not substitutes for runtime probes.

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server): threads, turns,
  steering, interruption, streaming events, and approvals.
- [OpenAI Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli):
  non-interactive execution and resume fallback.
- [OpenAI Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference):
  sandbox, writable roots, environment policy, and temp/network controls.
- [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks): hook discovery, merging, trust,
  and event outputs; included mainly to state why baseline v2 does not depend on hooks.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode):
  long-lived interactive input.
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions): runtime
  permission decisions.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing): OS-level filesystem
  and network boundaries.

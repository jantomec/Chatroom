# Chatroom Architecture v6

Status: implementation baseline, 2026-09-05. Standalone; supersedes `ARCHITECTURE.md` (v1)
and `ARCHITECTURE_V2.md` through `ARCHITECTURE_V5.md`. No code exists yet. Implementation
starts with Phase 0 (§25), whose purpose is to answer the items in §22 before any scheduler
code is written.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0,
git 2.50.1. Versions are evidence for the smoke tests, not compatibility promises.

How to read this document:

- **Comment** blocks explain why a decision stands or what changed from an earlier revision.
- **Guard** blocks mark decisions that a later revision must not reverse without the user's
  explicit approval. Each cites its evidence: a user decision, a measurement on this machine,
  or a quoted documentation sentence. A revision that believes a guarded decision is wrong
  must say so in its change list and quote the guard, rather than redesigning around it.
  Section 0.1 indexes all guards.
- **Proposed** marks items the user has not explicitly decided; they can be dropped.

---

## 0. Changes from v5

All six come from the Codex review of v5, each verified before adoption.

1. **Git writes inside the shared `.git` are scoped.** Claude's sandboxing docs: for a linked
   worktree "the sandbox also allows writes to the main repository's shared `.git`
   directory so commands such as `git commit` can update refs and the index. Writes to
   `hooks/` and `config` inside that directory remain denied." v5 therefore let an agent
   move `main`, delete Chatroom refs or write the peer's index. v6 allows writes only to the
   object store, the agent's own ref and reflog, and its own worktree admin directory, and
   watches the guarded refs as a backstop. Clones were considered and rejected (§15.7).
2. **The child environment is scrubbed.** v5 removed only the Anthropic key. Codex's config
   reference: `shell_environment_policy.inherit` defaults to `all` and
   `ignore_default_excludes` defaults to true, meaning "keep variables containing KEY,
   SECRET, or TOKEN". v6 scrubs secret-like variables at spawn for both drivers and sets
   Codex's own exclusions as a second layer. Guarantees are now labelled per surface, and
   Grep and Glob are labelled best-effort as the Claude docs say.
3. **Three modes, `guarded` by default.** v5 kept running with a guarantee disabled while
   calling the mode strict. v6: `guarded` requires the write boundary and reports the rest;
   `strict` fails closed on every advertised guarantee; `compatible` loads vendor
   customization. MCP servers, apps and browser tools are disabled in `guarded` and `strict`
   unless allowlisted, because Codex's docs say permission profiles do not govern them.
4. **`/apply` and `/sync` are native git merges.** Measured with git 2.50.1: a merge with
   `--no-commit --no-ff` into a dirty main preserves unstaged edits on untouched files,
   refuses when a dirty or untracked file would be overwritten, refuses a second merge until
   the first is committed or aborted, and merges an advanced tip on the same file cleanly
   after the first merge is committed. That is the dirty-disjoint rule, the collision rule
   and iterative apply, without the synthetic commit, the applied-oid marker, the per-path
   journal or the crash classification. `/sync` ships in the first release.
5. **Authority lives in the main worktree; the lock in the runtime root.** v5 created
   `.chatroom/` at the toplevel of whichever checkout `chatroom` ran in, so a user's own
   linked worktree would have produced a second database, not just a second lock.
6. **Guards updated.** G9, G13 and G15 rewritten; G21 to G24 added.

Kept from v5 without change of substance: CLI-on-subscription Claude in auto mode, Codex on
app-server with Auto-review, `PostToolUse` delivery, SQLite authority with mirror, delivery
records, idempotent operations, split-ownership IPC, capability probing, per-conversation
worktrees outside the main tree, snapshots, integration branch, suspect-session recovery,
Phase 0, the autonomy budget, the read denylist, and native Claude file tools.

### 0.1 Regression guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; SDK docs: "Anthropic does not allow third party developers to offer claude.ai login … including agents built on the Claude Agent SDK." |
| G2 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G3 | Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, falling back to the user visibly. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G4 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: streaming input "queued messages … process sequentially"; hook `additionalContext` "appended to the tool result". |
| G5 | Claude's native Read, Grep, Glob, Edit and Write stay enabled; the boundary is path deny rules. Grep and Glob are labelled best-effort. | Claude permissions docs: `Read(//path)` and `Edit(//path)` rules exist; "A Read deny rule also blocks the Edit and Write tools on the same path"; Grep and Glob honour Read denies "best-effort". |
| G6 | Reads are denylisted, not allowlisted; toolchains stay readable; caches writable via config. | Usability; Claude docs: "the deny holds inside a wider allow"; Codex docs: "deny takes precedence over write, and write takes precedence over read." |
| G7 | Worktrees and IPC live outside the main tree, because Claude permission rules are deny-wins and a main-tree Edit deny would cover a nested worktree. | Claude permissions docs: deny rules take precedence; sandboxing docs: "the narrower allow re-opens that part of the denied region." |
| G8 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G9 | No commit norms. Agents may commit or branch inside their own worktree; the shared `.git` is writable only within the scope of §15.7. | User decision on norms; Claude sandboxing docs on the shared `.git` allowance. |
| G10 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G11 | When both agents answer at once, both replies are recorded. | User decision. |
| G12 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G13 | `/apply` and `/sync` are native `git merge` operations. No synthetic commit, no applied-oid marker, no per-path journal. | Measured merge behaviour, §16.5 and §22. |
| G14 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency; correlation invariant kept. |
| G15 | Three modes: `guarded` (default, write boundary mandatory, rest reported), `strict` (fail closed), `compatible`. No mode claims a guarantee it does not enforce. | Codex review of v5; honesty of naming. |
| G16 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex sandbox denies Unix-socket connections. |
| G17 | Zero footprint: nothing written to tracked files, CLAUDE.md, AGENTS.md, `.claude/`, `.codex/` or `.gitignore`. | User decision. |
| G18 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | Both harnesses persist turns incrementally. |
| G19 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry, §7.1. |
| G20 | First-release cut line: Phase 0, phases 1 to 5. Source review, checkpoints, archive and `gc` come later. | Scope control. |
| G21 | Git writes in the shared `.git` are scoped to objects, own ref, own reflog and own admin directory; guarded refs are watched. Clones are not used. | Claude docs quote in change 1; user decision against clones. |
| G22 | The child environment is scrubbed of secret-like variables for both drivers; Codex's default exclusions are switched on. | Codex config reference: `ignore_default_excludes` "default: true". |
| G23 | `.chatroom/` lives in the main worktree resolved from the common git directory; the lock lives in the runtime root keyed by project id. | Codex review of v5; `git rev-parse --show-toplevel` differs per linked worktree. |
| G24 | MCP servers, apps and browser tools are disabled in `guarded` and `strict` unless allowlisted. | Codex config reference: profiles govern sandboxed commands, not MCP servers or apps. |

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
inside it. Chatroom creates durable authority under `.chatroom/` in the main worktree,
agent runtime data under the platform's per-user state directory, and Chatroom-owned Git
refs and worktrees. It does not change tracked project files, `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `.codex/`, or `.gitignore`. Plain `claude` and `codex` sessions remain
independent, and Claude keeps running on the user's subscription.

### 1.1 Non-goals for the first release

- More than Claude and Codex as agents.
- A graphical or full-screen interface.
- Remote or multi-user chatrooms.
- Exactly-once execution of model tool calls.
- Isolation from a deliberately hostile operating-system user.
- Native Windows. Supported targets are macOS, Linux and WSL2.
- Source review (`/review`), checkpoints, archive and `gc`.

---

## 2. Principles and invariants

1. **One durable authority.** SQLite wins over any derived file.
2. **One database writer.** Only the orchestrator connection mutates the database.
3. **Monotonic room order.** Every message and event receives one increasing `entry_id`.
4. **At-least-once transport, idempotent acceptance.**
5. **No state rollback.** Recovery moves forward from durable facts.
6. **No orchestrator writes under agent control.**
7. **A message is durable before it is visible.**
8. **A budget decision is deterministic.**
9. **A conversation maps to stable session and workspace identities.**
10. **Main-tree mutation is explicit and native.** `/apply` is the only normal operation
    that edits the user's main worktree, and it does so through `git merge`.
11. **Safety settings are pinned and probed** through shell and native tools.
12. **Adapters are capability-based.**
13. **Zero footprint.** (G17)
14. **Subscription-preserving.** (G1)
15. **Reviewers are not boundaries.** Human approval and Auto-review decide only within
    independently enforced path, ref, environment and network rules.
16. **Secrets denied, tools open.** (G6)
17. **Native tools stay native.** (G5)
18. **No mode claims what it does not enforce.** (G15)
19. **Shared repository state is protected by scope, not by trust.** (G21)

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
 │   + JSONL mirror)                          apply, all native git; ref watch) │
 │        ▲                 ▲                   ▲                               │
 │  ┌─────┴────────────┐    │          ┌────────┴────────┐                      │
 │  │ Claude driver    │    │          │ Codex driver    │                      │
 │  │ claude -p, auto  │    │          │ codex app-server│                      │
 │  │ stream-json i/o  │    │          │ JSON-RPC stdio  │   auto-review        │
 │  └─────┬────────────┘    │          └────────┬────────┘                      │
 └────────┼─────────────────┼───────────────────┼───────────────────────────────┘
          │ stdin turns +   │ agent-side files  │ turn/start, turn/steer
          │ PostToolUse hook│                   │
          ▼                 ▼                   ▼
   Claude worktree     from-agent/to-agent   Codex worktree
```

| Component | Responsibility |
|---|---|
| REPL | User input, transcript rendering, activity streams, permission decisions, commands. |
| Orchestrator | The single state machine and database writer. |
| Store | Schema, migrations, transactions, queries, JSONL mirror. |
| IPC dispatcher | Imports agent operations, writes receipts and deliveries, enforces idempotency and limits. |
| Driver | Starts or resumes one vendor session with a scrubbed environment and pinned boundary, submits turns, delivers mid-turn messages, normalizes events, relays approvals. |
| Workspace manager | Creates conversation worktrees, snapshots, merges, watches guarded refs. |
| Agent-side command | `post`, `reply`, `ask`, `inbox`, `hook`; uses only paths supplied in its environment. |

---

## 4. Project identity, locking, and disk layout

### 4.1 Project identity and the main worktree

Chatroom resolves `git rev-parse --path-format=absolute --git-common-dir`, hashes it into
`project_id`, and resolves the **main worktree** as the first entry of `git worktree list`
whose git directory is the common directory. Bare repositories are refused. All per-project
authority is placed in that main worktree, whichever checkout `chatroom` was started from.
Chatroom refuses to start from one of its own managed worktrees.

The project lock is an advisory OS lock on an open file descriptor at
`<runtime root>/lock`, unique by construction because the runtime root is keyed by
`project_id`. PID and start time are diagnostic fields.

> **Guard G23.** `git rev-parse --show-toplevel` differs for every linked worktree of the same
> repository, so authority keyed by it would fork the database. Keep `.chatroom/` in the main
> worktree and the lock in the runtime root.

### 4.2 Global files

```text
<install>/chatroom                         executable or launcher
~/.config/chatroom/config.toml             optional defaults
<platform-state>/chatroom/projects/        runtime roots by project id
```

The orchestrator resolves its own real executable path at startup and passes it to agents
as `CHATROOM_BIN`.

### 4.3 Per-project authority (`<main worktree>/.chatroom/`)

```text
.chatroom/
  config.toml
  chatroom.sqlite3                         authority
  chatroom.sqlite3-wal / -shm
  transcript/<conversation-id>.jsonl       derived mirror
  logs/<conversation-id>/                  raw vendor events, opt-in
  worktrees -> <runtime root>/worktrees    proposed: convenience symlink for the user
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after verifying that `.chatroom` is a
real directory. Mode `0700`; files `0600`. Agents have no read access to `.chatroom/`.

### 4.4 Per-project runtime root

```text
<platform-state>/chatroom/projects/<project-id>/
  lock
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
```

Every orchestrator-owned ancestor is a real directory owned by the user, mode `0700`,
opened with no-follow checks. The runtime path is stored in the database and must map back
to the canonical common directory before reuse. `chatroom gc` (later) reports orphaned
runtime roots.

> **Guard G7.** Worktrees stay outside the main tree. Claude permission rules are deny-wins,
> so the `Edit(//<main>/**)` deny in §15.2 would cover a nested worktree. The OS sandbox is
> not the reason: both vendors document that a narrower entry re-opens a denied region.

---

## 5. Durable storage

### 5.1 Engine and settings

`node:sqlite`, present on the development machine's Node with an experimental warning.
Phase 0 runs the durability suite on the oldest supported Node LTS. One write connection.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations run under an exclusive lock and keep a pre-migration backup.

### 5.2 JSONL mirror

Appended after every committed transaction that creates entries, outside the transaction.
On startup and on `chatroom log --verify`, the whole mirror is scanned: every line must
parse and the ordered `entry_id` sequence must equal the database query. Any discrepancy
causes a rewrite through a sibling temporary file, `fsync` and rename. Never read by
recovery.

### 5.3 Schema

```sql
projects(id PK, main_worktree, git_common_dir, runtime_root, created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                        -- active | archived | deleting
  autonomy_limit, autonomy_used)

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)

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

turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
                                 -- transport: start | steer | hook | boundary

deliveries(id PK, conversation_id FK, agent, message_id FK,
  status,                        -- queued | held | publishing | accepted | superseded
  transport, attempt, autonomy_charged, accepted_at, UNIQUE(agent, message_id))

agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))       -- type: post | reply | delivery_ack

permissions(id PK, turn_id FK, agent, vendor_request_id, status, reviewer, summary,
  request_json, decision_json, rationale, created_at, resolved_at)
                                 -- reviewer: user | auto_review | claude_auto | managed | none

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, admin_dir,
  head_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))
                                 -- owner: claude | codex | integration

guarded_refs(conversation_id FK, ref, expected_oid, checked_at, PK(conversation_id, ref))
                                 -- main, peer refs, integration ref; see §15.7

integration_operations(id PK, conversation_id FK, type, status, target_ref, details_json,
  created_at, finished_at)       -- type: snapshot | integrate | sync | apply | apply_abort
                                 -- status: planned | executing | committed | needs_user | failed
```

> **Comment.** Gone since v5: `applied_integration_oid`, `integration_base_oid`, per-path
> manifests. Merge ancestry carries that information. New: `guarded_refs` and
> `workspaces.admin_dir`, the path of the worktree's `.git/worktrees/<name>` directory,
> which §15.7 needs.

### 5.4 Transaction boundaries

One transaction each: append a message with targets, delivery rows and credit reservation;
create a turn with its input set; accept a delivery; append a final reply and end its turn;
import an agent operation and its receipt result; record a permission decision; plan or
finish a Git operation. Crossings into child processes, filesystem renames and Git use an
intent record followed by reconciliation.

---

## 6. Messages, targets, and causality

### 6.1 Participants and addressing

Handles: `user`, `claude`, `codex`. A mention is `@` followed by a handle or `all`, at a
word boundary, case-insensitive, anywhere in the body outside inline and fenced code.
`@all` means every participant except the author.

| Author | No mention | Mentions |
|---|---|---|
| user | Claude and Codex | the mentioned agents |
| agent | user | the mentioned participants except the author |

Agent-side commands accept `--to <handle>[,<handle>]` as an explicit override. Resolved
targets are separate rows, never reconstructed from text, and always shown.

> **Guard G10.** `@handle` is the one convention. Do not instruct agents to prefer `--to`.

### 6.2 Visibility and delivery rows

Every message is visible immediately after commit. A delivery row is created for each agent
other than the author, target or not. A non-target delivery waits until that agent next
receives a triggering message.

### 6.3 Operation and causal identifiers

Agent-side commands generate a random UUID `operation_id` before writing; a retry reuses it.
Messages may carry `reply_to`, `causal_root` and `turn_id`. A turn's final reply is linked
to its newest triggering input unless the agent already posted an explicit reply.

### 6.4 Limits

Body 64 KiB; operation file 96 KiB; posts per turn 100; unprocessed operation files per turn
256; delivery batch 64 messages and a driver-specific token budget.

---

## 7. Autonomy budget and scheduling

### 7.1 Meaning of the budget

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery is `held`; the message stays visible to the user.
- Messages to the user cost nothing. One message costs at most one credit.

Held deliveries are released, and charged once, when the user addresses the held recipient
or everyone, or raises `/budget`. A user message that addresses only one agent does not
release the other agent's held deliveries.

> **Guard G19.** The asymmetry is intentional. Do not make a user message to one agent
> release the other agent's held deliveries.

### 7.2 Scheduler states

Per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. One active turn per agent; the two agents run concurrently.

> **Guard G12 and G11.** No turn-taking; no discarded replies.

### 7.3 Scheduling rule

```text
for each agent A:
    triggers = undelivered messages targeted at A, not held
    if triggers is empty: continue
    batch = every undelivered message visible to A through the newest trigger
    if A is idle:                       create a turn with batch; start it
    elif A running and nativeSteering:  mark publishing; steer; accepted on protocol ack
    elif A running and hookDelivery:    mark publishing; write delivery files; accepted on ack
    else:                               leave queued for the next turn boundary
```

### 7.4 Fairness and backpressure

Both agents start in the same tick when both have eligible work. Messages coalesce into
bounded batches. Every post gets a receipt even when its target is held.

---

## 8. File IPC protocol

> **Guard G16.** Files, never sockets. Measured: a Unix-socket connection from inside the
> Codex sandbox fails with "Operation not permitted".

### 8.1 Per-turn environment

The driver builds the child environment from scratch:

1. Start from the user's environment.
2. Remove every variable whose name matches `security.env_deny_patterns`, default
   `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `AWS_*`,
   `GOOGLE_APPLICATION_CREDENTIALS`, `GH_*`, `GITHUB_*`, `NPM_CONFIG_*AUTH*`, `OPENAI_*`,
   `ANTHROPIC_*`. Names on `security.env_allow` are kept regardless.
3. Add the Chatroom variables:

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

The Codex driver additionally sets `shell_environment_policy.ignore_default_excludes =
false` and `shell_environment_policy.filters` with the same patterns, so Codex's own layer
enforces the scrub even if the driver's is bypassed. The Claude driver has no second layer:
Bash inherits the CLI's environment, which is the scrubbed one.

The agent's Git environment is not altered otherwise; the user's global Git configuration,
identity and excludes apply inside the worktree.

> **Guard G22.** Both drivers spawn with a scrubbed environment. Codex's config reference:
> `ignore_default_excludes` "Keep variables containing KEY, SECRET, or TOKEN before other
> filters run (default: true)". Do not rely on the vendor default, and do not scrub only the
> Anthropic key.

### 8.2 Writing an operation

`post`, `reply` and `delivery_ack` use one envelope:

```json
{"protocol": 3, "operation_id": "<uuid>", "type": "post", "created_at": "<iso>",
 "payload": {"to": ["codex"], "body": "@codex Parser interface is ready.", "reply_to": null}}
```

Unique temporary file in `CHATROOM_OPERATION_DIR`, `fsync`, rename to
`<operation-id>.json`. Notifications are hints; a poller is authoritative. The dispatcher
renames each entry into `staging/`, validates it with no-follow semantics, imports it
transactionally or returns the previous result, and writes a receipt by temp-file-and-rename.

### 8.3 Receipts

`{"protocol": 3, "operation_id": "…", "status": "accepted", "message_id": 42}`.
`chatroom post` waits briefly and prints `#42`. Before a turn is finalized, the drop root is
closed, drained, and retired after a grace period.

### 8.4 Deliveries and acknowledgment

For the hook transport, the orchestrator writes one atomic file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack`; they never move or delete the delivery file.

### 8.5 `ask` and `reply`

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`. A message whose `reply_to`
is the question id resolves it durably (`answered`). The first message from an asked party
that targets the asker after the question is returned immediately as `probable`; the
question stays open. On timeout, `indeterminate`.

> **Guard G14.** Return early on the first probable candidate; never let it mark the
> question resolved.

---

## 9. Driver contract

```ts
type GuaranteeLevel = "enforced" | "best_effort" | "unavailable";

type DriverCapabilities = {
  persistentSession: boolean;
  longLivedProcess: boolean;
  nativeSteering: boolean;
  hookDelivery: boolean;
  interrupt: boolean;
  hostApprovals: boolean;
  autoReviewer: "claude_auto" | "codex_auto_review" | "none";
  autoReviewRationale: boolean;
  inspectTurnState: boolean;
  structuredEvents: boolean;
  maxDeliveryBytes?: number;
  guarantees: {
    shellWrites: GuaranteeLevel;      // own worktree, drop, scratch, scoped .git only
    nativeWrites: GuaranteeLevel;     // Edit/Write denied on main, peer, IPC
    shellReads: GuaranteeLevel;       // secret paths denied
    nativeReads: GuaranteeLevel;      // Read denied on secret paths
    searchReads: GuaranteeLevel;      // Grep/Glob: best_effort unless disabled
    gitRefs: GuaranteeLevel;          // guarded refs unwritable; enforced | best_effort (watch only)
    environment: GuaranteeLevel;      // scrubbed
    externalTools: GuaranteeLevel;    // MCP, apps, browser disabled
    network: GuaranteeLevel;
  };
};
```

The driver interface is unchanged from v5: `probe`, `connect`, `startTurn`, `steer`,
`deliverViaHook`, `inspectTurn`, `answerPermission`, `interrupt`, `events`, `close`.

### 9.1 Capability probing

`chatroom doctor` fills every `guarantees` entry by attempting the forbidden thing through
both shell and native tools: write to main, peer, IPC and `.chatroom/`; read a canary
secret file and a canary secret environment variable; move `main`, delete the integration
ref, write the peer's admin directory, commit on the own branch (must succeed); list loaded
MCP servers, apps and hook sources; connect to a network host. It also verifies Claude's
login and Codex's effective reviewer. Only probe results enable capabilities; results are
cached with executable hash, version, platform and config fingerprint.

---

## 10. Claude driver

### 10.1 Transport

```text
claude -p \
  --session-id <uuid> | --resume <uuid> \
  --input-format stream-json --output-format stream-json --verbose \
  --include-hook-events \
  --append-system-prompt "<brief>" \
  --settings '<inline JSON: hooks, sandbox, permissions.deny; §15.2>' \
  --permission-mode auto --permission-prompts host \
  --strict-mcp-config [--mcp-config <allowlisted servers>] \
  [--setting-sources <per §15.5>] [--model <model>]
```

Working directory: the conversation's Claude worktree. Environment: §8.1. A turn is one
`user` message on stdin and the `result` event that ends it; the CLI queues further input,
so the driver writes a turn's input only when the scheduler starts one. `longLivedProcess`
true; `nativeSteering` false; `hookDelivery` true. Reply text and cost come from `result`;
activity from `assistant` events.

> **Guard G1.** CLI, never the Agent SDK. Everything the SDK offers is a wrapper around
> these flags, and the SDK docs direct SDK users to API keys.

### 10.2 Mid-turn delivery: PostToolUse hook

```json
{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` drains `CHATROOM_DELIVERY_DIR`, writes a `delivery_ack`, and prints
`hookSpecificOutput.additionalContext` with the delivery text. Hooks run outside the Bash
sandbox with the driver's environment.

> **Guard G4.** Streaming input is a queue; the hook is the injection channel.

### 10.3 Auto mode and approvals

`--permission-mode auto`: the classifier decides routine actions; the rest arrive as control
requests, are recorded with `reviewer: user`, shown with a short id, and answered on stdin.
Hard denials (§15.2) apply before any prompt.

> **Guard G2.** `auto` with host-relayed prompts. Not `bypassPermissions`, `acceptEdits`,
> `dontAsk`, or prompts routed to `none`.

### 10.4 Fallback

One process per turn with the same flags if the long-lived process fails Phase 0.

---

## 11. Codex driver

### 11.1 Transport

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the permission profile (§15.3), the environment policy (§8.1), MCP and app
disables (§15.5). `turn/start`, `turn/steer` with `expectedTurnId`, `turn/interrupt`.
Approval requests `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval` reach the REPL when
Auto-review escalates or is unavailable. `item/autoApprovalReview/*` notifications are
recorded as evidence when they parse. All names confirmed in the schema generated by
`codex app-server generate-json-schema` on 0.153.3.

### 11.2 Auto-review

The closest equivalent to Claude's auto mode. Docs: "Auto-review only applies when
approvals are interactive"; with `never` "there is nothing to review". The reviewer is set
per thread and per turn; decisions are recorded with rationale when observable, and as
`rationale: unavailable` otherwise; escalations and unavailability fall back to the user
visibly.

> **Guard G3.** `auto_review` with `on-request`, user fallback. The unstable notifications
> are evidence, not a precondition.

### 11.3 Fallback: `codex exec`

```text
codex exec --json -o <file> -c 'default_permissions="chatroom-<nonce>"' -c 'permissions.…' \
  -c 'approval_policy="never"' -c 'shell_environment_policy.…' [-c 'mcp_servers.<id>.enabled=false' …] \
  [-c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust] -
codex exec resume <thread-id> --json -o <file> -c … -
```

No `--sandbox`: the docs say `sandbox_mode` and `default_permissions` cannot both be set.
No Auto-review, human approval or steering on this path. If the profile cannot load, the
driver uses legacy `workspace-write` with `writable_roots` and reports `shellReads`,
`gitRefs` and `nativeReads` as `unavailable`. Hook delivery only when Chatroom's hook is the
sole non-managed hook source.

---

## 12. Turn lifecycle

Unchanged from v5: transactional turn creation with `publishing` deliveries; exact per-turn
drop and scratch directories; input through the native channel, never an argument;
`accepted` on acknowledgment; activity streamed. On exit: close and drain the drop root;
append the final reply with idempotency key `final:<turn-id>`, or `silent`; return
unacknowledged hook deliveries to `queued`; retire directories; run the scheduler. After
every turn ends, the workspace manager checks `guarded_refs` (§15.7).

---

## 13. Sessions and recovery

### 13.1 Sessions are caches

Session ids are always explicit; a picker, `--last` or `--continue` is never used. A
resumed session must report the expected id and working directory, else it is `lost`.

### 13.2 Suspect sessions

Snapshot the worktree; record the interrupted turn and accepted ids; inspect vendor turn
state where available; resume by explicit id and verify identity and directory, which moves
the session to `recovering`; send a recovery note as the first input, with no queued room
work attached; mark `healthy` only after that turn reaches a valid terminal event; otherwise
`lost` and rebuild.

> **Guard G18.** Resume before rebuild; the recovery turn is the health check.

### 13.3 Lost session rebuild

New generation; bounded prompt from brief, transcript tail, referenced messages and
workspace state; new id stored after acknowledgment; `session_rebuilt` event.

### 13.4 Startup reconciliation

Mark turns left `preparing` or `running` as interrupted; verify the runtime root; reconcile
staged IPC by id; recreate missing delivery or receipt files; quarantine orphans; reconcile
every `planned` or `executing` Git operation (§16.7); check `guarded_refs`; validate the
mirror; reconnect sessions last.

---

## 14. What agents receive

### 14.1 Delivery format

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
- You may commit on your own branch, but you do not need to. Chatroom snapshots all
  non-ignored changes and owns integration. Other branches and refs are not writable.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

> **Guard G8 and G9.** Main and peer readable, own worktree writable, commits allowed on the
> own branch. Do not replace main-tree reads with object-id inspection; do not add commit
> prohibitions or commit-often norms.

---

## 15. Sandboxing, approvals, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, writes to shared repository state, reads of known secret locations and
secret-bearing environment variables, malformed IPC, duplicate operations, and common path
and symlink attacks. It assumes anything a model tool can read may reach that model's
provider. It does not isolate a malicious local process, and it does not vet the
repository's own build tooling.

### 15.2 Claude

The OS sandbox covers Bash commands only; default write scope is the working directory, added
directories and the session temp directory, plus, for a linked worktree, the shared `.git`
directory except `hooks/` and `config`. Native tools are governed by permission rules.

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyWrite": ["<git scoping entries, §15.7>"],
      "denyRead":  ["<security.secret_paths…>", "<main>/.chatroom",
                    "<ipc root>/*/staging", "<ipc root>/<peer>"]
    },
    "network": {"allowUnixSockets": [], "allowedDomains": ["<security.network_domains…>"]}
  },
  "permissions": {
    "deny": [
      "Read(//<secret path>/**)", "…", "Read(//<main>/.chatroom/**)",
      "Edit(//<main>/**)", "Write(//<main>/**)",
      "Edit(//<peer worktree>/**)", "Write(//<peer worktree>/**)",
      "Edit(//<ipc root>/**)", "Write(//<ipc root>/**)",
      "Edit(//<git common dir>/**)", "Write(//<git common dir>/**)"
    ]
  }
}
```

Guarantee levels for Claude: `shellWrites` and `shellReads` enforced by the OS; `nativeWrites`
and `nativeReads` enforced by rules; `searchReads` best-effort, or enforced when
`security.harden_native_search` disables Grep and Glob so the agent searches with `rg` inside
the sandbox; `gitRefs` per §15.7; `environment` enforced by the driver; `externalTools`
enforced by `--strict-mcp-config` and the setting-source choice.

Default `security.secret_paths`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
`~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`, `~/.codex`,
`~/.config/chatroom`.

> **Guard G5 and G6.** Native tools stay; reads are denylisted. Do not deny `/` and re-open a
> minimal set.

### 15.3 Codex

A generated permission profile with a random name, supplied through `config` overrides:

```toml
default_permissions = "chatroom-<nonce>"

[permissions.chatroom-<nonce>.filesystem]
"/"                     = "read"      # or ":root" if Phase 0 shows it is accepted
"<own worktree>"        = "write"
"<drop root>"           = "write"
"<scratch root>"        = "write"
"<extra write root…>"   = "write"
"<git scoping entries, §15.7>"
"<main>/.chatroom"      = "deny"
"<ipc root>/*/staging"  = "deny"
"<ipc root>/<peer>"     = "deny"
"<secret path…>"        = "deny"

[permissions.chatroom-<nonce>.network]
enabled = false
```

Precedence per the docs: "More specific entries override broader entries … deny takes
precedence over write, and write takes precedence over read." If the profile cannot load,
legacy `workspace-write` with `writable_roots` enforces `shellWrites` only, and the other
guarantees are reported `unavailable`.

Never used: `danger-full-access`, the approvals-and-sandbox bypass, the experimental
per-thread `permissions` parameter.

### 15.4 Approval and review boundaries

Reviewers decide only within the boundaries above. A request touching a hard-denied path or
ref fails before any reviewer sees it.

### 15.5 Modes

| Mode | Behaviour |
|---|---|
| `guarded` (default) | Start only if `shellWrites` and `nativeWrites` probe as enforced and the login probe passes. Every other guarantee is attempted and its level shown in `/status`; nothing is silently claimed. MCP servers, apps and browser tools are disabled unless allowlisted (`security.mcp_allowlist`). Claude: `--strict-mcp-config`, and the setting-source combination Phase 0 finds that drops user and project hooks while keeping `CLAUDE.md`. Codex: `mcp_servers.<id>.enabled = false` for every configured server not on the allowlist, `apps.<id>.enabled = false` likewise, browser tools disabled by the key Phase 0 identifies. |
| `strict` | As `guarded`, but every guarantee must probe as `enforced` or the agent does not start. `searchReads` therefore implies `harden_native_search`. |
| `compatible` | Vendor customization loads normally. Every detected source, tool and widened path is listed in `/status` with a warning. |

Managed organization policy always remains in force.

> **Guard G15 and G24.** No mode claims a guarantee it does not enforce; `guarded` is the
> default because it always starts when the write boundary holds. Codex's config reference:
> profiles do not govern MCP servers or apps, so those are disabled by their own keys.

### 15.6 Identity

Sender identity comes from the driver and the fixed drop root, never from a payload.

### 15.7 Git write scope

Because the Claude sandbox opens the shared `.git` directory for linked worktrees, and
because commits are allowed (G9), the write scope inside `<git common dir>` is narrowed to
what committing on the own branch needs:

| Path under the common dir | Agent access | Why |
|---|---|---|
| `objects/**` | write | content-addressed; adding objects cannot damage anything |
| `refs/heads/chatroom/<proj>/<conv>/<agent>` and its `.lock` | write | the own branch |
| `logs/refs/heads/chatroom/<proj>/<conv>/<agent>` and `.lock` | write | its reflog |
| `worktrees/<own admin dir>/**` | write | own index, `HEAD`, per-worktree refs |
| `packed-refs`, `packed-refs.lock` | deny | rewriting it touches every ref |
| `HEAD`, `refs/**` except own, `logs/**` except own | deny | main, peer, integration, tags, remotes |
| `worktrees/<peer admin dir>/**`, `worktrees/<main>` | deny | the peer's index and `HEAD` |
| `hooks/`, `config`, `info/` | deny | Claude already denies the first two |

Consequences: `git commit`, `git branch` under the own name, `git log`, `git diff` and
`git show` work; `git stash` fails because `refs/stash` is shared; `git gc` and
`git pack-refs` fail on `packed-refs`; `git push`, `git fetch` have no network anyway.

Enforcement: Codex, through profile entries with the documented specific-over-broad and
deny-over-write precedence, probed as `enforced`. Claude, through `denyWrite` entries;
whether `denyWrite` can narrow the automatic worktree allowance is undocumented and is a
Phase 0 item. If it cannot, the driver enumerates every existing ref, `packed-refs`, `HEAD`
and the peer admin directory as explicit `denyWrite` entries and reports `gitRefs` as
`best_effort`, because refs created later are not covered.

Backstop in every mode: `guarded_refs` holds the expected oid of `main`, both agent refs
and the integration ref. The workspace manager compares before each integration operation
and after every turn. A moved ref produces a `ref_moved` event, blocks integration
operations for that conversation, and prints the reflog-based restore command; it never
resets the ref itself.

> **Guard G21.** Scope, then watch. Do not replace worktrees with per-agent clones: the user
> rejected clones, and they would lose the shared object store that makes snapshots,
> integration and peer inspection free. Do not fall back to forbidding commits.

---

## 16. Conversation workspaces and Git integration

### 16.1 One workspace set per conversation

Refs `refs/heads/chatroom/<project-short>/<conversation-short>/{claude,codex,integration}`,
all starting at main's HEAD. Worktrees under the runtime root at stable paths. Each
worktree's admin directory path is recorded in `workspaces.admin_dir`.

### 16.2 Snapshotting uncommitted work

`/snapshot <agent>`, with the agent stopped: temporary index from the branch HEAD; add the
worktree through it; `git write-tree` and `git commit-tree`, no hooks or signing; update the
ref with its expected old oid; align the worktree index; record the oid. Agent commits are
simply the history the snapshot sits on.

### 16.3 `/integrate <agent>`

Refuse while the agent runs; snapshot; in the temporary integration worktree,
`git merge --no-ff` the agent branch, no hooks or signing; on conflict `git merge --abort`
and report; on success record the oid.

### 16.4 `/sync <agent|all>`

1. In the integration worktree: if main's HEAD is not an ancestor of integration,
   `git merge --no-ff main`. On conflict, abort and report; nothing else changes.
2. Snapshot the agent; in the agent's worktree, with the agent stopped,
   `git merge --no-ff <integration>`. On conflict the worktree enters a documented conflict
   state with its pre-sync snapshot safe, and no normal turn starts there until the user
   resolves or `/sync --abort` runs `git merge --abort`.

`/import <source> <destination>` is integrate source, then sync destination.

### 16.5 `/apply [agent]`

`/apply <agent>` is integrate then apply. `/apply` runs, in the user's main worktree:

```sh
git merge --no-commit --no-ff <integration ref>
```

Measured with git 2.50.1 in a scratch repository:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Merge proceeds; the edit is preserved; tip changes are staged |
| Unstaged edit on a file the tip changes | Refused: "Your local changes … would be overwritten"; tree unchanged |
| Untracked file the tip would create | Refused: "untracked working tree files would be overwritten"; tree unchanged |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge; ancestry is shared |

Chatroom adds around the command: an `integration_operations` intent before, and after,
either `committed` with the resulting staged file list, or `failed` with git's message
verbatim. The result is left staged with `MERGE_HEAD` set; the user reviews with
`git diff --cached` and commits, or runs `/apply --abort`, which runs `git merge --abort` only
when a Chatroom intent for that `MERGE_HEAD` exists. `/apply --commit` (**proposed**) commits
immediately with a generated message.

Preconditions Chatroom checks before invoking git, purely to give better messages: the
integration ref exists and is not an ancestor of main's HEAD; the index equals HEAD; no
`MERGE_HEAD`, `REBASE_HEAD` or `CHERRY_PICK_HEAD` is present; `guarded_refs` match.

> **Guard G13.** Native merge, nothing custom. It gives the dirty-disjoint rule, the
> untracked-collision rule, iterative apply through shared ancestry, and atomic ref updates,
> all measured. The synthetic commit (v4), the applied-oid patch base (v3) and the per-path
> journal (v4, v5) each solved a subset and each had a failure case the native merge does not.
> Do not reintroduce any of them. The known trade-offs, a merge commit per apply and a staged
> rather than unstaged review, are accepted.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees and retired IPC, keeping
conversations, authority and refs. `chatroom reset` removes both roots and owned refs only
after all agents stop, every dirty worktree is snapshotted or explicitly discarded, each ref
matches its ownership token, and no non-Chatroom worktree depends on it.

### 16.7 Git operation recovery

Every operation has an intent row. On startup: an `executing` `apply` with a `MERGE_HEAD`
present in main is reported as `needs_user` with the two options, commit or `/apply --abort`;
an `executing` `apply` with no `MERGE_HEAD` is `failed`; an `executing` `integrate` or `sync`
is aborted in its worktree with `git merge --abort`; an `executing` `snapshot` is checked
against the ref's current oid. A `MERGE_HEAD` in main with no Chatroom intent is not
Chatroom's and is never touched.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees. |
| `chatroom list` | Conversations, agents, workspace state, integration state. |
| `chatroom continue <name-or-id>` | Verify worktrees and open. |
| `chatroom delete <name-or-id>` | Remove worktrees, owned refs, IPC, logs and rows after confirmation. |

Switching stops or waits for active turns, snapshots both worktrees, and disconnects drivers.

---

## 18. REPL and commands

```text
#42 codex → @claude                                       21:07  post
  @claude Parser interface is ready; can you take the CLI?
    · claude: Edit src/cli.ts
    · codex ✓ auto-review approved: npm test (low risk)

!p3 codex requests network access to registry.npmjs.org
claude: working · codex: waiting p3 · budget 1/6 · integration +2 · guarded ✓✓✓~✓ · parser
> _
```

The guarantee glyphs summarize `guarantees` per agent; `/status` expands them.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, guarantees per surface, reviewer, turns, held deliveries, permissions, workspaces, guarded refs, integration state, detected customization sources. |
| `/stop <agent\|all>` | Protocol interrupt, then bounded termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a relayed approval request. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2 |
| `/integrate <agent>` | §16.3 |
| `/sync <agent\|all>`, `/sync --abort <agent>`, `/import <src> <dst>` | §16.4 |
| `/apply [agent]`, `/apply --abort`, `/apply --commit` | §16.5 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and boundary diagnostics. |
| `/quit` | Stop turns, flush, release the lock. |

External: `chatroom log [--jsonl] [--verify]`, `doctor`, `clean`, `reset`, and the
agent-only `post`, `reply`, `ask`, `inbox`, `hook`.

---

## 19. Configuration

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Cross-agent activations after user input. |
| `turn.timeout_minutes` | `30` | Hard turn timeout. |
| `turn.stop_grace_seconds` | `5` | Grace between interrupt, SIGTERM and SIGKILL. |
| `ask.timeout_seconds` | `60` | Below the measured tool timeout. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.long_lived` | `true` | One process per session. |
| `driver.codex.prefer_app_server` | `true` | App-server before `exec`. |
| `driver.codex.approval_policy` | `on-request` | Required for Auto-review (G3). |
| `driver.codex.approvals_reviewer` | `auto_review` | `auto_review` or `user`. |
| `security.mode` | `guarded` | `guarded`, `strict` or `compatible` (G15). |
| `security.shell_network` | `false` | Network from sandboxed shell commands. |
| `security.network_domains` | empty | Domains allowed when shell network is enabled. |
| `security.secret_paths` | §15.2 defaults | Denied read paths, both harnesses. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_deny_patterns` | §8.1 defaults | Environment variables removed at spawn. |
| `security.env_allow` | empty | Names kept despite matching a deny pattern. |
| `security.harden_native_search` | `false` | Disable Grep and Glob for an enforced `searchReads`. |
| `security.mcp_allowlist` | empty | MCP servers and apps permitted in `guarded` and `strict`. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; §15.2. |
| `logging.raw_events` | `false` | Persist vendor raw streams. |
| `logging.retention_days` | `30` | Raw log and receipt retention. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |
| `workspace.state_dir` | platform default | Parent for per-project runtime roots. |
| `workspace.link_worktrees` | `true` | Proposed: the `.chatroom/worktrees` symlink. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn.

---

## 20. Activity, logs, and privacy

| Kind | Claude source | Codex source |
|---|---|---|
| `text` | `assistant` text blocks | `agent_message` items except the final one |
| `reasoning_summary` | `thinking` blocks, if present | `reasoning` items |
| `tool` | `tool_use` blocks | `command_execution`, `file_change`, `mcp_tool_call`, `web_search` |
| `tool_result` | `tool_result` blocks, bounded | `aggregated_output`, `exit_code`, bounded |
| `permission` | control requests | `requestApproval` methods and `autoApprovalReview` notifications |

Raw streams are off by default. Chatroom never records environment-variable values.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Session suspect; reconcile; resume and run a recovery turn; rebuild if that fails. |
| Crash after message commit, before scheduling | Rows remain queued. |
| Duplicate event or post retry | Original receipt returned. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, rejection event. |
| Steering or hook delivery races turn end | Return to queued; no second charge. |
| Driver exits nonzero | Preserve stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild as a new generation. |
| Write-boundary or login probe fails | `guarded` and `strict` refuse to start that agent. |
| Any other guarantee probes below `enforced` | `guarded` starts and shows the level; `strict` refuses. |
| Auto-review unavailable or unparsable | User review, visibly; or decisions recorded without rationale. |
| MCP server, app or hook source detected outside the allowlist | `guarded` and `strict` disable it; `compatible` warns. |
| Guarded ref moved | `ref_moved` event; integration blocked; restore command printed; ref never reset by Chatroom. |
| Budget exhausted | Trigger held; count shown. |
| Integrate or sync conflict | `git merge --abort` in that worktree; nothing else changes; paths reported. |
| Apply refused by git | Main unchanged; git's message shown verbatim. |
| Apply merge conflict | Conflict markers in main as git leaves them; `/apply --abort` restores. |
| Crash during apply | `needs_user` on startup with commit or abort as options. |
| Ref or ownership mismatch | Refuse the action; show expected and actual values. |
| Database corruption | Stop; preserve files; never rebuild authority from the mirror. |
| JSONL mirror inconsistent | Rewrite from SQLite. |
| Disk full | Stop accepting messages before acknowledging them. |

---

## 22. Verification ledger

### Measured on the development machine

- 2026-09-04, Codex 0.146.0 and 0.153.3, `workspace-write`: writes inside cwd succeed;
  outside fail; under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; environment
  variables reach commands under `codex sandbox`.
- `codex exec resume` has no `--cd` or `--sandbox` (0.153.3).
- App-server schema on 0.153.3: `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`, `review/start`, the three `requestApproval` methods, the
  `autoApprovalReview` notifications, `ApprovalsReviewer` enum, `GuardianApprovalReviewStatus`
  "[UNSTABLE]".
- Claude 2.1.261 flags as listed in §10.1.
- `node:sqlite` loads on Node 25.1.0 with an experimental warning.
- 2026-09-05, git 2.50.1, `git merge --no-commit --no-ff` into a dirty main: the six results
  of §16.5.

### Documented

- Claude sandboxing: Bash-only OS sandbox; default write scope; the linked-worktree shared
  `.git` allowance with `hooks/` and `config` denied; "re-allow specific paths within a
  denied region using `sandbox.filesystem.allowRead`. When read rules overlap, the more
  specific path wins"; protected paths that `allowWrite` cannot lift; `allowWrite` and
  `denyWrite` accept absolute and `~/` paths.
- Claude permissions: `Read(//path)` and `Edit(//path)` rules; a Read deny blocks Edit and
  Write; Grep and Glob best-effort; deny rules take precedence over allow.
- Claude hooks and headless: inline `--settings`; `PostToolUse` `additionalContext`;
  streaming input queues messages; `--strict-mcp-config`.
- Claude sessions: per-working-directory storage; `--continue` scoped to the directory.
- Claude Agent SDK: claude.ai login not permitted for SDK agents.
- Codex configuration: `shell_environment_policy.inherit` default `all`;
  `ignore_default_excludes` default true, "Keep variables containing KEY, SECRET, or
  TOKEN"; `filters`, `set`; `mcp_servers.<id>.enabled`, `apps.<id>.enabled`; profiles govern
  sandboxed commands, not MCP servers or apps.
- Codex permissions: `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; specific-over-broad, deny over write over read; Beta; exclusive with
  `sandbox_mode`; tokens `:minimal` and `:workspace_roots` documented, `:root` seen in source
  only.
- Codex Auto-review: `approvals_reviewer = "auto_review"`; requires interactive approvals.
- Codex app-server: experimental; per-thread `permissions` parameter experimental.

### Phase 0: verify before building the scheduler

1. `node:sqlite` durability suite on the oldest supported Node LTS.
2. Claude CLI: several sequential turns in one `-p` stream-json process; `--resume` later.
3. Claude hook from inline `--settings` fires in `-p` mode and `additionalContext` reaches
   the model; whether the chosen setting-source combination filters it.
4. Claude permission control request and response wire shapes.
5. `thinking` blocks in the Claude stream; whether `--verbose` is needed.
6. Claude boundary: shell writes succeed in worktree, drop, scratch and own git scope, fail
   in main, peer, `.chatroom` and guarded refs; native Edit denied on main and peer; native
   and shell reads of secret paths denied; a canary secret environment variable is absent
   from the tool shell; toolchains readable; a package install with an extra write root
   succeeds.
7. Claude git scoping: whether `denyWrite` entries narrow the automatic worktree allowance;
   otherwise the enumeration fallback and `gitRefs: best_effort`.
8. A Claude setting-source combination that drops user and project hooks and MCP servers
   while keeping `CLAUDE.md`; whether an empty list is accepted.
9. Claude login probe.
10. App-server: profile accepted through `config` overrides; root path token or `/`;
    `approvalsReviewer: auto_review` accepted and reported; routine command auto-approved;
    escalation reaches `requestApproval`; `turn/steer` against a finishing turn.
11. Codex boundary under the profile: same matrix as item 6 plus git scoping, through shell
    and file-change tools; a hard-denied path cannot become a prompt.
12. Codex external tools: MCP servers and apps disabled by their keys; the browser-tool
    disable key; `codex mcp list` or equivalent to enumerate configured servers.
13. Codex `exec` fallback: profile and environment policy via `-c` on start and resume.
14. What each harness records after a kill mid-generation; resume stays `recovering` until
    the recovery turn completes.
15. Effective tool-command timeouts of both harnesses.
16. Native merge behaviour under the Claude sandbox in the main worktree is not exercised
    by Chatroom, since `/apply` runs in the orchestrator's own process; confirm that the
    orchestrator is never itself launched inside a sandboxed shell.

---

## 23. Verification and testing strategy

- **Model-free core tests** with fake drivers: the invariants of §2 under crash injection at
  every boundary.
- **IPC security tests**: partial, duplicate, hard-linked, symlinked, directory, FIFO,
  sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn cases.
- **Boundary matrix**: every `guarantees` entry on both harnesses, positive and negative,
  through shell and native tools; environment canary; MCP absence; guarded-ref moves
  detected.
- **Git matrix**: file kinds; agent commits plus uncommitted changes; snapshots and
  integrations in sequence; both agents on the same and different files; main advancing
  before `/sync` and before `/apply`; the six `/apply` states of §16.5; repeated apply after
  commit; `/apply --abort` restoring byte-identical main; conflict states in agent
  worktrees; crash at every intent boundary with §16.7 reconciliation.
- **Mirror tests**: partial lines, malformed JSON, missing or duplicate records, rewrite.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 24. Implementation approach

TypeScript on the Phase-0-verified Node LTS range; `node:sqlite` if it passes.

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, probes.ts, env.ts
  security/   profiles.ts, boundaries.ts, git-scope.ts, customization.ts
  workspace/  repository.ts, snapshot.ts, merge.ts, refwatch.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, activity.ts
  test-support/ fake-driver.ts, crash-injector.ts, scratch-repo.ts
```

The agent-command entry path imports neither the REPL, the drivers, the workspace manager,
nor a writable database connection.

---

## 25. Build order

**First usable release: phases 0 to 5.**

0. **Vendor and runtime spikes.** Disposable probes for every item in §22, later folded
   into `doctor --smoke`. Exit: every first-release driver claim has a recorded fixture and
   every hard denial has a negative test. An unverified claim is removed or its guarantee is
   declared `unavailable`.
1. **Durable room core.** Schema, migrations, mirror; target resolution; delivery records
   and budget; startup reconciliation; fake drivers and property tests. Exit: crash
   injection cannot lose or duplicate logical messages.
2. **IPC and agent commands.** Layout, import, receipts, retry, limits, quarantine; the five
   agent commands; security suite. Exit: every accepted operation has one durable result and
   no orchestrator path can be redirected by an agent-controlled entry.
3. **Drivers, read-only.** Claude CLI in auto mode with hook delivery; Codex app-server with
   Auto-review and steering; `exec` fallback; scrubbed environments; minimal recovery. Exit:
   both agents chat concurrently and receive a mid-turn message.
4. **Guarded work.** Runtime roots; Claude sandbox and deny rules; Codex profile with legacy
   fallback; git write scope and ref watch; probes for every guarantee; approval relay;
   interruption; modes. Exit: each agent edits, commits and tests in its own worktree, reads
   main, peer and toolchains, cannot read secrets or the canary variable, cannot write main,
   peer, IPC, the database or any guarded ref, and `/status` shows the levels truthfully.
5. **Git collaboration.** Snapshots, `/integrate`, `/sync`, `/import`, `/apply` with
   `--abort`, intent recovery, the Git matrix. Exit: the six `/apply` states behave as
   measured and every abort leaves main byte-identical.
6. **Later.** Conflict-resolution turns; checkpoints; archive and delete; retention and
   `gc`; `/review` via `review/start`; `/apply --commit`; rendering polish.

> **Guard G20.** Keep the cut line. Source review, checkpoints, archive and `gc` are not
> first-release work.

---

## 26. Open decisions

1. **Claude setting sources in guarded mode.** Which combination drops hooks and MCP while
   keeping `CLAUDE.md`; whether project settings' permission rules should load.
2. **`/apply --commit`** and its message format (proposed).
3. **Raw activity defaults.** Off, with a temporary on-with-cap during adapter development.
4. **Conflict resolution.** A `/resolve` agent turn versus manual resolution.
5. **Inactive worktree policy** (later phase).
6. **Fallback support floor.** Whether environments without app-server are `guarded` with
   several guarantees `unavailable`, or `compatible` only.
7. **Convenience symlink** (§4.3), proposed.
8. **`/tmp` under the Codex profile.** Left open for tools that hard-code it.
9. **Grep and Glob hardening default.** Off in `guarded`; revisit after usage shows how much
   the agents rely on them.

---

## 27. References

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Agent SDK streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex permission profiles: https://learn.chatgpt.com/docs/permissions
- Codex Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex hooks: https://learn.chatgpt.com/docs/hooks

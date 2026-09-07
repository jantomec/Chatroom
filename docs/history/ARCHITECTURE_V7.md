# Chatroom Architecture v7

Status: implementation baseline, 2026-09-05. Standalone; supersedes `ARCHITECTURE.md` (v1)
and `ARCHITECTURE_V2.md` through `ARCHITECTURE_V6.md`. No code exists yet. Implementation
starts with Phase 0 (§25), whose purpose is to answer the items in §22 before any scheduler
code is written.

Observed on the development machine: Claude Code 2.1.261, Codex CLI 0.153.3, Node 25.1.0,
git 2.54.0 (Homebrew) and 2.50.1 (Apple), both on `PATH`. Versions are evidence for the
smoke tests, not compatibility promises.

How to read this document:

- **Comment** blocks explain why a decision stands or what changed from an earlier revision.
- **Guard** blocks mark decisions that a later revision must not reverse without the user's
  explicit approval. Each cites its evidence: a user decision, a measurement on this machine,
  or a quoted documentation sentence. A revision that believes a guarded decision is wrong
  must say so in its change list and quote the guard, rather than redesigning around it.
  Section 0.1 indexes all guards.
- **Proposed** marks items the user has not explicitly decided; they can be dropped.

---

## 0. Changes from v6

All from the Codex review of v6, each verified before adoption.

1. **The shared `.git` is read-only for agents; commits go through a broker.** v6 allowed
   writes to `objects/**` on the argument that content-addressed objects are safe to add.
   Write permission on a directory also permits unlinking and truncating packfiles and
   rewriting `objects/info/alternates`, which no ref watch would notice. v7 grants agents no
   write access anywhere under the common git directory. `chatroom commit "<message>"` asks
   the orchestrator to snapshot the worktree onto the agent's branch, using the snapshot
   mechanism that already exists. Clones remain rejected; a private object store reached
   through alternates was considered and rejected because objects private to an agent are
   dangling from the main repository's view until imported, and `git gc --auto` triggered
   by the user's own commit would fail on them.
2. **Ref ownership replaces the ref watch.** v6 flagged any movement of any guarded ref as
   tampering, which an ordinary agent commit would have triggered. With the broker, every
   Chatroom ref moves only through the orchestrator, so any other movement is tampering by
   definition, and `main` is externally mutable and tracked only for adoption by `/sync`.
3. **Network and hosted tools are pinned per surface.** Claude's sandboxing docs: without
   `strictAllowlist`, a command needing a new domain "prompts for approval, or in auto mode
   sends the request to the classifier", and `strictAllowlist` "enforces this for sandboxed
   commands only; in-process tools such as `WebFetch` still follow their permission rules."
   Codex's configuration reference has `web_search = "disabled"` and `agents.enabled`.
   v7 sets all of them and splits the single external-tools guarantee into five.
4. **Git operations are recorded per step with oids.** v6's recovery aborted every
   interrupted integrate or sync, which is wrong when the merge had already completed.
   Each step records its target ref, expected old oid, source oid and result oid, and
   recovery classifies by comparing refs.
5. **A pre-apply backup ref and `--no-autostash`.** The git-merge man page: `--abort` "will
   in some cases be unable to reconstruct the original (pre-merge) changes." v7 snapshots
   main's tracked dirty files into a backup ref before `/apply` and restores from it after
   an abort when git's abort left a difference. Measured: with `merge.autoStash` inherited
   and no `--no-autostash`, an overlapping edit that must be refused is instead stashed and
   overwritten.
6. **The orchestrator's git invocation is pinned.** Measured: a `pre-merge-commit` hook runs
   on a plain `git merge` and does not run with `core.hooksPath` pointed at an empty
   directory plus `--no-verify`. The binary is resolved once at startup and recorded,
   because this machine has two.
7. **Guards G9, G13 and G21 rewritten; G25 to G28 added.**

Kept from v6 without change of substance: CLI-on-subscription Claude in auto mode, Codex on
app-server with Auto-review, `PostToolUse` delivery, SQLite authority with mirror, delivery
records, idempotent operations, split-ownership IPC, capability probing, per-conversation
worktrees outside the main tree, snapshots, integration branch, suspect-session recovery,
Phase 0, the autonomy budget, the read denylist, native Claude file tools, environment
scrubbing, the three modes, authority in the main worktree, and native merges.

### 0.1 Regression guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; SDK docs: "Anthropic does not allow third party developers to offer claude.ai login … including agents built on the Claude Agent SDK." |
| G2 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G3 | Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, falling back to the user visibly. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G4 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: streaming input "queued messages … process sequentially"; hook `additionalContext` "appended to the tool result". |
| G5 | Claude's native Read, Grep, Glob, Edit and Write stay enabled; the boundary is path deny rules. Grep and Glob are labelled best-effort. | Claude permissions docs: `Read(//path)` and `Edit(//path)` rules; "A Read deny rule also blocks the Edit and Write tools on the same path"; Grep and Glob "best-effort". |
| G6 | Reads are denylisted, not allowlisted; toolchains stay readable; caches writable via config. | Claude docs: "the deny holds inside a wider allow"; Codex docs: "deny takes precedence over write, and write takes precedence over read." |
| G7 | Worktrees and IPC live outside the main tree, because Claude permission rules are deny-wins and a main-tree Edit deny would cover a nested worktree. | Claude permissions docs; sandboxing docs: "the narrower allow re-opens that part of the denied region." |
| G8 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G9 | No commit norms. Agents checkpoint their worktree onto their own branch with `chatroom commit` whenever they want. Native git write commands are unavailable to agents. | User decision on norms; change 1 for the mechanism. |
| G10 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G11 | When both agents answer at once, both replies are recorded. | User decision. |
| G12 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G13 | `/apply` and `/sync` are native `git merge` operations with the pinned invocation of §16.0, a pre-apply backup ref, and per-step intent rows. No synthetic commit, no applied-oid marker, no per-path journal. | Measured merge behaviour, §16.5 and §22. |
| G14 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency; correlation invariant kept. |
| G15 | Three modes: `guarded` (default), `strict` (fail closed), `compatible`. No mode claims a guarantee it does not enforce. | Codex review of v5. |
| G16 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex sandbox denies Unix-socket connections. |
| G17 | Zero footprint in tracked files, CLAUDE.md, AGENTS.md, `.claude/`, `.codex/`, `.gitignore`. | User decision. |
| G18 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | Both harnesses persist turns incrementally. |
| G19 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry, §7.1. |
| G20 | First-release cut line: Phase 0, phases 1 to 5. Source review, checkpoints, archive and `gc` come later. | Scope control. |
| G21 | The shared git directory is read-only for agents. No clones, no scoped object-store writes, no private object stores. Chatroom refs move only through the orchestrator. | Change 1; user decision against clones. |
| G22 | The child environment is scrubbed of secret-like variables for both drivers; Codex's default exclusions are switched on. | Codex config reference: `ignore_default_excludes` "default: true". |
| G23 | `.chatroom/` lives in the main worktree resolved from the common git directory; the lock lives in the runtime root. | `git rev-parse --show-toplevel` differs per linked worktree. |
| G24 | MCP servers, apps, browser tools, native web tools and Codex nested agents are disabled in `guarded` and `strict` unless allowlisted. | Codex config reference: profiles govern sandboxed commands only; Claude docs on `strictAllowlist` scope. |
| G25 | Shell network on Claude uses `strictAllowlist: true`; `WebFetch` and `WebSearch` are denied by rule; Codex `web_search = "disabled"`. | Claude sandboxing docs quoted in change 3; Codex config reference. |
| G26 | The git binary is resolved once at startup, recorded with its version, and used by path for every command. | Two binaries on this machine, 2.50.1 and 2.54.0. |
| G27 | Every git step has an intent row with target ref, expected old oid, source oid and result oid; recovery classifies by comparing refs, never by assuming an abort is possible. | Codex review of v6, finding 4. |
| G28 | `/apply` snapshots main's tracked dirty files into a backup ref first; `--abort` restores from it; every merge passes `--no-autostash`. | git-merge man page; measured autostash behaviour. |

---

## 1. Purpose

Chatroom is a terminal group chat with three participants:

- the user;
- Claude, through the Claude Code CLI in auto mode;
- Codex, through the Codex App Server with Auto-review, with the Codex CLI as fallback.

All participants see every message. Addressing says who is expected to act; it does not
make a message private. Claude and Codex work concurrently, coordinate while working, and
inspect one another's work and the user's main tree. Each agent writes only to its own Git
worktree and checkpoints it through the orchestrator.

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
    that edits the user's main worktree, through `git merge`.
11. **Safety settings are pinned and probed** through shell and native tools.
12. **Adapters are capability-based.**
13. **Zero footprint.** (G17)
14. **Subscription-preserving.** (G1)
15. **Reviewers are not boundaries.** Human approval and Auto-review decide only within
    independently enforced path, ref, environment and network rules.
16. **Secrets denied, tools open.** (G6)
17. **Native tools stay native.** (G5)
18. **No mode claims what it does not enforce.** (G15)
19. **Shared repository state is written only by the orchestrator.** (G21)
20. **Every git mutation is an intent with oids before it is a command.** (G27)

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
 │  (node:sqlite, WAL   (files + receipts)   (snapshot / commit broker /        │
 │   + JSONL mirror)                          integrate / sync / apply;         │
 │                                            pinned git; per-step intents)     │
 │        ▲                 ▲                   ▲                               │
 │  ┌─────┴────────────┐    │          ┌────────┴────────┐                      │
 │  │ Claude driver    │    │          │ Codex driver    │                      │
 │  │ claude -p, auto  │    │          │ codex app-server│                      │
 │  │ stream-json i/o  │    │          │ JSON-RPC stdio  │   auto-review        │
 │  └─────┬────────────┘    │          └────────┬────────┘                      │
 └────────┼─────────────────┼───────────────────┼───────────────────────────────┘
          │ stdin turns +   │ agent-side files  │ turn/start, turn/steer
          │ PostToolUse hook│ (post, commit, …) │
          ▼                 ▼                   ▼
   Claude worktree     from-agent/to-agent   Codex worktree
   (.git read-only)                          (.git read-only)
```

| Component | Responsibility |
|---|---|
| REPL | User input, transcript rendering, activity streams, permission decisions, commands. |
| Orchestrator | The single state machine and database writer. Resolves targets, schedules work, reserves autonomy credits, coordinates recovery. |
| Store | Schema, migrations, transactions, queries, JSONL mirror. |
| IPC dispatcher | Imports agent operations, including commit requests; writes receipts and deliveries; enforces idempotency and limits. |
| Driver | Starts or resumes one vendor session with a scrubbed environment and pinned boundary, submits turns, delivers mid-turn messages, normalizes events, relays approvals. |
| Workspace manager | The only writer of Chatroom refs and of the main worktree. Snapshots, brokered commits, merges, per-step intents, recovery. |
| Agent-side command | `post`, `reply`, `ask`, `inbox`, `hook`, `commit`; uses only paths supplied in its environment. |

---

## 4. Project identity, locking, and disk layout

### 4.1 Project identity and the main worktree

Chatroom resolves `git rev-parse --path-format=absolute --git-common-dir`, hashes it into
`project_id`, and resolves the **main worktree** as the entry of `git worktree list` whose
git directory is the common directory. Bare repositories are refused. All per-project
authority is placed in that main worktree, whichever checkout `chatroom` was started from.
Chatroom refuses to start from one of its own managed worktrees.

The project lock is an advisory OS lock on an open file descriptor at
`<runtime root>/lock`, unique by construction. PID and start time are diagnostic fields.

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
  hooks-empty/                             empty directory used as core.hooksPath (§16.0)
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
to the canonical common directory before reuse.

> **Guard G7.** Worktrees stay outside the main tree. Claude permission rules are deny-wins,
> so the `Edit(//<main>/**)` deny in §15.2 would cover a nested worktree. The OS sandbox is
> not the reason: both vendors document that a narrower entry re-opens a denied region.

---

## 5. Durable storage

### 5.1 Engine and settings

The store uses `node:sqlite`, present on the development machine's Node with an
experimental-feature warning. Phase 0 runs the durability suite on the oldest supported
Node LTS. One write connection; read-only diagnostics may open a read-only connection.

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

```sql
projects(id PK, main_worktree, git_common_dir, runtime_root, git_binary, git_version,
  created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                                  -- active | archived | deleting
  autonomy_limit, autonomy_used)

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)
                                           -- kind: message | event

messages(entry_id PK FK, author, via, body, turn_id, operation_id,
  reply_to FK, causal_root FK, UNIQUE(author, operation_id))
                                           -- via: repl | post | reply | final | recovery

message_targets(message_id FK, participant, expects_action, PK(message_id, participant))

events(entry_id PK FK, type, agent, turn_id, payload_json)

agent_sessions(conversation_id FK, agent, vendor_session_id, generation,
  status,                                  -- absent | healthy | suspect | recovering | lost
  last_confirmed_entry_id, capabilities_json, PK(conversation_id, agent))

turns(id PK, conversation_id FK, agent, attempt, status, vendor_turn_id,
  session_generation, started_at, ended_at, final_message_id, error_json, cost_json)
                                           -- status: preparing | running | ending | ended | failed | interrupted

turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
                                           -- transport: start | steer | hook | boundary

deliveries(id PK, conversation_id FK, agent, message_id FK,
  status,                                  -- queued | held | publishing | accepted | superseded
  transport, attempt, autonomy_charged, accepted_at, UNIQUE(agent, message_id))

agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))                 -- type: post | reply | delivery_ack | commit

permissions(id PK, turn_id FK, agent, vendor_request_id, status, reviewer, summary,
  request_json, decision_json, rationale, created_at, resolved_at)
                                           -- reviewer: user | auto_review | claude_auto | managed | none

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, admin_dir,
  expected_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))
                                           -- owner: claude | codex | integration
                                           -- expected_oid: what the orchestrator last wrote

main_observations(conversation_id FK, observed_oid, observed_at, adopted_by_operation_id)

git_operations(id PK, conversation_id FK, type, status, requested_by, created_at, finished_at,
  details_json)                            -- type: snapshot | commit | integrate | sync | apply | apply_abort
                                           -- status: planned | executing | done | needs_user | failed

git_steps(id PK, operation_id FK, ordinal, kind, target_ref, expected_old_oid, source_oid,
  result_oid, status, message)             -- kind: snapshot | merge | backup | restore | abort | ref_update
                                           -- status: planned | executing | done | needs_user | failed
```

> **Comment.** `guarded_refs` from v6 is replaced by `workspaces.expected_oid` for
> orchestrator-owned refs and `main_observations` for the externally mutable `main`.
> `git_steps` is new (G27). `projects.git_binary` and `git_version` are new (G26).

### 5.4 Transaction boundaries

One transaction each: append a message with targets, delivery rows and credit reservation;
create a turn with its input set; accept a delivery; append a final reply and end its turn;
import an agent operation and its receipt result; record a permission decision; plan a git
operation with all its steps; mark a git step `executing`; record a git step's result.
Crossings into child processes, filesystem renames and Git use an intent record followed
by reconciliation.

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
rows, never reconstructed from text later, and always shown in the REPL and the delivery
header.

> **Guard G10.** `@handle` is the one convention. Do not instruct agents to prefer `--to`;
> do not remove mention parsing from agent messages.

### 6.2 Visibility and delivery rows

Every message is visible in the user's transcript immediately after commit. A delivery row
is created for each agent other than the author, target or not. A non-target delivery waits
until that agent next receives a triggering message, which preserves "everyone sees
everything" without waking an agent for status chatter.

### 6.3 Operation and causal identifiers

Agent-side commands generate a random UUID `operation_id` before writing anything; a retry
reuses it; `(agent, operation_id)` is unique. Messages may carry `reply_to`, `causal_root`
and `turn_id`. `chatroom reply <id> <body>` sets `reply_to` and targets that message's
author unless `--to` overrides. A turn's final reply is linked to its newest triggering
input unless the agent already posted an explicit reply.

### 6.4 Limits

Defaults, configurable within hard caps: body 64 KiB; operation file 96 KiB; posts per turn
100; unprocessed operation files per turn 256; delivery batch 64 messages and a
driver-specific token budget; receipt retention seven days.

---

## 7. Autonomy budget and scheduling

### 7.1 Meaning of the budget

The budget limits how many agent-authored messages may activate the other agent after the
most recent user message. It is a credit counter.

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery is `held`; the message stays visible to the user.
- Messages to the user cost nothing. One message costs at most one credit.

Held deliveries are released, and charged once, when the user addresses the held recipient
or everyone, in which case they join that batch free, or when the user raises `/budget`,
in which case they are released in entry order while credit lasts. A user message that
addresses only one agent does not release the other agent's held deliveries.

> **Guard G19.** The asymmetry is intentional: "held" means the other agent tried to activate
> a recipient while the room was out of credit, and only the user re-opening that recipient or
> a deliberate budget change ends it.

### 7.2 Scheduler states

Per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. At most one turn is active per agent and conversation; the two
agents run concurrently.

> **Guard G12 and G11.** No turn-taking; no discarded replies.

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

Native acceptance means the vendor process accepted the input, not that the model acted on
it. Hook acceptance means the hook ran and acknowledged.

### 7.4 Fairness and backpressure

Both agents start in the same event-loop tick when both have eligible work. Messages
coalesce into bounded batches. Every post gets a receipt even when its target is held.

---

## 8. File IPC protocol

File IPC carries everything that originates inside an agent's tool shell, and deliveries
for the hook transport.

> **Guard G16.** Files, never sockets. Measured: a Unix-socket connection from inside the
> Codex sandbox fails with "Operation not permitted", while a file write under
> `writable_roots` succeeds.

### 8.1 Per-turn environment

The driver builds the child environment from scratch:

1. Start from the user's environment.
2. Remove every variable whose name matches `security.env_deny_patterns`, default
   `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `AWS_*`,
   `GOOGLE_APPLICATION_CREDENTIALS`, `GH_*`, `GITHUB_*`, `NPM_CONFIG_*AUTH*`, `OPENAI_*`,
   `ANTHROPIC_*`. Names on `security.env_allow` are kept regardless.
3. Add:

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
| `GIT_OPTIONAL_LOCKS` | `0`, so read-only git commands do not try to refresh the index |

The Codex driver additionally sets `shell_environment_policy.ignore_default_excludes =
false` and `shell_environment_policy.filters` with the same patterns, so Codex's own layer
enforces the scrub even if the driver's is bypassed. Nothing else in the agent's git
environment is altered; the user's global git configuration, identity and excludes apply
inside the worktree.

The turn's random directory nonce is part of the path rather than trusted from a payload.
Identity is assigned from the driver and the fixed drop root, never from a field in a file.

> **Guard G22.** Both drivers spawn with a scrubbed environment. Codex's config reference:
> `ignore_default_excludes` "Keep variables containing KEY, SECRET, or TOKEN before other
> filters run (default: true)". Do not rely on the vendor default.

### 8.2 Writing an operation

`post`, `reply`, `delivery_ack` and `commit` use one envelope:

```json
{
  "protocol": 3,
  "operation_id": "f7515aa7-ff20-4b9e-807d-12f66157b282",
  "type": "post",
  "created_at": "2026-09-05T10:07:40Z",
  "payload": {"to": ["codex"], "body": "@codex Parser interface is ready.", "reply_to": null}
}
```

The command writes a unique temporary regular file in `CHATROOM_OPERATION_DIR`, fsyncs it,
and renames it to `<operation-id>.json`. Filesystem notifications are latency hints; a
poller is authoritative. The dispatcher renames each entry into `staging/`, checks with
no-follow semantics that it is one bounded regular file, validates protocol, id, turn,
type, targets and UTF-8, imports it transactionally or returns the previous result for a
duplicate id, and writes a receipt under `to-agent/receipts/` by temp-file-and-rename.

### 8.3 Receipts

```json
{"protocol": 3, "operation_id": "f7515aa7-…", "status": "accepted", "message_id": 42}
```

`chatroom post` waits briefly for the receipt and prints `#42`. A local timeout means
"acceptance unknown"; a retry with the same id returns the same result. Before a turn is
finalized, the orchestrator closes the drop root to new imports, drains published files,
waits a short grace period, then retires the directory.

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

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`, for an answer. A message
whose `reply_to` is the question id resolves it durably (`answered`). The first message
from one of the asked parties that targets the asker after the question is returned
immediately as `probable`, with the note that the correlation is inferred; the question
stays open and a later explicit reply still resolves it. On timeout with no candidate,
`indeterminate`. The timeout is kept below the measured tool-command timeout of each driver.

> **Guard G14.** Return early on the first probable candidate; never let it mark the
> question resolved.

### 8.6 `chatroom commit`

```sh
"$CHATROOM_BIN" commit "Parser skeleton and tests"
```

Writes a `commit` operation with the message. The dispatcher imports it and the workspace
manager runs a snapshot (§16.2) of the agent's worktree onto the agent's branch with that
message, serialized with every other git operation. The receipt carries the new oid, or a
failure such as "nothing to commit". The agent may run it at any point in a turn. Because
the agent may be mid-edit, the snapshot is a checkpoint of whatever is on disk at that
moment, which the brief says.

Native `git commit`, `git add`, `git stash`, `git checkout <other branch>`, `git branch` and
`git reset` fail for agents because the shared git directory and the worktree's admin
directory are not writable (§15.7). `git log`, `git diff`, `git show`, `git status` and
`git blame` work.

> **Guard G9 and G21.** Checkpoints through the broker; no native git writes. Do not
> re-open any part of the shared git directory for writing, and do not add commit norms.

---

## 9. Driver contract

```ts
type GuaranteeLevel = "enforced" | "best_effort" | "unavailable";

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
  structuredEvents: boolean;
  maxDeliveryBytes?: number;
  guarantees: {
    shellWrites: GuaranteeLevel;     // own worktree, drop, scratch, extra roots only
    nativeWrites: GuaranteeLevel;    // Edit/Write denied on main, peer, IPC, git dir
    gitWrites: GuaranteeLevel;       // shared git directory and admin dirs unwritable
    shellReads: GuaranteeLevel;      // secret paths denied
    nativeReads: GuaranteeLevel;     // Read denied on secret paths
    searchReads: GuaranteeLevel;     // Grep/Glob best_effort unless disabled
    environment: GuaranteeLevel;     // scrubbed
    shellNetwork: GuaranteeLevel;    // strict allowlist for sandboxed commands
    nativeWeb: GuaranteeLevel;       // WebFetch/WebSearch, web_search
    browser: GuaranteeLevel;
    mcpApps: GuaranteeLevel;
    subagents: GuaranteeLevel;       // Codex nested agents disabled; Claude subagents share the boundary
  };
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

`chatroom doctor` fills every `guarantees` entry by attempting the forbidden thing through
both shell and native tools: writes to main, peer, IPC, `.chatroom/`, the common git
directory and the own admin directory; a read of a canary secret file and of a canary
secret variable; a fetch of a non-allowlisted host from a sandboxed command and from the
native web tool; listing loaded MCP servers, apps, hook sources and nested-agent tools; and,
as positives, a `chatroom commit` that lands on the own branch, `git log` inside the
worktree, and a package install with an extra write root. It also verifies Claude's login
and Codex's effective reviewer, and records the git binary and version. Only probe results
enable capabilities; results are cached with executable hash, version, platform and config
fingerprint.

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
true; resume happens once per chatroom run; if the process dies, the driver reconnects with
`--resume` and reports `session: suspect`. `nativeSteering` false; `hookDelivery` true.
Reply text and cost come from `result`; activity from `assistant` events (`text`,
`tool_use`, `thinking` if present). The system prompt and settings are not persisted with
the session and are passed on every process start.

> **Guard G1.** CLI, never the Agent SDK. The SDK overview: "Anthropic does not allow third
> party developers to offer claude.ai login or rate limits for their products, including
> agents built on the Claude Agent SDK." Everything the SDK offers is a wrapper around these
> flags.

### 10.2 Mid-turn delivery: PostToolUse hook

```json
{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` reads the hook event JSON on stdin, drains `CHATROOM_DELIVERY_DIR`, writes a
`delivery_ack`, and if anything was pending prints
`{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<delivery text>"}}`.
Hooks run as ordinary child processes of Claude Code, outside the Bash sandbox, with the
driver's environment. An agent generating text without tool calls hears nothing until its
next tool call or the end of its turn, in which case the batch returns to `queued`.

> **Guard G4.** The streaming-input docs describe "queued messages: send multiple messages
> that process sequentially". Streaming is a queue; the hook is the injection channel.

### 10.3 Auto mode and approvals

`--permission-mode auto`: Claude Code's classifier decides routine actions; the rest arrive
as control requests on stdout, are recorded with `reviewer: user`, shown in the REPL with a
short id, and answered on stdin. Hard denials (§15.2) apply before any prompt.

> **Guard G2.** `auto` with host-relayed prompts. Not `bypassPermissions`, `acceptEdits`,
> `dontAsk`, or prompts routed to `none`.

### 10.4 Fallback

One process per turn with the same flags if the long-lived process fails Phase 0.

---

## 11. Codex driver

### 11.1 Transport

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the permission profile (§15.3), the environment policy (§8.1),
`web_search = "disabled"`, `agents.enabled = false`, and per-id disables for MCP servers,
apps and browser origins (§15.5). `turn/start`; `turn/steer` with `expectedTurnId`;
`turn/interrupt`. Streamed items to driver events: `reasoning` for summaries,
`agent_message` for interim text, `command_execution` and `file_change` for tool activity.
Approval requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`
and `item/permissions/requestApproval` reach the REPL when Auto-review escalates or is
unavailable. `item/autoApprovalReview/started` and `/completed` are recorded as evidence
when they parse. All names confirmed in the schema generated by
`codex app-server generate-json-schema` on 0.153.3.

Authentication is the user's existing Codex login, shared by the CLI, app-server and
desktop app.

### 11.2 Auto-review

The closest equivalent to Claude's auto mode. Docs: "Auto-review only applies when
approvals are interactive"; with `never` "there is nothing to review". The reviewer is set
per thread and per turn; decisions are recorded with rationale when observable and as
`rationale: unavailable` otherwise; escalations and unavailability fall back to the user
visibly.

> **Guard G3.** `auto_review` with `on-request`, user fallback. Do not set `never`, and do
> not make the unstable notifications a precondition. The schema marks
> `GuardianApprovalReviewStatus` "[UNSTABLE]"; the config key and thread parameter are the
> stable part.

### 11.3 Fallback: `codex exec`

```text
codex exec --json -o <file> -c 'default_permissions="chatroom-<nonce>"' -c 'permissions.…' \
  -c 'approval_policy="never"' -c 'shell_environment_policy.…' -c 'web_search="disabled"' \
  -c 'agents.enabled=false' [-c 'mcp_servers.<id>.enabled=false' …] \
  [-c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust] -
codex exec resume <thread-id> --json -o <file> -c … -
```

No `--sandbox`: the docs say `sandbox_mode` and `default_permissions` cannot both be set.
No Auto-review, human approval or steering on this path. If the profile cannot load, the
driver uses legacy `workspace-write` with `writable_roots` and reports `shellReads`,
`nativeReads` and `gitWrites` as `unavailable` or `best_effort`. Hook delivery only when
Chatroom's hook is the sole non-managed hook source, because the trust bypass runs every
enabled hook from every layer.

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

Agent-side posts and commit requests are imported independently of model output. Eligible
messages for a running agent are steered or hook-delivered per capability. Approval
requests stop only the requesting operation; a human decision is durable before the driver
receives it; an Auto-review decision is recorded when its evidence arrives. `/stop`
requests protocol interruption, then SIGTERM, then SIGKILL after grace periods.

### 12.3 Ending a turn

1. Receive the terminal event and final reply.
2. Close the drop root and drain published operations.
3. In one transaction: append the non-empty final reply with idempotency key
   `final:<turn-id>` and `via: final`, or append `silent` when the reply is empty or
   exactly `[silent]`; store cost; mark the turn ended.
4. Write pending receipts, return unacknowledged hook deliveries to `queued`, retire
   per-turn directories, verify every orchestrator-owned ref against `expected_oid`
   (§15.7), run the scheduler.

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
Recovery: snapshot the worktree; record the interrupted turn and accepted ids; inspect
vendor turn state where available; resume by explicit id and verify identity and
directory, which moves the session to `recovering`; send a recovery note as the first
input, with no queued room work attached; mark `healthy` only after that turn reaches a
valid terminal event; otherwise `lost` and rebuild.

> **Guard G18.** Resume before rebuild; the recovery turn is the health check.

### 13.3 Lost session rebuild

New generation; bounded prompt from brief, transcript tail, referenced messages and
workspace state; new id stored after acknowledgment; `session_rebuilt` event. If the tail
does not fit, ask the user to split the conversation.

### 13.4 Startup reconciliation

Mark turns left `preparing` or `running` as interrupted; verify the runtime root; reconcile
staged IPC by id; recreate missing delivery or receipt files; quarantine orphans; classify
every `planned` or `executing` git operation step by step (§16.7); verify owned refs and
observe `main`; validate the mirror; reconnect sessions last.

---

## 14. What agents receive

### 14.1 Delivery format

Used for turn inputs, steering, hook injection and `chatroom inbox`.

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

Changed paths are advisory. The header repeats on every delivery so the rules survive
vendor compaction. Records are readable text, not JSON; targets remain metadata rows.

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
- "$CHATROOM_BIN" commit "<message>" records a checkpoint of your worktree on your branch,
  whenever you want one; it captures whatever is on disk at that moment. Native git write
  commands (add, commit, stash, checkout, branch, reset) are unavailable; git log, diff,
  show and status work. Chatroom owns integration and all refs.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`brief.extra` from configuration is appended with a visible label, size-capped, never
interpolated into shell code.

> **Guard G8 and G9.** Main and peer readable; own worktree writable; checkpoints through
> the broker; no commit norms. Do not replace main-tree reads with object-id inspection.

---

## 15. Sandboxing, approvals, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, any write to shared repository state, reads of known secret locations and
secret-bearing environment variables, undeclared network egress, hosted tools that bypass
the sandbox, malformed IPC, duplicate operations, and common path and symlink attacks. It
assumes anything a model tool can read may reach that model's provider. It does not isolate
a malicious local process and does not vet the repository's own build tooling.

### 15.2 Claude

The OS sandbox covers Bash commands only; default write scope is the working directory,
added directories and the session temp directory, plus, for a linked worktree, the shared
`.git` directory except `hooks/` and `config`. Native tools are governed by permission
rules.

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyWrite": ["<git common dir>"],
      "denyRead":  ["<security.secret_paths…>", "<main>/.chatroom",
                    "<ipc root>/*/staging", "<ipc root>/<peer>"]
    },
    "network": {"strictAllowlist": true, "allowUnixSockets": [],
                "allowedDomains": ["<security.network_domains…>"]}
  },
  "permissions": {
    "deny": [
      "WebFetch", "WebSearch",
      "Read(//<secret path>/**)", "…", "Read(//<main>/.chatroom/**)",
      "Edit(//<main>/**)", "Write(//<main>/**)",
      "Edit(//<peer worktree>/**)", "Write(//<peer worktree>/**)",
      "Edit(//<ipc root>/**)", "Write(//<ipc root>/**)",
      "Edit(//<git common dir>/**)", "Write(//<git common dir>/**)"
    ]
  }
}
```

- **Shell writes** are bounded by the default scope plus `allowWrite`. `denyWrite` on the
  common git directory is meant to revoke the automatic worktree allowance; whether it does
  is a Phase 0 item. If it does not, `gitWrites` is `best_effort`, enforced only by the
  post-turn ref check, and `/status` says so.
- **Shell reads** are open except the denylist. The harness homes `~/.claude` and `~/.codex`
  are in the default secret list, so an agent's shell cannot read other sessions'
  transcripts or the vendor credentials.
- **Network.** `strictAllowlist: true` makes sandboxed commands fail on any non-allowlisted
  host instead of prompting the classifier. The deny rules on `WebFetch` and `WebSearch`
  close the in-process path the sandbox does not cover.
- **Native tool writes** are denied for the main tree, peer worktree, IPC root and git
  directory. The worktree is not beneath any of them (G7).
- **Native tool reads** of secrets and `.chatroom/` are denied; a Read deny also blocks Edit
  and Write on the same path. Grep and Glob honour Read denies best-effort; with
  `security.harden_native_search` they are disabled and the agent searches with `rg` inside
  the sandbox.
- **Subagents.** Claude's own subagents run inside the same process under the same rules
  and sandbox, so the `Agent` tool stays enabled and `subagents` is `enforced` by
  inheritance, to be confirmed by probe.
- **`autoAllowBashIfSandboxed`** lets commands inside the boundary run without prompts,
  which is what unattended auto mode needs. It does not permit unsandboxed fallback.

Default `security.secret_paths`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
`~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`, `~/.codex`,
`~/.config/chatroom`.

> **Guard G5, G6 and G25.** Native tools stay; reads denylisted; strict allowlist plus web
> tool denies. Do not deny `/` and re-open a minimal set. Do not rely on an empty
> `allowedDomains` alone: the docs say a new domain "prompts for approval, or in auto mode
> sends the request to the classifier."

### 15.3 Codex

```toml
default_permissions = "chatroom-<nonce>"

[permissions.chatroom-<nonce>.filesystem]
"/"                     = "read"      # or ":root" if Phase 0 shows it is accepted
"<own worktree>"        = "write"
"<drop root>"           = "write"
"<scratch root>"        = "write"
"<extra write root…>"   = "write"
"<main>/.chatroom"      = "deny"
"<ipc root>/*/staging"  = "deny"
"<ipc root>/<peer>"     = "deny"
"<secret path…>"        = "deny"

[permissions.chatroom-<nonce>.network]
enabled = false                         # or the configured proxy policy

web_search = "disabled"
agents.enabled = false
shell_environment_policy.ignore_default_excludes = false
```

Precedence per the docs: "More specific entries override broader entries … deny takes
precedence over write, and write takes precedence over read." The common git directory and
the worktree admin directories are covered by the root `read` entry and receive no `write`
entry, so `gitWrites` is enforced by the profile with no special rule. `TMPDIR` is set to
the scratch root. The random profile name prevents user configuration from extending it.

If the profile cannot load, legacy `workspace-write` with `writable_roots` enforces
`shellWrites`; the worktree admin directory then becomes writable through the worktree's
`.git` link, so `gitWrites` is `best_effort` and reported. Never used: `danger-full-access`,
the approvals-and-sandbox bypass, the experimental per-thread `permissions` parameter.

### 15.4 Approval and review boundaries

Claude's classifier and relayed prompts, and Codex's Auto-review and relayed requests,
decide only within the boundaries above. A request touching a hard-denied path or ref fails
before any reviewer sees it. Negative tests exercise both layers.

### 15.5 Modes

| Mode | Behaviour |
|---|---|
| `guarded` (default) | Start only if `shellWrites`, `nativeWrites` and the login probe pass. Every other guarantee is attempted and its level shown in `/status`. MCP servers, apps, browser tools, native web tools and Codex nested agents are disabled unless allowlisted. Claude: `--strict-mcp-config`, and the setting-source combination Phase 0 finds that drops user and project hooks while keeping `CLAUDE.md`. Codex: `mcp_servers.<id>.enabled = false` and `apps.<id>.enabled = false` for everything not allowlisted, `browser_use.default_origin_policy` set to deny (key to be confirmed), `web_search = "disabled"`, `agents.enabled = false`. |
| `strict` | As `guarded`, but every guarantee must probe as `enforced` or the agent does not start. `searchReads` therefore implies `harden_native_search`. |
| `compatible` | Vendor customization loads normally. Every detected source, tool and widened path is listed in `/status` with a warning. |

Managed organization policy always remains in force.

> **Guard G15 and G24.** No mode claims a guarantee it does not enforce; `guarded` is the
> default because it always starts when the write boundary holds. Codex's config reference:
> profiles do not govern MCP servers or apps, so those are disabled by their own keys.

### 15.6 Identity

Sender identity comes from the driver and the fixed drop root, never from a payload.
Processes share one OS account; this is not isolation from a malicious local process.

### 15.7 Git write scope and ref ownership

Agents have **no** write access under the common git directory, including `objects/`, all
refs, `packed-refs`, `HEAD`, `hooks/`, `config`, `info/` and every `worktrees/<name>/` admin
directory, their own included. All of it stays readable. The worktree's `.git` file, which
points at the admin directory, is inside the writable worktree but is useless to rewrite
because the target is not writable.

Ownership of refs:

| Ref | Written by | Expected state | Deviation means |
|---|---|---|---|
| `refs/heads/chatroom/<p>/<c>/claude`, `…/codex` | orchestrator only, via snapshot and `chatroom commit` | `workspaces.expected_oid` | tampering: `ref_tampered` event, integration blocked for the conversation, restore command printed, ref never reset by Chatroom |
| `refs/heads/chatroom/<p>/<c>/integration` | orchestrator only | `workspaces.expected_oid` | same |
| `refs/chatroom/<p>/<c>/backup/<op>` | orchestrator only | recorded per operation | same |
| `main` | the user, any time | last `main_observations` row | nothing; `/sync` adopts it |

The check runs after every turn and before every git operation. It is detection, not
enforcement; enforcement is the write denial above.

> **Guard G21.** Read-only shared git directory; orchestrator-owned refs; `main` external.
> No clones, no scoped writes to the object store, no private object stores: an agent's
> private objects would be dangling from the main repository's view and break the user's
> own `git gc --auto`. Write permission on `objects/` would allow deleting packfiles and
> rewriting `objects/info/alternates`.

---

## 16. Conversation workspaces and Git integration

### 16.0 Git invocation

At startup the orchestrator resolves `git` on `PATH` to a real path (or `git.binary` from
config), records path and version in `projects`, and uses that path for every command.
Every merge is invoked as:

```text
<git> -c core.hooksPath=<main>/.chatroom/hooks-empty -c commit.gpgsign=false \
      merge --no-verify --no-gpg-sign --no-autostash --no-rerere-autoupdate --no-commit --no-ff <ref>
```

Measured on git 2.54.0: a `pre-merge-commit` hook runs on an unpinned merge and does not
run with this invocation; with `merge.autoStash=true` inherited and no `--no-autostash`, an
overlapping edit that must be refused is stashed and the file overwritten. Snapshots use
`write-tree`, `commit-tree` and `update-ref`, which run no hooks.

> **Guard G26 and G13.** Pinned binary, pinned flags. Do not call `git merge` without them.

### 16.1 One workspace set per conversation

Refs `refs/heads/chatroom/<project-short>/<conversation-short>/{claude,codex,integration}`,
all starting at main's HEAD. Worktrees under the runtime root at stable paths; admin
directory paths recorded in `workspaces.admin_dir`.

### 16.2 Snapshot

Used by `/snapshot`, by `chatroom commit`, by `/integrate` and `/sync` as their first step,
and by `/apply` for the backup. Steps, each a `git_steps` row: build a temporary index from
the branch's expected oid; add the worktree's tracked and non-ignored untracked files
through it; `write-tree`; `commit-tree` with the given message; `update-ref` with the
expected old oid; set `expected_oid`; align the worktree index without touching files.
Ignored files are not captured; staging state is not preserved.

### 16.3 `/integrate <agent>`

Steps: snapshot the agent; in the integration worktree, merge the agent branch with the
pinned invocation, then commit with `--no-verify`; record the result oid; set
`expected_oid`. Conflict: `git merge --abort` in the integration worktree, step
`needs_user`, paths reported. Later integrations contain only new snapshots.

### 16.4 `/sync <agent|all>`

Steps: if main's observed HEAD is not an ancestor of integration, merge `main` into
integration and record the observation as adopted; snapshot the agent; merge integration
into the agent branch in the agent's worktree with the agent stopped. A conflict in the
agent worktree is `needs_user` with the pre-sync snapshot safe and `/sync --abort <agent>`
available. `/import <source> <destination>` is integrate source, then sync destination.

### 16.5 `/apply [agent]`

`/apply <agent>` is integrate then apply. Steps in the user's main worktree:

1. **Preconditions**, for clear messages only: integration ref exists and is not an
   ancestor of HEAD; index equals HEAD; no `MERGE_HEAD`, `REBASE_HEAD` or
   `CHERRY_PICK_HEAD`; all orchestrator-owned refs match `expected_oid`.
2. **Backup.** If any tracked file is dirty, snapshot main's tracked files through a
   temporary index into `refs/chatroom/<p>/<c>/backup/<operation-id>`, parented on HEAD, and
   record the list of dirty paths with their blob ids. Untracked files are listed, not
   copied.
3. **Merge** with the pinned invocation.
4. **Record.** Git's outcome verbatim; the staged file list; status `needs_user` while
   `MERGE_HEAD` exists.

Measured with git 2.54.0 and the pinned invocation:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Proceeds; edit preserved; tip changes staged |
| Unstaged edit on a file the tip changes | Refused: "Your local changes … would be overwritten"; tree unchanged |
| Untracked file the tip would create | Refused: "untracked working tree files would be overwritten"; tree unchanged |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge; ancestry is shared |

The user reviews with `git diff --cached` and commits, or runs `/apply --abort`.
`/apply --abort`: `git merge --abort`, then compare every path in the backup's dirty list
against the backup blobs and restore any that differ, then delete the backup ref. The man
page says git's abort "will in some cases be unable to reconstruct the original (pre-merge)
changes"; the backup is what makes the restore a guarantee for tracked files. Untracked
files are never touched by either step. `/apply --commit` (**proposed**) commits immediately.

> **Guard G13 and G28.** Native merge, pinned, with backup. Do not reintroduce the synthetic
> commit, the applied-oid marker or the per-path journal, and do not describe abort as
> byte-identical without the backup. The known trade-offs, a merge commit per apply and a
> staged rather than unstaged review, are accepted.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees and retired IPC, keeping
conversations, authority and refs. `chatroom reset` removes both roots and owned refs,
backup refs included, only after all agents stop, every dirty worktree is snapshotted or
explicitly discarded, each ref matches its ownership token, and no non-Chatroom worktree
depends on it. Destructive commands show exact roots and refs and require confirmation.

### 16.7 Git operation recovery

On startup, for every operation left `planned` or `executing`, each step is classified by
reading its target ref and the worktree state:

| Step | Ref equals expected old oid | Ref equals recorded result, or is a merge of (expected old, source) | Otherwise |
|---|---|---|---|
| snapshot, ref_update | not done: redo or abandon | done: mark and continue | `needs_user`, both oids shown |
| merge in a Chatroom worktree | if `MERGE_HEAD` present: abort, mark `failed`; else not done | done: mark and continue | `needs_user` |
| merge in main (`apply`) | if `MERGE_HEAD` present: `needs_user` with commit or abort; else not done | HEAD is a merge whose second parent is the tip: done by the user | `needs_user` |
| backup | ref absent: not done | ref present: done | `needs_user` |
| restore | compare backup list against worktree | all restored: done | `needs_user` |

A `MERGE_HEAD` in main with no Chatroom operation is not Chatroom's and is never touched.

> **Guard G27.** Classify by oids; never assume an abort is possible.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees. Sessions start lazily. |
| `chatroom list` | Conversations, agents, workspace state, integration state. |
| `chatroom continue <name-or-id>` | Verify worktrees and open. |
| `chatroom delete <name-or-id>` | Remove worktrees, owned refs, IPC, logs and rows after confirmation. |

Switching stops or waits for active turns, snapshots both worktrees, and disconnects
drivers. A conversation holds one session per harness; ids change only through §13.3.
Sessions are isolated from the user's own because they live in conversation worktrees and
are resumed only by explicit id; the sessions docs state that `--continue` finds the most
recent session in the current directory.

---

## 18. REPL and commands

```text
#42 codex → @claude                                       10:07  post
  @claude Parser interface is ready; can you take the CLI?
    · claude: Edit src/cli.ts
    · codex ✓ auto-review approved: npm test (low risk)
    · codex ✓ commit 3f1c2a0 "Parser skeleton and tests"

!p3 codex requests network access to registry.npmjs.org
claude: working · codex: waiting p3 · budget 1/6 · integration +2 · guarded ✓✓✓✓~✓✓✓✓✓✓✓ · parser
> _
```

The guarantee glyphs summarize the twelve `guarantees` per agent; `/status` expands them.
Plain input is a user message. Multi-line input is fenced with a line containing only
`"""`. Relayed approval requests get short ids and are answered asynchronously.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit; releases held deliveries in order. |
| `/status` | Agents, sessions, the twelve guarantee levels, reviewer, git binary and version, turns, held deliveries, permissions, ownership state of every Chatroom ref, integration state, detected customization sources. |
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
agent-only `post`, `reply`, `ask`, `inbox`, `hook`, `commit`, which refuse to run unless
every required `CHATROOM_*` variable and the protocol version are present.

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
| `git.binary` | resolved from `PATH` | Override the git executable (G26). |
| `security.mode` | `guarded` | `guarded`, `strict` or `compatible` (G15). |
| `security.shell_network` | `false` | Network from sandboxed shell commands. |
| `security.network_domains` | empty | Domains allowed when shell network is enabled. |
| `security.web_tools` | `false` | Allow native web tools (`WebFetch`, `WebSearch`, Codex web search). |
| `security.browser` | `false` | Allow browser tools. |
| `security.subagents` | `false` | Allow Codex nested agents. Claude subagents are always allowed; they share the boundary. |
| `security.mcp_allowlist` | empty | MCP servers and apps permitted in `guarded` and `strict`. |
| `security.secret_paths` | §15.2 defaults | Denied read paths, both harnesses. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_deny_patterns` | §8.1 defaults | Environment variables removed at spawn. |
| `security.env_allow` | empty | Names kept despite matching a deny pattern. |
| `security.harden_native_search` | `false` | Disable Grep and Glob for an enforced `searchReads`. |
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
| `commit` | receipt of a `commit` operation | same |

Raw vendor streams are off by default, size-capped, and removable. Permission events store a
redacted summary, reviewer and available rationale. Chatroom never records
environment-variable values.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Session suspect; reconcile; resume and run a recovery turn; rebuild if that fails. |
| Crash after message commit, before scheduling | Rows remain queued. |
| Crash during a git operation | Steps classified per §16.7; nothing reset; `needs_user` where ambiguous. |
| Duplicate event or post retry | Original receipt returned. |
| Operation file malformed, oversized, symlinked, stale | Quarantine, rejection event. |
| Steering or hook delivery races turn end | Return to queued; no second charge. |
| Driver exits nonzero | Preserve stderr; fail turn; suspect only if acceptance was ambiguous. |
| Session cannot resume | Rebuild as a new generation. |
| Orchestrator-owned ref moved by anyone else | `ref_tampered` event; integration blocked for the conversation; restore command printed; ref never reset by Chatroom. |
| `main` moved by the user | Observed; `/sync` adopts it. |
| Agent runs a native git write command | Fails on the read-only git directory; the agent sees the error and uses `chatroom commit`. |
| `chatroom commit` with nothing to commit | Receipt says so; no ref change. |
| Apply refused by git | Main unchanged; message verbatim. |
| Apply conflict | `needs_user`; `/apply --abort` restores tracked dirty files from the backup. |
| Write-boundary or login probe fails | `guarded` and `strict` refuse to start that agent. |
| Any other guarantee below `enforced` | `guarded` starts and shows the level; `strict` refuses. |
| Auto-review unavailable or unparsable | User review, visibly; or decisions recorded without rationale. |
| Hosted tool detected outside the allowlist | `guarded` and `strict` disable it; `compatible` warns. |
| Budget exhausted | Trigger held; count shown. |
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
- App-server schema on 0.153.3: `thread/start`, `thread/resume`, `turn/start`, `turn/steer`
  with `expectedTurnId`, `turn/interrupt`, `review/start` with `delivery: inline | detached`,
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `item/autoApprovalReview/started` and `/completed`,
  `ApprovalsReviewer` enum `user | auto_review | guardian_subagent`,
  `GuardianApprovalReviewStatus` "[UNSTABLE]".
- Claude 2.1.261 flags as listed in §10.1. `node:sqlite` loads on Node 25.1.0.
- 2026-09-05, git 2.54.0 with the pinned invocation: the six `/apply` results of §16.5;
  `git merge --abort` after the disjoint case preserved the dirty file in that case; with
  `merge.autoStash=true` and no `--no-autostash`, the overlapping case proceeds and stashes
  the user's edit; a `pre-merge-commit` hook runs unpinned and not pinned. Two git binaries
  on `PATH`: 2.50.1 (Apple) and 2.54.0 (Homebrew).

### Documented

- Claude sandboxing: Bash-only OS sandbox; default write scope; linked-worktree allowance for
  the shared `.git` "so commands such as `git commit` can update refs and the index. Writes
  to `hooks/` and `config` inside that directory remain denied"; read precedence "the more
  specific path wins"; "Claude Code pre-allows no domains by default. The first time a
  command needs a new domain, Claude Code prompts for approval, or in auto mode sends the
  request to the classifier"; `strictAllowlist` "denies sandboxed commands access to any
  host outside the allowlist instead of prompting … enforces this for sandboxed commands
  only; in-process tools such as `WebFetch` still follow their permission rules"; permission
  rules "apply to every tool: Bash, Read, Edit, WebFetch, MCP".
- Claude permissions: `Read(//path)`, `Edit(//path)`; a Read deny blocks Edit and Write; Grep
  and Glob best-effort; deny rules take precedence.
- Claude hooks and headless: inline `--settings`; `PostToolUse` `additionalContext`;
  streaming input queues messages; `--strict-mcp-config`.
- Claude sessions: per-working-directory storage; `--continue` scoped to the directory.
- Claude Agent SDK: claude.ai login not permitted for SDK agents.
- Codex configuration: `shell_environment_policy.inherit` default `all`;
  `ignore_default_excludes` default true, "Keep variables containing KEY, SECRET, or
  TOKEN"; `mcp_servers.<id>.enabled`; `apps.<id>.enabled`; `web_search`
  "`disabled | cached | indexed | live`"; `agents.enabled` "Enable or disable multi-agent
  tools (default: true)"; `browser_use.default_origin_policy` and per-origin entries, no
  global switch; profiles govern sandboxed commands only.
- Codex permissions: `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; specific-over-broad, deny over write over read; Beta; exclusive with
  `sandbox_mode`; `:minimal` and `:workspace_roots` documented, `:root` in source only.
- Codex Auto-review: requires interactive approvals; `never` leaves nothing to review.
- Codex app-server: experimental; per-thread `permissions` parameter experimental.
- git-merge man page: `--abort` "will in some cases be unable to reconstruct the original
  (pre-merge) changes".

### Phase 0: verify before building the scheduler

1. `node:sqlite` durability suite on the oldest supported Node LTS.
2. Claude CLI: several sequential turns in one `-p` stream-json process; `--resume` later.
3. Claude hook from inline `--settings` fires in `-p` mode; setting-source interaction.
4. Claude permission control request and response wire shapes.
5. `thinking` blocks in the Claude stream; whether `--verbose` is needed.
6. Claude boundary matrix through shell and native tools: writes, reads, canary secret
   variable, toolchain reads, package install with an extra write root, `WebFetch` denied,
   sandboxed `curl` to a non-allowlisted host denied without a prompt.
7. Claude git: `denyWrite` on the common directory revokes the automatic worktree
   allowance; `git log`, `diff`, `status` work with `GIT_OPTIONAL_LOCKS=0`; `git commit`
   and `git stash` fail; `chatroom commit` lands on the own branch.
8. Claude setting-source combination that drops user and project hooks and MCP servers
   while keeping `CLAUDE.md`; whether Claude subagents inherit the sandbox and rules.
9. Claude login probe.
10. App-server: profile accepted through `config` overrides; root path token or `/`;
    reviewer accepted and reported; routine command auto-approved; escalation reaches
    `requestApproval`; `web_search`, `agents.enabled`, per-id MCP and app disables and the
    browser origin policy take effect; `turn/steer` against a finishing turn.
11. Codex boundary matrix under the profile, including that the admin directory is not
    writable and `chatroom commit` works.
12. Codex `exec` fallback: overrides via `-c` on start and resume.
13. What each harness records after a kill mid-generation.
14. Effective tool-command timeouts of both harnesses.
15. The backup-and-restore path of `/apply --abort` against a case where git's own abort
    loses a dirty change.
16. Recovery classification of §16.7 against a crash injected after each git step.

---

## 23. Verification and testing strategy

- **Model-free core tests** with fake drivers: the invariants of §2 under crash injection at
  every boundary.
- **IPC security tests**: partial, duplicate, hard-linked, symlinked, directory, FIFO,
  sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn cases.
- **Boundary matrix**: every `guarantees` entry on both harnesses, positive and negative,
  through shell and native tools; environment canary; hosted-tool absence.
- **Broker tests**: a commit mid-edit yields a consistent snapshot of what was on disk;
  concurrent commit requests serialize; nothing-to-commit returns a clean failure.
- **Ref-ownership tests**: an external move of an owned ref is detected after the next turn
  and blocks integration; a `main` move is adopted by `/sync`.
- **Git matrix**: file kinds; sequential snapshots and integrations; both agents on the same
  and different files; main advancing before `/sync` and before `/apply`; the six `/apply`
  states; repeated apply after commit; `/apply --abort` restoring tracked dirty files
  byte-identically in every case, including one where git's own abort does not; conflict
  states in agent worktrees; crash after each step of every operation with §16.7
  classification; hooks never run; autostash never engages; signing never attempted.
- **Mirror tests**: partial lines, malformed JSON, missing or duplicate records, rewrite.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 24. Implementation approach

TypeScript on the Phase-0-verified Node LTS range; `node:sqlite` if it passes. Vendor types
stop at the adapter boundary.

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, probes.ts, env.ts
  security/   profiles.ts, boundaries.ts, customization.ts
  workspace/  git.ts (binary, pinned invocation), repository.ts, snapshot.ts, broker.ts,
              merge.ts, refs.ts, backup.ts, steps.ts, recovery.ts
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
2. **IPC and agent commands.** Layout, import, receipts, retry, limits, quarantine; the six
   agent commands with `commit` against a fake workspace manager; security suite. Exit:
   every accepted operation has one durable result and no orchestrator path can be
   redirected by an agent-controlled entry.
3. **Drivers, read-only.** Claude CLI in auto mode with hook delivery; Codex app-server with
   Auto-review and steering; `exec` fallback; scrubbed environments; minimal recovery. Exit:
   both agents chat concurrently and receive a mid-turn message.
4. **Guarded work.** Runtime roots; Claude sandbox and deny rules including network and web
   tools; Codex profile and hosted-tool disables; read-only git directory; the broker; ref
   ownership checks; probes for all twelve guarantees; modes. Exit: each agent edits, tests
   and checkpoints in its own worktree, reads main, peer and toolchains, cannot read
   secrets, cannot reach the network or hosted tools, and cannot write main, peer, IPC, the
   database or any part of the git directory; `/status` shows the levels truthfully.
5. **Git collaboration.** Pinned invocation, snapshots, `/integrate`, `/sync`, `/import`,
   `/apply` with backup and `--abort`, per-step intents and recovery, the Git matrix. Exit:
   the six `/apply` states behave as measured and every abort leaves tracked files
   byte-identical.
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
10. **`chatroom commit` during an in-flight tool call.** Whether to refuse, to avoid
    checkpointing a half-written file. Default: allowed, documented in the brief.

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
- git-merge manual: `git merge --help`, "how to abort" section

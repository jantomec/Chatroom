# Chatroom Architecture v8

Status: implementation baseline, 2026-09-05. Standalone; supersedes `ARCHITECTURE.md` (v1)
and `ARCHITECTURE_V2.md` through `ARCHITECTURE_V7.md`. No code exists yet. Implementation
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

## 0. Changes from v7

All from the Codex review of v7, each verified before adoption. Two of Codex's proposed
remedies were corrected by measurement (items 3 and 6).

1. **The broker never discovers a repository.** v7 called rewriting the worktree's `.git`
   pointer file harmless. Measured: after rewriting it to point at a fake repository,
   discovery-based git in that directory reports the fake repository, while
   `--git-dir=<admin dir> --work-tree=<worktree>` reports the real one and a snapshot
   through a temporary index works that way. Repository config can name executables and
   the orchestrator runs unsandboxed, so the broker now uses recorded absolute paths only,
   verifies the pointer file before every operation, and writes to the pointer file are
   denied.
2. **`gitWrites` must be `enforced` in guarded mode.** Monitoring cannot see a deleted
   packfile or a rewritten peer index. If Claude's `denyWrite` cannot revoke the automatic
   linked-worktree allowance, the fallback is a **detached checkout**: a worktree with no
   `.git` file, locked against pruning, with `GIT_DIR` and `GIT_WORK_TREE` in the agent's
   environment. Measured: `git status` and `git log` work that way, `git worktree list`
   marks the entry prunable, and `git worktree lock` protects it. If neither probes as
   enforced, guarded refuses to start that agent.
3. **Two-state abort and an explicit collision preflight.** `/apply --abort` restores a path
   automatically only when its current state still equals the recorded post-merge state;
   otherwise the path is `needs_user`. States record mode, oid and absence, so deletions,
   symlinks and executable bits are represented. Codex proposed `--no-overwrite-ignore` for
   ignored files in the merge's way; the man page says "Use --no-overwrite-ignore to
   abort", but measured on 2.54.0 with both merge strategies, the ignored file was
   overwritten anyway. Chatroom therefore checks collisions itself: every path the merge
   would add or rename to must not exist in the working tree, tracked, untracked or ignored.
4. **Finer git steps.** Tree write, candidate commit with its oid persisted, ref
   compare-and-swap, and index alignment are separate recoverable steps. An interrupted
   apply retries automatically only when the entire recorded pre-state verifies.
5. **One merge-and-commit form for Chatroom-owned worktrees.** A single pinned
   `merge --no-ff -m` command, measured to run no hooks and produce the commit.
   `--no-commit` is reserved for the user's main worktree.
6. **Codex configuration corrected and measured.** v7's TOML example placed top-level keys
   under a table. Codex also claimed a loaded legacy `sandbox_mode` overrides
   `default_permissions`; measured under `codex sandbox` on 0.153.3, the profile override
   won in both the read-only and workspace-write cases. Guarded mode still reads back the
   effective policy and refuses if the legacy sandbox is active. Also measured: `:root` and
   a bare `/` are both accepted as read entries; a deny inside a read region holds; a read
   entry inside a write region holds; a profile without a system read grant cannot start
   `sh`.
7. **Smaller corrections.** User-initiated `/snapshot` and `/integrate` refuse while the
   agent runs; main's symbolic branch is recorded and checked; recovery finds the apply
   merge below newer user commits; sync conflicts are abort-only in the first release.
8. **Guards G13, G21 and G28 amended; G29 to G31 added.**

Kept from v7 without change of substance: everything else, including the commit broker,
ref ownership, per-surface guarantees, pinned git invocation and binary, per-step intents,
and the pre-apply backup.

### 0.1 Regression guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; SDK docs: "Anthropic does not allow third party developers to offer claude.ai login … including agents built on the Claude Agent SDK." |
| G2 | Claude runs in permission mode `auto` with prompts relayed to the REPL. | User decision. |
| G3 | Codex runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`, falling back to the user visibly. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G4 | Claude's mid-turn delivery is a `PostToolUse` hook; streaming input is not injection. | Claude docs: streaming input "queued messages … process sequentially"; hook `additionalContext` "appended to the tool result". |
| G5 | Claude's native Read, Grep, Glob, Edit and Write stay enabled; the boundary is path deny rules. Grep and Glob are labelled best-effort. | Claude permissions docs. |
| G6 | Reads are denylisted, not allowlisted; toolchains stay readable; caches writable via config. | Claude docs: "the deny holds inside a wider allow"; Codex docs and measurement: deny inside read holds. |
| G7 | Worktrees and IPC live outside the main tree, because Claude permission rules are deny-wins. | Claude permissions docs; sandboxing docs: "the narrower allow re-opens that part of the denied region." |
| G8 | Agents read the main tree and the peer worktree, including uncommitted state; they write only their own worktree. | User decision. |
| G9 | No commit norms. Agents checkpoint their worktree onto their own branch with `chatroom commit`. Native git write commands are unavailable to agents. | User decision on norms; v7 change 1. |
| G10 | `@handle` mentions are the single addressing convention; `--to` is an override only. | User decision. |
| G11 | When both agents answer at once, both replies are recorded. | User decision. |
| G12 | Agents run in parallel with per-agent inboxes; no turn-taking. | User decision. |
| G13 | `/apply` and `/sync` are native `git merge` operations with the pinned invocation of §16.0, invoked with recorded absolute paths, with a pre-apply backup and per-step intent rows. No synthetic commit, no applied-oid marker, no per-path journal. | Measured merge behaviour, §16.5 and §22. |
| G14 | `ask` returns early on a probable candidate; only an explicit reply resolves durably. | Latency; correlation invariant kept. |
| G15 | Three modes: `guarded` (default), `strict` (fail closed), `compatible`. No mode claims a guarantee it does not enforce. | Codex review of v5. |
| G16 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex sandbox denies Unix-socket connections. |
| G17 | Zero footprint in tracked files, CLAUDE.md, AGENTS.md, `.claude/`, `.codex/`, `.gitignore`. | User decision. |
| G18 | Suspect sessions are resumed and health-checked by a recovery turn; rebuild is the fallback. | Both harnesses persist turns incrementally. |
| G19 | The autonomy budget charges per agent message; a user message resets the counter without releasing held deliveries for agents it did not address. | Intentional asymmetry, §7.1. |
| G20 | First-release cut line: Phase 0, phases 1 to 5. Source review, checkpoints, archive and `gc` come later. | Scope control. |
| G21 | The shared git directory, the worktree admin directories and the worktree's `.git` pointer file are read-only for agents. No clones, no scoped object-store writes, no private object stores. Chatroom refs move only through the orchestrator. | v7 change 1; measured pointer rewrite (§22); user decision against clones. |
| G22 | The child environment is scrubbed of secret-like variables for both drivers; Codex's default exclusions are switched on. | Codex config reference: `ignore_default_excludes` "default: true". |
| G23 | `.chatroom/` lives in the main worktree resolved from the common git directory; the lock lives in the runtime root. | `git rev-parse --show-toplevel` differs per linked worktree. |
| G24 | MCP servers, apps, browser tools, native web tools and Codex nested agents are disabled in `guarded` and `strict` unless allowlisted. | Codex config reference; Claude docs on `strictAllowlist` scope. |
| G25 | Shell network on Claude uses `strictAllowlist: true`; `WebFetch` and `WebSearch` are denied by rule; Codex `web_search = "disabled"`. | Claude sandboxing docs; Codex config reference. |
| G26 | The git binary is resolved once at startup, recorded with its version, and used by path for every command. | Two binaries on this machine. |
| G27 | Every git step has an intent row with target ref, expected old oid, source oid and result oid; recovery classifies by comparing refs and states, never by assuming an abort is possible. | Codex reviews of v6 and v7. |
| G28 | `/apply` records pre-apply and post-merge state per affected path and backs up dirty tracked files into a backup ref; `--abort` restores a path automatically only when its current state equals the post-merge state; every merge passes `--no-autostash`. | git-merge man page; measured autostash behaviour; Codex review of v7. |
| G29 | The orchestrator never lets git discover a repository. Every command carries the recorded absolute git directory and worktree, and the worktree's `.git` pointer is verified before each operation. | Measured: a rewritten pointer redirects discovery; explicit paths ignore it. |
| G30 | `gitWrites` must probe as `enforced` for an agent to start in `guarded` or `strict`. The fallback for Claude is the detached checkout, not monitoring. | Codex review of v7, finding 2; measured detached checkout. |
| G31 | Collision preflight is Chatroom's own check over tracked, untracked and ignored files; `--no-overwrite-ignore` is passed but not relied on. | Measured: the flag did not prevent overwriting an ignored file on git 2.54.0. |

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
- Resolving sync conflicts in place; the first release aborts them.

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
15. **Reviewers are not boundaries.**
16. **Secrets denied, tools open.** (G6)
17. **Native tools stay native.** (G5)
18. **No mode claims what it does not enforce.** (G15)
19. **Shared repository state is written only by the orchestrator.** (G21)
20. **Every git mutation is an intent with oids before it is a command.** (G27)
21. **The orchestrator's git never trusts a path the agent can write.** (G29)

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
 │                                            explicit-path git; step intents)  │
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
   (git dir read-only)                       (git dir read-only)
```

| Component | Responsibility |
|---|---|
| REPL | User input, transcript rendering, activity streams, permission decisions, commands. |
| Orchestrator | The single state machine and database writer. Resolves targets, schedules work, reserves autonomy credits, coordinates recovery. |
| Store | Schema, migrations, transactions, queries, JSONL mirror. |
| IPC dispatcher | Imports agent operations, including commit requests; writes receipts and deliveries; enforces idempotency and limits. |
| Driver | Starts or resumes one vendor session with a scrubbed environment and pinned boundary, submits turns, delivers mid-turn messages, normalizes events, relays approvals. |
| Workspace manager | The only writer of Chatroom refs and of the main worktree. Snapshots, brokered commits, merges, per-step intents, recovery, always through recorded absolute paths. |
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
`<runtime root>/lock`, unique by construction.

> **Guard G23.** Authority in the main worktree, lock in the runtime root.

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

> **Guard G7.** Worktrees stay outside the main tree.

---

## 5. Durable storage

### 5.1 Engine and settings

`node:sqlite`, present on the development machine's Node with an experimental-feature
warning. Phase 0 runs the durability suite on the oldest supported Node LTS. One write
connection.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations run under an exclusive lock and keep a pre-migration backup.

### 5.2 JSONL mirror

Appended after every committed transaction that creates entries, outside the transaction.
Fully validated on startup and on `chatroom log --verify`; rewritten from SQLite on any
discrepancy; never read by recovery.

### 5.3 Schema

```sql
projects(id PK, main_worktree, git_common_dir, runtime_root, git_binary, git_version,
  created_at, current_conversation_id)

conversations(id PK, project_id FK, name, created_at, last_used_at,
  status,                                  -- active | archived | deleting
  autonomy_limit, autonomy_used,
  main_branch_ref)                         -- symbolic branch of the main worktree at creation

entries(id INTEGER PK AUTOINCREMENT, conversation_id FK, kind, created_at)
messages(entry_id PK FK, author, via, body, turn_id, operation_id,
  reply_to FK, causal_root FK, UNIQUE(author, operation_id))
message_targets(message_id FK, participant, expects_action, PK(message_id, participant))
events(entry_id PK FK, type, agent, turn_id, payload_json)

agent_sessions(conversation_id FK, agent, vendor_session_id, generation, status,
  last_confirmed_entry_id, capabilities_json, PK(conversation_id, agent))
turns(id PK, conversation_id FK, agent, attempt, status, vendor_turn_id, session_generation,
  started_at, ended_at, final_message_id, error_json, cost_json)
turn_inputs(turn_id FK, message_id FK, ordinal, transport, PK(turn_id, message_id))
deliveries(id PK, conversation_id FK, agent, message_id FK, status, transport, attempt,
  autonomy_charged, accepted_at, UNIQUE(agent, message_id))
agent_operations(operation_id, agent, turn_id, type, status, result_json, created_at,
  PK(agent, operation_id))                 -- type: post | reply | delivery_ack | commit
permissions(id PK, turn_id FK, agent, vendor_request_id, status, reviewer, summary,
  request_json, decision_json, rationale, created_at, resolved_at)

workspaces(conversation_id FK, owner, branch_ref UNIQUE, worktree_path, admin_dir,
  checkout_mode,                           -- linked | detached
  pointer_expected,                        -- exact expected content of <worktree>/.git, or NULL when detached
  expected_oid, last_snapshot_oid, ownership_token, status, PK(conversation_id, owner))

main_observations(conversation_id FK, observed_oid, observed_branch_ref, observed_at,
  adopted_by_operation_id)

git_operations(id PK, conversation_id FK, type, status, requested_by, created_at, finished_at,
  details_json)                            -- type: snapshot | commit | integrate | sync | apply | apply_abort
                                           -- status: planned | executing | done | needs_user | failed

git_steps(id PK, operation_id FK, ordinal, kind, target_ref, worktree_path, admin_dir,
  expected_old_oid, source_oid, candidate_oid, result_oid, status, message)
  -- kind: pointer_check | tree_write | commit_write | ref_cas | index_align | merge |
  --       merge_commit | backup | preflight | restore | abort
  -- status: planned | executing | done | needs_user | failed

apply_paths(operation_id FK, path,
  pre_mode, pre_oid, pre_absent,           -- state before the merge
  post_mode, post_oid, post_absent,        -- state after the merge completed
  PK(operation_id, path))
```

> **Comment.** New since v7: `workspaces.checkout_mode` and `pointer_expected` (G29, G30),
> `conversations.main_branch_ref` and `main_observations.observed_branch_ref` (change 7),
> the finer `git_steps.kind` set with `candidate_oid` (change 4), and `apply_paths` (G28).

### 5.4 Transaction boundaries

One transaction each: append a message with targets, delivery rows and credit reservation;
create a turn with its input set; accept a delivery; append a final reply and end its turn;
import an agent operation and its receipt result; record a permission decision; plan a git
operation with all its steps; mark a git step `executing`; record a git step's result and,
for `commit_write`, its candidate oid. Crossings into child processes, filesystem renames
and Git use an intent record followed by reconciliation.

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

> **Guard G10.** `@handle` is the one convention.

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

Body 64 KiB; operation file 96 KiB; posts per turn 100; unprocessed operation files per turn
256; delivery batch 64 messages and a driver-specific token budget; receipt retention seven
days.

---

## 7. Autonomy budget and scheduling

### 7.1 Meaning of the budget

- A user message resets `autonomy_used` to zero.
- An agent message that targets the other agent reserves one credit when committed. If no
  credit remains, its delivery is `held`; the message stays visible to the user.
- Messages to the user cost nothing. One message costs at most one credit.

Held deliveries are released, and charged once, when the user addresses the held recipient
or everyone, in which case they join that batch free, or when the user raises `/budget`,
in which case they are released in entry order while credit lasts. A user message that
addresses only one agent does not release the other agent's held deliveries.

> **Guard G19.** The asymmetry is intentional.

### 7.2 Scheduler states

Per agent: `idle`, `preparing`, `running`, `waiting_for_permission`, `stopping`,
`recovering`, `unavailable`. At most one turn is active per agent and conversation; the two
agents run concurrently.

> **Guard G12 and G11.** No turn-taking; no discarded replies.

### 7.3 Scheduling rule

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

Both agents start in the same event-loop tick when both have eligible work. Messages
coalesce into bounded batches. Every post gets a receipt even when its target is held.

---

## 8. File IPC protocol

> **Guard G16.** Files, never sockets.

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
| `GIT_DIR`, `GIT_WORK_TREE` | only in detached checkout mode (§15.8): the admin directory and the worktree |

The Codex driver additionally sets `shell_environment_policy.ignore_default_excludes =
false` and matching `filters`. Nothing else in the agent's git environment is altered.

> **Guard G22.** Scrubbed environment on both drivers.

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
no-follow semantics that it is one bounded regular file, validates it, imports it
transactionally or returns the previous result for a duplicate id, and writes a receipt
under `to-agent/receipts/` by temp-file-and-rename.

### 8.3 Receipts

`{"protocol": 3, "operation_id": "…", "status": "accepted", "message_id": 42}`.
`chatroom post` waits briefly and prints `#42`. A local timeout means "acceptance unknown".
Before a turn is finalized, the drop root is closed, drained, and retired after a grace
period.

### 8.4 Deliveries and acknowledgment

For the hook transport, the orchestrator writes one atomic file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack`; they never move or delete the delivery file.

### 8.5 `ask` and `reply`

`ask` is `post` followed by waiting, up to `ask.timeout_seconds`. A message whose `reply_to`
is the question id resolves it durably (`answered`). The first message from one of the
asked parties that targets the asker after the question is returned immediately as
`probable`; the question stays open. On timeout, `indeterminate`.

> **Guard G14.** Return early on the first probable candidate.

### 8.6 `chatroom commit`

```sh
"$CHATROOM_BIN" commit "Parser skeleton and tests"
```

Writes a `commit` operation. The dispatcher imports it and the workspace manager runs a
snapshot (§16.2) of the agent's worktree onto the agent's branch with that message,
serialized with every other git operation and using the recorded absolute paths, never
discovery. The receipt carries the new oid, or a failure such as "nothing to commit". The
agent may run it at any point in a turn; the snapshot is a checkpoint of whatever is on
disk at that moment, which the brief says.

Native `git commit`, `git add`, `git stash`, `git checkout <other branch>`, `git branch` and
`git reset` fail for agents because the shared git directory, the admin directory and the
`.git` pointer are not writable (§15.7). `git log`, `git diff`, `git show`, `git status` and
`git blame` work.

> **Guard G9 and G21.** Checkpoints through the broker; no native git writes.

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
  checkoutMode: "linked" | "detached";
  guarantees: {
    shellWrites: GuaranteeLevel;     // own worktree, drop, scratch, extra roots only
    nativeWrites: GuaranteeLevel;    // Edit/Write denied on main, peer, IPC, git dir, pointer
    gitWrites: GuaranteeLevel;       // git dir, admin dirs and pointer unwritable; must be enforced to start
    shellReads: GuaranteeLevel;
    nativeReads: GuaranteeLevel;
    searchReads: GuaranteeLevel;     // Grep/Glob best_effort unless disabled
    environment: GuaranteeLevel;
    shellNetwork: GuaranteeLevel;
    nativeWeb: GuaranteeLevel;
    browser: GuaranteeLevel;
    mcpApps: GuaranteeLevel;
    subagents: GuaranteeLevel;
  };
};
```

Interface unchanged: `probe`, `connect`, `startTurn`, `steer`, `deliverViaHook`,
`inspectTurn`, `answerPermission`, `interrupt`, `events`, `close`.

### 9.1 Capability probing

`chatroom doctor` fills every `guarantees` entry by attempting the forbidden thing through
both shell and native tools: writes to main, peer, IPC, `.chatroom/`, the common git
directory, the own admin directory and the own `.git` pointer file; reads of a canary
secret file and a canary secret variable; a fetch of a non-allowlisted host from a
sandboxed command and from the native web tool; listing loaded MCP servers, apps, hook
sources and nested-agent tools; and, as positives, a `chatroom commit` that lands on the
own branch, `git log` inside the worktree, and a package install with an extra write root.
For Claude it probes `gitWrites` first in linked mode and, if that is not enforced, in
detached mode (§15.8), recording which mode the driver will use. It also verifies Claude's
login and Codex's effective reviewer and sandbox policy, and records the git binary and
version.

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

> **Guard G1.** CLI, never the Agent SDK.

### 10.2 Mid-turn delivery: PostToolUse hook

```json
{"hooks": {"PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` drains `CHATROOM_DELIVERY_DIR`, writes a `delivery_ack`, and prints
`hookSpecificOutput.additionalContext` with the delivery text. Hooks run outside the Bash
sandbox with the driver's environment.

> **Guard G4.** Streaming input is a queue; the hook is the injection channel.

### 10.3 Auto mode and approvals

`--permission-mode auto` with host-relayed prompts, recorded and answered on stdin. Hard
denials apply before any prompt.

> **Guard G2.** `auto` with host-relayed prompts.

### 10.4 Fallback

One process per turn with the same flags if the long-lived process fails Phase 0.

---

## 11. Codex driver

### 11.1 Transport

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the keys of §15.3. `turn/start`; `turn/steer` with `expectedTurnId`;
`turn/interrupt`. Approval requests `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval` and `item/permissions/requestApproval` reach the REPL
when Auto-review escalates or is unavailable. `item/autoApprovalReview/*` notifications are
recorded as evidence when they parse. All names confirmed in the schema generated by
`codex app-server generate-json-schema` on 0.153.3.

After `thread/start`, the driver reads back the thread's effective sandbox policy and
permission profile where the protocol reports them, and refuses in `guarded` and `strict`
if the legacy sandbox is active instead of the generated profile.

### 11.2 Auto-review

Set per thread and per turn; decisions recorded with rationale when observable; escalation
and unavailability fall back to the user visibly.

> **Guard G3.** `auto_review` with `on-request`, user fallback.

### 11.3 Fallback: `codex exec`

Same `config` overrides passed through `-c`. No `--sandbox`. No approvals, Auto-review or
steering. Hook delivery only when Chatroom's hook is the sole non-managed hook source.

---

## 12. Turn lifecycle

### 12.1 Starting a turn

1. In one transaction: select every undelivered message through the newest eligible
   trigger, create the turn, attach ordered `turn_inputs`, mark those deliveries
   `publishing`, append `turn_started`.
2. Create exact per-turn drop and scratch directories.
3. Ensure the vendor session is connected, resuming by explicit id if needed, and verify
   its working directory and the `.git` pointer (§15.7).
4. Submit the input through the native channel, never as an argument.
5. On acknowledgment, store vendor ids, mark deliveries `accepted`, set the turn `running`.
6. Stream normalized activity to the REPL and, if enabled, the raw log.

### 12.2 During a turn

Agent-side posts and commit requests are imported independently of model output. Eligible
messages for a running agent are steered or hook-delivered per capability. Approval
requests stop only the requesting operation. `/stop` requests protocol interruption, then
SIGTERM, then SIGKILL after grace periods.

### 12.3 Ending a turn

1. Receive the terminal event and final reply.
2. Close the drop root and drain published operations.
3. In one transaction: append the non-empty final reply with idempotency key
   `final:<turn-id>` and `via: final`, or append `silent`; store cost; mark the turn ended.
4. Write pending receipts, return unacknowledged hook deliveries to `queued`, retire
   per-turn directories, verify every orchestrator-owned ref and pointer file (§15.7), run
   the scheduler.

### 12.4 Steering and hook races

If the vendor reports no matching active turn, or a hook delivery is unacknowledged at turn
end, the batch returns to `queued` and leads the next turn. The autonomy credit stays
charged.

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

> **Guard G18.** Resume before rebuild.

### 13.3 Lost session rebuild

New generation; bounded prompt from brief, transcript tail, referenced messages and
workspace state; new id stored after acknowledgment; `session_rebuilt` event.

### 13.4 Startup reconciliation

Mark turns left `preparing` or `running` as interrupted; verify the runtime root; reconcile
staged IPC by id; recreate missing delivery or receipt files; quarantine orphans; classify
every `planned` or `executing` git operation step by step (§16.7); verify owned refs,
pointer files and main's branch; validate the mirror; reconnect sessions last.

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
  Either may be mid-edit; the chat is where intent is stated. {detached_note}
- "$CHATROOM_BIN" commit "<message>" records a checkpoint of your worktree on your branch,
  whenever you want one; it captures whatever is on disk at that moment. Native git write
  commands (add, commit, stash, checkout, branch, reset) are unavailable; git log, diff,
  show and status work. Chatroom owns integration and all refs.

Recovery
- Message ids are stable. A recovery note may describe an interrupted attempt. Inspect the
  worktree before repeating commands or edits.
```

`{detached_note}` is empty in linked mode and, in detached mode, reads: "Your worktree has
no `.git` entry; git commands work in it through the environment. To look at the peer's
history use `git --git-dir={peer_admin_dir} log`, or read its files directly."

> **Guard G8 and G9.** Main and peer readable; own worktree writable; checkpoints through
> the broker; no commit norms.

---

## 15. Sandboxing, approvals, and trust

### 15.1 Threat model

Chatroom protects against accidental or prompt-injected writes outside an agent's assigned
workspace, any write to shared repository state or to the paths the orchestrator's git
reads, reads of known secret locations and secret-bearing environment variables, undeclared
network egress, hosted tools that bypass the sandbox, malformed IPC, duplicate operations,
and common path and symlink attacks. It assumes anything a model tool can read may reach
that model's provider.

### 15.2 Claude

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop root>", "<scratch root>", "<security.extra_write_roots…>"],
      "denyWrite": ["<git common dir>", "<worktree>/.git"],
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
      "Edit(//<git common dir>/**)", "Write(//<git common dir>/**)",
      "Edit(//<worktree>/.git)", "Write(//<worktree>/.git)"
    ]
  }
}
```

- **Shell writes** are bounded by the default scope plus `allowWrite`. The two `denyWrite`
  entries revoke the automatic linked-worktree allowance and protect the pointer file.
  Whether they take effect is Phase 0 item 7; if not, the driver switches to the detached
  checkout (§15.8), and if that is not enforced either, guarded refuses Claude.
- **Shell reads** are open except the denylist. `~/.claude` and `~/.codex` are in the
  default secret list.
- **Network.** `strictAllowlist: true` plus the `WebFetch` and `WebSearch` deny rules.
- **Native tool writes** are denied for the main tree, peer worktree, IPC root, git
  directory and pointer file. **Native tool reads** of secrets and `.chatroom/` are denied;
  a Read deny also blocks Edit and Write. Grep and Glob are best-effort unless
  `security.harden_native_search` disables them.
- **Subagents** share the process, rules and sandbox; the `Agent` tool stays enabled.

Default `security.secret_paths`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
`~/.docker/config.json`, `~/.kube`, `~/Library/Keychains`, `~/.claude`, `~/.codex`,
`~/.config/chatroom`.

> **Guard G5, G6 and G25.** Native tools stay; reads denylisted; strict allowlist plus web
> tool denies.

### 15.3 Codex

The driver passes these keys through the `config` override map on `thread/start` and
`thread/resume`, or through `-c` on `exec`. Shown here as the equivalent TOML, with
top-level keys before any table:

```toml
default_permissions = "chatroom-<nonce>"
web_search = "disabled"

[agents]
enabled = false

[shell_environment_policy]
ignore_default_excludes = false
# filters = { … §8.1 patterns … }
# set = { CHATROOM_AGENT = "codex", …, TMPDIR = "<scratch root>" }

[permissions.chatroom-<nonce>.filesystem]
":root"                 = "read"      # "/" is accepted as well; both measured
"<own worktree>"        = "write"
"<own worktree>/.git"   = "read"      # pointer file: read entry inside the write region, measured to deny writes
"<drop root>"           = "write"
"<scratch root>"        = "write"
"<extra write root…>"   = "write"
"<main>/.chatroom"      = "deny"
"<ipc root>/*/staging"  = "deny"
"<ipc root>/<peer>"     = "deny"
"<secret path…>"        = "deny"

[permissions.chatroom-<nonce>.network]
enabled = false
```

Measured on 0.153.3 under `codex sandbox`: a profile without a system read grant cannot
start `sh`, so the root read entry is required; a deny inside the root read holds; a read
entry for a file inside a write region denies writes to it; and a `default_permissions`
override took effect even when the user's config file had `sandbox_mode` set, in both the
read-only and workspace-write cases. Because that was `codex sandbox` and not app-server,
the driver still reads back the effective policy (§11.1). The common git directory and the
admin directories receive no `write` entry, so `gitWrites` is enforced by the profile.
Never used: `danger-full-access`, the approvals-and-sandbox bypass, the experimental
per-thread `permissions` parameter.

### 15.4 Approval and review boundaries

Reviewers decide only within the boundaries above. A request touching a hard-denied path or
ref fails before any reviewer sees it.

### 15.5 Modes

| Mode | Behaviour |
|---|---|
| `guarded` (default) | Start only if `shellWrites`, `nativeWrites`, `gitWrites` and the login probe pass. Every other guarantee is attempted and its level shown in `/status`. MCP servers, apps, browser tools, native web tools and Codex nested agents are disabled unless allowlisted. Claude: `--strict-mcp-config`, and the setting-source combination Phase 0 finds. Codex: per-id disables, `web_search = "disabled"`, `agents.enabled = false`, browser origin policy set to deny; the legacy sandbox must not be the effective policy. |
| `strict` | As `guarded`, but every guarantee must probe as `enforced` or the agent does not start. |
| `compatible` | Vendor customization loads normally. Every detected source, tool and widened path is listed in `/status` with a warning. |

> **Guard G15, G24 and G30.** No mode claims what it does not enforce; hosted tools off
> unless allowlisted; `gitWrites` is a start condition, not a reported level.

### 15.6 Identity

Sender identity comes from the driver and the fixed drop root, never from a payload.

### 15.7 Git write scope and ref ownership

Agents have no write access under the common git directory, including `objects/`, all refs,
`packed-refs`, `HEAD`, `hooks/`, `config`, `info/` and every `worktrees/<name>/` admin
directory, their own included; nor to the worktree's `.git` pointer file. All of it stays
readable.

The pointer file matters because an agent that rewrites it to `gitdir: <path it
controls>` would make any discovering git command, the orchestrator's included, operate on
a repository whose `config` the agent wrote. Two independent defences: the write denial
above, and the orchestrator never discovering (§16.0). Before every operation and after
every turn, the workspace manager checks that `<worktree>/.git` is a regular file whose
content equals `workspaces.pointer_expected`; a mismatch is `pointer_tampered`, blocks git
operations for that conversation, and prints the restore command.

Ownership of refs:

| Ref | Written by | Expected state | Deviation means |
|---|---|---|---|
| `refs/heads/chatroom/<p>/<c>/claude`, `…/codex` | orchestrator only | `workspaces.expected_oid` | `ref_tampered`: integration blocked, restore command printed, ref never reset by Chatroom |
| `refs/heads/chatroom/<p>/<c>/integration` | orchestrator only | `workspaces.expected_oid` | same |
| `refs/chatroom/<p>/<c>/backup/<op>` | orchestrator only | recorded per operation | same |
| `main` | the user, any time | last `main_observations` row | nothing; `/sync` adopts it. A changed symbolic branch is `needs_user` before `/apply` |

> **Guard G21 and G29.** Read-only git directory, admin directories and pointer file;
> orchestrator-owned refs; the orchestrator's git never discovers. No clones, no scoped
> writes, no private object stores.

### 15.8 Detached checkout (Claude fallback)

If Phase 0 shows that Claude's `denyWrite` entries cannot revoke the automatic
linked-worktree allowance, the Claude worktree is created as usual, then its `.git` pointer
file is removed and the worktree is locked with `git worktree lock`. The agent's
environment carries `GIT_DIR=<admin dir>` and `GIT_WORK_TREE=<worktree>`. Measured on git
2.54.0: `git status` and `git log` work in that directory through the environment; without
the environment, git reports "not a git repository"; `git worktree list` marks the entry
prunable and the lock prevents pruning.

Because the working directory then contains no `.git` entry, the sandbox has no linked
worktree to extend its write scope to, and the common git directory is outside the default
scope. The known cost: `git -C <other directory>` also uses the environment's repository,
so the brief's detached note tells the agent how to read the peer's history. The
orchestrator's own commands are unaffected, since they never discover.

`checkoutMode` is recorded per workspace and shown in `/status`.

---

## 16. Conversation workspaces and Git integration

### 16.0 Git invocation

At startup the orchestrator resolves `git` on `PATH` to a real path (or `git.binary` from
config), records path and version in `projects`, and uses that path for every command.

Every command names its repository explicitly and never discovers:

```text
<git> --git-dir=<recorded admin dir or common dir> --work-tree=<recorded worktree> …
```

plus `-c core.hooksPath=<main>/.chatroom/hooks-empty -c commit.gpgsign=false` on every
mutating command. Merges into Chatroom-owned worktrees are one command:

```text
<git> --git-dir=<admin> --work-tree=<wt> -c core.hooksPath=… -c commit.gpgsign=false \
      merge --no-verify --no-gpg-sign --no-autostash --no-rerere-autoupdate \
            --no-overwrite-ignore --no-ff -m "<message>" <ref>
```

The merge into the user's main worktree is the same with `--no-commit` and no `-m`.
Measured on git 2.54.0: a `pre-merge-commit` hook runs on an unpinned merge and does not
run with this invocation; with `merge.autoStash=true` inherited and no `--no-autostash`,
an overlapping edit that must be refused is stashed and the file overwritten; and, for a
rewritten pointer file, discovery follows it while explicit `--git-dir` does not.
Snapshots use `read-tree`, `add`, `write-tree`, `commit-tree` and `update-ref` under
`GIT_INDEX_FILE`, which run no hooks.

> **Guard G26, G29 and G13.** Pinned binary, pinned flags, explicit paths.

### 16.1 One workspace set per conversation

Refs `refs/heads/chatroom/<project-short>/<conversation-short>/{claude,codex,integration}`,
all starting at main's HEAD. `conversations.main_branch_ref` records the main worktree's
symbolic branch at creation. Worktrees under the runtime root at stable paths; admin
directory paths, checkout mode and expected pointer content recorded.

### 16.2 Snapshot

Used by `/snapshot`, by `chatroom commit`, by `/integrate` and `/sync` as their first step,
and by `/apply` for the backup. User-initiated `/snapshot` refuses while the agent has a
turn in flight; `chatroom commit` is the agent's own request and is allowed mid-turn.

Steps, each a `git_steps` row: `pointer_check`; `tree_write` (temporary index from the
branch's expected oid, add the worktree's tracked and non-ignored untracked files,
`write-tree`); `commit_write` (`commit-tree` with the message; the candidate oid is
persisted before the next step); `ref_cas` (`update-ref` with the expected old oid; sets
`expected_oid`); `index_align` (align the worktree's real index to the new commit without
touching files). Ignored files are not captured; staging state is not preserved.

### 16.3 `/integrate <agent>`

Refuses while the agent has a turn in flight. Steps: snapshot the agent; in the integration
worktree, `merge` in the single pinned form with a generated message; record the result
oid; set `expected_oid`. Conflict: `abort` step, operation `needs_user`, paths reported.

### 16.4 `/sync <agent|all>`

Steps: if main's observed HEAD is not an ancestor of integration, `merge` main into
integration in the single pinned form and record the observation as adopted; snapshot the
agent; `merge` integration into the agent branch in the agent's worktree, agent stopped, in
the single pinned form. A conflict in the agent worktree is `needs_user`; in the first
release the only resolution is `/sync --abort <agent>`, which runs the `abort` step and
leaves the pre-sync snapshot as the branch tip. Manual resolution in the agent worktree is
not supported, because committing it would move an orchestrator-owned ref outside the
orchestrator. `/import <source> <destination>` is integrate source, then sync destination.

### 16.5 `/apply [agent]`

`/apply <agent>` is integrate then apply. Steps in the user's main worktree, invoked with
`--git-dir=<common dir> --work-tree=<main worktree>`:

1. **Preconditions**, for clear messages only: integration ref exists and is not an
   ancestor of HEAD; the index equals HEAD; no `MERGE_HEAD`, `REBASE_HEAD` or
   `CHERRY_PICK_HEAD`; main's symbolic branch equals `main_branch_ref`, else `needs_user`
   with the two names shown; all orchestrator-owned refs match `expected_oid`.
2. **Preflight** (`preflight` step): compute the merge's affected paths from the merge base
   to the tip; every path the merge would add or rename to must not exist in the working
   tree, whether tracked, untracked or ignored; every path the merge would modify or delete
   must be clean against HEAD. Any violation stops here with the paths listed. Record every
   affected path's and every dirty path's pre-state in `apply_paths` (mode, oid, absent).
3. **Backup** (`backup` step): if any tracked file is dirty, snapshot main's tracked files
   through a temporary index into `refs/chatroom/<p>/<c>/backup/<operation-id>`, parented
   on HEAD.
4. **Merge** (`merge` step): the pinned invocation with `--no-commit`.
5. **Record**: git's outcome verbatim; for every `apply_paths` row, the post-merge state;
   operation `needs_user` while `MERGE_HEAD` exists.

Measured with git 2.54.0 and the pinned invocation:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Proceeds; edit preserved; tip changes staged |
| Unstaged edit on a file the tip changes | Refused by preflight, and by git: "Your local changes … would be overwritten" |
| Untracked file the tip would create | Refused by preflight, and by git |
| Ignored file the tip would create | Refused by preflight. Git alone overwrote it, with and without `--no-overwrite-ignore` |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge; ancestry is shared |

The user reviews with `git diff --cached` and commits, or runs `/apply --abort`.

**`/apply --abort`** (`abort` and `restore` steps): `git merge --abort`; then for every
`apply_paths` row, compare the current state with the recorded post-merge state. If equal,
the user has not touched the path since the merge: restore it to its pre-state, from the
backup ref for tracked dirty files, from HEAD for files the merge changed, or by deletion
for paths the merge created. If not equal, leave it and mark the path `needs_user` with
both states shown. Finally delete the backup ref when no path remains `needs_user`.
Untracked and ignored files are never touched by either step. `/apply --commit`
(**proposed**) commits immediately.

> **Guard G13, G28 and G31.** Native merge, pinned, explicit paths, with two-state
> restore and Chatroom's own collision preflight. Do not reintroduce the synthetic commit,
> the applied-oid marker or the per-path journal; do not restore a path whose current state
> differs from its post-merge state; do not rely on `--no-overwrite-ignore`.

### 16.6 Cleanup safety

`chatroom clean` snapshots and removes managed worktrees and retired IPC, keeping
conversations, authority and refs. `chatroom reset` removes both roots and owned refs,
backup refs included, only after all agents stop, every dirty worktree is snapshotted or
explicitly discarded, each ref matches its ownership token, and no non-Chatroom worktree
depends on it.

### 16.7 Git operation recovery

On startup, for every operation left `planned` or `executing`, each step is classified by
reading its target ref, the candidate oid, and the worktree state:

| Step | Classification |
|---|---|
| `pointer_check` | rerun |
| `tree_write` | rerun; a temporary index is disposable |
| `commit_write` | if `candidate_oid` is recorded and the object exists: done; else rerun |
| `ref_cas` | ref equals expected old oid: not done, rerun with the recorded candidate; ref equals candidate: done; otherwise `needs_user` with both oids |
| `index_align` | compare the worktree's index tree with the ref's tree: equal is done, else rerun |
| `merge` in a Chatroom worktree | ref is a commit whose parents are (expected old, source): done; `MERGE_HEAD` present: run `abort`, mark `failed`; ref equals expected old with no `MERGE_HEAD`: not done, rerun |
| `merge` in main | `MERGE_HEAD` present: `needs_user` with commit or abort; a merge commit with the tip as second parent exists on the branch above the recorded pre-HEAD: done by the user; HEAD equals pre-HEAD with no `MERGE_HEAD`: rerun only if index equals HEAD and every `apply_paths` pre-state verifies, else `needs_user` |
| `backup` | ref present: done; absent: rerun |
| `preflight` | rerun |
| `restore` | per path as in §16.5; unfinished paths stay `needs_user` |
| `abort` | `MERGE_HEAD` absent: done; else rerun |

A `MERGE_HEAD` in main with no Chatroom operation is not Chatroom's and is never touched.

> **Guard G27.** Classify by oids and recorded states; never assume an abort is possible;
> never retry an apply on an unverified tree.

---

## 17. Conversations

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one when none exists. |
| `chatroom new [name]` | Create conversation, refs and worktrees; record main's branch. |
| `chatroom list` | Conversations, agents, workspace state, integration state. |
| `chatroom continue <name-or-id>` | Verify worktrees, pointers and main's branch; open. |
| `chatroom delete <name-or-id>` | Remove worktrees, owned refs, IPC, logs and rows after confirmation. |

Switching stops or waits for active turns, snapshots both worktrees, and disconnects
drivers. A conversation holds one session per harness. Sessions are isolated from the
user's own because they live in conversation worktrees and are resumed only by explicit id.

---

## 18. REPL and commands

```text
#42 codex → @claude                                       10:07  post
  @claude Parser interface is ready; can you take the CLI?
    · claude: Edit src/cli.ts
    · codex ✓ auto-review approved: npm test (low risk)
    · codex ✓ commit 3f1c2a0 "Parser skeleton and tests"

!p3 codex requests network access to registry.npmjs.org
claude: working (linked) · codex: waiting p3 · budget 1/6 · integration +2 · guarded ✓✓✓✓✓~✓✓✓✓✓✓ · parser
> _
```

Plain input is a user message. Multi-line input is fenced with a line containing only
`"""`. Relayed approval requests get short ids and are answered asynchronously.

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, the twelve guarantee levels, checkout mode, reviewer, git binary and version, turns, held deliveries, permissions, ownership state of every Chatroom ref and pointer file, main's branch, integration state, detected customization sources. |
| `/stop <agent\|all>` | Protocol interrupt, then bounded termination. |
| `/allow <id> once\|session`, `/deny <id> [reason]` | Resolve a relayed approval request. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot <agent\|all>` | §16.2; refuses while the agent runs. |
| `/integrate <agent>` | §16.3; refuses while the agent runs. |
| `/sync <agent\|all>`, `/sync --abort <agent>`, `/import <src> <dst>` | §16.4 |
| `/apply [agent]`, `/apply --abort`, `/apply --commit` | §16.5 |
| `/show quiet\|activity\|full`, `/focus <agent\|all>` | Display controls. |
| `/history [N]` | Reprint messages. |
| `/doctor [--smoke]` | Capability and boundary diagnostics. |
| `/quit` | Stop turns, flush, release the lock. |

External: `chatroom log [--jsonl] [--verify]`, `doctor`, `clean`, `reset`, and the
agent-only `post`, `reply`, `ask`, `inbox`, `hook`, `commit`.

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
| `security.web_tools` | `false` | Allow native web tools. |
| `security.browser` | `false` | Allow browser tools. |
| `security.subagents` | `false` | Allow Codex nested agents. Claude subagents are always allowed. |
| `security.mcp_allowlist` | empty | MCP servers and apps permitted in `guarded` and `strict`. |
| `security.secret_paths` | §15.2 defaults | Denied read paths, both harnesses. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_deny_patterns` | §8.1 defaults | Environment variables removed at spawn. |
| `security.env_allow` | empty | Names kept despite matching a deny pattern. |
| `security.harden_native_search` | `false` | Disable Grep and Glob for an enforced `searchReads`. |
| `security.claude_auto_allow_sandboxed_bash` | `true` | Proposed; §15.2. |
| `workspace.claude_checkout` | `auto` | `auto` (linked if enforced, else detached), `linked`, `detached`. |
| `workspace.state_dir` | platform default | Parent for per-project runtime roots. |
| `workspace.link_worktrees` | `true` | Proposed: the `.chatroom/worktrees` symlink. |
| `logging.raw_events` | `false` | Persist vendor raw streams. |
| `logging.retention_days` | `30` | Raw log and receipt retention. |
| `display.level` | `activity` | `quiet`, `activity`, `full`. |
| `brief.extra` | empty | Size-capped project guidance appended to both briefs. |

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

Raw vendor streams are off by default. Chatroom never records environment-variable values.

---

## 21. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Session suspect; resume and recovery turn; rebuild if that fails. |
| Crash during a git operation | Steps classified per §16.7; nothing reset; `needs_user` where ambiguous. |
| Orchestrator-owned ref moved by anyone else | `ref_tampered`; integration blocked; restore command printed; ref never reset. |
| Worktree `.git` pointer altered | `pointer_tampered`; git operations blocked for the conversation; restore command printed. |
| `main` moved by the user | Observed; `/sync` adopts it. |
| Main worktree switched to another branch | `/apply` is `needs_user` until the user confirms or switches back. |
| Agent runs a native git write command | Fails; the agent uses `chatroom commit`. |
| `chatroom commit` with nothing to commit | Receipt says so; no ref change. |
| Apply refused by preflight or git | Main unchanged; paths or git's message shown. |
| Apply conflict | `needs_user`; `/apply --abort` restores paths whose state still equals the post-merge state, reports the rest. |
| Sync conflict | `needs_user`; `/sync --abort` only in the first release. |
| Write-boundary, git-write or login probe fails | `guarded` and `strict` refuse to start that agent. |
| Claude linked mode not enforced | Driver switches to detached checkout; if that fails too, refuses. |
| Legacy Codex sandbox found effective | `guarded` and `strict` refuse Codex with the config source shown. |
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
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied.
- `codex exec resume` has no `--cd` or `--sandbox` (0.153.3).
- App-server schema on 0.153.3: thread, turn, steer, interrupt, review, approval and
  auto-review methods and enums; `GuardianApprovalReviewStatus` "[UNSTABLE]".
- Claude 2.1.261 flags as listed in §10.1. `node:sqlite` loads on Node 25.1.0.
- 2026-09-05, git 2.54.0 with the pinned invocation: the `/apply` results of §16.5; with
  `merge.autoStash=true` and no `--no-autostash`, the overlapping case proceeds and stashes
  the user's edit; a `pre-merge-commit` hook runs unpinned and not pinned; an ignored file
  in the way of a tracked path was overwritten with and without `--no-overwrite-ignore`,
  under both the ort and recursive strategies. Two git binaries on `PATH`.
- 2026-09-05, git 2.54.0, linked worktree: `--git-dir=<admin> --work-tree=<wt>` gives
  correct `status` and `log`; after rewriting `<wt>/.git` to `gitdir: <fake repo>`,
  discovery reports the fake repository and explicit `--git-dir` still reports the real
  one; a broker-style snapshot through `GIT_INDEX_FILE`, `read-tree`, `add -A`,
  `write-tree`, `commit-tree` and `update-ref` works with explicit paths; with `<wt>/.git`
  removed, discovery fails, `GIT_DIR` plus `GIT_WORK_TREE` give correct `status` and
  `log`, `git worktree list` marks the entry prunable, and `git worktree lock` prevents
  pruning.
- 2026-09-05, Codex 0.153.3 under `codex sandbox` with `CODEX_HOME` pointing at a scratch
  config: a profile without a system read grant cannot start `sh`; `":root" = "read"` and
  `"/" = "read"` are both accepted; `"~/.ssh" = "deny"` inside the root read holds; a
  `"read"` entry for a file inside a `"write"` directory denies writes to that file; a
  `-c default_permissions` override took effect with `sandbox_mode = "read-only"` and with
  `sandbox_mode = "workspace-write"` loaded from the config file; overriding both
  `sandbox_mode` and `default_permissions` did not raise an error.

### Documented

- Claude sandboxing: Bash-only OS sandbox; default write scope; linked-worktree allowance
  for the shared `.git` "so commands such as `git commit` can update refs and the index.
  Writes to `hooks/` and `config` inside that directory remain denied"; read precedence
  "the more specific path wins"; domain prompting "or in auto mode sends the request to
  the classifier"; `strictAllowlist` scope "sandboxed commands only; in-process tools such
  as `WebFetch` still follow their permission rules"; permission rules "apply to every
  tool: Bash, Read, Edit, WebFetch, MCP".
- Claude permissions: `Read(//path)`, `Edit(//path)`; a Read deny blocks Edit and Write; Grep
  and Glob best-effort; deny rules take precedence.
- Claude hooks, headless, sessions, Agent SDK: as in earlier versions.
- Codex configuration: `shell_environment_policy` defaults; `mcp_servers.<id>.enabled`;
  `apps.<id>.enabled`; `web_search` "`disabled | cached | indexed | live`";
  `agents.enabled`; `browser_use.default_origin_policy`; profiles govern sandboxed
  commands only.
- Codex permissions: profile keys; "More specific entries override broader entries … deny
  takes precedence over write, and write takes precedence over read"; Beta; "Configure
  either `default_permissions` and `[permissions]`, or `sandbox_mode` /
  `sandbox_workspace_write`, but not both."
- Codex Auto-review and app-server: as in earlier versions.
- git-merge man page: `--abort` "will in some cases be unable to reconstruct the original
  (pre-merge) changes"; `--no-overwrite-ignore` "Use --no-overwrite-ignore to abort".

### Phase 0: verify before building the scheduler

1. `node:sqlite` durability suite on the oldest supported Node LTS.
2. Claude CLI: several sequential turns in one `-p` stream-json process; `--resume` later.
3. Claude hook from inline `--settings` fires in `-p` mode; setting-source interaction.
4. Claude permission control request and response wire shapes.
5. `thinking` blocks in the Claude stream; whether `--verbose` is needed.
6. Claude boundary matrix through shell and native tools, including the pointer file, a
   canary secret variable, toolchain reads, a package install with an extra write root,
   `WebFetch` denied, and a sandboxed `curl` to a non-allowlisted host denied without a
   prompt.
7. Claude git, linked mode: `denyWrite` on the common directory and on `<wt>/.git` revokes
   the automatic allowance; `git log`, `diff`, `status` work with `GIT_OPTIONAL_LOCKS=0`;
   `git commit` and `git stash` fail; `chatroom commit` works. If not enforced: the same
   matrix in detached mode, plus that Claude Code itself behaves with `GIT_DIR` and
   `GIT_WORK_TREE` in its environment.
8. Claude setting-source combination that drops user and project hooks and MCP servers
   while keeping `CLAUDE.md`; whether Claude subagents inherit the sandbox and rules.
9. Claude login probe.
10. App-server: the §15.3 overrides accepted through `config`; the effective policy is
    readable and reports the profile, not the legacy sandbox, with the user's real
    `config.toml` present; reviewer accepted and reported; routine command auto-approved;
    escalation reaches `requestApproval`; `web_search`, `agents.enabled`, per-id MCP and
    app disables and the browser origin policy take effect; `turn/steer` against a
    finishing turn.
11. Codex boundary matrix under the profile, including the admin directory and the pointer
    file, and `chatroom commit`.
12. Codex `exec` fallback: overrides via `-c` on start and resume.
13. What each harness records after a kill mid-generation.
14. Effective tool-command timeouts of both harnesses.
15. `/apply --abort` two-state restore against a case where git's own abort loses a dirty
    change, and against a user edit made after the merge.
16. Recovery classification of §16.7 against a crash injected after each step of every
    operation.

---

## 23. Verification and testing strategy

- **Model-free core tests** with fake drivers: the invariants of §2 under crash injection at
  every boundary.
- **IPC security tests**: partial, duplicate, hard-linked, symlinked, directory, FIFO,
  sparse, traversal, replaced-subdirectory, parallel-reader, stale-turn cases.
- **Boundary matrix**: every `guarantees` entry on both harnesses, positive and negative,
  through shell and native tools; environment canary; hosted-tool absence; pointer file.
- **Broker tests**: a commit mid-edit yields a consistent snapshot of what was on disk;
  concurrent commit requests serialize; nothing-to-commit returns a clean failure; a
  rewritten pointer file is detected and the broker refuses.
- **Ref-ownership tests**: an external move of an owned ref is detected after the next turn
  and blocks integration; a `main` move is adopted by `/sync`; a branch switch in main
  blocks `/apply`.
- **Git matrix**: file kinds including symlinks, mode changes and deletions; sequential
  snapshots and integrations; both agents on the same and different files; main advancing
  before `/sync` and before `/apply`; the seven `/apply` states; repeated apply after
  commit; `/apply --abort` in every case, including one where git's own abort does not
  restore and one where the user edited a file after the merge; sync conflicts and their
  abort; crash after each step of every operation with §16.7 classification; hooks never
  run; autostash never engages; signing never attempted; discovery never used.
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
  workspace/  git.ts (binary, explicit paths, pinned invocation), repository.ts, checkout.ts,
              snapshot.ts, broker.ts, merge.ts, refs.ts, backup.ts, apply.ts, steps.ts,
              recovery.ts
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
   every hard denial has a negative test.
1. **Durable room core.** Schema, migrations, mirror; target resolution; delivery records
   and budget; startup reconciliation; fake drivers and property tests. Exit: crash
   injection cannot lose or duplicate logical messages.
2. **IPC and agent commands.** Layout, import, receipts, retry, limits, quarantine; the six
   agent commands; security suite. Exit: every accepted operation has one durable result
   and no orchestrator path can be redirected by an agent-controlled entry.
3. **Drivers, read-only.** Claude CLI in auto mode with hook delivery; Codex app-server with
   Auto-review and steering; `exec` fallback; scrubbed environments; minimal recovery. Exit:
   both agents chat concurrently and receive a mid-turn message.
4. **Guarded work.** Runtime roots; linked or detached checkout per probe; Claude sandbox
   and deny rules; Codex profile with policy read-back; read-only git directory, admin
   directories and pointer file; the explicit-path broker; ref and pointer ownership
   checks; probes for all twelve guarantees; modes. Exit: each agent edits, tests and
   checkpoints in its own worktree, reads main, peer and toolchains, cannot read secrets,
   cannot reach the network or hosted tools, and cannot write main, peer, IPC, the database,
   any part of the git directory or the pointer file.
5. **Git collaboration.** Explicit-path pinned invocation, snapshots with the finer steps,
   `/integrate`, `/sync` with abort, `/import`, `/apply` with preflight, backup, two-state
   abort and the branch check, step recovery, the Git matrix. Exit: the seven `/apply`
   states behave as measured and every abort either restores a path exactly or reports it.
6. **Later.** Sync conflict resolution through the orchestrator; conflict-resolution turns;
   checkpoints; archive and delete; retention and `gc`; `/review`; `/apply --commit`;
   rendering polish.

> **Guard G20.** Keep the cut line.

---

## 26. Open decisions

1. Claude setting sources in guarded mode.
2. `/apply --commit` (proposed).
3. Raw activity defaults.
4. Sync conflict resolution route for a later release: `/sync --resolve <agent>`, where the
   user resolves files and the orchestrator commits, versus a `/resolve` agent turn.
5. Inactive worktree policy (later).
6. Fallback support floor without app-server.
7. Convenience symlink (proposed).
8. `/tmp` under the Codex profile.
9. Grep and Glob hardening default.
10. `chatroom commit` during an in-flight tool call.
11. Whether to prefer the detached checkout for Claude even when linked mode probes as
    enforced, for one fewer moving part, at the cost of the `git -C` caveat.

---

## 27. References

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
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- git-merge and git-worktree manuals: `git merge --help`, `git worktree --help`

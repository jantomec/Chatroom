# Chatroom Architecture

Status: implementation baseline, 2026-09-07. Phase 0 (§22) ran on 2026-09-07: its probes
live under `probes/`, their recorded streams under `probes/fixtures/`, and every claim they
settled is in §19 with the tool version. No scheduler code exists yet.

Observed on the development machine: Claude Code 2.1.263 (2.1.261 for the entries of §19
that name it), Codex CLI 0.153.3, Node 25.1.0, git 2.54.0 (Homebrew) and 2.50.1 (Apple),
both on `PATH`. Versions are evidence for the smoke tests, not compatibility promises.

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

1. **Two writers corrupt each other.** Each agent writes only its own worktree. Both
   sandboxes bound shell writes to the working directory by default, Codex's file edits go
   through its sandbox, and permission rules bound Claude's native edits to the peer and
   integration worktrees and the coordination state. Claude's native edits to the main
   tree are held by the brief and the auto-mode classifier, as in solo use, because a rule
   there closes the git allowance that native commits need (§15.1). For git metadata the
   rule is enforced where the harness allows scoping and otherwise held by norm and
   detection, as it is when the user runs the harness alone (§15.4).
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

> **Guard G25.** Prompt before mechanism. When a mechanism would interfere with how the
> models perform, add machinery to the chatroom, or leave the user unable to tell what is
> happening, the rule goes into the brief instead; the user runs frontier models, which
> follow it. The first application: the main-tree deny rules of §15.1 were dropped when
> they were measured to close the git allowance, and the brief's "never write there" is
> what holds. User decision, 2026-09-07.

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
| G25 | Prompt before mechanism. Where a rule would interfere with how the models perform, complicate the app, or make it hard for the user to see what is happening, the brief carries it instead. | User decision, 2026-09-07: frontier models follow the brief; enforced complexity hides what is going on. |

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
 │  REPL: transcript · activity · permissions · status bar · slash commands     │
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
| REPL | Input, transcript, activity, relayed prompts, status bar (§17.1), commands. |
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
without the variable and leaves it alone with it. The Codex driver does not rely on
`shell_environment_policy` filters: measured on 0.153.3, `inherit = "none"`,
`ignore_default_excludes = false` and a `filters` exclude entry all left `HOME`, `PATH` and a
`*TOKEN*` variable visible to the agent's commands, while `set` entries were applied (§19).
The scrubbed process environment is the only mechanism; app-server and `exec` commands
inherit it. The turn's
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
`chatroom hook` writes its ack on every invocation, with an empty list when nothing was
pending, and copies `effort.level` and `cwd` from the hook input into the ack's payload;
the dispatcher hands those two fields to the driver as a status report (§17.1).

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

type SessionStatus = {            // status bar, §17.1
  model: string | null;           // as the harness reports it
  effort: string | null;          // as the harness reports it
  cwd: string | null;             // as the harness reports it
  contextTokens: number | null;   // input side of the most recent model request
  contextWindow: number | null;   // as the harness reports it
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

`events()` yields a `status` event carrying a `SessionStatus` whenever one of its fields
changes. A driver fills a field only from what the harness sent; a configured value is not
a report, and the REPL shows `default` in its place (§17.1).

### 9.1 What `chatroom doctor` checks

- Both executables and versions; the git binary and version; `node:sqlite`.
- Claude's session is authenticated with the user's login, not an API key.
- A session starts, ends a turn, and resumes by id; the hook fires and its context reaches
  the model; steering or hook delivery works.
- **Write boundary**, through a shell command and through the harness's native file tool:
  a write inside the own worktree succeeds; shell writes into the main tree, the peer
  worktree, the integration worktree and the IPC directories fail, and so do native writes
  into all of those except, on Claude, the main tree, which the brief covers (§15.1).
  `writeBoundary` false refuses that agent, because rule 1 of §0.1 is hard for those
  paths.
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
  --permission-mode auto --permission-prompts host --permission-prompt-tool stdio \
  [--model <model>] [--effort <level>]
```

Working directory: the conversation's Claude worktree. Environment: §8.1. A turn is one
`user` message on stdin and the `result` event that ends it; the CLI queues further input,
so the driver writes input only when the scheduler starts a turn. `longLivedProcess` true,
so resume happens once per chatroom run; if the process dies the driver reconnects with
`--resume` and reports `session: suspect`. `nativeSteering` false; `hookDelivery` true.
Reply text and cost come from `result`; activity from `assistant` events: `text` blocks,
`tool_use` blocks, `thinking` blocks if present. The system prompt and settings are not
persisted with the session and are passed on every process start. The user's settings,
hooks, MCP servers and `CLAUDE.md` load as they would in solo use. Measured on 2.1.263
(§19): the `system` init event is emitted only after the first user message, so the driver
sends the first turn before it expects one; three sequential turns ran in one process and
closing stdin ended it with exit 0 within a second; `--resume <id>` in a new process
reported the same `session_id` and the worktree `cwd`, and remembered a hook delivery from
the earlier process; after a SIGKILL during a tool call, `--resume` recovered the session,
though the killed tool call was not in the model's memory.

The hook, registered in the inline settings for both tool outcomes, because the docs
say `PostToolUse` runs "after a tool call succeeds" and `PostToolUseFailure` "after a tool
call fails", and a run of failing commands must not delay delivery (measured: fourteen
failing commands in one turn fired `PostToolUse` twice):

```json
{"hooks": {
  "PostToolUse":        [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}],
  "PostToolUseFailure": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` reads the hook event on stdin, drains `CHATROOM_DELIVERY_DIR`, writes a
`delivery_ack`, and if anything was pending prints
`{"hookSpecificOutput": {"hookEventName": "<the input's hook_event_name>", "additionalContext": "<delivery text>"}}`;
the CLI rejects output whose `hookEventName` differs from the event that ran the hook
(measured: "Hook returned incorrect event name"). The `PostToolUseFailure` input carries
`error`, `is_interrupt` and `duration_ms` next to the common fields.
Hooks run as ordinary child processes of Claude Code, outside the Bash sandbox, with the
driver's environment. An agent generating text without tool calls hears nothing until its
next tool call or the end of its turn, in which case the batch returns to `queued`.

Auto mode: the classifier decides routine actions; the rest arrive as control requests on
stdout, are recorded with `reviewer: user`, shown in the REPL with a short id, and answered
on stdin. The stdout route needs `--permission-prompt-tool stdio` next to
`--permission-prompts host`: measured on 2.1.263, without it a prompt is denied at once
with a `permission_denied` system event and nothing reaches stdout; with it the CLI writes
`{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,
"input":…,"permission_suggestions":[…],"blocked_path":…,"tool_use_id":…}}` and accepts
`{"type":"control_response","response":{"subtype":"success","request_id":…,"response":
{"behavior":"allow","updatedInput":…}}}` or `{"behavior":"deny","message":…}` on stdin. A
`{"subtype":"initialize"}` control request is answered with the command catalogue but does
not enable the route. The alternative route, `--permission-prompt-tool mcp__<server>__<tool>`
with a Chatroom-provided MCP server, was measured to work as well and is the fallback if a
release drops the stdio value. The long-lived process passed Phase 0, so the one-process-
per-turn fallback is not used.

Status (§17.1). `--model` and `--effort` are passed only when `driver.claude.model` or
`driver.claude.effort` is set; an unset key leaves the user's own model and saved effort in
force, as in solo use. The driver reports the model and the working directory from the
`system` init event, the context tokens from each `assistant` event's `message.usage` as
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, the input-only
formula the Claude Code status line documents for its `used_percentage`, and the context
window from `modelUsage[<model>].contextWindow` on each `result`; `modelUsage` is a map with
one entry per model the session used, side calls included (measured: a `claude-haiku-4-5`
entry next to the session model), so the driver reads the entry whose key equals the init
event's `model`, which is the model name without the user's `[1m]` suffix and reports the
1M window. `thinking` content blocks did not appear in `assistant` events at effort
`xhigh`; the stream carries `system/thinking_tokens` events with an `estimated_tokens`
count instead, so activity shows a thinking counter, not text. The effort in force is
not in the stream, and the docs say the init event omits it; it is in every hook input as
`effort.level`, next to `cwd`, so `chatroom hook` copies both into its `delivery_ack`
(§8.2). A turn without a tool call reports no effort; the bar keeps the last report, or
shows `default` before the first.

> **Guard G2, G3, G5.** CLI on the subscription; `auto` with host-relayed prompts; the hook
> is the injection channel. Everything the Agent SDK offers is a wrapper around these flags,
> and the SDK docs direct SDK users to API keys.

---

## 11. Codex driver

`codex app-server` over stdio, JSON-RPC. `thread/start` or `thread/resume` with `cwd`,
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and a `config` override
map carrying the profile of §15.2 as nested objects, measured:
`{"default_permissions": "<name>", "permissions": {"<name>": {"filesystem": {…}}},
"shell_environment_policy": {"set": {…}}}`. The response's legacy `sandbox` field then
reads `workspaceWrite` with `writableRoots` equal to the profile's write entries, which is
how the driver confirms the profile loaded; no `thread/settings/updated` follows
`thread/start`, `activePermissionProfile` is absent from the response, and
`permissionProfile/list` names only the built-in profiles. A `default_permissions` value
without a matching table fails `thread/start` with "failed to load configuration", which is
where the legacy fallback below is decided. `turn/start`;
`turn/steer` with `expectedTurnId`, measured to be accepted during a running command and
rejected after the turn ended with error `-32600` "no active turn to steer"; `turn/interrupt`. Streamed items become driver events:
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
escalation and unavailability fall back to the user visibly. Measured on 0.153.3 (§19): an
escalation the model requested with `sandbox_permissions: "require_escalated"` went to
Auto-review and no `requestApproval` reached the client; `item/autoApprovalReview/started`
and `/completed` carried `review.status`, `riskLevel`, `userAuthorization` and `rationale`,
and a `guardianWarning` notification repeated the decision in prose. Auto-review approved
an escalated write into the main tree because the turn's input had authorized one rerun;
under the profile the approved rerun still failed with "operation not permitted" and no
file was written, while under legacy `workspace-write` an approved escalated `git commit`
ran unsandboxed and succeeded. What Auto-review approves follows what the turn input
says, and a turn input carries the peer's messages as well as the user's.

Fallback, if app-server probing fails: `codex exec --json -o <file> -c … -` and
`codex exec resume <thread-id> --json -o <file> -c … -`, with the same overrides passed
through `-c`, the profile table as a TOML inline table
(`-c 'permissions.<name>.filesystem={ ":root" = "read", "<path>" = "write", … }'`,
measured); `exec resume` has no `--cd`, so the working directory comes from spawning in
the worktree, measured to hold. The JSONL stream carries `thread.started` with
`thread_id`, `turn.started`, `item.started`, `item.completed` and `turn.completed`. There are no approvals, Auto-review or steering on this path: an action that
would need approval fails, the agent reports it, and the user performs it. Hook delivery
is enabled only when Chatroom's hook is the sole non-managed hook source, because the trust
bypass runs every enabled hook from every layer.

Status (§17.1). `model` on `thread/start` and `model_reasoning_effort` in the `config` map
are set only from `driver.codex.model` and `driver.codex.effort`. The `thread/start` and
`thread/resume` responses carry `model`, `reasoningEffort` and `cwd` (measured:
`gpt-5.6-sol` and `xhigh` from the user's `config.toml`, `low` when the config map sets
`model_reasoning_effort`);
`thread/settings/updated` carries them again when they change; `thread/tokenUsage/updated`
carries `tokenUsage.last` and `tokenUsage.modelContextWindow` (measured: 258400 for
`gpt-5.6-sol`, non-null on every update during a turn), and the context tokens are
`last.inputTokens` alone: measured and documented alike, the cached count is below the
input count, so it is not added again.
The schema also defines a `model/rerouted` notification, whose fields Phase 0 records
before the driver uses it. Under `exec`, `turn.completed` carries `usage.input_tokens` and
nothing carries the model, the effort or the window, so those cells show the configured
value or `default` and the context cell shows a token count.

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
when it integrates. A `packed-refs.lock` error from `git commit` is harmless." when
`nativeCommit` probed true, and "Committing is unavailable in this session; Chatroom
snapshots your work when it integrates." otherwise. `brief.extra`
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

One rule is hard for the shell on both harnesses and for every native write outside the
main tree: an agent writes working-tree files only in its own worktree, the drop root and
the scratch root, and never in Chatroom's coordination state. Claude's native edits to
the main tree are the one place the rule is carried by the brief (G25, §15.1). Everything
else is parity with solo use.

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
      "Edit(//<peer worktree>/**)",   "Write(//<peer worktree>/**)",
      "Edit(//<integration worktree>/**)", "Write(//<integration worktree>/**)",
      "Edit(//<ipc root>/<peer>/**)", "Write(//<ipc root>/<peer>/**)",
      "Edit(//<ipc root>/<me>/to-agent/**)", "Write(//<ipc root>/<me>/to-agent/**)",
      "Edit(//<ipc root>/<me>/staging/**)",  "Write(//<ipc root>/<me>/staging/**)",
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
  directory remain denied." That is what makes native commits work: measured on 2.1.263
  with the sandbox alone, `git commit` in the linked worktree landed on the own branch.
  `allowUnsandboxedCommands: false` is the one setting that keeps the rule hard; without it
  the classifier could approve a rerun outside the sandbox.
- **`denyWrite` inside the shared `.git`** narrows the allowance to the agent's own admin
  directory, the object store and its own ref. Measured on 2.1.263: the entries take
  effect inside the automatic allowance. With them, `git commit` moved only the own
  branch, while `git update-ref refs/heads/main`, a write into the peer's admin
  directory, an update of the peer and integration refs and `git pack-refs` were all
  refused; without them, the same session moved `main` and wrote into the peer's admin
  directory. Git metadata on Claude is therefore scoped as it is on Codex.
- **Permission deny rules feed the sandbox.** Measured: every `Edit` and `Write` deny rule
  also denies sandboxed commands, by path prefix. A deny over the whole IPC root blocked
  `chatroom post`'s own drop file, so the IPC rules name only the peer's directory and the
  own `to-agent/` and `staging/`. A deny over the main tree covers `<main>/.git`, which is
  the shared git directory, and closes the linked-worktree allowance: `git commit` then
  fails on `index.lock` in the agent's own admin directory. No narrower `allowWrite` of
  the git directory reopens it, since deny wins for writes, and a character class in a
  rule (`[!.]*`) matches nothing. A main-tree rule would therefore cost Claude its native
  commits, so there is none (G25, user decision 2026-09-07): native `Edit` and `Write`
  into the main tree are decided by the auto-mode classifier and the brief's "never write
  there", as in solo use, while shell writes into the main tree stay blocked by the
  sandbox's default scope and commits work.
- **Native tool writes** are denied for the peer and integration worktrees and the
  orchestrator-owned IPC directories, none of which sits above the git directory. The own
  drop and scratch roots are left out of the deny rules because a deny there would also
  block the shell; `chatroom post` writes its drop file through the Bash `allowWrite`.
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
alike; with them, `git commit` succeeds and `main` does not move. With git 2.54.0 the commit
also prints "error: Unable to create '…/packed-refs.lock': Operation not permitted" and
still succeeds, because that version locks `packed-refs` during a ref update and the
profile denies it; 2.50.1 does not touch the file. `packed-refs` stays denied and the
brief names the message as harmless. Codex runs commands through `/bin/zsh -lc`, so the
git an agent uses is the login shell's, whichever the orchestrator pinned. `:root` and `/` are both
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
allows it, measured on Codex through the profile and on Claude through `denyWrite` inside
the linked-worktree allowance, and otherwise relies on the brief's instruction not to touch other refs, on
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
clara  working     fable · high     chatroom/…/claude  ~/…/9f3c/claude  ctx 37%
phil   waiting p3  gpt-5.5 · medium  chatroom/…/codex   ~/…/9f3c/codex   ctx 12%
main   feature/parser  ~/Projects/app   budget 1/6 · integration +2 · task parser
> _
```

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, turns, held deliveries, permissions, refs and expectations, worktree attachment, main's branch, git binary, native-commit availability; the status bar's values with their source and age (§17.1). |
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
| `driver.claude.effort`, `driver.codex.effort` | vendor default | Effort override: `--effort` on Claude, `model_reasoning_effort` on Codex (§17.1). |
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
| `display.status_bar` | `true` | Show the status bar (§17.1); `false` leaves only the prompt. |
| `brief.extra` | empty | Project guidance appended to both briefs. |
| `workspace.state_dir`, `workspace.link_worktrees` | platform default, `true` | Runtime root; proposed symlink. |

Unknown keys are errors in project config. A config fingerprint is recorded with each turn.

Activity kinds: `text`, `reasoning_summary`, `tool`, `tool_result`, `permission`, from
`assistant` events on Claude and `item.*` events on Codex. Raw vendor streams are off by
default, size-capped, and removable. Chatroom never records environment-variable values.

### 17.1 Status bar

The lines directly above the prompt are a status bar: one line per agent and one for the
room, redrawn in place with the input line whenever a value changes. The bar never wraps
and never uses the alternate screen, so the REPL stays line-oriented (§1.1).

```text
clara  working     fable · high     chatroom/…/claude  ~/…/9f3c/claude  ctx 37%
phil   waiting p3  gpt-5.5 · medium  chatroom/…/codex   ~/…/9f3c/codex   ctx 12%
main   feature/parser  ~/Projects/app   budget 1/6 · integration +2 · task parser
```

| Column | Value | Source |
|---|---|---|
| state | `idle`, `working`, `waiting <id>` for a relayed approval, `held` while the budget holds its trigger, else the session state of §13 when it is not `healthy` | orchestrator |
| model, effort | what the harness reports for the session | driver `status` event (§9, §10, §11) |
| branch | the branch the worktree's `HEAD` named at the last expectation refresh; `detached` after a `worktree_detached` event | workspace manager (§16.1) |
| directory | the worktree path, `$HOME` as `~`, middle components elided first when the terminal is narrow | workspace manager, checked against the harness's reported `cwd` (§13) |
| context | the input side of the agent's most recent model request as a percentage of the model's context window | driver `status` event |
| room line | main's branch and path, credits used of `autonomy.limit`, integration commits ahead of main, the open task with the newest activity | orchestrator, workspace manager |

Context is measured the same way on both harnesses: the tokens the most recent request
sent as input. On Claude that is `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` from the newest `assistant` event, the formula the Claude Code
status line documents for its own `used_percentage`; on Codex it is
`tokenUsage.last.inputTokens` from the newest `thread/tokenUsage/updated`. Output tokens
are not counted. The window is `modelUsage[<model>].contextWindow` from the newest Claude
`result` and `tokenUsage.modelContextWindow` on Codex. Both figures update during a turn.
Claude's window is known only after the first `result` of the session, and `exec` never
reports one; without a window the cell shows the token count. Measured windows: 1000000
for `claude-fable-5-1` with the user's `[1m]` model setting, 258400 for `gpt-5.6-sol`. A rebuilt session (§13)
resets the cell to unknown.

Nothing on the bar is a configured value presented as a report. When Chatroom passed no
model or effort and the harness reports none, the cell reads `default`; when the harness
reports a value, that value is shown even where it differs from the configuration, since
Claude falls back to the highest effort the model supports and Codex can reroute a model.
A cell with no report at all reads `n/a`. `/status` lists the same values with their
source and the age of each report.

> **Comment.** Claude Code's own status line receives the same fields, but the docs
> present it as part of the interactive interface and do not say whether its command runs
> under `-p`, whereas every hook input carries `effort.level` and `cwd` by documentation and
> the event stream carries usage per request. Chatroom reads what it already receives
> rather than registering a second command. On Codex the app-server notification carries
> the values directly, and `exec` reports no window.

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
| A status cell has no harness report | `default` for model and effort, a token count for context without a window, `n/a` otherwise; configuration is never shown as a report (§17.1). |

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
- **Codex 0.153.3 app-server schema, status fields:** `thread/tokenUsage/updated` carries
  `tokenUsage.last` and `.total` (`inputTokens`, `cachedInputTokens`, `outputTokens`,
  `reasoningOutputTokens`, `totalTokens`, optional `cacheWriteInputTokens`) and a nullable
  `modelContextWindow`; the `thread/start` and `thread/resume` responses carry `model`,
  `reasoningEffort` and `cwd`; `Thread.model` and `Thread.reasoningEffort` are "not
  per-turn execution telemetry"; `turn/start` accepts `model` and `effort` that "Override
  … for this turn and subsequent turns"; `thread/settings/updated` carries `model`,
  `effort` and `cwd`;
  `model/list` entries carry `id`, `model`, `displayName`, `defaultReasoningEffort` and
  `supportedReasoningEfforts`; `config/read` returns `model`, `model_reasoning_effort` and
  `model_context_window`; `ReasoningEffort` is a string, "A non-empty reasoning effort value
  advertised by the model", not an enum; a `model/rerouted` notification exists.
- **Claude 2.1.261:** flags `--settings`, `--permission-prompts host|none`,
  `--permission-mode auto`, `--include-hook-events`, `--session-id`, `--resume`,
  `--input-format stream-json`.
- **Claude 2.1.263:** `--effort <level>` "(low, medium, high, xhigh, max)" and
  `--model <model>` in `--help`; `claude -p --input-format stream-json --output-format
  stream-json` with stdin at end-of-file exits 0 and prints nothing, so no init event can be
  sampled without a first message.
- **Node 25.1.0:** `node:sqlite` loads with an experimental warning.
- **git 2.54.0:** the six `/apply` states; `merge.autoStash` defeats the overlap refusal
  without `--no-autostash`; a `pre-merge-commit` hook runs unpinned and not pinned; an
  ignored file in the way is overwritten with and without `--no-overwrite-ignore`; abort
  discards changes staged after the merge and keeps unstaged ones, and fails on an unstaged
  edit to an affected file; explicit `--git-dir` ignores a rewritten `.git` pointer; a
  broker-style snapshot through explicit paths works; `git status` in a touched peer
  worktree rewrites its index without `GIT_OPTIONAL_LOCKS=0` and not with it. Two git
  binaries on `PATH`, 2.50.1 and 2.54.0.
- **Phase 0, 2026-09-07, `probes/` (Node 25.1.0 driver, Homebrew git 2.54.0 pinned for
  the orchestrator side, Claude Code 2.1.263, Codex 0.153.3):**
  - **`node:sqlite` on Node 22.23.2, 24.20.0 and 25.1.0** (SQLite 3.51.3, 3.53.4, 3.50.4):
    twelve SIGKILLs per version at random points of a writer committing three-row
    transactions under WAL and `synchronous = FULL` lost no committed group and left no
    partial group; `journal_mode` reads `wal`, `synchronous` 2, `foreign_keys` 1,
    `busy_timeout` 5000; a foreign-key violation throws `errcode` 787 and a UNIQUE violation
    2067 with `errstr` "constraint failed"; AUTOINCREMENT does not reuse a deleted id;
    ROLLBACK undoes a whole transaction; a `readOnly` connection reads committed rows while
    the writer holds `BEGIN IMMEDIATE` and refuses writes; a second writer gets `errcode` 5
    "database is locked" after its `busy_timeout`; 22 and 25 print the ExperimentalWarning,
    24 does not. About 1.8 s per version.
  - **Claude Code 2.1.263, session:** `claude auth status` reports `authMethod`
    `claude.ai` and `apiProvider` `firstParty`; the init event follows the first user
    message, carries `model` `claude-fable-5-1` (settings say `claude-fable-5-1[1m]`),
    `cwd`, `session_id` equal to `--session-id`, `permissionMode`, `apiKeySource`,
    `claude_code_version`, `capabilities`, and no `effort`; three turns in one process;
    stdin close exits 0 in 0.3 s; `--resume <id>` keeps the id and the hook delivery;
    `--include-hook-events` emits `system/hook_started` and `system/hook_response` with
    `hook_name` `PostToolUse:Bash`, `stdout`, `exit_code`, `outcome`; the PostToolUse hook
    from inline `--settings` fired and its `additionalContext` reached the model; the hook
    input carried `cwd`, `permission_mode`, `effort.level` `xhigh` with `--effort` unset
    and `low` with `--effort low`, and the environment carried `CLAUDE_EFFORT` and
    `CLAUDE_PROJECT_DIR`; each `assistant` event carries `message.model` and
    `message.usage` with the three input fields; the `result` carries `modelUsage` keyed by
    model with `contextWindow` 1000000 for the session model and a `claude-haiku-4-5`
    side entry; `rate_limit_event` and `system/thinking_tokens` messages appear; no
    `thinking` content blocks at `xhigh`; auto mode ran a `touch` in the worktree without
    any host handshake; manual mode without `--permission-prompt-tool stdio` denied the
    same `touch` with a `permission_denied` event and with the flag sent a
    `control_request` of subtype `can_use_tool` and honoured the `control_response`;
    an MCP `--permission-prompt-tool` received `tool_name`, `input` and `tool_use_id`;
    `sleep 130` is refused by the Bash tool itself ("Blocked: sleep 130 …"); SIGKILL
    during a tool call, then `--resume`: same `session_id`, recovery turn succeeded, the
    killed call absent from the model's memory.
  - **Claude Code 2.1.263, boundary (§15.1 settings, auto mode, `probes/03*`):** shell
    writes into the main tree, the peer and integration worktrees and the IPC root fail
    with "operation not permitted"; native `Write` into those and into the git directory
    is refused with "File is in a directory that is denied by your permission settings";
    shell `cat` and native `Read` of the secret path and of `.chatroom` are refused;
    `Edit`/`Write` deny rules also deny the shell by prefix: under `Edit(//<ipc root>/**)`
    the own drop-root write failed, and under `Edit(//<main>/**)` `git commit` failed on
    `index.lock` in the own admin directory; with the sandbox alone the commit landed and
    `update-ref refs/heads/main` moved `main` and a write into the peer's admin directory
    succeeded; with the `denyWrite` list alone, and with an explicit `allowWrite` of the
    git directory plus the list, the commit landed and `main`, the peer admin directory,
    the peer and integration refs and `packed-refs` were refused; an `allowWrite` of the
    git directory under the main-tree deny rule did not reopen it; `[!.]*` in a rule
    matched nothing and the commit still failed; `hooks/` and `config` in the shared git
    directory stayed denied; `--include-hook-events` showed `PostToolUse` firing for 2 of
    14 Bash calls in one turn, the successful ones; `PostToolUseFailure` fired for a
    failing call with `error`, `is_interrupt` and `duration_ms`, delivered
    `additionalContext`, and the CLI rejected output whose `hookEventName` named the other
    event; the Bash tool timeout is 120 s ("Command did not complete within its 120s
    timeout and was moved to the background"); with the final rule set of §15.1 (no
    main-tree rule) in one session: shell writes into the main tree, the peer worktree and
    the IPC root refused, the drop-root write and `git commit` succeeded with only the own
    branch moving, `main`, the peer admin directory and `packed-refs` refused, native
    `Write` into the peer and integration worktrees and the deliveries directory refused,
    native `Read` of the secret path refused, an instructed native `Write` into the main
    tree allowed by the classifier with no prompt, and the hooks fired on all 12 tool
    calls, `PostToolUse` for the 5 that succeeded and `PostToolUseFailure` for the 7 that
    failed.
  - **Codex 0.153.3 app-server:** `initialize` with `clientInfo` and `capabilities`, then
    `initialized`; `thread/start` accepted `approvalPolicy` `on-request`,
    `approvalsReviewer` `auto_review` and the §15.2 profile as a nested `config` map; the
    response's `sandbox` field listed the profile's write entries as `writableRoots`; no
    `thread/settings/updated` after start, no `activePermissionProfile` on the response,
    `permissionProfile/list` names only `:read-only`, `:workspace`,
    `:danger-full-access`; `config/read` returns the user's `model`,
    `model_reasoning_effort` and the rest of `config.toml`; a missing profile fails
    `thread/start` with "default_permissions requires a `[permissions]` table"; a routine
    command ran with no approval request and no review; `thread/tokenUsage/updated` on
    every request with `last.inputTokens`, `cachedInputTokens` below it, and
    `modelContextWindow` 258400; `git commit` in the worktree moved only the own branch
    with no approval and no review, printing the packed-refs.lock error of §15.2;
    `turn/steer` accepted during `sleep 6` and the steered word appeared in the reply,
    rejected after the turn with `-32600` "no active turn to steer"; `thread/resume` in a
    new process returned four turns, remembered the first, and showed
    `reasoningEffort` `low` from `model_reasoning_effort` in the config map; an escalated
    write into the main tree was approved by Auto-review (`riskLevel` low,
    `userAuthorization` high, rationale citing the turn input) with no `requestApproval`
    to the client, and the rerun still failed under the profile; under legacy
    `workspace-write` with `writable_roots` an escalated `git commit` was approved by
    Auto-review and succeeded unsandboxed; `shell_environment_policy.set` applied, `inherit`
    `none`, `ignore_default_excludes` `false` and `filters` did not remove any variable;
    a 25 s command completed and its output reached the model; SIGKILL mid-command, then
    `thread/resume`: the killed turn shows `status` `interrupted`, the thread is `idle`, a
    recovery turn completed. Turns took 5 to 33 s at effort `xhigh`.
  - **Codex 0.153.3 `exec`:** `-c default_permissions=… -c 'permissions.<name>.filesystem={…}'`
    accepted as a TOML inline table; `--json` emits `thread.started` with `thread_id`,
    `turn.started`, `item.started`, `item.completed` and `turn.completed` with
    `usage.input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
    `output_tokens`, `reasoning_output_tokens` and no model or window; `exec resume <id> -`
    read the prompt from stdin, ran in the spawn directory and remembered the first run;
    the commit moved only the own branch; a write into the main tree failed with
    "operation not permitted" and nothing asked for approval; the environment policy had
    the same non-effect as on app-server.
  - **Recovery classification (§16.7), model-free:** 30 cases over snapshot, integrate,
    apply and abort with a crash injected after every step, once before the row was
    recorded and once after: every snapshot crash recovered to the uncrashed end state
    with exactly one snapshot commit; a ref moved by someone else before `ref_cas` stopped
    with `needs_user` and nothing overwritten; an integration merge that crashed after
    the command was classified done by its parents; a conflicting integration merge left
    `MERGE_HEAD`, was aborted and marked `failed`; a crash between the main merge and its
    transaction classified `needs_user`, and `/apply --abort` refused for the unrecorded
    index; a crash before the merge ran reran a fresh preflight, which caught a file the
    user had created meanwhile; a merge the user committed before restart classified done
    by the user; abort with an unrecorded row classified done when `MERGE_HEAD` was gone
    and refused with a changed index. 3.2 s.

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
- **Claude Code status line and hooks:** the status line command receives `model.id`,
  `model.display_name`, `cwd`, `context_window.context_window_size` ("200000 by default, or
  1000000 for models with extended context"), `context_window.used_percentage`, "calculated
  from input tokens only: `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens`", and `effort.level`, which "Reflects the live session value" and
  is "Absent when the current model does not support the effort parameter"; it runs "once
  when a session starts" and again when "A new assistant message arrives", debounced at
  300 ms; nothing states whether it runs under `-p`. The hook common input fields include
  `cwd` and `effort`, "Object with a `level` field holding the effort level in effect when
  the hook runs", which "reports the level Claude Code ran instead" when the set level is
  unsupported and is "Present for events that fire within a tool-use context, such as
  `PreToolUse`, `PostToolUse`".
- **Claude Code stream and SDK types:** the `system` init message carries `model`, `cwd`
  and `permissionMode`; its `effort` field is one Claude Code "omits from the init message
  your application reads"; each `assistant` message carries `message.usage` with
  `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`; the `result`
  carries `modelUsage`, a map from model name to a record with `contextWindow: number`,
  cumulative across turns in a streaming-input session; `setModel()`, `supportedModels()`
  and `getContextUsage()` exist as control requests.
- **Claude Code effort:** `--effort` "Overrides the `modelSettings` and `effortLevel`
  settings for this session and does not persist"; the current models accept `low`,
  `medium`, `high`, `xhigh` and `max`; an unsupported level "falls back to the highest
  supported level at or below the one you set"; the default is `high` on every model that
  supports effort except Opus 4.7; `CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`; `/effort`
  sent through `-p` "applies to the current session only" and can report `Not applied`
  while a model-default hold is in effect, "so pass `--effort` at launch instead";
  `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` makes a native 1M model report a 200K window.
- **Codex configuration:** `shell_environment_policy.inherit` default `all`;
  `ignore_default_excludes` default true, "Keep variables containing KEY, SECRET, or
  TOKEN"; `mcp_servers.<id>.enabled`; `apps.<id>.enabled`; `web_search`; `agents.enabled`.
- **Codex permissions:** `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; the precedence sentence quoted in §15.2; Beta; "Configure either
  `default_permissions` and `[permissions]`, or `sandbox_mode` … but not both."
- **Codex Auto-review:** requires interactive approvals; `never` leaves nothing to review.
- **Codex configuration and `exec`:** `model`, "Model to use"; `model_reasoning_effort`,
  `minimal | low | medium | high | xhigh`, "Responses API only; `xhigh` is model-dependent";
  `model_context_window`, "Context window tokens available to the active model";
  `codex exec --json` emits `turn.completed` with `usage.input_tokens`,
  `cached_input_tokens`, `output_tokens` and `reasoning_output_tokens`, in the documented
  sample with `cached_input_tokens` below `input_tokens`, and no field for the model or the
  context window.
- **Codex app-server:** experimental; the per-thread `permissions` parameter is
  experimental and is not used.
- **git-merge:** `--abort` "will in some cases be unable to reconstruct the original
  (pre-merge) changes"; `--no-overwrite-ignore` is documented to abort.

### Phase 0

All items ran on 2026-09-07; the results are the "Phase 0" bullet above and the summaries
under `probes/fixtures/summaries/`. Open: the interactive comparison at the end of item 8.

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
8. Status sources (§17.1). Claude: the init event's `model` and `cwd`; `message.usage` on
   each `assistant` event, and whether `message.model` is present so a fallback model would
   show; `modelUsage[<model>].contextWindow` on the `result`; `effort.level` in the
   `PostToolUse` hook input with `--effort` set and unset. App-server:
   `thread/tokenUsage/updated` during a turn with a non-null `modelContextWindow`; the
   `thread/start` response's `model` and `reasoningEffort` with the overrides; the shape of
   `model/rerouted`. `exec`: `turn.completed.usage`. Then resume each session in the
   harness's own interface and compare its context figure with Chatroom's.

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
- **Status bar tests** with fake drivers: every cell unknown before the first report; a
  percentage only with a known window and a token count without one; `default` only when
  neither configuration nor the harness supplied a value, and the harness's value when the
  two differ; the shortening order at narrow widths; `detached` after `worktree_detached`;
  a rebuilt session resets the context cell.
- **Driver fixtures** recorded from sanitized vendor streams; live smoke tests opt-in.
- **Compatibility policy**: a vendor upgrade that changes an event shape disables that
  adapter until probe and parser pass.

---

## 21. Implementation

TypeScript on Node 22.18 or later, run without a build step through Node's type stripping,
which rules out parameter properties and enums; `node:sqlite` passed the Phase 0 suite on
22.23.2, 24.20.0 and 25.1.0, and 24 is the first line that loads it without the
experimental warning. Vendor types stop at the adapter boundary. `probes/` holds the
disposable Phase 0 probes and their sanitized fixtures; nothing in `src/` imports them.

```text
src/
  cli/        main.ts, repl.ts, agent-command.ts
  core/       orchestrator.ts, scheduler.ts, addressing.ts, budget.ts, recovery.ts
  store/      database.ts, migrations/, queries.ts, mirror.ts
  ipc/        protocol.ts, importer.ts, receipts.ts, deliveries.ts, paths.ts
  drivers/    types.ts, claude-cli.ts, codex-app-server.ts, codex-cli.ts, doctor.ts, env.ts
  workspace/  git.ts, repository.ts, snapshot.ts, merge.ts, refs.ts, apply.ts, steps.ts, recovery.ts
  ui/         renderer.ts, permissions.ts, activity.ts, statusbar.ts
  test-support/ fake-driver.ts, crash-injector.ts, scratch-repo.ts
```

The agent-command entry path imports neither the REPL, the drivers, the workspace manager,
nor a writable database connection.

---

## 22. Build order

**First usable release: phases 0 to 5.**

0. **Spikes** for every Phase 0 item in §19, later folded into `doctor`. Exit: every
   first-release driver claim has a recorded fixture. Done 2026-09-07 (§19, `probes/`),
   except the interactive comparison in item 8, which needs the user at a terminal.
1. **Durable room core**: schema, migrations, mirror, targets, deliveries, budget, startup
   reconciliation, fake drivers, property tests. Exit: crash injection cannot lose or
   duplicate logical messages.
2. **IPC and agent commands**: layout, import, receipts, retry, limits, quarantine, the five
   agent commands, security suite. Exit: every accepted operation has one durable result
   and no orchestrator path can be redirected by an agent-controlled entry.
3. **Drivers**: Claude in auto mode with the hook; Codex app-server with Auto-review and
   steering; `exec` fallback; scrubbed environment; minimal recovery; the status bar.
   Exit: both agents chat concurrently, receive a mid-turn message, and the status bar
   shows each agent's model, effort and context as the harness reported them.
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
8. Changing an agent's model or effort from the REPL, `/model <agent> <value>` and
   `/effort <agent> <level>`: Claude accepts `/model` and `/effort` as message text under
   `-p` and a `setModel()` control request; Codex accepts `model` and `effort` on
   `turn/start`. Not in the first release; the status bar shows what is in force.

---

## 24. References

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Code status line: https://code.claude.com/docs/en/statusline
- Claude Code model configuration: https://code.claude.com/docs/en/model-config
- Claude Code settings reference: https://code.claude.com/docs/en/settings-reference
- Claude Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex permission profiles: https://learn.chatgpt.com/docs/permissions
- Codex Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- git-merge and git-worktree manuals: `git merge --help`, `git worktree --help`

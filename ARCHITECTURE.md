# Chatroom Architecture

Status: implementation baseline, 2026-09-07, after Phase 0. The vendor probes under
`probes/` settled every claim in §16 about Claude Code 2.1.263, Codex CLI 0.153.3, Node
22.23.2, 24.20.0 and 25.1.0, and git 2.54.0 (Homebrew) and 2.50.1 (Apple), both on `PATH`
on the development machine. Versions are evidence for the smoke tests, not compatibility
promises. The code under `src/` implements this document; `chatroom doctor --live` is the
end-to-end check of §9.5.

How to read this document: **Guards** (§0.2) are decisions the user made; reversing one
needs the user's approval. **Measured** marks a fact taken from a probe or a scratch
experiment, with the tool version in §16. **Proposed** marks an item the user has not
decided; it can be dropped.

---

## 0. Posture

### 0.1 Parity, and prompt before mechanism

An agent inside the chatroom has the same capabilities and the same exposure as the same
harness run by the user directly in the same repository: Claude Code in auto mode, Codex
with Auto-review, the user's own settings, hooks, MCP servers, tools and network. The
chatroom adds only what two agents and an orchestrator need to share one repository
without corrupting each other's work or the user's tree.

Where a rule could be enforced by a mechanism or stated in the agent's brief, the brief
wins unless the mechanism costs nothing: the user runs frontier models, which follow
their instructions, and every enforcing mechanism is one more thing that can interfere
with the model, complicate the app, or hide from the user what is happening. Mechanisms
stay where they protect against a measured data-loss or corruption case and are invisible
in normal use: the two sandboxes that already exist in solo use, a handful of git flags,
and file-level idempotency.

Three things change when two agents share a repository:

1. **Two writers corrupt each other.** Each agent writes only its own worktree. Both
   sandboxes bound shell writes to the working directory by default, Codex's file edits go
   through its sandbox, and Claude's permission rules keep its native edits out of the
   peer's worktree and the chatroom's own directories. Claude's native edits to the main
   tree are held by the brief, because a rule there was measured to close the git
   allowance that native commits need (§12.1).
2. **A third party merges.** The orchestrator integrates and applies with native
   `git merge`, pinned flags and explicit paths, and refuses to run over a state it does
   not recognize.
3. **One model's output is the other's input.** A small autonomy budget bounds the loop,
   and the collaboration protocol of §11.3 gives the agents a way to finish, to settle
   disagreements, and to hand the user only the questions that are the user's.

### 0.2 Guards

| Guard | Decision | Evidence |
|---|---|---|
| G1 | Parity with solo use. A stricter boundary than the user runs daily must be argued as a coordination failure or data loss inside the parity model. | User decision, 2026-09-05. |
| G2 | Prompt before mechanism. Where a rule would interfere with how the models perform, add machinery, or leave the user unable to tell what is happening, the brief carries it. | User decision, 2026-09-07. |
| G3 | Claude runs through the Claude Code CLI on the user's subscription, never the Agent SDK. | User decision; Agent SDK docs: "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." |
| G4 | Claude runs in permission mode `auto`; Codex on app-server runs with `approvals_reviewer = "auto_review"` and `approval_policy = "on-request"`; prompts neither settles reach the user. | User decision; Codex docs: "Auto-review only applies when approvals are interactive." |
| G5 | Mid-turn delivery to Claude is a hook (`PostToolUse` and `PostToolUseFailure`); streaming input is not injection. | Claude docs: streaming input has "queued messages … process sequentially"; measured: the hook's `additionalContext` reaches the model. |
| G6 | Agents read the main tree and the peer worktree, including uncommitted state, and write only their own worktree. Worktrees live outside the main tree. | User decision. |
| G7 | No commit norms. Agents may commit on their own branch with native git, or not. | User decision, reaffirmed 2026-09-07. |
| G8 | Everyone sees every message; `@handle` is the one addressing convention; agents run in parallel with no turn-taking; when both answer at once, both replies are recorded. | User decision. |
| G9 | Agent-to-orchestrator IPC uses files, never sockets. | Measured: Codex's sandbox denies Unix-socket connections. |
| G10 | Zero footprint in tracked files, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.gitignore`; solo sessions stay untouched. | User decision. |
| G11 | The conversation log is JSONL that the user can open in an editor; it is the one authority. | User decision, 2026-09-07. |
| G12 | `/apply` and `/sync` are native `git merge` with the pinned invocation of §13.0, explicit paths, the collision preflight, and an abort that refuses when the index changed after the merge. | Measured data-loss cases, §16. |
| G13 | The orchestrator's git is one binary resolved at startup and used by path, and every command names its repository; it never discovers. | Measured: a rewritten `.git` pointer redirects discovery; two git binaries on this machine. |
| G14 | The agents manage completion themselves through the protocol of §11.3; the user is consulted only for the cases it names. Neither verdict is the default: an accept needs per-criterion evidence as a blocker needs a failing case. | User decision, 2026-09-07. |
| G15 | The agents are Clara (Claude) and Phil (Codex), with no assigned personality; handles are configuration, harness ids are what the machine keys on. | User decision, 2026-09-07. |

---

## 1. Purpose

Chatroom is a terminal group chat with three participants: the user; Clara, a Claude
agent running through the Claude Code CLI in auto mode; and Phil, a Codex agent running
through the Codex app server with Auto-review, with `codex exec` as fallback. All
participants see every message. Addressing says who is expected to act; it does not make
a message private. The two agents work at the same time in their own worktrees,
coordinate through the chat while working, and read one another's work and the user's
main tree.

`chatroom` is one globally installed command. A repository opts in when the command is
run inside it. The conversation lives in `.chatroom/` in the main worktree as files the
user can read; worktrees and per-turn directories live outside the main tree. Plain
`claude` and `codex` sessions remain independent, and Claude keeps running on the user's
subscription.

### 1.1 Non-goals for the first release

More than two agents; a full-screen interface; remote rooms; exactly-once tool execution;
isolation from a hostile local process; native Windows; resolving sync conflicts in
place; archiving or garbage-collecting old conversations.

---

## 2. Principles

1. **One authority, readable by a person.** The JSONL log wins over every derived state.
2. **One writer.** Only the orchestrator process appends to the log.
3. **A message is durable before it is visible.** Appended and synced, then shown.
4. **At-least-once transport, idempotent acceptance**, by operation id.
5. **No state rollback.** Recovery moves forward from what the log says.
6. **Stable identities.** Conversations, sessions and workspaces are named, never guessed.
7. **Main-tree mutation is explicit and native**, through `git merge`, and nothing
   Chatroom does to git is hidden from `git log` and the reflog.
8. **Parity** (G1), **prompt before mechanism** (G2), **zero footprint** (G10).

---

## 3. Overview

```text
 ┌──────────────────────────── chatroom process ─────────────────────────────┐
 │  REPL: transcript · activity · prompts · status bar · slash commands      │
 │                        │                                     ▲            │
 │                        ▼                                     │            │
 │  Orchestrator: log · scheduler · budget · turns · recovery                 │
 │        │                    │                      │                       │
 │        ▼                    ▼                      ▼                       │
 │  log.jsonl            IPC (files + receipts)   Workspaces                  │
 │                                                (snapshot / integrate /     │
 │                                                 sync / apply, pinned git)  │
 │  ┌──────────────────┐            ┌───────────────────┐                     │
 │  │ Claude driver    │            │ Codex driver      │                     │
 │  │ claude -p, auto  │            │ codex app-server  │  auto-review        │
 │  └────────┬─────────┘            └─────────┬─────────┘                     │
 └───────────┼────────────────────────────────┼───────────────────────────────┘
             │ stdin turns + hook             │ turn/start, turn/steer
             ▼                                ▼
      Claude worktree                  Codex worktree
```

| Part | Responsibility |
|---|---|
| REPL | Input, transcript, activity, relayed prompts, status bar, commands. |
| Orchestrator | Appends to the log, resolves targets, schedules turns, keeps the budget, recovers. |
| IPC | Imports the agents' `post`, `reply` and `delivery_ack` files; writes receipts and deliveries. |
| Driver | Starts or resumes one vendor session, submits turns, delivers mid-turn messages, normalizes events, relays prompts. |
| Workspaces | Snapshots, merges, ref expectations, always through recorded absolute paths. |
| Agent command | `post`, `reply`, `ask`, `inbox`, `hook`; uses only the paths in its environment. |

---

## 4. Layout

### 4.1 Identity and the main worktree

Chatroom resolves `git rev-parse --path-format=absolute --git-common-dir`, hashes it into
a project id, and takes the **main worktree** from `git worktree list` as the entry whose
git directory is the common directory. Bare repositories are refused. The conversation
lives in the main worktree whichever checkout `chatroom` was started from, so the user's
own linked worktrees share it. Chatroom refuses to start from one of its own worktrees.
One process at a time per project, held by a lock file in the state directory that
names the running pid; a lock whose process is gone is stale and taken over.

### 4.2 Files

```text
<install>/chatroom                                  executable
~/.config/chatroom/config.toml                      optional defaults

<main worktree>/.chatroom/                          excluded via .git/info/exclude
  config.toml                                       project overrides
  current                                           name of the current conversation
  conversations/<name>/
    log.jsonl                                       every message and event, one per line
    codex-thread                                    Codex thread id, once known
    claude-session                                  Claude session id, once known

<state dir>/chatroom/<project-id>/                  ~/.local/state on macOS and Linux
  lock
  worktrees/<name>/{claude,codex,integration}       linked worktrees, one set per conversation
  ipc/<name>/{claude,codex}/
    from-agent/                                     the agent's drop directory, cleared between turns
    to-agent/deliveries/, to-agent/receipts/        written by the orchestrator, read by the agent
    scratch/                                        the agent's temp directory, exported as TMPDIR
  hooks-empty/                                      empty directory used as core.hooksPath
```

Chatroom adds `/.chatroom/` to `.git/info/exclude` after checking that `.chatroom` is a
real directory. Worktrees and IPC stay outside the main tree so that the sandbox and
permission rules of §12, which are written by directory, can name the main tree and the
chatroom's directories as different things (G6). A conversation is deleted by removing
its directory, its worktrees and its refs; `chatroom delete <name>` does that after
showing what it will remove.

---

## 5. The log

### 5.1 Records

`log.jsonl` holds one JSON object per line. Every line has `id`, an integer that
increases by one per line and is the message number the participants see, `at`, an ISO
timestamp, and `kind`. Field names are words, so a line reads on its own:

```json
{"id":41,"at":"2026-09-07T10:07:12Z","kind":"message","from":"user","to":["clara","phil"],"body":"Implement X."}
{"id":42,"at":"2026-09-07T10:07:40Z","kind":"message","from":"phil","to":["clara"],"via":"post","turn":"t-0007","op":"f7515aa7-…","reply_to":41,"body":"@clara I'll take the parser; can you take the CLI?"}
{"id":43,"at":"2026-09-07T10:07:41Z","kind":"turn","agent":"claude","turn":"t-0008","event":"started","inputs":[41,42]}
{"id":44,"at":"2026-09-07T10:08:02Z","kind":"marker","message":42,"marker":"criteria","task":41}
{"id":45,"at":"2026-09-07T10:09:30Z","kind":"git","op":"snapshot","agent":"codex","event":"done","ref":"refs/heads/chatroom/…/codex","from":"a88f009","to":"9c29e41"}
```

Kinds: `message` (from `user`, `claude`, `codex` or `chatroom`, the last for summaries),
`turn` (`started`, `delivered`, `acked`, `ended`, `failed`, `interrupted`), `marker`
(§11.3), `session` (`started`, `resumed`, `rebuilt`), `git` (an operation's start and
outcome, with the oids it saw), `ref` (an expectation refresh or a deviation),
`permission` (a relayed prompt and its answer), `budget`, `status` (a driver status
report, §14.1), and `note` (anything the orchestrator wants the user to be able to find
later, such as a truncated line at startup).

The whole room state is a fold over the log: which messages each agent has received,
what each turn's inputs were, the budget, the open tasks, the expected oid of every
chatroom ref, the session ids. There is no second store to keep consistent and nothing
to verify against; `chatroom log` prints the file, `chatroom log --json` prints it raw.

### 5.2 Durability and startup

One append per accepted fact, `fsync` after the write, then the REPL shows it and the
scheduler acts on it. Facts that must land together are one line: a message carries its
targets; a turn start carries its input ids. On startup the orchestrator reads the log
once; a line that does not parse is a crash mid-write, and it is skipped, left in place,
and named in a `note` line appended at startup. Duplicate operation ids are rejected by
the set of ids the fold produces. The log is never rewritten. The two id files next to it
are written by temp-file-and-rename.

> Measured, §16: `node:sqlite` passed a crash-injection suite on three Node lines, so a
> database would have worked; the user chose the log for inspectability (G11).

---

## 6. Messages and addressing

The Claude agent is **Clara**, handle `clara`; the Codex agent is **Phil**, handle
`phil`. Handles are configuration (`agents.claude.handle`, `agents.codex.handle`) and
appear where people and models read. Paths, refs and `CHATROOM_AGENT` use the harness id,
`claude` or `codex`, which never changes, so a rename is a config edit (G15).

Handles: `user`, `clara`, `phil`. A mention is `@` followed by a handle or `all`, at a
word boundary, case-insensitive, anywhere in the body outside inline and fenced code.
`@all` means every participant except the author. An unknown handle produces a warning
and does not broaden the audience.

| Author | No mention | Mentions |
|---|---|---|
| user | Clara and Phil | the mentioned agents |
| agent | user | the mentioned participants except the author |

Agent commands accept `--to <handle>[,<handle>]` as an override; when both are present,
`--to` wins and the body is stored as written. Targets are recorded on the message line
and shown in the REPL and the delivery header; they are never reconstructed from text.

Every message is visible in the user's transcript as soon as it is appended. Each agent
other than the author will receive it: a target receives it as a trigger, a non-target
receives it as context the next time that agent is triggered, which keeps "everyone sees
everything" (G8) without waking an agent for status chatter.

Agent commands generate a random UUID operation id before writing anything and reuse it
on retry; the log rejects a second message with the same `(from, op)`. `chatroom reply
<id> <body>` sets `reply_to` and targets that message's author unless `--to` overrides. A
turn's final reply is linked to its newest triggering input unless the agent already
posted an explicit reply.

A message may begin with one **marker** in square brackets: `[criteria]`, `[assumption]`,
`[settled]`, `[done]`, `[accept]`, `[blocker]`, `[suggestion]` or `[ask-user]`,
optionally followed by `#<task id>` (§11.3). Messages from `chatroom` are summaries: they
target the user, cost no credit and trigger nobody.

Limits: a body is at most 64 KiB; a delivery batch at most 64 messages.

---

## 7. Scheduling and the autonomy budget

The budget limits how many agent-authored messages may activate the other agent after
the user's most recent message.

- A user message resets the count to zero.
- An agent message that targets the other agent uses one credit when it is appended. If
  no credit remains, its delivery is **held**; the message stays visible to the user.
- Messages to the user cost nothing.

Held deliveries are released when the user next addresses the held recipient or
everyone, in which case they join that batch free, or when the user raises `/budget`,
in which case they are released in order while credit lasts. When the budget runs out,
the chatroom posts one line to the user saying who is waiting on whom and what to type
to continue.

At most one turn is active per agent and conversation; the two agents run concurrently
(G8). The scheduler runs after every appended line:

```text
for each agent A:
    triggers = messages targeted at A that A has not received and that are not held
    if none: continue
    batch = every message A has not received, through the newest trigger

    if A is idle:              start a turn with batch as its input
    else if A is running:      deliver batch mid-turn: turn/steer on Codex,
                               a delivery file for the hook on Claude
    else:                      leave batch for the next turn boundary
```

Native acceptance means the vendor process took the input, not that the model acted on
it. A mid-turn batch that the vendor rejects, or that the hook has not acknowledged by
the end of the turn, returns to the queue without a second charge.

A task in state `waiting_user` or `escalated` (§11.3) holds agent-to-agent deliveries
whose task it is, so no credit is spent circling a question only the user can answer;
they are released when the user posts into that task.

---

## 8. Agent commands and file IPC

Files, never sockets (G9): measured, a Unix-socket connection from inside the Codex
sandbox fails with "Operation not permitted", while a file write under a granted
directory succeeds.

### 8.1 Environment

The driver builds the child environment from the user's environment minus every variable
whose name matches `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`,
`*CREDENTIAL*`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_*`, `GITHUB_*`,
`NPM_CONFIG_*AUTH*`, `OPENAI_*`, `ANTHROPIC_*`, except names on `security.env_allow`,
plus:

| Variable | Meaning |
|---|---|
| `CHATROOM_AGENT` | harness id, `claude` or `codex` |
| `CHATROOM_HANDLE` | the agent's name in the chat, `clara` or `phil` |
| `CHATROOM_CONVERSATION` | conversation name |
| `CHATROOM_OPERATION_DIR` | absolute drop directory, agent-writable, cleared between turns |
| `CHATROOM_DELIVERY_DIR`, `CHATROOM_RECEIPT_DIR` | absolute orchestrator-owned directories, agent-readable |
| `CHATROOM_SCRATCH` | absolute temp directory, also exported as `TMPDIR` |
| `CHATROOM_ASK_TIMEOUT` | seconds `ask` waits, from `ask.timeout_seconds` |
| `CHATROOM_BIN` | absolute path of the running executable |
| `GIT_OPTIONAL_LOCKS` | `0`: read-only git commands do not rewrite an index |

The directories are per agent, not per turn, because Claude's process is long-lived and
its environment is fixed when it starts; the orchestrator clears the drop and scratch
directories when a turn ends. Removing the Anthropic variables is what keeps Claude on the subscription. The rest is a
cheap default and the only environment filter there is: measured on Codex 0.153.3,
`shell_environment_policy` (`inherit = "none"`, `ignore_default_excludes = false`, a
`filters` exclude) removed nothing from the commands' environment, while its `set` map
worked; app-server and `exec` commands inherit the scrubbed environment instead.
`GIT_OPTIONAL_LOCKS=0` matters for coordination: measured on git 2.54.0, `git status` run
in a touched peer worktree rewrites that worktree's index without it and not with it.

### 8.2 Operations, receipts, deliveries

`post`, `reply` and `delivery_ack` share one envelope:

```json
{"op":"f7515aa7-ff20-4b9e-807d-12f66157b282","type":"post","at":"2026-09-07T10:07:40Z",
 "to":["phil"],"body":"@phil Parser interface is ready.","reply_to":null}
```

The command writes a temporary file in `CHATROOM_OPERATION_DIR`, syncs it and renames it
to `<op>.json`. The orchestrator polls the drop directories while a turn is active, imports each
file once by its op, appends the message or the acknowledgement, and writes a receipt
`{"op":"…","status":"accepted","message":42}` under `to-agent/receipts/` the same way. A
file that does not parse is renamed to `<name>.rejected` and noted in the log. `chatroom
post` waits briefly for its receipt and prints `#42`; on a local timeout it prints
"acceptance unknown", and a retry with the same op returns the same result.

For the hook transport, the orchestrator writes one file per batch under
`to-agent/deliveries/`. `chatroom inbox` and `chatroom hook` read it and write a
`delivery_ack` naming the files; the orchestrator removes a delivery file after its
acknowledgement is in the log. `chatroom hook` writes an acknowledgement on every
invocation, with an empty list when nothing was pending, and copies `effort.level` and
`cwd` from the hook input into it for the status bar (§14.1).

### 8.3 `ask` and `reply`

```sh
"$CHATROOM_BIN" ask "@phil list or iterator?"
"$CHATROOM_BIN" reply 52 "It returns an iterator."
```

`ask` is `post` followed by waiting up to `ask.timeout_seconds`, default 60, which is
below the Claude Bash tool's measured 120 s timeout. A message whose `reply_to` is the
question resolves it (`answered`). The first message from an asked party that targets the
asker after the question returns at once as `probable`, with a note that the correlation
is inferred; the question stays open and a later explicit reply still resolves it. On
timeout with no candidate, `indeterminate`.

---

## 9. Drivers

### 9.1 Contract

```ts
type Capabilities = {
  nativeSteering: boolean;   // input accepted into a running turn (Codex app-server)
  hookDelivery: boolean;     // hook injection (Claude)
  interrupt: boolean;
  hostPrompts: boolean;      // prompts the harness cannot settle reach the REPL
  nativeCommit: boolean;     // doctor: a native commit lands on the own branch only
};
type Status = { model, effort, cwd, contextTokens, contextWindow };   // each string | number | null

interface Driver {
  connect(session: { id?: string; cwd: string; brief: string }): Promise<Capabilities>;
  startTurn(turn: string, input: string): Promise<void>;
  steer(input: string): Promise<boolean>;            // if nativeSteering
  deliverViaHook(input: string): Promise<void>;      // if hookDelivery
  answerPrompt(id: string, decision: "allow" | "deny", reason?: string): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<Event>;                    // text, reasoning, tool, prompt, status, final, error
  close(): Promise<void>;
}
```

A `status` event carries only what the harness reported; a configured value is never
shown as a report (§14.1).

### 9.2 Claude

```text
claude -p --session-id <uuid> | --resume <uuid> \
  --input-format stream-json --output-format stream-json --verbose --include-hook-events \
  --append-system-prompt "<brief>" --settings '<inline JSON, §12.1>' \
  --permission-mode auto --permission-prompts host --permission-prompt-tool stdio \
  [--model <model>] [--effort <level>]
```

Working directory: the conversation's Claude worktree. One long-lived process per
session; a turn is one `user` message on stdin and the `result` event that ends it, and
the CLI queues further input, so the driver writes input only when the scheduler starts a
turn. The system prompt and settings are not persisted with the session and are passed on
every process start. The user's settings, hooks, MCP servers and `CLAUDE.md` load as in
solo use.

Measured on 2.1.263 (§16): the init event follows the first user message, so the driver
sends the first turn before expecting one; three turns ran in one process and closing
stdin ended it with exit 0; `--resume <id>` in a new process kept the id and remembered a
hook delivery; after a SIGKILL during a tool call `--resume` recovered the session.

The hook, registered in the inline settings for both tool outcomes because the docs say
`PostToolUse` runs "after a tool call succeeds" and `PostToolUseFailure` "after a tool
call fails" (measured: fourteen failing commands in one turn fired `PostToolUse` twice):

```json
{"hooks": {
  "PostToolUse":        [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}],
  "PostToolUseFailure": [{"matcher": "", "hooks": [{"type": "command", "command": "\"$CHATROOM_BIN\" hook"}]}]}}
```

`chatroom hook` reads the hook input on stdin, drains `CHATROOM_DELIVERY_DIR`, writes a
`delivery_ack`, and if anything was pending prints
`{"hookSpecificOutput": {"hookEventName": "<the input's hook_event_name>", "additionalContext": "<delivery text>"}}`;
the CLI rejects output naming the other event (measured: "Hook returned incorrect event
name"). An agent generating text without tool calls hears nothing until its next tool
call or the end of its turn, when the batch returns to the queue.

Prompts the classifier does not settle arrive on stdout as
`{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,"input":…,"permission_suggestions":[…],"blocked_path":…,"tool_use_id":…}}`
and are answered on stdin with
`{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":…}}}`
or `{"behavior":"deny","message":…}`. Measured: this needs `--permission-prompt-tool
stdio`; without it a prompt is denied at once with a `permission_denied` event. The REPL
shows such a prompt with a short id and the user answers it with `/allow` or `/deny`.

Status: `--model` and `--effort` are passed only when configured. The model and working
directory come from the init event; the context tokens from each `assistant` event's
`message.usage` as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
the input-only formula the Claude Code status line documents; the window from
`modelUsage[<init model>].contextWindow` on each `result`, where `modelUsage` has one
entry per model the session used, side calls included (measured: a `claude-haiku-4-5`
entry next to the session model, whose key is the model name without the user's `[1m]`
suffix, with a 1000000 window). The effort in force is not in the stream; every hook
input carries `effort.level` next to `cwd`, and `chatroom hook` copies both into its
acknowledgement. Thinking is not streamed as content blocks at effort `xhigh`; the
stream carries `system/thinking_tokens` counters instead, so activity shows a counter.

### 9.3 Codex app-server

`codex app-server` over stdio, newline-delimited JSON-RPC without the `jsonrpc` header.
`initialize` with `clientInfo`, then the `initialized` notification. `thread/start` or
`thread/resume` with `cwd`, `approvalPolicy: "on-request"`, `approvalsReviewer:
"auto_review"` and a `config` map carrying the profile of §12.2 as nested objects
(measured: `{"default_permissions": "<name>", "permissions": {"<name>": {"filesystem":
{…}}}, "shell_environment_policy": {"set": {…}}}`). The response's legacy `sandbox` field
then reads `workspaceWrite` with `writableRoots` equal to the profile's write entries,
which is how the driver confirms the profile loaded; a `default_permissions` without a
matching table fails `thread/start` with "failed to load configuration", which is where
the fallback of §12.2 is decided.

`turn/start` with the input; `turn/steer` with `expectedTurnId`, measured to be accepted
during a running command and rejected after the turn ended with `-32600` "no active turn
to steer"; `turn/interrupt`. Items become events: `reasoning`, `agentMessage`,
`commandExecution`, `fileChange`. `thread/resume` in a new process returns the thread
with its turns; after a SIGKILL mid-command the killed turn shows `status`
`interrupted`.

Approvals: an escalation the model asks for goes to Auto-review, and the client sees
`item/autoApprovalReview/started` and `/completed` with `review.status`, `riskLevel`,
`userAuthorization` and `rationale`, plus a `guardianWarning` line in prose; a request
Auto-review does not settle arrives as `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval` or `item/permissions/requestApproval` and is answered
with `{"decision": "accept" | "decline"}` or a permission grant. Measured: Auto-review
approved an escalated write into the main tree because the turn input had authorized
one rerun; under the profile the rerun still failed with "operation not permitted" and
nothing was written, while under legacy `workspace-write` an approved escalated `git
commit` ran unsandboxed. What Auto-review approves follows the turn input, and a turn
input carries the peer's messages as well as the user's; that is the exposure the user
accepted with G4.

Status: `thread/start` and `thread/resume` answer with `model`, `reasoningEffort` and
`cwd` (measured: `gpt-5.6-sol`, `xhigh` from the user's `config.toml`, `low` when the
config map sets `model_reasoning_effort`); `thread/tokenUsage/updated` carries
`tokenUsage.last.inputTokens` and `modelContextWindow` (measured: 258400) on every
request; the cached count is below the input count and is not added again.

### 9.4 Codex `exec` fallback

If app-server fails to connect: `codex exec --json -o <file> -c … --cd <worktree> -` and
`codex exec resume <thread-id> --json -o <file> -c … -`, the prompt on stdin, the profile
as a TOML inline table (`-c 'permissions.<name>.filesystem={ ":root" = "read", "<path>" =
"write", … }'`), and no `--cd` on resume, so the working directory comes from spawning
in the worktree, measured to hold. The stream carries `thread.started` with `thread_id`,
`turn.started`, `item.started`, `item.completed` and `turn.completed` with
`usage.input_tokens` and no model or window. There are no approvals, no Auto-review and
no steering on this path: an action that would need approval fails, the agent reports it,
and the user does it.

### 9.5 Doctor

`chatroom doctor` checks: both executables and versions, the git binary and version;
Claude's login is `claude.ai` and not an API key; a session starts, ends a turn and
resumes by id; the hook fires and its context reaches the model; steering works on Codex;
the write boundary through a shell command and a native file tool (own worktree writable;
main tree, peer worktree, integration worktree and IPC directories not, except native
writes into the main tree on Claude, which the brief covers); and the native commit (a
`git commit` in the own worktree moves only the own branch). A failed boundary check
refuses the agent; a failed commit check only sets `nativeCommit` false, which `/status`
shows and the brief mentions.

---

## 10. Turns and recovery

**Start.** Append `turn started` with the batch's message ids, create the drop and scratch
directories, ensure the session is connected, and submit the input through the native
channel. If submission fails, the batch stays queued and the failure is a `turn failed`
line.

**During.** Posts from the agent are imported as they appear. Eligible messages are
steered or hook-delivered per capability. A prompt stops only the requesting operation.
`/stop` asks for a protocol interrupt, then SIGTERM, then SIGKILL after five seconds
each.

**End.** Append the final reply as a message with `via: final`, or nothing when it is
empty or exactly `[silent]`; return unacknowledged hook deliveries to the queue; remove
the per-turn directories; refresh the ref expectations (§13.1); act on any marker (§11.3);
run the scheduler. A final reply with no mention targets the user.

**Sessions.** Each conversation keeps one session id per harness in the two id files next
to the log. The room log is the truth; a vendor session is a cache of the agent's working
memory. On startup, turns left `started` become `interrupted`, and each agent's next
turn begins with `--resume <id>` or `thread/resume` and a recovery note as its first
input: the interrupted turn, the messages it had received, and the worktree's current
`git status`. If the resume fails or reports a different working directory, the driver
starts a new session with the brief, the tail of the transcript that fits, and the same
note, and records `session rebuilt`. Both harnesses persist their turns incrementally,
measured, so resuming before rebuilding keeps the agent's memory at no cost.

---

## 11. What agents receive

### 11.1 Delivery format

Used for turn inputs, steering, hook injection and `chatroom inbox`. Readable text, not
JSON. The header repeats on every delivery so the rules survive compaction.

```text
[chatroom] You are @clara. 2 new messages. Act on those addressed to you; read the rest as context.
Speak with "$CHATROOM_BIN" post "..."; ask with "$CHATROOM_BIN" ask "..."; reply exactly [silent] if your posts said everything.

--- #41 · user → @clara @phil · 10:07:12
Implement X.

--- #42 · phil → @clara · 10:07:40 · reply to #41
@clara I'll take the parser; can you take the CLI?

workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230
peer changes since your previous input: src/parser.ts, test/parser.test.ts
tasks: #41 open · criteria #42 · blockers 0/2
```

### 11.2 Brief

Supplied on every process start. It is where the rules live (G2).

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
- When you claim a task, post "[criteria] #<task>" with three to seven numbered, checkable
  statements of what done means. When you receive criteria, check them against what the
  user asked: if they miss part of the request, or a statement cannot be verified, amend
  them, once. After that the criteria stand; the user may amend at any time.
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
  A task allows two blockers; after that the chatroom hands it to the user. Do not keep
  improving past that.

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

`{commit_note}` is "Commit on it if and when you like; Chatroom snapshots uncommitted
work when it integrates. A `packed-refs.lock` error from `git commit` is harmless." when
`nativeCommit` probed true, and "Committing is unavailable in this session; Chatroom
snapshots your work when it integrates." otherwise. `brief.extra` from configuration is
appended under a visible label.

### 11.3 Collaboration protocol

Two models asked to review each other's work do not converge on their own: the verb
"review" makes findings the deliverable, "more careful" is always available, and
severity labels drift upward to be heard. The opposite failure is as likely: a model told
that acceptance is welcome will accept to be agreeable. The brief above counters both with
one rule, that a verdict must be earned: a blocker costs a demonstrated failing case, an
accept costs verification of every criterion by the checker's own hands. Around that
rule: criteria are explicit before work starts and may be challenged once, blockers are
capped, and what the agents should not decide goes to the user in a form the user can
answer in one line.

The orchestrator's part is small. It records markers, and it does four things:

| Marker | Effect |
|---|---|
| `[criteria] #t` | recorded as the task's criteria; the first author is the lead. A task is a user message that assigned work, named by its id, or the one the reply chain leads to. |
| `[done] #t` | task `done_claimed`; the peer is triggered to check, mention or not, at the usual credit cost, because checking is part of the work. |
| `[accept] #t` from the peer | task `accepted`; the chatroom posts the completion summary: the task, the criteria with the author's and the checker's notes side by side, the assumptions and suggestions collected, which worktrees hold the result, and the `/apply` command that brings it in. |
| `[blocker] #t` from the peer | task `open`, blocker count up; the claimant is triggered, mention or not. The blocker after `task.review_rounds` (default 2) is recorded as a suggestion and the task is `escalated` with a summary to the user: criteria, what was accepted, the open disagreement, both recommendations. |
| `[ask-user] #t` | task `waiting_user`; the message targets the user whatever it mentions; agent-to-agent deliveries for the task are held until the user posts into it. |
| `[assumption]`, `[settled]`, `[suggestion]` | recorded and listed by `/tasks`; no other effect. |

A `[done]`, `[accept]` or `[blocker]` from the wrong author, such as the claimant
accepting its own claim, is recorded as a suggestion. `accepted` is terminal: a late
`[done]` does not reopen it. Whether an accept really lists evidence per criterion, or a
blocker really shows a failing case, is the brief's rule and the user's reading of the
summary; the orchestrator does not grade prose (G2, G14).

What goes to the user, by rule: behaviour the user will see that the task does not imply;
interface, dependency or scope changes beyond the ask; anything irreversible; conflicting
or ambiguous instructions where reasonable defaults differ; a disagreement still open
after two exchanges. What does not: implementation choices, naming, layout, test
structure, and any ambiguity with a reasonable default. The user answers with a plain
message into the task or `/reply <id> …`; `/tasks` lists open tasks with their criteria,
blockers used, settled decisions, assumptions and pending questions.

---

## 12. The boundary

The shell on both harnesses and every native write outside the main tree are bound: an
agent writes working-tree files only in its own worktree, its drop directory and its
scratch directory, and never in the chatroom's own directories. Claude's native edits to
the main tree are the one place the rule is carried by the brief alone (G2, §12.1).
Everything else is parity with solo use.

### 12.1 Claude

Passed as inline `--settings` JSON, measured on 2.1.263 as a whole (`probes/03f`):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["<drop dir>", "<scratch dir>", "<security.extra_write_roots…>"],
      "denyWrite": ["<git common dir>/worktrees/<peer admin dir>",
                    "<git common dir>/worktrees/<integration admin dir>",
                    "<git common dir>/refs/heads/<main branch>",
                    "<git common dir>/refs/heads/chatroom/<name>/codex",
                    "<git common dir>/refs/heads/chatroom/<name>/integration",
                    "<git common dir>/packed-refs"],
      "denyRead":  ["<ipc dir>/codex"]
    }
  },
  "permissions": {
    "deny": [
      "Edit(//<peer worktree>/**)",        "Write(//<peer worktree>/**)",
      "Edit(//<integration worktree>/**)", "Write(//<integration worktree>/**)",
      "Edit(//<ipc dir>/codex/**)",        "Write(//<ipc dir>/codex/**)",
      "Edit(//<ipc dir>/claude/to-agent/**)", "Write(//<ipc dir>/claude/to-agent/**)"
    ]
  },
  "hooks": { "…": "§9.2" }
}
```

- **Shell writes** are bounded by the sandbox's default scope: the working directory,
  the session temp directory, and, for a linked worktree, "the main repository's shared
  `.git` directory so commands such as `git commit` can update refs and the index. Writes
  to `hooks/` and `config` inside that directory remain denied" (docs). Measured: with
  the sandbox alone `git commit` in the worktree landed on the own branch, and the
  `denyWrite` entries hold inside that allowance: with them, `git commit` moved only the
  own branch while `git update-ref refs/heads/main`, a write into the peer's admin
  directory, updates of the peer and integration refs and `git pack-refs` were refused;
  without them the same session moved `main`. `allowUnsandboxedCommands: false` keeps the
  rule hard; without it the classifier could approve a rerun outside the sandbox.
- **Permission deny rules feed the sandbox** by path prefix, measured: a deny over the
  whole IPC directory blocked the agent's own drop file, and a deny over the main tree
  covered `<main>/.git` and cost the commit (`index.lock` in the agent's own admin
  directory refused); no narrower `allowWrite` reopened it and a character class in a
  rule matched nothing. So there is no main-tree rule (G2, user decision 2026-09-07):
  native `Edit` and `Write` into the main tree are decided by the auto-mode classifier and
  the brief's "never write there", as in solo use, and shell writes into the main tree
  stay blocked by the sandbox's default scope. The peer and integration worktrees and the
  chatroom's IPC directories keep their rules; none of them sits above the git directory.
- **Reads** are not denied, except the peer's IPC directory, which is the chatroom's own
  state. The two harness homes hold every other project's transcripts, and a second model
  reading them is the one exposure the chatroom creates that solo use does not; the brief
  says not to read them, and that is the whole mechanism (G2). The agent knows on its own
  what else it should not read.
- **Subagents** share the process, rules and sandbox. Network, web tools and MCP servers
  are as the user configured them.

### 12.2 Codex

Passed through the `config` map on `thread/start` and `thread/resume`, or `-c` on `exec`:

```toml
default_permissions = "chatroom"

[shell_environment_policy]
set = { TMPDIR = "<scratch dir>", GIT_OPTIONAL_LOCKS = "0" }

[permissions.chatroom.filesystem]
":root"                                            = "read"
"<own worktree>"                                   = "write"
"<drop dir>"                                       = "write"
"<scratch dir>"                                    = "write"
"<git common dir>/worktrees/<own admin dir>"       = "write"
"<git common dir>/objects"                         = "write"
"<git common dir>/refs/heads/chatroom/<name>/codex"      = "write"
"<git common dir>/refs/heads/chatroom/<name>/codex.lock" = "write"
"<git common dir>/logs/refs/heads/chatroom/<name>/codex"      = "write"
"<git common dir>/logs/refs/heads/chatroom/<name>/codex.lock" = "write"
"<ipc dir>/claude"                                 = "deny"
```

Measured on 0.153.3, under `codex sandbox` and through app-server: without the six git
entries `git add` in a linked worktree fails because the index lock lives in the admin
directory outside the worktree; with them `git commit` succeeds, only the own branch
moves, and no approval or review is involved. With git 2.54.0 the commit also prints
"error: Unable to create '…/packed-refs.lock': Operation not permitted" and still
succeeds, because that version locks `packed-refs` during a ref update and the profile
denies it; 2.50.1 does not touch the file; the brief names the message as harmless.
Codex runs commands through `/bin/zsh -lc`, so the git an agent uses is the login
shell's. `:root` and `/` are both accepted as read entries; a deny inside the root read
holds; precedence per the docs: "More specific entries override broader entries … deny
takes precedence over write, and write takes precedence over read."

If the profile fails to load, `thread/start` says so and the driver falls back to legacy
`workspace-write` with `writable_roots` for the drop and scratch directories; native
commits then need an escalation, which Auto-review or the user decides (measured: an
approved escalated commit ran unsandboxed and moved only the own branch), and
`nativeCommit` records the result.

### 12.3 What is deliberately not here

No read allowlist, no secret-path lists, no operating modes,
no network allowlist, no hosted-tool disabling, no escalation policy, no commit broker,
no clones. The user runs these harnesses with the same exposure every day (G1).

---

## 13. Git

### 13.0 Invocation

At startup the orchestrator resolves `git` on `PATH` to a real path, or `git.binary`
from config, records path and version, and uses that path for every command (G13). Every
command names its repository and never discovers:

```text
<git> --git-dir=<recorded admin dir or common dir> --work-tree=<recorded worktree> \
      -c core.hooksPath=<state dir>/hooks-empty -c commit.gpgsign=false \
      merge --no-verify --no-gpg-sign --no-autostash --no-rerere-autoupdate --no-ff -m "<message>" <ref>
```

The merge into the user's main worktree is the same with `--no-commit` and no `-m`.
Measured on git 2.54.0: a `pre-merge-commit` hook runs on an unpinned merge and does not
run with this invocation; with `merge.autoStash=true` inherited and no `--no-autostash`,
an overlapping edit that must be refused is stashed and the file overwritten; after
rewriting a worktree's `.git` pointer to a fake repository, discovery follows it while
explicit `--git-dir` does not. Snapshots use `read-tree`, `add`, `write-tree`,
`commit-tree` and `update-ref` under `GIT_INDEX_FILE`, which run no hooks. The flags are
the whole mechanism; nothing here is a layer the user has to understand, and every
result is visible in `git log` and the reflog.

### 13.1 Refs and expectations

Per conversation: `refs/heads/chatroom/<name>/{claude,codex,integration}`, all starting
at main's HEAD, and the main worktree's branch name recorded at creation. After every
turn and before every git operation the orchestrator reads the three refs, `main`, and
each agent worktree's `HEAD`, and appends a `ref` line when something differs from what
it last saw:

| Ref | Moved by | On deviation |
|---|---|---|
| an agent's branch | that agent's commits and the chatroom's snapshots | adopted as the agent's activity; the peer moving it would be a norm violation, recoverable from the reflog |
| integration | the chatroom only | shown; integration waits for `/adopt integration` or a reflog restore |
| main | the user | adopted on `/sync`; a changed branch name blocks `/apply` until `/adopt main` |
| a worktree's `HEAD` | never, once created | shown; that agent's git operations wait for the user |

### 13.2 Snapshot

Used by `/snapshot`, and by `/integrate`, `/sync` and `/apply` as their first step; it
refuses while the agent has a turn in flight. Build a temporary index from the branch tip,
add the worktree's tracked and non-ignored untracked files, `write-tree`; if the tree
equals the tip's tree there is nothing to do; otherwise `commit-tree` on top of the tip,
`update-ref` with the tip as the expected old value, and `read-tree` the new tip into the
worktree's index without touching files. Ignored files are not captured; staging state is
not preserved. An agent's own commits stay underneath.

### 13.3 `/integrate` and `/sync`

`/integrate <agent>`: snapshot, then merge the agent branch into the integration worktree
with the pinned form and a generated message. A conflict is aborted at once, reported
with its paths, and the integration ref is unchanged.

`/sync <agent|all>`: if main's HEAD is not an ancestor of integration, merge `main` into
integration first; snapshot; merge integration into the agent branch in the agent's
worktree. A conflict is reported and the only resolution in the first release is `/sync
--abort <agent>`, which runs `git merge --abort` there and leaves the pre-sync snapshot
as the tip. `/import <source> <destination>` is integrate source, then sync destination.

### 13.4 `/apply` and `/apply --abort`

`/apply [agent]` is integrate, then, in the user's main worktree with `--git-dir=<common
dir> --work-tree=<main worktree>`:

1. **Preconditions**, for clear messages: integration exists and is not an ancestor of
   HEAD; the index equals HEAD; no `MERGE_HEAD`, `REBASE_HEAD` or `CHERRY_PICK_HEAD`;
   main's branch name is the recorded one; integration is where the chatroom expects it.
2. **Preflight**: compute the paths the merge would change from the merge base to the
   tip. Every path it would add must not exist in the working tree, tracked, untracked or
   ignored; every path it would modify or delete must be clean against HEAD. Measured:
   git alone overwrote an ignored file in the way of a tracked path, with and without
   `--no-overwrite-ignore`, under both merge strategies, so this check is the chatroom's.
3. **Merge** with `--no-commit`. Record git's outcome and the post-merge index
   (`ls-files -s`, conflict stages included) in one `git` line. The operation stays
   open while `MERGE_HEAD` exists.

The user reviews with `git diff --cached` and commits, or runs `/apply --abort`, which
compares the current index with the recorded post-merge index and refuses with the
differing paths if anything changed, or if no post-merge index was recorded because the
process died between the merge and its line; otherwise it runs `git merge --abort`, and a
nonzero exit is reported, never retried. Measured: `git merge --abort` silently discards a
change staged after the merge to an unrelated file; unstaged changes to unrelated files
survive; an unstaged edit to a file the merge changed makes abort fail with "not
uptodate". The six main-worktree states measured with the pinned invocation:

| Main worktree state | Result |
|---|---|
| Unstaged edit on a file the tip does not touch | Proceeds; edit preserved; tip changes staged |
| Unstaged edit on a file the tip changes | Refused by preflight and by git; tree unchanged |
| Untracked or ignored file the tip would create | Refused by preflight; git alone would overwrite the ignored case |
| Any staged change in the index | Refused; tree unchanged |
| A previous `/apply` not yet committed | Refused: "You have not concluded your merge" |
| Previous `/apply` committed, tip advanced on the same file | Clean merge; ancestry is shared |

### 13.5 Recovery

Every operation writes one `git` line when it starts and one when it ends, with the
oids it saw. On startup an operation with a start and no end is reported to the user
with what git shows now: which refs moved, whether a `MERGE_HEAD` exists and where. The
orchestrator fixes nothing on its own except the one case that is safe by construction:
a snapshot, integrate or sync is rerun from scratch, after `git merge --abort` in the
chatroom's own worktree if a `MERGE_HEAD` was left there, because a snapshot with no
change makes no commit and a merge whose commit already exists (parents equal to the
expected tip and the source) is recognized and skipped. An `/apply` left open is the
user's: with `MERGE_HEAD` present, `git diff --cached`, commit or `/apply --abort`; with
HEAD moved past the recorded one by a merge commit whose second parent is the tip, it
was committed by hand and the operation is closed. A `MERGE_HEAD` in main with no
chatroom operation is not the chatroom's and is never touched. Measured (§16): the
crash-injection probe, which reads the same git facts this rule reads, the ref's
position, a merge commit's parents and `MERGE_HEAD`, recovered every snapshot, integrate
and abort case and stopped on every apply case that needs the user.

---

## 14. Conversations, REPL, configuration

Conversations: `chatroom` opens the current one, creating `default` when none exists;
`chatroom new [name]` creates a conversation, its refs and worktrees; `chatroom list`,
`chatroom continue <name>`. Switching stops or waits for active turns, snapshots both
worktrees and disconnects the drivers. `chatroom delete <name>` shows the worktrees, refs
and directories it will remove, reports commits on the agent branches that integration
does not contain and integration commits that main does not contain, and asks. One
session per harness per conversation; sessions are isolated from the user's own because
they live in conversation worktrees and are resumed only by explicit id.

The screen is laid out like Claude Code's: the transcript scrolls in the upper part, a
bordered input box and the status lines stay at the bottom, drawn with a terminal scroll
region and raw keystrokes, never the alternate screen. Plain input is a user message; a
backslash at the end of a line continues it on the next; ctrl-C clears the input, or
quits when pressed twice on an empty box; relayed prompts get short ids and are answered
asynchronously. Without a terminal, input is read line by line and output is plain text.

```text
#42 phil → @clara                                         10:07  post
  @clara Parser interface is ready; can you take the CLI?
    · clara: Edit src/cli.ts
    · phil ✓ auto-review approved: npm test (low risk)

!p3 phil asks: network access to registry.npmjs.org
clara  working     fable · high     chatroom/…/claude  ~/…/app-1/claude  ctx 37%
phil   waiting p3  gpt-5.5 · medium  chatroom/…/codex   ~/…/app-1/codex   ctx 12%
main   feature/parser  ~/Projects/app   budget 1/6 · integration +2 · task parser
> _
```

| Command | Effect |
|---|---|
| `/budget [N]` | Show or set the autonomy credit limit. |
| `/status` | Agents, sessions, turns, held deliveries, prompts, refs and expectations, git binary, native-commit availability, the status bar values with their source and age. |
| `/stop <agent\|all>` | Protocol interrupt, then SIGTERM, then SIGKILL. |
| `/allow <id>`, `/deny <id> [reason]` | Answer a relayed prompt. |
| `/new`, `/switch`, `/conversations`, `/rename` | Conversation lifecycle. |
| `/snapshot <agent\|all>`, `/integrate <agent>`, `/sync <agent\|all>`, `/sync --abort <agent>`, `/import <src> <dst>`, `/apply [agent]`, `/apply --abort` | §13 |
| `/adopt main\|integration` | Accept a ref where it is now as the new expectation. |
| `/tasks` | Open tasks with criteria, blockers used, settled decisions, assumptions, suggestions and pending questions. |
| `/reply <id> <text>` | Answer a specific message, typically an `[ask-user]` question; releases that task's held deliveries. |
| `/show quiet\|activity\|full`, `/focus <agent\|all>`, `/history [N]` | Display. |
| `/doctor` | §9.5 |
| `/quit` | Stop turns, flush, release the lock. |

External: `chatroom log [--json]`, `doctor`, `delete`, and the agent-only `post`, `reply`,
`ask`, `inbox`, `hook`, which refuse to run unless the `CHATROOM_*` variables are present.

Configuration, TOML, project overriding global; unknown keys are errors:

| Key | Default | Meaning |
|---|---:|---|
| `autonomy.limit` | `6` | Cross-agent activations after user input. |
| `ask.timeout_seconds` | `60` | Below the measured 120 s Bash tool timeout. |
| `task.review_rounds` | `2` | Blockers per task before the task goes to the user. |
| `agents.claude.handle`, `agents.codex.handle` | `clara`, `phil` | The agents' names in the chat. |
| `driver.claude.model`, `driver.codex.model` | vendor default | Model override. |
| `driver.claude.effort`, `driver.codex.effort` | vendor default | `--effort` on Claude, `model_reasoning_effort` on Codex. |
| `git.binary` | resolved from `PATH` | The git executable. |
| `security.extra_write_roots` | empty | Package caches, build outputs. |
| `security.env_allow` | empty | Variables exempt from the scrub of §8.1. |
| `display.status_bar` | `true` | Show the status bar; `false` leaves only the prompt. |
| `brief.extra` | empty | Project guidance appended to both briefs. |

Activity kinds: `text`, `reasoning`, `tool`, `tool_result`, `prompt`, from `assistant`
events on Claude and `item/*` notifications on Codex. Raw vendor streams are written
under the conversation's directory only with `chatroom --raw`.

### 14.1 Status bar

The lines under the input box are a status bar: one line per agent and one for the room,
redrawn whenever a value changes, never wrapping.

| Column | Value | Source |
|---|---|---|
| state | `idle`, `working`, `waiting <id>` for a relayed prompt, `held` while the budget holds its trigger, else `resumed` or `rebuilt` after recovery | orchestrator |
| model, effort | what the harness reports for the session | driver status event (§9.2, §9.3) |
| branch | the branch the worktree's `HEAD` named at the last refresh; `detached` if it no longer does | §13.1 |
| directory | the worktree path, `$HOME` as `~`, middle components elided first when the terminal is narrow | §13.1, checked against the harness's `cwd` |
| context | the input side of the agent's most recent model request as a percentage of the model's context window | driver status event |
| room line | main's branch and path, credits used of `autonomy.limit`, integration commits ahead of main, the open task with the newest activity | orchestrator |

Context is the tokens the most recent request sent as input, the formula Claude Code's
own status line documents; output tokens are not counted. Measured windows: 1000000 for
`claude-fable-5-1` with the user's `[1m]` setting, 258400 for `gpt-5.6-sol`. Claude's
window is known after the first `result` of the session and `exec` never reports one;
without a window the cell shows the token count. Nothing on the bar is a configured
value presented as a report: when the chatroom passed no model or effort and the
harness reports none, the cell reads `default`; when the harness reports a value, that
value is shown even where it differs from the configuration, since Claude falls back to
the highest effort the model supports and Codex can reroute a model. `/status` lists the
same values with their source and the age of each report.

---

## 15. Failure behaviour

| Situation | Behaviour |
|---|---|
| Orchestrator crashes during a turn | Turn marked interrupted; resume with a recovery note; rebuild the session if resume fails. |
| Crash after a message was appended, before scheduling | The fold finds it undelivered; it is scheduled on startup. |
| Crash during a git operation | Reported with git's current state; snapshots, integrates and syncs rerun; an open apply is the user's (§13.5). |
| Duplicate post or acknowledgement | The original receipt is returned. |
| Operation file malformed | Renamed `.rejected`, noted in the log. |
| Mid-turn delivery races turn end | Returned to the queue; no second charge. |
| Driver exits nonzero | stderr kept in the log; turn failed; session resumed next turn. |
| Session cannot resume | Rebuilt with the brief and the transcript tail; `rebuilt` on the status bar. |
| Integration or main moved unexpectedly | Shown; `/adopt` or a reflog restore. |
| Apply refused by preflight or git | Main unchanged; paths or git's message shown. |
| Index changed or unrecorded after the merge | `/apply --abort` refuses and lists paths or asks for a manual abort. |
| Sync conflict | Reported; `/sync --abort` only in the first release. |
| Boundary or login check fails | That agent does not start. |
| Native commit unavailable | Shown in `/status`; the brief tells the agent. |
| Codex profile fails to load | Legacy `workspace-write`; commits need an escalation. |
| Budget exhausted | Trigger held; one line to the user saying who waits on whom. |
| Blockers exceed `task.review_rounds` | The task goes to the user with a summary. |
| `[ask-user]` posted | The task waits; its agent-to-agent deliveries are held until the user posts into it. |
| A status cell has no harness report | `default` for model and effort, a token count for context without a window, `n/a` otherwise. |
| Disk full | Stop accepting messages before acknowledging them. |

---

## 16. Verification ledger

Every vendor claim in this document is either quoted from official documentation or
measured on the development machine; nothing about vendor behaviour is stated from
memory. Probes: `probes/`, summaries under `probes/fixtures/summaries/`.

### Measured on the development machine

- **Codex 0.146.0 and 0.153.3, legacy `workspace-write`:** writes inside cwd succeed;
  outside fail; under `writable_roots` succeed; `/tmp` writable by default and closed by
  `exclude_slash_tmp`; reads succeed anywhere; Unix-socket connections denied; in a linked
  worktree `git add` fails because the index lock lives in the admin directory.
- **Codex 0.153.3 profiles, under `codex sandbox`:** `:root` and `/` accepted as read
  entries; a deny inside the root read holds; a read entry for a file inside a write
  region holds; a profile without a system read grant cannot start `sh`; a worktree-only
  profile cannot `git add` in a linked worktree; a profile that also grants the own admin
  directory, `objects/` and the own ref and reflog commits successfully and `main` does
  not move; `default_permissions` took effect with `sandbox_mode` loaded from the file.
- **Codex 0.153.3 CLI and schema:** `codex exec resume` has no `--cd` or `--sandbox`;
  the app-server schema defines `thread/start`, `thread/resume`, `turn/start`,
  `turn/steer` with `expectedTurnId`, `turn/interrupt`, the three `requestApproval`
  methods, the `autoApprovalReview` notifications, `ApprovalsReviewer` with
  `auto_review`; `thread/tokenUsage/updated` carries `tokenUsage.last` and `.total`
  (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`,
  `totalTokens`, optional `cacheWriteInputTokens`) and a nullable `modelContextWindow`;
  `thread/start` and `thread/resume` responses carry `model`, `reasoningEffort` and
  `cwd`; `turn/start` accepts `model` and `effort`; `thread/settings/updated` carries
  `model`, `effort` and `cwd`; `config/read` returns `model`, `model_reasoning_effort`
  and `model_context_window`; `ReasoningEffort` is a string; a `model/rerouted`
  notification exists with `fromModel`, `toModel`, `reason`.
- **Claude 2.1.261 and 2.1.263 flags:** `--settings`, `--permission-prompts host|none`,
  `--permission-mode auto`, `--include-hook-events`, `--session-id`, `--resume`,
  `--input-format stream-json`, `--effort <level>` "(low, medium, high, xhigh, max)",
  `--model <model>`; `--permission-prompt-tool stdio` is accepted though absent from
  `--help`; `claude -p --input-format stream-json` with stdin at end-of-file exits 0 and
  prints nothing.
- **Node 22.23.2, 24.20.0, 25.1.0, `node:sqlite`** (SQLite 3.51.3, 3.53.4, 3.50.4): twelve
  SIGKILLs per version at random points of a writer committing three-row transactions
  under WAL and `synchronous = FULL` lost no committed group and left no partial group;
  the pragmas, foreign keys, UNIQUE errors, AUTOINCREMENT, read-only connections and
  `busy_timeout` behaved as documented; 22 and 25 print the ExperimentalWarning, 24 does
  not. About 1.8 s per version. Not used (G11); recorded so the decision is informed.
- **Node 22.18 and later** run `.ts` files through type stripping, which rules out
  parameter properties and enums; all three lines above ran the probes without a build.
- **git 2.54.0:** the six `/apply` states; `merge.autoStash` defeats the overlap refusal
  without `--no-autostash`; a `pre-merge-commit` hook runs unpinned and not pinned; an
  ignored file in the way is overwritten with and without `--no-overwrite-ignore`; abort
  discards changes staged after the merge and keeps unstaged ones, and fails on an
  unstaged edit to an affected file; explicit `--git-dir` ignores a rewritten `.git`
  pointer; a snapshot through explicit paths works; `git status` in a touched peer
  worktree rewrites its index without `GIT_OPTIONAL_LOCKS=0` and not with it; a commit
  from a linked worktree under a profile that denies `packed-refs` prints the
  packed-refs.lock error and succeeds, while 2.50.1 does not touch the file. Two git
  binaries on `PATH`, Apple 2.50.1 first, Homebrew 2.54.0 second.
- **Claude Code 2.1.263, session (`probes/02*`):** `claude auth status` reports
  `authMethod` `claude.ai` and `apiProvider` `firstParty`; the init event follows the
  first user message and carries `model` `claude-fable-5-1` (settings say
  `claude-fable-5-1[1m]`), `cwd`, `session_id` equal to `--session-id`, `permissionMode`,
  `apiKeySource`, `claude_code_version`, `capabilities`, and no `effort`; three turns in
  one process; stdin close exits 0 in 0.3 s; `--resume <id>` keeps the id and the hook
  delivery; `--include-hook-events` emits `system/hook_started` and `system/hook_response`
  with `hook_name`, `stdout`, `exit_code`, `outcome`; the PostToolUse hook from inline
  `--settings` fired and its `additionalContext` reached the model; the hook input
  carried `cwd`, `permission_mode`, `effort.level` `xhigh` with `--effort` unset and `low`
  with `--effort low`, and the environment carried `CLAUDE_EFFORT` and
  `CLAUDE_PROJECT_DIR`; `assistant` events carry `message.model` and `message.usage` with
  the three input fields; the `result` carries `modelUsage` keyed by model with
  `contextWindow` 1000000 for the session model and a `claude-haiku-4-5` side entry;
  `rate_limit_event` and `system/thinking_tokens` messages appear; no `thinking` content
  blocks at `xhigh`; auto mode ran a `touch` in the worktree without any host handshake;
  manual mode without `--permission-prompt-tool stdio` denied the same `touch` with a
  `permission_denied` event, and with the flag sent a `control_request` of subtype
  `can_use_tool` and honoured the `control_response`; an MCP `--permission-prompt-tool`
  received `tool_name`, `input` and `tool_use_id`; an `initialize` control request is
  answered with the command catalogue and does not enable the stdio route; `sleep 130`
  is refused by the Bash tool itself; a 130 s `node` wait hit the 120 s timeout and was
  moved to the background; SIGKILL during a tool call, then `--resume`: same
  `session_id`, recovery turn succeeded, the killed call absent from the model's memory;
  `PostToolUseFailure` fired for a failing call with `error`, `is_interrupt` and
  `duration_ms`, delivered `additionalContext`, and the CLI rejected output whose
  `hookEventName` named the other event.
- **Claude Code 2.1.263, boundary (`probes/03*`):** with the settings of §12.1 as a
  whole: shell writes into the main tree, the peer worktree and the IPC directory fail
  with "operation not permitted", the drop-directory write succeeds, `cat` of a denied
  path is refused, `git commit` lands on the own branch with only that ref moving,
  `update-ref refs/heads/main`, a write into the peer's admin directory and `git
  pack-refs` are refused, native `Write` into the peer and integration worktrees and the
  deliveries directory is refused with "File is in a directory that is denied by your
  permission settings", native `Read` of a denied path is refused, an instructed native
  `Write` into the main tree is allowed by the classifier with no prompt, and the hooks
  fire on every tool call, `PostToolUse` for the successful ones and `PostToolUseFailure`
  for the failing ones. In the variants: with the sandbox alone the commit landed and
  `update-ref refs/heads/main` moved `main`; with `denyWrite` entries and no permission
  rules the commit landed and `main`, the peer admin directory, the peer and integration
  refs and `packed-refs` were refused; under `Edit(//<ipc dir>/**)` the drop-directory
  write failed; under `Edit(//<main>/**)` the commit failed on `index.lock` in the own
  admin directory, an explicit `allowWrite` of the git directory did not reopen it, and
  `[!.]*` in a rule matched nothing; `hooks/` and `config` in the shared git directory
  stayed denied throughout.
- **Codex 0.153.3 app-server (`probes/04`, `06`):** `initialize` then `initialized`;
  `thread/start` accepted the profile as a nested `config` map and answered with
  `approvalPolicy` `on-request`, `approvalsReviewer` `auto_review`, `model`
  `gpt-5.6-sol`, `reasoningEffort` `xhigh`, and a `sandbox` field listing the profile's
  write entries as `writableRoots`; no `thread/settings/updated` after start, no
  `activePermissionProfile` on the response, `permissionProfile/list` names only the
  built-in profiles; a missing profile fails `thread/start` with "default_permissions
  requires a `[permissions]` table"; a routine command ran with no approval and no
  review; `thread/tokenUsage/updated` on every request with `modelContextWindow` 258400
  and the cached count below the input count; `git commit` moved only the own branch with
  no approval and no review; `turn/steer` accepted during `sleep 6` and the steered word
  appeared in the reply, rejected after the turn with `-32600`; `thread/resume` in a new
  process returned the turns, remembered the first, and showed `reasoningEffort` `low`
  from `model_reasoning_effort` in the config map; an escalated write into the main tree
  was approved by Auto-review (`riskLevel` low, `userAuthorization` high, rationale
  citing the turn input) with no `requestApproval` to the client, and the rerun still
  failed under the profile; under legacy `workspace-write` an escalated `git commit` was
  approved by Auto-review and succeeded unsandboxed; `shell_environment_policy.set`
  applied, `inherit` `none`, `ignore_default_excludes` `false` and `filters` removed
  nothing; a 25 s command completed and its output reached the model; SIGKILL
  mid-command, then `thread/resume`: the killed turn shows `interrupted`, the thread is
  `idle`, a recovery turn completed. Turns took 5 to 33 s at effort `xhigh`.
- **Codex 0.153.3 `exec` (`probes/05`):** `-c default_permissions=… -c
  'permissions.<name>.filesystem={…}'` accepted as a TOML inline table; `--json` emits
  `thread.started` with `thread_id`, `turn.started`, `item.started`, `item.completed` and
  `turn.completed` with `usage.input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` and no model or
  window; `exec resume <id> -` read the prompt from stdin, ran in the spawn directory and
  remembered the first run; the commit moved only the own branch; a write into the main
  tree failed with "operation not permitted" and nothing asked for approval.
- **Recovery classification (`probes/07`), model-free:** 30 cases over snapshot,
  integrate, apply and abort with a crash injected after every step, once before the
  record was written and once after: every snapshot crash recovered to the uncrashed end
  state with exactly one snapshot commit; a ref moved by someone else before the update
  stopped with nothing overwritten; an integration merge that crashed after the command
  was recognized by its parents; a conflicting integration merge was aborted; a crash
  between the main merge and its record left the apply to the user and the abort refused
  the unrecorded index; a crash before the merge ran reran the preflight, which caught a
  file the user had created meanwhile; a merge the user committed before restart was
  recognized as done. 3.2 s.

### Documented

- **Claude Code sandboxing:** Bash-only OS sandbox; default write scope is the working
  directory, added directories and the session temp directory; the linked-worktree
  allowance quoted in §12.1; "When read rules overlap, the more specific path wins";
  `allowWrite` accepts absolute and `~/` paths; `Edit` permission rules and `Read` deny
  rules take part in building the sandbox configuration.
- **Claude Code permissions:** `Read(//path)` and `Edit(//path)` rules; "A Read deny rule
  also blocks the Edit and Write tools on the same path"; deny rules take precedence over
  allow.
- **Claude Code hooks and headless:** inline `--settings` JSON; `PostToolUse` runs "after
  a tool call succeeds" and `PostToolUseFailure` "after a tool call fails";
  `additionalContext` is appended to the tool result; streaming input queues messages;
  `--permission-prompts host` routes prompts to "the SDK host or
  `--permission-prompt-tool`"; the Bash tool's default timeout is 120 s.
- **Claude Code sessions:** per-working-directory storage; `--continue` scoped to the
  directory; `--resume <id>` finds a session from any directory since 2.1.223.
- **Claude Agent SDK:** claude.ai login not permitted for SDK agents.
- **Claude Code status line and hooks:** the status line receives `model.id`, `cwd`,
  `context_window.context_window_size`, `context_window.used_percentage`, "calculated from
  input tokens only", and `effort.level`, which "Reflects the live session value"; hook
  inputs carry `cwd` and `effort`, "Object with a `level` field holding the effort level
  in effect when the hook runs", present "for events that fire within a tool-use
  context".
- **Claude Code stream types:** the `system` init message carries `model`, `cwd` and
  `permissionMode` and omits `effort`; each `assistant` message carries `message.usage`;
  the `result` carries `modelUsage`, a map from model name to a record with
  `contextWindow`.
- **Claude Code effort:** `--effort` overrides the settings for the session and does not
  persist; an unsupported level "falls back to the highest supported level at or below
  the one you set"; `CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`.
- **Codex configuration:** `shell_environment_policy.inherit` default `all`;
  `ignore_default_excludes` default true, "Keep variables containing KEY, SECRET, or
  TOKEN"; `filters` is the canonical pattern map; `set` injects values.
- **Codex permissions:** `default_permissions` and `[permissions.<name>.filesystem]` with
  `read | write | deny`; the precedence sentence quoted in §12.2; Beta; "Configure either
  `default_permissions` and `[permissions]`, or `sandbox_mode` … but not both."
- **Codex Auto-review:** requires interactive approvals; `never` leaves nothing to review.
- **Codex app-server:** experimental; newline-delimited JSON-RPC with the `jsonrpc`
  header omitted; a client sends one `initialize` per connection; `thread/resume` loads
  a thread from disk by id.
- **Codex `exec`:** `--json` emits `turn.completed` with `usage.input_tokens`,
  `cached_input_tokens`, `output_tokens` and `reasoning_output_tokens`, and no field for
  the model or the context window.
- **git-merge:** `--abort` "will in some cases be unable to reconstruct the original
  (pre-merge) changes"; `--no-overwrite-ignore` is documented to abort.

### Open

The interactive comparison of the status bar's context figure with each harness's own
display, which needs the user at a terminal; the shape of `model/rerouted` in practice;
Auto-review's behaviour on an escalation the turn input did not authorize.

---

## 17. Testing

- **Core tests** with fake drivers: the fold over the log, addressing, the budget and its
  holds, the scheduler, and crash injection at every append.
- **Log tests:** a truncated last line, a duplicate op, a rebuilt fold equal to the live
  state after every event kind.
- **Protocol tests:** every marker and transition of §11.3, including wrong-author
  markers, a late `[done]`, the blocker cap, and `[ask-user]` holding and releasing.
- **Git matrix:** file kinds including symlinks, mode changes and deletions; snapshots
  over agent commits, including the no-change case; sequential integrations; both agents
  on the same and different files; main advancing before `/sync` and before `/apply`;
  the six `/apply` states; abort with a changed, an unchanged and an unrecorded index; a
  crash after each step with the recovery of §13.5; hooks never run; autostash never
  engages; discovery never used.
- **Status bar tests:** every cell unknown before the first report; a percentage only
  with a known window; `default` only when neither configuration nor the harness
  supplied a value; the harness's value when the two differ.
- **Driver fixtures** recorded from the sanitized vendor streams under `probes/fixtures/`;
  live smoke tests opt-in. A vendor upgrade that changes an event shape disables that
  driver until its fixture parses again.

---

## 18. Implementation

TypeScript on Node 22.18 or later, run through Node's type stripping with no build step
(no parameter properties, no enums). No runtime dependencies beyond a TOML parser.
Vendor types stop at the driver boundary.

```text
src/
  cli.ts            entry: chatroom, new, list, continue, delete, log, doctor, and the agent commands
  repl.ts           input, transcript, activity, prompts, status bar
  log.ts            append with fsync, fold, startup read
  room.ts           addressing, budget, scheduler, turns, markers and tasks
  ipc.ts            drop directories, receipts, deliveries, the agent commands' side
  drivers/          claude.ts, codex.ts (app-server and exec), env.ts, doctor.ts
  git.ts            pinned invocation, refs and expectations, snapshot, integrate, sync, apply, recovery
  brief.ts          the brief and the delivery format
```

The agent-command entry path imports only `ipc.ts`. `probes/` holds the Phase 0 probes
and their fixtures; nothing in `src/` imports them.

---

## 19. Build order

1. **Room core**, model-free: the log, addressing, budget, scheduler, turns, markers, with
   fake drivers and crash injection. Exit: a crash at any append loses or duplicates
   nothing, and the protocol tests pass.
2. **Agents**: the agent commands and IPC, the Claude and Codex drivers with the
   boundary settings of §12, the doctor, the status bar. Exit: both agents chat
   concurrently, receive a mid-turn message, commit on their own branches, and the status
   bar shows what the harnesses report.
3. **Git**: snapshots, `/integrate`, `/sync`, `/import`, `/apply` with preflight and abort,
   `/adopt`, recovery, the git matrix. Exit: the six `/apply` states behave as measured and
   every abort either succeeds cleanly or stops with the reason.

Later: sync conflict resolution through the chatroom; `/apply --commit`; archiving;
rendering polish.

---

## 20. Open decisions

1. `/apply --commit` and its message format (proposed).
2. Sync conflict resolution for a later release: the user resolves files in the agent
   worktree and the chatroom commits, versus an agent turn.
3. Changing an agent's model or effort from the REPL; both harnesses accept it, the
   status bar already shows what is in force.
4. Decided 2026-09-07 for simplicity: the harness homes are a sentence in the brief, not
   a deny rule.

---

## 21. References

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Claude Code status line: https://code.claude.com/docs/en/statusline
- Claude Code model configuration: https://code.claude.com/docs/en/model-config
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex permission profiles: https://learn.chatgpt.com/docs/permissions
- Codex Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
- Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- git-merge and git-worktree manuals: `git merge --help`, `git worktree --help`

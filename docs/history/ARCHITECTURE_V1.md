# Chatroom Architecture

Status: design draft, revised 2026-09-04. No code exists yet. Everything here was decided
in conversation; items marked **proposed** were not explicitly decided and can be dropped.
Section 17 separates what has been measured on this machine, what is documented, and what
still has to be verified.

Verified against the installed tools: Claude Code 2.1.260, Codex CLI 0.146.0.

---

## 1. Purpose

A terminal group chat with three participants: the user, Claude (via Claude Code) and
Codex (via the Codex CLI). All three see every message. Anyone can address anyone. The two
agents work in parallel on the user's project, each in its own git worktree, and cooperate
through the chat rather than compete or review each other independently. Agents can post
to the chat while they work, and messages posted by others reach them while they work.

`chatroom` is a single globally installed command. A project opts in by running it once
inside the repo, which creates a `.chatroom/` directory holding only data. Running plain
`claude` or `codex` in the same project remains completely unaffected.

### Non-goals for v1

- Interactive approvals for Codex. Codex runs sandboxed with no prompts (see §11.3).
- More than these two agents.
- Any UI other than the terminal REPL.
- Steering a running Codex turn through its app-server protocol (see §9.5).

---

## 2. Principles

Each of these is a decision, not a preference. Later sections follow from them.

1. **Global tool, per-project data.** Code lives in one installed place. `.chatroom/`
   contains conversations, logs and worktrees, nothing executable.
2. **Zero footprint.** The chatroom never writes to CLAUDE.md, AGENTS.md, `.claude/`,
   `.codex/` or `.gitignore`. Its brief, hooks and settings reach each agent through the
   invocation itself. `.chatroom/` is hidden from git via `.git/info/exclude`.
3. **Headless, per-turn invocation with session resume.** Each turn is one short-lived
   CLI process. Both CLIs persist sessions, so context carries over. The chatroom
   delivers only what the agent has not yet seen.
4. **The transcript is the truth, sessions are a cache.** If a session cannot be
   resumed, a fresh one is rebuilt from the transcript.
5. **Speaking needs no ceremony.** An agent's final reply is a message. During a turn an
   agent can post with one command. The orchestrator appends both to the transcript.
6. **Everyone sees everything.** Every message is delivered to every participant.
   `@mentions` decide who is expected to act, not who may read.
7. **Parallel, not turns.** Each agent has an inbox and at most one turn in flight.
   Agents run concurrently whenever both have something to do, and messages reach a
   working agent without waiting for its turn to end where the harness allows it.
8. **Own worktree only.** Each agent may read the other's worktree and the main tree,
   and writes only to its own. No norms about committing.
9. **Bounded autonomy.** A hop budget limits how many agent-to-agent deliveries can
   happen before the user speaks again. It is changeable from the REPL.
10. **Conversations own sessions.** A chatroom conversation holds exactly one session per
    harness, with constant ids. Sessions started by the chatroom are never the ones the
    user starts by hand, and vice versa.
11. **Files, not sockets, between agent and orchestrator.** Codex's sandbox denies Unix
    sockets and allows a designated writable directory, so all agent-to-orchestrator
    traffic goes through files.

---

## 3. Components

```
 ┌───────────────────────────────── chatroom process ─────────────────────────────────┐
 │                                                                                    │
 │   REPL (terminal UI)                                                               │
 │     input line · transcript view · activity/reasoning stream · status line         │
 │     permission prompts                                                             │
 │            │                                          ▲                            │
 │            ▼                                          │                            │
 │   Orchestrator                                                                     │
 │     conversations · message ids · mention resolution · inboxes & cursors           │
 │     hop budget · delivery scheduler · outbox watcher                               │
 │     single writer of transcript.jsonl and state.json                               │
 │            │                                          ▲                            │
 │      ┌─────┴──────┐                            ┌──────┴──────┐                     │
 │      ▼            ▼                            │             │                     │
 │  Claude driver   Codex driver     ◄── stream events, replies, permission requests  │
 │  (stream-json    (--json / -o)                                                     │
 │   in + out)                                                                        │
 └──────┼────────────┼────────────────────────────────────────────────────────────────┘
        │            │            child processes, cwd = own worktree
        ▼            ▼
   claude -p …    codex exec …
   .chatroom/worktrees/claude    .chatroom/worktrees/codex
        │  ▲            │  ▲
        ▼  │            ▼  │     files only
   ipc/claude/{outbox,inbox}   ipc/codex/{outbox,inbox}
   written/read by `chatroom post`, `chatroom inbox`, `chatroom hook`, `chatroom ask`
   running inside the agent's tool shell
```

| Component | Responsibility |
|---|---|
| REPL | Reads user input, renders the transcript, activity and reasoning, shows permission prompts and collects answers, runs slash commands. |
| Orchestrator | Owns all state. Manages conversations, assigns message ids, resolves mentions, maintains per-agent inboxes and cursors, enforces the hop budget, starts turns and delivers messages, watches outboxes, writes the transcript. Single-threaded event loop. |
| Agent driver (one per agent) | Spawns that CLI for a first or resumed turn with the right flags, feeds it the prompt, parses its event stream into a common shape, relays permissions, detects session loss. |
| Agent-side commands | Subcommands of the same `chatroom` binary, run by the agent inside its tool shell: `post`, `inbox`, `ask`, `hook`. They only touch the agent's own `ipc/` directory. |
| Transcript | Append-only JSONL per conversation. |
| State | Small JSON file per conversation: sessions, cursors, in-flight turns, hop budget. |
| Worktrees | One git worktree per agent, created and managed by the chatroom, shared by all conversations. |

---

## 4. Layout on disk

### Global

```
<install location>/chatroom           the executable; also on PATH inside agent tool shells
~/.config/chatroom/config.toml        optional user defaults
```

### Per project

```
<project>/
  .chatroom/
    current                     id of the active conversation
    lock                        held while a chatroom process runs in this project
    config.json                 optional per-project overrides
    conversations/
      <conv-id>/
        meta.json               name, created, last_used
        transcript.jsonl        messages and events, append-only
        state.json              sessions, cursors, in-flight turns, hop budget
        log/
          <turn-id>.claude.jsonl   raw event stream of each turn
          <turn-id>.codex.jsonl
          <turn-id>.codex.last     the -o output file for Codex turns
        ipc/
          claude/
            outbox/             agent → orchestrator: posts
            inbox/              orchestrator → agent: deliveries awaiting pickup
            inbox/consumed/     picked-up deliveries, cleaned by the orchestrator
          codex/
            outbox/
            inbox/
            inbox/consumed/
    worktrees/
      claude/                   git worktree on branch chatroom/claude
      codex/                    git worktree on branch chatroom/codex
```

`chatroom` adds the single line `/.chatroom/` to `.git/info/exclude` on first run. That
file is local to the clone and never committed, so the project's tracked files do not
change.

---

## 5. Data formats

### 5.1 Transcript (`transcript.jsonl`)

One JSON object per line. Two kinds: `message` (chat content, delivered to agents) and
`event` (bookkeeping, shown in the UI, never delivered to agents).

```json
{"id": 41, "kind": "message", "ts": "2026-09-04T21:07:12Z",
 "from": "user", "to": ["claude", "codex"],
 "body": "Please implement X."}

{"id": 42, "kind": "message", "ts": "2026-09-04T21:07:40Z",
 "from": "codex", "to": ["claude"], "via": "post",
 "body": "@claude I'll take the parser; you take the CLI?",
 "turn": "t-0008"}

{"id": 43, "kind": "message", "ts": "2026-09-04T21:08:01Z",
 "from": "claude", "to": ["codex"], "via": "post",
 "body": "@codex Agreed, CLI is mine.",
 "turn": "t-0007"}

{"id": 44, "kind": "event", "ts": "2026-09-04T21:09:30Z",
 "event": "silent", "agent": "claude", "turn": "t-0007"}
```

| Field | Meaning |
|---|---|
| `id` | Monotonic integer per conversation, assigned by the orchestrator. Shared by messages and events. |
| `kind` | `message` or `event`. |
| `from` | `user`, `claude` or `codex`. |
| `to` | Resolved addressees (§6). Always non-empty for messages. |
| `via` | For agent messages: `post` (sent mid-turn with `chatroom post` or `ask`) or `reply` (the turn's final reply). |
| `body` | Message text as written. Mentions are left in place. |
| `turn` | For agent messages and turn events: the turn during which it happened. |
| `cost` | On `turn_ended` events: whatever the driver could extract (duration, tokens, USD). |
| `event` | `turn_started`, `turn_ended`, `turn_failed`, `turn_timeout`, `silent`, `delivered`, `permission_request`, `permission_decision`, `session_started`, `session_lost`, `session_rebuilt`, `budget_exhausted`, `hops_changed`, `merge`, `sync`, `stopped`, `outbox_rejected`. |

The orchestrator is the only writer. Each line is written with a single append call, and
a trailing partial line is discarded on load.

### 5.2 State (`state.json`, per conversation)

```json
{
  "version": 1,
  "hops": {"limit": 6, "used": 2},
  "next_turn": 9,
  "agents": {
    "claude": {
      "session_id": "3f5a…",
      "previous_sessions": [],
      "cwd": ".chatroom/worktrees/claude",
      "cursor": 43,
      "in_flight": {"turn": "t-0007", "delta_from": 41, "delta_to": 41, "started": "2026-09-04T21:07:13Z"},
      "pending_delivery": [42]
    },
    "codex": {
      "session_id": "019…",
      "previous_sessions": [],
      "cwd": ".chatroom/worktrees/codex",
      "cursor": 43,
      "in_flight": null,
      "pending_delivery": []
    }
  }
}
```

| Field | Meaning |
|---|---|
| `hops.limit` | Maximum agent-to-agent deliveries since the last user message. Set by `/hops N`. |
| `hops.used` | Counter, reset to 0 whenever a user message is posted. |
| `session_id` | The harness's session or thread id. Constant for the life of the conversation, except after session loss (§7.4). |
| `previous_sessions` | Ids replaced after session loss, for the record. |
| `cwd` | Where that session must be resumed from. |
| `cursor` | Highest message id handed to this agent, whether in a turn's delta or as a mid-turn delivery. |
| `in_flight` | Present while a turn is running. On startup any `in_flight` is treated as lost (§15). |
| `pending_delivery` | Ids written to the agent's inbox directory and not yet picked up. Rolled into the next delta if the turn ends first. |

State is rewritten atomically after every change.

### 5.3 Conversation metadata (`meta.json`)

```json
{"id": "2026-09-04-2107-parser", "name": "parser", "created": "2026-09-04T21:07:00Z", "last_used": "2026-09-04T22:41:10Z"}
```

### 5.4 Config

Keys, all optional, project file overriding global:

| Key | Default | Purpose |
|---|---|---|
| `hops` | 6 | Initial hop limit for a new conversation. |
| `turn_timeout_minutes` | 30 | Kill a turn that runs longer. |
| `ask_timeout_seconds` | 90 | How long `chatroom ask` waits for a reply (§9.4). |
| `claude.model`, `codex.model` | tool default | Passed as `--model` / `-m`. |
| `claude.permission_mode` | `auto` | Any value the CLI accepts except `bypassPermissions`. |
| `codex.sandbox` | `workspace-write` | `read-only` or `workspace-write`. |
| `brief.extra` | "" | Text appended to both briefs, for project-specific guidance. |
| `show` | `activity` | Default display level (§12). |

---

## 6. Participants and addressing

Handles: `user`, `claude`, `codex`. A mention is `@` followed by a handle or `all`, at a
word boundary, case-insensitive, anywhere in the body. Mentions inside fenced code blocks
and inline code are ignored.

Resolution of `to` from the author and the mentions found:

| Author | Mentions | `to` |
|---|---|---|
| user | none | `claude`, `codex` |
| user | `@all` | `claude`, `codex` |
| user | some | the mentioned agents |
| agent | none | `user` |
| agent | `@all` | `user` and the other agent |
| agent | some | the mentioned participants, minus the author |

Consequences that the brief spells out to the agents:

- A message with no mention from an agent is a status update to the user. It does not
  wake the other agent, which will read it at its next delivery.
- To hand something to the other agent, or ask it a question, the agent must mention
  it. That is a delivery and spends a hop.

---

## 7. Conversations and sessions

Terminology: a **conversation** is a chatroom-level thing, with its own transcript and
state. A **session** is a Claude Code or Codex thing, the harness's persisted context.
A conversation holds exactly one session per harness.

### 7.1 Lifecycle

| Command | Effect |
|---|---|
| `chatroom` | Open the current conversation, creating one if the project has none. |
| `chatroom new [name]` | Create a conversation and make it current. Sessions are created lazily on each agent's first turn. |
| `chatroom list` | Conversations with name, created, last used, message count. |
| `chatroom continue <name\|id>` | Make that conversation current and open it. |
| `/new [name]`, `/switch <name\|id>`, `/conversations`, `/rename <name>` | The same from inside the REPL. `/new` and `/switch` first stop any in-flight turns after confirmation. |

"Clearing" is `chatroom new`: the old conversation stays on disk and can be continued
later. Nothing is deleted unless the user runs `chatroom delete <name|id>`.

Session ids are constant within a conversation. Claude's id is a UUID generated by the
chatroom and passed with `--session-id` on the first turn. Codex's id is the `thread_id`
reported in the `thread.started` event of the first turn. Both are stored in `state.json`
and used with `--resume` / `exec resume` on every later turn.

### 7.2 Worktrees across conversations

**Proposed:** worktrees belong to the project, not to the conversation. A new conversation
starts with the worktrees in whatever state the previous one left them, and `/sync` resets
them to the main tree's HEAD when a clean start is wanted. The alternative, a worktree pair
per conversation, costs a full checkout and dependency setup per conversation and is not
needed while conversations are used sequentially.

### 7.3 Isolation from sessions the user runs directly

Requirement: the user can run `claude` in the project, exit, run a chatroom conversation,
exit, and then continue the original `claude` session, and the chatroom never touches it.

Mechanism:

- The chatroom always runs both CLIs with the agent's worktree as working directory, never
  the main tree. Claude Code stores sessions per working directory under
  `~/.claude/projects/<encoded path>/`, and `claude --continue` is documented as picking
  the most recent session in the current directory. Codex's `resume` picker filters by
  working directory by default. So sessions created in a worktree do not show up as
  "most recent" in the main tree.
- The chatroom never uses `--continue`, `--last`, or either tool's picker. It resumes only
  by the explicit id stored in the conversation. It therefore cannot pick up a session the
  user started by hand, whatever the working directory.
- If the user runs `claude` or `codex` by hand inside `.chatroom/worktrees/<agent>/`, they
  will see the chatroom's sessions there. That is expected and harmless.

To verify: since Claude Code 2.1.223, `--resume <id>` searches all projects and git
worktrees. Whether the interactive picker in the main tree also lists worktree sessions is
not documented. If it does, chatroom sessions are visible in the picker but still never
chosen by `--continue`.

### 7.4 Session loss

If a resume fails because the session is unknown (deleted session files, tool upgrade,
moved worktree), the driver reports `session_lost`. The orchestrator moves the old id to
`previous_sessions`, starts a fresh session with the brief followed by a catch-up prompt
containing the full transcript of messages, records `session_lost` and `session_rebuilt`
events, and continues. This is the only way a conversation's session id changes.

---

## 8. Turn and delivery model

### 8.1 Definitions

- **Inbox(A)**: messages with `id > cursor(A)` and `from ≠ A`, not yet handed to A.
- **Trigger for A**: a message in Inbox(A) with `A ∈ to`.
- **Turn**: one CLI process for one agent. Its **delta** is the whole inbox at the moment
  the turn starts.
- **Delivery**: handing a set of messages to A, either as a turn's delta or mid-turn
  through A's inbox directory (§9.2). A delivery containing at least one trigger is a
  **triggering delivery**.
- **Cost of a triggering delivery**: 1 hop if none of its triggers was authored by the
  user, else 0.
- **Budget**: a delivery that costs a hop may happen only if `hops.used < hops.limit`.

### 8.2 Scheduling rule

Run whenever a message is posted, a turn ends, a delivery is picked up, a user message
arrives, or the hop limit changes:

```
for each agent A:
    if Inbox(A) has no trigger: continue
    cost = 0 if any trigger in Inbox(A) is from user else 1
    if cost == 1 and hops.used >= hops.limit:
        mark A held; continue
    if A has no turn in flight:
        start turn for A with delta = Inbox(A)
    elif A's harness supports mid-turn injection:
        write Inbox(A) to ipc/A/inbox/ ; add ids to pending_delivery(A)
    else:
        continue          # queued until A's turn ends
    cursor(A) = max id handed over
    hops.used += cost
```

When a user message is posted: `hops.used = 0`, then the rule runs. Held agents therefore
resume on the next user message or budget increase.

An agent with only non-trigger messages in its inbox is left alone. It reads them with
the next triggering delivery.

### 8.3 Turn lifecycle

1. Build the delta prompt (§10.1). For a first turn, prepend the brief where the tool has
   no system-prompt flag (Codex).
2. Record `in_flight`. Append a `turn_started` event. Clear the agent's `ipc/` directories.
3. Spawn the CLI process in the agent's worktree with the environment of §9.1. Stream its
   events to the REPL. Relay permission requests (§11.2). Watch the outbox (§9.2).
4. On exit, extract the final reply.
   - Reply is empty or exactly `[silent]` after trimming: append a `silent` event.
   - Otherwise: resolve mentions, append a `message` with `via: "reply"`.
5. Any ids in `pending_delivery` whose inbox files were never consumed are rolled back so
   they lead the next delta. Their hop, if one was spent, is not spent again.
6. Clear `in_flight`. Append `turn_ended` with cost. Run the scheduling rule.

### 8.4 Why the slower reply is recorded rather than discarded

When both agents are addressed at once, both run, and both replies are posted in arrival
order. Each then receives the other's reply and reconciles. Discarding the slower reply
was considered and rejected: the reply already exists in that agent's own session history,
its side effects in the worktree have already happened, and the "reprompt with the other's
reply" is exactly what the delivery does anyway.

Duplicate work is instead prevented by a norm in the brief: on a task addressed to both,
the first thing each does is post a short claim of what it will take. With mid-turn
posting the claim arrives within seconds, before either has built anything.

### 8.5 Worked example

Hop limit 6. The user addresses both. Both harnesses support mid-turn injection.

```mermaid
sequenceDiagram
    participant U as user
    participant O as orchestrator
    participant C as claude (turn t7)
    participant X as codex (turn t8)
    U->>O: #41 "Implement X." (to: claude, codex; hops.used=0)
    par
        O->>C: start t7, delta [#41]
    and
        O->>X: start t8, delta [#41]
    end
    X-->>O: post "@claude I'll take the parser; you take the CLI?"
    O->>O: #42 (to: claude). claude busy, injection supported → inbox, cost 1 (used=1)
    C-->>O: post "@codex Agreed, CLI is mine."
    O->>O: #43 (to: codex) → inbox, cost 1 (used=2)
    O->>C: #42 picked up by claude's PostToolUse hook
    O->>X: #43 picked up by codex's PostToolUse hook
    X-->>O: reply "Parser done in my worktree, tests pass."
    O->>O: #45 (to: user). No trigger for claude. t8 ends
    C-->>O: reply "[silent]"
    O->>O: event #44 silent. t7 ends
    U->>O: #46 "@claude wire in codex's parser." (used=0)
    O->>C: start t9, delta [#45, #46] (cost 0)
```

Two hops were spent, both on the claim exchange. Claude's `[silent]` shows the exit valve
for a turn that already said everything through posts.

---

## 9. Mid-turn messaging

An agent can speak while it works and hear while it works. The three parts are outgoing
posts, incoming deliveries, and a blocking ask. All of them go through files in the
agent's own `ipc/` directory, because Codex's sandbox denies Unix sockets (measured) and
allows extra writable directories through configuration (measured).

### 9.1 Environment inside the agent's tool shell

The driver sets these variables on the child process. Both harnesses pass the parent
environment to tool shells (Codex's `shell_environment_policy.inherit` defaults to `all`;
the chatroom additionally pins them with `shell_environment_policy.set`, §11.3).

| Variable | Value |
|---|---|
| `CHATROOM_AGENT` | `claude` or `codex` |
| `CHATROOM_IPC` | absolute path of `ipc/<agent>/` |
| `CHATROOM_TURN` | the turn id |

The agent-side commands read only these. Identity comes from the environment and from
which directory a file appears in, never from the file's content, so an agent cannot post
as someone else.

### 9.2 Outgoing: `chatroom post`

```
chatroom post "@codex the parser interface is in src/parser.py, ready for you"
```

Writes `{"ts": …, "body": …}` to a temporary file inside `ipc/<agent>/outbox/` and renames
it into place. The orchestrator watches the outbox with filesystem events and a one-second
poll fallback, assigns an id, appends the message with `via: "post"`, removes the file,
and runs the scheduling rule. The command prints the assigned id.

Files that are not valid JSON, exceed a size cap, or appear while no turn is in flight are
moved aside and recorded as `outbox_rejected`.

### 9.3 Incoming: `chatroom inbox` and `chatroom hook`

The orchestrator delivers to a working agent by writing one file per message into
`ipc/<agent>/inbox/`. Two consumers exist:

- `chatroom inbox` prints every pending file in the delivery format (§10.2) and moves
  it to `inbox/consumed/`. An agent may run it whenever it wants to check the room.
- `chatroom hook` is the same, wrapped for the harness's hook system. It reads the hook
  event JSON on stdin, drains the inbox, and if anything was pending prints

  ```json
  {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<delivery text>"}}
  ```

  Both Claude Code and Codex document this exact output shape and inject
  `additionalContext` into the model's context. Registered on `PostToolUse`, it delivers
  new messages after every tool call, which is as close to real time as a working agent
  can hear. An agent that is generating text without tool calls hears nothing until its
  next tool call or its turn ends, in which case the messages lead its next delta.

How the hook is registered without touching any file in the project is per harness
(§11.1, §11.3). The orchestrator learns that a delivery was picked up by seeing the file
move to `consumed/`, and records a `delivered` event.

Codex caps injected context at 2500 tokens by default and spills larger output to a file;
the delivery text is kept well under that, and long bodies are truncated with a note to
run `chatroom inbox` for the full text.

### 9.4 Waiting for an answer: `chatroom ask`

```
chatroom ask "@codex does the parser return a list or an iterator?"
```

Posts the message, then blocks until a delivery arrives that is addressed to the asker
by one of the mentioned participants, or until `ask_timeout_seconds` elapses. It prints
every delivery that arrived meanwhile and exits 0 on an answer, 1 on timeout with the
text "no answer yet; carry on and check `chatroom inbox` later". The timeout stays under
the harnesses' default tool-command timeouts so the shell call itself is never killed.

`ask` is sugar over `post` plus polling the inbox directory, so it needs no new mechanism.
**Proposed** but recommended: it is the natural way for one agent to ask the other a
quick question without ending its turn.

### 9.5 What is not possible in v1

- Codex cannot receive input on stdin during an `exec` turn. Its app-server protocol has
  `turn/steer` and `turn/interrupt`, which is the eventual way to inject without waiting
  for a tool call. The hook route above covers the practical need.
- Claude Code's behaviour when a second `user` message is written to stdin during a turn
  is undocumented. If a test shows it is injected rather than queued, it becomes the
  preferred delivery path for Claude and the hook stays as fallback.
- **Later optimisation, not designed here:** both harnesses have a `Stop` hook that can
  refuse the stop and hand the model a reason. When an agent is about to end its turn
  while triggers are waiting, this could continue the same process instead of starting a
  new one.

---

## 10. What the agents receive

### 10.1 The delta prompt

Sent as the user message of every turn. Compact and machine-generated.

```
[chatroom] You are @claude. 2 new messages since your last turn.
Reply to the room. Mention @codex or @user to address them. Reply exactly [silent] to post nothing.
While working: `chatroom post "<text>"` speaks now; `chatroom inbox` shows new messages; new messages also arrive after tool calls.

--- #41 · user → @claude @codex · 2026-09-04 21:07:12
Please implement X.

--- #42 · codex → @claude · 2026-09-04 21:07:40
@claude I'll take the parser; you take the CLI?
```

The header repeats the essentials of the brief on every turn, so the rules survive
context compaction inside the agent's session.

**Proposed** trailer, cheap to compute and easy to drop:

```
Changed in codex's worktree since your last turn: src/parser.py, tests/test_parser.py
```

### 10.2 The delivery text

Used by `chatroom inbox`, `chatroom hook` and `chatroom ask`. Same message format as the
delta, with a one-line header:

```
[chatroom] 1 new message while you work.
--- #43 · claude → @codex · 2026-09-04 21:08:01
@codex Agreed, CLI is mine.
```

### 10.3 The brief

Delivered to Claude via `--append-system-prompt` on every invocation, and to Codex as the
opening of its first prompt. It is a template; the chatroom fills in handles and absolute
paths. Draft:

```
You are @{me} in a chatroom with @user and @{other}. Everything anyone writes is visible to
all three of you. You are here to solve the user's task together with @{other}: build on
each other's work, split work explicitly, disagree with reasons, and do not restate or
praise what the other has said. Act instead of acknowledging.

Speaking
- Run `chatroom post "<text>"` to say something now, while you keep working. Your final
  reply is also posted. If your posts already said everything, reply exactly [silent].
- Run `chatroom ask "<text>"` to ask a question and wait briefly for the answer.
- Mention @{other} only when you need something from them (a question, a handoff, a
  review). Mentioning them interrupts their work. A message without mentions goes to the user.
- Address @user only when you need a decision or are reporting completion.
- Keep messages short. Results live in the tree, coordination lives in the chat.

Hearing
- New messages reach you after each tool call, marked [chatroom]. Read them before your
  next step. `chatroom inbox` shows them on demand.

When a task is addressed to both of you
- Before doing anything else, post what you will take, in one or two lines. If the other's
  claim overlaps yours, resolve it in the chat, then work.

Where you work
- Your worktree: {my_worktree}. Write only here.
- @{other}'s worktree: {other_worktree}. Read it whenever useful, never write to it. It may
  be mid-edit; the chat is where intent is stated.
- The user's main tree: {main_tree}. Read only. The user merges from your worktree when
  ready.

Messages look like "--- #id · from → @to · time" followed by the body.
```

`brief.extra` from config is appended verbatim.

---

## 11. Agent drivers

Both drivers expose the same interface to the orchestrator:

```
start_turn(agent, prompt, is_first, env) -> stream of
    activity(kind, text)          kind ∈ {text, reasoning, tool, tool_result}  (§12)
    permission_request(id, tool, input)   Claude only in v1
    reply(text, cost, session_id)
    error(kind, detail)           kind ∈ {exit, timeout, session_lost, parse}
answer_permission(id, allow: bool, message?: str)
stop()                            SIGTERM, then SIGKILL after a grace period
```

### 11.1 Claude Code

Working directory: `.chatroom/worktrees/claude`.

```
claude -p \
  --session-id <uuid>              # first turn (uuid generated by the chatroom)
  --resume <uuid>                  # every later turn
  --append-system-prompt "<brief>" \
  --settings '{"hooks":{"PostToolUse":[{"matcher":"","hooks":[{"type":"command","command":"chatroom hook"}]}]}}' \
  --permission-mode auto \
  --permission-prompts host \
  --input-format stream-json \
  --output-format stream-json \
  --include-hook-events \
  --verbose \
  [--model <model>]
```

- The prompt is written to stdin as a `user` message in stream-json form, not passed as
  an argument, because stdin must stay open to answer permission requests. It is closed
  after the `result` event.
- The system prompt is not part of the persisted session, so `--append-system-prompt` is
  passed on every turn. The hook likewise comes from `--settings` on every turn. Inline
  JSON for `--settings` is documented. Neither writes a file anywhere.
- Reply text comes from the `result` event, which also carries duration and cost.
- Session files live under `~/.claude/projects/<encoded worktree path>/<uuid>.jsonl`.

### 11.2 Permission relaying (Claude)

With `--permission-prompts host`, anything `auto` mode would have asked the user is sent
to the chatroom as a control request on stdout instead of being denied. The REPL shows it
inline:

```
[claude] wants Bash: rm -rf build/            (y) allow  (n) deny  (a) allow this session  (m) deny with message
```

The answer is written back on stdin as a control response. Until answered, the agent is
blocked and its status reads `waiting for approval`. Multiple pending requests queue in
order. "Allow this session" is implemented in the orchestrator by remembering the exact
tool and input and auto-answering identical requests for the rest of the chatroom run.
Every request and decision is recorded as an event.

The wire shapes of the request and response are not in the official docs; a third-party
protocol description exists and the smoke test confirms them (§17).

### 11.3 Codex

Working directory: `.chatroom/worktrees/codex`.

```
# first turn
codex exec --json --sandbox workspace-write \
  -c 'sandbox_workspace_write.writable_roots=["<abs path of ipc/codex>"]' \
  -c 'shell_environment_policy.set={CHATROOM_AGENT="codex",CHATROOM_IPC="<abs path>",CHATROOM_TURN="<turn>"}' \
  -c 'hooks.PostToolUse=[{hooks=[{type="command",command="chatroom hook"}]}]' \
  --dangerously-bypass-hook-trust \
  -o <conv>/log/<turn>.codex.last \
  "<brief + delta>"

# later turns
codex exec resume <thread-id> --json \
  -c 'sandbox_mode="workspace-write"' \
  -c 'sandbox_workspace_write.writable_roots=[…]' -c 'shell_environment_policy.set={…}' \
  -c 'hooks.PostToolUse=[…]' --dangerously-bypass-hook-trust \
  -o <conv>/log/<turn>.codex.last \
  "<delta>"
```

- `codex exec resume` has neither `--cd` nor `--sandbox`. The working directory is set by
  spawning the process in the worktree, and the sandbox through `-c sandbox_mode`.
  Resuming by an explicit UUID does no working-directory filtering (from source).
- `writable_roots` opens exactly one extra directory, the agent's own `ipc/`. Measured:
  without it, writes outside the worktree fail with "Operation not permitted"; with it,
  they succeed; writes inside the worktree succeed; reads anywhere succeed; Unix socket
  connections fail. Note that `/tmp` and `$TMPDIR` are writable by default in
  workspace-write mode.
- Hooks: Codex's hook system is stable in 0.146 and documents the same
  `additionalContext` output as Claude Code. Hooks are normally read from
  `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`, both of which the zero-footprint
  rule forbids. The source shows the loader also reads a `hooks` key from `-c` overrides.
  Hooks not previously trusted are skipped unless `--dangerously-bypass-hook-trust` is
  given; the flag is documented as intended for automation that vets its own hook
  sources, which is this case, since the only hook is the chatroom's own command.
  Fallback if the `-c` route fails the smoke test: a single entry in `~/.codex/hooks.json`
  that runs `chatroom hook`, which exits immediately with no output when `CHATROOM_AGENT`
  is unset. That is a footprint in the user's global Codex config, not in the project.
- Reply text is read from the `-o` file. The thread id for later resumes is `thread_id`
  in the `thread.started` event.
- Codex in exec mode never asks for approval. A command that needs more than the sandbox
  allows fails, the failure is reported to the model, and the model says so in the chat.
  Interactive approvals exist only in Codex's interactive mode and its app-server
  protocol, which is out of scope for v1.
- Session files live under `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.

### 11.4 Enforcement of "own worktree only", by tool

| | Read other worktree / main tree | Write outside own worktree and own `ipc/` |
|---|---|---|
| Codex | allowed by the sandbox (measured) | blocked by the sandbox (measured) |
| Claude | allowed | treated as an out-of-directory edit by the permission system; surfaces as a relayed prompt to the user |

The other agent's worktree is never passed to Claude via `--add-dir`, because that grants
write access along with read.

### 11.5 Timeouts and stopping

A turn that exceeds `turn_timeout_minutes` is stopped. `/stop <agent>` does the same on
demand. In both cases: SIGTERM, a short grace period, SIGKILL; a `turn_timeout` or
`stopped` event; the cursor is rolled back so the delta is redelivered on the next turn
with a note that the previous attempt was cut short.

---

## 12. Activity and reasoning display

Both event streams carry what the two interactive UIs show, so the REPL can show it too.

| Kind | Claude Code (`stream-json`) | Codex (`--json`) |
|---|---|---|
| `text`, interim narration between tool calls | `assistant` messages, `text` blocks | `item.completed` with `type: "agent_message"`, except the last one, which is the reply |
| `reasoning` | `thinking` blocks in `assistant` messages (to verify) | `item.*` with `type: "reasoning"`, `text` is the summary |
| `tool` | `tool_use` blocks: name and a one-line summary of input | `command_execution` (`command`), `file_change` (`changes`), `mcp_tool_call`, `web_search`, `todo_list` |
| `tool_result` | `user` messages carrying `tool_result`, truncated | `command_execution.aggregated_output`, `exit_code`, truncated |
| token-level streaming | `--include-partial-messages` | `item.updated` |

Display levels, set with `/show` and defaulting to the `show` config key:

| Level | Shows |
|---|---|
| `quiet` | messages, events, status line |
| `activity` | plus `text` and `tool` lines |
| `full` | plus `reasoning` and truncated `tool_result` |

Every activity line is prefixed with the agent's handle and drawn in that agent's colour,
dimmed. Because two streams interleave, `/focus <agent|all>` restricts activity lines to
one agent while messages from everyone keep showing. A split-pane layout is the natural
upgrade if interleaving proves hard to read; it is not part of v1.

---

## 13. Worktrees

### 13.1 Setup

On first run in a project:

1. Refuse if not inside a git repository.
2. Create `.chatroom/` and add `/.chatroom/` to `.git/info/exclude`.
3. `git worktree add -b chatroom/claude .chatroom/worktrees/claude HEAD`, likewise for
   `codex`. Each worktree is a full checkout of the current commit, so the project's own
   CLAUDE.md, AGENTS.md and settings apply inside it exactly as in the main tree.
4. Create the first conversation.

A branch per agent is created even though agents are not told to commit; it costs
nothing and makes any commit an agent chooses to make harmless.

A fresh worktree contains no build outputs or installed dependencies. For projects that
need them, `brief.extra` is the place to tell the agents how to set up.

### 13.2 `/merge <agent>`

Brings that agent's work into the user's main tree. Because agents are not required to
commit, this applies the worktree's difference from its base commit, including untracked
files, rather than merging a branch.

1. Refuse if that agent has a turn in flight.
2. Refuse if the worktree's base commit differs from the main tree's HEAD; ask for
   `/sync` first.
3. Produce a patch of everything in the worktree relative to its base commit, new files
   included, and apply it to the main tree with a three-way apply.
4. On conflict, apply nothing and report the files. On success, leave the changes
   unstaged in the main tree for the user to review and commit, and record a `merge` event.

### 13.3 `/sync [agent]`

Moves one or both worktrees onto the main tree's current HEAD, carrying their uncommitted
changes along. Refuses while that agent has a turn in flight. Reports conflicts and leaves
the worktree for the user to resolve if the carry-over fails. Records a `sync` event.

### 13.4 Teardown

`chatroom clean` removes both worktrees and their branches, keeping conversations
(sessions are marked lost). `chatroom reset` removes `.chatroom/` entirely and the
exclude line.

---

## 14. The REPL

Line-oriented, not a full-screen TUI. Three regions:

```
#42 codex → @claude                                          21:07  (post)
  @claude I'll take the parser; you take the CLI?
    · claude: Read src/cli.py
    · codex ~ "Need to check how the CLI parses args before…"
#43 claude → @codex                                          21:08  (post)
  @codex Agreed, CLI is mine.

claude: working (Edit src/cli.py) · codex: working (Bash pytest) · hops 2/6 · parser
> _
```

- Transcript region: messages as they are posted, events dimmed, activity lines per
  the display level.
- Status line: each agent's state (`idle`, `working (<current tool>)`, `waiting for
  approval`, `held (n unread)`), the hop counter, and the conversation name.
- Input line. A plain line is a message from the user. To send several lines, open and
  close the message with a line containing only `"""`.

Slash commands:

| Command | Effect |
|---|---|
| `/hops [N]` | Show or set the hop limit. Setting it re-runs the scheduling rule. Persisted. |
| `/status` | Sessions, cursors, in-flight turns, pending deliveries, worktree base commits, pending permissions. |
| `/stop <agent\|all>` | Kill the in-flight turn(s). |
| `/new [name]`, `/switch <name\|id>`, `/conversations`, `/rename <name>` | §7.1 |
| `/merge <agent>` | §13.2 |
| `/sync [agent]` | §13.3 |
| `/show [quiet\|activity\|full]`, `/focus <agent\|all>` | §12 |
| `/history [N]` | Reprint the last N messages. |
| `/quit` | Stop in-flight turns, release the lock, exit. Everything is already on disk. |

Sub-commands outside the REPL: `chatroom new|list|continue|delete`, `chatroom log`
(print a transcript), `chatroom clean`, `chatroom reset`, and the agent-side
`chatroom post|inbox|ask|hook`.

---

## 15. Failure modes

| Situation | Behaviour |
|---|---|
| Chatroom crashes mid-turn | On restart, `in_flight` entries roll the cursor back to `delta_from - 1` and `pending_delivery` ids are re-queued; the redelivered delta is prefixed with "the previous attempt was interrupted". |
| Two chatroom processes in one project | The second refuses to start while `.chatroom/lock` is held by a live process. |
| CLI exits nonzero | `turn_failed` event with the tail of stderr; cursor rolled back; agent returns to idle. |
| Session unknown on resume | §7.4. |
| Reply cannot be parsed | Treated as `turn_failed`; raw output stays in `log/`. |
| Turn exceeds timeout | §11.5. |
| Agent-to-agent ping-pong | Hop budget holds the next delivery; status line shows `held`. |
| Agent writes outside its worktree | Codex: blocked by sandbox. Claude: relayed prompt; the user denies. |
| Agent forgets the rules after compaction | The header on every delta restates them. |
| Outbox file malformed or oversized | Moved aside, `outbox_rejected` event, nothing posted. |
| Delivery written but never picked up | Rolled into the next delta at turn end; no second hop charged. |
| Hook not running (trust refused, wrong config) | Deliveries pile up unconsumed; `/status` shows it; messages still arrive at turn boundaries. |
| `/merge` conflicts | Nothing applied; files listed; user resolves or asks an agent to. |
| Transcript has a trailing partial line | Dropped on load; ids continue from the last complete record. |

---

## 16. Trust and safety notes

- Both agents run unattended in the user's repo. Claude's `auto` permission mode plus
  prompt relaying and Codex's `workspace-write` sandbox are the two guards.
  `bypassPermissions` and Codex's approvals-and-sandbox bypass are not exposed in config.
- `--dangerously-bypass-hook-trust` is passed to Codex only so that the chatroom's own
  hook command runs. No other hook is configured by the chatroom, and hooks the user has
  in `~/.codex/hooks.json` run exactly as they would in normal use.
- The `ipc/` directory is the only place outside its worktree that Codex can write. Its
  contents are treated as data: parsed strictly, size-capped, sender taken from the
  directory name.
- Secrets in the main tree are readable by both agents. Project hooks and settings apply
  inside the worktrees just as in the main tree. Do not run the chatroom in a repository
  whose hooks are not trusted.

---

## 17. Verification status

### Measured on this machine (2026-09-04)

- Codex `workspace-write`: writes inside cwd succeed; writes outside cwd fail; writes to
  a directory listed in `sandbox_workspace_write.writable_roots` succeed; `/tmp` and
  `$TMPDIR` are writable by default; reads outside cwd succeed; connecting to a Unix
  socket fails with "Operation not permitted". Environment variables reach commands run
  under `codex sandbox`.
- Flag inventory of both CLIs: `--settings`, `--permission-prompts`, `--permission-mode
  auto`, `--include-hook-events`, `--session-id`, `--resume` on Claude; `--json`, `-o`,
  `--sandbox`, `--dangerously-bypass-hook-trust` on `codex exec`; absence of `--cd` and
  `--sandbox` on `codex exec resume`; `hooks` feature stable in `codex features list`.

### Documented (official docs, or Codex source at tag rust-v0.146.0)

- Claude Code: hook JSON output with `hookSpecificOutput.additionalContext`; inline JSON
  for `--settings`; session storage path; `--continue` scoped to the working directory;
  `--resume <id>` searching all projects since 2.1.223.
- Codex: hook events including `PostToolUse`, `UserPromptSubmit` and `Stop`; injection of
  `additionalContext` with a 2500-token default cap; hook trust and the bypass flag;
  `--json` event types and the `thread_id` in `thread.started`; item types including
  `reasoning` and `agent_message`; config keys `sandbox_mode`,
  `sandbox_workspace_write.writable_roots`, `shell_environment_policy.set`; `inherit`
  defaulting to `all`; resume by UUID without cwd filtering; app-server `turn/steer` and
  `turn/interrupt`.

### To verify with the smoke test before building the scheduler

1. Claude `PostToolUse` hook supplied through `--settings` runs in `-p` mode and its
   `additionalContext` reaches the model. Whether hooks from `--settings` need any trust
   step.
2. Codex hooks supplied through `-c hooks.PostToolUse=[…]` load with
   `--dangerously-bypass-hook-trust`, and `additionalContext` reaches the model. If not,
   the global `hooks.json` fallback.
3. `shell_environment_policy.set` delivers the `CHATROOM_*` variables to Codex's tool
   shell; `writable_roots` works on a resumed turn via `-c`.
4. What Claude does with a second `user` message on stdin during a turn.
5. The exact wire shape of Claude's permission `control_request` and `control_response`,
   including deny-with-message.
6. Whether `thinking` blocks appear in Claude's `stream-json` output, and whether
   `--verbose` is required for it in `-p` mode on 2.1.260.
7. Whether Claude's `auto` mode reads files outside the worktree without prompting, and
   whether the interactive picker in the main tree lists worktree sessions.
8. What each CLI's session contains after its process is killed mid-generation, and
   whether resume then works.
9. That `--append-system-prompt` is applied on a `--resume` turn.
10. The default tool-command timeout of each harness, to keep `ask_timeout_seconds`
    below it.

### Open decisions

- **Implementation language.** Requirements: spawn two child processes concurrently,
  stream and parse their stdout, keep one stdin open for control responses, watch
  directories, run a readline-style REPL. Recommendation: TypeScript, because both
  vendors publish TypeScript SDKs whose wire protocols are the same stream-json / JSONL
  the CLIs emit. Note that the Codex SDK exposes neither hooks nor extra config
  overrides, so the Codex driver shells out to the CLI regardless.
- **Handle for the OpenAI agent.** `codex` is used throughout; `gpt` would also work.
- **Changed-files trailer** in the delta (§10.1), proposed.
- **Worktrees shared across conversations** (§7.2), proposed.
- **`chatroom ask`** (§9.4), proposed.

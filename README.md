# Chatroom

A terminal group chat for one user and two coding agents, Clara (Claude Code) and Phil
(Codex), working on one repository. Each agent gets its own git worktree and branch; the
user reads one transcript, talks to both or to one with `@clara` or `@phil`, and the agents
talk to each other through the same chat. The screen has the shape of Claude Code's:
the transcript flows from the top, an input box and status lines for both agents follow it.

The design leans on the brief the agents receive rather than on enforcement, keeps all
state in files you can open in an editor (one JSONL log per conversation), and leaves the
agents as free as they are when you use them alone. `ARCHITECTURE.md` is the full
description; `docs/STATUS.md` has the current state and the decision log.

## Requirements

- Node 22.18 or newer (the code runs through Node's type stripping, no build step)
- git
- Claude Code and Codex installed and signed in; `chatroom doctor` checks both

## Install

```sh
npm install && npm link          # once; `npm unlink -g chatroom` removes it
```

## Use

```sh
cd <your repository>
chatroom doctor                  # executables, logins, git, sandbox
chatroom                         # opens the conversation "default"
```

Inside: plain text goes to both agents, `@clara` or `@phil` to one, `/help` lists the
commands. Shift-Enter, Option-Enter, Ctrl-J or a trailing backslash add a line; ctrl-C
twice quits. `chatroom new <name>`, `chatroom continue <name>`, `chatroom list` and
`chatroom delete <name>` manage conversations. The log is
`.chatroom/conversations/<name>/log.jsonl`; `chatroom log` prints it. Worktrees live
under `~/.local/state/chatroom/<project>/worktrees/<name>/`.

`chatroom doctor --live` runs an end-to-end check with both agents; it spends both quotas
and takes a few minutes.

## Development

```sh
npm run typecheck
npm test
```

## License

MIT, see `LICENSE`.

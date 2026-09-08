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

- macOS or Linux; on Windows, WSL 2 (see below)
- Node 22.18 or newer (the code runs through Node's type stripping, no build step)
- git
- Claude Code and Codex installed and signed in; `chatroom doctor` checks both
- On Linux and WSL 2, Claude Code's sandbox needs `bubblewrap` and `socat`
  (`sudo apt-get install bubblewrap socat` on Debian and Ubuntu)

The chatroom has been run on macOS. Linux and WSL 2 go through the same code paths but
have not been tried yet. Native Windows is not supported: the chatroom finds executables
and interrupts agents the POSIX way, and Claude Code's own sandbox runs on macOS, Linux
and WSL 2 only.

### Windows through WSL 2

1. In PowerShell as administrator, run `wsl --install`, then open the WSL terminal.
   Everything below happens inside WSL, not in PowerShell or CMD.
2. Install Node 22.18 or newer and git, then Claude Code
   (`curl -fsSL https://claude.ai/install.sh | bash`) and Codex
   (`curl -fsSL https://chatgpt.com/codex/install.sh | sh`), and sign in to both.
3. Install the sandbox packages: `sudo apt-get install bubblewrap socat`.
4. Keep the repository under the Linux home directory, for example `~/code/my-app`,
   not under `/mnt/c`, as the Codex documentation recommends.
5. Install and run the chatroom as below, from the WSL terminal.

## Install

The chatroom is not published on npm. It runs straight from a clone of this repository,
and the `chatroom` command on PATH points into that folder, so keep the folder where it
is.

```sh
git clone https://github.com/jantomec/Chatroom.git
cd Chatroom
npm install        # fetches the one dependency
npm link           # puts the `chatroom` command on PATH, pointing at this folder
```

To update, run `chatroom update`; it pulls and installs in that folder. When a newer
version is on GitHub, the chatroom shows a line under its status bar. `npm unlink -g chatroom`
removes the command.

## Use

```sh
cd <your repository>
chatroom doctor                  # executables, logins, git, sandbox
chatroom                         # opens the conversation "default"
```

An empty repository works too: the chatroom makes an empty first commit on the main branch
as the base and says so.

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

# Phase 0 probes

Disposable TypeScript probes for the Phase 0 items of the tenth architecture revision,
`docs/history/ARCHITECTURE_V10.md`, run on 2026-09-07; their results are the measured
bullets of `ARCHITECTURE.md` §16. Section numbers in the probe comments refer to that
tenth revision. Each writes `probes/out/<name>/events.log`, `summary.json` and the raw vendor
streams; `sanitize-fixtures.ts` copies scrubbed recordings into `fixtures/`. Run with
`node probes/<file>` on Node 22.18 or later. Live probes spend the user's Claude and
Codex quotas and build throwaway repositories under `~/.local/state/chatroom-probes/`.

| Probe | Item | What it measured |
|---|---|---|
| `01-sqlite.ts` | 1 | `node:sqlite` under SIGKILL, WAL, FULL sync, busy_timeout, FK, UNIQUE, read-only connections; run under each Node line |
| `02-claude-session.ts` | 2, 8 | three turns in one `-p` process, hook delivery, `--resume`, `--effort`, init and usage fields, `modelUsage` |
| `02b`, `02c`, `02d-claude-control.ts` | 2 | the permission prompt route: `permission_denied` without a prompt tool, `initialize` control request, `--permission-prompt-tool stdio` and an MCP prompt tool |
| `02e-claude-hook-failure.ts` | 2 | `PostToolUseFailure`: fires on a failing call, input fields, `hookEventName` validation, `additionalContext` |
| `03-claude-boundary.ts` | 3 | the §15.1 settings as first written: every shell and native write outside the worktree blocked, and so were the drop root and the native commit |
| `03b-claude-boundary-narrow.ts` | 3 | the same with deny rules naming only the protected subtrees, plus the Bash timeout |
| `03c-claude-git-allowance.ts` | 3 | why `git commit` fails in the linked worktree: sandbox alone, explicit `allowWrite` of the git directory with `denyWrite`, `denyWrite` alone |
| `03d`, `03e` | 3 | whether a narrower `allowWrite` or a `[!.]*` glob lets a main-tree deny rule coexist with native commits (neither does) |
| `03f-claude-boundary-final.ts` | 3 | the final §15.1 rule set: no main-tree rule, deny rules for the peer, integration and IPC directories, both hook events |
| `04-appserver.ts` | 4, 8 | app-server handshake, profile through the `config` map, Auto-review, native commit, steer, resume in a new process, legacy fallback |
| `05-codex-exec.ts` | 5 | `codex exec` with `-c` overrides, resume, commit, blocked write, JSONL events, environment policy |
| `06-kill-resume.ts` | 6 | SIGKILL mid-command and resume on both harnesses; the Codex exec tool with a 25 s command |
| `07-recovery.ts` | 7 | the §16.7 classification against a crash after every step of snapshot, integrate, apply and abort, model-free |

`lib/` holds the shared pieces: `lab.ts` builds the §4.2 layout in a scratch repository,
`claude.ts` and `appserver.ts` are minimal clients for the two wire protocols, `hook.ts`
and `chatroom-stub.sh` stand in for `chatroom hook`, `permission-mcp.ts` is the MCP
permission tool used by `02d`, and `util.ts` has the recorder and the pinned-git helpers.
Nothing under `probes/` is imported by `src/`.

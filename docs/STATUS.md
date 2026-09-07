# Status

Updated 2026-09-07.

## Current state

- `ARCHITECTURE.md` was accepted as the implementation baseline on 2026-09-07 by the user
  and by the Codex reviewer, whose last review found "no remaining coordination or
  data-loss flaw" and recommended starting Phase 0 rather than another revision.
- Phase 0 (§22 item 0) ran on 2026-09-07 in one session. Every item of §19 "Phase 0" has a
  probe under `probes/`, a raw recording under `probes/out/` (ignored by git) and a
  sanitized one under `probes/fixtures/`; the measurements are the "Phase 0" bullet of
  §19. The one open sub-item is the interactive comparison of item 8, which needs the
  user to resume a probe session in each harness's own interface and compare the context
  figure with the one Chatroom would compute.
- The TypeScript project is scaffolded (`package.json`, `tsconfig.json`, strict, Node type
  stripping, no build step, dev dependencies `typescript` and `@types/node`). `src/` does
  not exist yet; nothing in `probes/` is meant to be imported by it, though the recovery
  probe's step classifier and the two protocol clients are the obvious seeds for
  `workspace/recovery.ts`, `drivers/claude-cli.ts` and `drivers/codex-app-server.ts`.
- The status bar addition of §17.1 (2026-09-07, after acceptance) is unchanged and the
  Codex reviewer has not seen it, nor the Phase 0 edits below.

## What Phase 0 changed in the design

Each of these is written into `ARCHITECTURE.md` with its measurement in §19. None reverses
a guard; two touch the mechanism a guard relies on and are flagged for the user.

1. **Host permission prompts on Claude need `--permission-prompt-tool stdio`.** With
   `--permission-prompts host` alone a prompt is denied at once with a `permission_denied`
   event and nothing reaches stdout; with the flag the `control_request` /
   `control_response` exchange of §10 works and its wire shape is recorded. An MCP
   permission tool also works and is the fallback. (§10)
2. **Claude `Edit`/`Write` deny rules feed the Bash sandbox by prefix.** A deny over the
   whole IPC root blocked the agent's own drop-root write, so the IPC rules now name only
   the peer's directory and the own `to-agent/` and `staging/`. (§15.1)
3. **`denyWrite` holds inside the linked-worktree git allowance**, so git metadata on
   Claude is scoped as on Codex. The main-tree deny rule `Edit(//<main>/**)` covered
   `<main>/.git` and closed that allowance, which would have cost Claude its native
   commits; the user dropped the rule on 2026-09-07 and stated the principle as guard
   G25, prompt before mechanism. Native edits into the main tree are now carried by the
   brief and the auto-mode classifier, as in solo use. (§0.1, §15.1, §15.4)
4. **`PostToolUse` fires only after a tool call succeeds** (docs and measurement), so a
   run of failing commands would delay mid-turn delivery; the hook is registered for
   `PostToolUseFailure` as well. (§10, G5's mechanism, not its decision)
5. **Codex `shell_environment_policy` filters have no effect** on 0.153.3 under the exec
   tool (`inherit = "none"`, `ignore_default_excludes = false` and `filters` all left `HOME`,
   `PATH` and a `*TOKEN*` variable visible; `set` works). The orchestrator's own scrub is
   the only mechanism, as §8.1 already made it. (§8.1)
6. **The app-server `config` map is nested objects**, the profile's effect is read from the
   response's legacy `sandbox.writableRoots`, and a missing profile fails `thread/start`
   with a clear error, which is where the legacy fallback is decided. (§11)
7. **Claude's `modelUsage` is keyed by model and includes side calls**; the driver reads
   the init model's entry. Thinking is not streamed as content blocks at `xhigh`; a
   `system/thinking_tokens` counter is. (§10, §17.1)
8. **git 2.54.0 prints a harmless `packed-refs.lock` error on every commit** from a
   linked worktree whose profile denies `packed-refs`; 2.50.1 does not. The brief names
   it. Agents use the login shell's git, not the orchestrator's. (§15.2)
9. **Node range:** 22.18 or later, type stripping, no parameter properties or enums;
   `node:sqlite` passed on 22.23.2, 24.20.0 and 25.1.0; 24 is the first line without the
   experimental warning. (§21)
10. **The Bash tool timeout is 120 s** and a timed-out command is moved to the background;
    a bare `sleep 130` is refused before running. `ask.timeout_seconds = 60` stays below
    it. Codex's exec tool completed a 25 s command with no timeout. (§8.3 assumption
    confirmed)

## Open for the user

- **Auto-review approved an escalation into the main tree.** Under the §15.2 profile the
  model asked to rerun `printf x > <main>/escape.txt` outside the sandbox after the sandbox
  blocked it; Auto-review approved with rationale "The user explicitly authorized one exact
  rerun outside the sandbox", and no `requestApproval` reached the client. The rerun still
  failed under the profile and no file was written. Under legacy `workspace-write` an
  escalated `git commit` was approved the same way and ran unsandboxed. The decision log's
  reopen condition for `auto_review` ("Auto-review approving writes into the peer worktree
  or main") is met for the approval and not for the write. Auto-review reads the turn
  input, which in the chatroom carries the peer's messages as well as the user's. The
  probe's prompt did authorize the rerun, so this is the authorized case, not an
  unprompted one; the unprompted case was not measured. G4 stands unless the user says
  otherwise.
- The interactive part of item 8 (compare context percentages in each harness's own UI).
- Whether to keep the probe labs under `~/.local/state/chatroom-probes/` (about a dozen
  small repositories) or delete them.

## Resume point

Phase 1 of `ARCHITECTURE.md` §22: the durable room core on the layout of §21, with
`node:sqlite`, fake drivers and crash injection. Before writing scheduler code, read the
"What Phase 0 changed" list above and the Phase 0 bullet of §19; the three probe clients
under `probes/lib/` show the exact wire shapes for both harnesses.

## How the design was produced

Ten revisions between 2026-09-04 and 2026-09-07, alternating drafts by Claude Code with
reviews by Codex. v1 to v3 built the product; v4 to v8 hardened it one mechanism per
review round until the user judged it disproportionate; v9 reset the posture to parity;
v10 added the collaboration protocol and the agents' names and was accepted after three
specification patches. The lesson from the loop is written into the design itself, in
§14.3 of `ARCHITECTURE.md`: two models asked to review each other do not converge
without an external criterion, an evidence rule for both verdicts, and a round cap.

## Decision log

Each rejected alternative carries the condition under which it should be reconsidered.

| Decision | Why | Rejected | Reopen if |
|---|---|---|---|
| Claude through the Claude Code CLI on the user's subscription | The Agent SDK docs say Anthropic does not allow claude.ai login for SDK agents | Agent SDK as driver | Anthropic permits subscription authentication for the SDK |
| Parity posture: agents have the exposure of solo use plus coordination rules only | The hardened designs defended against what the user already permits daily, and each review round added a mechanism | Read allowlists, modes, guarantee levels, hosted-tool disabling, escalation proofs | The chatroom is used in untrusted repositories, by more than one user, or unattended without anyone reading its summaries |
| Native commits on the own branch; git metadata scoped where the harness allows, else norm plus detection | A commit broker and a read-only git directory were disproportionate under parity; measured: Claude scopes the allowance with `denyWrite`, Codex with the profile | Commit broker, read-only `.git`, detached checkout | Never for the mechanism; see the next row for Claude's commits |
| No `Edit`/`Write` deny rule on the main tree for Claude; the brief carries "never write there" (G25) | Measured: any such rule closes the git allowance and costs native commits, and no rule shape excludes `.git`; user decision 2026-09-07, prompt before mechanism | Keeping the rule and running Claude without native commits; a `PreToolUse` hook refusing main-tree paths | Claude Code gains an allow-over-deny for paths, in which case the rule returns at no cost |
| Linked worktrees, one per agent per conversation | Shared object store makes snapshots, integration and peer inspection free; user decision | Per-agent clones, alternates sidecar | The user changes their mind; there is no technical trigger |
| Worktrees outside the main tree | Claude permission rules are deny-wins; a main-tree Edit deny would cover a nested worktree | Worktrees under `.chatroom/` | Claude permission rules gain allow-over-deny for paths |
| `/apply` and `/sync` as native `git merge` with pinned flags, own collision preflight, abort refusing on a changed index | Measured git behaviour covers the dirty-tree, collision, iteration and abort cases; the §16.7 classification survived 30 injected crashes | Synthetic commit of the dirty tree, applied-oid patch base, per-path journal, backup ref, two-state abort | A measured data-loss case that the index check cannot catch |
| `PostToolUse` plus `PostToolUseFailure` hooks for mid-turn delivery to Claude | Docs: streaming input queues messages; measured: the hook's `additionalContext` reaches the model, and `PostToolUse` alone skips failing calls | Streaming input as injection | A Claude Code version injects mid-turn through stdin |
| Host prompts through `--permission-prompt-tool stdio` control requests | Measured: without the flag prompts are auto-denied; with it the exchange works | MCP permission tool (measured to work; kept as fallback) | A Claude Code version drops the `stdio` value |
| Files for agent-to-orchestrator IPC | Codex's sandbox denies Unix sockets, measured | Sockets, local TCP | Both sandboxes allow a socket and the profile can express it |
| Codex through app-server, `exec` as fallback | Steering and approvals exist only on app-server; both paths measured | `exec` only | Never; the fallback is kept |
| `node:sqlite` as authority with a JSONL mirror | Transactions and idempotent acceptance; no native binding to ship; the durability suite passed on 22, 24 and 25 | JSONL as authority; a native SQLite binding | `node:sqlite` fails the durability suite on a Node line the project supports |
| Environment scrub in the orchestrator only | Measured: Codex's `shell_environment_policy` filters do not remove variables under the exec tool | Relying on the policy's filters | A Codex version applies the policy to the exec tool, in which case it becomes a second layer, not a replacement |
| Auto-review with `on-request` on app-server | User decision; closest equivalent to Claude's auto mode | `approval_policy = never` | Phase 0 measured Auto-review approving an authorized escalation into main while the profile still blocked the write; the user decides whether that meets the condition |
| No personalities or lenses for the agents | User decision: let them be themselves | A standing lens per agent, rotating ownership | Real sessions show the two agreeing too readily; a lens is three lines of brief |
| Names Clara and Phil; handles in config, harness ids in paths and refs | User decision; a rename must not need a migration | Handles in paths | Never |
| Collaboration protocol: numbered criteria, evidence for both verdicts, round cap of two, escalation by rule | Reviewers invent findings and accepters rubber-stamp unless both verdicts cost evidence | Acceptance as the "expected" answer | Sessions show verification notes being written without verification; then match notes against the activity stream |
| Status bar cells come only from harness reports; configuration shows as `default` | A configured level is not the level in force: Claude falls back to a supported effort, Codex can reroute a model; the hook input and the event stream carry the values, measured | Showing configured values as reports; Claude's `statusLine` command as the source; parsing the user's settings files | The docs state that the status line command runs under `-p`, or a Claude Code version drops `effort` from the hook input |
| Context percentage is input-only, over the harness-reported window | Matches Claude Code's documented `used_percentage`; Codex reports `modelContextWindow` on the same notification as the usage; both measured | Counting output tokens; a hard-coded window per model | The interactive comparison of item 8 shows a harness's own display disagreeing with Chatroom's figure |

## Measured facts

All measurements live in `ARCHITECTURE.md` §19 with tool versions; the Phase 0 bullet
there is the index into `probes/fixtures/summaries/`. Facts about the development
machine rather than the project (tool paths and versions, the two git binaries and their
PATH order, Node versions under nvm, quota notes) are in auto-memory.

## Running the probes

```sh
npm install                      # typescript, @types/node
npm run typecheck
node probes/01-sqlite.ts         # model-free, ~2 s; also run under each Node line
node probes/07-recovery.ts       # model-free, ~3 s
node probes/02-claude-session.ts # live: spends Claude quota, builds ~/.local/state/chatroom-probes/lab02
node probes/04-appserver.ts      # live: spends Codex quota
node probes/sanitize-fixtures.ts # refresh probes/fixtures/ from probes/out/
```

Live probes run one at a time per harness and spend both quotas; keep them to a few
turns.

## Review brief for the other model

Paste this with the document when asking Codex, or any other model, for a review.

```text
Review brief for the Chatroom architecture

Posture: parity. Inside the chatroom, each agent has exactly the capabilities and exposure
it has when the user runs that harness directly in the same repository: Claude Code in
auto mode, Codex with Auto-review, the user's own settings, hooks, MCP servers, web tools
and network. The chatroom adds only what two agents and an orchestrator need to share one
repository without corrupting each other's work or the user's tree. See §0 and guard G1.

Review for:
- coordination failures: any way two agents plus the orchestrator can corrupt each other's
  work or the user's tree that the stated rules do not cover;
- data loss in an orchestrator-run git operation, including recovery after a crash;
- factual errors against the vendor documentation or the measurements in §19;
- internal inconsistencies, dangling references, or a guard that contradicts the text.

Do not raise, unless it produces one of the above: secret reads, network egress, hosted
tools, subagents, escalation through Auto-review, or ref movement by an agent. These are
parity with solo use by decision. If you believe a finding in that category is a
coordination failure or a data-loss case, say so explicitly and show the path.

A blocker needs a demonstrated failing case. State what you verified and how.
```

## Document checks

Run after any edit to `ARCHITECTURE.md`. All four should print nothing surprising:
zero em-dashes, every `§` reference matching a heading, every guard in the index having a
block or being cited in one, and no stale term.

```sh
F=ARCHITECTURE.md
echo "em-dashes: $(grep -c '—' $F)"
echo "guard index: $(grep -cE '^\| G[0-9]+ \|' $F)  guard blocks: $(grep -c '^> \*\*Guard' $F)"
echo "guards cited in blocks:"; grep -oE '^> \*\*Guard [^.]*' $F | grep -oE 'G[0-9]+' | sort -u | tr '\n' ' '; echo
echo "section refs:"; grep -oE '§[0-9]+(\.[0-9]+)?' $F | sort -u | tr '\n' ' '; echo
echo "headings:"; grep -E '^###? [0-9]' $F | grep -oE '^#+ [0-9]+(\.[0-9]+)?' | sed 's/^#* //' | tr '\n' ' '; echo
echo "version references (should be none):"; grep -n -iE '\bv[0-9]+\b|earlier version|history/|review of v' $F | head
echo "stale phrases (should be none):"; grep -n -iE 'no code exists|not been exercised|to be measured' $F | head
```

Cost on 2026-09-07: about one second per run; the last run, after the Phase 0 edits,
found zero em-dashes, 25 guards indexed, 19 guard blocks citing 24 of them, and every
section reference resolving. G15 has no guard block and is cited only in §2; that was
already so in the accepted baseline and has not been changed.

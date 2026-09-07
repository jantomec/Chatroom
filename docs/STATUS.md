# Status

Updated 2026-09-07.

## Current state

- `ARCHITECTURE.md` is the eleventh revision and the implementation baseline. It was
  rewritten on 2026-09-07 after Phase 0, at the user's request, under two principles the
  user stated in their own words: prompt before mechanism (guard G2) and state the user
  can open in an editor (guard G11, the JSONL log). The tenth revision, which the Codex
  reviewer accepted and which Phase 0 measured against, is `docs/history/ARCHITECTURE_V10.md`.
- Every vendor claim in the document is quoted from official documentation or measured
  (§16). Phase 0 ran on 2026-09-07; its probes are under `probes/`, sanitized recordings
  under `probes/fixtures/`. The one open sub-item is the interactive comparison of the
  status bar's context figure with each harness's own display, which needs the user at a
  terminal.
- The TypeScript project is scaffolded (`package.json`, `tsconfig.json`, strict, Node type
  stripping, no build step). `src/` does not exist yet. The Codex reviewer has not seen
  the eleventh revision.

## What the rewrite removed, and why

Each item was a mechanism in the tenth revision. The user's answers across the project
(2026-09-04 to 2026-09-07) asked for simplicity every time a choice arose: everyone sees
everything, no turns, no commit norms, "the agent should already know on its own which
files are not supposed to be read", parity with solo use, names but no personalities,
healthy pushback without endless review, a status bar, nothing generated unasked.

| Removed | Replaced by | Reopen if |
|---|---|---|
| SQLite authority with a JSONL mirror, migrations, mirror verification | One JSONL log per conversation, one append per fact, the room state as a fold over it (§5) | The fold becomes too slow for a conversation, which at chat sizes it will not |
| Intent rows, step tables and a seven-row recovery classification for git | One `git` line at the start and end of each operation; snapshot, integrate and sync rerun from scratch because they are idempotent; an open apply is the user's (§13.5) | A measured case where rerunning from scratch loses data; the classification probe (`probes/07`) is kept as the test for the idempotent reruns |
| Six session states, suspect and lost | Resume by id with a recovery note; rebuild if resume fails (§10) | Never; the two cases are the only two that happen |
| Quarantine staging, no-follow checks, a security suite for IPC files | Import by op id; a file that does not parse is renamed `.rejected` (§8.2) | The chatroom is used with agents the user does not trust |
| The textual evidence gate on `[accept]` and the re-trigger with missing criterion numbers | The brief's rule that an accept lists evidence per criterion; the user reads the summary (§11.3, G14) | Sessions show accepts without evidence going unnoticed; then the gate is a regex |
| Secret-path deny lists (`~/.ssh`, `~/.aws`, keychains, …) | Only the two harness homes stay denied, the one read the chatroom creates that solo use does not (§12.1) | A repository where the agents should not see something the user's own Claude can see |
| The `Edit`/`Write` deny on the main tree for Claude | The brief's "never write there" (§12.1, G2); measured to be the rule that closed the git allowance | Claude Code gains allow-over-deny for paths |
| 30 configuration keys | 11 (§14) | A user needs one of the removed ones |
| Inline guard blocks throughout the text | The guard index alone (§0.2), 15 guards | Never |
| Autonomy holds per task state, turn timeouts, stop grace keys, raw-event retention | The budget and one hold rule (§7); constants; `chatroom --raw` | Never |

Kept because it is a measured data-loss protection and invisible in use: the pinned
merge flags, explicit paths, the collision preflight, and the abort index check (G12,
G13). Kept because the user asked for it: the status bar, the collaboration protocol's
norms and its four orchestrator behaviours, the names.

## Findings left to the user

- Auto-review approved an escalation into the main tree because the turn input had
  authorized one rerun; under the profile the rerun still failed, under legacy
  `workspace-write` an approved escalated commit ran unsandboxed. The unauthorized case
  was not measured. G4 stands unless the user says otherwise.
- Whether the two harness homes stay denied for reading or become a sentence in the
  brief (§20 item 4).
- Whether to delete the probe labs under `~/.local/state/chatroom-probes/`.

## Resume point

Phase 1 of `ARCHITECTURE.md` §19: the room core on the layout of §18, model-free, with
fake drivers and crash injection at every append. Before writing it, read §5 (the log)
and §11.3 (the protocol's four behaviours); the probe clients under `probes/lib/` show
the wire shapes for both harnesses when Phase 2 comes.

## How the design was produced

Eleven revisions between 2026-09-04 and 2026-09-07, alternating drafts by Claude Code
with reviews by Codex. v1 to v3 built the product; v4 to v8 hardened it one mechanism per
review round until the user judged it disproportionate; v9 reset the posture to parity;
v10 added the collaboration protocol and the names and was accepted; Phase 0 measured
it; v11 removed the machinery the measurements and the user's stated preferences showed
to be unnecessary. The lesson from the review loop is written into §11.3: two models
asked to review each other do not converge without an external criterion, an evidence
rule for both verdicts, and a round cap.

## Decision log

Each rejected alternative carries the condition under which it should be reconsidered.

| Decision | Why | Rejected | Reopen if |
|---|---|---|---|
| Claude through the Claude Code CLI on the user's subscription | The Agent SDK docs say Anthropic does not allow claude.ai login for SDK agents | Agent SDK as driver | Anthropic permits subscription authentication for the SDK |
| Parity posture | The hardened designs defended against what the user already permits daily | Read allowlists, modes, guarantee levels, hosted-tool disabling, escalation proofs | The chatroom is used in untrusted repositories or by more than one user |
| Prompt before mechanism (G2) | Frontier models follow the brief; enforced complexity hides what is happening | Rules where a sentence does | The user starts running models that do not follow the brief |
| JSONL log as the one authority (G11) | The user can open and search it; a fold over it is the whole state | SQLite (measured to work), a JSONL mirror of a database | Never for inspectability; a fold too slow at chat sizes would be a bug |
| Native commits on the own branch; git metadata scoped where the harness allows | Measured: Claude scopes the allowance with `denyWrite`, Codex with the profile | Commit broker, read-only `.git`, detached checkout, per-agent clones | Never |
| No main-tree `Edit`/`Write` rule on Claude | Measured: any such rule closes the git allowance; the brief carries it | Keeping the rule without native commits; a `PreToolUse` hook | Claude Code gains allow-over-deny for paths |
| Linked worktrees outside the main tree | Shared object store; the rules of §12 name directories | Per-agent clones; worktrees under `.chatroom/` | The user prefers everything under `.chatroom/` and accepts the IDE seeing three copies |
| `/apply` and `/sync` as native `git merge` with pinned flags, preflight, abort index check | Measured data-loss cases (§16) | Synthetic commits, per-path journals, backup refs | A measured data-loss case the index check cannot catch |
| Recovery by rerunning idempotent operations; an open apply is the user's | The seven-row classification recovered every case, and rerun-from-scratch reaches the same states with no table | Step tables and intent rows | A measured case where a rerun loses data |
| `PostToolUse` plus `PostToolUseFailure` hooks for mid-turn delivery | Measured: `additionalContext` reaches the model; `PostToolUse` alone skips failing calls | Streaming input as injection | A Claude Code version injects mid-turn through stdin |
| Host prompts through `--permission-prompt-tool stdio` | Measured: without it prompts are auto-denied | MCP permission tool (measured to work; the fallback) | A Claude Code version drops the `stdio` value |
| Files for IPC | Measured: Codex's sandbox denies Unix sockets | Sockets, local TCP | Both sandboxes allow a socket |
| Codex through app-server, `exec` as fallback | Steering and approvals exist only on app-server; both measured | `exec` only | Never |
| Environment scrub in the orchestrator only | Measured: Codex's `shell_environment_policy` filters remove nothing | Relying on the policy | A Codex version applies the policy to the exec tool |
| Auto-review with `on-request` on app-server | User decision; the closest equivalent to Claude's auto mode | `approval_policy = never` | The user reads the finding above and decides otherwise |
| No personalities; names Clara and Phil; handles in config | User decision | Lenses; handles in paths | Never |
| Collaboration protocol: numbered criteria, evidence for both verdicts, a blocker cap, escalation by rule, four orchestrator behaviours | Reviewers invent findings and accepters rubber-stamp unless both verdicts cost evidence | Acceptance as the expected answer; grading prose | Sessions show the norms not holding; then add the smallest check that would have caught it |
| Status bar from harness reports only | A configured value is not the value in force; measured sources | Showing configuration as a report | A harness stops reporting |

## Running the probes

```sh
npm install && npm run typecheck
node probes/01-sqlite.ts         # model-free, ~2 s
node probes/07-recovery.ts       # model-free, ~3 s
node probes/02-claude-session.ts # live: spends Claude quota
node probes/04-appserver.ts      # live: spends Codex quota
node probes/sanitize-fixtures.ts # refresh probes/fixtures/
```

Live probes run one at a time per harness and spend both quotas; keep them to a few
turns. Facts about the development machine are in auto-memory.

## Review brief for the other model

Paste this with the document when asking Codex, or any other model, for a review.

```text
Review brief for the Chatroom architecture

Posture: parity, and prompt before mechanism. Inside the chatroom, each agent has exactly
the capabilities and exposure it has when the user runs that harness directly in the same
repository: Claude Code in auto mode, Codex with Auto-review, the user's own settings,
hooks, MCP servers, web tools and network. Where a rule can be a sentence in the agent's
brief, it is; mechanisms exist only for measured data-loss cases. See §0 and guards G1
and G2.

Review for:
- coordination failures: any way two agents plus the orchestrator can corrupt each other's
  work or the user's tree that the stated rules do not cover;
- data loss in an orchestrator-run git operation, including recovery after a crash;
- factual errors against the vendor documentation or the measurements in §16;
- internal inconsistencies, dangling references, or a guard that contradicts the text.

Do not raise, unless it produces one of the above: secret reads, network egress, hosted
tools, subagents, escalation through Auto-review, ref movement by an agent, or a rule
that is stated in the brief instead of enforced. These are decisions. If you believe a
finding in that category is a coordination failure or a data-loss case, say so
explicitly and show the path.

A blocker needs a demonstrated failing case. State what you verified and how.
```

## Document checks

Run after any edit to `ARCHITECTURE.md`. All should print nothing surprising: zero
em-dashes, every `§` reference matching a heading, every guard cited in the text present
in the index, no version references, no stale term.

```sh
F=ARCHITECTURE.md
echo "em-dashes: $(grep -c '—' $F)"
echo "guard index: $(grep -cE '^\| G[0-9]+ \|' $F)"
echo "guards cited but not indexed:"; comm -23 <(grep -oE '\bG[0-9]+\b' $F | sort -u) <(grep -oE '^\| G[0-9]+ \|' $F | grep -oE 'G[0-9]+' | sort -u) | tr '\n' ' '; echo
echo "dangling section refs:"; comm -23 <(grep -oE '§[0-9]+(\.[0-9]+)?' $F | tr -d '§' | sort -u) <(grep -E '^###? [0-9]' $F | grep -oE '^#+ [0-9]+(\.[0-9]+)?' | sed 's/^#* //' | sort -u) | tr '\n' ' '; echo
echo "version references (should be none):"; grep -n -iE '\bv[0-9]+\b|earlier version|history/|review of v' $F | head
echo "stale terms (should be none):"; grep -n -iE 'sqlite as|mirror|intent row|git_steps|suspect' $F | head
```

Cost on 2026-09-07: about one second per run.

# Status

Updated 2026-09-07.

## Current state

- `ARCHITECTURE.md` was accepted as the implementation baseline on 2026-09-07 by the user
  and by the Codex reviewer, whose last review found "no remaining coordination or
  data-loss flaw" and recommended starting Phase 0 rather than another revision.
- No code exists. No TypeScript project has been scaffolded.
- Evidence behind the acceptance: every vendor claim in the document is either quoted
  from official documentation or measured on the development machine (§19 of
  `ARCHITECTURE.md`), and the last two review rounds produced only specification patches,
  no design changes.

## Resume point

Start Phase 0 (`ARCHITECTURE.md` §22): disposable probes for the seven items in §19,
later folded into `chatroom doctor`. Run these two first, because their outcome decides
the most:

1. **Claude git scoping.** With the inline `--settings` of §15.1, does `denyWrite` on the
   peer's admin directory and on `refs/heads/main` take effect inside the automatic
   linked-worktree allowance? Both outcomes are designed for (§15.4); the answer sets what
   `/status` reports.
2. **Codex app-server profile.** Are the §15.2 overrides accepted through the `config`
   map on `thread/start`, is the effective policy readable and does it report the profile
   with the user's real `config.toml` present, and does `git commit` in the worktree work
   without an elevation? The `codex sandbox` measurements in §19 suggest yes; app-server
   has not been exercised.

Then the rest of §19 in order. No live model call has been made in the design phase; the
first Phase 0 probe will be the first.

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
| Native commits on the own branch; git metadata scoped where the harness allows, else norm plus detection | A commit broker and a read-only git directory were disproportionate under parity | Commit broker, read-only `.git`, detached checkout | Claude cannot scope the worktree allowance **and** metadata protection becomes a requirement |
| Linked worktrees, one per agent per conversation | Shared object store makes snapshots, integration and peer inspection free; user decision | Per-agent clones, alternates sidecar | The user changes their mind; there is no technical trigger |
| Worktrees outside the main tree | Claude permission rules are deny-wins; a main-tree Edit deny would cover a nested worktree | Worktrees under `.chatroom/` | Claude permission rules gain allow-over-deny for paths |
| `/apply` and `/sync` as native `git merge` with pinned flags, own collision preflight, abort refusing on a changed index | Measured git behaviour covers the dirty-tree, collision, iteration and abort cases | Synthetic commit of the dirty tree, applied-oid patch base, per-path journal, backup ref, two-state abort | A measured data-loss case that the index check cannot catch |
| `PostToolUse` hook for mid-turn delivery to Claude | Docs: streaming input queues messages | Streaming input as injection | A Claude Code version injects mid-turn through stdin |
| Files for agent-to-orchestrator IPC | Codex's sandbox denies Unix sockets, measured | Sockets, local TCP | Both sandboxes allow a socket and the profile can express it |
| Codex through app-server, `exec` as fallback | Steering and approvals exist only on app-server | `exec` only | Never; the fallback is kept |
| `node:sqlite` as authority with a JSONL mirror | Transactions and idempotent acceptance; no native binding to ship | JSONL as authority; a native SQLite binding | `node:sqlite` fails the durability suite on the oldest supported LTS, in which case use a binding, not JSONL |
| Auto-review with `on-request` on app-server | User decision; closest equivalent to Claude's auto mode | `approval_policy = never` | Phase 0 shows Auto-review approving writes into the peer worktree or main, in which case the user chooses between `never` and accepting it |
| No personalities or lenses for the agents | User decision: let them be themselves | A standing lens per agent, rotating ownership | Real sessions show the two agreeing too readily; a lens is three lines of brief |
| Names Clara and Phil; handles in config, harness ids in paths and refs | User decision; a rename must not need a migration | Handles in paths | Never |
| Collaboration protocol: numbered criteria, evidence for both verdicts, round cap of two, escalation by rule | Reviewers invent findings and accepters rubber-stamp unless both verdicts cost evidence | Acceptance as the "expected" answer | Sessions show verification notes being written without verification; then match notes against the activity stream |

## Measured facts

All measurements live in `ARCHITECTURE.md` §19 with tool versions. Two facts about the
development machine rather than the project are in auto-memory: the two git binaries on
`PATH` and the installed tool versions and paths.

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
```

Cost on 2026-09-07: about one second per run; the last run found zero em-dashes,
24 guards indexed, 18 guard blocks citing all 24, and every section reference resolving.

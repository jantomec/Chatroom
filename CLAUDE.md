# Chatroom

A terminal group chat for one user and two coding agents, Clara (Claude Code) and Phil
(Codex), sharing one repository through per-agent worktrees. The project is in its design
phase: the architecture is accepted, no code exists yet.

## Where things are

- `ARCHITECTURE.md` is the implementation baseline. Read §0 first: it states the posture
  (parity with solo use) and indexes the guards, the decisions that need the user's
  approval to reverse.
- `docs/STATUS.md` holds the current state, the exact resume point, the decision log with
  rejected alternatives and their reopen conditions, the review brief for the other model,
  and the document checks.
- `docs/history/` holds the nine superseded drafts. They are a record, not a source: new
  revisions never cite them, and `ARCHITECTURE.md` stands on its own.

## Rules for working in this repo

- **Parity is the posture.** A change that makes the chatroom stricter than the user's
  daily solo use must be argued as a coordination failure or data loss inside the parity
  model. Guard G1 in `ARCHITECTURE.md`.
- **Guards are not reversed silently.** To argue against one, quote it and say why; the
  user decides.
- **Measure before claiming.** Every statement about a CLI flag, a config key, a protocol
  method or a git behaviour is verified against the installed tool's help, the app-server
  schema (`codex app-server generate-json-schema --out <dir>`), the official docs, or a
  scratch-repository experiment, and recorded in `ARCHITECTURE.md` §19 with the tool
  version. Nothing about vendor behaviour is stated from memory.
- **Reviews have a bar.** A finding counts if it is a coordination failure, data loss in an
  orchestrator operation, a factual error against docs or measurements, or an internal
  inconsistency. Hardening beyond parity does not count. The brief in `docs/STATUS.md`
  says this to the reviewing model; use it.
- **The architecture stays standalone.** No "changes from vN" sections, no references to
  earlier versions, no review history in guard evidence.

## Verification

There is no code gate yet. The document gate is the set of shell checks in
`docs/STATUS.md` under "Document checks": dangling section references, guard index versus
guard blocks, leftover em-dashes, stale terms. Run them after any edit to
`ARCHITECTURE.md`.

## Next

Phase 0 of `ARCHITECTURE.md` §22: disposable probes for the items in §19, in TypeScript,
before any scheduler code. `docs/STATUS.md` names the two probes to run first.

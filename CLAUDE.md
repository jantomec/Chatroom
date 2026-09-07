# Chatroom

A terminal group chat for one user and two coding agents, Clara (Claude Code) and Phil
(Codex), sharing one repository through per-agent worktrees. The architecture is the
eleventh revision and the code under `src/` implements it; `bin/chatroom.js` is the
command.

## Where things are

- `ARCHITECTURE.md` is the implementation baseline. Read §0 first: it states the posture
  (parity with solo use, and prompt before mechanism) and indexes the guards, the
  decisions that need the user's approval to reverse.
- `docs/STATUS.md` holds the current state, the exact resume point, the decision log with
  rejected alternatives and their reopen conditions, the review brief for the other model,
  and the document checks.
- `docs/history/` holds the ten superseded drafts. They are a record, not a source: new
  revisions never cite them, and `ARCHITECTURE.md` stands on its own.
- `probes/` holds the disposable Phase 0 probes (`NN-name.ts`, run with
  `node probes/NN-name.ts`, Node 22.18+), their shared helpers under `probes/lib/`, raw
  outputs under `probes/out/` (ignored by git) and sanitized recordings under
  `probes/fixtures/`. Live probes spend the user's Claude and Codex quotas and build
  throwaway repositories under `~/.local/state/chatroom-probes/`.

## Rules for working in this repo

- **Parity is the posture, and prompt before mechanism.** A change that makes the
  chatroom stricter than the user's daily solo use must be argued as a coordination
  failure or data loss inside the parity model (guard G1). A rule that can be a sentence
  in the agent's brief is one; a mechanism needs a measured data-loss case (guard G2).
  Keep state as files the user can open.
- **Guards are not reversed silently.** To argue against one, quote it and say why; the
  user decides.
- **Measure before claiming.** Every statement about a CLI flag, a config key, a protocol
  method or a git behaviour is verified against the installed tool's help, the app-server
  schema (`codex app-server generate-json-schema --out <dir>`), the official docs, or a
  scratch-repository experiment, and recorded in `ARCHITECTURE.md` §16 with the tool
  version. Nothing about vendor behaviour is stated from memory.
- **Reviews have a bar.** A finding counts if it is a coordination failure, data loss in an
  orchestrator operation, a factual error against docs or measurements, or an internal
  inconsistency. Hardening beyond parity does not count. The brief in `docs/STATUS.md`
  says this to the reviewing model; use it.
- **Nothing unasked.** Do not add a file, a mechanism, a configuration key or a process
  the user did not ask for without saying so first.
- **The architecture stays standalone.** No "changes from vN" sections, no references to
  earlier versions, no review history in guard evidence.

## Verification

Code gate: `npm run typecheck` (strict TypeScript, `erasableSyntaxOnly` because the code
runs through Node's type stripping without a build step) and `npm test` (model-free,
under ten seconds). `chatroom doctor --live` is the live end-to-end check; it spends
both quotas and needs a git repository to run in. The model-free probe `07-recovery`
must also stay green.
The document gate is the set of shell checks in `docs/STATUS.md` under "Document checks":
dangling section references, guard index versus guard blocks, leftover em-dashes, stale
terms. Run them after any edit to `ARCHITECTURE.md`.

## Next

Real use. `docs/STATUS.md` holds the resume point, what the rewrite removed and why,
and how to run the command.

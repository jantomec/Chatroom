import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NAMES_DEFAULT, brief, formatDelivery, mentions, parseMarker, resolveTargets } from "./brief.ts";

test("mentions: word boundary, case-insensitive, outside code, unknown handles reported", () => {
  const { targets, unknown } = mentions("@Clara and @PHIL, not email@phil.x, `@clara` in code, ```\n@phil\n``` fenced, @nobody", NAMES_DEFAULT);
  assert.deepEqual([...targets].sort(), ["claude", "codex"]);
  assert.deepEqual(unknown, ["nobody"]);
});

test("targets: user without mention reaches both agents; agent without mention reaches the user; @all is everyone but the author; --to wins", () => {
  assert.deepEqual(resolveTargets("user", "do it", NAMES_DEFAULT).to, ["claude", "codex"]);
  assert.deepEqual(resolveTargets("user", "@phil do it", NAMES_DEFAULT).to, ["codex"]);
  assert.deepEqual(resolveTargets("claude", "done", NAMES_DEFAULT).to, ["user"]);
  assert.deepEqual(resolveTargets("claude", "@phil @clara hi", NAMES_DEFAULT).to, ["codex"]);
  assert.deepEqual(resolveTargets("codex", "@all hi", NAMES_DEFAULT).to, ["user", "claude"]);
  assert.deepEqual(resolveTargets("codex", "@clara hi", NAMES_DEFAULT, ["user"]).to, ["user"]);
});

test("markers parse at the start only, with an optional task id", () => {
  assert.deepEqual(parseMarker("[done] #41 all criteria met"), { marker: "done", task: 41 });
  assert.deepEqual(parseMarker("  [Ask-User] which?"), { marker: "ask-user", task: null });
  assert.equal(parseMarker("later [done]"), null);
  assert.equal(parseMarker("[bogus] x"), null);
});

test("brief names both agents, the worktrees and the commit note", () => {
  const b = brief({ agent: "claude", names: NAMES_DEFAULT, myWorktree: "/w/claude", peerWorktree: "/w/codex", mainTree: "/m", myBranch: "chatroom/x/claude", nativeCommit: false, extra: "Use pnpm." });
  assert.match(b, /You are Clara, @clara in a project chat with @user and Phil, @phil/);
  assert.match(b, /Committing is unavailable/);
  assert.match(b, /Project guidance[\s\S]*Use pnpm\./);
  assert.match(b, /Do not read ~\/\.claude or ~\/\.codex/);
});

test("delivery format matches §11.1", () => {
  const text = formatDelivery({ agent: "claude", names: NAMES_DEFAULT, messages: [
    { id: 41, at: "2026-09-07T10:07:12.000Z", kind: "message", from: "user", to: ["claude", "codex"], body: "Implement X." },
    { id: 42, at: "2026-09-07T10:07:40.000Z", kind: "message", from: "codex", to: ["claude"], body: "@clara I'll take the parser", reply_to: 41 },
  ], workspace: { own: "9c29e41", integration: "7b88c12", peer: "a88f009", main: "116e230" }, peerChanges: ["src/parser.ts"], tasks: "#41 open · criteria #42 · blockers 0/2" });
  assert.match(text, /^\[chatroom\] You are @clara\. 2 new messages\./);
  assert.match(text, /--- #41 · user → @clara @phil · 10:07:12\nImplement X\./);
  assert.match(text, /--- #42 · phil → @clara · 10:07:40 · reply to #41/);
  assert.match(text, /workspace: own=9c29e41 integration=7b88c12 peer=a88f009 main=116e230\npeer changes since your previous input: src\/parser.ts\ntasks: #41 open/);
});

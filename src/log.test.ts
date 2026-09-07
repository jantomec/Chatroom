import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Log } from "./log.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "chatroom-log-")), "log.jsonl");

test("appends increasing ids and reads them back", () => {
  const p = fresh();
  const log = new Log(p);
  const a = log.append({ kind: "message", from: "user", to: ["claude", "codex"], body: "hi" });
  const b = log.append({ kind: "note", text: "x" });
  assert.equal(a.id, 1); assert.equal(b.id, 2);
  log.close();
  const again = new Log(p);
  assert.deepEqual(again.records.map((r) => r.id), [1, 2]);
  assert.equal(again.append({ kind: "note", text: "y" }).id, 3);
  again.close();
});

test("a partial last line is skipped, noted, and does not corrupt the next append", () => {
  const p = fresh();
  const log = new Log(p);
  log.append({ kind: "message", from: "user", to: ["claude"], body: "one" });
  log.close();
  appendFileSync(p, '{"id":2,"at":"2026-09-07T00:00:00Z","kind":"message","from":"user","to":["claude"],"body":"tru');
  const again = new Log(p);
  assert.deepEqual(again.skipped, [2]);
  assert.equal(again.records.length, 2);            // the message and the startup note
  assert.equal(again.records[1]?.kind, "note");
  const next = again.append({ kind: "message", from: "user", to: ["claude"], body: "two" });
  assert.equal(next.id, 3);
  again.close();
  const third = new Log(p);
  assert.equal(third.skipped.length, 1);            // the bad bytes are still there, still skipped
  assert.deepEqual(third.records.filter((r) => r.kind === "message").map((r) => (r as any).body), ["one", "two"]);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 5);                    // one, partial, note, two, note
  third.close();
});

test("an empty or missing file starts at id 1", () => {
  const p = fresh();
  writeFileSync(p, "");
  const log = new Log(p);
  assert.equal(log.append({ kind: "note", text: "first" }).id, 1);
  log.close();
});

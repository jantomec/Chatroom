import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ipc, agentCommand, agentEnv } from "./ipc.ts";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "chatroom-ipc-"));
  const ipc = new Ipc(base);
  const dirs = ipc.ensure("claude");
  const env = agentEnv({ CHATROOM_AGENT: "claude", CHATROOM_HANDLE: "clara", CHATROOM_OPERATION_DIR: dirs.drop, CHATROOM_DELIVERY_DIR: ipc.deliveries("claude"), CHATROOM_RECEIPT_DIR: ipc.receipts("claude"), CHATROOM_ASK_TIMEOUT: "1" })!;
  const out: string[] = []; const err: string[] = []; let stdin = "";
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), stdin: () => stdin };
  return { ipc, env, io, out, err, setStdin: (s: string) => { stdin = s; }, dirs };
}

test("post writes an operation file, the orchestrator imports it once and writes a receipt the command prints", async () => {
  const { ipc, env, io, out } = setup();
  const p = agentCommand("post", ["--to", "phil", "Parser", "ready"], env, io);
  await new Promise((r) => setTimeout(r, 50));
  const ops = ipc.poll("claude");
  assert.equal(ops.length, 1); assert.equal(ops[0]!.body, "Parser ready"); assert.deepEqual(ops[0]!.to, ["phil"]); assert.equal(ops[0]!.type, "post");
  assert.equal(ipc.poll("claude").length, 0, "imported once");
  ipc.writeReceipt("claude", { op: ops[0]!.op, status: "accepted", message: 42 });
  assert.equal(await p, 0);
  assert.deepEqual(out, ["#42"]);
});

test("reply carries reply_to; a malformed file is renamed .rejected; acceptance unknown on timeout", async () => {
  const { ipc, env, io, out, dirs } = setup();
  writeFileSync(join(dirs.drop, "bad.json"), "{not json");
  const p = agentCommand("reply", ["7", "It", "returns", "an", "iterator."], env, io);
  await new Promise((r) => setTimeout(r, 50));
  const ops = ipc.poll("claude");
  assert.equal(ops.length, 1); assert.equal(ops[0]!.reply_to, 7); assert.equal(ops[0]!.type, "reply");
  assert.ok(readdirSync(dirs.drop).includes("bad.json.rejected"));
  assert.equal(await p, 0);
  assert.match(out[0]!, /acceptance unknown/);
});

test("ask waits for the answer file and reports probable correlation", async () => {
  const { ipc, env, io, out } = setup();
  const p = agentCommand("ask", ["@phil", "list", "or", "iterator?"], env, io);
  await new Promise((r) => setTimeout(r, 50));
  const [op] = ipc.poll("claude");
  assert.equal(op!.type, "ask");
  ipc.writeReceipt("claude", { op: op!.op, status: "accepted", message: 52 });
  await new Promise((r) => setTimeout(r, 150));
  ipc.writeAnswer("claude", op!.op, { status: "probable", message: { id: 53, from: "phil", body: "iterator" } });
  assert.equal(await p, 0);
  assert.equal(out[0], "#52"); assert.match(out[1]!, /^probable: #53 phil: iterator\n\(correlation inferred/);
});

test("hook drains deliveries, writes an acknowledgement with effort and cwd, and prints additionalContext", async () => {
  const { ipc, env, io, out, setStdin } = setup();
  const name = ipc.writeDelivery("claude", "[chatroom] hello\n");
  setStdin(JSON.stringify({ hook_event_name: "PostToolUseFailure", effort: { level: "high" }, cwd: "/w" }));
  assert.equal(await agentCommand("hook", [], env, io), 0);
  const printed = JSON.parse(out[0]!);
  assert.equal(printed.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(printed.hookSpecificOutput.additionalContext, /hello/);
  const [ack] = ipc.poll("claude");
  assert.equal(ack!.type, "delivery_ack"); assert.deepEqual(ack!.delivered, [name]); assert.equal(ack!.effort, "high"); assert.equal(ack!.cwd, "/w");
  ipc.removeDelivery("claude", name);
  assert.deepEqual(ipc.pendingDeliveries("claude"), []);
  // a hook with nothing pending prints nothing and still acknowledges
  out.length = 0; setStdin("{}");
  await agentCommand("hook", [], env, io);
  assert.deepEqual(out, []);
  assert.equal(ipc.poll("claude").length, 1);
});

test("inbox prints deliveries and acknowledges; the commands refuse to run without the environment", async () => {
  const { ipc, env, io, out } = setup();
  ipc.writeDelivery("claude", "one\n"); ipc.writeDelivery("claude", "two\n");
  await agentCommand("inbox", [], env, io);
  assert.equal(out[0], "one\n\ntwo\n");
  assert.equal(agentEnv({}), null);
});

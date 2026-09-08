import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeDriver } from "./fake-driver.ts";
import { Log } from "./log.ts";
import { Room, fold } from "./room.ts";
import { CONFIG_DEFAULTS } from "./types.ts";

function setup(limit = 6) {
  const dir = mkdtempSync(join(tmpdir(), "chatroom-room-"));
  const path = join(dir, "log.jsonl");
  const log = new Log(path);
  const claude = new FakeDriver("claude"); const codex = new FakeDriver("codex");
  const out: string[] = [];
  const room = new Room(log, { ...CONFIG_DEFAULTS, autonomyLimit: limit }, { claude, codex }, { output: (l) => out.push(l) });
  return { dir, path, log, claude, codex, room, out };
}
const ids = (s: string) => [...s.matchAll(/--- #(\d+)/g)].map((m) => Number(m[1]));

test("a user message to both starts both turns with the message as input, in parallel", async () => {
  const { room, claude, codex } = setup();
  const m = await room.postUser("Implement X.");
  assert.equal(claude.turns.length, 1); assert.equal(codex.turns.length, 1);
  assert.deepEqual(ids(claude.lastTurn.input), [m.id]); assert.deepEqual(ids(codex.lastTurn.input), [m.id]);
  assert.equal(room.state.turns.claude?.id, "t-0001");
  assert.equal(claude.connects.length, 1); assert.equal(room.state.sessions.claude.state, "started");
});

test("both finals are recorded and each becomes the other's next delivery (G8)", async () => {
  const { room, claude, codex } = setup();
  await room.postUser("Plan it.");
  claude.final("@phil I'll take the parser."); codex.final("@clara I'll take the CLI.");
  await room.idle();
  const msgs = [...room.state.messages.values()].filter((m) => m.from !== "user");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.via, "final"); assert.equal(msgs[0]?.reply_to, 1);
  // clara's reply reached phil's still-running turn by steering; phil's reply started clara's second turn
  assert.equal(codex.steers.length, 1); assert.deepEqual(ids(codex.steers[0]!), [msgs[0]!.id]);
  assert.equal(claude.turns.length, 2); assert.deepEqual(ids(claude.turns[1]!.input), [msgs[1]!.id]);
  assert.equal(room.state.creditsUsed, 2);
});

test("a final without mention targets the user and triggers nobody; [silent] posts nothing", async () => {
  const { room, claude, codex } = setup();
  await room.postUser("@clara hello");
  claude.final("Hello back."); await room.idle();
  assert.equal(codex.turns.length, 0);
  assert.deepEqual([...room.state.messages.values()].at(-1)!.to, ["user"]);
  await room.postUser("@clara again");
  claude.final("[silent]"); await room.idle();
  assert.equal([...room.state.messages.values()].filter((m) => m.from === "claude").length, 1);
});

test("mid-turn delivery: steer on codex, hook on claude, hook ack, and release at turn end", async () => {
  const { room, claude, codex } = setup();
  await room.postUser("Go.");
  // codex posts to clara while clara runs: hook delivery
  const m1 = await room.postAgent("codex", { op: "op-1", body: "@clara parser ready", turn: "t-0002" });
  assert.equal(claude.hooks.length, 1); assert.deepEqual(claude.hooks[0]!.ids, [m1.id]);
  assert.equal(room.state.received.claude.has(m1.id), false);
  await room.ackDelivery("claude", [m1.id]);
  assert.equal(room.state.received.claude.has(m1.id), true);
  // clara posts to phil while phil runs: steer
  const m2 = await room.postAgent("claude", { op: "op-2", body: "@phil ok", turn: "t-0001" });
  assert.equal(codex.steers.length, 1); assert.equal(room.state.received.codex.has(m2.id), true);
  // an unacknowledged hook delivery returns to the queue at turn end and is re-delivered on the next turn
  const m3 = await room.postAgent("codex", { op: "op-3", body: "@clara one more", turn: "t-0002" });
  assert.equal(claude.hooks.length, 2);
  claude.final("[silent]"); await room.idle();
  assert.ok(room.log.records.some((r) => r.kind === "turn" && r.event === "released" && (r.inputs ?? []).includes(m3.id)), "unacknowledged delivery released at turn end");
  assert.equal(claude.turns.length, 2, "re-delivered as the input of a new turn");
  assert.deepEqual(ids(claude.turns[1]!.input), [m3.id]);
  assert.equal(room.state.creditsUsed, 3, "no second charge");
});

test("Esc: interrupts both, returns the unread user message for editing, holds unread agent messages until the next message", async () => {
  const { room, claude, codex } = setup();
  await room.postUser("Go.");                                                                   // read by both at turn start
  const m1 = await room.postAgent("codex", { op: "op-1", body: "@clara parser ready", turn: "t-0002" });   // hook delivery, unread
  const u = await room.postUser("@clara wait, one more thing");                                  // hook delivery, unread
  assert.equal(claude.hooks.length, 2);
  const back = await room.interruptByUser();
  assert.equal(back, u.body, "the unread user message comes back for editing");
  assert.equal(claude.interrupted, 1); assert.equal(codex.interrupted, 1); assert.equal(claude.dropped, 1, "delivery files dropped");
  assert.ok(room.state.retracted.claude.has(u.id)); assert.ok(room.state.heldFor.claude.has(m1.id));
  claude.final("[silent]"); codex.final("[silent]"); await room.idle();
  assert.equal(claude.turns.length, 1, "nothing restarts on its own"); assert.equal(codex.turns.length, 1);
  assert.equal(room.log.records.filter((r) => r.kind === "turn" && r.event === "started" && r.reason === "summary").length, 0, "no summary after Esc");
  const u2 = await room.postUser("@clara edited");
  assert.equal(claude.turns.length, 2);
  assert.deepEqual(ids(claude.lastTurn.input), [m1.id, u2.id], "the held message arrives with the next one; the withdrawn one never does");
  assert.equal(await room.interruptByUser(), null, "Esc with nothing unread returns nothing");
});

test("duplicate op returns the same message", async () => {
  const { room } = setup();
  await room.postUser("@phil x");
  const a = await room.postAgent("codex", { op: "same", body: "hi", turn: "t-0001" });
  const b = await room.postAgent("codex", { op: "same", body: "hi", turn: "t-0001" });
  assert.equal(a.id, b.id);
  assert.equal([...room.state.messages.values()].filter((m) => m.from === "codex").length, 1);
});

test("budget: the seventh activation is held, released when the user addresses the agent or raises /budget", async () => {
  const { room, claude, codex, out } = setup(2);
  await room.postUser("@clara start");
  claude.final("@phil 1"); await room.idle();            // credit 1
  codex.final("@clara 2"); await room.idle();            // credit 2
  claude.final("@phil 3"); await room.idle();            // held
  const held = [...room.state.messages.values()].find((m) => m.body === "@phil 3")!;
  assert.equal(held.held, true); assert.equal(room.state.heldFor.codex.has(held.id), true);
  assert.equal(codex.turns.length, 1, "phil not triggered by the held message");
  assert.ok(out.some((l) => /Budget 2\/2 used/.test(l)), "budget summary posted");
  await room.postUser("@clara only");                    // does not release phil's held message
  assert.equal(room.state.heldFor.codex.has(held.id), true);
  assert.equal(room.state.creditsUsed, 0, "user message resets the count");
  await room.postUser("@phil go on");                    // releases it, free
  assert.equal(room.state.heldFor.codex.has(held.id), false);
  assert.ok(ids(codex.lastTurn.input).includes(held.id));
  // raise the budget releases in order while credit lasts
  const { room: r2, claude: c2, codex: x2 } = setup(1);
  await r2.postUser("@clara s"); c2.final("@phil a"); await r2.idle(); x2.final("@clara b"); await r2.idle();
  assert.equal(r2.state.heldFor.claude.size, 1);
  await r2.setBudget(5);
  assert.equal(r2.state.heldFor.claude.size, 0); assert.equal(r2.state.limit, 5);
});

test("protocol: criteria, done triggers the peer, blocker triggers the claimant, cap escalates, accept summarizes", async () => {
  const { room, claude, codex } = setup(20);
  const task = await room.postUser("Build the parser.");          // #1, both
  await room.postAgent("claude", { op: "c", body: `[criteria] #${task.id} 1. parses 2. tests pass`, turn: "t-0001" });
  assert.equal(room.state.tasks.get(task.id)?.lead, "claude");
  claude.final(`[done] #${task.id} 1. ran it 2. npm test green`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "done_claimed");
  const done = [...room.state.messages.values()].find((m) => m.body.startsWith("[done]"))!;
  assert.ok(done.to.includes("codex"), "done reaches the peer without a mention");
  codex.final(`[blocker] #${task.id} criterion 2 fails: test X red`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "open"); assert.equal(room.state.tasks.get(task.id)?.blockers, 1);
  const blocker = [...room.state.messages.values()].find((m) => m.body.startsWith("[blocker]"))!;
  assert.ok(blocker.to.includes("claude"), "blocker reaches the claimant");
  // the claimant cannot accept its own claim
  claude.final(`[done] #${task.id} fixed`); await room.idle();
  claude.final(`[accept] #${task.id} looks good to me`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "done_claimed");
  // second blocker, then the third escalates
  codex.final(`[blocker] #${task.id} still red`); await room.idle();
  claude.final(`[done] #${task.id} fixed again`); await room.idle();
  codex.final(`[blocker] #${task.id} nope`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "escalated");
  const summaries = [...room.state.messages.values()].filter((m) => m.from === "chatroom");
  assert.ok(summaries.some((m) => /goes to you/.test(m.body)));
  assert.ok(summaries.every((m) => m.to.length === 1 && m.to[0] === "user" && !m.credit));
  // the user posts into the task: reopened; then done and accept
  await room.postUser(`#${task.id} take phil's fix, ship it`);
  assert.equal(room.state.tasks.get(task.id)?.state, "open");
  claude.final(`[done] #${task.id} shipped`); await room.idle();
  codex.final(`[accept] #${task.id} 1. verified 2. verified`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "accepted");
  assert.ok(summaries.length < [...room.state.messages.values()].filter((m) => m.from === "chatroom").length);
  claude.final(`[done] #${task.id} late`); await room.idle();
  assert.equal(room.state.tasks.get(task.id)?.state, "accepted", "a late done does not reopen");
});

test("[ask-user] targets the user and holds agent-to-agent traffic on the task until the user answers", async () => {
  const { room, claude, codex } = setup(20);
  const task = await room.postUser("Decide the format.");
  claude.final(`[ask-user] #${task.id} JSON or YAML? @phil prefers YAML`); await room.idle();
  const q = [...room.state.messages.values()].find((m) => m.body.startsWith("[ask-user]"))!;
  assert.deepEqual(q.to, ["user"]);
  assert.equal(room.state.tasks.get(task.id)?.state, "waiting_user");
  codex.final(`@clara let's just pick YAML #${task.id}`); await room.idle();
  const held = [...room.state.messages.values()].find((m) => m.body.startsWith("@clara let's"))!;
  assert.equal(held.held, true);
  await room.postUser(`JSON. #${task.id}`);
  assert.equal(room.state.tasks.get(task.id)?.state, "open");
  assert.equal(room.state.heldFor.claude.has(held.id), false);
});

test("crash injection: every prefix of the log folds to a consistent state and resumes without duplicates", async () => {
  const { room, claude, codex, path, dir } = setup(3);
  await room.postUser("Task.");
  claude.final("@phil a"); await room.idle();
  await room.postAgent("codex", { op: "o1", body: "@clara b", turn: "t-0002" });
  codex.final("[done] #1 all"); await room.idle();
  claude.final("[accept] #1 1. ok"); await room.idle();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length > 10);
  for (let k = 1; k <= lines.length; k++) {
    const p = join(dir, `prefix-${k}.jsonl`);
    writeFileSync(p, lines.slice(0, k).join("\n") + "\n");
    const log = new Log(p);
    const s = fold(log.records, 3);
    const all = new Set(s.messages.keys());
    for (const a of ["claude", "codex"] as const) for (const id of s.received[a]) assert.ok(all.has(id), `prefix ${k}: received id ${id} exists`);
    assert.equal(s.ops.size, [...s.messages.values()].filter((m) => m.op).length, `prefix ${k}: ops unique`);
    const c = new FakeDriver("claude"), x = new FakeDriver("codex");
    const resumed = new Room(log, { ...CONFIG_DEFAULTS, autonomyLimit: 3 }, { claude: c, codex: x });
    for (const a of ["claude", "codex"] as const) assert.equal(resumed.state.turns[a], null, `prefix ${k}: open turns closed at startup`);
    const before = { claude: new Set(s.received.claude), codex: new Set(s.received.codex) };
    await resumed.tick();
    for (const d of [c, x]) for (const t of d.turns) for (const id of ids(t.input)) assert.ok(!before[d.agent].has(id), `prefix ${k}: ${d.agent} not re-delivered #${id}`);
    log.close();
  }
});

test("startup after a crash mid-turn: the turn is marked interrupted and the next turn resumes the session with a recovery note", async () => {
  const { room, claude, path } = setup();
  await room.postUser("@clara work");
  assert.equal(room.state.turns.claude?.id, "t-0001");
  room.log.close();
  const log = new Log(path);
  const c = new FakeDriver("claude"), x = new FakeDriver("codex");
  const again = new Room(log, CONFIG_DEFAULTS, { claude: c, codex: x });
  assert.equal(again.state.turns.claude, null);
  assert.ok(log.records.some((r) => r.kind === "turn" && r.event === "interrupted"));
  await again.postUser("@clara continue");
  assert.equal(c.connects.length, 1); assert.equal(c.connects[0]!.id, "s-claude-1", "resumes the recorded session id");
  assert.match(c.lastTurn.input, /Recovery note: your previous turn t-0001 was interrupted/);
  assert.equal(again.state.sessions.claude.state, "resumed");
  // a failed resume rebuilds
  const log2 = new Log(path); const c2 = new FakeDriver("claude"); c2.failResume = true;
  const third = new Room(log2, CONFIG_DEFAULTS, { claude: c2, codex: new FakeDriver("codex") });
  void third; assert.equal(c2.failResume, true);
});

test("prompts are recorded, relayed and answered", async () => {
  const { room, claude } = setup();
  const relayed: string[] = [];
  room.hooks.prompt = (_a, id, summary) => relayed.push(`${id}:${summary}`);
  await room.postUser("@clara do");
  claude.emit({ type: "prompt", id: "p1", summary: "Bash: rm -rf build", request: {} }); await room.idle();
  assert.deepEqual(relayed, ["p1:Bash: rm -rf build"]);
  assert.ok(room.state.prompts.has("p1"));
  assert.equal(await room.answerPrompt("p1", "deny", "no"), true);
  assert.deepEqual(claude.prompts, [{ id: "p1", decision: "deny", reason: "no" }]);
  assert.equal(room.state.prompts.has("p1"), false);
});

test("exchange summary: after three agent-to-agent messages and both idle, the last speaker is asked to summarize for the user, once", async () => {
  const { room, claude, codex } = setup(20);
  await room.postUser("Build it together.");
  claude.final("@phil I'll take the parser."); await room.idle();      // 1
  codex.final("@clara I'll take the CLI."); await room.idle();          // 2
  claude.final("@phil parser done, merging yours."); await room.idle(); // 3
  codex.final("[silent]"); await room.idle();                            // codex idle, nothing queued for anyone
  const summaryTurn = room.log.records.find((r) => r.kind === "turn" && r.event === "started" && r.reason === "summary");
  assert.ok(summaryTurn, "a summary turn was started");
  assert.equal((summaryTurn as any).agent, "claude", "the last speaker is asked (phil's [silent] posted nothing)");
  assert.match(claude.lastTurn.input, /The exchange has paused: you and the other agent have both gone idle/);
  claude.final("Parser and CLI are done on both branches; nothing open."); await room.idle();
  const summary = [...room.state.messages.values()].find((m) => m.via === "summary" && m.from === "claude");
  assert.ok(summary); assert.deepEqual(summary!.to, ["user"]); assert.equal(summary!.credit, undefined);
  assert.equal(room.log.records.filter((r) => r.kind === "turn" && r.event === "started" && r.reason === "summary").length, 1, "not asked twice");
  // a new user message starts a new exchange; a short one gets no summary
  await room.postUser("@clara thanks");
  claude.final("You're welcome."); await room.idle();
  assert.equal(room.log.records.filter((r) => r.kind === "turn" && r.event === "started" && r.reason === "summary").length, 1);
});

test("exchange summary: when the budget holds a message, the summary follows once both are idle", async () => {
  const { room, claude, codex } = setup(1);
  await room.postUser("Go.");
  claude.final("@phil first"); await room.idle();        // credit 1 of 1; phil's turn from the user message is running, so it is steered
  codex.final("@clara second"); await room.idle();       // held: budget used
  assert.equal(room.state.exchange.held, true);
  const summaryTurn = room.log.records.find((r) => r.kind === "turn" && r.event === "started" && r.reason === "summary");
  assert.ok(summaryTurn, "summary requested"); assert.equal((summaryTurn as any).agent, "codex");
  assert.match(codex.lastTurn.input, /budget is used up/);
  void claude;
});

test("warm-up and the first turn racing each other connect a driver once", async () => {
  const { room, claude, codex } = setup();
  await Promise.all([room.warm(), room.postUser("@clara go")]);
  assert.equal(claude.connects.length, 1); assert.equal(codex.connects.length, 1);
  assert.equal(room.log.records.filter((r) => r.kind === "session").length, 2);
});

// Phase 0 item 5: the `codex exec` fallback with -c overrides on start and resume, the
// commit test, the JSONL event shapes, environment filters, and a blocked write.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allRefs, buildLab, refOid, type Lab } from "./lib/lab.ts";
import { CODEX_BIN, HOME, PROBES_ROOT, Recorder, cleanEnv, run, versionOf } from "./lib/util.ts";

const rec = new Recorder("05-codex-exec");
rec.note("codex_version", versionOf(CODEX_BIN));
const lab = buildLab(join(HOME, ".local/state/chatroom-probes/lab05"));
const profileName = "chatroom-p0";
function overrides(lab: Lab): string[] {
  const c = lab.commonDir;
  const fs: [string, string][] = [
    [":root", "read"], [lab.worktrees.codex, "write"], [lab.ipc.codex.drop, "write"], [lab.ipc.codex.scratch, "write"],
    [lab.adminDirs.codex, "write"], [join(c, "objects"), "write"],
    [join(c, "refs/heads", lab.branches.codex), "write"], [join(c, "refs/heads", lab.branches.codex + ".lock"), "write"],
    [join(c, "logs/refs/heads", lab.branches.codex), "write"], [join(c, "logs/refs/heads", lab.branches.codex + ".lock"), "write"],
    [lab.authority, "deny"], [join(lab.ipc.root, "*", "staging"), "deny"], [lab.ipc.claude.root, "deny"], [lab.secrets, "deny"],
  ];
  const table = "{ " + fs.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(", ") + " }";
  return [
    "-c", `default_permissions=${JSON.stringify(profileName)}`,
    "-c", `permissions.${profileName}.filesystem=${table}`,
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    "-c", `shell_environment_policy.filters={ "*SECRET*" = "exclude" }`,
    "-c", `shell_environment_policy.set={ CHATROOM_PROBE_SET = "via-c-set", TMPDIR = ${JSON.stringify(lab.ipc.codex.scratch)}, GIT_OPTIONAL_LOCKS = "0" }`,
  ];
}
const env = cleanEnv({
  CHATROOM_AGENT: "codex", CHATROOM_HANDLE: "phil", CHATROOM_CONVERSATION: lab.conv, CHATROOM_TURN: "turn0001",
  CHATROOM_OPERATION_DIR: lab.ipc.codex.drop, CHATROOM_DELIVERY_DIR: lab.ipc.codex.deliveries, CHATROOM_RECEIPT_DIR: lab.ipc.codex.receipts,
  CHATROOM_SCRATCH: lab.ipc.codex.scratch, CHATROOM_BIN: join(PROBES_ROOT, "lib", "chatroom-stub.sh"), CHATROOM_PROTOCOL: "3", GIT_OPTIONAL_LOCKS: "0",
  MY_FAKE_TOKEN: "token-should-be-stripped", MY_FAKE_SECRET: "secret-should-be-stripped",
});
type Ev = Record<string, any>;
function exec(label: string, args: string[], prompt: string, cwd: string): { events: Ev[]; last: string; status: number | null; stderr: string; ms: number } {
  const out = rec.file(`${label}.last.txt`);
  const t0 = Date.now();
  const r = run(CODEX_BIN, [...args, "--json", "-o", out], { cwd, env, input: prompt, timeoutMs: 600_000 });
  const events = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Ev; } catch { return { _unparsed: l }; } });
  const ms = Date.now() - t0;
  const last = existsSync(out) ? readFileSync(out, "utf8") : "";
  rec.log(`${label}: exit=${r.status} ${ms} ms, events=${events.map((e) => e["type"]).join(",")}, last=${JSON.stringify(last).slice(0, 200)}`);
  if (r.status !== 0) rec.log(`${label} stderr: ${r.stderr.slice(-800)}`);
  return { events, last, status: r.status, stderr: r.stderr, ms };
}

// E1: start with -c overrides, prompt on stdin, environment and a fact to remember
const e1 = exec("E1", ["exec", ...overrides(lab), "--cd", lab.worktrees.codex, "-"],
  "Remember the secret word PAPAYA. Run exactly this shell command: echo \"$CHATROOM_AGENT|$CHATROOM_PROBE_SET|$MY_FAKE_TOKEN|$MY_FAKE_SECRET|$TMPDIR\"\nReply with only the command's output.", lab.worktrees.codex);
rec.check("E1 exit 0", e1.status === 0, { status: e1.status, stderr: e1.stderr.slice(-300) });
const threadId = e1.events.find((e) => e["type"] === "thread.started")?.["thread_id"] as string | undefined;
rec.note("E1_thread_started", e1.events.find((e) => e["type"] === "thread.started"));
rec.check("thread.started carries thread_id", typeof threadId === "string", threadId);
rec.note("E1_event_types", [...new Set(e1.events.map((e) => e["type"]))]);
rec.note("E1_turn_completed", e1.events.find((e) => e["type"] === "turn.completed"));
rec.check("turn.completed carries usage.input_tokens and no model or context window", (() => { const t = e1.events.find((e) => e["type"] === "turn.completed"); return Boolean(t && typeof t["usage"]?.input_tokens === "number" && !("model" in t) && !JSON.stringify(t).includes("context_window")); })());
rec.note("E1_items", e1.events.filter((e) => e["type"] === "item.completed").map((e) => e["item"]));
rec.check("-c overrides: CHATROOM_AGENT inherited and set map applied", /codex\|via-c-set/.test(e1.last), e1.last);
rec.check("-c ignore_default_excludes=false strips *TOKEN*", !/token-should-be-stripped/.test(e1.last), e1.last);
rec.check("-c filters exclude strips *SECRET*", !/secret-should-be-stripped/.test(e1.last), e1.last);
rec.check("TMPDIR is the scratch root", e1.last.includes(lab.ipc.codex.scratch), e1.last);

// E2: resume with the same overrides; commit test
const refsBefore = allRefs(lab);
const e2 = exec("E2", ["exec", "resume", threadId ?? "missing", ...overrides(lab), "-"],
  "Create note.txt containing hi in the current directory, then run: git add note.txt && git commit -q -m probe && git rev-parse HEAD\nReply with only the commit hash. Then, on a second line, the secret word you were asked to remember.", lab.worktrees.codex);
rec.check("E2 (exec resume) exit 0", e2.status === 0, { status: e2.status, stderr: e2.stderr.slice(-300) });
rec.check("exec resume runs in the worktree when spawned there (no --cd on resume)", e2.events.some((e) => JSON.stringify(e).includes(lab.worktrees.codex)) || /[0-9a-f]{40}/.test(e2.last), e2.last);
const refsAfter = allRefs(lab);
const codexRef = `refs/heads/${lab.branches.codex}`;
const moved = Object.keys({ ...refsBefore, ...refsAfter }).filter((r) => refsBefore[r] !== refsAfter[r]);
rec.check("commit under exec moved only the own branch", moved.length === 1 && moved[0] === codexRef, { moved });
rec.check("main did not move", refOid(lab, "refs/heads/main") === lab.baseOid);
rec.check("resumed exec remembers the first run", /PAPAYA/.test(e2.last), e2.last);
rec.note("E2_command_items", e2.events.filter((e) => e["type"] === "item.completed" && e["item"]?.type === "command_execution").map((e) => ({ command: e["item"].command, exit_code: e["item"].exit_code, output: String(e["item"].aggregated_output ?? "").slice(0, 300) })));

// E3: a write outside the profile fails without any approval path
const escape = join(lab.main, "escape.txt");
const e3 = exec("E3", ["exec", "resume", threadId ?? "missing", ...overrides(lab), "-"],
  `Run exactly this shell command once: printf x > "${escape}"\nDo not retry. Reply with one line: the exit code and the error text, if any.`, lab.worktrees.codex);
rec.check("E3 exit 0", e3.status === 0, e3.status);
rec.check("blocked write under exec: file absent, no approval mechanism", !existsSync(escape), { exists: existsSync(escape), last: e3.last });
rec.note("E3_command_items", e3.events.filter((e) => e["type"] === "item.completed" && e["item"]?.type === "command_execution").map((e) => ({ command: e["item"].command, exit_code: e["item"].exit_code, output: String(e["item"].aggregated_output ?? "").slice(0, 300) })));
rec.note("E3_event_types", [...new Set(e3.events.map((e) => e["type"]))]);
rec.finish({ threadId, lab: lab.root });

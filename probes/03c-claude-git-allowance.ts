// Phase 0 item 3 addendum: why does `git commit` fail in the linked worktree under the
// sandbox? Variants: sandbox alone; sandbox with an explicit allowWrite of the git common
// directory plus the denyWrite list; sandbox with the denyWrite list only.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeProcess, resultText } from "./lib/claude.ts";
import { allRefs, buildLab, refOid } from "./lib/lab.ts";
import { CLAUDE_BIN, HOME, Recorder, cleanEnv } from "./lib/util.ts";

const rec = new Recorder("03c-claude-git-allowance");
const brief = "You are Clara, a probe subject in a test harness. Run exactly the commands you are given, one Bash tool call per command, with no retries, no workarounds and no dangerouslyDisableSandbox. Report what happened.";
async function variant(label: string, mk: (c: string) => Record<string, unknown>): Promise<void> {
  const lab = buildLab(join(HOME, ".local/state/chatroom-probes", `lab03c-${label}`));
  const c = lab.commonDir; const wt = lab.worktrees.claude; const sandbox = mk(c);
  const denyWrite = [lab.adminDirs.codex, lab.adminDirs.integration, join(c, "refs/heads/main"), join(c, "refs/heads", lab.branches.codex), join(c, "refs/heads", lab.branches.integration), join(c, "packed-refs")];
  const settings = { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, ...sandbox, ...(sandbox["filesystem"] ? { filesystem: { ...(sandbox["filesystem"] as object), denyWrite } } : {}) } };
  rec.note(`${label}_settings`, settings);
  const env = cleanEnv({ CHATROOM_AGENT: "claude", GIT_OPTIONAL_LOCKS: "0" });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--settings", JSON.stringify(settings), "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--append-system-prompt", brief, "--session-id", randomUUID()];
  const p = new ClaudeProcess({ bin: CLAUDE_BIN, args, cwd: wt, env, logFile: rec.file(`${label}.jsonl`), onControlRequest: (req) => { rec.note(`${label}_control_request`, req["request"]); return { behavior: "deny", message: "probe host denies" }; } });
  try {
    const before = allRefs(lab); const mark = p.mark(); const t0 = Date.now();
    p.sendUser(`Run these commands with the Bash tool, one call each, in order, exactly as written:\n1. echo c > c.txt && git add c.txt && git commit -q -m probe && git rev-parse HEAD\n2. git update-ref refs/heads/main HEAD\n3. echo x > "${lab.adminDirs.codex}/from-claude-admin.txt"\nReply with one line per command: number, exit code, first line of any error.`);
    const r = await p.waitForResult(mark, 300_000);
    const after = allRefs(lab);
    const moved = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    const own = `refs/heads/${lab.branches.claude}`;
    const results = p.events.filter((e) => e["type"] === "user").flatMap((e) => e["message"]?.content ?? []).filter((b: any) => b.type === "tool_result").map((b: any) => String(b.content).slice(0, 220));
    rec.log(`${label}: ${Date.now() - t0} ms`);
    rec.note(`${label}_tool_results`, results);
    rec.check(`${label}: git commit landed on the own branch`, moved.includes(own), { moved, results });
    rec.check(`${label}: main did not move`, refOid(lab, "refs/heads/main") === lab.baseOid, { main: refOid(lab, "refs/heads/main") });
    rec.check(`${label}: peer admin dir untouched`, !existsSync(join(lab.adminDirs.codex, "from-claude-admin.txt")));
    rec.note(`${label}_reply`, resultText(r).slice(0, 500));
  } catch (e) { rec.check(`${label} completed`, false, String(e) + p.stderr.slice(-500)); }
  p.endInput(); await Promise.race([p.exited, new Promise((res) => setTimeout(res, 30_000))]); if (p.child.exitCode === null) p.kill("SIGKILL");
}
await variant("V1-sandbox-only", () => ({}));
await variant("V2-allowWrite-common-dir-plus-denyWrite", (c) => ({ filesystem: { allowWrite: [c] } }));
await variant("V3-denyWrite-only", () => ({ filesystem: {} }));
rec.finish();

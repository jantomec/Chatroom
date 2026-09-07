// `chatroom doctor` (ARCHITECTURE.md §9.5): the static checks, and with --live one scripted
// turn per agent in a throwaway conversation that verifies the boundary and native commits.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Check { name: string; ok: boolean; detail: string }

function run(cmd: string, args: string[], env = process.env): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 20000 });
  return { status: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

export function staticChecks(bins: { claude: string; codex: string; git: string; gitVersion: string }): Check[] {
  const out: Check[] = [];
  const cv = run(bins.claude, ["--version"]); out.push({ name: "claude executable", ok: cv.status === 0, detail: cv.out.split("\n")[0] ?? "" });
  const auth = run(bins.claude, ["auth", "status"]);
  let a: any = {}; try { a = JSON.parse(auth.out); } catch { /* not json */ }
  out.push({ name: "claude login is claude.ai, not an API key", ok: a.loggedIn === true && a.authMethod === "claude.ai", detail: `loggedIn=${a.loggedIn} authMethod=${a.authMethod} apiProvider=${a.apiProvider}` });
  const xv = run(bins.codex, ["--version"]); out.push({ name: "codex executable", ok: xv.status === 0, detail: xv.out.split("\n")[0] ?? "" });
  const login = run(bins.codex, ["login", "status"]); out.push({ name: "codex login", ok: /logged in/i.test(login.out), detail: login.out.split("\n")[0] ?? "" });
  out.push({ name: "git", ok: true, detail: `${bins.git} (${bins.gitVersion})` });
  out.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  if (process.platform === "darwin") out.push({ name: "macOS sandbox (Seatbelt)", ok: existsSync("/usr/bin/sandbox-exec"), detail: "/usr/bin/sandbox-exec" });
  return out;
}

export interface LiveProbe { agent: "claude" | "codex"; own: string; main: string; peer: string; ipcRoot: string; commonDir: string; ownRef: string; peerRef: string; mainRef: string }

/** The scripted turn text for one agent. */
export function liveScript(p: LiveProbe): string {
  return [
    "[chatroom doctor] Run the following commands with your shell tool, one call each, exactly as written, in order, with no retries and no workarounds. Then reply with one line per command: its number and its exit code.",
    `1. echo probe > chatroom-doctor-own.txt`,
    `2. echo probe > "${p.main}/chatroom-doctor-main.txt"`,
    `3. echo probe > "${p.peer}/chatroom-doctor-peer.txt"`,
    `4. echo probe > "${p.ipcRoot}/chatroom-doctor-ipc.txt"`,
    `5. git add chatroom-doctor-own.txt && git commit -q -m "chatroom doctor" && git rev-parse HEAD`,
    `6. git update-ref refs/heads/main HEAD`,
  ].join("\n");
}

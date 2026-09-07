// Builds a disposable repository laid out the way §4.2 of ARCHITECTURE.md describes:
// a main worktree, per-agent linked worktrees on chatroom/<p>/<c>/<agent> refs, an
// integration worktree, IPC directories and a fake secret path.
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { GIT, gitIn, git, must } from "./util.ts";

export interface Lab {
  root: string;
  main: string;              // main worktree
  commonDir: string;         // <main>/.git
  runtime: string;
  conv: string;
  project: string;
  worktrees: { claude: string; codex: string; integration: string };
  adminDirs: { claude: string; codex: string; integration: string };
  branches: { claude: string; codex: string; integration: string; main: string };
  ipc: { claude: IpcDirs; codex: IpcDirs; root: string };
  secrets: string;
  secretFile: string;
  authority: string;         // <main>/.chatroom
  baseOid: string;
}
export interface IpcDirs { root: string; drop: string; deliveries: string; receipts: string; scratch: string; staging: string }

export function buildLab(root: string, opts: { conv?: string; project?: string } = {}): Lab {
  const conv = opts.conv ?? "c0000001";
  const project = opts.project ?? "p0000001";
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  const main = join(root, "repo");
  mkdirSync(main, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "Lab", GIT_AUTHOR_EMAIL: "lab@example.invalid", GIT_COMMITTER_NAME: "Lab", GIT_COMMITTER_EMAIL: "lab@example.invalid", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  must(gitIn(main, ["init", "-q", "-b", "main"], env), "git init");
  must(gitIn(main, ["config", "user.name", "Lab"], env), "config");
  must(gitIn(main, ["config", "user.email", "lab@example.invalid"], env), "config");
  writeFileSync(join(main, "README.md"), "# lab\n");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src", "app.txt"), "line1\nline2\n");
  writeFileSync(join(main, ".gitignore"), "ignored.txt\n");
  must(gitIn(main, ["add", "-A"], env), "add");
  must(gitIn(main, ["commit", "-q", "-m", "base"], env), "commit");
  const baseOid = must(gitIn(main, ["rev-parse", "HEAD"], env), "rev-parse");
  const commonDir = must(gitIn(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env), "common dir");

  const authority = join(main, ".chatroom");
  mkdirSync(authority, { mode: 0o700 });
  writeFileSync(join(authority, "config.toml"), "# authority canary\n", { mode: 0o600 });
  writeFileSync(join(commonDir, "info", "exclude"), "/.chatroom/\n", { flag: "a" });
  mkdirSync(join(authority, "hooks-empty"));

  const runtime = join(root, "runtime");
  const wtRoot = join(runtime, "worktrees", conv);
  const worktrees = { claude: join(wtRoot, "claude"), codex: join(wtRoot, "codex"), integration: join(runtime, "integration", conv) };
  const prefix = `chatroom/${project}/${conv}`;
  const branches = { claude: `${prefix}/claude`, codex: `${prefix}/codex`, integration: `${prefix}/integration`, main: "main" };
  mkdirSync(wtRoot, { recursive: true });
  mkdirSync(join(runtime, "integration"), { recursive: true });
  for (const k of ["claude", "codex", "integration"] as const) {
    must(gitIn(main, ["worktree", "add", "-q", "-b", branches[k], worktrees[k], "main"], env), `worktree add ${k}`);
  }
  const adminDirs = {} as Lab["adminDirs"];
  for (const k of ["claude", "codex", "integration"] as const) {
    adminDirs[k] = must(git(null, null, ["-C", worktrees[k], "rev-parse", "--path-format=absolute", "--git-dir"], { env }), `admin dir ${k}`);
  }

  const ipcRoot = join(runtime, "ipc");
  const mkIpc = (agent: string): IpcDirs => {
    const r = join(ipcRoot, agent);
    const d: IpcDirs = {
      root: r, drop: join(r, "from-agent", "turn0001-n0nce"), deliveries: join(r, "to-agent", "deliveries"),
      receipts: join(r, "to-agent", "receipts"), scratch: join(r, "scratch", "turn0001-n0nce"), staging: join(r, "staging"),
    };
    for (const p of Object.values(d)) mkdirSync(p, { recursive: true, mode: 0o700 });
    return d;
  };
  const ipc = { claude: mkIpc("claude"), codex: mkIpc("codex"), root: ipcRoot };
  writeFileSync(join(runtime, "lock"), "");

  const secrets = join(root, "secrets");
  mkdirSync(secrets, { recursive: true });
  const secretFile = join(secrets, "canary.txt");
  writeFileSync(secretFile, "SECRET-CANARY-7f3a9c\n");

  return { root, main, commonDir, runtime, conv, project, worktrees, adminDirs, branches, ipc, secrets, secretFile, authority, baseOid };
}

export function refOid(lab: Lab, ref: string): string | null {
  const r = git(lab.commonDir, null, ["rev-parse", "--verify", "-q", ref]);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function allRefs(lab: Lab): Record<string, string> {
  const out = must(git(lab.commonDir, null, ["for-each-ref", "--format=%(refname) %(objectname)"]), "for-each-ref");
  const m: Record<string, string> = {};
  for (const line of out.split("\n").filter(Boolean)) { const [ref, oid] = line.split(" "); if (ref && oid) m[ref] = oid; }
  return m;
}

export function headRef(lab: Lab, worktree: string): string {
  const r = git(null, null, ["-C", worktree, "symbolic-ref", "-q", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : "(detached)";
}

export { GIT };

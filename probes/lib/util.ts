// Shared helpers for the Phase 0 probes. Disposable code: nothing here is imported by src/.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBES_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT_ROOT = join(PROBES_ROOT, "out");
export const HOME = process.env["HOME"] ?? "";
// Pinned by path (Guard G20). Homebrew git is what ARCHITECTURE.md §19 measured with.
export const GIT = process.env["CHATROOM_PROBE_GIT"] ?? "/opt/homebrew/bin/git";
export const CLAUDE_BIN = process.env["CHATROOM_PROBE_CLAUDE"] ?? join(HOME, ".local/bin/claude");
export const CODEX_BIN = process.env["CHATROOM_PROBE_CODEX"] ?? join(HOME, ".nvm/versions/node/v25.1.0/bin/codex");

export function outDir(probe: string): string {
  const d = join(OUT_ROOT, probe);
  mkdirSync(d, { recursive: true });
  return d;
}

export interface RunResult { status: number | null; signal: string | null; stdout: string; stderr: string }

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env ?? process.env, input: opts.input, encoding: "utf8", maxBuffer: 64 << 20,
    timeout: opts.timeoutMs,
  });
  return { status: r.status, signal: r.signal as string | null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Explicit-path git (Guard G22): no discovery, every command names its repository. */
export function git(gitDir: string | null, workTree: string | null, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): RunResult {
  const a: string[] = [];
  if (gitDir) a.push(`--git-dir=${gitDir}`);
  if (workTree) a.push(`--work-tree=${workTree}`);
  return run(GIT, [...a, ...args], opts);
}

/** Discovery-based git, allowed only while building a lab fixture. */
export function gitIn(cwd: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  return run(GIT, args, { cwd, ...(env ? { env } : {}) });
}

export function must(r: RunResult, what: string): string {
  if (r.status !== 0) throw new Error(`${what}: exit ${r.status} ${r.signal ?? ""}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return r.stdout.trim();
}

export const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
export const nowIso = () => new Date().toISOString();

/** A whitelist environment: the probes must not inherit this Claude Code session's own variables. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

export function versionOf(cmd: string, args: string[] = ["--version"]): string {
  const r = run(cmd, args);
  return (r.stdout + r.stderr).trim().split("\n")[0] ?? "";
}

/** Collects findings for one probe and writes them as JSON at the end. */
export class Recorder {
  readonly dir: string;
  readonly startedAt = Date.now();
  readonly findings: Record<string, unknown> = {};
  readonly checks: { name: string; ok: boolean; detail?: unknown }[] = [];
  readonly probe: string;
  constructor(probe: string) {
    this.probe = probe;
    this.dir = outDir(probe);
    writeFileSync(join(this.dir, "events.log"), "");
  }
  note(key: string, value: unknown): void {
    this.findings[key] = value;
    this.log(`note ${key}: ${JSON.stringify(value)}`);
  }
  check(name: string, ok: boolean, detail?: unknown): boolean {
    this.checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    this.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    return ok;
  }
  log(line: string): void {
    const l = `${nowIso()} ${line}`;
    appendFileSync(join(this.dir, "events.log"), l + "\n");
    console.log(l);
  }
  file(name: string): string { return join(this.dir, name); }
  finish(extra: Record<string, unknown> = {}): void {
    const summary = {
      probe: this.probe, finishedAt: nowIso(), wallMs: Date.now() - this.startedAt,
      passed: this.checks.filter((c) => c.ok).length, failed: this.checks.filter((c) => !c.ok).length,
      checks: this.checks, findings: this.findings, ...extra,
    };
    writeFileSync(join(this.dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`\n${this.probe}: ${summary.passed} passed, ${summary.failed} failed, ${summary.wallMs} ms -> ${join(this.dir, "summary.json")}`);
  }
}

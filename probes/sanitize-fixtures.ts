// Copies sanitized samples of the recorded vendor streams into probes/fixtures/ (§20:
// "Driver fixtures recorded from sanitized vendor streams"). Home paths, the user name, email
// addresses, the machine name and the Codex installation id are replaced; account and
// rate-limit records are dropped; the lists that describe the user's own Claude Code setup
// (commands, skills, plugins, MCP servers, agents, memory paths) are emptied and tool
// catalogues truncated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { HOME, OUT_ROOT, PROBES_ROOT } from "./lib/util.ts";

const FIX = join(PROBES_ROOT, "fixtures");
mkdirSync(FIX, { recursive: true });
const USER = HOME.split("/").pop() ?? "";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOST = hostname().replace(/\.local$/, "");
const scrub = (s: string) => s.split(HOME).join("/Users/user").split(USER).join("user").split(HOST).join("host").replace(EMAIL, "user@example.invalid").replace(/"installationId":"[^"]*"/g, '"installationId":"00000000-0000-0000-0000-000000000000"');
const dropLine = (l: string) => /rate_limit_event|account\/rateLimits|"subtype":"thinking_tokens"|"messaging_socket_path"/.test(l) && !/"subtype":"init"/.test(l);
const SETUP_LISTS = new Set(["slash_commands", "skills", "agents", "plugins", "mcp_servers", "terminal_slash_commands", "commands"]);
/** Empty every list that describes the user's own setup, wherever it sits, and truncate tool catalogues. */
function trimInit(obj: any): any {
  if (Array.isArray(obj)) { obj.forEach(trimInit); return obj; }
  if (!obj || typeof obj !== "object") return obj;
  for (const k of Object.keys(obj)) {
    if (k.endsWith("mcp_servers") && Array.isArray(obj[k])) obj[k] = obj[k].filter((e: any) => e?.name === "probe");   // the probe's own server stays
    else if (SETUP_LISTS.has(k) && Array.isArray(obj[k])) obj[k] = [];
    else if (k === "memory_paths") obj[k] = {};
    else if (k === "messaging_socket_path") delete obj[k];
    else if (k === "tools" && Array.isArray(obj[k])) { const t = obj[k].filter((x: unknown) => !(typeof x === "string" && x.startsWith("mcp__"))); obj[k] = t.slice(0, 3).concat(t.length > 3 ? [`… ${t.length - 3} more`] : []); }
    else trimInit(obj[k]);
  }
  return obj;
}
function jsonl(src: string, dst: string, keep?: (o: any) => boolean): void {
  if (!existsSync(src)) { console.log(`skip ${src}`); return; }
  const out: string[] = [];
  for (const line of readFileSync(src, "utf8").split("\n")) {
    if (!line.trim() || dropLine(line)) continue;
    const raw = line.replace(/^(<- |-> )/, "");
    let o: any; try { o = JSON.parse(raw); } catch { continue; }
    if (keep && !keep(o)) continue;
    out.push((line.startsWith("-> ") ? "-> " : line.startsWith("<- ") ? "<- " : "") + scrub(JSON.stringify(trimInit(o))));
  }
  writeFileSync(join(FIX, dst), out.join("\n") + "\n");
  console.log(`${dst}: ${out.length} lines`);
}
function json(src: string, dst: string, pick?: (o: any) => unknown): void {
  if (!existsSync(src)) { console.log(`skip ${src}`); return; }
  const o = JSON.parse(readFileSync(src, "utf8"));
  writeFileSync(join(FIX, dst), scrub(JSON.stringify(pick ? pick(o) : o, null, 2)) + "\n");
  console.log(dst);
}
// Claude
jsonl(join(OUT_ROOT, "02-claude-session/sessionA.jsonl"), "claude-stream-three-turns.jsonl");
jsonl(join(OUT_ROOT, "02-claude-session/sessionB.jsonl"), "claude-stream-resumed-effort-low.jsonl");
jsonl(join(OUT_ROOT, "02d-claude-control/V1-prompt-tool-stdio.jsonl"), "claude-stream-control-request.jsonl", (o) => o.type === "control_request" || o.type === "result" || o.subtype === "init");
jsonl(join(OUT_ROOT, "02d-claude-control/V1-prompt-tool-stdio.jsonl.stdin"), "claude-stdin-user-and-control-response.jsonl");
jsonl(join(OUT_ROOT, "02c-claude-control/S2-manual-init.jsonl"), "claude-stream-initialize-response.jsonl", (o) => o.type === "control_response");
jsonl(join(OUT_ROOT, "02-claude-session/hook-input.jsonl"), "claude-hook-input-posttooluse.jsonl");
jsonl(join(OUT_ROOT, "03-claude-boundary/session.jsonl"), "claude-stream-boundary-broad-deny.jsonl");
jsonl(join(OUT_ROOT, "03b-claude-boundary-narrow/session.jsonl"), "claude-stream-boundary-narrow-deny.jsonl");
json(join(OUT_ROOT, "03b-claude-boundary-narrow/settings.json"), "claude-settings-boundary-narrow.json");
jsonl(join(OUT_ROOT, "02e-claude-hook-failure/hook-input.jsonl"), "claude-hook-input-posttoolusefailure.jsonl");
for (const v of ["V1-sandbox-only", "V2-allowWrite-common-dir-plus-denyWrite", "V3-denyWrite-only"]) jsonl(join(OUT_ROOT, `03c-claude-git-allowance/${v}.jsonl`), `claude-stream-git-allowance-${v}.jsonl`, (o) => o.type === "user" || o.type === "result" || o.subtype === "init");
for (const v of ["V4-main-deny-plus-allowWrite-git", "V5-main-deny-only"]) jsonl(join(OUT_ROOT, `03d-claude-main-deny-vs-git/${v}.jsonl`), `claude-stream-main-deny-${v}.jsonl`, (o) => o.type === "user" || o.type === "result" || o.subtype === "init");
jsonl(join(OUT_ROOT, "03e-claude-deny-glob/session.jsonl"), "claude-stream-deny-glob.jsonl", (o) => o.type === "user" || o.type === "result" || o.subtype === "init");
jsonl(join(OUT_ROOT, "03f-claude-boundary-final/session.jsonl"), "claude-stream-boundary-final.jsonl");
json(join(OUT_ROOT, "03f-claude-boundary-final/settings.json"), "claude-settings-boundary-final.json");
jsonl(join(OUT_ROOT, "06-kill-resume/claude2.jsonl"), "claude-stream-resume-after-sigkill.jsonl");
// Codex app-server
jsonl(join(OUT_ROOT, "04-appserver/server1.jsonl"), "codex-appserver-profile-four-turns.jsonl");
jsonl(join(OUT_ROOT, "04-appserver/server2.jsonl"), "codex-appserver-resume.jsonl");
jsonl(join(OUT_ROOT, "04-appserver/server3.jsonl"), "codex-appserver-legacy-fallback.jsonl");
jsonl(join(OUT_ROOT, "06-kill-resume/codex2.jsonl"), "codex-appserver-resume-after-sigkill.jsonl");
// Codex exec
for (const e of ["E1", "E2", "E3"]) json(join(OUT_ROOT, `05-codex-exec/summary.json`), `codex-exec-${e}-items.json`, (o) => o.findings[`${e}_items`] ?? o.findings[`${e}_command_items`] ?? o.findings[`${e}_turn_completed`]);
json(join(OUT_ROOT, "05-codex-exec/summary.json"), "codex-exec-events.json", (o) => ({ thread_started: o.findings.E1_thread_started, event_types: o.findings.E1_event_types, turn_completed: o.findings.E1_turn_completed }));
// Summaries of every probe
for (const d of ["01-sqlite/v22.23.2", "01-sqlite/v24.20.0", "01-sqlite/v25.1.0", "02-claude-session", "02b-claude-control", "02c-claude-control", "02d-claude-control", "02e-claude-hook-failure", "03-claude-boundary", "03b-claude-boundary-narrow", "03c-claude-git-allowance", "03d-claude-main-deny-vs-git", "03e-claude-deny-glob", "03f-claude-boundary-final", "04-appserver", "05-codex-exec", "06-kill-resume", "07-recovery"]) {
  const src = join(OUT_ROOT, d, "summary.json");
  if (!existsSync(src)) { console.log(`skip ${d}`); continue; }
  const o = JSON.parse(readFileSync(src, "utf8"));
  const slim = { probe: o.probe, finishedAt: o.finishedAt, wallMs: o.wallMs, passed: o.passed, failed: o.failed, checks: o.checks.map((c: any) => ({ name: c.name, ok: c.ok })), findings: o.findings };
  mkdirSync(join(FIX, "summaries"), { recursive: true });
  writeFileSync(join(FIX, "summaries", d.replace("/", "-") + ".json"), scrub(JSON.stringify(slim, null, 2)) + "\n");
}

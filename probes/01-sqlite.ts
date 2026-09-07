// Phase 0 item 1: node:sqlite durability under SIGKILL, WAL, FULL sync, busy_timeout,
// foreign keys, UNIQUE idempotency, AUTOINCREMENT monotonicity, read-only connections.
// Run with each Node binary under test: <node> probes/01-sqlite.ts
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Recorder } from "./lib/util.ts";

const PRAGMAS = "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;";

if (process.argv[2] === "--child") { child(process.argv[3]!); } else { await parent(); }

function child(dbPath: string): never {
  const db = new DatabaseSync(dbPath);
  db.exec(PRAGMAS);
  db.exec("CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, grp INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO entries(grp, seq, body) VALUES (?, ?, ?)");
  for (let g = 1; ; g++) {
    db.exec("BEGIN IMMEDIATE");
    for (let s = 1; s <= 3; s++) ins.run(g, s, "x".repeat(200));
    db.exec("COMMIT");
    writeSync(1, `committed ${g}\n`);
  }
}

async function parent(): Promise<void> {
  const rec = new Recorder(`01-sqlite/${process.version}`);
  const warnings: string[] = [];
  process.on("warning", (w) => warnings.push(`${w.name}: ${w.message}`));
  rec.note("node", process.version);
  rec.note("sqlite_version", (process.versions as Record<string, string>)["sqlite"] ?? null);

  const dbPath = join(rec.dir, "crash.sqlite3");
  const clean = () => { for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(dbPath + s)) rmSync(dbPath + s); };

  // 1. Crash injection: SIGKILL the writer at a random moment, then verify atomicity and durability.
  const iterations = 12;
  let groupsTotal = 0;
  for (let i = 0; i < iterations; i++) {
    clean();
    const c = spawn(process.execPath, [process.argv[1]!, "--child", dbPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    const firstCommit = new Promise<void>((r) => c.stdout.on("data", (d) => { out += d; if (out.includes("\n")) r(); }));
    c.stderr.on("data", (d) => { err += d; });
    await Promise.race([firstCommit, new Promise((r) => setTimeout(r, 5000))]);
    await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 120)));
    c.kill("SIGKILL");
    const exit = await new Promise<{ code: number | null; signal: string | null }>((r) => c.on("exit", (code, signal) => r({ code, signal })));
    const reported = out.trim().split("\n").filter(Boolean).map((l) => Number(l.split(" ")[1])).filter((n) => !Number.isNaN(n));
    const lastReported = reported.length ? reported[reported.length - 1]! : 0;
    const db = new DatabaseSync(dbPath);
    db.exec(PRAGMAS);
    const groups = db.prepare("SELECT grp, COUNT(*) AS n FROM entries GROUP BY grp ORDER BY grp").all() as { grp: number; n: number }[];
    db.close();
    const maxGroup = groups.length ? groups[groups.length - 1]!.grp : 0;
    const complete = groups.every((g) => g.n === 3);
    const contiguous = groups.every((g, idx) => g.grp === idx + 1);
    groupsTotal += maxGroup;
    rec.check(`crash ${i + 1}: every reported commit survives, every group atomic`,
      exit.signal === "SIGKILL" && complete && contiguous && maxGroup >= lastReported && maxGroup <= lastReported + 1,
      { reported: lastReported, found: maxGroup, complete, contiguous, exit, stderr: err.slice(0, 200) });
  }
  rec.note("crash_groups_committed_total", groupsTotal);
  clean();

  // 2. Pragmas and API surface.
  const db = new DatabaseSync(dbPath);
  db.exec(PRAGMAS);
  const jm = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
  rec.check("journal_mode is wal", Object.values(jm)[0] === "wal", jm);
  const sy = db.prepare("PRAGMA synchronous").get() as Record<string, unknown>;
  rec.check("synchronous is FULL (2)", Object.values(sy)[0] === 2, sy);
  const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
  rec.check("foreign_keys on", Object.values(fk)[0] === 1, fk);
  const bt = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
  rec.check("busy_timeout 5000", Object.values(bt)[0] === 5000, bt);
  db.exec(`CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL);
           CREATE TABLE messages(entry_id INTEGER PRIMARY KEY REFERENCES entries(id), author TEXT NOT NULL, operation_id TEXT, UNIQUE(author, operation_id));`);
  const insE = db.prepare("INSERT INTO entries(kind) VALUES (?)");
  const r1 = insE.run("message"); insE.run("message"); const r3 = insE.run("message");
  rec.check("run() returns lastInsertRowid and changes", r1.lastInsertRowid === 1 && r1.changes === 1, r1);
  db.prepare("DELETE FROM entries WHERE id = ?").run(r3.lastInsertRowid);
  const r4 = insE.run("event");
  rec.check("AUTOINCREMENT never reuses a deleted id", r4.lastInsertRowid === 4, r4);
  // foreign key enforcement
  let fkErr: any = null; try { db.prepare("INSERT INTO messages(entry_id, author, operation_id) VALUES (999, 'claude', 'op')").run(); } catch (e) { fkErr = e; }
  rec.check("foreign key violation throws", fkErr !== null, fkErr && { message: fkErr.message, errcode: fkErr.errcode, errstr: fkErr.errstr });
  // UNIQUE idempotency
  db.prepare("INSERT INTO messages(entry_id, author, operation_id) VALUES (1, 'claude', 'op-1')").run();
  let uq: any = null; try { db.prepare("INSERT INTO messages(entry_id, author, operation_id) VALUES (2, 'claude', 'op-1')").run(); } catch (e) { uq = e; }
  rec.check("UNIQUE(author, operation_id) violation throws with an errcode", uq !== null && typeof uq.errcode === "number", uq && { message: uq.message, errcode: uq.errcode, errstr: uq.errstr });
  // transaction rollback on error inside BEGIN
  db.exec("BEGIN");
  insE.run("message");
  try { db.prepare("INSERT INTO messages(entry_id, author, operation_id) VALUES (3, 'claude', 'op-1')").run(); } catch { db.exec("ROLLBACK"); }
  const cnt = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  rec.check("ROLLBACK undoes the whole transaction", cnt === 3, { n: cnt });
  rec.note("api", { isTransaction: typeof (db as any).isTransaction, isOpen: typeof (db as any).isOpen, hasIterate: typeof db.prepare("SELECT 1").iterate, hasBackup: typeof (DatabaseSync as any).prototype.backup, hasApplyChangeset: typeof (db as any).applyChangeset });

  // 3. Second connection: read-only reader sees committed rows while the writer holds a transaction (WAL).
  db.exec("BEGIN IMMEDIATE"); insE.run("message");
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  ro.exec("PRAGMA busy_timeout = 200");
  const roCount = (ro.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  rec.check("read-only connection reads committed state during a write transaction", roCount === 3, { n: roCount });
  let roWrite: any = null; try { ro.exec("INSERT INTO entries(kind) VALUES ('x')"); } catch (e) { roWrite = e; }
  rec.check("read-only connection refuses writes", roWrite !== null, roWrite && { message: roWrite.message });
  // second writer waits busy_timeout then fails
  const w2 = new DatabaseSync(dbPath); w2.exec("PRAGMA busy_timeout = 300");
  const t0 = Date.now(); let busy: any = null; try { w2.exec("BEGIN IMMEDIATE"); } catch (e) { busy = e; }
  const waited = Date.now() - t0;
  rec.check("second writer gets SQLITE_BUSY after busy_timeout", busy !== null && waited >= 250 && waited < 2000, busy && { message: busy.message, errcode: busy.errcode, waitedMs: waited });
  db.exec("COMMIT");
  ro.close(); w2.close();
  const chk = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  rec.note("wal_checkpoint", chk);
  db.close();
  rec.note("warnings", warnings);
  rec.finish();
}

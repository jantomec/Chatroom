#!/usr/bin/env node
// Launcher: the code runs through Node's type stripping, no build step (Node 22.18+).
import { main } from "../src/cli.ts";
main(process.argv.slice(2)).then((code) => { process.exit(code ?? 0); }, (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });

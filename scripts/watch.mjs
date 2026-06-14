#!/usr/bin/env node
/**
 * Dev watcher — the one command to run while developing (`npm run build:watch`). It fixes the
 * two gotchas of a bare `tsc -w`:
 *   1. `stock-glyphs.json` is GENERATED (not committed) → a fresh repo has none, so `tsc` would
 *      fail. We run `build:stock` FIRST.
 *   2. `tsc` copies `src/profiles/*.json` into `dist/profiles` VERBATIM (= bank references), so
 *      it clobbers the inlined glyphs every compile → the demo loses its icons. We RE-INLINE
 *      (`build-atlas --dist`) after EVERY tsc compile cycle, then bounce the Angular demo
 *      (its watch doesn't see `../dist`).
 * Bank edits (`svgs/**.svg`) are invisible to tsc, so we watch them too. Ctrl-C stops everything.
 */
import { spawn } from "node:child_process";
import { watch, utimesSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const run = (cmd, args) =>
  new Promise((res) => spawn(cmd, args, { cwd: ROOT, stdio: "inherit", shell: WIN }).on("exit", (c) => res(c ?? 0)));

const DEMO_ENTRY = join(ROOT, "demo", "src", "app", "showcase", "showcase.component.ts");
const bounceDemo = () => { if (existsSync(DEMO_ENTRY)) { try { const t = new Date(); utimesSync(DEMO_ENTRY, t, t); } catch { /* demo absent */ } } };

// Re-inline the dist profiles (debounced, non-reentrant) + bounce the demo.
let timer = null, busy = false, again = false;
async function reinline() {
  if (busy) { again = true; return; }
  busy = true;
  await run("node", ["scripts/build-atlas.mjs", "--dist"]);
  bounceDemo();
  busy = false;
  if (again) { again = false; schedule(); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(reinline, 250); };

// 1) stock glyphs must exist before tsc (fresh-repo fix).
console.log("▶ build:stock (stock-glyphs.json)…");
await run("node", ["scripts/build-atlas.mjs"]);

// 2) tsc -w; re-inline after each compile cycle (tsc re-copies the profile JSON verbatim).
console.log("▶ tsc -w + atlas watch — Ctrl-C to stop\n");
const tsc = spawn("npx", ["tsc", "-w", "-p", "tsconfig.json", "--preserveWatchOutput"], { cwd: ROOT, shell: WIN });
tsc.stdout.on("data", (d) => {
  const s = d.toString();
  process.stdout.write(s);
  if (/Watching for file changes|Found \d+ error/.test(s)) schedule();
});
tsc.stderr.on("data", (d) => process.stderr.write(d));

// 3) Bank edits are invisible to tsc → refresh stock (recompiles if a stock glyph changed) + re-inline.
watch(join(ROOT, "svgs"), { recursive: true }, async (_e, f) => {
  if (!f || !f.endsWith(".svg")) return;
  await run("node", ["scripts/build-atlas.mjs"]); // refresh stock-glyphs (write-if-changed → no tsc loop)
  schedule();
});

const stop = () => { try { tsc.kill(); } catch { /* already gone */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

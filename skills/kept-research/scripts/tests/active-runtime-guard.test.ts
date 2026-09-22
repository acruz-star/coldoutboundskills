#!/usr/bin/env tsx
/**
 * HARD ACCEPTANCE GUARD — offline, no network. Proves the active /kept-research runtime cannot call
 * Parallel FindAll. Run this after any change to kept-run.ts or the discovery scripts:
 *
 *     npx tsx skills/kept-research/scripts/tests/active-runtime-guard.test.ts
 *
 * legacy parallel-discover.ts is allowed to remain in the repo (audit-only) — it just must never be
 * reachable from kept-run.ts, and no findall endpoint may appear in the file kept-run.ts actually runs.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

let pass = 0, fail = 0;
function assert(cond: unknown, msg: string) { if (cond) { pass++; } else { fail++; console.error(`FAIL: ${msg}`); } }

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPTS = join(HERE, "..");
const keptRunPath = join(SCRIPTS, "kept-run.ts");
const activeDiscoverPath = join(SCRIPTS, "parallel-search-discover.ts");
const legacyDiscoverPath = join(SCRIPTS, "parallel-discover.ts");

assert(existsSync(keptRunPath), "kept-run.ts exists");
assert(existsSync(activeDiscoverPath), "parallel-search-discover.ts (the active discovery script) exists");
const keptRun = readFileSync(keptRunPath, "utf8");
const activeDiscover = readFileSync(activeDiscoverPath, "utf8");

// 1. kept-run.ts invokes the active Search discovery script.
assert(/["']parallel-search-discover\.ts["']/.test(keptRun), "kept-run.ts invokes parallel-search-discover.ts");

// 2. kept-run.ts does not invoke (or even mention) the legacy FindAll discovery script.
assert(!/parallel-discover\.ts/.test(keptRun), "kept-run.ts does not invoke or reference parallel-discover.ts");

// 3. the active discovery script contains no FindAll endpoint anywhere.
for (const banned of ["/v1beta/findall", "findall/runs", "FindAll create", "FindAll extend", "FindAll enrich"]) {
  assert(!activeDiscover.includes(banned), `parallel-search-discover.ts contains no "${banned}"`);
}
assert(!/\bFINDALL_EST\b/.test(activeDiscover), "parallel-search-discover.ts does not price itself with FINDALL_EST");

// 4. /v1/search IS the active discovery endpoint, and it is the only Parallel endpoint the active
//    script submits candidate-discovery work to (besides the OpenAI planner/extractor calls).
assert(activeDiscover.includes('"/v1/search"'), 'parallel-search-discover.ts submits to "/v1/search"');
const parallelPosts = [...activeDiscover.matchAll(/parallel\(\s*"POST"\s*,\s*("[^"]+"|`[^`]+`)/g)].map((m) => m[1]);
assert(parallelPosts.length > 0, "parallel-search-discover.ts makes at least one Parallel POST");
for (const p of parallelPosts) assert(p.includes("/v1/search"), `every Parallel POST in parallel-search-discover.ts targets /v1/search (found ${p})`);

// 5. kept-run.ts itself never submits to FindAll directly (it only ever shells out to the discovery script).
for (const banned of ["/v1beta/findall", "findall/runs"]) assert(!keptRun.includes(banned), `kept-run.ts contains no "${banned}"`);

// 6. legacy file, if present, is not imported by anything the active runtime loads (kept-run.ts or the
//    active discovery script) — it may only exist standalone in the repo for audit/manual use.
if (existsSync(legacyDiscoverPath)) {
  assert(!new RegExp(String.raw`from\s+["'].*parallel-discover["']`).test(keptRun), "kept-run.ts does not import parallel-discover.ts");
  assert(!new RegExp(String.raw`from\s+["'].*parallel-discover["']`).test(activeDiscover), "parallel-search-discover.ts does not import parallel-discover.ts");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

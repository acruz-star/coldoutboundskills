#!/usr/bin/env tsx
/**
 * compile-spec.ts — campaign-spec.json → the inputs Eric's list-builder already understands.
 *
 *     npx tsx compile-spec.ts --spec=<campaign-spec.json>
 *
 * Writes into <run-dir>/spec/ (deterministic — same spec in, same bytes out, so
 * run-lane's config-change guard only trips when the campaign really changed):
 *   campaign-spec.json   frozen copy of the spec this run was built from
 *   judge-spec.json      list-builder judge spec (icp / lean / qualifies / disqualifies)
 *   prompt.txt           assembled by list-builder's make-judge.ts (mandatory blocks intact)
 *   company-list.csv     company_list_csv minus exclude_domains (only when a list was given)
 *   lane.json            run-lane config — every company (Parallel feed + supplied list) via extra_candidates
 *
 * No network, no paid calls.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { parseArgs, readCsv, writeCsv, normDomain } from "../../list-expander/scripts/lib";
import { loadSpec, runDirFor, CampaignSpec } from "./kept-lib";

/** FRESH-COMPILE GUARD. The selected tab is the only source of truth for a new compile. An operator
 *  clarification, recipient fallback, threshold or rule given for an EARLIER run must never seed this one
 *  unless the operator gives or approves it again (then it is recorded as "RE-APPROVED <date>: …").
 *  Detection: a clarification string that appears verbatim in another run folder's spec is inherited.
 *  A same-tab historical run is NOT exempt — re-reading the same tab into a fresh compile must not let an
 *  old clarification back in silently. */
export function inheritedClarifications(spec: CampaignSpec, thisRunDir: string): { text: string; from: string }[] {
  const mine = (spec.source as any).operator_clarifications ?? [];
  if (!mine.length) return [];
  const lanes = join(homedir(), "output", "list-builder", "lanes");
  const hits: { text: string; from: string }[] = [];
  for (const d of existsSync(lanes) ? readdirSync(lanes) : []) {
    const other = join(lanes, d, "spec", "campaign-spec.json");
    if (resolve(join(lanes, d)) === resolve(thisRunDir) || !existsSync(other)) continue;
    let prev: any; try { prev = JSON.parse(readFileSync(other, "utf8")); } catch { continue; }
    for (const c of prev.source?.operator_clarifications ?? []) for (const m of mine) if (!/^RE-APPROVED \d{4}-\d{2}-\d{2}:/.test(m) && m.trim() === String(c).trim()) hits.push({ text: m, from: d });
  }
  return hits;
}

/** Byte-identical spec files — the only thing that makes a compile an explicit RESUME of the lane's frozen
 *  spec rather than a fresh compile. A freshly re-read Google Doc tab always carries new provenance
 *  (source.read_at at minimum), so it can never collide with this even when the tab text is unchanged. */
function sameBytes(a: string, b: string): boolean {
  try { return Buffer.compare(readFileSync(a), readFileSync(b)) === 0; } catch { return false; }
}

export function compile(specPath: string): { runDir: string; laneJson: string; specCopy: string; promptPath: string; parallelCandidates: string } {
  const spec = loadSpec(specPath);
  const runDir = runDirFor(spec);
  const specDir = join(runDir, "spec");
  const frozenSpec = join(specDir, "campaign-spec.json");

  // RESUME vs FRESH. runDirFor() is keyed only by client_slug + campaign_slug, so the same lane path is
  // computed whether this is a genuine resume or a brand-new invocation for the same campaign (same tab,
  // even the identical tab_sha256). Only an explicit resume of the EXACT frozen spec already belonging to
  // this lane may reuse its state.json, spend ledger, Parallel run ids and prior artifacts. Anything else —
  // including an unchanged tab re-compiled fresh — must start clean.
  const isResume = existsSync(frozenSpec) && (resolve(specPath) === resolve(frozenSpec) || sameBytes(specPath, frozenSpec));
  if (existsSync(runDir) && !isResume) {
    const lanesRoot = resolve(runDir, "..");
    const archived = join(lanesRoot, `${spec.client_slug}-${spec.campaign_slug}.archived-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(runDir, archived);
    console.log(`fresh compile: previous lane archived for audit (not reused): ${archived}`);
  }

  const inherited = inheritedClarifications(spec, runDir);
  if (inherited.length) {
    console.error("STOP — this spec carries operator clarifications inherited from a previous run, not given for this one:\n" +
      inherited.map((h) => `  - "${h.text.slice(0, 120)}"  (from run ${h.from})`).join("\n") +
      "\nA fresh compile uses only the selected campaign tab. Remove them, or have the operator approve them again for this run and record each as \"RE-APPROVED <YYYY-MM-DD>: <text>\".");
    process.exit(2);
  }
  mkdirSync(specDir, { recursive: true });
  const specCopy = join(specDir, "campaign-spec.json");
  if (resolve(specPath) !== resolve(specCopy)) copyFileSync(specPath, specCopy);

  // 1. judge — Eric's judge spec shape, assembled by Eric's make-judge.ts (never hand-written)
  const judgeSpec = {
    icp: spec.companies.icp,
    lean: spec.companies.lean ?? "lean YES when the identity language fits",
    thin_evidence_lean: spec.companies.thin_evidence_lean ?? "YES",
    qualifies: spec.companies.qualifies,
    disqualifies: spec.companies.disqualifies,
  };
  const judgeSpecPath = join(specDir, "judge-spec.json");
  writeFileSync(judgeSpecPath, JSON.stringify(judgeSpec, null, 2) + "\n");
  const here = resolve(fileURLToPath(import.meta.url), "..");
  const makeJudge = resolve(here, "../../list-builder/scripts/make-judge.ts");
  const promptPath = join(specDir, "prompt.txt");
  const mj = spawnSync("npx", ["tsx", makeJudge, `--spec=${judgeSpecPath}`, `--out=${promptPath}`], { encoding: "utf8" });
  if (mj.status !== 0 || !existsSync(promptPath)) { console.error(`make-judge failed:\n${mj.stdout}\n${mj.stderr}`); process.exit(1); }

  // 2. a supplied company list enters through Eric's extra_candidates door
  const exclude = new Set((spec.companies.exclude_domains ?? []).map(normDomain));
  const extra: string[] = [];
  if (spec.companies.company_list_csv) {
    const rows = readCsv(spec.companies.company_list_csv).filter((r) => !exclude.has(normDomain(r.domain ?? r.website ?? "")));
    const listPath = join(specDir, "company-list.csv");
    writeCsv(listPath, rows.map((r) => ({ ...r, source: r.source || "company_list" })));
    extra.push(listPath);
  }

  // 3. lane.json — Eric's lane judges EVERY company. Parallel's discoveries and any supplied list both enter
  //    through his `extra_candidates` door; seeds through his `seeds`. Native fields only.
  const parallelCandidates = join(specDir, "parallel-candidates.csv");
  const lane = {
    name: spec.campaign_slug,
    client_slug: spec.client_slug,
    prompt: promptPath,
    emp_min: 1, emp_max: 100000,
    seeds: (spec.companies.seeds ?? []).map(normDomain).filter((d) => d && !exclude.has(d)),
    sources: { lookalikes: false },
    extra_candidates: [parallelCandidates, ...extra],
    thresholds: { min_final_rows: 1, min_verified_pct: 0.2, max_reject_rate: 0.998 },
    stall_min: 30,
  };
  const laneJson = join(specDir, "lane.json");
  const body = JSON.stringify(lane, null, 2) + "\n";
  if (!existsSync(laneJson) || readFileSync(laneJson, "utf8") !== body) writeFileSync(laneJson, body);
  return { runDir, laneJson, specCopy, promptPath, parallelCandidates };
}

if (process.argv[1]?.split("/").pop() === "compile-spec.ts") {
  const args = parseArgs();
  if (!args.spec) { console.error("Usage: npx tsx compile-spec.ts --spec=<campaign-spec.json>"); process.exit(1); }
  const r = compile(String(args.spec));
  console.log(`compiled → ${r.laneJson}\nrun dir  → ${r.runDir}`);
}

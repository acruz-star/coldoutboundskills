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
 *  Detection: a clarification string that appears verbatim in another run folder's spec is inherited. */
export function inheritedClarifications(spec: CampaignSpec, thisRunDir: string): { text: string; from: string }[] {
  const mine = (spec.source as any).operator_clarifications ?? [];
  if (!mine.length) return [];
  const lanes = join(homedir(), "output", "list-builder", "lanes");
  const hits: { text: string; from: string }[] = [];
  for (const d of existsSync(lanes) ? readdirSync(lanes) : []) {
    const other = join(lanes, d, "spec", "campaign-spec.json");
    if (resolve(join(lanes, d)) === resolve(thisRunDir) || !existsSync(other)) continue;
    let prev: any; try { prev = JSON.parse(readFileSync(other, "utf8")); } catch { continue; }
    if (prev.source?.tab_sha256 === spec.source.tab_sha256) continue; // same tab, same campaign: a resume, not a fresh compile
    for (const c of prev.source?.operator_clarifications ?? []) for (const m of mine) if (!/^RE-APPROVED \d{4}-\d{2}-\d{2}:/.test(m) && m.trim() === String(c).trim()) hits.push({ text: m, from: d });
  }
  return hits;
}

export function compile(specPath: string): { runDir: string; laneJson: string; specCopy: string; promptPath: string; parallelCandidates: string } {
  const spec = loadSpec(specPath);
  const runDir = runDirFor(spec);
  const specDir = join(runDir, "spec");
  const inherited = inheritedClarifications(spec, runDir);
  if (inherited.length) {
    console.error("STOP — this spec carries operator clarifications inherited from a previous run, not given for this one:\n" +
      inherited.map((h) => `  - "${h.text.slice(0, 120)}"  (from run ${h.from})`).join("\n") +
      "\nA fresh compile uses only the selected campaign tab. Remove them, or have the operator approve them again for this run and record each as \"RE-APPROVED <YYYY-MM-DD>: <text>\".");
    process.exit(2);
  }
  // A spec dir left by a DIFFERENT tab under the same campaign slug is a previous campaign: keep it for audit, never reuse it.
  const prevSpec = join(specDir, "campaign-spec.json");
  if (existsSync(prevSpec) && resolve(specPath) !== resolve(prevSpec)) {
    try { const prev = JSON.parse(readFileSync(prevSpec, "utf8")); if (prev.source?.tab_sha256 !== spec.source.tab_sha256) { const aside = join(runDir, `spec-prev-${String(prev.source?.tab_sha256 ?? "unknown").slice(0, 12)}`); renameSync(specDir, aside); console.log(`previous spec for a different tab set aside for audit (not reused): ${aside}`); } } catch { /* unreadable: leave it */ }
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

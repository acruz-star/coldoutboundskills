#!/usr/bin/env tsx
/**
 * kept-run.ts — the ONE command behind /kept-research. Same contract as Eric's
 * run-lane.ts: re-run the SAME command to resume after any failure.
 *
 *     npx tsx kept-run.ts --spec=<campaign-spec.json>          # runs the whole fixed flow, start to finish
 *     npx tsx kept-run.ts --spec=<campaign-spec.json> --plan   # optional: print the plan + cost ceiling, spend nothing
 *     (debug: --until=companies stops after Eric's lane, before signal research)
 *
 * GLOBAL TARGET (every campaign): find 50 qualified, evidence-backed, unique leads; inspect up to
 * 1,000 unique companies to get there. The flow below repeats in ROUNDS — each round asks the adaptive
 * Parallel Search research loop for more unique companies and only new ones are judged/researched —
 * until the target is met, the company ceiling is reached, research is genuinely exhausted, or the
 * spend cap leaves no room for another round.
 *
 * It runs without approval prompts. It STOPS only when:
 *   - required campaign information is missing (spec fails validation)            exit 2
 *   - the per-run spend cap would be exceeded (checked BEFORE anything is bought) exit 5
 *   - a required key is absent (exit 2), or a paid submission is ambiguous and
 *     retrying could pay twice (exit 4)
 *
 * Fixed sequence — the spec (from the Google Doc tab) only changes WHAT is looked for:
 *
 *   COMPILE    spec → judge-spec.json → Eric's make-judge.ts → prompt.txt; lane.json (native fields only)
 *   DISCOVER   Adaptive Parallel SEARCH research on the campaign SIGNAL only (broad: no ICP / geography /
 *              size filter). A lightweight planner (gpt-5-nano) changes query wording and source focus
 *              from observed yield; Search results are extracted into candidates + cited evidence, and an
 *              unresolved company's official domain is found with a focused follow-up search.
 *   +EVIDENCE  The same discovery pass returns the campaign's supporting facts, the canonical company
 *              domain, company identity and — only when the campaign states an ICP — the cited facts that
 *              bear on it. Search evidence can fully satisfy a fact; no redundant second proof is bought.
 *   ERIC LANE  EVERY company, however discovered: his MERGE → SCORE (judge reads Parallel's cited evidence as the
 *              description) → REJECT_AUDIT, then VERIFY (passes on sufficient cited evidence; otherwise his live
 *              website check) → FINALIZE → PUSH → REPORT. Nothing is bypassed.
 *   GAPS       targeted Parallel research only for supporting facts still missing / contradictory
 *   RECIPIENT  the campaign's recipient logic (Title(s) / named person) → Quick Enrich → Eric's contacts-merge + contacts.ts
 *   GATE       deterministic QUALIFIED / REVIEW / REJECT (+ dedupe) → output/*.csv, evidence, summary, scorecard
 *   (then, by the skill procedure: evidence read → instantly-upload.ts → Instantly LEAD LIST; never a campaign)
 *
 * How Eric's orchestrator runs without Prospeo and without being edited: his stages are
 * resumable from state.json, and a stage already marked done/skipped is not re-run. This
 * wrapper writes that state file the way a finished stage would: PRECHECK/PULL "done"
 * (this wrapper did the precheck; the pull is the Parallel feed, with an empty pull-all.csv),
 * and his three Prospeo-only stages — LOOKALIKES, ENRICH, COUNT — "skipped".
 *
 * It never writes copy and never touches a sending platform.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { loadEnv, parseArgs, readCsv } from "../../list-expander/scripts/lib";
import { loadSpec, buildResearchSet, icpIsNeutral, spentSoFar, readJsonl, SEARCH_EST, SEARCH_EST_COMPANIES_PER_JOB, TASK_EST_PER_RUN, FIRST_BATCH_COMPANIES, planNextRound } from "./kept-lib";
import { compile } from "./compile-spec";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const LB = resolve(HERE, "../../list-builder/scripts");
const sha16 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16); // same hash run-lane uses for config_sha

function tsx(script: string, argv: string[]): number {
  return spawnSync("npx", ["tsx", script, ...argv], { stdio: "inherit", env: process.env, timeout: 12 * 3600_000 }).status ?? 1;
}

/** The ICP judge is ALWAYS OpenAI gpt-5-nano — the model Eric's list-builder is built and
 *  tuned around. It is pinned here so a stray OPENAI_ICP_MODEL / --model in a shell or .env can
 *  never silently change which model qualified a list. There is no fallback provider. */
const JUDGE_MODEL = "gpt-5-nano";
function configureJudge(): string {
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY_NANO) return "";
  if (process.env.OPENAI_ICP_MODEL && process.env.OPENAI_ICP_MODEL !== JUDGE_MODEL) console.log(`note: OPENAI_ICP_MODEL=${process.env.OPENAI_ICP_MODEL} ignored — kept-research pins the judge to ${JUDGE_MODEL}`);
  process.env.OPENAI_ICP_MODEL = JUDGE_MODEL; // read by score-batch.ts, reject-audit.ts and verify-website.ts
  return `OpenAI ${JUDGE_MODEL} (pinned)`;
}

/** Proof, not intent: Eric's scripts log the model they actually used ("Scoring N companies
 *  with <model>"). Read what THIS run appended to child.log and refuse anything else. */
function assertJudgeModel(runDir: string, logOffset: number): void {
  const p = join(runDir, "child.log");
  if (!existsSync(p)) return;
  const used = [...readFileSync(p, "utf8").slice(logOffset).matchAll(/Scoring \d+ companies with (\S+)/g)].map((m) => m[1]);
  const wrong = used.filter((m) => m !== JUDGE_MODEL);
  if (wrong.length) { console.error(`\nSTOP — the ICP judge ran on ${[...new Set(wrong)].join(", ")}, not ${JUDGE_MODEL}. Results from this run are not valid; find what overrode the model and re-run.`); process.exit(1); }
  if (used.length) console.log(`judge model verified from Eric's log: ${JUDGE_MODEL}`);
}

/** Unique companies Parallel Search discovery has found so far this run (cumulative across rounds). */
function discoveryTotal(runDir: string): number {
  const p = join(runDir, "discovery-status.json");
  if (!existsSync(p)) return 0;
  try { return Number(JSON.parse(readFileSync(p, "utf8")).unique_company_candidates ?? 0); } catch { return 0; }
}

/** EVIDENCE-AWARE VALIDATION. For companies HIS judge qualified whose Parallel evidence meets the evidence
 *  standard (canonical domain stated + cited identity + cited ICP facts when the campaign states an ICP), record the validation in
 *  his verified stream — the file his VERIFY stage resumes from — so that stage passes on evidence instead of
 *  re-fetching. Every other qualified company is left for his live website check. Rows carry
 *  website_status="parallel_evidence" so the basis of each pass is auditable. */
const VERIFIED_COLS = ["domain", "name", "industry", "state", "source_filters", "confidence", "reason", "website_status", "final_verdict", "live_reason"];
export function recordEvidenceValidations(runDir: string): { byEvidence: number; toLiveCheck: number } {
  const stream = join(runDir, "pull-batch1-scored.csv.stream.csv");
  const out = join(runDir, "verified.stream.csv");
  const evid = new Map((existsSync(join(runDir, "parallel-evidence.csv")) ? readCsv(join(runDir, "parallel-evidence.csv")) : []).map((r) => [r.domain, r]));
  const done = new Set(existsSync(out) ? readCsv(out).map((r) => r.domain) : []);
  if (!existsSync(out)) writeFileSync(out, VERIFIED_COLS.join(",") + "\n");
  const esc = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  let byEvidence = 0, toLiveCheck = 0;
  const seen = new Set<string>();
  for (const r of existsSync(stream) ? readCsv(stream) : []) {
    if (r.qualified !== "true" || !r.domain || seen.has(r.domain)) continue;
    seen.add(r.domain);
    if (done.has(r.domain)) continue;
    const e = evid.get(r.domain);
    if (e?.sufficient !== "true") { toLiveCheck++; continue; }
    const row: Record<string, string> = { ...r, website_status: "parallel_evidence", final_verdict: "verified", live_reason: `validated on Parallel evidence: ${e.why}` };
    appendFileSync(out, VERIFIED_COLS.map((c) => esc(row[c])).join(",") + "\n");
    byEvidence++;
  }
  return { byEvidence, toLiveCheck };
}

const LANE_STAGES = ["PRECHECK", "LOOKALIKES", "PULL", "MERGE", "SCORE", "REJECT_AUDIT", "VERIFY", "ENRICH", "FINALIZE", "COUNT", "PUSH", "REPORT"];
const JUDGED_ARTIFACTS = ["candidates.csv", "skipped-already-judged.csv", "pull-batch1-scored.csv", "pull-batch1-scored.csv.stream.csv", "reject-audit.csv", "verified.stream.csv", "lane-final.csv", "lane-removed-band-geo.csv", "judged.wal.ndjson", "judged.wal.synced"];

/** Write run-lane's state.json so his unmodified orchestrator picks up at MERGE. */
export function seedLaneState(runDir: string, laneJson: string, promptPath: string, feedPath: string, feedRows: number, phase: "judge" | "validate"): void {
  const statePath = join(runDir, "state.json");
  const configSha = sha16(readFileSync(laneJson, "utf8"));
  const promptSha = sha16(readFileSync(promptPath));
  const feedSha = sha16(readFileSync(feedPath));
  let state: any = null;
  if (existsSync(statePath)) { try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { console.error(`state.json is corrupt (${statePath}) — move it aside and re-run (Eric's recovery rule).`); process.exit(2); } }
  state ??= { config_sha: configSha, run_id: `run_${Date.now().toString(36)}`, created: new Date().toISOString(), stages: {} };
  const invalidateFrom = (first: string) => { for (const s of LANE_STAGES.slice(LANE_STAGES.indexOf(first))) state.stages[s] = { status: "pending" }; };

  // Eric's score-batch exits 0 and SCORE is marked done even when rows failed technically
  // (API error / timeout), and --resume then skips those domains forever. A technical failure
  // is not a verdict: set the judged artifacts aside and judge again.
  const stream = join(runDir, "pull-batch1-scored.csv.stream.csv");
  const techFailed = existsSync(stream) ? readCsv(stream).filter((r) => r.qualified !== "true" && r.qualified !== "false").length : 0;
  if (techFailed) {
    const aside = join(runDir, `prev-judge-techfail-${Date.now().toString(36)}`);
    mkdirSync(aside, { recursive: true });
    for (const f of JUDGED_ARTIFACTS) if (existsSync(join(runDir, f))) renameSync(join(runDir, f), join(aside, f));
    console.log(`${techFailed} companies were never actually judged last run (technical errors) — set aside to ${aside}; judging again.`);
    invalidateFrom("MERGE");
  } else if (state.kept_prompt_sha && state.kept_prompt_sha !== promptSha) {
    // The ICP judge changed. Verdicts made under the old prompt must not survive (score-batch
    // resumes from its stream), so set them aside — never deleted — and judge again.
    const aside = join(runDir, `prev-judge-${state.kept_prompt_sha}`);
    mkdirSync(aside, { recursive: true });
    for (const f of JUDGED_ARTIFACTS) if (existsSync(join(runDir, f))) renameSync(join(runDir, f), join(aside, f));
    console.log(`ICP judge changed since the last run — previous verdicts moved to ${aside}; re-judging every candidate.`);
    invalidateFrom("MERGE");
  } else if (state.config_sha !== configSha || (state.kept_feed_sha && state.kept_feed_sha !== feedSha)) {
    console.log("candidate feed or lane config changed — re-merging (already-scored companies are kept, new ones get judged).");
    invalidateFrom("MERGE");
  }
  for (const s of LANE_STAGES) state.stages[s] ??= { status: "pending" };
  Object.assign(state, { config_sha: configSha, kept_prompt_sha: promptSha, kept_feed_sha: feedSha });
  state.stages.PRECHECK = { status: "done", note: "kept-research precheck (Parallel + Quick Enrich + judge keys, prompt present)" };
  state.stages.LOOKALIKES = { status: "skipped", note: "Prospeo/Exa lookalikes unavailable; discovery is adaptive Parallel Search research" };
  state.stages.PULL = { status: "done", out_rows: feedRows, note: `Parallel-powered discovery (${feedRows} companies) delivered through extra_candidates; no Prospeo pull` };
  state.stages.ENRICH = { status: "skipped", note: "Prospeo company enrichment unavailable; company context + canonical domain are supplied by Parallel" };
  state.stages.COUNT = { status: "skipped", note: "Prospeo contact count unavailable; contacts are resolved by Quick Enrich in the recipient stage" };
  // Two passes of HIS orchestrator, same state file:
  //   judge     MERGE → SCORE → REJECT_AUDIT run; VERIFY / FINALIZE / PUSH are held
  //   validate  the wrapper has recorded evidence-based validations for companies his judge qualified;
  //             VERIFY now runs his live website check for every company still unvalidated, then FINALIZE / PUSH / REPORT
  for (const st of ["VERIFY", "FINALIZE", "PUSH"]) state.stages[st] = phase === "judge" ? { status: "skipped", note: "held until the ICP judge has run (evidence-aware validation happens in pass 2)" } : { status: "pending" };
  const pullAll = join(runDir, "pull-all.csv"); // MERGE reads it unconditionally; the real candidates arrive through extra_candidates
  if (!existsSync(pullAll)) writeFileSync(pullAll, "");
  const tmp = `${statePath}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
}

/** The completion report. instantly-upload.ts calls this again after uploading so the upload count is final. */
export function writeRunReport(runDir: string, spec: any, stopReason?: string): void {
  const rd = (f: string) => (existsSync(join(runDir, f)) ? readCsv(join(runDir, f)) : []);
  const prevPath = join(runDir, "output", "run-report.json");
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : {};
  const status = existsSync(join(runDir, "discovery-status.json")) ? JSON.parse(readFileSync(join(runDir, "discovery-status.json"), "utf8")) : {};
  const q = rd("output/qualified.csv"), rv = rd("output/review.csv"), rj = rd("output/rejected.csv"), up = rd("output/instantly-upload.csv");
  const ledger = readJsonl(join(runDir, "spend-ledger.jsonl"));
  const T = spec.targets; const sp = spentSoFar(runDir);
  const dupEmail = rv.filter((r) => String(r.reason).startsWith("duplicate lead")).length;
  const r = {
    campaign: `${spec.client_slug}/${spec.campaign_slug}`,
    unique_companies_inspected: new Set(rd("pull-batch1-scored.csv.stream.csv").map((x) => x.domain)).size,
    qualified: q.length, review: rv.length, rejected: rj.length,
    duplicates_removed: { company_domains_at_discovery: Number(status.duplicates_removed ?? 0), recipient_emails: dupEmail, already_in_instantly_workspace: up.filter((x) => x.action === "skipped_already_in_workspace").length },
    parallel_spend_usd_estimate: Number(sp.usd.toFixed(2)), parallel_cap_usd: spec.budget.max_usd,
    quick_enrich_lookups: { paid_this_run: ledger.filter((e: any) => e.provider === "quickenrich" && e.kind === "employee-search").length, reused_from_cache: readJsonl(join(runDir, "emails.jsonl")).filter((e: any) => e.reused).length },
    verified_emails: readJsonl(join(runDir, "recipients.jsonl")).filter((x: any) => x.email_status === "verified").length,
    instantly_uploads: !up.length ? "pending (upload step not run yet)" : up.some((x) => x.action === "would_upload") ? `0 — DRY RUN (${up.filter((x) => x.action === "would_upload").length} would upload)` : up.filter((x) => x.action === "uploaded").length,
    minimum_success_threshold: T.qualified_leads, below_minimum_success_threshold: q.length < T.qualified_leads,
    stop_reason: stopReason ?? prev.stop_reason ?? "unknown",
  };
  mkdirSync(join(runDir, "output"), { recursive: true });
  writeFileSync(prevPath, JSON.stringify(r, null, 2));
  const why = !r.below_minimum_success_threshold ? "" : `\n- **BELOW THE MINIMUM SUCCESS THRESHOLD** (${q.length} of ${T.qualified_leads}). Why: the run ended because — ${r.stop_reason}. Of ${r.unique_companies_inspected} companies inspected, ${rj.length} were rejected and ${rv.length} are in REVIEW (one unresolved fact each — the fastest route to more leads is resolving those). No qualification standard was lowered to reach the threshold.`;
  const block = ["", "## Run report", `- Unique companies inspected: ${r.unique_companies_inspected} (ceiling ${T.max_companies})`, `- QUALIFIED: ${r.qualified} · REVIEW: ${r.review} · REJECTED: ${r.rejected}`,
    `- Duplicates removed: ${r.duplicates_removed.company_domains_at_discovery} company domains · ${r.duplicates_removed.recipient_emails} recipient emails · ${r.duplicates_removed.already_in_instantly_workspace} already in the Instantly workspace`,
    `- Parallel spend: ~$${r.parallel_spend_usd_estimate} of $${r.parallel_cap_usd} (estimate)`, `- Quick Enrich lookups: ${r.quick_enrich_lookups.paid_this_run} paid · ${r.quick_enrich_lookups.reused_from_cache} reused from cache`,
    `- Verified emails: ${r.verified_emails}`, `- Instantly uploads: ${r.instantly_uploads}`, `- Stop reason: ${r.stop_reason}${why}`, ""].join("\n");
  const sumPath = join(runDir, "output", "summary.md");
  if (existsSync(sumPath)) writeFileSync(sumPath, readFileSync(sumPath, "utf8").replace(/\n## Run (target|report)[\s\S]*?(?=\n## |$)/g, "\n").replace(/\n+$/, "\n") + block);
  console.log(block);
}

function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !existsSync(String(args.spec))) { console.error("Usage: npx tsx kept-run.ts --spec=<campaign-spec.json> [--plan]"); process.exit(1); }
  const spec = loadSpec(String(args.spec)); // exits 2 listing every missing/invalid campaign requirement
  const { runDir, laneJson, specCopy, promptPath, parallelCandidates } = compile(String(args.spec));
  const judge = configureJudge();

  // ---- plan + spend-cap preflight (free) ----
  const d = spec.companies.discovery;
  const proc = spec.signals.processor ?? "core";
  const listN = (spec.companies.company_list_csv ? readCsv(spec.companies.company_list_csv).length : 0) + (spec.companies.seeds ?? []).length;
  const T = spec.targets;
  // Search API has no fixed run cost (unlike FindAll): cost scales with search jobs run. Estimate a search
  // job's average yield (SEARCH_EST_COMPANIES_PER_JOB) plus a 30% allowance for domain-resolution passes.
  const perCompanySearch = d ? (SEARCH_EST.fast / SEARCH_EST_COMPANIES_PER_JOB) * 1.3 : 0;
  const perCompany = perCompanySearch + (TASK_EST_PER_RUN[proc] ?? 0.1); // discover + research one more company
  const bought = discoveryTotal(runDir);
  const firstRound = bought || Math.min(d?.match_limit ?? FIRST_BATCH_COMPANIES, T.max_companies);
  const spent = spentSoFar(runDir);
  const estFirst = bought ? 0 : (d ? perCompanySearch * firstRound : 0) + (TASK_EST_PER_RUN[proc] ?? 0.1) * (firstRound + listN);
  const affordable = Math.max(0, Math.floor((spec.budget.max_usd - spent.usd) / perCompany));
  const missing = [
    !(process.env.PARALLEL_API_KEY || process.env.PARALLEL_AI_API_KEY) && "PARALLEL_API_KEY",
    !process.env.QUICKENRICH_API_KEY && "QUICKENRICH_API_KEY",
    !judge && "OPENAI_API_KEY (Eric's ICP judge, gpt-5-nano)",
  ].filter(Boolean);
  console.log([
    `\n# kept-research — ${spec.client_slug}/${spec.campaign_slug}`,
    `source      : "${spec.source.doc_title}" → tab "${spec.source.tab}" (sha ${spec.source.tab_sha256.slice(0, 12)})`,
    `run dir     : ${runDir}`,
    `volume      : inspect up to ${T.max_companies} unique companies and KEEP EVERY lead that qualifies. ${T.qualified_leads} qualified = minimum success threshold, NOT a stop (${T.source})`,
    `discovery   : ${d ? `Adaptive Parallel SEARCH research on Signal/s ONLY, broad: ${d.match_conditions.map((c) => c.name).join(", ")}; no ICP/geo/size filter. A gpt-5-nano planner chooses query wording + source focus (open web by default) from observed yield, never a fixed source. Search evidence + a focused domain-resolution pass establish company identity, canonical domain${icpIsNeutral(spec) ? " (no ICP facts: the campaign sets no company restriction)" : " + cited icp_evidence"}; gap research (${proc}) covers only what's left. ${bought ? `${bought} unique companies already found, resuming` : `first round target ${firstRound}`}; later rounds keep researching with new tactics` : "none (company list / seeds only — single pass)"}${listN ? ` + ${listN} listed/seed companies` : ""}`,
    `eric's lane : EVERY company runs his MERGE → SCORE (ICP judge, ${judge || "NOT CONFIGURED"}) → REJECT_AUDIT → VERIFY → FINALIZE → REPORT. VERIFY is evidence-aware: passes on sufficient cited Parallel evidence, else his live website check`,
    `gaps        : extra Parallel research ONLY for required facts still missing / contradictory (asked once, missing fields only)`,
    `people      : Quick Enrich — ${spec.people.recipient.from_field ? `person named in signals.${spec.people.recipient.from_field}` : `titles [${spec.people.recipient.titles.join(", ")}]`}; only after the research rules pass; Employee Search directly when the person is named (1 credit), Contact Finder first only for title-only`,
    `rules       : ${spec.rules.length} rules, REVIEW allows ${spec.review_policy?.max_unresolved ?? 1} unresolved; ${spec.variables.length} variables`,
    `spend cap   : $${spec.budget.max_usd} Parallel (${spec.budget.source}); Quick Enrich unlimited. Spent so far: ~$${spent.usd.toFixed(2)}, ${spent.credits} credits.`,
    `              ≈ $${perCompany.toFixed(3)} per company inspected → the cap affords about ${affordable} more companies. The run ends only at the ${T.max_companies}-company ceiling, exhausted discovery, the Parallel cap, or a hard safety stop.`,
    `              (price table in kept-lib.ts — estimates, not invoices)`,
  ].join("\n"));
  if (args.plan) { console.log("\n--plan: nothing was spent.\n"); return; }
  if (missing.length) { console.error(`\nSTOP — missing keys: ${missing.join(", ")}. Add them to ${resolve(HERE, "../../../.env")} and re-run.`); process.exit(2); }
  if (spent.usd + estFirst > spec.budget.max_usd) {
    console.error(`\nSTOP — spend cap would be exceeded by the first round alone: ≈ $${(spent.usd + estFirst).toFixed(2)} vs cap $${spec.budget.max_usd}. Nothing was bought.\n` +
      `Lower the first-round size / generator / signals.processor, or set a higher budget in the campaign tab, then re-run.`);
    process.exit(5);
  }
  process.env.KEPT_SPEND_APPROVED = "1"; // preflight passed; every paid step still re-checks the ledger against the cap before submitting

  // ---- execute in ROUNDS until the target is met. Same fixed order every round; every step resumable. ----
  let total = firstRound, stopReason = "";
  for (let round = 1; ; round++) {
    console.log(`\n══ ROUND ${round} — discovery target ${d ? total : 0} ══\n▶ DISCOVER (adaptive Parallel Search research on Signal/s → query/source tactics chosen from yield → unique company candidates → cited Search evidence)`);
    const disc = tsx(join(HERE, "parallel-search-discover.ts"), [`--spec=${specCopy}`, `--run-dir=${runDir}`, `--total=${total}`, ...(args["confirm-not-submitted"] ? ["--confirm-not-submitted"] : [])]);
    if (disc === 5 && round > 1) { stopReason = "spend cap: the next discovery round would exceed it"; break; }
    if (disc !== 0) { console.error(`\nDISCOVER stopped (exit ${disc}). Read the message above; re-running the same command resumes without paying twice.`); process.exit(disc); }
    const discovered = readCsv(parallelCandidates).length;
    if (discovered + listN === 0) { console.error("\nSTOP — discovery matched 0 companies with a usable domain and the tab gives no company list or seeds. Nothing to research."); process.exit(1); }

    // ERIC'S LANE, pass 1 — his MERGE, ICP judge (SCORE) and REJECT_AUDIT on every company. His judge reads
    // Parallel's cited company evidence (the feed's description), so no homepage scrape is needed for those.
    console.log("\n▶ ERIC LANE 1/2 — MERGE → SCORE (ICP judge) → REJECT_AUDIT");
    seedLaneState(runDir, laneJson, promptPath, parallelCandidates, discovered + listN, "judge");
    const childLog = join(runDir, "child.log");
    const logOffset = existsSync(childLog) ? readFileSync(childLog, "utf8").length : 0;
    tsx(join(LB, "run-lane.ts"), [`--config=${laneJson}`, `--run-dir=${runDir}`]); // exits NOT READY by design: VERIFY is held
    assertJudgeModel(runDir, logOffset);
    const judgedRows = existsSync(join(runDir, "pull-batch1-scored.csv.stream.csv")) ? readCsv(join(runDir, "pull-batch1-scored.csv.stream.csv")) : [];
    const unjudged = judgedRows.filter((r) => r.qualified !== "true" && r.qualified !== "false");
    if (unjudged.length) { console.error(`\nSTOP — the ICP judge failed technically on ${unjudged.length}/${judgedRows.length} companies (not a verdict). First error: ${unjudged[0].reason}\nFix the cause and re-run this same command; those companies will be judged again.`); process.exit(1); }
    let laneState = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const bad1 = ["MERGE", "SCORE", "REJECT_AUDIT"].filter((st) => laneState.stages?.[st]?.status !== "done");
    if (bad1.length) { console.error(`\nERIC LANE is NOT READY — ${bad1.join(", ")} did not complete. Read ${join(runDir, "summary.md")}, then re-run this same command.`); process.exit(1); }

    // ERIC'S LANE, pass 2 — his company/website VALIDATION stage, evidence-aware: passes on sufficient cited
    // Parallel evidence, otherwise runs his live website check. Then his FINALIZE / PUSH / REPORT (READY gate).
    const ev = recordEvidenceValidations(runDir);
    console.log(`\n▶ ERIC LANE 2/2 — VERIFY (evidence-aware: ${ev.byEvidence} validated on Parallel evidence, ${ev.toLiveCheck} → his live website check) → FINALIZE → PUSH → REPORT`);
    seedLaneState(runDir, laneJson, promptPath, parallelCandidates, discovered + listN, "validate");
    const laneCode = tsx(join(LB, "run-lane.ts"), [`--config=${laneJson}`, `--run-dir=${runDir}`]);
    laneState = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const stagesDone = ["MERGE", "SCORE", "VERIFY", "FINALIZE"].every((st) => laneState.stages?.[st]?.status === "done");
    if (laneCode !== 0 && !stagesDone) { console.error(`\nERIC LANE is NOT READY — read ${join(runDir, "summary.md")} (line 1 + "Why not ready"), then re-run this same command.`); process.exit(1); }

    // His live check could not verify some sites (blocked / inaccessible / uninformative) → second opinion or REVIEW
    console.log("\n▶ VERIFY-FALLBACK (only for companies his live website check could not verify)");
    const vf = tsx(join(HERE, "verify-fallback.ts"), [`--run-dir=${runDir}`, `--prompt-file=${promptPath}`]);
    if (vf !== 0) { console.error(`\nVERIFY-FALLBACK stopped (exit ${vf}). Re-run this same command.`); process.exit(vf); }
    const researchN = buildResearchSet(runDir).length;
    if (laneCode !== 0 && researchN) console.log(`note: his lane reported NOT READY on its verified-count thresholds only; continuing with ${researchN} companies (his finals + verify-fallback).`);
    if (args.until === "companies") { console.log(`\n--until=companies: research set has ${researchN} companies; stopping before gap research and Quick Enrich.`); return; }

    if (researchN) for (const [name, script] of [["GAP DECISION (required facts still missing / weak / contradictory → targeted Parallel research, those fields only)", "parallel-signals.ts"], ["RECIPIENT STAGE (spec recipient logic → Quick Enrich, only companies worth progressing → Eric contacts-merge + contacts.ts EMAILS)", "quickenrich-people.ts"], ["FINAL GATE + DEDUPE", "qualify.ts"]]) {
      console.log(`\n▶ ${name}`);
      const code = tsx(join(HERE, script), [`--spec=${specCopy}`, `--run-dir=${runDir}`, ...(script === "parallel-signals.ts" && args["confirm-not-submitted"] ? ["--confirm-not-submitted"] : [])]);
      if (code !== 0) { console.error(`\n${name} stopped (exit ${code}). Read the message above; re-running the same command resumes without paying twice.`); process.exit(code); }
    }

    // ---- target check: decide whether another round is worth buying ----
    const qPath = join(runDir, "output", "qualified.csv");
    const qualified = existsSync(qPath) ? readCsv(qPath).length : 0;
    const status = existsSync(join(runDir, "discovery-status.json")) ? JSON.parse(readFileSync(join(runDir, "discovery-status.json"), "utf8")) : {};
    const inspected = new Set(judgedRows.map((r) => r.domain)).size; // every company passes through Eric's judge exactly once
    console.log(`\nround ${round}: ${qualified} qualified (minimum success threshold ${T.qualified_leads}) · ${inspected}/${T.max_companies} companies inspected · ~$${spentSoFar(runDir).usd.toFixed(2)} of $${spec.budget.max_usd}`);
    const plan = planNextRound({ qualified, inspected, total, target: T.qualified_leads, maxCompanies: T.max_companies, capUsd: spec.budget.max_usd, spentUsd: spentSoFar(runDir).usd, perCompanyUsd: perCompany, exhausted: !!status.exhausted, matched: status.matched, hasDiscovery: !!d });
    if (plan.stop) { stopReason = plan.stop; break; }
    const next = plan.next;
    console.log(`yield so far ${((qualified / Math.max(inspected, 1)) * 100).toFixed(1)}%${qualified >= T.qualified_leads ? " — threshold met, continuing: every qualifying lead is kept" : ""} → next round +${next} companies`);
    total += next;
  }

  writeRunReport(runDir, spec, stopReason);

}

if (process.argv[1]?.split("/").pop() === "kept-run.ts") main();

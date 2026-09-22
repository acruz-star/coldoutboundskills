#!/usr/bin/env tsx
/**
 * parallel-discover.ts — PARALLEL is the discovery + evidence ENGINE for Eric's spine. It decides nothing.
 *
 * DISCOVERY IS BROAD: the FindAll match conditions are the SIGNAL from the campaign tab and nothing else. No
 * ICP, geography, size or exclusion is applied at discovery — those are qualification, decided later by Eric's
 * stages. One run returns as much required evidence as possible alongside the signal:
 *   match conditions  = the spec's signal conditions only, each with citations
 *   enrichment        = the campaign's fact fields + icp_evidence (cited facts for Eric's judge) + canonical
 *                       company_domain + company_context, attached to the SAME run (POST /enrich — covers
 *                       every match, including later extend rounds)
 *
 * What it hands to Eric's stages:
 *   spec/parallel-candidates.csv   the candidate feed for his MERGE stage (his `extra_candidates` door). The
 *                                  description column carries Parallel's cited company context + ICP reasoning,
 *                                  so his ICP judge (SCORE) reads real evidence instead of scraping a homepage.
 *   parallel-evidence.csv          per company: is the cited evidence sufficient for his company/website
 *                                  validation stage to pass without a live fetch? (evidenceSufficient)
 *   signals.jsonl / evidence.jsonl the campaign facts + every citation, for the gap decision and the final gate.
 *
 *     npx tsx parallel-discover.ts --spec=<campaign-spec.json> --run-dir=<dir> --total=<N>
 *       --total   companies FindAll should have matched after this call. First call creates the run;
 *                 later calls EXTEND it by the difference (additive), so rounds never re-buy matches.
 *       [--adopt=<findall_id>] [--confirm-not-submitted]
 *
 * PAID. Only runs under kept-run.ts, which enforces the per-run spend cap. Every paid submission
 * (create / enrich / extend) is recorded before and after; a re-run RESUMES, it never buys twice.
 *
 * Also writes discovery-status.json and raw/findall-<id>.json.
 */
import { writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadEnv, parseArgs, writeCsv, normDomain, sleep } from "../../list-expander/scripts/lib";
import { loadSpec, CampaignSpec, FIRST_BATCH_COMPANIES, rootDomain, evidenceSufficient, icpIsNeutral, parallel, readJsonl, appendJsonl, logSpend, spentSoFar, requireSpendApproval, FINDALL_EST, TASK_EST_PER_RUN, signalSchema, isUnknown } from "./kept-lib";

// FindAll's candidate url is sometimes the SOURCE of the news or an investor/about microsite. Parallel
// is asked for the canonical domain (company_domain); this is only the fallback when it says UNCLEAR.
const NOT_A_COMPANY_SITE = /(^|\.)(prnewswire|businesswire|globenewswire|newswire|accesswire|einpresswire|linkedin|facebook|x|twitter|instagram|youtube|wikipedia|bloomberg|reuters|yahoo|sec|greatplacetowork|theorg|crunchbase|zoominfo|glassdoor|indeed|dnb|owler|rocketreach|pitchbook|comparably|zippia|cbinsights|manta|bbb|yelp|mapquest)\.(com|org|gov|co|io|ai)$/;
const MICROSITE_PREFIX = /^(investors?|ir|about|newsroom|news|press|media|corporate|careers|jobs|blog)\./;
export function companyDomain(url: string): string {
  const d = normDomain(url).replace(MICROSITE_PREFIX, "");
  return !d.includes(".") || NOT_A_COMPANY_SITE.test(d) ? "" : d;
}

export const FEED_COLS = ["domain", "name", "description", "source", "findall_candidate_id"];
export const EVID_COLS = ["domain", "name", "canonical_domain_stated", "icp_evidence_citations", "context_cited", "sufficient", "why"];
const val = (o: any) => (o && typeof o === "object" && "value" in o ? o.value : o);

/** Turn one FindAll result into (a) the candidate feed for Eric's MERGE, (b) the evidence-sufficiency
 *  table for his validation stage, (c) campaign facts + citations. Pure — tested offline against fixtures. */
export function candidatesToResearch(spec: CampaignSpec, res: any, exclude: Set<string>): { feed: Record<string, string>[]; sufficiency: Record<string, string>[]; signals: { domain: string; name: string; content: Record<string, unknown>; candidate_id: string }[]; evidence: any[]; dropped: string[]; unenriched: string[]; duplicates: number } {
  const fieldNames = [...spec.signals.fields.map((f) => f.name), "company_domain", "company_context", "icp_evidence", "contradictions"];
  const feed: Record<string, string>[] = [], sufficiency: Record<string, string>[] = [], signals: any[] = [], evidence: any[] = [], dropped: string[] = [], unenriched: string[] = [];
  const seen = new Set<string>(); let duplicates = 0;
  for (const c of (res?.candidates ?? []).filter((x: any) => x.match_status === "matched")) {
    const out = c.output ?? {};
    const content: Record<string, unknown> = {};
    for (const f of fieldNames) if (out[f] !== undefined) content[f] = val(out[f]);
    const stated = isUnknown(content.company_domain) ? "" : rootDomain(companyDomain(String(content.company_domain)));
    const domain = stated || rootDomain(companyDomain(c.url ?? ""));
    if (!domain) { dropped.push(`${c.name}: no usable company domain (url ${c.url ?? "none"})`); continue; }
    if (exclude.has(domain)) continue;
    if (seen.has(domain)) { duplicates++; continue; } // company dedupe key = canonical root domain
    seen.add(domain);
    content.company_domain = domain;
    const enriched = spec.signals.fields.some((f) => out[f.name] !== undefined);
    if (!enriched) unenriched.push(domain);
    const basis: any[] = Array.isArray(c.basis) ? c.basis : [];
    const cites = (field: string) => basis.filter((b) => b.field === field).flatMap((b) => (b.citations ?? []).map((x: any) => x.url)).filter(Boolean);
    const conds = Object.entries(out).filter(([, v]: any) => v?.type === "match_condition") as [string, any][];
    const icpCites = new Set(cites("icp_evidence")).size;
    const ctxCited = !isUnknown(content.company_context) && cites("company_context").length > 0;
    const suff = evidenceSufficient({ canonical_domain_stated: !!stated, icp_evidence_citations: icpCites, context_cited: ctxCited, icp_required: !icpIsNeutral(spec) });
    sufficiency.push({ domain, name: c.name ?? domain, canonical_domain_stated: String(!!stated), icp_evidence_citations: String(icpCites), context_cited: String(ctxCited), sufficient: String(suff.ok), why: suff.why });
    // evidence text for Eric's judge: the company's identity, plus cited ICP facts only when the campaign states an ICP
    const icpFacts = isUnknown(content.icp_evidence) ? "" : String(content.icp_evidence);
    const description = [isUnknown(content.company_context) ? c.description ?? "" : String(content.company_context), icpFacts && `ICP evidence: ${icpFacts}`, conds.length && `Signal: ${conds.map(([k, v]) => `${k}=${String(v.value).slice(0, 80)}`).join(" | ")}`, icpCites && `Sources: ${[...new Set(cites("icp_evidence"))].slice(0, 4).join(" ; ")}`].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 3000);
    feed.push({ domain, name: c.name ?? domain, description, source: "parallel-findall", findall_candidate_id: c.candidate_id ?? "" });
    if (enriched) signals.push({ domain, name: c.name ?? domain, content, candidate_id: c.candidate_id ?? "" });
    for (const b of basis) for (const cit of (b.citations?.length ? b.citations : [{}]))
      evidence.push({ domain, stage: out[b.field]?.type === "match_condition" ? "discovery" : "signals", field: b.field, value: val(out[b.field]) ?? "", confidence: b.confidence ?? "", source_url: cit.url ?? "", excerpt: (cit.excerpts ?? []).join(" … ").slice(0, 800), reasoning: b.reasoning ?? "" });
  }
  return { feed, sufficiency, signals, evidence, dropped, unenriched, duplicates };
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx parallel-discover.ts --spec=<campaign-spec.json> --run-dir=<dir> --total=<N>"); process.exit(1); }
  const spec = loadSpec(String(args.spec));
  const runDir = String(args["run-dir"]);
  const feedPath = join(runDir, "spec", "parallel-candidates.csv");
  const evidPath = join(runDir, "parallel-evidence.csv");
  mkdirSync(join(runDir, "spec"), { recursive: true });
  const progress = join(runDir, "parallel-discover.log");
  const say = (s: string) => { console.log(s); appendFileSync(progress, `${new Date().toISOString()} ${s}\n`); };

  const d = spec.companies.discovery;
  if (!d) { writeFileSync(feedPath, FEED_COLS.join(",") + "\n"); writeFileSync(evidPath, EVID_COLS.join(",") + "\n"); say("no discovery block in the spec — company list / seeds only"); return; }
  requireSpendApproval("Parallel FindAll");

  const generator = d.generator ?? "core";
  const processor = spec.signals.processor ?? "core";
  const total = Number(args.total ?? d.match_limit ?? FIRST_BATCH_COMPANIES);
  if (!Number.isInteger(total) || total < 5 || total > 1000) { console.error(`--total must be an integer 5-1000 (got ${args.total})`); process.exit(1); }
  const exclude = (spec.companies.exclude_domains ?? []).map(normDomain).filter(Boolean);
  const meta = { skill: "kept-research", campaign: spec.campaign_slug };
  const xl = exclude.length ? { exclude_list: exclude.map((x) => ({ name: x, url: `https://${x}` })) } : {};
  // signal-only match conditions: broad discovery. The ICP travels as evidence (enrichment), not as a filter.
  const payload = { objective: d.objective, entity_type: d.entity_type ?? "companies", match_conditions: d.match_conditions, generator, ...xl, metadata: meta };
  const hash = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
  const statePath = join(runDir, "parallel-runs.jsonl");
  // A run bought under an older fingerprint must still be recognised, or a resume would buy a second one.
  const legacyBase = { objective: d.objective, entity_type: d.entity_type ?? "companies", match_conditions: d.match_conditions, generator };
  const known = new Set(readJsonl(statePath).map((e) => e.discovery_sha));
  const sha = [hash(payload), hash({ ...legacyBase, ...xl, metadata: meta }), hash({ ...legacyBase, match_limit: d.match_limit, ...xl, metadata: meta })].find((h) => known.has(h)) ?? hash(payload);
  const ev = () => readJsonl(statePath).filter((e) => e.discovery_sha === sha);
  const log = (event: string, extra: Record<string, unknown> = {}) => appendJsonl(statePath, { event, discovery_sha: sha, at: new Date().toISOString(), ...extra });
  const pending = (start: string, end: string) => ev().filter((e) => e.event === start && !ev().some((x) => x.event === end && x.ref === e.ref));
  const ambiguous = (what: string) => { console.error(`AMBIGUOUS SUBMISSION: a FindAll ${what} was started and its result was never recorded.\nCheck the run in the Parallel dashboard. If it did NOT go through, re-run with --confirm-not-submitted${what === "create" ? "; if it did, re-run with --adopt=<findall_id>" : ""}. Refusing to pay twice blind.`); process.exit(4); };
  const capCheck = (est: number, what: string) => { const spent = spentSoFar(runDir).usd; if (spent + est > spec.budget.max_usd) { console.error(`SPEND CAP: ${what} est $${est.toFixed(2)} + already spent $${spent.toFixed(2)} would exceed this run's cap of $${spec.budget.max_usd}. Nothing submitted.`); process.exit(5); } };
  const taskEst = TASK_EST_PER_RUN[processor] ?? 0.1;

  // ---- create ----
  let findallId: string = String(args.adopt ?? "") || ev().find((e) => e.event === "findall_created")?.findall_id || "";
  if (args.adopt && !ev().some((e) => e.event === "findall_created")) log("findall_created", { findall_id: findallId, adopted: true });
  const fresh = !findallId;
  if (!findallId) {
    if (ev().some((e) => e.event === "findall_submitting") && !args["confirm-not-submitted"]) ambiguous("create");
    capCheck(FINDALL_EST[generator].fixed + (FINDALL_EST[generator].per_match + taskEst) * total, "FindAll + evidence");
    log("findall_submitting");
    const r = await parallel("POST", "/v1beta/findall/runs", { ...payload, match_limit: total });
    if (!r?.findall_id) { console.error(`FindAll create did not return an id: ${JSON.stringify(r).slice(0, 400)}`); process.exit(4); }
    findallId = r.findall_id;
    log("findall_created", { findall_id: findallId, generator, match_limit: total });
    logSpend(runDir, { provider: "parallel", kind: `findall:${generator}`, id: findallId, est_usd: FINDALL_EST[generator].fixed + FINDALL_EST[generator].per_match * total, note: `match_limit ${total} (estimate at ceiling)` });
    say(`FindAll created ${findallId} (${generator}, match_limit ${total})`);
  }
  const created = ev().find((e) => e.event === "findall_created")!;

  // ---- evidence: attach the campaign's fields to THIS run, once ----
  if (!ev().some((e) => e.event === "findall_enriched")) {
    if (pending("findall_enriching", "findall_enriched").length && !args["confirm-not-submitted"]) ambiguous("enrich");
    const covers = Math.max(Number(created.match_limit ?? 0), fresh ? total : 0);
    if (!fresh) capCheck(taskEst * covers, "evidence enrichment"); // a fresh create already budgeted it above
    const ref = `enrich-${processor}`;
    log("findall_enriching", { ref });
    const r = await parallel("POST", `/v1beta/findall/runs/${findallId}/enrich`, { processor, output_schema: signalSchema(spec) });
    if (r?._network_error || r?._http_status || r?.error) { console.error(`FindAll enrich did not confirm: ${JSON.stringify(r).slice(0, 300)}`); process.exit(4); }
    log("findall_enriched", { ref, processor, fields: spec.signals.fields.length });
    logSpend(runDir, { provider: "parallel", kind: `findall-enrich:${processor}`, id: findallId, est_usd: taskEst * covers, note: `evidence fields on up to ${covers} matches (estimate at ceiling)` });
    say(`evidence enrichment attached to ${findallId} (${processor}, ${spec.signals.fields.length} campaign fields + company_domain + company identity${icpIsNeutral(spec) ? "; no ICP facts — the campaign sets no company restriction" : " + icp_evidence"})`);
    await sleep(5000);
  }

  // ---- extend up to --total ----
  const current = Number(created.match_limit ?? 0) + ev().filter((e) => e.event === "findall_extended").reduce((a, e) => a + Number(e.additional ?? 0), 0);
  if (created.adopted && !created.match_limit) say(`adopted run ${findallId}: its size is unknown to this run; not extending`);
  else if (total > current) {
    const stuck = pending("findall_extending", "findall_extended");
    if (stuck.length && !args["confirm-not-submitted"]) ambiguous("extend");
    for (const e of stuck) log("findall_extended", { ref: e.ref, additional: 0, note: "operator confirmed not submitted" });
    const add = total - current;
    capCheck((FINDALL_EST[generator].per_match + taskEst) * add, `extending FindAll by ${add}`);
    const ref = `${current}+${add}`;
    log("findall_extending", { ref, additional: add });
    const r = await parallel("POST", `/v1beta/findall/runs/${findallId}/extend`, { additional_match_limit: add });
    if (r?._network_error || r?._http_status || r?.error) { console.error(`FindAll extend did not confirm: ${JSON.stringify(r).slice(0, 300)}`); process.exit(4); }
    log("findall_extended", { ref, additional: add, new_total: r?.match_limit ?? total });
    logSpend(runDir, { provider: "parallel", kind: `findall-extend:${generator}+${processor}`, id: findallId, est_usd: (FINDALL_EST[generator].per_match + taskEst) * add, note: `+${add} matches with evidence → ${total} (estimate at ceiling)` });
    say(`FindAll ${findallId} extended by ${add} → ${total}`);
    await sleep(5000);
  } else say(`resuming FindAll ${findallId} (match limit ${current})`);

  for (;;) {
    const s = await parallel("GET", `/v1beta/findall/runs/${findallId}`);
    const st = s?.status ?? {};
    say(`status=${st.status ?? "?"} matched=${st.metrics?.matched_candidates_count ?? "?"} generated=${st.metrics?.generated_candidates_count ?? "?"}`);
    if (st.is_active === false) { if (st.status && st.status !== "completed") say(`run ended ${st.status} (${st.termination_reason ?? "no reason"}) — using whatever matched`); break; }
    await sleep(30_000);
  }

  const res = await parallel("GET", `/v1beta/findall/runs/${findallId}/result`);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(join(runDir, "raw", `findall-${findallId}.json`), JSON.stringify(res, null, 1));
  const out = candidatesToResearch(spec, res, new Set(exclude));
  for (const m of out.dropped) say(`  dropped — ${m}`);

  // signals + evidence are append-only; write only what this run has not recorded for this FindAll yet
  const sigPath = join(runDir, "signals.jsonl");
  const haveSig = new Set(readJsonl(sigPath).filter((s) => s.source === "findall" && s.parallel_id === findallId).map((s) => s.domain));
  for (const s of out.signals) if (!haveSig.has(s.domain)) appendJsonl(sigPath, { domain: s.domain, name: s.name, source: "findall", parallel_id: findallId, run_id: s.candidate_id, status: "RESEARCH_COMPLETE", content: s.content, researched_at: new Date().toISOString() });
  const haveEv = new Set(readJsonl(join(runDir, "evidence.jsonl")).filter((e) => e.parallel_id === findallId).map((e) => `${e.domain}|${e.field}|${e.source_url}`));
  for (const e of out.evidence) if (!haveEv.has(`${e.domain}|${e.field}|${e.source_url}`)) appendJsonl(join(runDir, "evidence.jsonl"), { ...e, parallel_id: findallId, researched_at: new Date().toISOString() });
  if (out.feed.length) writeCsv(feedPath, out.feed, FEED_COLS); else writeFileSync(feedPath, FEED_COLS.join(",") + "\n");
  if (out.sufficiency.length) writeCsv(evidPath, out.sufficiency, EVID_COLS); else writeFileSync(evidPath, EVID_COLS.join(",") + "\n");
  const matched = (res?.candidates ?? []).filter((c: any) => c.match_status === "matched").length;
  const suffN = out.sufficiency.filter((r) => r.sufficient === "true").length;
  writeFileSync(join(runDir, "discovery-status.json"), JSON.stringify({ findall_id: findallId, requested_total: total, matched, usable: out.feed.length, duplicates_removed: out.duplicates, unenriched: out.unenriched.length, evidence_sufficient: suffN, exhausted: matched < total, at: new Date().toISOString() }, null, 1));
  say(`${out.feed.length} unique companies → Eric's MERGE feed (${matched} matched; ${out.duplicates} duplicate domains removed; ${suffN} carry evidence sufficient for his validation stage; ${out.unenriched.length} not yet enriched) → ${feedPath}`);
}

if (process.argv[1]?.split("/").pop() === "parallel-discover.ts") main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

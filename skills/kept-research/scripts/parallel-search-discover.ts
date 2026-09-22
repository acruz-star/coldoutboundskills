#!/usr/bin/env tsx
/**
 * parallel-search-discover.ts — the ACTIVE discovery engine for /kept-research, replacing FindAll.
 *
 * DISCOVERY IS BROAD AND SIGNAL-ONLY, same contract as before: the campaign's Signal/s
 * (spec.companies.discovery.objective + match_conditions) is the ONLY thing that drives what gets
 * searched. Never Angle, never Title(s), never ICP/industry/segment language, never a prior
 * campaign's clarifications. Industry/Segment still ride along as CITED EVIDENCE for Eric's judge
 * (icp_evidence), exactly as before — that is qualification evidence, not a discovery filter.
 *
 * HOW IT WORKS (adaptive, no hard-coded source assumptions):
 *   PLAN     a lightweight OpenAI gpt-5-nano planner sees ONLY the Signal/s objective + match
 *            conditions (never research_brief, signal field names, Title(s), rules, recipient logic,
 *            or ICP/industry/segment language — see DiscoverySignal / plannerPrompt), plus every tactic
 *            already tried this campaign and its yield, and the downstream qualified COUNT. It proposes
 *            2-5 new search jobs (short keyword queries, optional include_domains for a source-focused
 *            pass, a rationale) for one PLANNER WAVE. It never repeats a tactic that already ran, and
 *            changes wording/source/person-vs-company framing when yield is weak. It is never told to
 *            prefer one source family — it learns that from yield.
 *   SEARCH   each job in the wave is POST /v1/search (mode "fast"; include_domains only when the job
 *            asks for a focused source pass — never a site: operator). This is the ONLY discovery
 *            network call in this file; the legacy FindAll batch-discovery endpoint is never referenced.
 *   EXTRACT  gpt-5-nano reads each NEW result (url/title/excerpts) and, strictly from what that result
 *            states, extracts a candidate company + any campaign signal/evidence fields the excerpt
 *            actually establishes (signalSchema — the ICP/field detail the planner never sees is fine
 *            here; this step runs AFTER a company is already found by the signal-only planner). It
 *            never invents a company or person; a company_domain is accepted only when
 *            domainGroundedInResult confirms it is actually stated by that result — never a
 *            plausible-looking domain gpt-5-nano merely generated. A candidate whose domain isn't
 *            grounded is held as UNRESOLVED, never fed to Eric with a guessed domain.
 *   RESOLVE  for each unresolved company, ONE focused /v1/search for its official website;
 *            pickOfficialDomainFromResults only accepts a result whose domain/title defensibly names
 *            THIS company (never a bare topical mention, never a similarly-named different company).
 *            Resolved → joins the feed; still not → stays in the audit file, never fabricated.
 *   REPEAT   the loop keeps running planner waves within this call until this round's target
 *            unique-company count is met, or research is genuinely exhausted (the last 2 of at least 3
 *            COMPLETE planner waves each produced ≤1 new unique company — a wave's own individual job
 *            yields never trigger this on their own), or the spend cap stops it.
 *
 *     npx tsx parallel-search-discover.ts --spec=<campaign-spec.json> --run-dir=<dir> --total=<N>
 *       --total   cumulative unique companies this campaign run should have by the end of this call.
 *       [--confirm-not-submitted]
 *
 * PAID. Only runs under kept-run.ts, which enforces the per-run spend cap. Every /v1/search submission
 * is recorded (search-jobs.jsonl) before its result is read, keyed by a stable hash of
 * objective + search_queries + source policy, so a resumed run NEVER submits the same search-job twice
 * and a crash mid-call is reconciled (not paid for blind) exactly like the rest of this skill.
 *
 * Writes into the SAME artifacts Eric and the rest of this skill already expect:
 *   spec/parallel-candidates.csv   Eric's MERGE feed (same columns as before; source = "parallel-search")
 *   parallel-evidence.csv          per-company evidence-sufficiency for his validation stage
 *   signals.jsonl / evidence.jsonl campaign facts + citations — Search evidence can fully satisfy a
 *                                  fact, so parallel-signals.ts (gap research) only asks for what's left
 *   parallel-search-unresolved.csv companies a signal identified but whose domain could not be
 *                                  established — audit only, never fed to Eric
 *   discovery-status.json          search_calls, search_jobs, queries_run, unique_urls_seen,
 *                                  unique_company_candidates, new_candidates_last_round,
 *                                  source_domain_counts, query_yield (per search job),
 *                                  planner_wave_yield (per planner wave — what exhaustion decides on),
 *                                  research_exhausted, stop_reason (+ exhausted/matched/
 *                                  duplicates_removed kept for kept-run.ts's existing
 *                                  round-continuation and report logic)
 */
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadEnv, parseArgs, writeCsv, readCsv, normDomain, sleep, httpJson, requireEnv } from "../../list-expander/scripts/lib";
import {
  loadSpec, CampaignSpec, rootDomain, evidenceSufficient, icpIsNeutral, parallel, readJsonl, appendJsonl,
  logSpend, spentSoFar, requireSpendApproval, SEARCH_EST, signalSchema, isUnknown, UNCLEAR,
  officialCompanyDomain, mergeSignals, FIRST_BATCH_COMPANIES,
} from "./kept-lib";

// ---------- types ----------
export type SearchJob = { objective: string; search_queries: string[]; include_domains?: string[]; rationale: string };
export type SearchResult = { url: string; title?: string; excerpts?: string[]; publish_date?: string | null };
export type ExtractedCandidate = {
  source_url: string; source_excerpt: string;
  company_name: string; company_domain: string;
  signal_person_name: string; signal_person_title: string;
  signal_evidence: string;
  fields: Record<string, string>;
};

export const FEED_COLS = ["domain", "name", "description", "source", "findall_candidate_id"];
export const EVID_COLS = ["domain", "name", "canonical_domain_stated", "icp_evidence_citations", "context_cited", "sufficient", "why"];
export const UNRESOLVED_COLS = ["company_name", "best_evidence", "source_url", "status"];

// ---------- discovery state (pure, in-memory; loaded from / folded into the append-only jsonl files) ----------
export type DiscoveryState = {
  companies: Map<string, { name: string; content: Record<string, unknown> }>; // key: root domain
  byName: Map<string, string>; // normalized company name -> root domain, once resolved
  pendingContent: Map<string, Record<string, unknown>>; // normalized name -> evidence gathered before a domain was known
  unresolved: Map<string, { name: string; evidence: string; source_url: string }>; // normalized name
};
export function newDiscoveryState(): DiscoveryState { return { companies: new Map(), byName: new Map(), pendingContent: new Map(), unresolved: new Map() }; }
const normName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Fold extracted candidates into state. Never invents a domain: a candidate whose domain is not
 *  evident is held in `unresolved` for the domain-resolution search pass, not fed to Eric. Pure. */
export function applyExtracted(state: DiscoveryState, extracted: ExtractedCandidate[], exclude: Set<string>): { added: string[]; duplicates: number } {
  const added: string[] = []; let duplicates = 0;
  for (const c of extracted) {
    const key = normName(c.company_name);
    if (!key) continue;
    const content: Record<string, unknown> = { ...c.fields };
    if (c.signal_evidence && isUnknown(content.company_context)) content.company_context = c.signal_evidence;
    const domain = c.company_domain ? rootDomain(c.company_domain) : state.byName.get(key) ?? "";
    if (domain && exclude.has(domain)) continue;
    if (domain) {
      const existing = state.companies.get(domain);
      const withPending = mergeSignals(existing?.content ?? null, state.pendingContent.get(key) ?? null);
      const merged = mergeSignals(withPending, content) ?? content;
      state.companies.set(domain, { name: existing?.name || c.company_name, content: merged });
      state.byName.set(key, domain);
      state.unresolved.delete(key);
      state.pendingContent.delete(key);
      if (existing) duplicates++; else added.push(domain);
    } else {
      const prev = state.unresolved.get(key);
      state.unresolved.set(key, { name: c.company_name, evidence: prev?.evidence || c.signal_evidence || c.source_excerpt, source_url: prev?.source_url || c.source_url });
      state.pendingContent.set(key, mergeSignals(state.pendingContent.get(key) ?? null, content) ?? content);
    }
  }
  // Same-batch reconciliation: a company can appear in one result before its domain-bearing result
  // (e.g. a LinkedIn mention processed ahead of the company's own press page in the same search job).
  // Re-check every still-unresolved name against byName in case a later item in THIS batch resolved it.
  for (const [key, u] of [...state.unresolved]) {
    const domain = state.byName.get(key);
    if (!domain) continue;
    const entry = state.companies.get(domain)!;
    entry.content = mergeSignals(entry.content, state.pendingContent.get(key) ?? null) ?? entry.content;
    state.unresolved.delete(key);
    state.pendingContent.delete(key);
  }
  return { added, duplicates };
}

/** A later focused domain-resolution search resolves an unresolved company. Pure. Returns true if it
 *  produced a genuinely new company (vs. merging into one already known under that domain). */
export function applyDomainResolution(state: DiscoveryState, companyName: string, domain: string, exclude: Set<string>): boolean {
  const key = normName(companyName);
  const u = state.unresolved.get(key);
  if (!u) return false;
  const rd = rootDomain(domain);
  state.unresolved.delete(key);
  if (exclude.has(rd)) { state.pendingContent.delete(key); return false; }
  const content = { ...(state.pendingContent.get(key) ?? {}), company_domain: rd };
  const existing = state.companies.get(rd);
  state.companies.set(rd, { name: existing?.name || u.name, content: mergeSignals(existing?.content ?? null, content) ?? content });
  state.byName.set(key, rd);
  state.pendingContent.delete(key);
  return !existing;
}

/** State → Eric's MERGE feed + the evidence-sufficiency table his VERIFY stage reads. Pure. */
export function stateToFeed(spec: CampaignSpec, state: DiscoveryState): { feed: Record<string, string>[]; sufficiency: Record<string, string>[] } {
  const feed: Record<string, string>[] = [], sufficiency: Record<string, string>[] = [];
  for (const [domain, c] of state.companies) {
    const content = c.content;
    const icpFacts = isUnknown(content.icp_evidence) ? "" : String(content.icp_evidence);
    const contextCited = !isUnknown(content.company_context);
    const description = [contextCited ? String(content.company_context) : "", icpFacts && `ICP evidence: ${icpFacts}`]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 3000)
      || `Candidate found via adaptive Parallel Search discovery on: ${spec.companies.discovery?.objective ?? "the campaign signal"}`.slice(0, 300);
    feed.push({ domain, name: c.name || domain, description, source: "parallel-search", findall_candidate_id: "" });
    const icpCited = icpFacts.length > 0;
    const suff = evidenceSufficient({ canonical_domain_stated: true, icp_evidence_citations: icpCited ? 1 : 0, context_cited: contextCited, icp_required: !icpIsNeutral(spec) });
    sufficiency.push({ domain, name: c.name || domain, canonical_domain_stated: "true", icp_evidence_citations: String(icpCited ? 1 : 0), context_cited: String(contextCited), sufficient: String(suff.ok), why: suff.why });
  }
  return { feed, sufficiency };
}

// ---------- job hashing / resume (D: never submit the same search-job hash twice) ----------
export function searchJobHash(job: { objective: string; search_queries: string[]; include_domains?: string[] }): string {
  const norm = {
    objective: job.objective.trim().toLowerCase(),
    search_queries: [...job.search_queries].map((q) => q.trim().toLowerCase()).sort(),
    include_domains: [...(job.include_domains ?? [])].map((d) => normDomain(d)).sort(),
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

// ---------- planner (adaptive tactics; never told to prefer a source; never given Angle/Title/ICP) ----------
const SITE_OP = /\bsite:\S+/gi;
export function sanitizeSearchJob(raw: any): SearchJob | null {
  if (!raw || typeof raw !== "object") return null;
  const objective = String(raw.objective ?? "").trim();
  if (!objective) return null;
  const queries = (Array.isArray(raw.search_queries) ? raw.search_queries : [])
    .map((q: unknown) => String(q ?? "").replace(SITE_OP, "").trim()).filter(Boolean).slice(0, 3);
  if (!queries.length) return null;
  const include_domains = Array.isArray(raw.include_domains) ? [...new Set(raw.include_domains.map((d: unknown) => normDomain(String(d ?? ""))).filter(Boolean))] as string[] : undefined;
  const rationale = String(raw.rationale ?? "").trim().slice(0, 300) || "planner tactic";
  return { objective: objective.slice(0, 500), search_queries: queries, ...(include_domains?.length ? { include_domains } : {}), rationale };
}

/** Parses + sanitizes the planner's JSON. Drops any job whose hash was already tried (never a repeat). Pure. */
export function parsePlannerResponse(raw: string, alreadyTried: Set<string>): { jobs: SearchJob[]; plannerExhausted: boolean; note: string } {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { jobs: [], plannerExhausted: false, note: "planner output was not valid JSON — no jobs this wave" }; }
  const raw_jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  const sanitized = raw_jobs.map(sanitizeSearchJob).filter((j: SearchJob | null): j is SearchJob => !!j).slice(0, 6);
  const fresh = sanitized.filter((j) => !alreadyTried.has(searchJobHash(j)));
  const droppedRepeat = sanitized.length - fresh.length;
  return { jobs: fresh, plannerExhausted: !!parsed?.exhausted, note: droppedRepeat ? `${droppedRepeat} planner job(s) repeated an already-tried tactic — skipped` : "" };
}

export type WaveHistoryItem = { queries: string[]; include_domains: string[]; rationale: string; new_candidates: number; source_hosts: string[] };
/** The ONLY campaign information the search planner may see: the Signal/s objective + match
 *  conditions. Deliberately NOT the full CampaignSpec — research_brief, signals.fields, titles,
 *  rules, recipient logic and ICP/industry/segment language must be structurally unreachable here,
 *  not just avoided by convention. Section G of the offline test suite asserts its keys are exactly
 *  {objective, match_conditions} and that no other campaign field ever reaches the planner prompt. */
export type DiscoverySignal = { objective: string; match_conditions: { name: string; description: string }[] };
export function plannerPrompt(signal: DiscoverySignal, history: WaveHistoryItem[], ctx: { uniqueCount: number; qualifiedCount: number | null; target: number }): { system: string; user: string } {
  const d = signal;
  const system = [
    "You are an adaptive web-research planner for B2B lead discovery. You choose SEARCH TACTICS ONLY — you never judge or filter which companies qualify; that happens later, by someone else, on separate evidence.",
    'Respond ONLY with strict JSON: {"jobs": [{"objective": string, "search_queries": [1-3 short KEYWORD queries, not full sentences], "include_domains": [optional bare domains, e.g. "linkedin.com"], "rationale": string}], "exhausted": boolean}.',
    "NEVER put a site: operator inside search_queries — to focus one source family, use include_domains instead. Do not permanently bind to one source: most jobs should be open web (no include_domains); use include_domains only for a genuine focused pass.",
    "Never repeat a tactic (same wording or same source) that already ran. When recent yield is weak, change wording, synonyms, event framing, person-first vs. company-first search, or try a different source family, or a reverse search from a named person back to their company.",
    'Return "exhausted": true only when you cannot think of any materially different wording or source tactic left worth trying.',
  ].join(" ");
  const historyLines = history.length
    ? history.map((h, i) => `${i + 1}. queries=[${h.queries.join(" | ")}] source=${h.include_domains.length ? h.include_domains.join(",") : "open web"} → ${h.new_candidates} new candidate(s) (hosts seen: ${h.source_hosts.slice(0, 6).join(", ") || "none"}) — tactic: ${h.rationale}`).join("\n")
    : "(none yet — this is the first round; propose several different wordings/sources to test what works)";
  const user = [
    "CAMPAIGN SIGNAL TO RESEARCH — the ONLY thing discovery is allowed to search for. No industry, segment, title, angle, pain, or purchase-intent framing.",
    `objective: ${d.objective}`,
    `signal condition(s): ${d.match_conditions.map((c) => `${c.name} — ${c.description}`).join(" | ")}`,
    "",
    "TACTICS ALREADY TRIED THIS CAMPAIGN (do not repeat any of these):",
    historyLines,
    "",
    `unique candidates found so far: ${ctx.uniqueCount} (target for this call: ${ctx.target})`,
    ctx.qualifiedCount != null ? `downstream qualified so far: ${ctx.qualifiedCount}` : "",
    "",
    history.length === 0
      ? "First round: propose 3-5 jobs testing different wording and at least one open-web tactic plus one plausible source-focused tactic — do not assume which source will work."
      : "Propose 2-4 jobs, materially different from every tactic above.",
  ].filter(Boolean).join("\n");
  return { system, user };
}

// ---------- extractor (never invents a company/domain/person; UNCLEAR when not established) ----------
export function extractionPrompt(spec: CampaignSpec, job: SearchJob, results: SearchResult[]): { system: string; user: string } {
  const props = (signalSchema(spec).json_schema as any).properties as Record<string, { description: string }>;
  const fieldGuide = Object.entries(props).map(([k, v]) => `- ${k}: ${v.description}`).join("\n");
  const system = [
    "You are a strict evidence extractor for B2B lead discovery. For each numbered search result, decide whether it plausibly identifies a company as a candidate for the signal below.",
    `Never invent a company name, domain, or person. Use "${UNCLEAR}" (or omit the field entirely) whenever the result's own text does not establish it — never guess, never infer from general knowledge.`,
    'Respond ONLY with JSON: {"candidates": [{"source_url": <exact url from the list below>, "company_name": string, "company_domain": string, "signal_person_name": string, "signal_person_title": string, "signal_evidence": "<one sentence, cited to this result>", "fields": {"<field name>": "<value>"}}]}.',
    'Include one entry per result that plausibly identifies a company; omit results that establish nothing usable. "fields" may only use names from the field guide below, and only when THIS result\'s own text establishes them — never carry a fact over from a different result.',
  ].join(" ");
  const user = [
    `SIGNAL BEING RESEARCHED: ${job.objective}`,
    `SEARCH TACTIC: queries=[${job.search_queries.join(" | ")}]`,
    "FIELD GUIDE (fill a field only when this result's own text establishes it):",
    fieldGuide,
    "",
    "SEARCH RESULTS:",
    ...results.map((r, i) => `[${i + 1}] url: ${r.url}\ntitle: ${r.title ?? ""}\nexcerpts: ${(r.excerpts ?? []).join(" … ").slice(0, 1200)}`),
  ].join("\n");
  return { system, user };
}

/** Is `domain` actually grounded in THIS result — never trust a model-generated domain on its say-so
 *  alone. Grounded means either: the result's own url IS that domain (the result itself is the
 *  company's site — the strongest possible grounding), or the exact domain string is present in the
 *  result's own title/excerpt text (the source itself states it). Pure. */
export function domainGroundedInResult(domain: string, result: SearchResult): boolean {
  const d = normDomain(domain);
  if (!d.includes(".")) return false;
  if (officialCompanyDomain(result.url) === d) return true;
  const text = `${result.title ?? ""} ${(result.excerpts ?? []).join(" ")}`.toLowerCase();
  return text.includes(d);
}

/** Never invents a source: a candidate is kept only if its source_url is one of the results actually
 *  shown, and only if it names a company. `fields` is filtered to known campaign field names.
 *  A company_domain the model returns is accepted ONLY when domainGroundedInResult confirms it —
 *  a plausible-looking domain the model invented, with no support in the cited result, is rejected
 *  and the candidate is left unresolved (never guessed). Pure. */
export function parseExtractionResponse(raw: string, results: SearchResult[], spec: CampaignSpec): ExtractedCandidate[] {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const byUrl = new Map(results.map((r) => [r.url, r]));
  const validFields = new Set(Object.keys((signalSchema(spec).json_schema as any).properties));
  const arr = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const out: ExtractedCandidate[] = [];
  for (const c of arr) {
    const url = String(c?.source_url ?? "");
    const res = byUrl.get(url);
    if (!res) continue; // never invent a source
    const name = String(c?.company_name ?? "").trim();
    if (!name || isUnknown(name)) continue; // never invent a company
    const domainRaw = String(c?.company_domain ?? "");
    let domain = "";
    if (!isUnknown(domainRaw)) {
      const candidate = officialCompanyDomain(domainRaw);
      if (candidate && domainGroundedInResult(candidate, res)) domain = candidate; // else: not grounded — rejected, stays unresolved
    }
    if (!domain) domain = officialCompanyDomain(url); // the result IS the company's own site — trivially grounded
    const fields: Record<string, string> = {};
    if (c?.fields && typeof c.fields === "object") for (const [k, v] of Object.entries(c.fields)) if (validFields.has(k) && !isUnknown(v)) fields[k] = String(v).slice(0, 2000);
    out.push({
      source_url: url,
      source_excerpt: (res.excerpts ?? []).join(" … ").slice(0, 800),
      company_name: name,
      company_domain: domain,
      signal_person_name: isUnknown(c?.signal_person_name) ? "" : String(c.signal_person_name).trim().slice(0, 200),
      signal_person_title: isUnknown(c?.signal_person_title) ? "" : String(c.signal_person_title).trim().slice(0, 200),
      signal_evidence: String(c?.signal_evidence ?? "").trim().slice(0, 400),
      fields,
    });
  }
  return out;
}

// ---------- domain resolution (B: a social/news result names a company but not its domain) ----------
/** How defensibly a domain identifies THIS company by name — 0 means "not defensible", and such a
 *  domain is never returned, never guessed at. Requires either the domain's own name slug to
 *  substantially match the company's full name (a genuine "official site" pattern — e.g.
 *  riversidehardwareco.com for "Riverside Hardware"), or every significant word of the company name
 *  to appear in the result's title AND the domain to share at least one of those words too. A bare
 *  topical mention (a news article whose domain has nothing to do with the company's own name) scores
 *  0 and is excluded, even if the title happens to name the company. Pure. */
function domainMatchScore(companyName: string, domain: string, title: string): 0 | 1 | 2 {
  const nameWords = normName(companyName).split(" ").filter((w) => w.length > 2);
  if (!nameWords.length) return 0;
  const nameJoined = nameWords.join("");
  const domainSlug = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (domainSlug.length > 2 && (domainSlug.includes(nameJoined) || nameJoined.includes(domainSlug))) return 2;
  const titleNorm = normName(title);
  const allWordsInTitle = nameWords.every((w) => titleNorm.includes(w));
  const domainSharesAWord = nameWords.some((w) => domainSlug.includes(w));
  return allWordsInTitle && domainSharesAWord ? 1 : 0;
}

/** Picks the official domain from a focused "<company> official website" search's results —
 *  deterministically, never a guess. Non-company hosts (social/news/wires/listings/filings/
 *  aggregators) are excluded by officialCompanyDomain first; of what remains, only domains that pass
 *  domainMatchScore (real name/identity support, not bare topical overlap) are even eligible; the
 *  best-scoring one wins. If nothing passes, returns "" — the company stays unresolved rather than
 *  attaching an unrelated or similarly-named company's site. Pure. */
export function pickOfficialDomainFromResults(companyName: string, results: SearchResult[]): string {
  const scored = results
    .map((r) => ({ r, domain: officialCompanyDomain(r.url) }))
    .filter((x) => x.domain)
    .map((x) => ({ ...x, score: domainMatchScore(companyName, x.domain, x.r.title ?? "") }))
    .filter((x) => x.score > 0);
  if (!scored.length) return "";
  scored.sort((a, b) => b.score - a.score);
  return scored[0].domain;
}

// ---------- research exhaustion (auditable, code-decided from observed PLANNER-WAVE yield) ----------
/** A planner wave = one planner call's entire group of search jobs, run to completion, plus the
 *  domain resolutions those jobs' results generated — one number: the TOTAL new unique companies
 *  that whole wave produced. Exhausted when at least 3 COMPLETE planner waves have run and the last
 *  2 consecutive waves each produced ≤1 new unique company. An individual low-yield job inside an
 *  otherwise-productive wave (e.g. job yields [20, 0, 0] within one wave) must never trigger this —
 *  callers pass PLANNER-WAVE totals here, never per-job yields. Pure, no network. */
export function researchExhausted(plannerWaveNewCandidates: number[]): boolean {
  if (plannerWaveNewCandidates.length < 3) return false;
  return plannerWaveNewCandidates.slice(-2).every((n) => n <= 1);
}

// ---------- OpenAI (gpt-5-nano; same key/model pattern as the rest of this skill) ----------
async function askNano(system: string, user: string, apiKey: string, model: string): Promise<string> {
  const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" }, ...(model.startsWith("gpt-5") ? { reasoning_effort: "minimal" } : {}) };
  for (let a = 0; a < 3; a++) {
    try {
      const r = await httpJson("https://api.openai.com/v1/chat/completions", { headers: { Authorization: `Bearer ${apiKey}` }, body, timeoutMs: 90_000 });
      if (r.error) throw new Error(r.error.message ?? "api error");
      return String(r.choices?.[0]?.message?.content ?? "{}");
    } catch (e: any) { if (a === 2) return "{}"; await sleep(1500 * (a + 1)); }
  }
  return "{}";
}

// ================================================================================================
async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx parallel-search-discover.ts --spec=<campaign-spec.json> --run-dir=<dir> --total=<N>"); process.exit(1); }
  const spec = loadSpec(String(args.spec));
  const runDir = String(args["run-dir"]);
  const feedPath = join(runDir, "spec", "parallel-candidates.csv");
  const evidPath = join(runDir, "parallel-evidence.csv");
  const unresolvedPath = join(runDir, "parallel-search-unresolved.csv");
  const jobsLogPath = join(runDir, "search-jobs.jsonl");
  mkdirSync(join(runDir, "spec"), { recursive: true });
  const progress = join(runDir, "parallel-search-discover.log");
  const say = (s: string) => { console.log(s); appendFileSync(progress, `${new Date().toISOString()} ${s}\n`); };

  const d = spec.companies.discovery;
  if (!d) { writeFileSync(feedPath, FEED_COLS.join(",") + "\n"); writeFileSync(evidPath, EVID_COLS.join(",") + "\n"); say("no discovery block in the spec — company list / seeds only"); return; }
  requireSpendApproval("Parallel Search");

  const total = Number(args.total ?? d.match_limit ?? FIRST_BATCH_COMPANIES);
  if (!Number.isInteger(total) || total < 5 || total > 1000) { console.error(`--total must be an integer 5-1000 (got ${args.total})`); process.exit(1); }
  const exclude = new Set((spec.companies.exclude_domains ?? []).map(rootDomain).filter(Boolean));
  const apiKey = process.env.OPENAI_API_KEY_NANO ?? requireEnv("OPENAI_API_KEY");
  const model = "gpt-5-nano";

  const jobEvents = () => readJsonl(jobsLogPath);
  const submittedHashes = () => new Set(jobEvents().filter((e: any) => e.event === "search_submitting").map((e: any) => e.job_hash as string));
  const completedHashes = () => new Set(jobEvents().filter((e: any) => e.event === "search_completed").map((e: any) => e.job_hash as string));
  const pendingHashes = () => [...submittedHashes()].filter((h) => !completedHashes().has(h));
  const ambiguous = (what: string) => { console.error(`AMBIGUOUS SUBMISSION: a Search ${what} was started and its result was never recorded.\nCheck the Parallel dashboard / usage log. If it did NOT go through, re-run with --confirm-not-submitted. Refusing to pay twice blind.`); process.exit(4); };
  const capCheck = (est: number, what: string) => { const spent = spentSoFar(runDir).usd; if (spent + est > spec.budget.max_usd) { console.error(`SPEND CAP: ${what} est $${est.toFixed(2)} + already spent $${spent.toFixed(2)} would exceed this run's cap of $${spec.budget.max_usd}. Nothing submitted.`); process.exit(5); } };

  const stuck = pendingHashes();
  if (stuck.length) {
    if (!args["confirm-not-submitted"]) ambiguous("job");
    for (const h of stuck) appendJsonl(jobsLogPath, { event: "search_completed", job_hash: h, urls: [], result_count: 0, at: new Date().toISOString(), note: "operator confirmed not submitted" });
  }

  // ---- rebuild state from this run's history (resume across kept-run.ts's outer ROUNDS) ----
  const state = newDiscoveryState();
  for (const s of readJsonl(join(runDir, "signals.jsonl"))) {
    if (s.source !== "search" || s.status !== "RESEARCH_COMPLETE" || !s.domain) continue;
    const existing = state.companies.get(s.domain);
    state.companies.set(s.domain, { name: existing?.name || s.name || s.domain, content: mergeSignals(existing?.content ?? null, s.content ?? null) ?? (s.content ?? {}) });
    state.byName.set(normName(s.name || s.domain), s.domain);
  }
  if (existsSync(unresolvedPath)) for (const r of readCsv(unresolvedPath)) {
    const key = normName(r.company_name);
    if (r.status === "unresolved" && !state.byName.has(key)) state.unresolved.set(key, { name: r.company_name, evidence: r.best_evidence, source_url: r.source_url });
  }
  const processedUrls = new Set<string>(jobEvents().filter((e: any) => e.event === "wave_extracted").flatMap((e: any) => e.processed_urls ?? []));
  const startCount = state.companies.size;

  // ---- adaptive wave loop ----
  const MAX_WAVES = 30;
  let waves = 0, duplicatesThisCall = 0, stopReason = "";
  const waveHistory: WaveHistoryItem[] = jobEvents().filter((e: any) => e.event === "search_submitting" && e.kind !== "domain-resolve").map((s: any) => {
    const wr = jobEvents().find((w: any) => w.event === "wave_extracted" && w.job_hash === s.job_hash);
    return { queries: s.search_queries, include_domains: s.include_domains ?? [], rationale: s.rationale, new_candidates: wr?.new_candidates ?? 0, source_hosts: wr?.source_hosts ?? [] };
  });
  // PLANNER-WAVE history (distinct from the per-job waveHistory above, which is planner *context* only).
  // Exhaustion is decided on this: one number per completed planner wave = every new unique company that
  // wave's whole job group + the domain resolutions it generated produced. Reconstructed for resume.
  const plannerWaveHistory: number[] = jobEvents().filter((e: any) => e.event === "planner_wave_completed").map((e: any) => Number(e.new_candidates ?? 0));

  while (state.companies.size < total && waves < MAX_WAVES) {
    const qualifiedPath = join(runDir, "output", "qualified.csv");
    const qualifiedCount = existsSync(qualifiedPath) ? readCsv(qualifiedPath).length : null;
    const { system, user } = plannerPrompt({ objective: d.objective, match_conditions: d.match_conditions }, waveHistory, { uniqueCount: state.companies.size, qualifiedCount, target: total });
    const plannerRaw = await askNano(system, user, apiKey, model);
    const { jobs, plannerExhausted, note } = parsePlannerResponse(plannerRaw, submittedHashes());
    if (note) say(`  ${note}`);
    if (!jobs.length) { stopReason = plannerExhausted ? "planner reports no further productive search tactics" : "planner produced no new (non-repeating) tactic this wave"; break; }

    let waveNewCandidates = 0;
    const waveJobHashes: string[] = [];
    for (const job of jobs) {
      if (state.companies.size >= total) break;
      const hash = searchJobHash(job);
      waveJobHashes.push(hash);
      capCheck(SEARCH_EST.fast, `search job [${job.search_queries.join(", ")}]`);
      appendJsonl(jobsLogPath, { event: "search_submitting", kind: "discover", job_hash: hash, objective: job.objective, search_queries: job.search_queries, include_domains: job.include_domains ?? [], rationale: job.rationale, at: new Date().toISOString() });
      const body: any = { objective: job.objective, search_queries: job.search_queries, mode: "fast" };
      if (job.include_domains?.length) body.advanced_settings = { source_policy: { include_domains: job.include_domains } };
      const res = await parallel("POST", "/v1/search", body);
      if (res?._network_error || res?._http_status || res?.error) { console.error(`Search request did not confirm: ${JSON.stringify(res).slice(0, 300)}`); ambiguous("request"); }
      const results: SearchResult[] = Array.isArray(res?.results) ? res.results : [];
      appendJsonl(jobsLogPath, { event: "search_completed", kind: "discover", job_hash: hash, search_id: res?.search_id ?? "", urls: results.map((r) => r.url), result_count: results.length, at: new Date().toISOString() });
      logSpend(runDir, { provider: "parallel", kind: "search:fast", id: res?.search_id, est_usd: SEARCH_EST.fast, note: `${job.search_queries.join(" | ")}${job.include_domains?.length ? ` [${job.include_domains.join(",")}]` : ""}` });
      say(`  search [${job.search_queries.join(" | ")}]${job.include_domains?.length ? ` (${job.include_domains.join(",")})` : ""} → ${results.length} results`);

      const newResults = results.filter((r) => r.url && !processedUrls.has(r.url));
      let added: string[] = [], dup = 0;
      if (newResults.length) {
        const ep = extractionPrompt(spec, job, newResults);
        const extractedRaw = await askNano(ep.system, ep.user, apiKey, model);
        const extracted = parseExtractionResponse(extractedRaw, newResults, spec);
        const r = applyExtracted(state, extracted, exclude);
        added = r.added; dup = r.duplicates; duplicatesThisCall += dup;
        for (const c of extracted) {
          const domain = c.company_domain ? rootDomain(c.company_domain) : state.byName.get(normName(c.company_name));
          if (!domain) continue;
          const entry = state.companies.get(domain); if (!entry) continue;
          appendJsonl(join(runDir, "signals.jsonl"), { domain, name: entry.name, source: "search", parallel_id: hash, run_id: c.source_url, status: "RESEARCH_COMPLETE", content: entry.content, researched_at: new Date().toISOString() });
          for (const [field, value] of Object.entries(c.fields)) appendJsonl(join(runDir, "evidence.jsonl"), { domain, stage: "discovery", field, value, confidence: "", source_url: c.source_url, excerpt: c.source_excerpt, reasoning: c.signal_evidence, parallel_id: hash, researched_at: new Date().toISOString() });
          if (!c.fields.company_context && c.signal_evidence) appendJsonl(join(runDir, "evidence.jsonl"), { domain, stage: "discovery", field: "company_context", value: c.signal_evidence, confidence: "", source_url: c.source_url, excerpt: c.source_excerpt, reasoning: "", parallel_id: hash, researched_at: new Date().toISOString() });
        }
      }
      for (const r of newResults) processedUrls.add(r.url);
      const hosts = [...new Set(newResults.map((r) => normDomain(r.url)))];
      appendJsonl(jobsLogPath, { event: "wave_extracted", job_hash: hash, new_candidates: added.length, duplicate_candidates: dup, source_hosts: hosts, processed_urls: newResults.map((r) => r.url), at: new Date().toISOString() });
      say(`    ${added.length} new unique candidate(s), ${dup} duplicate(s) of an already-known company`);
      waveHistory.push({ queries: job.search_queries, include_domains: job.include_domains ?? [], rationale: job.rationale, new_candidates: added.length, source_hosts: hosts });
      waveNewCandidates += added.length;
    }

    // ---- domain resolution: companies a signal named but whose domain isn't evident yet ----
    for (const [key, u] of [...state.unresolved]) {
      if (state.companies.size >= total) break;
      const job: SearchJob = { objective: `Find the official company website domain for "${u.name}"`, search_queries: [`${u.name} official website`], rationale: "domain resolution for an unresolved company" };
      const hash = searchJobHash(job);
      if (completedHashes().has(hash)) continue; // already attempted this run; do not retry forever
      capCheck(SEARCH_EST.fast, `domain resolution for "${u.name}"`);
      appendJsonl(jobsLogPath, { event: "search_submitting", kind: "domain-resolve", job_hash: hash, company_name: u.name, search_queries: job.search_queries, at: new Date().toISOString() });
      const res = await parallel("POST", "/v1/search", { objective: job.objective, search_queries: job.search_queries, mode: "fast" });
      if (res?._network_error || res?._http_status || res?.error) { console.error(`Domain-resolution search did not confirm: ${JSON.stringify(res).slice(0, 300)}`); ambiguous("domain-resolution request"); }
      const results: SearchResult[] = Array.isArray(res?.results) ? res.results : [];
      appendJsonl(jobsLogPath, { event: "search_completed", kind: "domain-resolve", job_hash: hash, search_id: res?.search_id ?? "", urls: results.map((r) => r.url), result_count: results.length, at: new Date().toISOString() });
      logSpend(runDir, { provider: "parallel", kind: "search:domain-resolve", id: res?.search_id, est_usd: SEARCH_EST.fast, note: u.name });
      const domain = pickOfficialDomainFromResults(u.name, results);
      if (domain) {
        const isNew = applyDomainResolution(state, u.name, domain, exclude);
        appendJsonl(join(runDir, "signals.jsonl"), { domain, name: u.name, source: "search", parallel_id: hash, run_id: `domain-resolve:${key}`, status: "RESEARCH_COMPLETE", content: state.companies.get(domain)?.content ?? { company_domain: domain }, researched_at: new Date().toISOString() });
        say(`  domain resolved: "${u.name}" → ${domain}`);
        if (isNew) waveNewCandidates += 1;
      } else say(`  domain NOT resolved: "${u.name}" — kept in ${unresolvedPath} for review, not fed to Eric`);
    }

    // ---- close out this PLANNER WAVE: one total for exhaustion, regardless of how its individual
    // jobs performed (a wave that yields [20, 0, 0] across its jobs is a productive wave of 20). ----
    waves++;
    plannerWaveHistory.push(waveNewCandidates);
    appendJsonl(jobsLogPath, { event: "planner_wave_completed", wave: waves, job_hashes: waveJobHashes, new_candidates: waveNewCandidates, at: new Date().toISOString() });
    say(`  planner wave ${waves} complete: ${waveNewCandidates} new unique candidate(s) across ${waveJobHashes.length} search job(s)`);
    if (state.companies.size >= total) { stopReason = "reached this round's target unique-company count"; break; }
    if (researchExhausted(plannerWaveHistory)) { stopReason = "adaptive search exhausted: the last 2 of 3+ complete planner waves each produced ≤1 new unique company"; break; }
  }
  if (!stopReason) stopReason = waves >= MAX_WAVES ? "wave safety ceiling reached this call (resume to continue)" : "reached this round's target unique-company count";

  // ---- write outputs ----
  const { feed, sufficiency } = stateToFeed(spec, state);
  if (feed.length) writeCsv(feedPath, feed, FEED_COLS); else writeFileSync(feedPath, FEED_COLS.join(",") + "\n");
  if (sufficiency.length) writeCsv(evidPath, sufficiency, EVID_COLS); else writeFileSync(evidPath, EVID_COLS.join(",") + "\n");
  const unresolvedRows = [...state.unresolved.values()].map((u) => ({ company_name: u.name, best_evidence: u.evidence, source_url: u.source_url, status: "unresolved" }));
  if (unresolvedRows.length) writeCsv(unresolvedPath, unresolvedRows, UNRESOLVED_COLS); else writeFileSync(unresolvedPath, UNRESOLVED_COLS.join(",") + "\n");

  const evs = jobEvents();
  const discoverSubmits = evs.filter((e: any) => e.event === "search_submitting" && e.kind !== "domain-resolve");
  const completes = evs.filter((e: any) => e.event === "search_completed");
  const urlSet = new Set<string>(); const sourceDomainCounts: Record<string, number> = {};
  for (const c of completes) for (const u of (c.urls ?? [])) { urlSet.add(u); const h = normDomain(u); sourceDomainCounts[h] = (sourceDomainCounts[h] ?? 0) + 1; }
  const query_yield = discoverSubmits.map((s: any) => { const wr = evs.find((w: any) => w.event === "wave_extracted" && w.job_hash === s.job_hash); return { queries: s.search_queries, include_domains: s.include_domains ?? [], rationale: s.rationale, new_candidates: wr?.new_candidates ?? 0 }; });
  // Wave-level yield (what exhaustion actually decides on) — auditable independently of per-job query_yield.
  const planner_wave_yield = evs.filter((e: any) => e.event === "planner_wave_completed").map((e: any) => ({ wave: e.wave, job_count: (e.job_hashes ?? []).length, new_candidates: e.new_candidates }));
  const research_exhausted = researchExhausted(plannerWaveHistory) || stopReason.startsWith("adaptive search exhausted");

  const status = {
    search_calls: completes.length,
    search_jobs: discoverSubmits.length,
    queries_run: discoverSubmits.reduce((a: number, s: any) => a + (s.search_queries?.length ?? 0), 0),
    unique_urls_seen: urlSet.size,
    unique_company_candidates: state.companies.size,
    new_candidates_last_round: state.companies.size - startCount,
    unresolved_companies: state.unresolved.size,
    source_domain_counts: sourceDomainCounts,
    query_yield,
    planner_wave_yield,
    research_exhausted,
    stop_reason: stopReason,
    // kept for kept-run.ts's existing round-continuation (planNextRound) and report logic:
    matched: state.companies.size, requested_total: total, usable: feed.length,
    duplicates_removed: duplicatesThisCall, exhausted: research_exhausted,
    at: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "discovery-status.json"), JSON.stringify(status, null, 1));
  say(`${feed.length} unique companies → Eric's MERGE feed (${status.new_candidates_last_round} new this call; ${state.unresolved.size} unresolved companies held for review) → ${feedPath}`);
  say(`stop: ${stopReason}`);
}

if (process.argv[1]?.split("/").pop() === "parallel-search-discover.ts") main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

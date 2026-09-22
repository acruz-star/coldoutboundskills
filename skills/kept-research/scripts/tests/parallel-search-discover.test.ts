#!/usr/bin/env tsx
/**
 * Offline tests for parallel-search-discover.ts — NO network calls, NO spend. Every scenario is a
 * pure-function test against fixtures (the LLM planner/extractor calls are stood in for by fixed JSON
 * strings, exactly what the real model would be asked to return).
 *
 *     npx tsx skills/kept-research/scripts/tests/parallel-search-discover.test.ts
 *
 * Covers the offline scenarios from the Search-API migration spec:
 *   A. mixed Search results (LinkedIn / company-news / Reddit) → candidate + evidence records
 *   B. a social result names a company but not its domain → domain-resolution picks the canonical one
 *   C. Search evidence already proves a required fact → gapFields asks for nothing more
 *   D. resume: a completed search-job hash is never re-submitted
 *   E. poor first-round yield → the planner prompt carries the yield so round 2 must differ
 *   F. the candidate feed stays byte-compatible with Eric's MERGE feed (parallel-discover.ts's FEED_COLS)
 */
import {
  searchJobHash, parsePlannerResponse, plannerPrompt, parseExtractionResponse, applyExtracted,
  applyDomainResolution, pickOfficialDomainFromResults, stateToFeed, newDiscoveryState, researchExhausted,
  FEED_COLS, type SearchResult,
} from "../parallel-search-discover";
import { gapFields } from "../kept-lib";
import type { CampaignSpec } from "../kept-lib";

let pass = 0, fail = 0;
function assert(cond: unknown, msg: string) { if (cond) { pass++; } else { fail++; console.error(`FAIL: ${msg}`); } }
function eq(a: unknown, b: unknown, msg: string) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const spec: CampaignSpec = {
  spec_version: "1", campaign_slug: "retire-test", client_slug: "acme-client",
  source: { doc_id: "doc1", doc_title: "Test Doc", tab: "Retire Test", read_at: "2026-09-22T00:00:00Z", tab_sha256: "abc" },
  reference_date: "2026-09-22",
  companies: {
    icp: "Any company: the tab sets no industry or segment restriction",
    qualifies: ["Any company that the signal is about"],
    disqualifies: ["None stated by the campaign"],
    discovery: { objective: "a named small-business owner recently announced retirement or a business sale", match_conditions: [{ name: "retirement_signal", description: "a named owner has publicly announced retirement or intent to sell the business" }], entity_type: "companies" },
    exclude_domains: [],
  },
  signals: {
    research_brief: "Confirm the owner's retirement/sale announcement and identify the owner by name.",
    fields: [
      { name: "retiree_name", type: "string", description: "The full name of the owner who announced retirement or sale." },
      { name: "retirement_announced_at", type: "date", description: "The date the retirement/sale was announced." },
    ],
  },
  people: { recipient: { from_field: "retiree_name", titles: [], find_email: true }, find_email: true },
  rules: [{ id: "r1", description: "must have a named retiree", field: "signals.retiree_name", op: "exists", on_fail: "REVIEW", on_unknown: "REVIEW" }],
  variables: [],
  targets: { qualified_leads: 50, max_companies: 1000, source: "test" },
  budget: { max_usd: 100, source: "test" },
} as unknown as CampaignSpec;

// ---------------------------------------------------------------------------------------------
// A. mixed Search results → candidate + evidence records; social/news hosts never become company_domain
// ---------------------------------------------------------------------------------------------
{
  const results: SearchResult[] = [
    { url: "https://www.linkedin.com/in/jane-smith-baker", title: "Jane Smith - Owner - Acme Bakery | LinkedIn", excerpts: ["Jane Smith, owner of Acme Bakery, announced her retirement after 30 years."] },
    { url: "https://acmebakery.com/press/jane-retires", title: "Acme Bakery announces owner's retirement", excerpts: ["Acme Bakery's founder Jane Smith will retire on 2026-08-01, ending three decades at the helm."] },
    { url: "https://www.reddit.com/r/smallbusiness/comments/xyz", title: "Anyone know what's happening with Acme Bakery?", excerpts: ["Heard Acme Bakery's owner is retiring and might sell the shop."] },
  ];
  const plannerJson = JSON.stringify({
    candidates: [
      { source_url: results[0].url, company_name: "Acme Bakery", company_domain: "UNCLEAR", signal_person_name: "Jane Smith", signal_person_title: "Owner", signal_evidence: "LinkedIn profile states Jane Smith is the owner and is retiring.", fields: { retiree_name: "Jane Smith" } },
      { source_url: results[1].url, company_name: "Acme Bakery", company_domain: "acmebakery.com", signal_person_name: "Jane Smith", signal_person_title: "Owner", signal_evidence: "Press release confirms retirement announcement.", fields: { retiree_name: "Jane Smith", retirement_announced_at: "2026-08-01" } },
      { source_url: results[2].url, company_name: "Acme Bakery", company_domain: "UNCLEAR", signal_person_name: "UNCLEAR", signal_person_title: "UNCLEAR", signal_evidence: "Reddit thread speculates the owner is retiring and selling.", fields: {} },
    ],
  });
  const extracted = parseExtractionResponse(plannerJson, results, spec);
  eq(extracted.length, 3, "A: all three results plausibly identify a company → 3 extracted candidates");
  eq(extracted[0].company_domain, "", "A: LinkedIn result never becomes a company_domain");
  eq(extracted[1].company_domain, "acmebakery.com", "A: the company's own press page resolves the domain");
  eq(extracted[2].company_domain, "", "A: Reddit result never becomes a company_domain");

  const state = newDiscoveryState();
  const { added, duplicates } = applyExtracted(state, extracted, new Set());
  eq(added, ["acmebakery.com"], "A: exactly one unique company added (all three results are the same company)");
  eq(duplicates, 1, "A: the Reddit mention folds into the already-known company (counted as a repeat mention, not a new one)");
  eq(state.unresolved.size, 0, "A: same-batch reconciliation resolves the LinkedIn/Reddit mentions once the domain is known");
  const company = state.companies.get("acmebakery.com")!;
  eq(company.content.retiree_name, "Jane Smith", "A: retiree_name established from evidence");
  eq(company.content.retirement_announced_at, "2026-08-01", "A: retirement_announced_at established from the press page");

  const { feed, sufficiency } = stateToFeed(spec, state);
  eq(feed.length, 1, "A: feed has exactly one row for the one company");
  eq(feed[0].source, "parallel-search", "A: feed row is tagged source=parallel-search");
  eq(feed[0].findall_candidate_id, "", "A: findall_candidate_id kept blank for compatibility");
  assert(sufficiency[0].sufficient === "true" || sufficiency[0].sufficient === "false", "A: sufficiency row computed");
}

// ---------------------------------------------------------------------------------------------
// B. a social result names a company but not its domain → domain-resolution picks the canonical one
// ---------------------------------------------------------------------------------------------
{
  const state = newDiscoveryState();
  const socialOnly = parseExtractionResponse(JSON.stringify({ candidates: [
    { source_url: "https://www.instagram.com/p/abc123", company_name: "Riverside Hardware", company_domain: "UNCLEAR", signal_person_name: "Tom Rivera", signal_person_title: "Owner", signal_evidence: "Instagram post: owner Tom Rivera is retiring after 22 years.", fields: { retiree_name: "Tom Rivera" } },
  ] }), [{ url: "https://www.instagram.com/p/abc123", title: "Riverside Hardware", excerpts: ["owner Tom Rivera is retiring after 22 years"] }], spec);
  applyExtracted(state, socialOnly, new Set());
  assert(state.unresolved.has("riverside hardware"), "B: a social-only mention is held unresolved, not fed to Eric with a guessed domain");

  const domainResults: SearchResult[] = [
    { url: "https://www.yelp.com/biz/riverside-hardware", title: "Riverside Hardware - Yelp" },
    { url: "https://riversidehardwareco.com/", title: "Riverside Hardware Co. — Official Site" },
    { url: "https://www.facebook.com/RiversideHardware", title: "Riverside Hardware" },
  ];
  const picked = pickOfficialDomainFromResults("Riverside Hardware", domainResults);
  eq(picked, "riversidehardwareco.com", "B: domain-resolution filters out yelp/facebook and picks the company's own site");

  const isNew = applyDomainResolution(state, "Riverside Hardware", picked, new Set());
  assert(isNew, "B: resolving the domain produces a new company");
  assert(!state.unresolved.has("riverside hardware"), "B: no longer unresolved once the domain is found");
  const c = state.companies.get("riversidehardwareco.com")!;
  eq(c.content.retiree_name, "Tom Rivera", "B: evidence gathered while unresolved carries over once resolved");

  const unresolvedCase = pickOfficialDomainFromResults("Ghost Company", [{ url: "https://www.linkedin.com/company/ghost", title: "Ghost Company" }]);
  eq(unresolvedCase, "", "B: when every result is a non-company host, resolution correctly returns nothing (never fabricated)");
}

// ---------------------------------------------------------------------------------------------
// C. Search evidence already proves a required fact → gapFields asks for nothing more
// ---------------------------------------------------------------------------------------------
{
  const fullyEstablished = { retiree_name: "Jane Smith", retirement_announced_at: "2026-08-01", company_domain: "acmebakery.com", company_context: "Acme Bakery, a family-owned bakery." };
  eq(gapFields(spec, fullyEstablished), [], "C: no gap when Search discovery already established every required fact — no redundant second proof");

  const partial = { retiree_name: "UNCLEAR", company_domain: "acmebakery.com" };
  const gaps = gapFields(spec, partial);
  assert(gaps.includes("retiree_name"), "C: a genuinely missing required fact (nobody named) is still asked for");
}

// ---------------------------------------------------------------------------------------------
// D. resume: a completed search-job hash is never re-submitted
// ---------------------------------------------------------------------------------------------
{
  const job = { objective: spec.companies.discovery!.objective, search_queries: ["small business owner retiring", "family business owner retires sells"], rationale: "broad open-web pass" };
  const hash = searchJobHash(job);
  const sameJobReordered = { objective: job.objective, search_queries: [...job.search_queries].reverse(), rationale: "same tactic, queries reordered" };
  eq(searchJobHash(sameJobReordered), hash, "D: hash is stable regardless of query order (same tactic, same spend)");

  const plannerRepeats = JSON.stringify({ jobs: [job, { objective: "a materially different tactic", search_queries: ["family bakery owner steps down"], rationale: "new wording" }], exhausted: false });
  const { jobs } = parsePlannerResponse(plannerRepeats, new Set([hash]));
  eq(jobs.length, 1, "D: a job matching an already-tried hash is dropped; the new one survives");
  eq(jobs[0].rationale, "new wording", "D: the surviving job is the materially different one");
}

// ---------------------------------------------------------------------------------------------
// E. poor first-round yield → the planner prompt carries yield history so round 2 must differ
// ---------------------------------------------------------------------------------------------
{
  const weakHistory = [
    { queries: ["small business owner retiring"], include_domains: [], rationale: "broad open-web pass", new_candidates: 1, source_hosts: ["prnewswire.com"] },
    { queries: ["family business sale announcement"], include_domains: [], rationale: "wire-service framing", new_candidates: 0, source_hosts: [] },
  ];
  const { user } = plannerPrompt(spec, weakHistory, { uniqueCount: 1, qualifiedCount: 0, target: 50 });
  assert(user.includes("small business owner retiring"), "E: the prompt shows the exact tried queries");
  assert(user.includes("1 new candidate"), "E: the prompt shows the observed yield per tactic");
  assert(!/\bAngle\b/.test(user) && !/\bTitle\(s\)\b/.test(user), "E: the planner is never shown Angle or Title(s) — signal only");
  assert(user.includes("materially different"), "E: weak yield explicitly instructs materially different tactics next round");
  eq(researchExhausted([1, 0]), false, "E: two weak waves alone is not yet exhaustion (needs 3+ waves)");
  eq(researchExhausted([1, 0, 0]), true, "E: three waves with the last two near-zero IS exhaustion");
  eq(researchExhausted([1, 5, 6]), false, "E: healthy yield is never exhausted");
}

// ---------------------------------------------------------------------------------------------
// F. candidate feed stays compatible with Eric's MERGE feed
// ---------------------------------------------------------------------------------------------
{
  eq(FEED_COLS, ["domain", "name", "description", "source", "findall_candidate_id"], "F: FEED_COLS unchanged from the legacy FindAll feed shape Eric's MERGE (extra_candidates) expects");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

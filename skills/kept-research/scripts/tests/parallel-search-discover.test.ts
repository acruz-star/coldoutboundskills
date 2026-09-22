#!/usr/bin/env tsx
/**
 * Offline tests for parallel-search-discover.ts — NO network calls, NO spend. Every scenario is a
 * pure-function test against fixtures (the LLM planner/extractor calls are stood in for by fixed JSON
 * strings, exactly what the real model would be asked to return).
 *
 *     npx tsx skills/kept-research/scripts/tests/parallel-search-discover.test.ts
 *
 * Covers the offline scenarios from the Search-API migration spec, plus the 2026-09-22 hardening pass:
 *   A. mixed Search results (LinkedIn / company-news / Reddit) → candidate + evidence records
 *   B. a social result names a company but not its domain → domain-resolution picks the canonical one
 *   C. Search evidence already proves a required fact → gapFields asks for nothing more
 *   D. resume: a completed search-job hash is never re-submitted
 *   E. poor first-round yield → the planner prompt carries the yield so round 2 must differ
 *   F. the candidate feed stays byte-compatible with Eric's MERGE feed (parallel-discover.ts's FEED_COLS)
 *   G. the search planner sees ONLY the Signal/s objective + match_conditions — never research_brief,
 *      signal field names, titles, rules, recipient logic, or ICP/industry/segment language
 *   H. research exhaustion is decided on PLANNER-WAVE totals, never on individual search-job yields
 *   I. company_domain is accepted only when grounded in the cited Search result itself — never a
 *      model-invented domain, and domain resolution never resolves to an unrelated/similarly-named site
 */
import {
  searchJobHash, parsePlannerResponse, plannerPrompt, parseExtractionResponse, applyExtracted,
  applyDomainResolution, pickOfficialDomainFromResults, domainGroundedInResult, stateToFeed,
  newDiscoveryState, researchExhausted, FEED_COLS, type SearchResult, type DiscoverySignal,
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
    icp: "Family-owned home services businesses (plumbing, HVAC, electrical)",
    qualifies: ["Company operates in residential home services"],
    disqualifies: ["Publicly traded companies", "Companies with 500+ employees"],
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
  people: { recipient: { from_field: "retiree_name", titles: ["general manager", "chief operating officer"], find_email: true }, find_email: true },
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
  const signal: DiscoverySignal = { objective: spec.companies.discovery!.objective, match_conditions: spec.companies.discovery!.match_conditions };
  const { user } = plannerPrompt(signal, weakHistory, { uniqueCount: 1, qualifiedCount: 0, target: 50 });
  assert(user.includes("small business owner retiring"), "E: the prompt shows the exact tried queries");
  assert(user.includes("1 new candidate"), "E: the prompt shows the observed yield per tactic");
  assert(!/\bAngle\b/.test(user) && !/\bTitle\(s\)\b/.test(user), "E: the planner is never shown Angle or Title(s) — signal only");
  assert(user.includes("materially different"), "E: weak yield explicitly instructs materially different tactics next round");
}

// ---------------------------------------------------------------------------------------------
// F. candidate feed stays compatible with Eric's MERGE feed
// ---------------------------------------------------------------------------------------------
{
  eq(FEED_COLS, ["domain", "name", "description", "source", "findall_candidate_id"], "F: FEED_COLS unchanged from the legacy FindAll feed shape Eric's MERGE (extra_candidates) expects");
}

// ---------------------------------------------------------------------------------------------
// G. the search planner is Signal/s-ONLY — structurally, not just by convention
// ---------------------------------------------------------------------------------------------
{
  const signal: DiscoverySignal = { objective: spec.companies.discovery!.objective, match_conditions: spec.companies.discovery!.match_conditions };
  eq(Object.keys(signal).sort(), ["match_conditions", "objective"], "G: plannerPrompt's input type carries ONLY objective + match_conditions — no path to pass research_brief/fields/titles/rules even by mistake");

  const { system, user } = plannerPrompt(signal, [], { uniqueCount: 0, qualifiedCount: 12, target: 50 });
  const combined = `${system}\n${user}`;
  const FORBIDDEN = [
    spec.signals.research_brief,                        // research_brief text itself
    "retiree_name", "retirement_announced_at",           // signal field names
    "general manager", "chief operating officer",         // Title(s)
    "Family-owned home services",                        // companies.icp
    "residential home services", "Publicly traded",       // qualifies / disqualifies (Industry/Segment)
  ];
  for (const banned of FORBIDDEN) assert(!combined.includes(banned), `G: planner prompt never contains "${banned}"`);
  assert(combined.includes(spec.companies.discovery!.objective), "G: planner prompt DOES contain the discovery objective (the one thing it's allowed to see)");
  assert(combined.includes("downstream qualified so far: 12"), "G: planner may see the downstream qualified COUNT only, nothing else about qualification");
}

// ---------------------------------------------------------------------------------------------
// H. research exhaustion is decided on PLANNER-WAVE totals, never individual search-job yields
// ---------------------------------------------------------------------------------------------
{
  // Regression case: one planner wave whose 4 individual search jobs yield [5, 0, 0, 0] — a healthy
  // wave (5 new companies) whose job-level array would have length >= 3 with a [0, 0] tail. The OLD
  // (buggy) code fed job-level yields straight into researchExhausted and would have called this
  // exhausted after a single wave. The fix: only the wave's ONE total (5) is ever passed in.
  const jobYieldsWithinOneWave = [5, 0, 0, 0];
  const waveTotal = jobYieldsWithinOneWave.reduce((a, b) => a + b, 0);
  eq(waveTotal, 5, "H: one planner wave's total is the SUM of its jobs' yields");
  eq(researchExhausted(jobYieldsWithinOneWave), true, "H: (documents the bug) feeding job-level yields directly would have wrongly called this exhausted");
  eq(researchExhausted([waveTotal]), false, "H: feeding the correct wave-level total (just one completed wave) is NOT exhausted — only 1 of the required 3+ waves has run");

  // "wave 1 jobs produce [20, 0, 0] => wave yield 20, NOT exhausted"
  const wave1JobYields = [20, 0, 0];
  const wave1Total = wave1JobYields.reduce((a, b) => a + b, 0);
  eq(wave1Total, 20, "H: wave 1's total across its jobs is 20");
  eq(researchExhausted([wave1Total]), false, "H: a single productive wave (20) is never exhausted regardless of its jobs' individual spread");

  // "planner-wave yields [20, 0, 0] => exhausted only after those are 3 separate completed planner waves"
  eq(researchExhausted([20, 0]), false, "H: two completed planner waves is not yet enough (needs 3+)");
  eq(researchExhausted([20, 0, 0]), true, "H: three completed planner waves whose last two totaled ≤1 each IS exhausted");

  // "yields [20, 0, 8] => not exhausted"
  eq(researchExhausted([20, 0, 8]), false, "H: the last wave being productive (8) means NOT exhausted even after 3 waves");
}

// ---------------------------------------------------------------------------------------------
// I. company_domain grounding is deterministic — never a model-invented domain, never an unrelated site
// ---------------------------------------------------------------------------------------------
{
  // I.1 — LinkedIn post names Acme; extractor invents acme.com but the result never mentions it => rejected.
  const linkedinResult: SearchResult = { url: "https://www.linkedin.com/in/someone", title: "Someone - Owner - Acme | LinkedIn", excerpts: ["Owner of Acme is retiring."] };
  assert(!domainGroundedInResult("acme.com", linkedinResult), "I.1: domainGroundedInResult rejects a domain absent from the result's own url/title/excerpts");
  const invented = parseExtractionResponse(JSON.stringify({ candidates: [
    { source_url: linkedinResult.url, company_name: "Acme", company_domain: "acme.com", signal_person_name: "Someone", signal_person_title: "Owner", signal_evidence: "LinkedIn profile.", fields: {} },
  ] }), [linkedinResult], spec);
  eq(invented[0].company_domain, "", "I.1: an invented company_domain with no support in the cited result is rejected — company stays unresolved, never a guessed domain");

  // Same case, but the excerpt DOES state the domain — now it's grounded and accepted.
  const stated: SearchResult = { url: "https://www.linkedin.com/in/someone", title: "Someone - Owner - Acme | LinkedIn", excerpts: ["Owner of Acme (acme.com) is retiring."] };
  const groundedCase = parseExtractionResponse(JSON.stringify({ candidates: [
    { source_url: stated.url, company_name: "Acme", company_domain: "acme.com", signal_person_name: "Someone", signal_person_title: "Owner", signal_evidence: "LinkedIn profile states the company's site.", fields: {} },
  ] }), [stated], spec);
  eq(groundedCase[0].company_domain, "acme.com", "I.1b: a domain the source result itself states IS accepted");

  // I.2 — focused search returns a news article (localnews.com) AND the true acme.com official page => choose acme.com.
  const mixedResults: SearchResult[] = [
    { url: "https://localnews.com/2026/09/acme-corp-to-close-plant", title: "Acme Corp to close local plant" },
    { url: "https://acme.com/", title: "Acme Corp — Official Site" },
  ];
  eq(pickOfficialDomainFromResults("Acme Corp", mixedResults), "acme.com", "I.2: a topical news mention never outranks the company's own official site");

  // I.3 — focused search returns only unrelated third-party pages => no domain, never a guess.
  const unrelatedOnly: SearchResult[] = [
    { url: "https://localnews.com/2026/09/small-business-roundup", title: "Small business roundup" },
    { url: "https://randomblog.example.com/post", title: "My thoughts on retirement" },
  ];
  eq(pickOfficialDomainFromResults("Acme Corp", unrelatedOnly), "", "I.3: pages with no defensible name/identity support never resolve a domain");

  // I.4 — similarly named companies cannot silently resolve to the wrong site.
  const similarlyNamed: SearchResult[] = [
    { url: "https://acmeplumbing.com/", title: "Acme Plumbing Co. — Official Site" },
  ];
  eq(pickOfficialDomainFromResults("Acme Hardware", similarlyNamed), "", "I.4: a different company that merely shares the word \"Acme\" does not silently resolve as the match");

  // I.4b — the genuine match still resolves correctly when present alongside the similarly-named decoy.
  const genuineAmongDecoys: SearchResult[] = [
    { url: "https://acmeplumbing.com/", title: "Acme Plumbing Co. — Official Site" },
    { url: "https://acmehardwareco.com/", title: "Acme Hardware Co. — Official Site" },
  ];
  eq(pickOfficialDomainFromResults("Acme Hardware", genuineAmongDecoys), "acmehardwareco.com", "I.4b: the genuine official site still wins even with a similarly-named decoy present");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

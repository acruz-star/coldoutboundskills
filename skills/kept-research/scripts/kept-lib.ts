/**
 * Shared helpers for the kept-research skill.
 *
 * Everything generic (env, csv, args, http, domain normalization, concurrency)
 * comes from list-expander's lib.ts. This file only adds what Eric's system has
 * no equivalent for: the campaign-spec contract, the Parallel.ai + Quick Enrich
 * clients, the spend ledger, and JSONL state.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { httpJson, sleep, readCsv, writeCsv, normDomain } from "../../list-expander/scripts/lib";

// ---------- campaign spec ----------
export type MatchCondition = { name: string; description: string };
export type SignalField = { name: string; type: "string" | "number" | "boolean" | "date" | "enum"; enum?: string[]; description: string };
export type Rule = {
  id: string; description: string; field: string;
  op: "eq" | "ne" | "in" | "not_in" | "gte" | "lte" | "gt" | "lt" | "is_true" | "is_false" | "exists" | "date_gte" | "date_lte" | "contains" | "not_contains";
  value?: unknown; on_fail: "REJECT" | "REVIEW"; on_unknown: "REVIEW" | "REJECT" | "PASS";
};
export type CampaignSpec = {
  spec_version: string; campaign_slug: string; client_slug: string;
  source: { doc_id: string; doc_title: string; tab: string; read_at: string; tab_sha256: string };
  reference_date: string;
  companies: {
    icp: string; qualifies: string[]; disqualifies: string[]; lean?: string; thin_evidence_lean?: "YES" | "NO";
    discovery?: { objective: string; entity_type?: string; match_conditions: MatchCondition[]; generator?: "preview" | "base" | "core" | "pro"; match_limit?: number };
    seeds?: string[]; exclude_domains?: string[]; company_list_csv?: string | null;
  };
  signals: { processor?: string; research_brief: string; fields: SignalField[] };
  people: {
    recipient: {
      from_field?: string | null; title_field?: string | null; titles: string[]; title_excludes?: string[]; max_per_company?: number;
      /** Optional signal field holding the named person's LinkedIn URL — the strongest Quick Enrich identity input. */
      linkedin_field?: string | null;
      /** Ordered named-person alternates, tried only when from_field is not established (e.g. a
       *  continuity owner when the retiree has no boss). Each names a person the research identified. */
      fallbacks?: { from_field: string; title_field?: string | null; linkedin_field?: string | null; label: string }[];
      /** Default true (unchanged behaviour): with no named person, pick the best title match from
       *  Quick Enrich. false = never pick someone just for their rank; no named person ⇒ no recipient. */
      pick_by_title_when_unnamed?: boolean;
    };
    find_email: boolean; on_no_recipient?: "REVIEW" | "REJECT"; on_no_email?: "REVIEW" | "REJECT";
  };
  rules: Rule[];
  review_policy?: { max_unresolved?: number };
  variables: { name: string; from: string; required?: boolean }[];
  /** Volume. qualified_leads = MINIMUM SUCCESS THRESHOLD (default 50; never a stop); max_companies = ceiling (default 1,000). */
  targets: { qualified_leads: number; max_companies: number; source?: string };
  /** Where newly QUALIFIED leads go after the run. Omit it: list = "Kept | <tab name>", upload on.
   *  Always a LEAD LIST, never a campaign. */
  instantly?: { lead_list?: string; upload?: boolean };
  /** Parallel spend cap only. Quick Enrich is unlimited: there is no credit cap (lookups are still logged). */
  budget: { max_usd: number; source?: string };
};

export const BUILTIN_FIELDS = ["company_domain", "company_context", "icp_evidence", "contradictions"];
const OPS = new Set(["eq", "ne", "in", "not_in", "gte", "lte", "gt", "lt", "is_true", "is_false", "exists", "date_gte", "date_lte", "contains", "not_contains"]);
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Validate a spec; returns the list of problems (empty = valid). Never throws. */
export function validateSpec(s: any): string[] {
  const e: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) e.push(msg); };
  need(s && typeof s === "object", "spec is not an object");
  if (e.length) return e;
  need(SLUG.test(s.campaign_slug ?? ""), "campaign_slug must be lowercase kebab-case");
  need(SLUG.test(s.client_slug ?? ""), "client_slug must be lowercase kebab-case");
  need(s.source?.doc_id && s.source?.tab && s.source?.tab_sha256, "source.doc_id / source.tab / source.tab_sha256 are required (provenance of the Google Doc tab)");
  need(/^\d{4}-\d{2}-\d{2}$/.test(s.reference_date ?? ""), "reference_date must be YYYY-MM-DD");
  need(s.companies?.icp, "companies.icp one-liner is required");
  need(Array.isArray(s.companies?.qualifies) && s.companies.qualifies.length, "companies.qualifies needs at least one bullet");
  need(Array.isArray(s.companies?.disqualifies) && s.companies.disqualifies.length, "companies.disqualifies needs at least one bullet");
  const d = s.companies?.discovery;
  const hasList = !!s.companies?.company_list_csv || (s.companies?.seeds ?? []).length > 0;
  need(d || hasList, "companies needs discovery, company_list_csv, or seeds — otherwise there is nothing to research");
  if (d) {
    need(d.objective, "companies.discovery.objective is required");
    need(Array.isArray(d.match_conditions) && d.match_conditions.length, "companies.discovery.match_conditions needs at least one condition");
    // discovery is SIGNAL-ONLY: the ICP, geography, size, industry and exclusions are qualification, decided later by Eric's stages
    // phrases that only occur in ICP / size / geography language, never in a signal (a signal may mention "an employee")
    const ICP_LANGUAGE = /\b(headquartered in|is headquartered|based in the united states|\d[\d,]*\s*(to|-|–)\s*\d[\d,]*\s*employees|employee count|headcount|annual revenue|is an operating business|operating businesses|privately held|family[- ]owned|industrial manufacturer)\b/i;
    for (const c of d.match_conditions ?? []) need(!/^icp_fit$/.test(c.name) && !ICP_LANGUAGE.test(c.description ?? ""), `companies.discovery.match_conditions "${c.name}" reads like ICP / qualification, not the signal — discovery must be broad; move it to companies.qualifies/disqualifies or rules`);
    need(!ICP_LANGUAGE.test(d.objective ?? ""), "companies.discovery.objective must describe the SIGNAL only (no HQ / size / industry / ownership restrictions — those are qualification)");
    need(d.match_limit == null || (Number.isInteger(d.match_limit) && d.match_limit >= 5 && d.match_limit <= 1000), "companies.discovery.match_limit (first-round size) must be an integer 5-1000 when given");
    need(!d.generator || ["preview", "base", "core", "pro"].includes(d.generator), "companies.discovery.generator must be preview|base|core|pro");
  }
  if (s.companies?.company_list_csv) need(existsSync(s.companies.company_list_csv), `company_list_csv not found: ${s.companies.company_list_csv}`);
  need(s.signals?.research_brief, "signals.research_brief is required");
  const fields: SignalField[] = s.signals?.fields ?? [];
  need(fields.length > 0, "signals.fields needs at least one field");
  const fieldNames = new Set<string>();
  for (const f of fields) {
    need(/^[a-z][a-z0-9_]*$/.test(f.name ?? ""), `signal field name "${f.name}" must be snake_case`);
    need(!fieldNames.has(f.name), `duplicate signal field "${f.name}"`);
    fieldNames.add(f.name);
    need(["string", "number", "boolean", "date", "enum"].includes(f.type), `signal field ${f.name}: bad type "${f.type}"`);
    need(f.type !== "enum" || (Array.isArray(f.enum) && f.enum.length), `signal field ${f.name}: enum type needs enum values`);
    need(f.description, `signal field ${f.name}: description is required (it is the research question)`);
  }
  for (const b of BUILTIN_FIELDS) fieldNames.add(b); // always asked of Parallel, usable in rules/variables
  const okPath = (p: string) => {
    const [root, key] = String(p ?? "").split(".");
    if (root === "signals") return fieldNames.has(key);
    return (root === "company" || root === "recipient") && !!key;
  };
  const r = s.people?.recipient;
  need(r, "people.recipient is required");
  if (r) {
    need(Array.isArray(r.titles), "people.recipient.titles must be an array (may be empty only when from_field is set)");
    need(r.from_field || (r.titles ?? []).length, "people.recipient needs from_field (a signal field naming the person) or titles");
    need(!r.from_field || fieldNames.has(r.from_field), `people.recipient.from_field "${r.from_field}" is not a signal field`);
    need(!r.title_field || fieldNames.has(r.title_field), `people.recipient.title_field "${r.title_field}" is not a signal field`);
    need(!r.linkedin_field || fieldNames.has(r.linkedin_field), `people.recipient.linkedin_field "${r.linkedin_field}" is not a signal field`);
    for (const f of r.fallbacks ?? []) {
      need(!f.linkedin_field || fieldNames.has(f.linkedin_field), `people.recipient.fallbacks: linkedin_field "${f.linkedin_field}" is not a signal field`);
      need(f.label && fieldNames.has(f.from_field), `people.recipient.fallbacks: from_field "${f.from_field}" is not a signal field (and label is required)`);
      need(!f.title_field || fieldNames.has(f.title_field), `people.recipient.fallbacks: title_field "${f.title_field}" is not a signal field`);
    }
    need(r.pick_by_title_when_unnamed == null || typeof r.pick_by_title_when_unnamed === "boolean", "people.recipient.pick_by_title_when_unnamed must be true or false");
  }
  need(typeof s.people?.find_email === "boolean", "people.find_email must be true or false");
  need(Array.isArray(s.rules) && s.rules.length, "rules needs at least one rule");
  const ids = new Set<string>();
  for (const rule of s.rules ?? []) {
    need(rule.id && !ids.has(rule.id), `rule id "${rule.id}" missing or duplicated`);
    ids.add(rule.id);
    need(OPS.has(rule.op), `rule ${rule.id}: unknown op "${rule.op}"`);
    need(okPath(rule.field), `rule ${rule.id}: field "${rule.field}" must be signals.<declared field>, company.<col>, or recipient.<col>`);
    need(["REJECT", "REVIEW"].includes(rule.on_fail), `rule ${rule.id}: on_fail must be REJECT or REVIEW`);
    need(["REVIEW", "REJECT", "PASS"].includes(rule.on_unknown), `rule ${rule.id}: on_unknown must be REVIEW, REJECT or PASS`);
    need(["is_true", "is_false", "exists"].includes(rule.op) || rule.value !== undefined, `rule ${rule.id}: op ${rule.op} needs a value`);
  }
  for (const v of s.variables ?? []) need(v.name && okPath(v.from), `variable "${v.name}": from "${v.from}" must be signals.<declared field>, company.<col>, or recipient.<col>`);
  need(s.targets?.qualified_leads == null || (Number.isInteger(s.targets.qualified_leads) && s.targets.qualified_leads > 0), "targets.qualified_leads must be a positive integer when given");
  need(s.targets?.max_companies == null || (Number.isInteger(s.targets.max_companies) && s.targets.max_companies >= 5 && s.targets.max_companies <= 1000), "targets.max_companies must be an integer 5-1000 when given (Parallel FindAll's match ceiling is 1000)");
  // budget is optional: when the tab is silent the built-in per-run cap applies (see loadSpec)
  need(s.budget?.max_usd == null || Number(s.budget.max_usd) > 0, "budget.max_usd must be a positive number when given");
  need(s.instantly == null || ((s.instantly.lead_list == null || (typeof s.instantly.lead_list === "string" && s.instantly.lead_list.trim())) && (s.instantly.upload == null || typeof s.instantly.upload === "boolean")), "instantly must be { lead_list?: non-empty string, upload?: boolean }");
  need(!s.instantly || !("campaign" in s.instantly) && !("campaign_id" in s.instantly), "instantly may only name a lead_list — this skill never adds leads to a campaign");
  // a legacy budget.max_quickenrich_credits in an older spec is tolerated and ignored — Quick Enrich is unlimited
  return e;
}

export function loadSpec(path: string): CampaignSpec {
  const s = JSON.parse(readFileSync(path, "utf8"));
  const errs = validateSpec(s);
  if (errs.length) { console.error(`campaign-spec invalid (${path}):\n` + errs.map((x) => `  - ${x}`).join("\n")); process.exit(2); }
  s.targets = { qualified_leads: Number(s.targets?.qualified_leads ?? DEFAULT_TARGET_QUALIFIED), max_companies: Number(s.targets?.max_companies ?? DEFAULT_MAX_COMPANIES), source: s.targets?.qualified_leads != null || s.targets?.max_companies != null ? "campaign tab / operator" : "global default" };
  s.budget = { max_usd: Number(s.budget?.max_usd ?? DEFAULT_MAX_USD), source: s.budget?.max_usd != null ? "campaign tab" : "global default" };
  return s;
}

export function runDirFor(spec: { client_slug: string; campaign_slug: string }): string {
  // Same root Eric's run-lane uses, so fleet.ts and the registry see kept-research lanes.
  return join(homedir(), "output", "list-builder", "lanes", `${spec.client_slug}-${spec.campaign_slug}`);
}

// ---------- research set ----------
// The companies that progress past Eric's company gates. The ONLY way in is his lane: MERGE → SCORE (ICP
// judge) → REJECT_AUDIT → VERIFY (company/website validation) → FINALIZE → lane-final.csv. How VERIFY was
// satisfied is recorded per company:
//   parallel_evidence        his validation stage passed on Parallel's canonical domain + cited ICP evidence
//   primary                  his live website check passed
//   secondary_* / unverified_review   his live check failed → verify-fallback.ts second opinion, or REVIEW
export type VerifyPath = "parallel_evidence" | "primary" | "secondary_alt_fetch" | "secondary_cited_sources" | "unverified_review";
export function researchSetPath(runDir: string): string { return join(runDir, "research-set.csv"); }
export function buildResearchSet(runDir: string): Record<string, string>[] {
  const rd = (f: string) => (existsSync(join(runDir, f)) ? readCsv(join(runDir, f)) : []);
  const verified = new Map(rd("verified.stream.csv").map((r) => [normDomain(r.domain), r]));
  const set = new Map<string, Record<string, string>>();
  for (const r of rd("lane-final.csv")) {
    const d = normDomain(r.domain); const v = verified.get(d);
    const byEvidence = v?.website_status === "parallel_evidence";
    if (!set.has(d)) set.set(d, { ...r, domain: d, company_url: `https://${d}`, verify_path: byEvidence ? "parallel_evidence" : "primary", verify_note: byEvidence ? v!.live_reason : "" });
  }
  for (const r of rd("verify-fallback.csv")) { const d = normDomain(r.domain); if (r.verify_path !== "rejected" && !set.has(d)) set.set(d, { domain: d, name: r.name, company_url: `https://${d}`, confidence: verified.get(d)?.confidence ?? "", live_reason: r.secondary_reason, verify_path: r.verify_path, verify_note: `primary check: ${r.primary_verdict} (${r.site_state}); second opinion: ${r.secondary_verdict} — ${r.secondary_reason}` }); }
  const rows = [...set.values()];
  const cols = [...new Set(["domain", "name", "company_url", "confidence", "live_reason", "verify_path", "verify_note", ...rows.flatMap((r) => Object.keys(r))])];
  if (rows.length) writeCsv(researchSetPath(runDir), rows, cols); else writeFileSync(researchSetPath(runDir), cols.join(",") + "\n");
  return rows;
}

/** Registrable (root) domain — the company dedupe key. "investors.acme.co.uk" → "acme.co.uk". */
const TWO_LEVEL_TLD = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
export function rootDomain(input: string): string {
  const d = normDomain(input); const p = d.split(".");
  if (p.length <= 2) return d;
  return p.slice(TWO_LEVEL_TLD.test(d) ? -3 : -2).join(".");
}

// ---------- values ----------
const UNKNOWN = /^(|unclear|unknown|n\/a|na|none|null|not found|not stated)$/i;
export function isUnknown(v: unknown): boolean { return v == null || (typeof v === "string" && UNKNOWN.test(v.trim())); }
/** Parallel returns JSON numbers as floats and sometimes numeric strings — coerce before any numeric gate. */
export function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim().replace(/,/g, ""))) return Number(v.trim().replace(/,/g, ""));
  return null;
}

// ---------- JSONL (append-only state; split on \n only — U+2028 inside excerpts is legal JSON) ----------
export function readJsonl<T = any>(p: string): T[] {
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn final line */ } }
  return out;
}
export function appendJsonl(p: string, rec: unknown): void { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(rec) + "\n"); }

// ---------- spend ledger ----------
// Every paid submission is written here BEFORE the result is read, so a crash
// can be reconciled from provider-side ids instead of paying twice.
export type SpendEvent = { at: string; provider: "parallel" | "quickenrich"; kind: string; id?: string; est_usd?: number; credits?: number; note?: string };
export function ledgerPath(runDir: string): string { return join(runDir, "spend-ledger.jsonl"); }
export function logSpend(runDir: string, ev: Omit<SpendEvent, "at">): void { appendJsonl(ledgerPath(runDir), { at: new Date().toISOString(), ...ev }); }
export function spentSoFar(runDir: string): { usd: number; credits: number } {
  let usd = 0, credits = 0;
  for (const e of readJsonl<SpendEvent>(ledgerPath(runDir))) { usd += Number(e.est_usd ?? 0); credits += Number(e.credits ?? 0); }
  return { usd, credits };
}
/** Paid scripts run only under kept-run.ts — the one place the per-run spend cap is
 *  checked BEFORE anything is submitted. Calling a paid script directly is refused. */
export function requireSpendApproval(what: string): void {
  if (process.env.KEPT_SPEND_APPROVED !== "1") {
    console.error(`REFUSING paid step (${what}): run it through kept-run.ts, which enforces the per-run spend cap.`);
    process.exit(3);
  }
}

// GLOBAL VOLUME RULE for every campaign research run (operator rule, 2026-09-21): inspect up to 1,000
// unique companies and KEEP EVERY lead that passes the full qualification standard. 50 qualified leads is
// the MINIMUM SUCCESS THRESHOLD, never a stopping condition, and never a reason to lower a standard.
// A campaign tab may state a different target; when it is silent, these apply.
export const DEFAULT_TARGET_QUALIFIED = 50;
export const DEFAULT_MAX_COMPANIES = 1000;
export const FIRST_BATCH_COMPANIES = 50; // first discovery round when the tab gives no discovery limit

// Built-in per-run Parallel cap. The Doc tab (spec.budget.max_usd) may set its own; when it is silent this applies.
// Quick Enrich has NO cap — treated as unlimited; credits are only counted for the summary.
export const DEFAULT_MAX_USD = Number(process.env.KEPT_MAX_USD ?? 100); // global Parallel cap per campaign run (operator rule, 2026-09-21)

// Estimates only — used for the pre-run plan and the budget ceiling. Check current
// Parallel pricing before trusting them; the ledger records estimates, not invoices.
export const FINDALL_EST = { preview: { fixed: 0.1, per_match: 0 }, base: { fixed: 0.25, per_match: 0.03 }, core: { fixed: 2, per_match: 0.15 }, pro: { fixed: 10, per_match: 1 } } as const;
export const TASK_EST_PER_RUN: Record<string, number> = { lite: 0.005, base: 0.01, core: 0.025, core2x: 0.05, pro: 0.1, ultra: 0.3 };

// ---------- Parallel.ai ----------
const PARALLEL_BASE = "https://api.parallel.ai";
export function parallelKey(): string {
  const k = process.env.PARALLEL_API_KEY ?? process.env.PARALLEL_AI_API_KEY ?? "";
  if (!k) { console.error("Missing env: PARALLEL_API_KEY — add it to the repo-root .env or ~/.env"); process.exit(1); }
  return k;
}
export async function parallel(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 120_000): Promise<any> {
  let last: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await httpJson(`${PARALLEL_BASE}${path}`, { method, headers: { "x-api-key": parallelKey() }, body, timeoutMs })
      .catch((err) => ({ _network_error: String(err?.message ?? err) }));
    const status = last?._http_status;
    // GETs are safe to retry. A POST is retried ONLY on 429 (request was not accepted);
    // a network error on a POST is ambiguous — surface it so the caller reconciles.
    if (last?._network_error) { if (method === "GET") { await sleep(3000 * (attempt + 1)); continue; } return last; }
    if (status === 429 || (method === "GET" && status >= 500)) { await sleep(5000 * (attempt + 1)); continue; }
    return last;
  }
  return last;
}

// ---------- Quick Enrich ----------
const QE_BASE = "https://app.quickenrich.io/api";
export function quickEnrichKey(): string {
  const k = process.env.QUICKENRICH_API_KEY ?? "";
  if (!k) { console.error("Missing env: QUICKENRICH_API_KEY — add it to the repo-root .env or ~/.env"); process.exit(1); }
  return k;
}
/** 120 req/min ceiling on the finder endpoints — callers pace at >= 500ms. */
export async function quickEnrich(method: "GET" | "POST", path: string, body?: unknown, paid = false): Promise<any> {
  let last: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await httpJson(`${QE_BASE}${path}`, { method, headers: { Authorization: `Bearer ${quickEnrichKey()}`, Accept: "application/json" }, body, timeoutMs: 60_000 })
      .catch((err) => ({ _network_error: String(err?.message ?? err) }));
    const status = last?._http_status;
    // A paid lookup is retried only on 429 (not accepted). Anything ambiguous is returned
    // so the caller records it as an error instead of risking a second credit.
    if (status === 429 || (!paid && (status >= 500 || last?._network_error))) { await sleep(2000 * 2 ** attempt); continue; }
    return last;
  }
  return last;
}

// ---------- round sizing ----------
/** How many more companies the next discovery round should buy, or the reason the run ends.
 *  VOLUME RULE: inspect up to maxCompanies and keep EVERY lead that passes. `target` is the MINIMUM
 *  SUCCESS THRESHOLD — reaching it never stops the run. Pure, so the policy is testable without spending. */
export function planNextRound(a: { qualified: number; inspected: number; total: number; target: number; maxCompanies: number; capUsd: number; spentUsd: number; perCompanyUsd: number; exhausted: boolean; matched?: number; hasDiscovery: boolean }): { next: number; stop: string } {
  if (!a.hasDiscovery) return { next: 0, stop: "single pass: the tab supplied a company list / seeds and no discovery signal" };
  if (a.exhausted) return { next: 0, stop: `discovery exhausted: FindAll matched ${a.matched ?? "fewer"} of the ${a.total} requested` };
  if (a.total >= a.maxCompanies) return { next: 0, stop: `company ceiling reached (${a.maxCompanies} unique companies inspected)` };
  // below the threshold: size from observed yield (floored at 5%); at/above it: keep sweeping in full rounds
  const yieldRate = Math.max(a.qualified / Math.max(a.inspected, 1), 0.05);
  const wanted = a.qualified >= a.target ? 250 : Math.min(250, Math.max(25, Math.ceil(((a.target - a.qualified) / yieldRate) * 1.2)));
  const canAfford = Math.floor((a.capUsd - a.spentUsd) / a.perCompanyUsd);
  const next = Math.min(wanted, a.maxCompanies - a.total, canAfford);
  if (next < 5) return { next: 0, stop: canAfford < 5 ? `Parallel spend cap: ~$${a.spentUsd.toFixed(2)} of $${a.capUsd} used; another useful round (≥5 companies) would exceed it` : `company ceiling reached (${a.maxCompanies} unique companies inspected)` };
  return { next, stop: "" };
}

// ---------- Parallel evidence schema (shared by discovery enrichment and gap research) ----------
export const UNCLEAR = "UNCLEAR";
/** JSON-schema properties for the campaign's signal fields (+ built-ins). Every field is a string so
 *  "not established" is always expressible; qualify.ts coerces. `only` limits it to a subset (gap research). */
export function signalSchema(spec: CampaignSpec, only?: Set<string>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const f of spec.signals.fields) {
    if (only && !only.has(f.name)) continue;
    const base = `${f.description} Answer only from sources you can cite. If the sources do not establish this, answer exactly "${UNCLEAR}" — never guess.`;
    if (f.type === "enum") props[f.name] = { type: "string", enum: [...(f.enum ?? []), UNCLEAR], description: base };
    else if (f.type === "boolean") props[f.name] = { type: "string", enum: ["true", "false", UNCLEAR], description: base };
    else if (f.type === "number") props[f.name] = { type: "string", description: `${base} Digits only (e.g. 12 or 3.5), no units or words.` };
    else if (f.type === "date") props[f.name] = { type: "string", description: `${base} Format YYYY-MM-DD, or YYYY-MM / YYYY when the source is only that precise.` };
    else props[f.name] = { type: "string", description: base };
  }
  if (!only || only.has("company_domain")) props.company_domain = { type: "string", description: `The company's OWN primary website domain, e.g. acme.com — not a news site, press-release wire, investor-relations microsite, social profile or parent-company site. "${UNCLEAR}" if it cannot be established.` };
  const icpField = icpEvidenceField(spec);
  if (icpField && (!only || only.has("icp_evidence"))) props.icp_evidence = { type: "string", description: icpField.description };
  if (!only || only.has("company_context")) props.company_context = { type: "string", description: "One or two cited sentences that establish this company's IDENTITY: its name as it presents itself and what it does, enough to confirm the signal is about this company and not a similarly named one. Do not research headquarters, size, ownership or other profile facts unless a campaign field asks for them." };
  props.contradictions = { type: "string", description: "Material contradictions between credible sources about any field above, stated literally with both versions. Empty string if none. Do not silently pick the convenient version." };
  return { type: "json", json_schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false } };
}

/** Does the campaign actually restrict who the companies are? A neutral ICP (Industry / Segment = Any, written
 *  as "Any company …" with no stated disqualifier) means NO company-type facts are researched or judged. */
export function icpIsNeutral(spec: CampaignSpec): boolean {
  const c = spec.companies;
  const noDisq = !c.disqualifies?.length || c.disqualifies.every((d) => /^(none|no restriction|n\/a|any)/i.test(d.trim()));
  return /^any (company|companies|business|businesses|industry|organization)\b/i.test((c.icp ?? "").trim()) && noDisq;
}

/** The tab's ICP is NOT a discovery filter. Discovery is signal-only (broad). When the campaign states an ICP,
 *  the facts that bear on it come back as cited EVIDENCE and Eric's judge decides fit. When the ICP is neutral
 *  there is nothing to judge, so nothing is asked. */
export function icpEvidenceField(spec: CampaignSpec): { name: string; description: string } | null {
  if (icpIsNeutral(spec)) return null;
  return { name: "icp_evidence", description: `The campaign restricts which companies it is for: "${spec.companies.icp}". Qualifies when: ${spec.companies.qualifies.join("; ")}. Does not qualify when: ${spec.companies.disqualifies.join("; ")}. Report, with sources, only the facts about this company that bear on that restriction. Do not decide whether it qualifies, and do not research facts the restriction does not mention.` };
}

/** Later evidence overlays earlier evidence, but an UNCLEAR answer never erases an established fact. */
export function mergeSignals(prev: Record<string, unknown> | null, next: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!next) return prev;
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) if (!isUnknown(v) || !(k in out)) out[k] = v;
  if (next.contradictions !== undefined && prev?.contradictions && String(next.contradictions).trim() === "") out.contradictions = ""; // a deeper pass that resolves it clears it
  return out;
}

/** Fields a company still needs before its rules/variables/recipient can be decided. Empty = no gap. */
export function gapFields(spec: CampaignSpec, content: Record<string, unknown> | null): string[] {
  if (!content) return [...spec.signals.fields.map((f) => f.name), "company_domain", "company_context"];
  const need = new Set<string>();
  const sig = (p: string) => (p.startsWith("signals.") ? p.slice(8) : "");
  for (const r of spec.rules) if (r.on_unknown !== "PASS" && sig(r.field) && isUnknown(content[sig(r.field)])) need.add(sig(r.field));
  for (const v of spec.variables ?? []) if (v.required && sig(v.from) && isUnknown(content[sig(v.from)])) need.add(sig(v.from));
  if (isUnknown(content.company_domain)) need.add("company_domain");
  const rc = spec.people.recipient;
  const named = [rc.from_field, ...(rc.fallbacks ?? []).map((f) => f.from_field)].filter(Boolean) as string[];
  if (named.length && named.every((n) => isUnknown(content[n]))) named.forEach((n) => need.add(n)); // nobody named at all
  need.delete("contradictions");
  return [...need];
}

// ---------- usable email (ONE definition: the gate and the Instantly upload both use it) ----------
const ROLE_LOCAL = new Set(["info", "contact", "hello", "hi", "sales", "team", "support", "admin", "office", "hr", "careers", "jobs", "press", "media", "marketing", "billing", "accounts", "accounting", "help", "service", "enquiries", "inquiries", "mail", "noreply", "no-reply"]);
/** "" = usable. Quick Enrich's email_verification_date IS the verification; the email domain is not compared to the website. */
export function usableEmail(email: string, status: string, verifiedOn: string): string {
  const e = (email || "").trim().toLowerCase();
  if (!e) return `no email from Quick Enrich (${status || "none"}) — none is invented`;
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return "invalid email syntax";
  if (ROLE_LOCAL.has(e.split("@")[0])) return `role mailbox (${e.split("@")[0]}@), not a person`;
  if (status !== "verified" || !verifiedOn) return "Quick Enrich returned no email_verification_date, so the email is not treated as verified";
  return "";
}

// ---------- global Quick Enrich lookup cache ----------
// A person looked up for ANY campaign is never paid for again. Key: root domain | first | last.
export function qeCachePath(): string { return join(homedir(), "output", "list-builder", "kept-research-cache", "quickenrich-lookups.jsonl"); }
export function qeKey(domain: string, first: string, last: string): string { return `${rootDomain(domain)}|${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`; }
export function qeCacheLoad(): Map<string, any> { const m = new Map<string, any>(); for (const e of readJsonl(qeCachePath())) if (e.key && !String(e.status).startsWith("ERROR")) m.set(e.key, e); return m; }

// ---------- evidence standard for the company/website validation stage ----------
/** Is Parallel's cited evidence enough for Eric's validation stage to pass WITHOUT a live website fetch?
 *  Needs: a canonical company domain Parallel itself stated, cited company identity, and — only when the campaign
 *  states an ICP — cited ICP evidence (the facts his judge ruled on). Anything less → his live website check runs. */
export function evidenceSufficient(e: { canonical_domain_stated: boolean; icp_evidence_citations: number; context_cited: boolean; icp_required?: boolean }): { ok: boolean; why: string } {
  const miss = [!e.canonical_domain_stated && "no canonical company domain from Parallel", e.icp_required !== false && e.icp_evidence_citations < 1 && "ICP evidence has no citation", !e.context_cited && "no cited company identity"].filter(Boolean);
  return miss.length ? { ok: false, why: miss.join("; ") } : { ok: true, why: `canonical domain stated by Parallel; ${e.icp_required !== false ? `ICP evidence on ${e.icp_evidence_citations} cited source(s); ` : "no ICP restriction in this campaign; "}company identity cited` };
}


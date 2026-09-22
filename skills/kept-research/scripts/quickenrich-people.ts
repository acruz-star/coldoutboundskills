#!/usr/bin/env tsx
/**
 * quickenrich-people.ts — QUICK ENRICH OWNS recipient / contact enrichment.
 *
 * GATE: nothing here runs for a company until it has PASSED the campaign's research rules on
 *       Parallel's evidence (every rule passes, nothing unresolved). No lookups on REVIEW/REJECT companies.
 *
 * Then, per company:
 *   A. Recipient already NAMED by the research (the campaign's primary named person, else a fallback the campaign's spec defines)
 *        → Employee Search straight away, with the strongest identity available:
 *          LinkedIn URL and/or company URL + first name + last name.   [no Contact Finder call]
 *   B. Only a TITLE is known (and the spec allows picking by title)
 *        → Contact Finder (free) to identify the person → Eric's contacts-merge.ts → Employee Search on them.
 *   C. Neither → no recipient → REVIEW (the gate decides; nobody is chosen for their rank alone).
 *
 * Employee Search is the ONE paid call (1 credit) and returns the contact record: title, LinkedIn,
 * email, email_verification_date, phone, company + email domain. Everything it returns is kept raw in
 * emails.jsonl (append-only; a lookup ever attempted is never paid for twice).
 *
 * EMAIL: an email WITH an email_verification_date is verified by Quick Enrich — source "quickenrich",
 * date preserved. No email → none is invented (REVIEW). The email domain does NOT have to equal the
 * website domain; what must hold is the AFFILIATION: Quick Enrich ties this person to this company.
 *
 *     npx tsx quickenrich-people.ts --spec=<campaign-spec.json> --run-dir=<dir> [--retry-email-errors]
 */
import { existsSync, writeFileSync, readFileSync, renameSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { loadEnv, parseArgs, readCsv, writeCsv, normDomain, sleep } from "../../list-expander/scripts/lib";
import { loadSpec, CampaignSpec, researchSetPath, quickEnrich, readJsonl, appendJsonl, logSpend, requireSpendApproval, isUnknown, qeKey, qeCacheLoad, qeCachePath } from "./kept-lib";
import { evaluate, loadSignals, Recipient } from "./qualify";

const na = (v: unknown): string => (v == null || v === "N/A" ? "" : String(v).trim());
const first = (o: any, keys: string[]): string => { for (const k of keys) if (na(o?.[k])) return na(o[k]); return ""; };
/** Short tokens (cfo, coo, vp, it) must match as whole words — "cto" is inside "director". */
export function titleMatches(title: string, pattern: string): boolean {
  const t = title.toLowerCase(), p = pattern.toLowerCase().trim();
  if (!p) return false;
  return p.length < 5 || !p.includes(" ") ? new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) : t.includes(p);
}

export type Named = { first_name: string; last_name: string; title: string; linkedin_url: string; label: string };
/** The person the research NAMED, in the spec's order (primary, then whatever fallbacks the campaign's spec defines). null = nobody named. */
export function namedRecipient(rc: CampaignSpec["people"]["recipient"], sig: Record<string, unknown>): Named | null {
  for (const n of [{ from_field: rc.from_field, title_field: rc.title_field, linkedin_field: rc.linkedin_field, label: "primary" }, ...(rc.fallbacks ?? [])]) {
    if (!n.from_field || isUnknown(sig[n.from_field])) continue;
    const parts = String(sig[n.from_field]).trim().replace(/,.*$/, "").replace(/\s+\(.*\)$/, "").split(/\s+/);
    if (parts.length < 2) continue;
    const li = n.linkedin_field && !isUnknown(sig[n.linkedin_field]) && /linkedin\.com\/in\//i.test(String(sig[n.linkedin_field])) ? String(sig[n.linkedin_field]).trim() : "";
    return { first_name: parts[0], last_name: parts[parts.length - 1], title: n.title_field && !isUnknown(sig[n.title_field]) ? String(sig[n.title_field]) : "", linkedin_url: li, label: n.label };
  }
  return null;
}

/** Title-only path: choose from Contact Finder results by the spec's title priority. */
export function pickByTitle(rc: CampaignSpec["people"]["recipient"], pool: Record<string, string>[]): Record<string, string> | null {
  if (!rc.titles.length || rc.pick_by_title_when_unnamed === false) return null;
  const ok = pool.filter((p) => !(rc.title_excludes ?? []).some((x) => titleMatches(p.job_title, x)));
  for (const t of rc.titles) { const hit = ok.find((p) => titleMatches(p.job_title, t)); if (hit) return hit; }
  return null;
}

const CO_NOISE = /\b(the|inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|companies|group|holdings|plc|lp|llp)\b/g;
const coTokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(CO_NOISE, " ").split(/\s+/).filter((t) => t.length > 1));
const sameDomain = (a: string, b: string) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
/** Is this Quick Enrich record really THIS person at THIS company? The email domain alone never decides it. */
export function affiliation(a: { companyDomain: string; companyName: string; first: string; last: string }, rec: { first_name: string; last_name: string; company_url: string; company_name: string; email_domain: string }): { ok: boolean; why: string } {
  if (rec.last_name && rec.last_name.toLowerCase() !== a.last.toLowerCase()) return { ok: false, why: `Quick Enrich returned a different person (${rec.first_name} ${rec.last_name})` };
  if (rec.first_name && a.first && rec.first_name[0].toLowerCase() !== a.first[0].toLowerCase()) return { ok: false, why: `Quick Enrich returned a different first name (${rec.first_name})` };
  if (sameDomain(normDomain(rec.company_url), a.companyDomain)) return { ok: true, why: "Quick Enrich company URL matches the company" };
  const x = coTokens(rec.company_name), y = coTokens(a.companyName);
  const inter = [...x].filter((t) => y.has(t)).length;
  if (x.size && y.size && (inter / Math.min(x.size, y.size) >= 0.6)) return { ok: true, why: `Quick Enrich company name matches ("${rec.company_name}")` };
  if (sameDomain(rec.email_domain, a.companyDomain)) return { ok: true, why: "email is on the company's own domain" };
  return { ok: false, why: `Quick Enrich ties this person to "${rec.company_name || rec.company_url || "an unknown company"}", not clearly to ${a.companyName}` };
}

/** Normalise one Employee Search response. Raw is kept separately; nothing is invented. */
export function readEmployee(d: any): { email: string; email_verification_date: string; title: string; linkedin_url: string; phone: string; first_name: string; last_name: string; company_name: string; company_url: string; email_domain: string } {
  let x: any = d?.data; if (Array.isArray(x)) x = x[0]; x = x ?? {};
  const email = first(x, ["email", "work_email", "business_email"]).toLowerCase();
  return {
    email: email.includes("@") ? email : "", email_verification_date: first(x, ["email_verification_date", "email_verified_date", "email_verified_at", "verification_date", "last_verified"]),
    title: first(x, ["title", "job_title"]), linkedin_url: first(x, ["employee_linkedin", "linkedin_url", "linkedin"]), phone: first(x, ["phone", "mobile_phone", "mobile", "direct_phone", "phone_number", "company_phone"]),
    first_name: first(x, ["first_name"]), last_name: first(x, ["last_name"]), company_name: first(x, ["company_name", "company"]), company_url: first(x, ["company_url", "url", "website"]),
    email_domain: first(x, ["email_domain", "final_email_domain"]).toLowerCase() || (email.includes("@") ? email.split("@")[1] : ""),
  };
}

/** ERIC'S CONTACTS STAGES on the Quick Enrich records: his contacts-merge.ts (normalize + dedupe, raw_json kept,
 *  provider label "quickenrich"), then his contacts.ts EMAILS + REPORT → leads-final.csv. His three provider
 *  pulls (GetLeads / Blitz / Prospeo) are marked done: Quick Enrich is the enrichment engine for this stage. */
export function ericContactsStages(runDir: string, spec: CampaignSpec, picks: (Recipient & { domain: string })[]): void {
  const LB = resolve(fileURLToPath(import.meta.url), "../../../list-builder/scripts");
  const enriched = picks.filter((p) => p.email || p.title).map((p) => ({ first_name: p.first_name, last_name: p.last_name, job_title: p.title, linkedin_url: p.linkedin_url, domain: p.domain, company_name: p.qe_company_name || "", email: p.email, email_status: p.email_status === "verified" ? "verified" : p.email ? "unverified" : "", phone: p.phone ?? "", email_verification_date: p.email_verified_on ?? "", email_domain: p.email_domain ?? "", recipient_basis: p.source }));
  if (enriched.length) {
    const recCsv = join(runDir, "contacts-recipients-quickenrich.csv");
    writeCsv(recCsv, enriched);
    const slug = `__contacts__${spec.client_slug}-${spec.campaign_slug}-recipients`;
    if (spawnSync("npx", ["tsx", join(LB, "contacts-merge.ts"), `--run=${slug}`, `--csv=${recCsv}:quickenrich`], { stdio: "inherit" }).status !== 0) { console.error("contacts-merge failed"); process.exit(1); }
    writeFileSync(join(runDir, "contacts-merged.csv"), readFileSync(join(homedir(), "output", "list-builder", slug, "contacts-merged.csv")));
    const laneReady = existsSync(join(runDir, "summary.md")) && readFileSync(join(runDir, "summary.md"), "utf8").startsWith("# READY");
    if (laneReady) {
      const note = "Quick Enrich is the enrichment engine for this stage (kept-research)";
      writeFileSync(join(runDir, "contacts-state.json"), JSON.stringify({ GETLEADS: { status: "done", note }, COVERAGE: { status: "done", note }, BLITZ: { status: "done", note }, PROSPEO_PEOPLE: { status: "done", note }, MERGE: { status: "done", note: "his contacts-merge.ts, provider label quickenrich" } }, null, 2));
      const c = spawnSync("npx", ["tsx", join(LB, "contacts.ts"), `--config=${join(runDir, "spec", "lane.json")}`, `--run-dir=${runDir}`], { stdio: "inherit" });
      if (c.status !== 0) console.error("  note: Eric's contacts.ts EMAILS stage did not complete; recipients.jsonl is unaffected");
    } else console.log("  note: his contacts.ts requires a READY lane (it refuses otherwise, by his design) — skipped; contacts-merged.csv is still written");
  }

}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx quickenrich-people.ts --spec=<campaign-spec.json> --run-dir=<dir>"); process.exit(1); }
  const spec = loadSpec(String(args.spec));
  const runDir = String(args["run-dir"]);
  const rc = spec.people.recipient;
  const companies = readCsv(researchSetPath(runDir));
  const signals = loadSignals(runDir);

  // GATE — only companies that passed the research rules outright
  const passed = companies.filter((c) => { const s = signals.get(normDomain(c.domain))?.content; return s && evaluate(spec, c, s, null, "pre").verdict === "QUALIFIED"; });
  console.log(`quick enrich: ${passed.length}/${companies.length} companies passed the research gate — no lookups are spent on the other ${companies.length - passed.length}`);

  // B. title-only companies need Contact Finder (free) to identify a person first
  const finderPath = join(runDir, "contacts-quickenrich.jsonl");
  const searched = new Set(readJsonl(finderPath).map((r) => r.domain));
  const needFinder = passed.filter((c) => !namedRecipient(rc, signals.get(normDomain(c.domain))!.content!) && rc.titles.length && rc.pick_by_title_when_unnamed !== false);
  for (const c of needFinder) {
    const domain = normDomain(c.domain);
    if (searched.has(domain)) continue;
    const d = await quickEnrich("POST", "/employees/contact-finder", { company_url: { include: [domain], exclude: [] }, title: { include: rc.titles, exclude: rc.title_excludes ?? [] }, page: 1, per_page: 100 });
    await sleep(550);
    if (!d?.success && !Array.isArray(d?.data)) { console.error(`  finder ${domain}: ${JSON.stringify(d).slice(0, 200)} — will retry on re-run`); continue; }
    if (Number(d?.meta?.credits_used ?? 0) > 0) logSpend(runDir, { provider: "quickenrich", kind: "contact-finder", id: domain, credits: Number(d.meta.credits_used), note: "finder unexpectedly charged" });
    appendJsonl(finderPath, { domain, company_name: c.name, people: d.data ?? [], at: new Date().toISOString() });
  }
  let merged: Record<string, string>[] = [];
  const flat = readJsonl(finderPath).flatMap((r) => (r.people as any[]).map((p) => ({ first_name: na(p.first_name), last_name: na(p.last_name), job_title: na(p.title), linkedin_url: na(p.employee_linkedin), domain: r.domain, company_name: na(p.company_name) || r.company_name, city: na(p.city), state: na(p.region_code), country: na(p.country_code) })));
  if (flat.length) { // Eric's normalizer/deduper; every raw provider field survives in raw_json
    const finderCsv = join(runDir, "contacts-quickenrich.csv");
    writeCsv(finderCsv, flat);
    const slug = `__contacts__${spec.client_slug}-${spec.campaign_slug}`;
    const m = spawnSync("npx", ["tsx", resolve(fileURLToPath(import.meta.url), "../../../list-builder/scripts/contacts-merge.ts"), `--run=${slug}`, `--csv=${finderCsv}:quickenrich`], { stdio: "inherit" });
    if (m.status !== 0) { console.error("contacts-merge failed"); process.exit(1); }
    writeFileSync(join(runDir, "contacts-merged.csv"), readFileSync(join(homedir(), "output", "list-builder", slug, "contacts-merged.csv")));
    merged = readCsv(join(runDir, "contacts-merged.csv"));
  }

  // identify → Employee Search (the one paid call), strongest identity first
  // lookups already paid for — by this run OR by any other campaign (global cache) — are reused, never re-bought
  const cache = new Map<string, any>();
  for (const e of readJsonl(join(runDir, "emails.jsonl"))) cache.set(e.key, e);
  const globalCache = qeCacheLoad();
  let reused = 0;
  const picks: (Recipient & { domain: string; key: string })[] = [];
  let direct = 0, viaFinder = 0, paid = 0;
  for (const c of passed) {
    const domain = normDomain(c.domain);
    const sig = signals.get(domain)!.content!;
    const named = namedRecipient(rc, sig);
    const byTitle = named ? null : pickByTitle(rc, merged.filter((p) => p.domain === domain));
    const who = named ?? (byTitle ? { first_name: byTitle.first_name, last_name: byTitle.last_name, title: byTitle.job_title, linkedin_url: byTitle.linkedin_url, label: "title_match" } : null);
    if (!who) continue;
    named ? direct++ : viaFinder++;
    const key = qeKey(domain, who.first_name, who.last_name);
    let hit = cache.get(key);
    if (!hit && globalCache.has(key)) { hit = { ...globalCache.get(key), reused: true, reused_from: globalCache.get(key).campaign ?? "another run", at: new Date().toISOString() }; appendJsonl(join(runDir, "emails.jsonl"), hit); cache.set(key, hit); reused++; }
    if (!hit || (args["retry-email-errors"] && String(hit.status).startsWith("ERROR"))) {
      requireSpendApproval("Quick Enrich Employee Search");
      const qs = new URLSearchParams({ ...(who.linkedin_url ? { linkedin_url: who.linkedin_url } : {}), company_url: domain, first_name: who.first_name, last_name: who.last_name });
      logSpend(runDir, { provider: "quickenrich", kind: "employee-search", id: key, credits: 1 }); // ledger BEFORE the call, so an ambiguous failure is still counted
      const d = await quickEnrich("GET", `/employees/search?${qs}`, undefined, true);
      await sleep(550); paid++;
      const rec = readEmployee(d);
      const status = d?._network_error || d?._http_status ? `ERROR:${d._http_status ?? "network"}` : !rec.email ? "NOT_FOUND" : rec.email_verification_date ? "verified" : "unverified_no_date";
      hit = { key, domain, status, identity_inputs: [...qs.keys()], ...rec, raw: d?.data ?? null, at: new Date().toISOString() };
      appendJsonl(join(runDir, "emails.jsonl"), hit);
      if (!status.startsWith("ERROR")) appendJsonl(qeCachePath(), { ...hit, campaign: `${spec.client_slug}/${spec.campaign_slug}` });
    }
    const aff = hit.email ? affiliation({ companyDomain: domain, companyName: c.name, first: who.first_name, last: who.last_name }, hit) : { ok: true, why: "" };
    picks.push({ domain, key, first_name: who.first_name, last_name: who.last_name, full_name: `${who.first_name} ${who.last_name}`, title: hit.title || who.title, linkedin_url: hit.linkedin_url || who.linkedin_url,
      source: named ? `signal_research:${named.label}` : "quickenrich_title_match", found_in_quickenrich: !!hit.email || !!hit.title,
      email: hit.email ?? "", email_status: hit.status, email_source: hit.email ? "quickenrich" : "", email_verified_on: hit.email_verification_date ?? "", email_domain: hit.email_domain ?? "", phone: hit.phone ?? "",
      company_url: `https://${domain}`, qe_company_name: hit.company_name ?? "", qe_company_url: hit.company_url ?? "", affiliation: aff.ok ? "confirmed" : "uncertain", affiliation_note: aff.why });
  }
  console.log(`recipients: ${picks.length}/${passed.length} — ${direct} named by research → Employee Search directly (Contact Finder skipped), ${viaFinder} identified via Contact Finder; ${paid} new paid lookups, ${picks.filter((p) => p.email_status === "verified").length} Quick Enrich-verified emails`);
  if (reused) console.log(`  ${reused} lookups reused from the global Quick Enrich cache (not paid again)`);

  ericContactsStages(runDir, spec, picks);

  const out = join(runDir, "recipients.jsonl");
  writeFileSync(out + ".tmp", picks.map((p) => JSON.stringify(p)).join("\n") + (picks.length ? "\n" : ""));
  renameSync(out + ".tmp", out);
}

if (process.argv[1]?.split("/").pop() === "quickenrich-people.ts") main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env tsx
/**
 * qualify.ts — the deterministic three-way gate: QUALIFIED / REVIEW / REJECT.
 *
 *     npx tsx qualify.ts --spec=<campaign-spec.json> --run-dir=<dir>
 *
 * No network, no LLM, no paid calls — re-run it as often as you like.
 * Company FIT was already decided upstream by Eric's judge + reject-audit + live
 * website verify. This gate applies the campaign's RULES (from the Google Doc
 * tab, compiled into the spec) to the researched facts:
 *
 *   REJECT     a rule is demonstrably false (on_fail=REJECT), or on_unknown=REJECT fired,
 *              or more unresolved facts remain than review_policy.max_unresolved (default 1)
 *   REVIEW     otherwise able to qualify, with 1..max_unresolved facts genuinely unresolved
 *   QUALIFIED  every rule passes, recipient (+ email when required) found, required variables filled
 *
 * Missing evidence is never read as positive evidence, and a technical research
 * failure is never read as a business conclusion (it lands in REVIEW as RESEARCH_FAILED).
 *
 * Output (<run-dir>/output/): qualified.csv, review.csv, rejected.csv, evidence.csv,
 * summary.md, and scorecard.md from Eric's list-quality-scorecard.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { parseArgs, readCsv, writeCsv, normDomain } from "../../list-expander/scripts/lib";
import { loadSpec, researchSetPath, CampaignSpec, Rule, isUnknown, asNum, readJsonl, spentSoFar, mergeSignals, usableEmail } from "./kept-lib";

export type Recipient = { first_name: string; last_name: string; full_name: string; title: string; linkedin_url: string; source: string; found_in_quickenrich: boolean; email: string; email_status: string;
  email_source?: string; email_verified_on?: string; email_domain?: string; phone?: string; company_url?: string; qe_company_name?: string; qe_company_url?: string; affiliation?: "confirmed" | "uncertain"; affiliation_note?: string };
export type Verdict = { verdict: "QUALIFIED" | "REVIEW" | "REJECT"; reason: string; unresolved: string[]; rule_results: Record<string, "pass" | "fail" | "unknown" | "skipped">; variables: Record<string, string>; notes: string[] };

/** A date known only to the year or month is a RANGE, not a point. */
function dateRange(v: unknown): [string, string] | null {
  const m = String(v ?? "").trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (d) return [`${y}-${mo}-${d}`, `${y}-${mo}-${d}`];
  if (mo) return [`${y}-${mo}-01`, `${y}-${mo}-31`];
  return [`${y}-01-01`, `${y}-12-31`];
}

export function evalRule(rule: Rule, v: unknown): "pass" | "fail" | "unknown" {
  if (isUnknown(v)) return "unknown";
  const s = String(v).trim().toLowerCase();
  const tri = (b: boolean | null) => (b == null ? "unknown" : b ? "pass" : "fail");
  const same = (a: unknown) => { const na = asNum(a), nv = asNum(v); return na != null && nv != null ? na === nv : String(a).trim().toLowerCase() === s; };
  switch (rule.op) {
    case "exists": return "pass";
    case "is_true": return tri(s === "true" ? true : s === "false" ? false : null);
    case "is_false": return tri(s === "false" ? true : s === "true" ? false : null);
    case "eq": return tri(same(rule.value));
    case "ne": return tri(!same(rule.value));
    case "in": return tri((rule.value as unknown[]).some(same));
    case "not_in": return tri(!(rule.value as unknown[]).some(same));
    case "contains": return tri(s.includes(String(rule.value).toLowerCase()));
    case "not_contains": return tri(!s.includes(String(rule.value).toLowerCase()));
    case "gte": case "lte": case "gt": case "lt": {
      const a = asNum(v), b = asNum(rule.value);
      if (a == null || b == null) return "unknown";
      return tri(rule.op === "gte" ? a >= b : rule.op === "lte" ? a <= b : rule.op === "gt" ? a > b : a < b);
    }
    case "date_gte": case "date_lte": {
      const r = dateRange(v), b = dateRange(rule.value);
      if (!r || !b) return "unknown";
      if (rule.op === "date_gte") return r[0] >= b[0] ? "pass" : r[1] < b[0] ? "fail" : "unknown"; // coarse date straddling the cutoff = unresolved
      return r[1] <= b[1] ? "pass" : r[0] > b[1] ? "fail" : "unknown";
    }
  }
  return "unknown";
}

function valueAt(path: string, company: Record<string, string>, signals: Record<string, unknown> | null, recipient: Recipient | null): unknown {
  const [root, key] = path.split(".");
  if (root === "signals") return signals?.[key];
  if (root === "company") return company[key];
  return (recipient as any)?.[key];
}

/** mode "pre" = before the people step: recipient rules/requirements are skipped, so
 *  paid people work is only spent on companies the facts have not already rejected. */
export function evaluate(spec: CampaignSpec, company: Record<string, string>, signals: Record<string, unknown> | null, recipient: Recipient | null, mode: "pre" | "final"): Verdict {
  const out: Verdict = { verdict: "QUALIFIED", reason: "", unresolved: [], rule_results: {}, variables: {}, notes: [] };
  if (!signals) return { ...out, verdict: "REVIEW", reason: "RESEARCH_FAILED: signal research did not complete for this company — re-run the same command to retry; not a business conclusion", unresolved: ["research_failed"] };
  const rejects: string[] = [];
  // Website could not be verified by Eric's live check NOR by the secondary path: that is one
  // unresolved fact, never a rejection (a blocked or uninformative site proves nothing).
  if (company.verify_path === "unverified_review") out.unresolved.push(`website_verify: company could not be verified as operating — ${company.verify_note || "site blocked, inaccessible or uninformative"}`);
  else if (String(company.verify_path).startsWith("secondary")) out.notes.push(`website verified by secondary path (${company.verify_path}): ${company.verify_note ?? ""}`);
  for (const rule of spec.rules) {
    if (mode === "pre" && rule.field.startsWith("recipient.")) { out.rule_results[rule.id] = "skipped"; continue; }
    const v = valueAt(rule.field, company, signals, recipient);
    const r = evalRule(rule, v);
    out.rule_results[rule.id] = r;
    const shown = isUnknown(v) ? "not established" : JSON.stringify(v);
    if (r === "fail") (rule.on_fail === "REJECT" ? rejects : out.unresolved).push(`${rule.id}: ${rule.description} — found ${shown}`);
    else if (r === "unknown" && rule.on_unknown !== "PASS") (rule.on_unknown === "REJECT" ? rejects : out.unresolved).push(`${rule.id}: ${rule.description} — ${shown}`);
  }
  if (mode === "final") {
    // Quick Enrich is only consulted for companies that PASSED the research rules. If this company did
    // not, the recipient was deliberately never looked up — that is not a second missing fact.
    // "Passed" is judged exactly as quickenrich-people.ts judges it: the pre-recipient verdict (rules AND required variables).
    const lookedUp = !!recipient || evaluate(spec, company, signals, null, "pre").verdict === "QUALIFIED";
    if (!lookedUp) out.notes.push("recipient not looked up: the company has not passed the research gate, so no Quick Enrich lookup was spent");
    else if (!recipient) ((spec.people.on_no_recipient ?? "REVIEW") === "REJECT" ? rejects : out.unresolved).push("recipient: no defensible recipient found");
    else if (spec.people.find_email && !recipient.email) ((spec.people.on_no_email ?? "REVIEW") === "REJECT" ? rejects : out.unresolved).push(`email: Quick Enrich returned no email for ${recipient.full_name} (${recipient.email_status || "not attempted"}) — none is invented`);
    else if (spec.people.find_email && usableEmail(recipient.email, recipient.email_status, recipient.email_verified_on ?? "")) out.unresolved.push(`email: ${recipient.email} — ${usableEmail(recipient.email, recipient.email_status, recipient.email_verified_on ?? "")}`);
    if (recipient?.email && recipient.affiliation === "uncertain") out.unresolved.push(`affiliation: ${recipient.affiliation_note}`);
    else if (recipient?.email && recipient.email_domain && recipient.company_url && !recipient.company_url.includes(recipient.email_domain)) out.notes.push(`email domain ${recipient.email_domain} differs from the website domain; affiliation confirmed — ${recipient.affiliation_note}`);
  }
  for (const v of spec.variables ?? []) {
    if (v.from.startsWith("recipient.") && (mode === "pre" || !recipient || v.from === "recipient.email")) continue; // a missing recipient/email is already counted once above
    const val = valueAt(v.from, company, signals, recipient);
    if (isUnknown(val)) { if (v.required) out.unresolved.push(`variable {{${v.name}}}: ${v.from} not established`); }
    else out.variables[v.name] = String(val);
  }
  // Contradictions: carried as a note always; BLOCKING only when the text touches the
  // recipient by name (a fact the outreach would assert). Immaterial source noise must
  // not throw away the batch.
  const contra = String(signals.contradictions ?? "").trim();
  if (contra && !isUnknown(contra)) {
    out.notes.push(`contradictions: ${contra}`);
    const last = recipient?.last_name?.toLowerCase();
    if (last && last.length > 2 && new RegExp(`\\b${last.replace(/[^a-z]/g, "")}\\b`, "i").test(contra)) out.unresolved.push("contradiction names the recipient — read the evidence");
  }
  const max = spec.review_policy?.max_unresolved ?? 1;
  if (rejects.length) return { ...out, verdict: "REJECT", reason: rejects[0] };
  if (out.unresolved.length > max) return { ...out, verdict: "REJECT", reason: `${out.unresolved.length} unresolved facts (REVIEW allows ${max}): ${out.unresolved.join("; ")}` };
  if (out.unresolved.length) return { ...out, verdict: "REVIEW", reason: out.unresolved.join("; ") };
  return { ...out, reason: "all rules pass; recipient and required variables established" };
}

/** Evidence per company: every completed record (discovery enrichment, then any gap research) MERGED in
 *  order — a later UNCLEAR never erases an established fact. null content = nothing researched yet. */
export function loadSignals(runDir: string): Map<string, { content: Record<string, unknown> | null; run_id: string }> {
  const m = new Map<string, { content: Record<string, unknown> | null; run_id: string }>();
  for (const s of readJsonl(join(runDir, "signals.jsonl"))) {
    const prev = m.get(s.domain);
    if (s.status === "RESEARCH_COMPLETE" && s.content) m.set(s.domain, { content: mergeSignals(prev?.content ?? null, s.content), run_id: [prev?.run_id, s.run_id].filter(Boolean).join("+") });
    else if (!prev) m.set(s.domain, { content: null, run_id: s.run_id });
  }
  return m;
}

function main() {
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx qualify.ts --spec=<campaign-spec.json> --run-dir=<dir>"); process.exit(1); }
  const spec = loadSpec(String(args.spec));
  const runDir = String(args["run-dir"]);
  const outDir = join(runDir, "output");
  mkdirSync(outDir, { recursive: true });
  const companies = readCsv(researchSetPath(runDir));
  const signals = loadSignals(runDir);
  const recipients = new Map<string, Recipient>(readJsonl(join(runDir, "recipients.jsonl")).map((r) => [r.domain, r]));
  const evidence = readJsonl(join(runDir, "evidence.jsonl"));
  const evCount = new Map<string, number>();
  for (const e of evidence) evCount.set(e.domain, (evCount.get(e.domain) ?? 0) + 1);

  const buckets: Record<string, Record<string, unknown>[]> = { QUALIFIED: [], REVIEW: [], REJECT: [] };
  for (const c of companies) {
    const domain = normDomain(c.domain);
    const sig = signals.get(domain);
    const rec = recipients.get(domain) ?? null;
    const v = evaluate(spec, c, sig?.content ?? null, rec, "final");
    buckets[v.verdict].push({
      company_domain: domain, company_name: c.name, verdict: v.verdict, stage: "rules", reason: v.reason,
      first_name: rec?.first_name ?? "", last_name: rec?.last_name ?? "", job_title: rec?.title ?? "", linkedin_url: rec?.linkedin_url ?? "",
      email: rec?.email ?? "", email_status: rec?.email_status ?? "", email_source: rec?.email_source ?? "", email_verified_on: rec?.email_verified_on ?? "", email_domain: rec?.email_domain ?? "",
      company_url: rec?.company_url || `https://${domain}`, phone: rec?.phone ?? "", quickenrich_company: rec?.qe_company_name ?? "", affiliation: rec?.affiliation ?? "", recipient_source: rec?.source ?? "", recipient_in_quickenrich: rec ? String(rec.found_in_quickenrich) : "",
      ...Object.fromEntries(Object.entries(v.variables).map(([k, val]) => [`var_${k}`, val])),
      ...Object.fromEntries(spec.signals.fields.map((f) => [`sig_${f.name}`, sig?.content?.[f.name] ?? ""])),
      rule_results: Object.entries(v.rule_results).map(([k, r]) => `${k}=${r}`).join(" "),
      website_verify_path: c.verify_path || "primary", notes: v.notes.join(" | "), judge_confidence: c.confidence ?? "", website_verify: c.live_reason ?? "",
      evidence_rows: evCount.get(domain) ?? 0, parallel_run_id: sig?.run_id ?? "",
    });
  }
  // UNIQUE leads: one company per row already; the same person must not qualify twice via two domains.
  const seenEmail = new Map<string, string>();
  buckets.QUALIFIED = buckets.QUALIFIED.filter((r) => {
    const e = String(r.email ?? "").toLowerCase();
    if (!e || !seenEmail.has(e)) { if (e) seenEmail.set(e, String(r.company_domain)); return true; }
    buckets.REVIEW.push({ ...r, verdict: "REVIEW", reason: `duplicate lead: same recipient email already qualified under ${seenEmail.get(e)}` });
    return false;
  });

  // Companies Eric's judge / live verify turned away are rejected leads too — keep them visible.
  const finalSet = new Set(companies.map((c) => normDomain(c.domain)));
  const upstream = new Map<string, Record<string, unknown>>();
  const scored = join(runDir, "pull-batch1-scored.csv.stream.csv");
  if (existsSync(scored)) for (const r of readCsv(scored)) if (r.qualified !== "true" && !finalSet.has(r.domain)) upstream.set(r.domain, { company_domain: r.domain, company_name: r.name, verdict: "REJECT", stage: "icp_judge", reason: r.reason || "judge: not a fit" });
  const verified = join(runDir, "verified.stream.csv");
  if (existsSync(verified)) for (const r of readCsv(verified)) if (r.final_verdict !== "verified" && !finalSet.has(r.domain)) upstream.set(r.domain, { company_domain: r.domain, company_name: r.name, verdict: "REJECT", stage: "website_verify", reason: `${r.final_verdict}${r.live_reason ? `: ${r.live_reason}` : ""}` });
  // where the secondary path ran, its reason is the decisive one
  const fb = join(runDir, "verify-fallback.csv");
  if (existsSync(fb)) for (const r of readCsv(fb)) if (r.verify_path === "rejected" && upstream.has(r.domain)) upstream.get(r.domain)!.reason = `${r.primary_verdict}; second opinion not_fit: ${r.secondary_reason}`;
  buckets.REJECT.push(...upstream.values());

  const cols = buckets.QUALIFIED[0] ? Object.keys(buckets.QUALIFIED[0]) : buckets.REVIEW[0] ? Object.keys(buckets.REVIEW[0]) : undefined;
  const write = (name: string, rows: Record<string, unknown>[], c?: string[]) => { const p = join(outDir, name); if (rows.length) writeCsv(p, rows, c); else writeFileSync(p, (c ?? ["company_domain", "company_name", "verdict", "stage", "reason"]).join(",") + "\n"); return p; };
  const qPath = write("qualified.csv", buckets.QUALIFIED, cols);
  write("review.csv", buckets.REVIEW, cols);
  write("rejected.csv", buckets.REJECT);
  write("evidence.csv", evidence.map((e) => ({ company_domain: e.domain, stage: e.stage, field: e.field, value: typeof e.value === "object" ? JSON.stringify(e.value) : e.value, confidence: e.confidence, source_url: e.source_url, excerpt: e.excerpt, reasoning: e.reasoning, parallel_id: e.parallel_id, researched_at: e.researched_at })));

  // QA — Eric's list-quality-scorecard, unchanged, over the qualified leads
  let scorecard = "skipped (no qualified leads with an email)";
  if (buckets.QUALIFIED.some((r) => r.email)) {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const sc = spawnSync("npx", ["tsx", resolve(here, "../../list-quality-scorecard/scripts/score-list.ts"), `--list=${qPath}`, `--out=${join(outDir, "scorecard.md")}`], { encoding: "utf8" });
    scorecard = sc.status === 0 ? join(outDir, "scorecard.md") : `failed: ${(sc.stderr || sc.stdout).slice(0, 200)}`;
  }

  const spend = spentSoFar(runDir);
  const byStage = (s: string) => buckets.REJECT.filter((r) => r.stage === s).length;
  const reasons = new Map<string, number>();
  for (const r of buckets.REJECT.filter((x) => x.stage === "rules")) { const k = String(r.reason).split(":")[0]; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  const failed = buckets.REVIEW.filter((r) => String(r.reason).startsWith("RESEARCH_FAILED")).length;
  const lines = [
    `# kept-research summary — ${spec.client_slug}/${spec.campaign_slug}`, "",
    `Source: Google Doc "${spec.source.doc_title}" · tab "${spec.source.tab}" · read ${spec.source.read_at} · tab sha ${spec.source.tab_sha256.slice(0, 12)}`,
    `Reference date: ${spec.reference_date}`, "",
    "## Funnel",
    `- Supplied-list companies judged by Eric's ICP judge: ${existsSync(scored) ? readCsv(scored).length : 0}`,
    `- Researched: ${companies.length} (Parallel evidence ${companies.filter((c) => c.verify_path === "parallel_evidence").length}, live website verify ${companies.filter((c) => (c.verify_path || "primary") === "primary").length}, secondary verification ${companies.filter((c) => String(c.verify_path).startsWith("secondary")).length}, unverifiable → REVIEW ${companies.filter((c) => c.verify_path === "unverified_review").length})`,
    `- **QUALIFIED: ${buckets.QUALIFIED.length}**`,
    `- **REVIEW: ${buckets.REVIEW.length}**${failed ? ` (${failed} are RESEARCH_FAILED — technical, re-run to retry)` : ""}`,
    `- **REJECTED: ${buckets.REJECT.length}** (icp judge ${byStage("icp_judge")}, website verify ${byStage("website_verify")}, campaign rules ${byStage("rules")})`, "",
    "## Rule rejections by decisive rule", ...([...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)), reasons.size ? "" : "- none\n",
    "## Spend (estimates from the ledger, not invoices)", `- Parallel: ~$${spend.usd.toFixed(2)} of $${spec.budget.max_usd} budget`, `- Quick Enrich: ${spend.credits} credits used (no cap — treated as unlimited)`, "",
    "## Files", `- output/qualified.csv · output/review.csv · output/rejected.csv`, `- output/evidence.csv (${evidence.length} citations — every researched fact has receipts)`, `- List quality scorecard: ${scorecard}`, "",
    "## Before anything leaves this folder",
    "- Read the evidence for EVERY qualified row. A deterministic gate passing is not the same as a human agreeing; record any override in output/adjudications.md, not in chat.",
    "- Emails come from Quick Enrich; one with an email_verification_date is treated as verified (email_source, email_verified_on columns).",
    "- No copy is written and nothing is ever activated or sent.", "",
  ];
  writeFileSync(join(outDir, "summary.md"), lines.join("\n"));
  console.log(`QUALIFIED ${buckets.QUALIFIED.length} · REVIEW ${buckets.REVIEW.length} · REJECTED ${buckets.REJECT.length} → ${join(outDir, "summary.md")}`);
}

if (process.argv[1]?.split("/").pop() === "qualify.ts") main();

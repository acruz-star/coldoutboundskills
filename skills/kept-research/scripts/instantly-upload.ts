#!/usr/bin/env tsx
/**
 * instantly-upload.ts — the LAST step of a kept-research run: put newly QUALIFIED leads that
 * have a usable email into the campaign's Instantly LEAD LIST. Nothing else.
 *
 *     npx tsx instantly-upload.ts --spec=<campaign-spec.json> --run-dir=<dir> [--dry-run]
 *
 * HARD FENCE — enforced in code by instantly() below, not by convention:
 *   - Only these calls exist: GET/POST /lead-lists, POST /leads/list (read), POST /leads/add.
 *   - /leads/add is refused unless the body has a list_id and NO campaign / campaign_id.
 *     A lead in a list belongs to no campaign, so nothing here can start, schedule or send email.
 *   - No campaign, sequence, account, sender, schedule or activation endpoint is reachable.
 *
 * Which list: spec.instantly.lead_list when the tab names one, else "Kept | <tab name>".
 *             Found by exact name; created (empty, inert) if it does not exist yet.
 * Which leads: output/qualified.csv rows that are
 *   - not held by the human evidence read (output/holds.csv: company_domain,reason)
 *   - not already uploaded by this run (instantly-uploads.jsonl, append-only)
 *   - USABLE, VERIFIED email: returned by Quick Enrich WITH an email_verification_date (that is the
 *     verification — no second verifier is required), valid syntax, a person's mailbox (not info@ / sales@ …).
 *     The email domain does NOT have to equal the website domain: the gate already confirmed the
 *     recipient ↔ company affiliation, and an uncertain affiliation never reaches QUALIFIED.
 *   - not already anywhere in the Instantly workspace (looked up first; the add call also passes
 *     skip_if_in_workspace + skip_if_in_list, so a retry can never duplicate)
 * Variables: every campaign variable (var_*) plus source/provenance fields go into custom_variables,
 * including company_url, email_domain, email_source (quickenrich) and email_verified_on.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadEnv, parseArgs, readCsv, writeCsv, normDomain, httpJson, sleep } from "../../list-expander/scripts/lib";
import { loadSpec, readJsonl, appendJsonl, usableEmail } from "./kept-lib";
export { usableEmail };

const BASE = "https://api.instantly.ai/api/v2";
const ALLOWED: [string, RegExp][] = [["GET", /^\/lead-lists(\?.*)?$/], ["POST", /^\/lead-lists$/], ["POST", /^\/leads\/list$/], ["POST", /^\/leads\/add$/]];

/** The only door to Instantly. Anything outside the allow-list throws before a request is made. */
export async function instantly(method: "GET" | "POST", path: string, body?: any): Promise<any> {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) throw new Error(`instantly-upload fence: ${method} ${path} is not permitted (lead lists and lead adds only)`);
  if (path === "/leads/add") {
    const keys = JSON.stringify(body ?? {});
    if (!body?.list_id || "campaign" in body || "campaign_id" in body || /"campaign(_id)?"\s*:/.test(keys)) throw new Error("instantly-upload fence: /leads/add requires list_id and must not reference a campaign");
  }
  const key = process.env.INSTANTLY_API_KEY ?? "";
  if (!key) { console.error("Missing env: INSTANTLY_API_KEY — add it to the repo-root .env or ~/.env"); process.exit(2); }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await httpJson(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, body, timeoutMs: 90_000 }).catch((e) => ({ _network_error: String(e?.message ?? e) }));
    if (r?._http_status === 429 || r?._http_status >= 500 || r?._network_error) { await sleep(3000 * (attempt + 1)); continue; } // safe to retry: adds are skip_if_in_workspace
    return r;
  }
  throw new Error(`Instantly ${method} ${path} kept failing`);
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx instantly-upload.ts --spec=<campaign-spec.json> --run-dir=<dir> [--dry-run]"); process.exit(1); }
  const spec = loadSpec(String(args.spec)) as any;
  const runDir = String(args["run-dir"]);
  const dry = !!args["dry-run"];
  if (spec.instantly?.upload === false) { console.log("instantly.upload=false in the spec — skipping upload."); return; }
  const listName: string = spec.instantly?.lead_list || `Kept | ${spec.source.tab}`;
  const qPath = join(runDir, "output", "qualified.csv");
  if (!existsSync(qPath)) { console.error(`missing ${qPath} — the research run has not completed`); process.exit(2); }
  const qualified = readCsv(qPath);
  const holds = new Map(existsSync(join(runDir, "output", "holds.csv")) ? readCsv(join(runDir, "output", "holds.csv")).map((r) => [normDomain(r.company_domain), r.reason || "held by evidence read"]) : []);
  const logPath = join(runDir, "instantly-uploads.jsonl");
  const already = new Set(readJsonl(logPath).filter((e) => e.action === "uploaded" || e.action === "already_in_workspace").map((e) => e.email));

  const report: Record<string, string>[] = [];
  const note = (r: Record<string, string>, action: string, reason: string) => report.push({ company_domain: r.company_domain, email: r.email, first_name: r.first_name, last_name: r.last_name, action, reason, list: listName });
  let cand = qualified.filter((r) => {
    const email = (r.email || "").toLowerCase();
    if (holds.has(normDomain(r.company_domain))) { note(r, "held", holds.get(normDomain(r.company_domain))!); return false; }
    const bad = usableEmail(r.email, r.email_status, r.email_verified_on);
    if (bad) { note(r, "skipped_unusable_email", bad); return false; }
    if (already.has(email)) { note(r, "skipped_already_uploaded_by_this_run", ""); return false; }
    return true;
  });

  const verifiedNote = "verified by Quick Enrich";

  if (dry) { for (const r of cand) note(r, "would_upload", `${verifiedNote} on ${r.email_verified_on}`); }
  else if (cand.length) {
    // 1. the list: exact name, else create
    const found = await instantly("GET", `/lead-lists?limit=100&search=${encodeURIComponent(listName)}`);
    let list = (found?.items ?? []).find((l: any) => String(l.name).trim().toLowerCase() === listName.trim().toLowerCase());
    if (!list) { list = await instantly("POST", "/lead-lists", { name: listName }); console.log(`created Instantly lead list "${listName}" (${list?.id})`); }
    if (!list?.id) { console.error(`could not resolve or create lead list "${listName}": ${JSON.stringify(list ?? found).slice(0, 300)}`); process.exit(1); }

    // 2. who is already anywhere in the workspace
    const existing = new Set<string>();
    for (let i = 0; i < cand.length; i += 100) {
      const d = await instantly("POST", "/leads/list", { contacts: cand.slice(i, i + 100).map((r) => r.email.toLowerCase()), limit: 100 });
      for (const x of d?.items ?? []) if (x.email) existing.add(String(x.email).toLowerCase());
    }
    const fresh = cand.filter((r) => { if (!existing.has(r.email.toLowerCase())) return true; note(r, "skipped_already_in_workspace", ""); appendJsonl(logPath, { email: r.email.toLowerCase(), action: "already_in_workspace", at: new Date().toISOString() }); return false; });

    // 3. add to the LIST (never a campaign)
    for (let i = 0; i < fresh.length; i += 500) {
      const batch = fresh.slice(i, i + 500);
      const leads = batch.map((r) => ({
        email: r.email.toLowerCase(), first_name: r.first_name, last_name: r.last_name, company_name: r.company_name, website: r.company_url || `https://${normDomain(r.company_domain)}`, ...(r.phone ? { phone: r.phone } : {}),
        custom_variables: {
          ...Object.fromEntries(Object.entries(r).filter(([k, v]) => k.startsWith("var_") && v !== "").map(([k, v]) => [k.slice(4), String(v)])),
          job_title: r.job_title || "", linkedin_url: r.linkedin_url || "",
          kept_campaign: spec.campaign_slug, kept_campaign_tab: spec.source.tab, kept_source_doc: spec.source.doc_title,
          kept_source_url: r.sig_primary_source_url || "", kept_recipient_basis: r.recipient_source || "", kept_website_verify: r.website_verify_path || "",
          company_url: r.company_url || `https://${normDomain(r.company_domain)}`, email_domain: r.email_domain || "", email_source: r.email_source || "quickenrich", email_verified_on: r.email_verified_on || "", kept_qualified_on: new Date().toISOString().slice(0, 10),
        },
      }));
      const res = await instantly("POST", "/leads/add", { list_id: list.id, leads, skip_if_in_workspace: true, skip_if_in_list: true, verify_leads_on_import: false });
      if (res?._http_status || res?.error) { console.error(`Instantly add failed: ${JSON.stringify(res).slice(0, 300)}`); process.exit(1); }
      for (const r of batch) { appendJsonl(logPath, { email: r.email.toLowerCase(), company_domain: r.company_domain, action: "uploaded", list_id: list.id, list: listName, at: new Date().toISOString() }); note(r, "uploaded", `${verifiedNote} on ${r.email_verified_on}`); }
      console.log(`Instantly: sent ${batch.length} leads to list "${listName}" → ${JSON.stringify({ uploaded: res?.leads_uploaded, skipped: res?.skipped_count, duplicated: res?.duplicated_leads, invalid: res?.invalid_email_count }).replace(/"/g, "")}`);
    }
  }

  const outCsv = join(runDir, "output", "instantly-upload.csv");
  if (report.length) writeCsv(outCsv, report); else writeFileSync(outCsv, "company_domain,email,first_name,last_name,action,reason,list\n");
  const count = (a: string) => report.filter((r) => r.action === a).length;
  const block = ["", `## Instantly lead list${dry ? " (DRY RUN — nothing sent)" : ""}`, `- List: "${listName}" (a lead list, not a campaign — nothing was activated or sent)`,
    `- ${dry ? "Would upload" : "Uploaded"}: ${count(dry ? "would_upload" : "uploaded")} · already in workspace: ${count("skipped_already_in_workspace")} · already uploaded by this run: ${count("skipped_already_uploaded_by_this_run")} · unusable email: ${count("skipped_unusable_email")} · held by evidence read: ${count("held")}`,
    `- Emails: Quick Enrich, each with its email_verification_date preserved (email_source / email_verified_on)`, `- Detail: output/instantly-upload.csv`, ""].join("\n");
  const sumPath = join(runDir, "output", "summary.md");
  if (existsSync(sumPath)) writeFileSync(sumPath, readFileSync(sumPath, "utf8").replace(/\n## Instantly lead list[\s\S]*?(?=\n## |$)/, "\n").replace(/\n+$/, "\n") + block);
  console.log(block);
  const { writeRunReport } = await import("./kept-run");
  writeRunReport(runDir, spec); // final counts, now including what was uploaded / skipped as duplicates
}

if (process.argv[1]?.split("/").pop() === "instantly-upload.ts") main().then(() => process.exit(0)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });

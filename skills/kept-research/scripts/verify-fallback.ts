#!/usr/bin/env tsx
/**
 * verify-fallback.ts — secondary verification for companies Eric's live website check
 * (verify-website.ts, untouched) could not verify.
 *
 * His check fetches https://<domain>/ once with a 15s timeout and re-judges the homepage.
 * That is right for small-company sites and wrong as a final word for sites that block
 * bots, need "www.", or have a homepage that says nothing about the business. A failed
 * fetch proves nothing about the company, so it must never be a rejection on its own.
 *
 *     npx tsx verify-fallback.ts --run-dir=<dir> --prompt-file=<prompt.txt>
 *
 * For every row in verified.stream.csv whose final_verdict is `dead` or `live-not-match`:
 *   1. ALT FETCH (free): bare + www host, homepage then /about pages (lib.ts fetchHomepageText).
 *   2. SECOND OPINION (gpt-5-nano, same pinned judge model, same ICP prompt), three-way:
 *        fit           evidence establishes an operating company matching the ICP
 *        not_fit       POSITIVE evidence of a disqualifying / different / defunct business
 *        insufficient  evidence cannot establish it either way
 *      Evidence = the alt-fetched site text when there is any; otherwise the dated, cited public
 *      sources discovery already collected (a company that issued a press release last month exists).
 *   3. OUTCOME
 *        fit + site text      → verify_path = secondary_alt_fetch
 *        fit + cited sources  → verify_path = secondary_cited_sources   (needs ≥1 cited source URL)
 *        insufficient / error → verify_path = unverified_review         (one unresolved fact → REVIEW)
 *        not_fit              → stays rejected at website_verify, with the reason
 *   `suspended-parked` is positive evidence about the domain and stays rejected, as before.
 *
 * Writes verify-fallback.csv (append-only, resumable) and research-set.csv
 * (= Eric's lane-final.csv + recovered + review rows). Never edits his files.
 */
import { existsSync, appendFileSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadEnv, parseArgs, readCsv, writeCsv, csvEscape, normDomain, httpJson, requireEnv, mapConcurrent, fetchHomepageText } from "../../list-expander/scripts/lib";
import { researchSetPath, buildResearchSet, readJsonl, VerifyPath } from "./kept-lib";

const COLS = ["domain", "name", "primary_verdict", "primary_reason", "site_state", "secondary_verdict", "secondary_reason", "verify_path"];

async function secondOpinion(icpPrompt: string, name: string, domain: string, siteText: string, cited: string, model: string, apiKey: string): Promise<{ verdict: "fit" | "not_fit" | "insufficient"; reason: string }> {
  const body = {
    model,
    messages: [
      { role: "system", content: 'You are a strict B2B list-qualification engine giving a SECOND opinion after an automated homepage check failed. Respond ONLY with JSON: {"verdict": "fit"|"not_fit"|"insufficient", "reason": "<one sentence>"}' },
      { role: "user", content: `${icpPrompt}\n\n---\nCOMPANY: ${name} (${domain})\n\nLIVE SITE TEXT (may be empty: the site may block automated fetches):\n${siteText.slice(0, 3500) || "(none retrievable)"}\n\nINDEPENDENT CITED PUBLIC EVIDENCE gathered during discovery:\n${cited.slice(0, 2500) || "(none)"}\n\nDecide:\n- "fit": the evidence establishes this is a real, currently operating company that fits the ICP.\n- "not_fit": there is POSITIVE evidence of a disqualifying business type, a different business, or a defunct company. A blocked, empty or uninformative website is NEVER grounds for not_fit.\n- "insufficient": the evidence cannot establish it either way.\nJSON only.` },
    ],
    response_format: { type: "json_object" },
    ...(model.startsWith("gpt-5") ? { reasoning_effort: "minimal" } : {}),
  };
  for (let a = 0; a < 3; a++) {
    try {
      const r = await httpJson("https://api.openai.com/v1/chat/completions", { headers: { Authorization: `Bearer ${apiKey}` }, body, timeoutMs: 60_000 });
      if (r.error) throw new Error(r.error.message ?? "api error");
      const j = JSON.parse(r.choices[0].message.content);
      if (["fit", "not_fit", "insufficient"].includes(j.verdict)) return { verdict: j.verdict, reason: String(j.reason ?? "").slice(0, 220) };
      throw new Error(`unexpected verdict ${j.verdict}`);
    } catch (e: any) { if (a === 2) return { verdict: "insufficient", reason: `second opinion failed technically: ${String(e?.message ?? e).slice(0, 120)}` }; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
  }
  return { verdict: "insufficient", reason: "second opinion failed technically" };
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args["run-dir"] || !args["prompt-file"]) { console.error("Usage: npx tsx verify-fallback.ts --run-dir=<dir> --prompt-file=<prompt.txt>"); process.exit(1); }
  const runDir = String(args["run-dir"]);
  const icpPrompt = readFileSync(String(args["prompt-file"]), "utf8");
  const model = String(process.env.OPENAI_ICP_MODEL ?? "gpt-5-nano");
  const verifiedPath = join(runDir, "verified.stream.csv");
  const verifiedRows = existsSync(verifiedPath) ? readCsv(verifiedPath) : [];
  const todoAll = verifiedRows.filter((r) => r.final_verdict === "dead" || r.final_verdict === "live-not-match");

  const outPath = join(runDir, "verify-fallback.csv");
  if (!existsSync(outPath)) writeFileSync(outPath, COLS.join(",") + "\n");
  const done = new Set(readCsv(outPath).map((r) => r.domain));
  const todo = todoAll.filter((r) => !done.has(r.domain));

  if (todo.length) {
    const apiKey = process.env.OPENAI_API_KEY_NANO ?? requireEnv("OPENAI_API_KEY");
    const candText = new Map(existsSync(join(runDir, "candidates.csv")) ? readCsv(join(runDir, "candidates.csv")).map((r) => [r.domain, r.text_excerpt || r.description || ""]) : []);
    const citedUrls = new Map<string, Set<string>>();
    for (const e of readJsonl(join(runDir, "evidence.jsonl"))) if (e.stage === "discovery" && e.source_url) { if (!citedUrls.has(e.domain)) citedUrls.set(e.domain, new Set()); citedUrls.get(e.domain)!.add(e.source_url); }
    console.log(`verify-fallback: ${todo.length} companies failed the primary website check — second opinion with ${model}`);
    await mapConcurrent(todo, 6, async (r) => {
      const domain = normDomain(r.domain);
      let siteText = "";
      for (const host of [domain, `www.${domain}`]) { siteText = await fetchHomepageText(host, 4000).catch(() => ""); if (siteText.replace(/TITLE:|META:|BODY:|\s/g, "").length > 200) break; siteText = ""; }
      const siteState = siteText ? "readable_via_alt_fetch" : r.final_verdict === "dead" ? "unreachable" : "uninformative";
      const urls = [...(citedUrls.get(domain) ?? [])];
      const cited = `${candText.get(domain) ?? ""}\nSOURCES: ${urls.slice(0, 6).join(" ; ")}`;
      const v = await secondOpinion(icpPrompt, r.name, domain, siteText, cited, model, apiKey);
      let path: VerifyPath | "rejected" = "unverified_review";
      if (v.verdict === "not_fit") path = "rejected";
      else if (v.verdict === "fit" && siteText) path = "secondary_alt_fetch";
      else if (v.verdict === "fit" && urls.length) path = "secondary_cited_sources";
      const row: Record<string, string> = { domain, name: r.name, primary_verdict: r.final_verdict, primary_reason: r.live_reason || "", site_state: siteState, secondary_verdict: v.verdict, secondary_reason: v.reason, verify_path: path };
      appendFileSync(outPath, COLS.map((c) => csvEscape(row[c])).join(",") + "\n");
      console.log(`  ${domain}: primary=${r.final_verdict} site=${siteState} second=${v.verdict} → ${path}`);
    });
  }

  const set = buildResearchSet(runDir);
  const n = (p: string) => set.filter((r) => r.verify_path === p).length;
  console.log(`research set: ${set.length} companies (Parallel evidence ${n("parallel_evidence")}, list→website verified ${n("primary")}, secondary ${n("secondary_alt_fetch") + n("secondary_cited_sources")}, to REVIEW ${n("unverified_review")}) → ${researchSetPath(runDir)}`);
}

if (process.argv[1]?.split("/").pop() === "verify-fallback.ts") main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

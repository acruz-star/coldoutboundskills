#!/usr/bin/env tsx
/**
 * parallel-signals.ts — GAP research only.
 *
 * Discovery already returns each company's campaign evidence from the FindAll run itself
 * (parallel-discover.ts). This step exists for what is still missing afterwards, and nothing else:
 *   - a company that did not come from FindAll at all (a supplied list / seeds)      → all fields
 *   - a REQUIRED fact Parallel left UNCLEAR (a rule, a required variable, the company
 *     domain, or nobody named as recipient)                                           → only those fields
 *   - a contradiction that names the recipient                                        → only that person's fields
 * A company with no gap costs nothing here. Each gap is asked ONCE (a technical failure gets one
 * retry with the same question); an honest UNCLEAR the second time stays UNCLEAR → REVIEW.
 *
 *     npx tsx parallel-signals.ts --spec=<campaign-spec.json> --run-dir=<dir>
 *
 * PAID. Only runs under kept-run.ts (spend cap). Task group / run ids are persisted as soon as they
 * exist; a re-run resumes them. Results are appended to signals.jsonl as source "gap" and MERGED over
 * the discovery evidence — an UNCLEAR never erases an established fact.
 */
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadEnv, parseArgs, readCsv, normDomain, sleep, mapConcurrent } from "../../list-expander/scripts/lib";
import { loadSpec, researchSetPath, CampaignSpec, parallel, readJsonl, appendJsonl, logSpend, spentSoFar, requireSpendApproval, TASK_EST_PER_RUN, signalSchema, gapFields, mergeSignals, isUnknown } from "./kept-lib";

const INPUT_SCHEMA = { type: "json", json_schema: { type: "object", properties: {
  company_name: { type: "string" }, website: { type: "string" },
  established_so_far: { type: "string", description: "Facts already established with sources. Do not re-research them; use them as context and only correct one if you find it is wrong." },
  reference_date: { type: "string", description: "Treat this as today's date when judging recency." }, research_brief: { type: "string", description: "What this campaign needs to know about the company." },
}, required: ["company_name", "website", "reference_date", "research_brief"] } };

/** Merged evidence per company from every completed record, in order. */
export function mergedSignals(runDir: string): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const s of readJsonl(join(runDir, "signals.jsonl"))) if (s.status === "RESEARCH_COMPLETE" && s.content) m.set(s.domain, mergeSignals(m.get(s.domain) ?? null, s.content)!);
  return m;
}

/** Which companies need which fields. Pure — tested offline. */
export function planGaps(spec: CampaignSpec, companies: { domain: string }[], merged: Map<string, Record<string, unknown>>, asked: Map<string, Set<string>>): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  for (const c of companies) {
    const content = merged.get(c.domain) ?? null;
    const need = new Set(gapFields(spec, content));
    const contra = String(content?.contradictions ?? "").toLowerCase();
    if (contra) for (const n of [spec.people.recipient, ...(spec.people.recipient.fallbacks ?? [])]) {
      const person = n.from_field ? String(content?.[n.from_field] ?? "") : "";
      const last = person.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
      if (!isUnknown(person) && last.length > 2 && new RegExp(`\\b${last}\\b`).test(contra)) { need.add(n.from_field!); if (n.title_field) need.add(n.title_field); }
    }
    const already = asked.get(c.domain) ?? new Set<string>();
    const todo = [...need].filter((f) => !already.has(f)).sort();
    if (todo.length) plan.set(c.domain, todo);
  }
  return plan;
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (!args.spec || !args["run-dir"]) { console.error("Usage: npx tsx parallel-signals.ts --spec=<campaign-spec.json> --run-dir=<dir>"); process.exit(1); }
  const spec = loadSpec(String(args.spec));
  const runDir = String(args["run-dir"]);
  const setCsv = researchSetPath(runDir);
  if (!existsSync(setCsv)) { console.error(`missing ${setCsv} — run through kept-run.ts`); process.exit(2); }
  const companies = readCsv(setCsv).map((r) => ({ domain: normDomain(r.domain), name: r.name || r.domain })).filter((c) => c.domain);
  const nameBy = new Map(companies.map((c) => [c.domain, c.name]));
  const signalsPath = join(runDir, "signals.jsonl");
  const statePath = join(runDir, "parallel-runs.jsonl");
  const processor = spec.signals.processor ?? "core";

  const gapEvents = () => readJsonl(statePath).filter((e) => e.kind === "gap");
  const dangling = gapEvents().filter((e) => e.event === "runs_submitting" && !gapEvents().some((x) => x.event === "runs_added" && x.batch === e.batch));
  if (dangling.length) {
    if (!args["confirm-not-submitted"]) { console.error("AMBIGUOUS SUBMISSION: a batch of gap-research runs was started and no run ids were recorded.\nCheck the task group in parallel-runs.jsonl on the Parallel dashboard. If the runs do not exist, re-run with --confirm-not-submitted. Refusing to pay twice blind."); process.exit(4); }
    for (const e of dangling) appendJsonl(statePath, { event: "runs_added", kind: "gap", batch: e.batch, run_ids: [], domains: [], fields: e.fields, note: "operator confirmed not submitted" });
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    // what has been asked (and answered or is in flight) per company; a technical failure frees the fields for ONE retry
    const asked = new Map<string, Set<string>>();
    const failedOnce = new Set(readJsonl(signalsPath).filter((s) => s.source === "gap" && s.status === "RESEARCH_FAILED").map((s) => s.domain));
    for (const e of gapEvents()) if (e.event === "runs_added") for (const dm of e.domains as string[]) {
      if (attempt === 2 && failedOnce.has(dm) && (e.attempt ?? 1) === 1 && !gapEvents().some((x) => x.event === "runs_added" && (x.attempt ?? 1) === 2 && x.domains.includes(dm))) continue;
      if (!asked.has(dm)) asked.set(dm, new Set()); for (const f of e.fields as string[]) asked.get(dm)!.add(f);
    }
    const plan = planGaps(spec, companies, mergedSignals(runDir), asked);
    if (attempt === 1) console.log(`gap research: ${plan.size}/${companies.length} companies have an unresolved required fact${plan.size ? "" : " — nothing to research"}`);
    if (plan.size) {
      requireSpendApproval("Parallel gap research");
      const est = (TASK_EST_PER_RUN[processor] ?? 0.1) * plan.size;
      const spent = spentSoFar(runDir).usd;
      if (spent + est > spec.budget.max_usd) { console.error(`SPEND CAP: ${plan.size} gap runs est $${est.toFixed(2)} + spent $${spent.toFixed(2)} would exceed this run's cap of $${spec.budget.max_usd}. Nothing submitted.`); process.exit(5); }
      let groupId: string = gapEvents().find((e) => e.event === "taskgroup_created")?.taskgroup_id ?? "";
      if (!groupId) {
        const g = await parallel("POST", "/v1/tasks/groups", { metadata: { skill: "kept-research", campaign: spec.campaign_slug, kind: "gap" } });
        if (!g?.taskgroup_id) { console.error(`task group create failed: ${JSON.stringify(g).slice(0, 300)}`); process.exit(4); }
        groupId = g.taskgroup_id;
        appendJsonl(statePath, { event: "taskgroup_created", kind: "gap", taskgroup_id: groupId, at: new Date().toISOString() });
      }
      // one add-runs call per distinct field set, so each company is asked ONLY for what it lacks
      const bySet = new Map<string, string[]>();
      for (const [dm, fields] of plan) { const k = fields.join(","); if (!bySet.has(k)) bySet.set(k, []); bySet.get(k)!.push(dm); }
      const merged = mergedSignals(runDir);
      for (const [k, domains] of bySet) {
        const fields = k.split(",");
        const batchId = `${attempt}-${createHash("sha256").update(k + domains.join()).digest("hex").slice(0, 8)}-${Date.now().toString(36)}`;
        appendJsonl(statePath, { event: "runs_submitting", kind: "gap", batch: batchId, fields, count: domains.length, at: new Date().toISOString() });
        const r = await parallel("POST", `/v1/tasks/groups/${groupId}/runs`, {
          default_task_spec: { input_schema: INPUT_SCHEMA, output_schema: signalSchema(spec, new Set(fields)) },
          inputs: domains.map((dm) => ({ processor, input: { company_name: nameBy.get(dm) ?? dm, website: `https://${dm}`, established_so_far: JSON.stringify(Object.fromEntries(Object.entries(merged.get(dm) ?? {}).filter(([, v]) => !isUnknown(v)))).slice(0, 2500), reference_date: spec.reference_date, research_brief: spec.signals.research_brief } })),
        }, 300_000);
        if (!Array.isArray(r?.run_ids) || r.run_ids.length !== domains.length) { console.error(`add-runs returned ${r?.run_ids?.length ?? "no"} ids for ${domains.length} inputs: ${JSON.stringify(r).slice(0, 300)}`); process.exit(4); }
        appendJsonl(statePath, { event: "runs_added", kind: "gap", batch: batchId, attempt, taskgroup_id: groupId, run_ids: r.run_ids, domains, fields, at: new Date().toISOString() });
        logSpend(runDir, { provider: "parallel", kind: `gap-task:${processor}`, id: groupId, est_usd: (TASK_EST_PER_RUN[processor] ?? 0.1) * domains.length, note: `${domains.length} companies × [${fields.join(", ")}], attempt ${attempt}` });
        console.log(`  asked ${domains.length} companies for: ${fields.join(", ")}`);
      }
    }

    const groupId = gapEvents().find((e) => e.event === "taskgroup_created")?.taskgroup_id;
    if (!groupId) break;
    const collected = new Set(readJsonl(signalsPath).filter((s) => s.source === "gap").map((s) => s.run_id));
    const pendingRuns: { domain: string; run_id: string; fields: string[]; attempt: number }[] = [];
    for (const e of gapEvents()) if (e.event === "runs_added") (e.domains as string[]).forEach((dm, i) => { if (e.run_ids[i] && !collected.has(e.run_ids[i])) pendingRuns.push({ domain: dm, run_id: e.run_ids[i], fields: e.fields, attempt: e.attempt ?? 1 }); });
    if (!pendingRuns.length) break;
    for (;;) {
      const g = await parallel("GET", `/v1/tasks/groups/${groupId}`);
      console.log(`group ${groupId}: ${JSON.stringify(g?.status?.task_run_status_counts ?? {})}`);
      if (g?.status?.is_active === false) break;
      await sleep(30_000);
    }
    await mapConcurrent(pendingRuns, 8, async (p) => {
      const res = await parallel("GET", `/v1/tasks/runs/${p.run_id}/result`, undefined, 120_000);
      const content = res?.output?.content;
      const ok = content && typeof content === "object";
      const inp = ok ? await parallel("GET", `/v1/tasks/runs/${p.run_id}/input`) : null;
      const inpSite = normDomain(inp?.input?.website ?? "");
      if (inpSite && inpSite !== p.domain) { console.error(`FATAL: run ${p.run_id} input is ${inpSite}, expected ${p.domain} — mapping is wrong; nothing written for it`); return; }
      appendJsonl(signalsPath, { domain: p.domain, name: nameBy.get(p.domain) ?? p.domain, source: "gap", fields: p.fields, run_id: p.run_id, attempt: p.attempt, status: ok ? "RESEARCH_COMPLETE" : "RESEARCH_FAILED", error: ok ? undefined : JSON.stringify(res).slice(0, 300), content: ok ? content : null, researched_at: new Date().toISOString() });
      if (!ok) return;
      const basis: any[] = Array.isArray(res.output.basis) ? res.output.basis : Object.values(res.output.basis ?? {});
      for (const b of basis) for (const cit of (b.citations?.length ? b.citations : [{}]))
        appendJsonl(join(runDir, "evidence.jsonl"), { domain: p.domain, stage: "gap", field: b.field, value: content[b.field] ?? "", confidence: b.confidence ?? "", source_url: cit.url ?? "", excerpt: (cit.excerpts ?? []).join(" … ").slice(0, 800), reasoning: b.reasoning ?? "", parallel_id: p.run_id, researched_at: new Date().toISOString() });
    });
  }
  const merged = mergedSignals(runDir);
  console.log(`evidence: ${companies.filter((c) => merged.has(c.domain)).length}/${companies.length} companies have researched facts`);
}

if (process.argv[1]?.split("/").pop() === "parallel-signals.ts") main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

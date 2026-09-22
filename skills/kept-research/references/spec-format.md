# campaign-spec.json — the contract between the Google Doc tab and the pipeline

One spec per campaign tab. `scripts/kept-lib.ts` `validateSpec` is the authority; a spec
that fails validation never runs. Worked example: `example-campaign-spec.json`.

## What the tab should contain (so it compiles without questions)

| Tab section | Becomes |
|---|---|
| Who the companies are; what looks close but is NOT a fit | `companies.icp`, `qualifies[]`, `disqualifies[]` |
| The SIGNAL that makes a company relevant now, with dates — and nothing else | `companies.discovery.objective` + `match_conditions[]` |
| A fixed company list, if any | `companies.company_list_csv` (columns: `domain` required; `name`, `description` optional) |
| Domains to skip | `companies.exclude_domains[]` |
| The facts needed about each company / the people involved | `signals.fields[]` |
| Who receives the message | `people.recipient` |
| Qualification rules, thresholds, cutoffs | `rules[]` |
| Variables the campaign needs filled | `variables[]` |
| Volume, only if different from the 1,000-company ceiling / 50-lead minimum success threshold | `targets` |
| Instantly lead list name, only if different from `Kept | <tab name>` | `instantly.lead_list` |
| Parallel spend cap, only if different from the global $100 per run | `budget.max_usd` |

## Fields

```
spec_version        "1"
campaign_slug       kebab-case; with client_slug it names the run dir (<client>-<campaign>)
client_slug         kebab-case
source              { doc_id, doc_title, tab, read_at (ISO), tab_sha256, operator_clarifications?[] }
reference_date      YYYY-MM-DD — "today" for recency judgments

companies.icp                   one-liner                          → judge ICP
companies.qualifies[]           bullets                            → judge QUALIFIES
companies.disqualifies[]        bullets                            → judge DOES NOT QUALIFY
companies.lean                  optional, default "lean YES when the identity language fits"
companies.thin_evidence_lean    "YES" | "NO" (strict lanes)
companies.discovery             optional if a list/seeds are given
    .objective                  the SIGNAL in natural language, cast wide ("any company, any size, anywhere"). NO HQ /
                                size / industry / ownership restrictions: those are qualification, applied later
    .entity_type                default "companies"
    .match_conditions[]         { name (snake_case), description } — SIGNAL conditions ONLY (the event, the date window,
                                the named person). The validator rejects conditions that read like ICP / geography / size.
                                Discovery must be broad; Eric's judge and the rules decide fit afterwards.
    .generator                  preview | base | core | pro   (default core)
    .match_limit                OPTIONAL size of the FIRST discovery round (default 50). Later rounds are sized
                                from the observed yield; the run target and spend cap are the real levers.
companies.seeds[]               known-good domains; always enter the judged pool
companies.exclude_domains[]
companies.company_list_csv      absolute path or null

signals.processor               Parallel Task processor, default "core"
signals.research_brief          what to establish about each company
signals.fields[]                { name (snake_case), type: string|number|boolean|date|enum, enum?[], description }
                                description = the literal research question. Every field comes back as
                                a string; "UNCLEAR" means not established. `company_domain`, `company_context`,
                                `contradictions` are always added automatically; `icp_evidence` is added only when the campaign
                                states an ICP (neutral "Any company" ICP → no company-profile facts are researched).
                                These fields are returned BY the FindAll run (enrichment); write each one once —
                                do not add a field that merely restates a match condition.

people.recipient.from_field     signal field holding the recipient's full name, or null
people.recipient.title_field    signal field holding their title (optional)
people.recipient.linkedin_field signal field holding their LinkedIn URL (optional; strongest Quick Enrich identity input)
people.recipient.fallbacks[]    ordered named-person alternates { from_field, title_field?, label }, tried only when
                                from_field is not established (e.g. a continuity owner when there is no boss)
people.recipient.pick_by_title_when_unnamed   default true. false = never pick someone just for their rank:
                                no named person ⇒ no recipient ⇒ on_no_recipient
people.recipient.titles[]       Quick Enrich title filter AND pick priority (first match wins)
people.recipient.title_excludes[]
people.find_email               true = Quick Enrich Employee Search (1 credit) for each company that PASSED the research rules
people.on_no_recipient          REVIEW (default) | REJECT
people.on_no_email              REVIEW (default) | REJECT

rules[]             { id, description, field, op, value?, on_fail: REJECT|REVIEW, on_unknown: REVIEW|REJECT|PASS }
    field           signals.<field> | company.<lane-final column> | recipient.<first_name|last_name|title|email|...>
    op              eq ne in not_in gte lte gt lt is_true is_false exists contains not_contains date_gte date_lte
review_policy.max_unresolved    accepted for compatibility; unresolved facts always mean REVIEW, never REJECT
variables[]         { name, from: signals.<f>|company.<c>|recipient.<c>, required? } → var_<name> columns
targets             OPTIONAL { qualified_leads, max_companies (5-1000) }. Omit it and the GLOBAL rule applies:
                    inspect up to 1,000 unique companies and keep EVERY lead that qualifies; qualified_leads (50)
                    is the MINIMUM SUCCESS THRESHOLD, never a stopping condition.
instantly           OPTIONAL { lead_list?: name, upload?: boolean }. Omit it: list = "Kept | <tab name>", upload on.
                    A lead LIST only — naming a campaign here is a validation error.
budget              OPTIONAL { max_usd } — per-run Parallel spend cap. Omit it and the global $100 applies.
                    Quick Enrich has no cap (unlimited); a legacy max_quickenrich_credits is ignored.
```

## Rule-writing notes

- `on_unknown` is the important choice. `REVIEW` = "would qualify if we knew this";
  `REJECT` = "no evidence means no lead"; `PASS` = nice-to-have only.
- Dates: a source that only gives a year or month is a range. `date_gte 2024-09-08`
  against `2024` is UNRESOLVED (the range straddles the cutoff), against `2023` fails,
  against `2024-10` passes.
- Numbers may arrive as `12`, `12.0` or `"12"` — all compare correctly. `"twelve"` is unresolved.
- Tenure, join dates, ownership: ask for the precise thing ("earliest date joined the company in
  any role"), and ask for the source's own wording in a second string field when the number will
  be quoted in outreach, so a human can audit the quote and not just the number.

## Standing rule — announced-retirement campaigns: who receives it

Compile every announced-retirement tab with this recipient logic (operator rule, 2026-09-21), even
though the tab only says "Send to: the boss":

1. **Normal case: the retiree's boss.** `retiree_boss_full_name` = stated reporting line, else the
   executive the role normally reports to (CFO → CEO). `people.recipient.from_field`.
2. **Retiree is a Chair, Executive Chair, CEO, Owner or Founder with no real boss: do not reject.**
   Switch to the continuity owner, as `people.recipient.fallbacks[0]`:
   COO or President first; then a clearly identified successor, operating executive, or Board Chair
   **only if a source shows they genuinely own the transition**. Capture `continuity_owner_basis`
   and `continuity_owner_evidence` (the source's wording).
3. **Never choose someone just because they are the highest-ranking person.** Set
   `pick_by_title_when_unnamed: false` so Quick Enrich title matching can never stand in for a named person.
4. **No defensible recipient ⇒ REVIEW** (`on_no_recipient: "REVIEW"`), never REJECT.

Field wording to reuse: see the `retiree_has_real_boss`, `retiree_boss_*` and `continuity_owner_*`
fields in any compiled announced-retirement spec.

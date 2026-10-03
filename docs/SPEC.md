# Tend: system spec (the contract every component builds to)

Tend helps a sexual assault survivor recover what their state's crime victim compensation
program already promises. It reads their (mock, Capital One Nessie) bank history, finds costs
the law covers, holds bills the law says they should never have been sent, and assembles a
claim where every dollar points to a transaction and a verbatim quote of the law.
Nothing is filed and no money moves without the survivor's explicit yes.

Design rules that override everything below:
1. The model proposes; code decides. Gemini may suggest an expense category. Only the law
   engine decides eligibility, caps, holds, and totals, using verified rules.
2. Every dollar carries a proof: item id, rule id, source id, source sha256, verbatim quote.
3. Integer cents everywhere. No floats in money paths.
4. No field anywhere stores what happened, where, or who did it. No names of accused people.
5. Demo data is fictional and labeled as such. Nessie is a mock bank and the UI says so.
6. Local-first and encrypted (docs/PRIVACY.md is normative): the WebAssembly engine, statement parsing,
   on-device Gemini Nano classification and bill reading, form filling, and the encrypted vault all run
   in the browser. Only confirmed payments, end-to-end encrypted shares, and opt-in cloud AI leave the
   device. The native engine serves bank-scale batch use and the API's server-side fallback.

## Repository layout

```
rules/        verified corpus: SCHEMA.md, tools/, jurisdictions/ST.json, sources/ST/, verified/ST.json
engine/       C++20 law engine: compiler (tendc), VM (libtend), disassembler (tdis), CLI (tendvm),
              tests, fuzz, bench, wasm build
refengine/    Python reference implementation of the same semantics + differential tests
api/          FastAPI service (Python 3.12, uv): Nessie, classification, claims, packet, actions, share, agent API
web/          Next.js (TypeScript) app; runs the WASM engine on device
agent/        Fetch.ai uAgent (Chat Protocol) that drives the same API from ASI:One
seed/         fictional Nessie worlds (personas) and fixtures
docs/         SPEC.md (this), ARCHITECTURE.md, EVAL.md, devpost.md
```

## Law engine semantics (normative; C++ VM and Python reference must agree exactly)

### Input

```json
{
  "jurisdiction": "MI",
  "context": {
    "incident_date": "2026-06-14",
    "as_of_date": "2026-10-03",
    "police_report": "yes | no | unknown",
    "forensic_exam": true
  },
  "items": [
    {
      "item_id": "nessie:6f1c...",          // stable id; Nessie object id or receipt hash:line
      "date": "2026-06-14",
      "amount_cents": 32500,
      "expense": "forensic_exam",            // enum from rules/SCHEMA.md, or "unknown"
      "confirmed": true,                     // survivor said yes for this line
      "insurance_paid_cents": 0,
      "is_bill": true,                       // an unpaid bill (vs. money already spent)
      "units": 0,                            // weeks for lost_wages, sessions for counseling, miles for transportation; 0 if unknown
      "description": "Riverbend General - forensic exam, deductible applied"
    }
  ]
}
```

### Per-item decision (items processed in order of (date, item_id))

Status is decided by the first matching step:
1. `out_of_window`: date < incident_date, or date > as_of_date. Not related; never counted.
2. `held`: expense == forensic_exam AND an `exam_no_bill` rule exists. Proof: that rule (plus
   `exam_payment` if present). The survivor should not pay this; the UI routes them to the exam
   payment program. If only `exam_payment` exists, also `held` with that rule. If neither exists,
   the item is treated as expense `medical`.
3. `excluded`: an `excluded_expense` rule names this expense. Proof: that rule.
4. `unknown_rule`: no `covered_expense` and no `expense_cap` rule names this expense (or expense is
   "unknown"). Shown as "not included; ask a Navigator". Never counted.
5. `needs_confirmation`: confirmed == false. Shown with its rule, not counted until confirmed.
6. `eligible`: proof is every covered_expense / expense_cap rule for this expense.
   requested = amount_cents. allowed starts at requested.
   If a `collateral_source` rule exists: allowed = max(0, allowed - insurance_paid_cents), and the
   collateral rule joins the proof.

### Aggregate phase (deterministic, after all items)

7. Expense caps: for each `expense_cap` with per == "claim", walk eligible items of that expense in
   order; cumulative allowed may not exceed the cap; the crossing item is cut to the remainder and
   records cap_rule_id; later items get allowed = 0 and cap_rule_id. Caps with per in
   (week, session, hour, mile, day) apply only to items with units > 0:
   allowed = min(allowed, cap * units). Items without units keep their amount and get a
   `rate_unverified` flag naming the cap rule.
8. Total cap: same walk over all eligible items (all expenses) against `total_cap` (if several, the
   smallest). Crossing item cut, later items zero.
9. Minimum loss: if a `minimum_loss` rule exists with amount_cents and total allowed < amount, the
   check is `not_met` unless forensic_exam is true and `waived_for` contains "sexual_assault"
   (then `waived`). With only days_lost, the check is `unknown`.
10. Deadline: deadline_date = incident_date + years (calendar years) or days. `ok` if
    as_of_date <= deadline_date, else `late`. Multiple deadline rules: use the longest and list all.
    If none: `unknown`.
11. Reporting: if a `reporting_requirement` exists: `satisfied` when police_report == yes, or when
    forensic_exam is true and alternatives contain forensic_exam; `required` when police_report == no
    and no alternative applies; otherwise `unknown`.
12. Info rules (collateral_source, conduct_reduction, emergency_award, eligible_crime, residency)
    are listed for display. Tend never screens anyone on conduct.

### Output

```json
{
  "jurisdiction": "MI",
  "law_image_sha256": "...",
  "lines": [
    {"item_id": "...", "expense": "counseling", "status": "eligible",
     "requested_cents": 15000, "allowed_cents": 15000,
     "rule_ids": ["MI-COUNSEL-1"], "cap_rule_id": null, "flags": []}
  ],
  "totals": {"requested_cents": 0, "allowed_cents": 0, "held_cents": 0, "by_expense": {"counseling": 0}},
  "checks": {
    "deadline": {"status": "ok", "deadline_date": "2031-06-14", "rule_ids": ["MI-DEADLINE-1"]},
    "minimum_loss": {"status": "met", "rule_ids": []},
    "reporting": {"status": "satisfied", "rule_ids": []}
  },
  "info_rule_ids": ["MI-COLLATERAL-1"],
  "trace": [ {"op": "...", "item_id": "...", "rule_id": "...", "delta_cents": 0} ]
}
```
`trace` is the VM's execution log (one entry per decision or cap cut); the Python reference emits
the same decisions in the same order, so traces can be diffed.

## Law image (.tlaw) and the VM (engine/ owns the details; these points are fixed)

- `tendc rules/verified/MI.json -o build/laws/MI.tlaw` compiles one jurisdiction. The image holds a
  header (magic "TLAW", format version, jurisdiction, sha256 of the verified JSON), a constant pool
  (rule ids, pinpoints, quotes, source ids and hashes), a rule table, and bytecode.
- The VM really executes bytecode: per-item programs (window, exam hold, exclusion, coverage,
  confirmation, collateral) and an aggregate program (caps, total cap, minimum loss, deadline,
  reporting). Adding a jurisdiction is new data, never new code.
- `tdis MI.tlaw` prints a readable assembly listing; each rule block is commented with its pinpoint
  and the start of its quote, e.g.
  `; MI-EXAM-1  MCL 18.355a(2)  "A health care provider shall not submit a bill..."`.
- The loader validates everything (magic, version, bounds, jump targets, stack depth, checksums)
  and rejects malformed images without crashing. It is fuzzed.
- C ABI (same symbols natively and in WASM):
  `tend_eval_json(const uint8_t* img, size_t img_len, const char* input_json) -> char*` (caller frees with `tend_free`),
  `tend_disasm(const uint8_t* img, size_t img_len) -> char*`, `tend_version() -> const char*`.
- Native shared library for the API (ctypes), a CLI (`tendvm eval --law X.tlaw --input in.json`),
  and an Emscripten build that writes `web/public/engine/tend.js` + `tend.wasm`.

## API (FastAPI, prefix /api)

- `GET /jurisdictions` list with rule and source counts; `GET /jurisdictions/{st}` verified rules with fragment links; `GET /jurisdictions/{st}/asm` disassembly.
- `POST /scan` {persona_id or customer_id, st, incident_date} -> items with proposed expense, confidence, and `confirmed: false` for inferred items.
- `POST /claim` engine input -> engine output (native engine; falls back to refengine and says so in a header).
- `POST /bill/audit` -> extracted bill lines (sum must equal the bill total) and holds.
- `POST /actions/propose` -> {action_id, amount_cents, from, payee, confirm_code, expires_at}; `POST /actions/confirm` {action_id, confirm_code} -> Nessie write, read-back, audit row. Single use; integer cents.
- `GET /packet/{claim_id}.pdf`; `POST /share` -> expiring read-only link; `GET /share/{token}`.
- Agent endpoints mirror these for the Fetch.ai agent.

## Nessie (mock bank) facts every component must respect

- Base URL https://api.nessieisreal.com (HTTPS only from the venue). Key in .env as NESSIE_API_KEY.
- It is a record store: account.balance never changes after creation. Balances are computed by our
  ledger from records. Amounts are integers. Transfers carry no payee (put it in the description).
  Other keys can read account sub-collections, so seed only fictional data.

## Personas (seed/)

Rowan (Michigan) is the main demo. The same transaction history is also seeded for New York,
California, and Texas personas so the demo can switch jurisdiction and show the claim recompute
under each state's law.

## v1.1: the law IR (supersedes the engine input section where they differ)

The verified corpus is faithful to 51 different legal systems, so its params vary. A Python front
end, `rules/tools/normalize.py`, turns each `rules/verified/ST.json` into a canonical
`rules/ir/ST.json`. Both engines read ONLY the IR: the C++ compiler `tendc` compiles IR to a .tlaw
image, and the Python reference interprets IR directly. Differential tests therefore compare two
independent back ends on identical input.

IR shape (all money in integer cents, all durations in days):

```json
{
  "ir_version": 1, "jurisdiction": "MI", "source_sha256": "<sha256 of verified/MI.json>",
  "rules": [
    {"id": "MI-CAP-2", "kind": "expense_cap", "expense": "counseling",
     "cap_cents": 8000, "per": "unit", "unit": "session", "count_limit": 35},
    {"id": "MI-CAP-1", "kind": "total_cap", "cap_cents": 4500000},
    {"id": "MI-EXAM-1", "kind": "exam_no_bill"},
    {"id": "MI-EXCL-1", "kind": "excluded", "expense": "property_replacement", "tags": ["phone"]},
    {"id": "MI-COVER-3", "kind": "covered", "expense": "transportation"},
    {"id": "MI-FILE-1", "kind": "deadline", "days": 1826, "from": "crime"},
    {"id": "MI-REPORT-1", "kind": "reporting", "required": true, "alternatives": ["forensic_exam"]},
    {"id": "MI-MIN-1", "kind": "minimum_loss", "cap_cents": 20000, "days_lost": 5, "waiver": "discretionary", "waiver_for_sexual_assault": true},
    {"id": "MI-COLL-1", "kind": "info", "category": "collateral_source"}
  ],
  "skipped": [{"id": "MD-COV-10", "reason": "applies_to: household family members, not the survivor"}]
}
```

Normalization rules (the front end owns these; engines never see raw params):
- `per`: claim, residence, crime_scene -> "claim". week, session, hour, mile, day, month, item ->
  "unit" with that unit name. Unknown -> rule goes to `skipped` with the reason.
- Rules with `applies_to` naming anyone other than the victim/claimant -> `skipped`.
- Deadlines: years -> days (365*years + leap days approximated as years*365 + years//4),
  months -> 30*months, days kept. No duration -> `info`.
- `excluded_expense` with an `item` text: map to tags with a fixed keyword table (phone, cell phone,
  mobile -> "phone"; purse, wallet, handbag -> "purse"; jewelry -> "jewelry"; cash, money ->
  "cash"; car, vehicle -> "vehicle"; pain and suffering -> "pain_suffering"). An excluded rule
  matches an item when expense matches (if given) AND (no tags OR the item carries one of the tags).
  Unmapped item text -> `info`.
- `minimum_loss` waiver: "automatic" only if the quote says the requirement does not apply to
  sexual assault victims; otherwise "discretionary" when waived_for mentions sexual assault,
  criminal sexual conduct, or forensic exam. Engines report `may_be_waived`, never `waived`, for
  discretionary waivers.
- `reporting`: required flag plus alternatives as given; within_hours -> within_days rounded up.
- Several caps on the same (expense, per, unit): keep the most generous and add the others to the
  line's `alt_cap_rule_ids` (the program decides which provider rate applies).
- Everything else that is not decision-relevant (residency, eligible_crime, conduct_reduction,
  emergency_award, exam_payment, collateral_source) -> `info` with its category. collateral_source
  info still triggers the insurance subtraction in step 6.

Engine semantics changes from v1.0:
- Items may carry `tags` (classifier-set, e.g. ["phone"]).
- Step 6 uses `unit` caps: allowed = min(allowed, cap_cents * units) when units > 0, and a
  `count_limit` caps units at that count across the claim (in item order).
- Minimum loss statuses: met, not_met, may_be_waived, unknown.
- Reporting status: satisfied if police_report == yes, or forensic_exam is true and ANY reporting
  rule lists forensic_exam; required if some rule has required=true and nothing satisfies it;
  not_required if every rule has required=false; else unknown.

## v1.2: semantic fixes from the wave-1 reviews (normative; both engines must match exactly)

IR version 2 (rules/tools/normalize.py) changes:
- An excluded rule that names an expense AND a narrowing item becomes `info` when the item text maps
  to no tag. One excluded item never removes a whole category.
- Deadlines are decision rules only when counted from the crime, incident, discovery, injury,
  offense, or police report. A deadline counted from the report is computed from the incident date
  (the earliest it could start) and the line gets the flag `deadline_from_report`, which the UI
  explains as "measured from the date it happened; the law counts from your report, so you may have
  longer." Deadlines counted from an 18th or 21st birthday are `info` (Tend never asks for age).
- A minimum_loss rule with no threshold whose quote says there is no minimum compiles to
  `cap_cents: 0` (always met).

Engine semantics changes:
1. Typed units. Items carry `unit` ("session", "week", "hour", "mile", "day", "month", "item", or
   null) next to `units`. A per-unit cap applies only when `cap.unit == item.unit` and `units > 0`:
   allowed = min(allowed, cap_cents * units). Otherwise the cap is not applied and the line gets the
   flag `rate_unverified:<rule_id>`. `count_limit` caps the total units counted for that rule across
   the claim, in item order.
2. Held exams. An exam line is `held` only when an `exam_no_bill` rule exists; its proof is every
   exam_no_bill rule, then every exam_payment rule. Without exam_no_bill, the exam line is treated
   as `medical`, and exam_payment rules are listed in info.
3. Minimum loss. Tend serves sexual assault survivors, so the waiver check no longer depends on
   forensic_exam. With total allowed below cap_cents: `waived` if waiver == automatic and
   waiver_for_sexual_assault; `may_be_waived` if discretionary and waiver_for_sexual_assault;
   otherwise `not_met`. A rule with days_lost is also `met` when the claim's lost_wages items have
   unit week and sum(units) * 5 >= days_lost, or unit day and sum(units) >= days_lost.
4. Input validation (both engines reject identically): duplicate item_id, any integer outside
   [-(2^53-1), 2^53-1], amount_cents < 0, unknown expense or unit strings. Errors use the shape
   {"error": {"code": "bad_input", "message": "..."}}.
5. The trace vocabulary, flag formats, and every open choice listed in engine/FORMAT.md section 4
   are normative; refengine/README.md must point to them rather than restate them.

Clarifications (wave 2, engines). Points 1, 3, and 4 and the deadline flag above left room; both
engines read them this way, and engine/FORMAT.md sections 4 and 5 give the full detail:
- `deadline_from_report` is a flag on the deadline check: `checks.deadline.flags` is
  `["deadline_from_report"]` when any deadline rule counts from the report, else `[]`.
- Lost-wage days add up across lines: 5 x the units of eligible lost_wages lines with unit week,
  plus the units of those with unit day. Lines that are not eligible do not count.
- A rule with only days_lost that the claim does not meet is `unknown`. Several minimum loss
  rules combine to the most severe status: not_met, may_be_waived, unknown, waived, met.
- The integer bounds apply to the integers the engine reads (amount_cents, insurance_paid_cents,
  units), and all three must be >= 0. A known key written twice in one object is bad_input.
- `count_limit` counts only units on lines the cap applies to (matching unit, units > 0).

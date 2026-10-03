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
6. The same engine runs natively (server, bank-scale batch) and as WebAssembly in the browser,
   so a survivor can run their claim without their bank data leaving the device.

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

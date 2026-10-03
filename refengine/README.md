# refengine

A plain Python implementation of the law engine in `docs/SPEC.md`, written to be read. The C++ VM
has to produce the same output for the same rules and input, and `difftest.py` checks that on
random claims. The API also falls back to this package when the native engine is unavailable.

Python 3.12, standard library only (pytest for the tests).

## Run it

```sh
cd refengine && uv sync && cd ..
uv run --project refengine python -m tend_ref eval --rules rules/verified/MI.json --input in.json
uv run --project refengine python -m tend_ref gen --rules rules/verified/MI.json --seed 1 --index 0 > in.json
```

`eval` prints the engine output (`--compact` for one line, `--input -` for stdin) and exits 2 with
`error: ...` on stderr for bad input. `gen` prints a random engine input from the same generator
the difftest uses.

From Python:

```python
from tend_ref import EngineInputError, Law, evaluate, load_rules

rules, sha = load_rules("rules/verified/MI.json")
out = evaluate(rules, engine_input, law_sha256=sha)  # raises EngineInputError on bad input
law = Law(rules, sha)                                # index once, then law.evaluate(...) per claim
```

For `api/`, add `tend-ref` to its dependencies with
`[tool.uv.sources] tend-ref = { path = "../refengine", editable = true }`.

## Tests

```sh
cd refengine && uv run pytest
```

Unit tests per SPEC step use the synthetic jurisdiction `tests/fixtures/ZZ.json` (every category,
edge cases for each step) and `ZY.json` (most categories missing). `tests/golden/` holds an input
whose expected output was worked out by hand from the SPEC; any engine can be checked against it
(ignore `law_image_sha256`). `test_real_rules.py` runs generated claims through every file in
`rules/verified/` (or `TEND_RULES_DIR`) and skips when there are none.

## Differential test

```sh
python refengine/difftest.py --n 10000 --rules-dir rules/verified
```

- Looks for `engine/build/libtend.dylib` (or `.so`), called through the C ABI with ctypes, then for
  `engine/build/tendvm`. Either needs `tendc` to compile each `ST.json` to a `.tlaw` in a temp dir.
  `--engine-lib`, `--engine-cli`, `--tendc` set paths; `--prefer-cli` runs one process per claim so
  an engine crash cannot take the run down. `--engine-cmd "... {law} {rules} {input}"` runs any command.
- With no engine it runs the reference alone, checks every output against the invariants in
  `tend_ref/invariants.py`, and prints a NOTICE that nothing was compared.
- Claim N of jurisdiction ST comes from (seed, ST, N). On a mismatch it shrinks the input to the
  fewest items that still disagree, prints the differing fields and the first differing trace entry,
  saves the input, and prints a `--replay ST:N` command.
- `law_image_sha256` is not compared unless `--compare-sha` is given (the reference has no image).
  `--no-trace` compares everything but the trace. The ZY and ZZ fixtures run too unless `--no-fixtures`.

## Readings where the SPEC is silent

The C++ engine has to make the same choices. Rule ids in parentheses are real cases from
`rules/verified/` that make the choice matter.

1. A rule's expense is `rule.expense`, else `params.expense`. Rules that only describe an item in
   text (`params.item`) match no expense.
2. Hold proof is the `exam_no_bill` rules, then the `exam_payment` rules, each in file order,
   counting only rules that name `forensic_exam` or no expense. Some exam rules name `medical`
   (WV-EXAM-3 says the facility may bill for nonforensic care), and they cannot prove an exam bill
   is held.
3. A forensic exam with no hold rules becomes `medical` for every later step and in its output line.
4. Proof lists every matching rule in file order; `covered_expense` and `expense_cap` interleave as
   they appear. On an eligible line all `collateral_source` rules follow the coverage rules.
5. `requested_cents` is the amount on every line; `allowed_cents` is 0 unless eligible. Totals count
   eligible lines only, `held_cents` sums held amounts, and `by_expense` maps each expense with an
   eligible line to its allowed cents (sorted keys, zeros kept).
6. With a collateral rule, every eligible line logs a `collateral` entry, even when insurance is 0.
7. A cap without `amount_cents` does nothing (`count_limit` and `weeks` are not enforced). Unit caps
   (week, session, hour, mile, day) run before claim caps, each group in file order, so the claim
   walk sees rate-limited amounts. Any other `per` (claim, crime_scene, residence, or missing) is a
   claim cap (MI-CAP-9, MI-CAP-11).
8. A cap cuts a line only when its allowed amount is more than the room left. A cut sets
   `cap_rule_id` (the last cap to cut wins). A later line already at 0, say paid in full by
   insurance, keeps `cap_rule_id: null`.
9. A unit cap on a line with no units adds the flag `rate_unverified:<rule_id>`.
10. Of several total caps the smallest governs; on a tie, the first in the file.
11. Minimum loss: each rule with `amount_cents` passes, fails, or fails but is waived (`forensic_exam`
    is true and `waived_for`, a string or a list, contains exactly `sexual_assault`). Any unwaived
    failure is `not_met`, otherwise any waived one is `waived`, otherwise `met`. With no amount rule,
    a `days_lost` rule makes it `unknown`. No rule, or only rules with neither threshold
    (NJ-MINLOSS-1 says there is no minimum), is `met`.
12. Deadline: on one rule, `years` (calendar years, Feb 29 to Feb 28) beats `days`. Rules counted
    from `age_18` are listed but not dated, since the engine has no birth date and counting from the
    incident would stretch an adult's deadline (VA-DEADLINE-4: 10 years instead of 3). Rules with no
    period are listed only. Dates past 9999-12-31 stop there.
13. Reporting pools `alternatives` across all reporting rules. `satisfied`: a police report was
    made, or there was an exam and some rule lists `forensic_exam`, or no rule has `required: true`
    (a missing `required` counts as true; no rules at all lands here too). `required`: no police
    report and every pooled alternative is `forensic_exam`, the only one the engine can rule out.
    Otherwise `unknown`, because an advocate or protective order might still apply (NY-REPORT-4).
14. A check's `rule_ids` lists every rule of its category in file order.
15. Input: strict `YYYY-MM-DD` dates; money and units are integers from 0 to 2^53 - 1 (no floats, no
    booleans); unique `item_id`s; the input's jurisdiction must match the rules (any case) or be
    absent. Missing or null optional fields default to `confirmed: false`, `insurance_paid_cents: 0`,
    `units: 0`, `is_bill: false`, `expense: "unknown"`. An expense outside the enum is `unknown_rule`.
    Lines are sorted by `(date, item_id)`, ids compared by code point (the same as UTF-8 bytes).
16. `law_image_sha256` is the sha256 of the rules file bytes when loaded with `load_rules` (the CLI),
    otherwise of the canonical rules JSON (sorted keys, no spaces).

Two data notes that follow from the SPEC as written, worth a look by whoever owns the rules:
MI-MIN-1 reads "$200 or 5 days of lost earnings" but only the amount can be tested, so a small
Michigan claim is `not_met`; SC-MIN-2 encodes its exam waiver as `["forensic_exam"]`, which the
SPEC's `sexual_assault` test never matches.

## Trace

One entry per decision or change, `{"op", "item_id", "rule_id", "delta_cents"}`. `delta_cents` is
the change to that line's allowed amount, so one item's deltas sum to its `allowed_cents`.

| op | rule_id | delta_cents |
|---|---|---|
| `out_of_window`, `unknown_rule`, `exam_as_medical` | null | 0 |
| `held`, `excluded`, `needs_confirmation` | first proof rule | 0 |
| `eligible` | first coverage rule | + amount |
| `collateral` | first collateral rule | minus the insurance taken off |
| `rate_cap`, `expense_cap`, `total_cap` | the cap | minus the cut |
| `rate_unverified` | the cap | 0 |
| `minimum_loss_<status>` | first unwaived failing rule (not_met), first waived failing rule (waived), first days_lost rule (unknown), else null | 0 |
| `deadline_<status>` | the rule with the latest date, or null | 0 |
| `reporting_<status>` | the rule listing forensic_exam when the exam satisfies it, the first requiring rule for required or unknown, else null | 0 |

Order: items in `(date, item_id)` order through steps 1-6; then unit caps (rule by rule, lines in
order), claim caps, the total cap; then `minimum_loss`, `deadline`, `reporting`. Check entries have
`item_id: null`.

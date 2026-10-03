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
python3 refengine/difftest.py --n 10000 --rules-dir rules/verified
```

- Looks for `engine/build/libtend.dylib` (or `.so`), called through the C ABI with ctypes, then for
  `engine/build/tendvm`. Either needs `tendc` to compile each `ST.json` to a `.tlaw` in a temp dir.
  `--engine-lib`, `--engine-cli`, `--tendc` set paths; `--prefer-cli` runs one process per claim so
  an engine crash cannot take the run down. `--engine-cmd "... {law} {rules} {input}"` runs any command.
- With no engine it runs the reference alone, checks every output against the invariants in
  `tend_ref/invariants.py`, and prints a NOTICE that nothing was compared.
- Claim N of jurisdiction ST comes from (seed, ST, N). On a mismatch it shrinks the input to the
  fewest items that still disagree, prints the differing fields and the first differing trace entry,
  saves the input, and prints a `--replay ST:N` command. `--keep-going` counts every failing claim
  and lists them by differing field.
- `law_image_sha256` is not compared unless `--compare-sha` is given (the reference has no image).
  `--no-trace` compares everything but the trace. The ZY and ZZ fixtures run too unless `--no-fixtures`.

## Readings where the SPEC leaves room

The C++ engine makes the same choices except the last sentence of 11 (see the last question
below); difftest holds both to them.

1. A rule's expense is `rule.expense`, else `params.expense`. A rule that only describes an item in
   text (`params.item`) names no expense.
2. Hold proof is every `exam_no_bill` rule, then every `exam_payment` rule, each in file order,
   whatever expense the rule names ("an exam_no_bill rule exists").
3. A forensic exam with no hold rules becomes `medical` for every later step and in its output line.
4. Proof lists every matching rule in file order; `covered_expense` and `expense_cap` interleave as
   they appear. An eligible line adds every `collateral_source` rule after its coverage rules.
5. `requested_cents` is the amount on every line; `allowed_cents` is 0 unless eligible. Totals count
   eligible lines only, `held_cents` sums held amounts, and `by_expense` maps each expense with an
   eligible line to its allowed cents (sorted keys, zeros kept).
6. Insurance is logged as a `collateral` entry only when it changes the allowed amount.
7. A cap without `amount_cents` limits nothing (`count_limit` and `weeks` are not enforced). A
   missing `per` means per claim. Unit caps (week, session, hour, mile, day) apply `rate x units` to
   lines with units and flag lines without. A cap per anything else (residence, crime_scene, month,
   item) cannot be measured, so it flags every eligible line of its expense and cuts nothing. These
   run first, in file order, then the claim caps in file order.
8. A walk cuts the line that crosses the cap to what is left, then sets every later line to 0 with
   that `cap_rule_id` and a trace entry, even a line that was already at 0. A line keeps the last
   cap that cut it.
9. A flag reads `rate_unverified:<rule_id>`.
10. Of several total caps the smallest governs; on a tie, the first in the file.
11. Minimum loss: every rule with `amount_cents` is tested; any unwaived shortfall is `not_met`,
    else any waived one is `waived`, else `met`. A shortfall is waived when `forensic_exam` is true
    and `waived_for` is a string containing `sexual_assault` or a list with that exact entry. With
    no amount rule, a `days_lost` rule makes it `unknown`. No rule, or only rules with neither
    threshold, is `met`.
12. Deadline: every rule with `years` or `days` is dated from `incident_date` (years win on one rule;
    Feb 29 lands on Feb 28; dates stop at 9999-12-31) and the latest date wins. Rules with no period
    are listed only.
13. Reporting: no rules is `satisfied`. Otherwise `satisfied` when a police report was made, or there
    was an exam and some rule lists `forensic_exam`; `required` when no report was made, some rule
    has `required: true` (missing counts as true), and no rule lists an alternative other than
    `forensic_exam`; otherwise `unknown`. A string `alternatives` counts as the exam when it contains
    `forensic_exam` and as another alternative unless it is empty or exactly `forensic_exam`.
14. A check's `rule_ids` lists every rule of its category in file order. Categories no step uses
    (`submission`, `required_document`, `processing_time`) are ignored, and only the five SPEC
    categories go in `info_rule_ids`.
15. Input: strict `YYYY-MM-DD` dates; money and units are integers from 0 to 2^53 - 1 (no floats, no
    booleans); unique `item_id`s; the input's jurisdiction must equal the rules' or be absent.
    Missing or null optional fields default to `confirmed: false`, `insurance_paid_cents: 0`,
    `units: 0`, `is_bill: false`, `expense: "unknown"`. An expense outside the enum reads as
    `unknown`. Lines are sorted by `(date, item_id)`, ids compared by code point (UTF-8 byte order).
16. `law_image_sha256` is the sha256 of the rules file bytes when loaded with `load_rules` (the CLI),
    otherwise of the canonical rules JSON (sorted keys, no spaces).

## Trace

One entry per decision or change, `{"op", "item_id", "rule_id", "delta_cents"}`. `delta_cents` is
the change to that line's allowed amount, so one item's deltas sum to its `allowed_cents`.

| op | rule_id | delta_cents |
|---|---|---|
| `out_of_window`, `unknown_rule` | null | 0 |
| `held`, `excluded`, `needs_confirmation` | first proof rule | 0 |
| `eligible` | first coverage rule | + amount |
| `collateral` | first collateral rule | minus the insurance taken off |
| `unit_cap`, `expense_cap`, `total_cap` | the cap | new allowed minus old |
| `rate_unverified` | the cap | 0 |
| `minimum_loss`, `deadline`, `reporting` | first rule in the check's `rule_ids`, or null | 0 |

Order: items in `(date, item_id)` order through steps 1-6; then unit and unmeasurable caps (rule by
rule, lines in order), claim caps, the total cap; then `minimum_loss`, `deadline`, `reporting`,
whose entries have `item_id: null`.

## Questions for whoever owns the SPEC and the rules

Each follows from the SPEC as written and shows up in real files:

- Hold proof can cite a rule that argues the other way: WV-EXAM-3 (category `exam_payment`, expense
  `medical`) says the facility may bill for nonforensic care. Filtering hold proof to rules that
  name `forensic_exam` or no expense would fix it.
- Dating `age_18` rules from the incident overstates adult deadlines: VA-DEADLINE-4 gives 10 years
  where adults have 3, so a late Virginia claim can read `ok`.
- MI-MIN-1 is "$200 or 5 days of lost earnings", but only the amount can be tested, so a small
  Michigan claim reads `not_met`.
- SC-MIN-2 encodes its exam waiver as `["forensic_exam"]`, which the `sexual_assault` test never
  matches.
- `count_limit` (session counts) and caps per month or per item are not enforced, only flagged.
- NJ-MINLOSS-1 is a `minimum_loss` rule with no threshold ("There are no minimum loss
  requirements"). The SPEC only makes a days_lost-only rule `unknown`, so the reference says `met`;
  the C++ engine says `unknown` for any rule without an amount. One of them should change.

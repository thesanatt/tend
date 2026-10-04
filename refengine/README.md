# refengine

A plain Python implementation of the Tend law engine (docs/SPEC.md v1.3), written to be read and
checked by eye. It reads the same law IR as the C++ compiler (`rules/ir/ST.json`, IR version 2)
and must produce the same result document for the same claim, byte for byte, trace included.
`difftest.py` checks that on random claims. The API falls back to this package when the native
engine is not available.

Python 3.12, standard library only (pytest for the tests).

## What is normative

Every choice the SPEC leaves open is settled in **engine/FORMAT.md section 4** (semantics) and
**section 5** (input validation, error messages, output document). This package follows those
sections and does not restate them. If the two engines ever disagree, the SPEC and FORMAT.md
decide which one is wrong.

The reference reads a law the way `tendc` does: the same IR is accepted or refused, with the same
error message (`tests/test_law.py` runs a table of broken laws through both, and
`difftest.py --ir-fuzz` does it on random ones). The verified file (`rules/verified/ST.json`) is
read only to bind the IR to it (its sha256 must match the IR's `source_sha256`) and to attach
quotes and pinpoints for display.

## Run it

```sh
cd refengine && uv sync && cd ..
uv run --project refengine python -m tend_ref gen --ir rules/ir/MI.json --seed 1 --index 0 > claim.json
uv run --project refengine python -m tend_ref eval --ir rules/ir/MI.json --input claim.json
uv run --project refengine python -m tend_ref check --ir rules/ir/MI.json
```

`eval` prints the result (`--compact` for one line, `--input -` for stdin). A refused claim prints
the error document and exits 1, as `tendvm eval` does; a law `tendc` would refuse prints
`error: ...` and exits 2. `--law-sha256` sets `law_image_sha256` (pass the compiled image's
sha256 to get the C++ engine's exact bytes).

From Python:

```python
from tend_ref import EngineInputError, Law, evaluate, evaluate_json, load_law

law = load_law("rules/ir/MI.json")          # finds rules/verified/MI.json next to it
out = law.evaluate(claim_dict)              # raises EngineInputError(code, message)
text = evaluate_json(law, raw_claim_bytes)  # like tend_eval_json: an error document instead
out = evaluate(ir_dict, claim_dict)         # an IR document works too (what api/ passes)
```

## Layout

```
tend_ref/law.py         IR v2 loader: tendc's checks and messages, rule indexes per SPEC step
tend_ref/claim.py       claim JSON: strict reading, then validation in document order
tend_ref/engine.py      steps 1-12, with int64 saturation where the VM saturates
tend_ref/gen.py         seeded random claims aimed at each law (and broken ones)
tend_ref/randlaw.py     random laws and broken laws for the difftest
tend_ref/invariants.py  properties every output must have
difftest.py             reference vs C++ engine on random claims
```

## Tests

```sh
cd refengine && uv run pytest
```

- `test_items.py`, `test_caps.py`, `test_checks.py`: each SPEC step, hand-computed on the synthetic
  `tests/fixtures/ir/ZZ.json` (built from `tests/fixtures/verified/ZZ.json` by the real
  `rules/tools/normalize.py`; `test_fixtures.py` checks that) and on small laws written in the test.
- `test_golden.py`: `tests/golden/zz_mixed` is a claim worked out by hand line by line (the
  arithmetic is in the test); the expected file was written by the C++ engine and the reference
  must match it byte for byte. It also reproduces the C++ engine's own golden output.
- `test_input.py`: every validation message, through the reference and, when `engine/build` has
  `libtend`, through the C++ engine, which must return the same bytes.
- `test_law.py`: laws `tendc` refuses, with its messages, checked against `tendc` when it is built.
- `test_gen.py`, `test_real_rules.py`, `test_cli.py`, `test_difftest.py`: the generator, every
  `rules/ir` file under the invariants, the command line, and the difftest against a stand-in
  engine with planted bugs.

## Differential test

```sh
python3 refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000
```

- Compiles every `rules/ir/*.json` (and the ZY and ZZ fixtures, unless `--no-fixtures`) with
  `engine/build/tendc`, then sends the same claim bytes to `engine/build/libtend` (ctypes) and to the
  reference. `--prefer-cli` uses `tendvm` instead, one process per claim, so a crash cannot take the
  run down; `--engine-cmd "... {law} {input}"` runs any command.
- Claim N of law ST comes from (seed, ST, N). About 4% of claims are broken on purpose (bad
  values, repeated keys, text that is not JSON). Well-formed claims must give byte-identical
  results; text that is not JSON must be refused by both with `bad_input` (the C++ message adds a
  byte offset, so only the code is compared there).
- `--random-laws N` adds N random laws (`--random-claims` claims each) that combine rules the
  corpus never does. `--ir-fuzz N` checks N broken laws against `tendc`'s refusals.
- On a mismatch it shrinks the claim to the fewest items that still disagree, saves it, and
  prints a `--replay ST:N` command. `--keep-going` counts every failing claim by differing field.
- Without a C++ engine it runs the reference alone against its invariants and says so.
- `--corpus DIR` saves every agreed claim with the sha256 of the native result, for
  `engine/tests/wasm_parity.mjs`, which checks the WebAssembly build against the same bytes.

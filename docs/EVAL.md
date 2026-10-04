# Tend: evaluation

Every number Tend claims, the command that produces it, and what it does not show.

Two kinds of numbers appear here, and each row says which:

- **Reproduced Oct 4, 2026** from `main` at `5832f8f`, in a Linux container: 4 vCPUs of an Intel
  Xeon at 2.1 GHz (a shared VM), GCC 13.3, Node 22.22, Python 3.12.3, uv 0.8.17.
- **Recorded Oct 3, 2026** by the author on an Apple M4 Max laptop, quoted from the file named.
  These could not be rerun here, and the reason is given.

Engine detail (the difftest breakdown, fuzzing, the review pass) is in
[engine/EVAL.md](../engine/EVAL.md). Throughput detail is in [engine/BENCH.md](../engine/BENCH.md).
Neon detail is in [NEON.md](NEON.md).

## Test suites

| Suite | Command | Result | When |
|---|---|---|---|
| C++ engine | `make -C engine && make -C engine test` | 70 test cases, 27,376 assertions, all pass (1 min 18 s with the build) | reproduced Oct 4 |
| C++ engine under ASan and UBSan | `make -C engine test-san` | 70 of 70 pass | reproduced Oct 4 |
| VM vs the independent C++ oracle, random laws | inside `make test` | 6,000 evaluations (1,500 random laws x 4 claims), 0 differences | reproduced Oct 4 |
| VM vs oracle, real laws | inside `make test` | 51 jurisdictions x 12 scenarios, 0 differences | reproduced Oct 4 |
| Shipped law images | inside `make test` | all 51 in `web/public/engine/laws` byte-identical to a fresh `tendc` build | reproduced Oct 4 |
| Python reference engine | `cd refengine && uv run pytest` | 470 passed | reproduced Oct 4 |
| Difftest, reference vs C++ | `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` | 121,000 claims, 0 mismatches; 119,544 well-formed claims byte-identical; 3,000 random or broken laws, 0 disagreements (59.6 s) | reproduced Oct 4 |
| WASM vs native | `make -C engine wasm-parity` | 106,000 of 106,000 claims byte-identical across 53 laws; all 51 shipped images checked (24.4 s in Node) | reproduced Oct 4 |
| Fuzzing under ASan and UBSan | `make -C engine fuzz FUZZ_SECONDS=420` | 1,276,000 executions in 420 s, then 2,517,704 in 660 s; no crashes, no property violations | recorded Oct 3 ([engine/EVAL.md](../engine/EVAL.md)); not built here, see below |
| API | `cd api && uv run pytest` | 395 tests: 373 passed, 22 skipped (the Neon tests, which need `TEND_NEON_TEST=1` and a database URL) | reproduced Oct 4 |
| API on Neon | `TEND_NEON_TEST=1 uv run pytest -k "neon or live"` | 32 tests, about 70 s | recorded Oct 3 ([NEON.md](NEON.md)); needs a Neon URL |
| Neon role limits | `uv run python ../scripts/neon/roles.py` | 28 of 28 checks as expected | recorded Oct 3 ([NEON.md](NEON.md)); needs Neon |
| Seed (fictional bank) | `cd seed && uv run pytest` | 166 tests: 161 passed, 5 skipped (live Nessie, needs `TEND_LIVE=1` and a key) | reproduced Oct 4 |
| Agents | `cd agent && uv run pytest` | 259 tests: 258 passed, 1 failed (see below) | reproduced Oct 4 |
| Web types | `cd web && npm ci && npx tsc --noEmit` | no errors | reproduced Oct 4 |
| Web tests | `cd web && npx vitest run` | 40 files, 1,182 tests: 1,178 passed, 4 failed (see below) | reproduced Oct 4 |
| Rules: every quote verbatim | `python3 rules/tools/verify.py all` | 51 of 51 jurisdictions PASS (2,578 rules, 824 sources); no file changed | reproduced Oct 4 |
| Rules: IR is reproducible | `uv run --python 3.12 rules/tools/normalize.py` | all 51 IR files regenerated with no diff | reproduced Oct 4 |
| Law image is reproducible | `engine/build/tendc rules/ir/MI.json -o MI.tlaw` | 51,812 bytes, sha256 `54f9809e...`, the same bytes as the image built on macOS and shipped | reproduced Oct 4 |

### What failed, and why

- **Web, 4 tests** (`web/tests/local/classify-parity.test.ts:101`, one per persona). The test
  checks that each seed snapshot still has the sha256 recorded in
  `web/tests/local/fixtures/classify-parity.json`. Commit `b536bca` re-read the four snapshots from
  live Nessie (same 190 records, new history fingerprint) after that fixture was written, so the
  recorded hashes are stale. The parity tests themselves, which compare the TypeScript classifier
  with the Python one on those snapshots, pass. The fix is to rewrite the four hashes in the
  fixture.
- **Agents, 1 test** (`test_a_sub_agent_that_never_answers_gets_a_clear_fallback`). It points the
  Navigator at an address nobody runs. uagents then asks the Almanac contract on the Fetch.ai
  testnet where that address lives, and this container cannot reach the ledger, so the resolver
  raises `ValueError: Almanac contract not found for testnet` before the timeout path runs. The
  Navigator answers with its generic "Something went wrong on my side" message instead of the
  expected "The Law agent isn't answering right now". The 258 other tests, including the full
  three-agent loop, pass. agent/README.md reports 259 passing on the author's machine.
- **Fuzzer, not built.** `engine/fuzz/fuzz.cpp` needs clang's SanitizerCoverage runtime and
  headers (`sanitizer/common_interface_defs.h`). This container's clang 18 ships without
  compiler-rt, and GCC has no `trace-pc-guard`. The numbers above are quoted from
  engine/EVAL.md.

## Engines in one paragraph

Three implementations of SPEC v1.2 must agree byte for byte: the C++ compiler and VM (native and
WASM), the Python reference (`refengine/`), and a plain C++ oracle used only in tests
(`engine/tests/oracle.cpp`). The difftest aims claims at each law's own numbers: dates around the
window, amounts around each cap, typed units, tags, insurance, unconfirmed lines, and broken JSON.
On Oct 4 it reached every status and check in the SPEC (eligible 317,455; held 28,050; per-unit
cuts 11,968; total cap cuts 11,378; deadline late 46,526; minimum loss may_be_waived 1,498; and
the rest in engine/EVAL.md), with the same per-status tallies as the Oct 3 run. A harness test
(`refengine/tests/test_difftest.py`) plants bugs and checks the difftest catches them.

## Throughput

`tendvm bench` on a synthetic 1,000,000-item claim, single thread, best of 5
(`make -C engine bench` for the ZZ fixture; the MI line in [engine/BENCH.md](../engine/BENCH.md)).

| Law | Machine | VM, trace on | VM, trace off | JSON in -> JSON out |
|---|---|---|---|---|
| MI | M4 Max, Apple clang 21 (recorded Oct 3) | 14.1M items/s | 16.0M items/s | 1.86M items/s |
| MI | Xeon VM, GCC 13 (reproduced Oct 4) | 4.71M items/s | 6.66M items/s | 0.68M items/s |
| ZZ | M4 Max (recorded Oct 3) | 12.4M items/s | 13.4M items/s | 1.85M items/s |
| ZZ | Xeon VM (reproduced Oct 4) | 3.78M items/s | 5.24M items/s | 0.62M items/s |

The VM ran the same 31,353,844 instructions for MI on both machines. The gap is the machine: a
shared 2.1 GHz VM against a laptop core. On the VM, parsing 207 MB of claim JSON took 0.72 s of
the 1.46 s end to end. A survivor's claim is tens of lines: 0.16 ms through the C ABI and 0.12 ms
in WASM on the M4 Max (engine/BENCH.md).

## Sorting costs (the classifier)

The classifier runs rules first (a merchant registry and keyword rules), then links rides to care
days and pay dips to lost wages, and asks a model only for what is left. On the device the model
is Gemini Nano through Chrome's Prompt API (`web/lib/local/deviceai.ts`), constrained to a fixed
list of labels. A model may never set `forensic_exam` or `lost_wages` (`web/lib/local/classify.ts:262`):
its exam label becomes `medical` and its lost-wage label becomes `unknown`. In Chrome 154 it
labeled a phone bill payment as lost wages (commit `e202549`), which is why.

| Check | Command | Result | When |
|---|---|---|---|
| Server classifier vs the plan's own labels, 4 personas | `cd seed && uv run python seeder.py classify all --no-model` | 190 of 190 for each persona: 87 keyword, 64 registry, 14 ride links, 11 income, 8 transfers, 3 pay dips, 4 from the committed model cache | reproduced Oct 4 |
| TypeScript port vs the Python classifier | `npx vitest run tests/local/classify-parity.test.ts` | label parity passes on all 4 snapshots (the 4 hash checks fail, above) | reproduced Oct 4 |
| Gemini Nano on held-out rows | `measureDeviceClassifier` (`web/lib/local/measure.ts`) in Chrome, with `web/tests/local/fixtures/device-eval.json` and `device-eval-b.json` (32 fictional rows each, no rule matches them) | no result is committed | not reproducible here: needs Chrome with the built-in model |
| Gemini Nano reading a bill photo | in Chrome 154 | the seed bill photo read correctly 3 of 3 times; a bill whose lines do not add up stays "couldn't read reliably" | recorded Oct 3, commit `aaef95c` message only |

The 190 of 190 is not an accuracy figure. The history and its labels come from the same plan
(`seed/history.py`), with merchants the rules were written for. It shows the rules, ride links,
and pay-dip inference do what the plan says, on fictional data. Real statements will have
merchants no rule knows, which is where the model and the survivor's yes or no come in. Nothing a
model picks starts confirmed.

## End to end

| What | Command | Result | When |
|---|---|---|---|
| The whole agent loop: question, Check, demo claim, held exam line, $118.00 paid with a code, sealed share opened with its key | API on SQLite (`cd api && uv run python -m tend_api.loader && uv run uvicorn tend_api.main:app --port 8000`), then `cd agent && uv run python scripts/rehearse.py` | whole chat 4.0 s; the opened share reads MI, 46 costs, $4,008.00 the program can be asked for, $325.00 held (dry-run bank) | reproduced Oct 4 (agent/REHEARSAL.md has the Oct 3 run: 3.9 s) |
| The web flow in a browser: Check, demo bank, sample bill, all questions answered yes, the $118.00 payment with its code, packet, share link opened in a second tab, garden | `next dev` with `TEND_API_URL` pointing at the local API, driven by Playwright in headless Chromium (no Gemini Nano) | $325.00 held under MCL 18.355a(2); $118.00 paid (dry run, read back); "Amount you can ask for: $3,848.00" from 38 costs; the advocate's tab opened the same claim; the privacy line named the payment and the share | reproduced Oct 4 |
| Corpus load into SQLite | `cd api && uv run python -m tend_api.loader` | 19 categories, 51 jurisdictions, 824 sources, 2,578 rules, 51 law images in 0.5 s | reproduced Oct 4 |
| `POST /api/claim` with Rowan's fixture, native engine | `curl -H 'content-type: application/json' --data @web/fixtures/rowan-mi.input.json localhost:8000/api/claim` | 3.4 to 4.8 ms over 3 requests, `X-Tend-Engine: native` | reproduced Oct 4 |
| Demo reset against live Nessie | `cd seed && uv run python reset_demo.py` | 2.6 s | recorded Oct 3 (seed/README.md); needs a Nessie key |
| Deployed API | `vercel curl /api/health` | first request after a deploy 0.44 s; warm 0.08 to 0.15 s; live Nessie relay read 0.64 s | recorded Oct 3 (DEPLOY.md); this container cannot reach `youreowed.tech` |
| Neon | `uv run python ../scripts/neon/measure.py` | quote search 0.30 ms on the server, 36 to 42 ms from a laptop; a two-branch diff 0.48 to 0.55 s | recorded Oct 3 (NEON.md) |
| Web production build | `cd web && npx next build` | compiled, 170 static pages, 24.8 s | reproduced Oct 4 |

## What these numbers do not show

- Agreement between engines shows they read engine/FORMAT.md the same way. It does not show that
  FORMAT.md reads the law correctly. That rests on the verified quotes and the hand-computed golden
  claims, and all three engines were written from one spec by one author.
- The difftest claims are synthetic, aimed at each law's numbers. Real bank histories look
  different.
- The classifier numbers come from fictional data built for the demo. There is no accuracy number
  for Gemini Nano in the repository yet. The demo total depends on it: with the rules alone the web
  flow counts $3,848.00, and the agent run counts $4,008.00, because the server classifier sorts
  the sheets ($96) and the door chain and light ($64) from cached `gemini-3.5-flash-lite` answers
  (`seed/cache/classify_cache.json`).
- Only Michigan's application is pre-filled (`web/lib/packet/specs.ts:85`). For other states the
  packet links the program's blank form, or says Tend did not find one. No test checks that a
  program will accept a packet. The program decides.
- Deadlines counted from discovery (AZ, MA, MD, ME, NJ, PA) are dated from the incident in SPEC
  v1.2, with no flag, so a `late` there may not be late. engine/EVAL.md says the same.

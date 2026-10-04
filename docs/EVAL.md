# Tend: evaluation

Every number Tend claims, the command that produces it, and what it does not show.

Two kinds of numbers appear here, and each row says which:

- **Reproduced Oct 4, 2026** on the branch `wave4/docs` after merging `main` at `f720ae3` (SPEC
  v1.3, tend 1.3.0, tlaw 1.3), in a Linux container: 4 vCPUs of an Intel Xeon at 2.1 GHz (a
  shared VM), GCC 13.3, Node 22.22, Python 3.12.3, uv 0.8.17. The doc changes on this branch touch
  no code, so these are main's numbers.
- **Recorded** by the author on an Apple M4 Max laptop, or on an earlier build, quoted from the
  file named. Each says why it was not rerun.

Engine detail (the difftest breakdown, fuzzing, the review pass) is in
[engine/EVAL.md](../engine/EVAL.md). Throughput detail is in [engine/BENCH.md](../engine/BENCH.md).
Neon detail is in [NEON.md](NEON.md).

## Test suites

| Suite | Command | Result | When |
|---|---|---|---|
| C++ engine | `make -C engine && make -C engine test` | 70 test cases, 27,403 assertions, all pass (1 min 37 s with a clean build) | reproduced |
| VM vs the independent C++ oracle | inside `make test` | 6,000 random evaluations and 51 jurisdictions x 12 scenarios, 0 differences | reproduced |
| Shipped law images | inside `make test` | all 51 in `web/public/engine/laws` byte-identical to a fresh `tendc` build on Linux | reproduced |
| C++ engine under ASan and UBSan | `make -C engine test-san` | 70 of 70 pass | on tend 1.2.0, Oct 4; not rerun on 1.3.0 for time |
| Python reference engine | `cd refengine && uv run pytest` | 586 passed (114 check the IR that normalize.py makes) | reproduced |
| Difftest, reference vs C++ | `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` | 121,000 claims, 0 mismatches; 119,600 well-formed claims byte-identical; 3,000 random or broken laws, 0 disagreements (53.8 s) | reproduced |
| WASM vs native | `make -C engine wasm-parity` | 106,000 of 106,000 claims byte-identical across 53 laws, all 51 shipped images checked, tend 1.3.0 (29.0 s in Node) | reproduced |
| Fuzzing under ASan and UBSan | `make -C engine fuzz FUZZ_SECONDS=420` | 1,276,000 then 2,517,704 executions on 1.2; 580,048 in 180 s on 1.3; no crashes | recorded ([engine/EVAL.md](../engine/EVAL.md)); this container's clang has no sanitizer runtime |
| API | `cd api && uv run pytest` | 446 tests: 424 passed, 22 skipped (the Neon tests, which need `TEND_NEON_TEST=1` and a database URL) | reproduced |
| API on Neon | `TEND_NEON_TEST=1 uv run pytest -k "neon or live"` | 32 tests, about 70 s | recorded Oct 3 ([NEON.md](NEON.md)); needs a Neon URL |
| Neon role limits | `uv run python ../scripts/neon/roles.py` | 28 of 28 checks as expected | recorded Oct 3 ([NEON.md](NEON.md)); needs Neon |
| Seed (fictional bank) | `cd seed && uv run pytest` | 166 tests: 161 passed, 5 skipped (live Nessie, needs `TEND_LIVE=1` and a key) | reproduced |
| Agents | `cd agent && uv run pytest` | 265 passed | reproduced |
| Web types | `cd web && npm ci && npx tsc --noEmit` | no errors | reproduced |
| Web unit and screen tests | `cd web && npx vitest run` | 42 files, 1,234 passed | reproduced |
| Web end to end (Playwright, Chromium) | `web/e2e/run.sh` | 3 passed: the demo path, the offline survivor path, and the check that no request carried transaction text, a bill line, or the share key (34 s with `E2E_SKIP_BUILD=1`) | reproduced; see the note below |
| Rules: every quote verbatim | `python3 rules/tools/verify.py all` | 51 of 51 jurisdictions PASS (2,578 rules, 824 sources); no file changed | reproduced |
| Rules: IR is reproducible | `uv run --python 3.12 rules/tools/normalize.py` | all 51 IR files regenerated with no diff | reproduced |

**The e2e note.** `run.sh` installs Playwright 1.47 by default, whose Chromium build this container
does not have, so it ran with `E2E_PLAYWRIGHT_VERSION=1.56.0` against the preinstalled Chromium 141.
The first full run (with the build) failed one test: the first page load took longer than its
5-second wait while the other suites were running on the same 4 CPUs. The rerun with the machine
quiet passed 3 of 3.

## Engines in one paragraph

Three implementations of SPEC v1.3 must agree byte for byte: the C++ compiler and VM (native and
WASM), the Python reference (`refengine/`), and a plain C++ oracle used only in tests
(`engine/tests/oracle.cpp`). The difftest aims claims at each law's own numbers: dates around the
window, amounts around each cap, typed units, tags, insurance, unconfirmed lines, deadlines from
the report and from discovery, and broken JSON. On the merged branch it reached every status, check,
and flag in the SPEC (eligible 317,609; held 28,214; per-unit cuts 11,786; total cap cuts 11,473;
`deadline_from_discovery` on 29,916 claims and `deadline_from_report` on 16,161), with the same
tallies engine/EVAL.md records. A harness test (`refengine/tests/test_difftest.py`) plants bugs and
checks the difftest catches them.

## Throughput

`tendvm bench` on a synthetic 1,000,000-item claim, single thread, best of 5
(`make -C engine bench` for the ZZ fixture; the MI line in [engine/BENCH.md](../engine/BENCH.md)).
These were measured on tend 1.2.0 and not rerun on 1.3.0; v1.3 adds one flag check to the deadline
step and does not touch the per-line program.

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
| Server classifier vs the plan's own labels, 4 personas | `cd seed && uv run python seeder.py classify all --no-model` | 190 of 190 for each persona: 87 keyword, 64 registry, 14 ride links, 11 income, 8 transfers, 3 pay dips, 4 from the committed model cache | reproduced on the merged branch |
| TypeScript port vs the Python classifier, including the lost-pay workday estimate | `npx vitest run tests/local/classify-parity.test.ts` | passes on all 4 snapshots | reproduced on the merged branch |
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
| The web flow in a browser, every question answered yes: Check, demo bank, sample bill, the $118.00 payment with its code, packet, share link opened in a second tab, garden | `next dev` with `TEND_API_URL` pointing at a local API, driven by Playwright in headless Chromium (no Gemini Nano) | $325.00 held under MCL 18.355a(2); $118.00 paid (dry run, read back); "Amount you can ask for: $3,848.00" from 38 costs; the advocate's tab opened the same claim; the privacy line named the payment, then the share | reproduced |
| The e2e demo path, online, step by step | `web/e2e/run.sh` (prints the timings) | Check 0.46 s; sample statement read on the device 0.48 s; bill PDF 0.59 s; $118.00 code 0.56 s and confirm 0.18 s; packet built on the device 1.0 s; sealed link 0.10 s; advocate opens it 0.34 s | reproduced |
| The e2e offline path | the same | first visit saved for offline 2.2 s; reload with no network 0.34 s; statement 0.48 s and bill 0.21 s read offline; packet 0.17 s; payment and share say they are offline and send nothing; back online, the $118.00 payment goes through | reproduced |
| The whole agent loop: question, Check, demo claim, held exam line, $118.00 paid with a code, sealed share opened with its key | API running locally, then `cd agent && uv run python scripts/rehearse.py` | whole chat 4.0 s; MI, 46 costs, $4,008.00, $325.00 held (dry-run bank) | on tend 1.2.0, Oct 4 (agent/REHEARSAL.md has 3.9 s); not rerun for time |
| Demo reset against live Nessie | `cd seed && uv run python reset_demo.py` | 2.6 s | recorded Oct 3 (seed/README.md); needs a Nessie key |
| Deployed API | `vercel curl /api/health` | first request after a deploy 0.44 s; warm 0.08 to 0.15 s; live Nessie relay read 0.64 s | recorded Oct 3 (DEPLOY.md); this container cannot reach `youreowed.tech` |
| Neon | `uv run python ../scripts/neon/measure.py` | quote search 0.30 ms on the server, 36 to 42 ms from a laptop; a two-branch diff 0.48 to 0.55 s | recorded Oct 3 (NEON.md) |

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
  (`seed/cache/classify_cache.json`). In the browser, the same two lines can be sent to cloud AI
  only after a yes on its consent screen.
- Only Michigan's application is pre-filled (`web/lib/packet/specs.ts`). For other states the
  packet links the program's blank form, or says Tend did not find one. No test checks that a
  program will accept a packet. The program decides.
- The e2e tests run on a dry-run bank and an in-memory database. They do not exercise Neon or
  Nessie; the live suites above do, and they need keys.

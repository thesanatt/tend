# Tend: evaluation

Every number Tend claims, the command that produces it, and what it does not show.

Five kinds of numbers appear here, and each row says which:

- **Rerun Nov 16, 2026** on the branch `deep-pass-2026-11-16`, from a clean clone at `0f14cf8`, on
  the same laptop: Apple clang 21.0, Node 24.14.1, Python 3.12.13, uv 0.11.12. The engines, the law
  data, and the shipped law images are the same files as on Oct 20; the web app, the API,
  `verify.py`, and the tests changed after it. The Python suites ran again at `31cf9ea`, after
  lint fixes, with the same counts. The same day the C++ engine was built and tested with GCC 13.3
  in an Ubuntu 24.04 container on that laptop (arm64, 14 CPUs), its first Linux run since Oct 4.
  Only the rows that name Linux ran there.
- **Rerun Oct 20, 2026** on `press-ready-int` at `9dce7e1`, on the same laptop as Oct 19, after
  merging the rule checks (`press-ready-claims`). That merge changed the law data (rules, IR, and
  all 51 shipped law images) and `verify.py`, not the engines: 2,578 rules became 2,728. Every
  suite in the tables, and the engine benchmark, ran again later that day at `b2f8698`, after the
  last review's fixes (web only, plus `verify.py` escapes and the dataset README). Only the web
  unit and screen test count changed.
- **Rerun Oct 19, 2026** on the integration branch `press-ready-int` at `12508ea`, on an Apple M4
  Max laptop (14 cores): macOS 26.5, Apple clang 21, Node 24.14, Python 3.12.13, uv 0.11.12. The
  law data, the engines, and the shipped law images are the same files as on Oct 4; the web app,
  the API, and their tests changed after it.
- **Reproduced Oct 4, 2026** on the branch `wave4/docs` after merging `main` at `f720ae3` (SPEC
  v1.3, tend 1.3.0, tlaw 1.3), in a Linux container: 4 vCPUs of an Intel Xeon at 2.1 GHz (a
  shared VM), GCC 13.3, Node 22.22, Python 3.12.3, uv 0.8.17. The doc changes on that branch
  touched no code, so these were main's numbers.
- **Recorded** on an Apple M4 Max laptop, or on an earlier build, quoted from the file named.
  Each says why it was not rerun.

Engine detail (the difftest breakdown, fuzzing, the review pass) is in
[engine/EVAL.md](../engine/EVAL.md). Throughput detail is in [engine/BENCH.md](../engine/BENCH.md).
Neon detail is in [NEON.md](NEON.md).

## Test suites

| Suite | Command | Result | When |
|---|---|---|---|
| C++ engine | `make -C engine && make -C engine test` | 70 test cases, 27,403 assertions, all pass (1 min 37 s with a clean build on Oct 4) | rerun Nov 16 on macOS and, with GCC 13.3, on Linux; the same as Oct 4 |
| VM vs the C++ oracle (shares no code with the VM) <!-- TODO(Sanat): this cell used to say "independent"; who wrote it is yours to state. --> | inside `make test` | 6,000 random evaluations and 51 jurisdictions x 12 scenarios, 0 differences | rerun Nov 16 on macOS and Linux, the same as Oct 4 |
| Shipped law images | inside `make test` | all 51 in `web/public/engine/laws` byte-identical to a fresh `tendc` build: on macOS on Oct 20 and on macOS and Linux (GCC 13.3, arm64) on Nov 16, the images the rule checks rebuilt; on Linux on Oct 4 and on macOS on Oct 19, the images before them | rerun Nov 16 |
| C++ engine under ASan and UBSan | `make -C engine test-san` | 70 of 70 pass, 27,403 assertions, no sanitizer report. On macOS, 54.6 s with the build. On Linux with GCC 13.3, 14 s for the tests, with the leak check on (macOS has none) and ASan's stack-use-after-return check off; see the note below | rerun Nov 16 on tend 1.3.0, macOS and Linux |
| Python reference engine | `cd refengine && uv run pytest` | 586 passed (114 check the IR that normalize.py makes) | rerun Nov 16, the same as Oct 4 |
| Difftest, reference vs C++ | `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` | 121,000 claims, 0 mismatches; 119,599 well-formed claims byte-identical (119,600 before the rule checks: the generator aims claims at each law's own numbers, so new rules change the claims it makes); 3,000 random or broken laws, 0 disagreements (14.9 s on Nov 16; 12.7 s on Oct 20; 53.8 s on Oct 4) | rerun Nov 16, the same as Oct 20 |
| WASM vs native | `make -C engine wasm-parity` | 106,000 of 106,000 claims byte-identical across 53 laws, all 51 shipped images checked, tend 1.3.0 (15.0 s in Node on Nov 16; 14.8 s on Oct 20; 29.0 s on Oct 4) | rerun Nov 16, the same as Oct 4 |
| Fuzzing under ASan and UBSan | `make -C engine fuzz FUZZ_SECONDS=420` | 1,276,000 then 2,517,704 executions on 1.2; 580,048 in 180 s on 1.3; no crashes | recorded ([engine/EVAL.md](../engine/EVAL.md)); the Oct 4 container's clang had no sanitizer runtime, and it was not rerun on Oct 19 |
| API | `cd api && uv run pytest` | 444 tests: 421 passed, 23 skipped (the Neon tests, which need `TEND_NEON_TEST=1` and a database URL). Oct 20 had 436, and Oct 4 had 446: the retired agents' endpoints took their tests with them, and the demo account's reset added some | rerun Nov 16 |
| API on Neon | `TEND_NEON_TEST=1 uv run pytest -k "neon or live"` | 32 tests, about 70 s | recorded Oct 3 ([NEON.md](NEON.md)); needs a Neon URL |
| Neon role limits | `uv run python ../scripts/neon/roles.py` | 28 of 28 checks as expected | recorded Oct 3 ([NEON.md](NEON.md)); needs Neon |
| Seed (fictional bank) | `cd seed && uv run pytest` | 167 tests: 163 passed, 4 skipped (live Nessie, needs `TEND_LIVE=1` and a key) | rerun Nov 16, the same as Oct 20 |
| Web types | `cd web && npm ci && npx tsc --noEmit` | no errors | rerun Nov 16 |
| Web unit and screen tests | `cd web && npx vitest run` | 63 files, 2,431 passed on Nov 16 with the checks for the held-out classifier rows (2,356 in 58 files earlier that day; 2,259 on Oct 26 with /compare; 1,937 earlier that day with the large-text check; 1,936 on Oct 25 with the /data and /law/changes link cards; 1,932 at `ef8e7ce`; 1,929 at `b2f8698`; 1,840 in 56 files at `9dce7e1`, before the review's fixes and their tests; 1,568 on Oct 19, before the rule checks; 42 files and 1,234 tests on Oct 4) | rerun Nov 16 |
| Web lint | `cd web && npm run lint` | no errors and no warnings. On Oct 20 it gave 19 warnings: 17 in the generated `public/engine/tend.js`, which lint now skips, and 2 unused parameters in a test, now gone | rerun Nov 16 |
| Web production build | `cd web && npm run build` | builds, with 186 pages made ahead of time (185 with /compare and its card; one more is `/dev/classifier-eval`, which the built site answers with its not-found page) | rerun Nov 16 |
| Web end to end (Playwright, Chromium) | `web/e2e/run.sh` | 33 passed (182 s with the build) on Nov 16, the same 33 as on Oct 26, when the phone checks first covered /press, /data, /law/changes and /compare; 31 on Oct 20. They are 13 tests, some run at several widths, text sizes, or languages: the demo path, the offline survivor path, the check that no request carried transaction text, a bill line, or the share key, the guided tour and the Spanish UI without its notes, and phone layouts, including text at 200 percent on a 360 px phone in both languages | rerun Nov 16; see the note below |
| Rules: every quote verbatim | `python3 rules/tools/verify.py all` | 51 of 51 jurisdictions PASS (2,728 rules, 824 sources; 2,578 before the rule checks); no file changed | rerun Nov 16, the same as Oct 20 |
| Rules: IR is reproducible | `uv run --python 3.12 rules/tools/normalize.py` | all 51 IR files regenerated with no diff | rerun Nov 16, the same as Oct 4 |
| Rules: tests of the checker and of the dataset export | `uv run --no-project --with pytest pytest rules/tools/test_verify.py rules/tools/test_export_dataset.py` | 39 passed, 2 skipped. The 2 extract every saved source again with BeautifulSoup and pdftotext and are opt-in; with `--with beautifulsoup4` and pdftotext installed, 41 passed. One test checks the numbers in the text params the state page prints against each rule's quote, which `verify.py` does not read | first run Nov 16 (`test_verify.py` and that test are new) |
| Published dataset matches the corpus | `python3 rules/tools/export_dataset.py --check` | dataset v1.0 is current, 6 files in 2 folders | rerun Nov 16 |
| Web formatting | `cd web && npx prettier --check .` | every file it reads passes. `web/.prettierignore` lists what it skips: the law data, the dataset, the built engine, the service worker, and fixtures | first run Nov 16 |
| Python lint | `uv run --project api ruff check .` from the repo root | no findings | first run Nov 16 |

**The e2e note.** On Oct 19 and again on Oct 20 `run.sh` ran with its default Playwright 1.47 and that version's
Chromium, with no other suite running, and passed 31 of 31 on the first run each time. On Oct 4 the Linux
container did not have that Chromium build, so it ran with `E2E_PLAYWRIGHT_VERSION=1.56.0` against
the preinstalled Chromium 141. Its first full run (with the build) failed one test: the first page
load took longer than its 5-second wait while the other suites were running on the same 4 CPUs.
The rerun with the machine quiet passed 3 of 3, all the e2e tests there were then.

**The sanitizer note.** On Linux, ASan also checks for a stack frame used after its function
returned; on macOS that check is off unless asked for. With GCC 13.3's Linux default the test
binary was still running after 24 minutes on Nov 16, with no report up to then, and was
stopped. With `ASAN_OPTIONS=detect_stack_use_after_return=0` the same binary passed in 14 s. So
the Linux result above covers what the macOS one does plus leaks, and nothing here has run the
stack-use-after-return check to the end.

**GCC's warnings.** GCC 13.3 prints 8 warnings that Apple clang does not: 5 from `-Wextra` where
a conditional picks between a number and an enum constant (`src/eval.cpp`, `src/format.cpp`,
`src/vm.cpp`, `tools/tendvm.cpp`), and 3 from `-Wpedantic` on `__int128` in the test oracle. The
engine source is as it was on Oct 20.

**CI.** `.github/workflows/ci.yml`, added Nov 16, runs the rows above that need no keys on every
pull request and on main: the rules rows, the engine rows through WASM vs native, the sanitizer
build with the setting from the note above, the API and seed tests, and the web rows through the
build. It leaves out the browser tests, the Neon and Nessie tests, fuzzing, and the Emscripten
build. Each command in it passed on Nov 16 from a clean clone on macOS; on Linux only the engine
commands were tried that day.

**The source check.** `rules/tools/check_sources.py`, added Nov 16, fetches each saved source's URL
again into a temporary folder, reads the page's text the way `fetch_source.py` does, and looks for
each rule's quote with the test `verify.py` uses. It reports the sources it could not fetch, the
sources whose bytes changed while every quote is still there, and the rules whose quote is gone.
Only the last makes it fail, and it changes no file in the repository. It cannot tell whether a page
that still holds the quote still means the same thing. It makes plain requests and does not open a
browser, so a site that refuses those is "not fetched". And 120 of the 824 sources are Justia or
Cornell copies, so a quote found there matches the copy, not the state's own text. Its 19 tests use
fixture pages and no network. One sample has run: `MI OH CA` on the evening of Nov 16 (01:25 UTC on
Nov 17), 58 sources cited by 175 rules, in 45 seconds. No quote was missing. 41 sources had new
bytes with all 107 quotes still there, and 29 of the 41 read the same as the saved text word for
word. 10 sources had the same bytes (54 rules, not read again). 7 answered HTTP 403, 6 on Justia and
1 on ohiosos.gov, which left 14 rules unchecked; a run a few minutes earlier had 5 refused, 4 of them
on Justia. The other 48 jurisdictions have not been run, and the weekly workflow
(`.github/workflows/source-check.yml`, report only) has not run on GitHub.

## Engines in one paragraph

Three implementations of SPEC v1.3 must agree byte for byte: the C++ compiler and VM (native and
WASM), the Python reference (`refengine/`), and a plain C++ oracle used only in tests
(`engine/tests/oracle.cpp`). The difftest aims claims at each law's own numbers: dates around the
window, amounts around each cap, typed units, tags, insurance, unconfirmed lines, deadlines from
the report and from discovery, and broken JSON. On the merged branch it reached every status, check,
and flag in the SPEC (eligible 319,019; held 27,164; per-unit cuts 11,786; total cap cuts 11,473;
`deadline_from_discovery` on 29,916 claims and `deadline_from_report` on 16,161, on Oct 20).
[engine/EVAL.md](../engine/EVAL.md) has the full breakdown. A harness test
(`refengine/tests/test_difftest.py`) plants bugs and checks the difftest catches them.

## Throughput

`tendvm bench` on a synthetic 1,000,000-item claim, single thread, best of 5
(`make -C engine bench` for the ZZ fixture; the MI line in [engine/BENCH.md](../engine/BENCH.md)).
The table gives the tend 1.2.0 runs. A rerun on tend 1.3.0 on Oct 20, 2026, on the same laptop at
`b2f8698`, gave MI 16.7M items/s with trace on, 19.3M with trace off, and 2.26M JSON in to JSON out,
and ZZ 13.9M, 15.2M, and 2.06M. v1.3 adds one flag check to the deadline step and does not touch the
per-line program.

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
list of labels. A model may never set `forensic_exam` or `lost_wages` (`web/lib/local/classify.ts:263`):
its exam label becomes `medical` and its lost-wage label becomes `unknown`. In Chrome 154 it
labeled a phone bill payment as lost wages (commit `e202549`), which is why.

| Check | Command | Result | When |
|---|---|---|---|
| Server classifier vs the plan's own labels, 4 personas | `cd seed && uv run python seeder.py classify all --no-model` | 190 of 190 for each persona. The method counts cover the 191 records it reads (the 190 plus the Riverbend bill): 87 keyword, 64 registry, 14 ride links, 11 income, 8 transfers, 3 pay dips, 4 from the committed model cache | rerun Oct 19, the same as Oct 4 |
| TypeScript port vs the Python classifier, including the lost-pay workday estimate | `npx vitest run tests/local/classify-parity.test.ts` | passes on all 4 snapshots | rerun Oct 20, the same as Oct 4 |
| Gemini Nano on held-out rows | `measureDeviceClassifier` (`web/lib/local/measure.ts`) in Chrome, with `web/tests/local/fixtures/device-eval.json` and `device-eval-b.json` (32 fictional rows each, no rule matches them) | no result is committed | not reproduced: needs Chrome with the built-in model |
| Rules only, no model, on 460 held-out rows | `cd web && npx tsx scripts/classifier-eval.ts` | 257 of 460 rows right: 55.9% (95% interval 51.3% to 60.3%). The rows are fictional and their labels are proposed, not yet reviewed by a person. See "The held-out rows" below | first run Nov 16, 2026, at `a6bf3f0` |
| Gemini Nano on the same 460 rows | the page `/dev/classifier-eval` under `npm run dev`, in Chrome, then `npx tsx scripts/classifier-eval.ts --model FILE` | no result is committed | not run: needs Chrome with the built-in model |
| Gemini Nano reading a bill photo | in Chrome 154 | the seed bill photo read correctly 3 of 3 times; a bill whose lines do not add up stays "couldn't read reliably" | recorded Oct 3, commit `aaef95c` message only |

The 190 of 190 is not an accuracy figure. The history and its labels come from the same plan
(`seed/history.py`), with merchants the rules were written for. It shows the rules, ride links,
and pay-dip inference do what the plan says, on fictional data. Real statements will have
merchants no rule knows, which is where the model and the survivor's yes or no come in. Nothing a
model picks starts confirmed.

### The held-out rows

`web/tests/local/fixtures/classifier-heldout.json` holds 460 fictional bank rows for measuring the
classifier on merchants the rules were not written for. It was written on Nov 16, 2026 and
committed (`3620818`) before the classifier first ran on it. No row, label or rule was changed
after a result was seen. Each row was written from how banks print a line: a merchant name cut
short, a store number, a city and state, a processor prefix such as SQ or TST, an ACH or transfer
line. Its `source` field says which. Half the rows should get a cost label, with every label on the
list (`EXPENSES` in `web/lib/types.ts`) covered. The other half should get none, and those include
the near misses: a phone bill payment, a person-to-person cash line, a pharmacy chain selling
groceries, a rideshare on a day with no care visit, a gym, a pet clinic.

Read the numbers with these limits in mind:

- The first column is the rules alone: the merchant registry, the keyword rules, ride links and
  pay dips, with no model. That is what the app does in a browser with no built-in model and no
  yes to cloud AI.
- The labels are proposed, and no person has checked them. One AI assistant wrote the rows and the
  labels, after it had read the rules. So the rows are held out from the rules in time, not written
  blind, and until a person reviews the labels every figure is agreement with proposed labels, not
  accuracy.
- The rows are fictional, and the mix is chosen by label: half cost rows, half not. A real
  statement is mostly ordinary spending. The "all rows" figure therefore does not carry over to a
  real statement. The per-label figures and the two error lines are the ones to compare from one
  version of the rules or the model to the next.
- A row counts as right when what the app offers matches the label: the same cost label, or none.
  An offered cost label still waits for a yes or no unless it starts checked, so a cost label where
  none belongs is split by what happens next. It is the worse mistake, because it can raise a claim.
- The merchant registry holds only the four demo merchants, so it matches none of these rows. Each
  label has 5 to 26 rows, so the per-label ranges are wide.
- The ceiling column is arithmetic on the labels: every row a model would be asked about, answered
  with its own label, then scored through the same code. It is the most a model could add, not what
  any model does.

<!-- classifier-heldout:start -->
<!-- Written by `cd web && npx tsx scripts/classifier-eval.ts --write` from the result files in
     web/tests/local/fixtures. Change a number by running that, not by editing between these marks. -->

The rows: 460 fictional rows from `classifier-heldout.json` (set hash `3c2492917dfdaac8`). 230 should get a cost label and 230 should get none. The labels are proposed by the rows' writer, not reviewed by a person. The rows' writer flagged 53 of them as unsure; 30 of the 203 rows the rules got wrong are flagged.

|  | Rules only, no model | A model that never errs. This is a ceiling worked out from the labels, not a model's result |
|---|---|---|
| Measured | Nov 16, 2026 | Nov 16, 2026 |
| All rows right | 55.9% (257 of 460, 95% interval 51.3% to 60.3%) | 91.7% (422 of 460, 95% interval 88.9% to 93.9%) |
| Rows that should get a cost label, right | 14.3% (33 of 230, 95% interval 10.4% to 19.5%) | 86.1% (198 of 230, 95% interval 81.0% to 90.0%) |
| Rows that should get none, right | 97.4% (224 of 230, 95% interval 94.4% to 98.8%) | 97.4% (224 of 230, 95% interval 94.4% to 98.8%) |
| Rows a rule decided, right | 82.0% (82 of 100, 95% interval 73.3% to 88.3%) | 82.0% (82 of 100, 95% interval 73.3% to 88.3%) |
| Would raise a claim: a cost label where none belongs | 2.6% (6 of 230, 95% interval 1.2% to 5.6%) | 2.6% (6 of 230, 95% interval 1.2% to 5.6%) |
| ... on or after the incident date, and starts checked | 4 (h237, h311, h337, h446) | 4 (h237, h311, h337, h446) |
| ... on or after it, and waits for an answer | 1 (h319) | 1 (h319) |
| ... dated before it, which the law engine leaves out | 1 (h072) | 1 (h072) |
| Missed: no cost label where one belongs | 84.3% (194 of 230, 95% interval 79.1% to 88.5%) | 11.7% (27 of 230, 95% interval 8.2% to 16.5%) |
| ... no rule matched the row | 185 | 18 |
| ... a rule called it ordinary spending, or a ride had no care that day | 9 (h112, h159, h195, h255, h277, h289, h293, h344, h405) | 9 (h112, h159, h195, h255, h277, h289, h293, h344, h405) |
| One cost label where another belongs | 3 (h243 childcare as tuition, h367 medical as counseling, h395 other as medical) | 5 (h106 forensic_exam as medical, h225 forensic_exam as medical, h243 childcare as tuition, h367 medical as counseling, h395 other as medical) |
| Rows no rule matched, which are all a model is asked about | 360 (326 distinct) | 360 (326 distinct) |
| ... of those, should get a cost label | 185 | 185 |
| ... of those, should get none | 175 | 175 |
| Rows still unsorted after the run | 360 | 0 |

Even with a model that never errs, these labels stay short: `transportation` 4 of 24, `forensic_exam` 3 of 5, `lost_wages` 3 of 5, `other` 6 of 8, `clothing_bedding` 9 of 10, `dental` 11 of 12, `medical` 24 of 26, `childcare` 13 of 14, `prescription` 13 of 14.

Gemini Nano on these rows: no result is committed.

Per label, rules only. Precision is the share of rows given the label that carry it. Recall is the share of rows carrying the label that were given it. Each range is the 95% interval.

| Label | Rows | Given | Right | Precision | Recall |
|---|---|---|---|---|---|
| `medical` | 26 | 5 | 1 | 20.0% (3.6% to 62.4%) | 3.8% (0.7% to 18.9%) |
| `forensic_exam` | 5 | 3 | 3 | 100.0% (43.9% to 100.0%) | 60.0% (23.1% to 88.2%) |
| `counseling` | 24 | 4 | 3 | 75.0% (30.1% to 95.4%) | 12.5% (4.3% to 31.0%) |
| `lost_wages` | 5 | 3 | 3 | 100.0% (43.9% to 100.0%) | 60.0% (23.1% to 88.2%) |
| `transportation` | 24 | 1 | 1 | 100.0% (20.7% to 100.0%) | 4.2% (0.7% to 20.2%) |
| `relocation` | 16 | 1 | 1 | 100.0% (20.7% to 100.0%) | 6.3% (1.1% to 28.3%) |
| `temporary_housing` | 15 | 5 | 4 | 80.0% (37.6% to 96.4%) | 26.7% (10.9% to 52.0%) |
| `security` | 14 | 4 | 4 | 100.0% (51.0% to 100.0%) | 28.6% (11.7% to 54.6%) |
| `crime_scene_cleanup` | 5 | 0 | 0 | never given | 0.0% (0.0% to 43.4%) |
| `childcare` | 14 | 2 | 2 | 100.0% (34.2% to 100.0%) | 14.3% (4.0% to 39.9%) |
| `property_replacement` | 8 | 0 | 0 | never given | 0.0% (0.0% to 32.4%) |
| `clothing_bedding` | 10 | 0 | 0 | never given | 0.0% (0.0% to 27.8%) |
| `prescription` | 14 | 2 | 2 | 100.0% (34.2% to 100.0%) | 14.3% (4.0% to 39.9%) |
| `dental` | 12 | 7 | 5 | 71.4% (35.9% to 91.8%) | 41.7% (19.3% to 68.0%) |
| `funeral` | 8 | 2 | 2 | 100.0% (34.2% to 100.0%) | 25.0% (7.1% to 59.1%) |
| `legal` | 12 | 0 | 0 | never given | 0.0% (0.0% to 24.2%) |
| `tuition` | 10 | 3 | 2 | 66.7% (20.8% to 93.9%) | 20.0% (5.7% to 51.0%) |
| `other` | 8 | 0 | 0 | never given | 0.0% (0.0% to 32.4%) |
| no cost label | 230 | 418 | 224 | 53.6% (48.8% to 58.3%) | 97.4% (94.4% to 98.8%) |

By how the row was written, rules only:

| How the row was written | Right |
|---|---|
| ACH debit line: a company name, an entry description and an ID | 62.5% (15 of 24, 95% interval 42.7% to 78.8%) |
| a line the bank writes itself: card payment, transfer, ATM or fee | 100.0% (12 of 12, 95% interval 75.8% to 100.0%) |
| aggregator style: a clean merchant name, a category and a short description, as the demo bank path gives | 42.1% (16 of 38, 95% interval 27.9% to 57.8%) |
| bank export row: the descriptor in the description and the bank's own category in the category column | 52.6% (10 of 19, 95% interval 31.7% to 72.7%) |
| card line inside the bank's own wrapper text (purchase authorized on, POS withdrawal, checkcard) | 14.3% (1 of 7, 95% interval 2.6% to 51.3%) |
| card line with a payment processor prefix (SQ \*, TST\*, PAYPAL \* and others) before a cut merchant name | 55.3% (42 of 76, 95% interval 44.1% to 65.9%) |
| card line with a store number, then city and state | 71.3% (57 of 80, 95% interval 60.5% to 80.0%) |
| card line: the merchant name as a card network cuts it, then city and state | 38.7% (55 of 142, 95% interval 31.1% to 46.9%) |
| money in: pay, a refund, a transfer in or interest | 94.1% (32 of 34, 95% interval 80.9% to 98.4%) |
| online bill pay line | 22.2% (2 of 9, 95% interval 6.3% to 54.7%) |
| person-to-person payment line (Zelle, Venmo, Cash App, Apple Cash), some with a memo | 78.9% (15 of 19, 95% interval 56.7% to 91.5%) |
<!-- classifier-heldout:end -->

Where the rules are weakest, in the run above: they sort 33 of the 230 cost rows, and no label has
more than 5 rows right. No row labeled `crime_scene_cleanup`, `property_replacement`,
`clothing_bedding`, `legal` or `other` is found, and `medical`, `counseling`, `transportation` and
`relocation` are each found once to three times in 16 to 26 rows. The six cost labels given where
none belongs are three pet clinics marked `medical`, two dental insurance premiums marked `dental`
(one dated before the incident date), and a hotel stay that was refunded. Nine cost rows are missed
by a rule and not for want of one: seven rides on a day when no rule sorted the care charge, and
two short paychecks sent by Zelle, which the rules read as ordinary money in.

What a model can and cannot add: no rule matches 360 of the 460 rows (326 distinct, so 55 prompts
of six), and a model is asked about those and no others. Of them, 185 should get a cost label and
175 should get none, where a model can only add mistakes. Even a model that never errs leaves 20 of
the 24 rides unoffered, because a ride is offered only on a day with a care charge that a rule or a
bill sorted, and a model's answer does not count for that. It also cannot give `forensic_exam` to
the two exam rows no rule matched.

To review the labels, which only a person can do: copy
`web/tests/local/fixtures/classifier-heldout.review.csv` to `classifier-heldout.reviewed.csv` in
the same folder and fill the `reviewed` column. Write `ok` to keep the proposed label, a label from
the list to replace it, `none` for no cost label, or `skip` to leave the row out. An empty cell
means not looked at yet. The rows flagged unsure are the first to check. Then run
`cd web && npx tsx scripts/classifier-eval.ts --write`, which reads that file, rewrites the result
file and the block of numbers above, and says how many labels were reviewed and corrected. Bring
the text around the block in line, and commit the reviewed file with the result.

To record Gemini Nano's answers (Chrome on a desktop with the built-in model):

1. `cd web && npm run dev`, then open `http://localhost:3000/dev/classifier-eval` in that Chrome.
   The page says whether the model is ready and offers the download if it is not. If it says the
   model is not available, check `chrome://on-device-internals`.
2. Choose `web/tests/local/fixtures/classifier-heldout.json`, press Run, and wait for the table.
   With the app's 5 second limit a slow prompt leaves its rows unanswered, and they score as
   unsorted; the table says how many prompts failed.
3. Press Save, and move the file to
   `web/tests/local/fixtures/classifier-heldout.nano.answers.json`.
4. `cd web && npx tsx scripts/classifier-eval.ts --model tests/local/fixtures/classifier-heldout.nano.answers.json --write`
   scores the answers without calling a model, saves `classifier-heldout.nano.result.json`, and adds
   the run to the block above. Fill the Gemini Nano row in the table, and commit both files.

The page exists only under `npm run dev`; the built site answers that address with its not-found
page. Nothing leaves the browser: the rows go to the built-in model and the answers to a file.

## End to end

| What | Command | Result | When |
|---|---|---|---|
| The web flow in a browser, every question answered yes: Check, demo bank, sample bill, the $118.00 payment with its code, packet, share link opened in a second tab, garden | `next dev` with `TEND_API_URL` pointing at a local API, driven by Playwright in headless Chromium (no Gemini Nano) | $325.00 held under MCL 18.355a(2); $118.00 paid (dry run, read back); "Amount you can ask for: $3,848.00" from 38 costs; the advocate's tab opened the same claim; the privacy line named the payment, then the share | reproduced Oct 4 |
| The e2e demo path, online, step by step | `web/e2e/run.sh` (prints the timings) | Check 0.26 s; sample statement read on the device 0.57 s (0.27 s on Oct 20; see the note on step times); bill PDF 0.09 s; $118.00 code 0.52 s and confirm 0.15 s; packet built on the device 0.90 s; sealed link 0.13 s; advocate opens it 0.24 s. On Oct 4's Xeon VM: Check 0.46 s, statement 0.48 s, bill 0.59 s, code 0.56 s, confirm 0.18 s, packet 1.0 s, link 0.10 s, advocate 0.34 s | rerun Nov 16 |
| The e2e offline path | the same | first visit saved for offline 0.48 s; reload with no network 0.16 s; statement 0.28 s and bill 0.09 s read offline; packet 0.04 s; payment and share say they are offline and send nothing; saved progress opens offline after a reload; back online, the $118.00 payment goes through. On Oct 4: first visit 2.2 s, reload 0.34 s, statement 0.48 s, bill 0.21 s, packet 0.17 s | rerun Nov 16 |
| Demo reset against live Nessie | `cd seed && uv run python reset_demo.py` | 2.6 s | recorded Oct 3 (seed/README.md); needs a Nessie key |
| Deployed API | `vercel curl /api/health` | first request after a deploy 0.44 s; warm 0.08 to 0.15 s; live Nessie relay read 0.64 s | recorded Oct 3 (DEPLOY.md); the Oct 4 container could not reach `youreowed.tech`, and the Oct 19 run did not touch the deployment |
| Neon | `uv run python ../scripts/neon/measure.py` | quote search 0.30 ms on the server, 36 to 42 ms from a laptop; a two-branch diff 0.48 to 0.55 s | recorded Oct 3 (NEON.md) |

**Step times.** `run.sh` times a step from the click to the moment Playwright sees the result, and
Playwright looks again after 100 ms, then 250 ms, then 500 ms. So a step's time lands on a few
values and not between them. In two full runs on Nov 16 the statement step printed 278 to 281 ms
in the offline and tour runs and 567 to 591 ms in the three others; on Oct 20 the online run printed
0.27 s. Whether the read itself got slower between those dates was not measured.

## What these numbers do not show

- Agreement between engines shows they read engine/FORMAT.md the same way. It does not show that
  FORMAT.md reads the law correctly. That rests on the verified quotes and the hand-computed golden
  claims, and all three engines were written from one spec. <!-- TODO(Sanat): this line used to say "by one author";
  who wrote them is yours to state. -->
- The difftest claims are synthetic, aimed at each law's numbers. Real bank histories look
  different.
- The classifier numbers come from fictional data: the demo history, and 460 held-out rows whose
  labels are proposed and not yet reviewed by a person. The held-out figure is for the rules alone.
  There is no accuracy number for Gemini Nano in the repository yet. The demo total depends on it: with the rules alone the web
  flow counts $3,848.00. The server classifier also sorts the sheets ($96) and the door chain and
  light ($64), from cached `gemini-3.5-flash-lite` answers (`seed/cache/classify_cache.json`), and
  with them the total is $4,008.00. In the browser, the same two lines can be sent to cloud AI only
  after a yes on its consent screen.
- Only Michigan's application is pre-filled (`web/lib/packet/specs.ts`). For other states the
  packet links the program's blank form, or says Tend did not find one. No test checks that a
  program will accept a packet. The program decides.
- The e2e tests run on a dry-run bank and an in-memory database. They do not exercise Neon or
  Nessie; the live suites above do, and they need keys.

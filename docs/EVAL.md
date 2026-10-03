# Tend: evaluation

What was measured, how, and what the numbers do not show. All runs on Oct 3, 2026, on an Apple
M4 Max laptop shared with other work.

## Engines

Tend has two independent implementations of the law engine in docs/SPEC.md v1.2: the C++ compiler
and VM (engine/, which also runs in the browser as WebAssembly) and a Python reference
(refengine/). Both read the same law IR (rules/ir, version 2) and must return the same result
document, byte for byte, for every well-formed claim. engine/FORMAT.md sections 4 and 5 settle
every choice the SPEC leaves open; both engines follow them. The C++ tests add a third, plain
implementation (engine/tests/oracle.cpp) that shares no code with the compiler or the VM.

### Results

| check | result |
|---|---|
| C++ test suite (`make test`) | 69 test cases, 27,014 assertions, all pass |
| the same under AddressSanitizer and UBSan (`make test-san`) | 69 of 69 pass |
| C++ VM vs the C++ oracle, random laws | 6,000 evaluations (1,500 random laws x 4 claims), 0 differences |
| C++ VM vs the C++ oracle, real laws | 612 evaluations (51 jurisdictions x 12 scenarios), 0 differences |
| Python reference tests (`uv run pytest`) | 470 tests, all pass |
| validation messages, reference and C++ | 72 claim cases give byte-identical results; 15 non-JSON texts refused by both |
| laws refused, reference and `tendc` | 51 broken laws refused by both with the same message; 7 edge cases accepted by both |
| hand-computed golden claim (18 lines, 40 trace entries) | the C++ engine wrote the expected file; the reference matches it byte for byte |
| difftest, reference vs C++ (`difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000`) | **121,000 claims, 0 mismatches** |
| WASM vs native (`make wasm-parity`) | **106,000 of 106,000 claims byte-identical**; all 51 shipped law images are the ones tested |
| fuzzing under ASan and UBSan (`make fuzz FUZZ_SECONDS=420`) | 1,276,000 executions in 420 s, no crashes, no property violations |

### The difftest in detail

- 121,000 claims: 2,000 for each of the 51 jurisdictions (102,000), 2,000 for each of the two
  synthetic fixtures (4,000), and 50 for each of 300 random laws (15,000).
- 119,544 claims were well-formed JSON; for every one, the two engines returned identical bytes.
  3,852 claims were refused as `bad_input` and 61 as `jurisdiction_mismatch`, by both engines, with
  identical messages. 1,456 of the refused claims were not JSON at all (broken on purpose); for
  those only the error code is compared, because the C++ message gives a byte offset.
- 3,000 broken or random laws: 1,204 accepted by both engines, 1,796 refused by both with the same
  message, 0 disagreements.
- Decisions reached: 317,455 eligible, 171,600 unknown_rule, 96,360 out_of_window, 78,980
  excluded, 78,960 needs_confirmation, 28,050 held; 90,337 insurance deductions, 11,968 per-unit
  cuts, 41,023 rate_unverified flags, 18,793 per-claim cap cuts, 11,378 total cap cuts.
- SPEC v1.2 paths reached: 11,884 unit caps applied, 14,906 lines flagged because they counted a
  different unit, 25,790 flagged for no unit or no units, 1,061 lines cut to 0 after a count limit
  ran out, 13,866 claims with a report-anchored deadline flag, 2,652 exams treated as medical
  where no exam_no_bill rule exists, 59,300 lines excluded by tag, 208 minimum losses met by
  lost-wage days alone.
- Checks reached: deadline ok 55,617, late 46,526, unknown 14,944; minimum loss met 98,573,
  not_met 10,457, unknown 6,207, may_be_waived 1,498, waived 352; reporting satisfied 57,357,
  required 24,824, unknown 22,493, not_required 12,413.
- The harness catches planted bugs: an engine that ignores typed units fails 77 of 150 ZZ claims, one
  that changes an error message fails 4 of 150, and one that formats the same document differently
  fails 59 of 60 (`tests/test_difftest.py` keeps these checks).

### Fuzzing

The coverage-guided fuzzer (engine/fuzz/fuzz.cpp, SanitizerCoverage with its own driver because
Apple clang ships no libFuzzer) ran 420 s under ASan and UBSan at about 3,000 executions per
second: 319,000 each on raw law images, images with a fixed checksum (to reach the bytecode
verifier), claim JSON against a valid law, and law IR through the compiler. It reached 5,632 of
22,204 instrumented edges and found no crash and no broken property (every result valid JSON, no
VM trap from a compiled law or a valid image).

### Throughput (engine/BENCH.md has the details)

| | result |
|---|---|
| VM, 1M-item Michigan claim, single thread | 14.1M items/s with the trace (71 ms) |
| JSON in to JSON out, 1M items | 1.86M items/s (536 ms; 207 MB in, 424 MB out) |
| WASM in Node, 1M items | 0.73M items/s |
| one survivor-size claim | 0.16 ms through the C ABI, 0.11 ms in the Python reference, 0.12 ms in WASM |

Against the SPEC v1.1 engine on the same machine, back to back: parsing is 12% slower (it now
checks integer ranges, expense and unit strings, and repeated keys) and the VM 10% slower (typed
unit checks), 7% end to end.

### Reproduce

```sh
make -C engine test test-san wasm-parity
make -C engine fuzz FUZZ_SECONDS=420
cd refengine && uv run pytest && cd ..
uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000
```

### What these numbers do not show

- Agreement shows the two engines read FORMAT.md the same way. It does not show that FORMAT.md
  reads the law correctly; that rests on the verified corpus (every rule quotes its source) and on
  the hand-computed golden claims.
- Both engines and the oracle were written by the same team from the same SPEC, so a misreading
  shared by all three would not show up as a mismatch.
- The claims are synthetic, aimed at each law's own numbers. Real bank histories look different.
- 5,632 of 22,204 edges is 25%: the count includes the JSON library and code the fuzz targets
  never call, so it is not a coverage figure for the engine alone.

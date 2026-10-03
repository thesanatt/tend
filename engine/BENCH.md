# Benchmark

A synthetic 1,000,000-item claim, single thread, release build. Recorded Oct 3, 2026, for tend
1.2.0 (tlaw 1.2, SPEC v1.2).

**Machine:** Apple M4 Max (10 performance + 4 efficiency cores), 36 GB, macOS 26.5. The machine
was shared (a browser and other build jobs, load average about 6), and the same binary measured
14.0M to 15.9M items/s at different minutes, so comparisons below were run back to back.
**Native build:** Apple clang 21.0.0, `make` defaults: `-std=c++20 -O2 -DNDEBUG -fPIC -fvisibility=hidden`,
threaded dispatch. **WASM build:** Emscripten 6.0.10 (`em++ -O3 -fno-exceptions`), run in Node 24.14.1.

**Claim:** `tendvm bench` builds 1M items in date order across the window (a few days fall
outside it), with a fixed mix of expenses (medical, counseling, lost wages, transportation,
relocation, forensic exam, property, prescription, security, other, dental, unknown), 90%
confirmed, 20% with insurance, 75% with units. Counted counseling, lost wage, and transportation
lines name their unit (session, week, mile) 9 times in 10, so per-unit caps both apply and flag.
Best of 5 runs.

| law | IR rules | instructions run | VM, trace on | VM, trace off | JSON in -> JSON out |
|---|---|---|---|---|---|
| MI (real Michigan IR) | 80 | 31.4M | **14.1M items/s** (71 ms) | 16.0M items/s (63 ms) | **1.86M items/s** (536 ms) |
| ZZ (test fixture, tag checks on every expense) | 33 | 41.9M | 12.4M items/s (81 ms) | 13.4M items/s (74 ms) | 1.85M items/s (539 ms) |

For MI the end-to-end time splits into reading 207 MB of claim JSON with full validation and the
duplicate item_id check (287 ms), the VM (71 ms), and writing 424 MB of result JSON with its
2.2M-entry trace (147 ms). The law itself is about 13% of a bank-scale run; the rest is JSON.

## Against tend 1.1 (SPEC v1.1), same machine, back to back

The wave-1 engine (main at 0fe19be) built from source and run on the same MI rules (IR marked
version 1 so its compiler accepts it), alternating three times with the current build:

| | tend 1.1 | tend 1.2 | change |
|---|---|---|---|
| parse (validation) | 257 ms | 287 ms | +12% |
| VM, trace on | 64 ms (29.5M instructions) | 70 ms (31.4M instructions) | +10% |
| JSON in -> JSON out | 2.0M items/s | 1.86M items/s | -7% |

The parse now checks every integer against the JavaScript-safe range, refuses unknown expense
and unit strings and repeated keys, and reads the `unit` field (the claim is also 2% larger). The
VM runs 6% more instructions: each per-unit cap compares the line's unit, and minimum loss rules
with a day count sum lost-wage days. The wave-1 numbers in git history (18.2M items/s) were taken
on a quieter machine; on this one, at this time, tend 1.1 ran 15.6M.

## Small claims

A survivor's claim is tens of lines, not millions. On 2,000 generated Michigan claims
(12,384 items, 6.2 per claim):

| engine | per claim |
|---|---|
| libtend through ctypes (`tend_eval_json`) | 0.161 ms |
| Python reference, law loaded once | 0.106 ms |
| WASM in Node, 22-item ZZ claim (`wasm_smoke.mjs`) | 0.117 ms |

`tend_eval_json` keeps no state, so every call checks the whole image again (the SHA-256 trailer
over 52 KB, the section tables, and the bytecode verifier): an empty claim costs 0.159 ms, nearly
all of the 0.161. That is fine for one claim at a time in the browser. A handle that verifies once
and evaluates many claims would remove it for the API; it is not built. All 2,000 results were
byte-identical between the two engines.

The WASM engine on the 1M-item MI claim: **0.73M items/s** end to end in Node (1.37 s; the time
includes moving 166 MB in and 425 MB out across the JavaScript boundary).

## Reproduce

From engine/:

```
make bench                                                  # ZZ fixture
./build/tendc ../rules/ir/MI.json -o build/laws/MI.tlaw
./build/tendvm bench --law build/laws/MI.tlaw --items 1000000 --runs 5
make wasm && node scripts/wasm_bench.mjs ../web/public/engine build/laws/MI.tlaw 1000000 3
```

## Notes

- Threaded dispatch (computed goto) against the plain `switch`, back to back on MI: 15.7M vs
  14.1M items/s with the trace on, 17.5M vs 14.8M with it off. Build with
  `-DTEND_NO_THREADED_DISPATCH` to compare. WASM always uses the switch.
- The item program runs once per item without a call per item: `ret` moves to the next item.
- Error messages are built only when a field is wrong, so the happy path never formats a path
  like `items[123].amount_cents`.

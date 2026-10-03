# Benchmark

A synthetic 1,000,000-item claim, single thread, release build. Recorded Oct 3, 2026.

**Machine:** Apple M4 Max (10 performance + 4 efficiency cores), 36 GB, macOS 26.5.2.
**Native build:** Apple clang 21.0.0, `make` defaults: `-std=c++20 -O2 -DNDEBUG -fPIC -fvisibility=hidden`,
threaded dispatch. **WASM build:** Emscripten 6.0.10 (`em++ -O3 -fno-exceptions`), run in Node 24.14.1.

**Claim:** `tendvm bench` builds 1M items in date order across the window (a few days fall
outside it), with a fixed mix of expenses (medical, counseling, lost wages, transportation,
relocation, forensic exam, property, prescription, security, other, dental, unknown), 90%
confirmed, 20% with insurance, 75% with units. Best of 5 runs; medians were within 3%.

| law | IR rules | instructions run | VM, trace on | VM, trace off | JSON in -> JSON out |
|---|---|---|---|---|---|
| MI (real Michigan IR) | 78 | 29.5M | **18.2M items/s** (55 ms) | 20.3M items/s (49 ms) | **2.33M items/s** (430 ms) |
| ZZ (test fixture, tag checks on every expense) | 31 | 39.8M | 14.2M items/s (70 ms) | 15.8M items/s (63 ms) | 2.13M items/s (470 ms) |

The end-to-end time for MI splits into parsing 203 MB of claim JSON and checking that item ids are unique (227 ms), the VM (55 ms),
and writing 424 MB of result JSON with its 2.2M-entry trace (126 ms). So the law itself is
about 15% of a bank-scale run; the rest is JSON.

The WASM engine on the same MI claim: **0.78M items/s** end to end in Node (1.29 s for 1M items;
the time includes moving 162 MB in and 423 MB out across the JavaScript boundary), and 0.11 ms
for the 21-item fixture claim, which is the size of a real survivor's claim.

## Reproduce

From engine/:

```
make bench                                                  # ZZ fixture
./build/tendc ../rules/ir/MI.json -o build/laws/MI.tlaw
./build/tendvm bench --law build/laws/MI.tlaw --items 1000000 --runs 5
make wasm && node scripts/wasm_bench.mjs ../web/public/engine build/laws/MI.tlaw 1000000 3
```

## Notes

- Threaded dispatch (computed goto) is about 8% faster than the plain `switch` on this machine
  (18.2M vs 16.8M items/s for MI); Apple's branch predictor already handles the switch well.
  Build with `-DTEND_NO_THREADED_DISPATCH` to compare. WASM always uses the switch.
- The item program runs once per item without a call per item: `ret` moves to the next item.
- Building error-path strings lazily (only when a field is wrong) cut JSON parsing from 296 ms
  to 193 ms per million items. The duplicate item_id check (an open-addressing table over the
  parsed ids) added about 35 ms back.

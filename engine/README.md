# engine/: the Tend law engine

A small compiler and virtual machine for crime victim compensation law. `tendc` turns one
jurisdiction's law IR (version 2, docs/SPEC.md v1.2) into a `.tlaw` image; `libtend` verifies the
image byte by byte and runs a claim through its bytecode; every allowed dollar comes back with
the rules (and so the quotes) that justify it. The same C++ runs natively and as WebAssembly in
the browser.

FORMAT.md is the specification (image layout, instruction set, verifier, semantics, input and
output documents). BENCH.md has the performance numbers; EVAL.md has the engine test results, and
docs/EVAL.md the whole project's.

## Build and test

Needs a C++20 compiler (Apple clang 21 and GCC 13 are fine). Emscripten only for the WASM build.

```
make                 # build/libtend.a, build/libtend.dylib (.so on Linux), build/tendc, build/tdis, build/tendvm
make test            # 70 doctest cases; pass IR=... VERIFIED=... to point the corpus test elsewhere
make test-san        # the same under AddressSanitizer and UBSan
make fuzz FUZZ_SECONDS=300
make bench           # 1M-item claim, single thread
make laws            # rules/ir + rules/verified -> build/laws/ST.tlaw
make wasm            # web/public/engine/tend.js, tend.wasm, tend_engine.mjs, laws/ST.tlaw, laws/index.json
make wasm-parity     # the difftest's claims through WASM and native, byte for byte
```

CMake works too: `cmake -S engine -B engine/build/cmake -G Ninja && cmake --build engine/build/cmake`
and `ctest --test-dir engine/build/cmake`; under `emcmake` it builds the WASM module.

The tests: `test_semantics.cpp` checks each SPEC step by hand-computed answers;
`test_differential.cpp` runs 1,500 random laws x 4 claims against `oracle.cpp`, a second, plain
implementation that shares no code with the compiler or VM; `test_corpus.cpp` compiles all 51
jurisdictions, checks 12 scenarios each against the oracle, and fails when an image in
`web/public/engine/laws` (or its `index.json` entry) is not what `tendc` builds now, so a rules
change needs `make wasm` before it ships; `test_loader.cpp` feeds the loader
broken images; `test_capi.cpp` checks the C ABI, the CLI tools, and the golden output in
`tests/golden/`. The Python reference (refengine/) is a third implementation; `refengine/difftest.py`
compares it with this engine on random claims.

## Command line

```
tendc rules/ir/MI.json -o build/laws/MI.tlaw            # verified file found at rules/verified/MI.json
tendc rules/ir/MI.json --verified path/MI.json -o MI.tlaw
tdis build/laws/MI.tlaw                                 # annotated assembly listing
tendvm eval --law build/laws/MI.tlaw --input claim.json [--pretty] [-o out.json]
tendvm inspect build/laws/MI.tlaw [--pretty]            # rule table, quotes, sources, tags
tendvm disasm build/laws/MI.tlaw
tendvm bench --law build/laws/MI.tlaw [--items 1000000] [--runs 5]
```

`tendc` refuses stale IR (its `source_sha256` no longer matches the verified file): rerun
`uv run --python 3.12 rules/tools/normalize.py` first. It also refuses IR version 1.

## C ABI (include/tend/tend.h)

```c
const char* tend_version(void);                                    /* "tend 1.2.0 (tlaw 1.2)" */
char* tend_eval_json(const uint8_t* img, size_t img_len, const char* input_json);
char* tend_disasm(const uint8_t* img, size_t img_len);
char* tend_inspect_json(const uint8_t* img, size_t img_len);
void  tend_free(void* p);
```

Every `char*` result is malloc'd UTF-8; free it with `tend_free`. Errors are JSON documents
(`{"error":{"code","message"}}`, FORMAT.md section 5 lists every message), or a line starting
with `error: ` from `tend_disasm`. The functions keep no global state and are safe to call from
several threads.

From Python (the API service):

```python
import ctypes, json
lib = ctypes.CDLL("engine/build/libtend.dylib")
lib.tend_eval_json.restype = ctypes.c_void_p
lib.tend_eval_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
lib.tend_free.argtypes = [ctypes.c_void_p]
image = open("engine/build/laws/MI.tlaw", "rb").read()
ptr = lib.tend_eval_json(image, len(image), json.dumps(claim).encode())
result = json.loads(ctypes.string_at(ptr).decode())
lib.tend_free(ptr)
```

From the browser:

```js
import { loadTend } from '/engine/tend_engine.mjs';
const tend = await loadTend();
const image = new Uint8Array(await (await fetch('/engine/laws/MI.tlaw')).arrayBuffer());
const result = tend.evaluate(image, claim);   // same JSON as the native engine
```

Items should carry `unit` next to `units` (SPEC v1.2): a per-session cap applies only to items
counted in sessions, and anything else is flagged `rate_unverified`. Expense and unit strings
outside the lists in FORMAT.md section 5 are refused.

## Layout

```
include/tend/tend.h   C ABI
src/                  format, sha256, civil dates, JSON reader/writer, image builder and loader,
                      VM, evaluation, disassembler, C ABI, compiler (the only part using nlohmann/json)
tools/                tendc, tdis, tendvm
tests/                doctest suite, an independent oracle, fixtures (fictional jurisdiction ZZ),
                      goldens, wasm_smoke.mjs, wasm_parity.mjs
fuzz/                 coverage-guided fuzzer
scripts/              build_laws.sh, build_wasm.sh, laws_index.mjs, run_claim.sh, wasm_bench.mjs
js/                   tend_engine.mjs, the WASM wrapper
third_party/          nlohmann/json 3.11.3 and doctest 2.4.11 single headers (MIT)
```

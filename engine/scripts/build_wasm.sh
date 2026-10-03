#!/usr/bin/env bash
# WebAssembly build of the law engine for on-device evaluation.
#   scripts/build_wasm.sh [OUT_DIR] [IR_DIR] [VERIFIED_DIR]
# Writes OUT_DIR/tend.js, tend.wasm, tend_engine.mjs (default ../web/public/engine).
# When IR_DIR (default ../rules/ir) has jurisdictions, also compiles them with
# their verified files into OUT_DIR/laws/ST.tlaw plus laws/index.json; stale
# IR is reported and skipped. Ends with a Node check that the WASM engine and
# the native engine produce byte-identical output.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/../web/public/engine}"
ir="${2:-$here/../rules/ir}"
verified="${3:-$here/../rules/verified}"

if ! command -v em++ >/dev/null 2>&1; then
  echo "build_wasm: em++ not found. Install Emscripten (brew install emscripten) and rerun." >&2
  exit 1
fi
mkdir -p "$out"
cd "$here"

em++ -std=c++20 -O3 -fno-exceptions -DNDEBUG -Iinclude -Isrc -Ithird_party \
  src/format.cpp src/sha256.cpp src/civil.cpp src/json.cpp src/image.cpp src/builder.cpp \
  src/vm.cpp src/eval.cpp src/disasm.cpp src/capi.cpp \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTendModule \
  -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_tend_eval_json,_tend_disasm,_tend_inspect_json,_tend_version,_tend_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8,HEAPU8 \
  -o "$out/tend.js"
cp js/tend_engine.mjs "$out/tend_engine.mjs"
echo "build_wasm: $(wc -c < "$out/tend.wasm" | tr -d ' ') bytes wasm, $(wc -c < "$out/tend.js" | tr -d ' ') bytes js -> $out"

# Native tools for compiling laws and for the parity check.
make -s build/tendc build/tendvm >/dev/null
mkdir -p build/laws
./build/tendc --quiet tests/fixtures/ir/ZZ.json -o build/laws/ZZ.tlaw

shopt -s nullglob
ir_files=("$ir"/*.json)
if [ ${#ir_files[@]} -gt 0 ]; then
  ./scripts/build_laws.sh "$ir" "$verified" "$out/laws" || echo "build_wasm: some jurisdictions were not compiled (listed above)"
  node scripts/laws_index.mjs "$out/laws" > "$out/laws/index.json"
  echo "build_wasm: $(ls "$out"/laws/*.tlaw | wc -l | tr -d ' ') law images in $out/laws"
fi

node tests/wasm_smoke.mjs "$out" build/laws/ZZ.tlaw tests/fixtures/ZZ_claim.json tests/golden/ZZ_claim.out.json

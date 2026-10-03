#!/usr/bin/env bash
# WebAssembly build of the law engine for on-device evaluation.
#   scripts/build_wasm.sh [OUT_DIR] [RULES_DIR]
# Writes OUT_DIR/tend.js, tend.wasm, tend_engine.mjs (default ../web/public/engine).
# When RULES_DIR (default ../rules/verified) has jurisdictions, also compiles
# them natively into OUT_DIR/laws/ST.tlaw plus laws/index.json.
# Finishes with a Node check that WASM and native outputs are byte-identical.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/../web/public/engine}"
rules="${2:-$here/../rules/verified}"

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
./build/tendc --quiet tests/fixtures/ZZ.json -o build/laws/ZZ.tlaw

shopt -s nullglob
law_files=("$rules"/*.json)
if [ ${#law_files[@]} -gt 0 ]; then
  ./scripts/build_laws.sh "$rules" "$out/laws" >/dev/null
  node scripts/laws_index.mjs "$out/laws" > "$out/laws/index.json"
  echo "build_wasm: compiled ${#law_files[@]} jurisdictions into $out/laws"
fi

node tests/wasm_smoke.mjs "$out" build/laws/ZZ.tlaw tests/fixtures/ZZ_claim.json tests/golden/ZZ_claim.out.json

#!/usr/bin/env bash
# Compile every jurisdiction's law IR into a law image.
#   scripts/build_laws.sh [IR_DIR] [VERIFIED_DIR] [OUT_DIR]
# Defaults: ../rules/ir, ../rules/verified -> build/laws. Prints one line per
# jurisdiction. Stale IR (rerun rules/tools/normalize.py) and other failures
# are listed and make the script exit non-zero; good images are still written.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ir_dir="${1:-$here/../rules/ir}"
verified_dir="${2:-$here/../rules/verified}"
out="${3:-$here/build/laws}"
tendc="$here/build/tendc"

if [ ! -x "$tendc" ]; then
  make -C "$here" -s build/tendc >/dev/null || exit 1
fi
mkdir -p "$out"

shopt -s nullglob
files=("$ir_dir"/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "no law IR in $ir_dir"
  exit 0
fi

failed=0
for f in "${files[@]}"; do
  st="$(basename "$f" .json)"
  if msg="$("$tendc" --quiet "$f" --verified "$verified_dir/$st.json" -o "$out/$st.tlaw" 2>&1)"; then
    printf '%-4s ok   %7d bytes\n' "$st" "$(wc -c < "$out/$st.tlaw")"
  else
    printf '%-4s FAIL %s\n' "$st" "${msg#tendc: }"
    rm -f "$out/$st.tlaw"
    failed=1
  fi
done
exit $failed

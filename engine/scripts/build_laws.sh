#!/usr/bin/env bash
# Compile every verified jurisdiction into a law image.
#   scripts/build_laws.sh [RULES_DIR] [OUT_DIR]
# Defaults: ../rules/verified -> build/laws. Prints one line per jurisdiction
# and exits non-zero if any file fails to compile.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
rules="${1:-$here/../rules/verified}"
out="${2:-$here/build/laws}"
tendc="$here/build/tendc"

if [ ! -x "$tendc" ]; then
  make -C "$here" -s build/tendc >/dev/null || exit 1
fi
mkdir -p "$out"

shopt -s nullglob
files=("$rules"/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "no verified jurisdictions in $rules"
  exit 0
fi

failed=0
for f in "${files[@]}"; do
  st="$(basename "$f" .json)"
  if msg="$("$tendc" --quiet "$f" -o "$out/$st.tlaw" 2>&1)"; then
    printf '%-4s ok   %7d bytes\n' "$st" "$(wc -c < "$out/$st.tlaw")"
  else
    printf '%-4s FAIL %s\n' "$st" "$msg"
    failed=1
  fi
done
exit $failed

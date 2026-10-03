#!/usr/bin/env bash
# Evaluate one claim: scripts/run_claim.sh LAW.tlaw CLAIM.json [--pretty]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
law="$1"
claim="$2"
shift 2
mode=eval
exec "$here/build/tendvm" "$mode" --law "$law" --input "$claim" "$@"

#!/usr/bin/env bash
# Between judges: put Rowan's fictional Nessie account back at the demo start (about 3 s).
# Then, in the browser: press Esc twice (Exit this page) and open the demo link this prints.
set -euo pipefail
cd "$(dirname "$0")/../seed"
uv run python reset_demo.py | tail -1
echo "Now: Esc twice in the browser, then open https://youreowed.tech/check?demo=rowan"

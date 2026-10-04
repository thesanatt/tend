#!/usr/bin/env bash
# Tend's end-to-end tests in Chromium, with one command (Playwright for Python, through uv):
#
#   web/e2e/run.sh                    build the web app, start the API and the app, run every test
#   E2E_SKIP_BUILD=1 web/e2e/run.sh   reuse the last e2e build
#   web/e2e/run.sh -k offline         pytest options pass through
#   E2E_CHANNEL=chrome web/e2e/run.sh drive the installed Google Chrome instead of Playwright's Chromium
#
# The API runs on an in-memory database with the bank in dry-run mode and without the repo .env, so a
# run never writes to Neon or Nessie and never calls a model. Ports: E2E_API_PORT (8790),
# E2E_WEB_PORT (3790). Server logs land in E2E_LOG_DIR (/tmp/tend-e2e).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PLAYWRIGHT_VERSION="${E2E_PLAYWRIGHT_VERSION:-1.47.0}"
run() { uv run --quiet --python 3.12 --with "playwright==${PLAYWRIGHT_VERSION}" --with pytest "$@"; }
# The browser Playwright drives; downloaded once, then reused.
run python -m playwright install chromium >/dev/null
exec uv run --quiet --python 3.12 --with "playwright==${PLAYWRIGHT_VERSION}" --with pytest \
  python -m pytest -p no:cacheprovider -q -rA "$@"

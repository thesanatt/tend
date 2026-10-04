#!/usr/bin/env bash
# Starts Tend on this machine with one command: the API (FastAPI on uvicorn), the web app (Next.js),
# and the Fetch.ai agent when agent/run.sh is there. Prints the URLs. Ctrl+C stops everything.
#
#   scripts/dev.sh              API + web (next dev, hot reload) + agent
#   scripts/dev.sh --prod       the web app as a production build, the way Vercel serves it. Only this
#                               mode registers the offline worker (public/sw.js), so use it to rehearse
#                               the airplane-mode demo.
#   scripts/dev.sh --no-agent   skip the agent
#
# Settings (environment):
#   API_PORT, WEB_PORT   default 8000 and 3000; when a port is taken the next free one is used
#   TEND_DB              default: a local SQLite file (api/.data/dev.sqlite3), loaded with the corpus on
#                        first start. TEND_DB=neon uses Neon from the repo .env.
#   TEND_BANK            default dry_run: a confirmed payment is recorded and read back, nothing goes to
#                        the bank. TEND_BANK=nessie writes it to Capital One's Nessie sandbox (fictional
#                        demo accounts only).
# Secrets stay in the repo .env, which the API and the agent read themselves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="dev"
AGENT=1
for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    --no-agent) AGENT=0 ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "Tend needs $1 on PATH." >&2; exit 1; }; }
need uv
need node
need npm
need curl
need lsof

busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
free_port() {
  local p="$1"
  while busy "$p"; do p=$((p + 1)); done
  echo "$p"
}

API_PORT="$(free_port "${API_PORT:-8000}")"
WEB_PORT="$(free_port "${WEB_PORT:-3000}")"
API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"
TMP="${TMPDIR:-/tmp}"
LOGS="${TMP%/}/tend-dev"
mkdir -p "$LOGS" "$ROOT/api/.data"

# Everything started here is in this script's process group, so one kill stops it all.
stop() {
  trap - INT TERM EXIT
  kill 0 2>/dev/null || true
}
trap stop INT TERM EXIT

wait_for() {
  local url="$1" name="$2" tries="${3:-120}"
  for _ in $(seq "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "$name did not start. Its log: $LOGS/${name}.log" >&2
  exit 1
}

echo "Starting the API on ${API_URL} ..."
(
  cd "$ROOT/api"
  uv sync -q
  TEND_DB="${TEND_DB:-$ROOT/api/.data/dev.sqlite3}" \
    TEND_BANK="${TEND_BANK:-dry_run}" \
    TEND_CORS_ORIGINS="${WEB_URL},http://127.0.0.1:${WEB_PORT}" \
    exec uv run uvicorn tend_api.main:app --host 127.0.0.1 --port "$API_PORT"
) >"$LOGS/api.log" 2>&1 &
wait_for "${API_URL}/api/health" api

echo "Starting the web app on ${WEB_URL} (${MODE}) ..."
(
  cd "$ROOT/web"
  [ -d node_modules ] || npm ci --no-audit --no-fund
  export TEND_API_URL="$API_URL"
  if [ "$MODE" = "prod" ]; then
    npx next build
    exec npx next start --port "$WEB_PORT"
  else
    exec npx next dev --port "$WEB_PORT"
  fi
) >"$LOGS/web.log" 2>&1 &
wait_for "${WEB_URL}/check" web 600

AGENT_LINE="not started (--no-agent)"
if [ "$AGENT" = 1 ] && [ -x "$ROOT/agent/run.sh" ]; then
  AGENT_PORT="${AGENT_PORT:-8001}"
  if busy "$AGENT_PORT"; then
    # One agent per seed: a second copy would fight the first for the same Agentverse mailbox.
    AGENT_LINE="port ${AGENT_PORT} is already in use, so it was not started again"
  else
    (cd "$ROOT/agent" && TEND_API_URL="$API_URL" AGENT_PORT="$AGENT_PORT" exec ./run.sh) >"$LOGS/agent.log" 2>&1 &
        AGENT_LINE="starting on port ${AGENT_PORT}; its address and Inspector link are in ${LOGS}/agent.log"
  fi
elif [ "$AGENT" = 1 ]; then
  AGENT_LINE="not here (no agent/run.sh)"
fi

cat <<EOF

Tend is running.
  Survivor flow     ${WEB_URL}/check?demo=rowan   (Rowan, fictional, Michigan)
  Public page       ${WEB_URL}/mi
  How Tend decides  ${WEB_URL}/law/MI
  API docs          ${API_URL}/api/docs
  Agent             ${AGENT_LINE}
  Logs              ${LOGS}/
Press Ctrl+C to stop.
EOF

wait

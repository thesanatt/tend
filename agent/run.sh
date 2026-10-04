#!/usr/bin/env bash
# Start Tend Navigator and its two helper agents (Law, Bank and Packet) for ASI:One.
# It loads the repo .env (the file wins over the shell) and creates AGENT_SEED there once if it is missing.
# No seed is ever printed. The addresses and the Agentverse Inspector link are.
#
#   ./run.sh            run the three agents; the Navigator listens on its Agentverse mailbox
#   ./run.sh --address  print the three addresses and the Inspector link, then exit
#   ./run.sh --chat     talk to the same conversation in this terminal, no Agentverse needed
#
# Only one copy of the Navigator should run at a time: two processes on the same mailbox take each other's messages.
set -euo pipefail
cd "$(dirname "$0")"
exec uv run --python 3.12 python -m tend_agent "$@"

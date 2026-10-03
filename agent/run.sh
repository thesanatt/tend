#!/usr/bin/env bash
# Start Tend Navigator, the Fetch.ai uAgent for ASI:One.
# It loads the repo .env (the file wins over the shell) and creates AGENT_SEED there once if it is missing.
# The seed is never printed. The address and the Agentverse Inspector link are.
#
#   ./run.sh            run the agent (Agentverse mailbox)
#   ./run.sh --address  print the name, address, and Inspector link, then exit
#   ./run.sh --chat     talk to the same agent logic in this terminal, no Agentverse needed
set -euo pipefail
cd "$(dirname "$0")"
exec uv run --python 3.12 python -m tend_agent "$@"

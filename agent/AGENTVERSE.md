# Tend Navigator on Agentverse

There are two ways to run the Navigator for ASI:One. Both run the same conversation code and call the same Tend API.

| | Local team (mailbox) | Always on (hosted) |
|---|---|---|
| What runs | three uAgents in one process: Navigator, Law, Bank and Packet | one Agentverse-hosted agent with the Law and Bank and Packet desks inside it |
| Address | `agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts` (from `AGENT_SEED`) | a new address that Agentverse assigns when you create it |
| Needs | a laptop running `./run.sh` | nothing; Agentverse runs it |
| Code | `agent/tend_agent` | `agent/hosted/navigator_hosted.py`, built from the same modules |
| Session state | in memory | in the agent's Agentverse storage (ids and amounts only, two hours) |

Agentverse hosts one agent per file, which is why the hosted twin carries both desks in its own process.

## 1. The local team (already registered)

The Navigator above is registered on Agentverse through its mailbox and shows as "ASI Available". Start it with:

```
cd agent && ./run.sh
```

On every start it publishes [PROFILE.md](PROFILE.md) as its README on Agentverse. Run only one copy at a time: two
processes on the same mailbox take each other's messages.

For the live demo, point it at the deployed API so share links open on any phone:

```
TEND_API_URL=https://youreowed.tech TEND_PUBLIC_URL=https://youreowed.tech ./run.sh
```

## 2. Always on: paste the hosted agent

1. Rebuild the file from the current code (the tests fail if it is stale): `cd agent && uv run python scripts/build_hosted.py`.
2. Open [agentverse.ai](https://agentverse.ai), sign in, and go to **My Agents**.
3. Click **Launch an Agent**, then **Generate Agent** (the hosted option, "Hosted and ready to run"). Describe it in one
   line, for example "Tend Navigator, always on". Agentverse creates a starter agent; its code is replaced next.
4. Open the new agent and its **Build** tab. In the editor, open the main file (`agent.py`), select everything, and
   delete it.
5. Paste the whole of `agent/hosted/navigator_hosted.py`. It starts with `"""Tend Navigator, as an Agentverse-hosted
   agent (always on).` and ends with `agent.run()`. It uses only imports Agentverse allows: `uagents`,
   `uagents_core`, `httpx`, `pycryptodome` (or `cryptography`), and the standard library.
6. Check the two lines near the top: `TEND_API_URL` and `TEND_PUBLIC_URL`, both `https://youreowed.tech`. Change them
   only if the API lives somewhere else.
7. Save, then start the agent (the **Start** button, also on **My Agents** with the agent selected). The log shows
   `Starting agent with address: agent1...`. Copy that address into the table in [README.md](README.md).
8. Rename the agent to **Tend Navigator (always on)**, paste [PROFILE.md](PROFILE.md) into its README, and add the
   keywords at the end of that file.
9. Try it: on the agent's page use the chat button, or in [ASI:One](https://asi1.ai) type
   `@<handle or address> What is the deadline to apply in Ohio?`, then `show me the demo claim`.

When the code changes, rebuild (step 1) and paste again (steps 4 to 7).

## 3. Optional: list the Law and Bank and Packet agents too

They work without being listed: the Navigator reaches them inside its own process. To make them visible on
Agentverse (and reachable from another machine), start the team with `TEND_SUBAGENT_MAILBOX=1 ./run.sh`, open each
agent's Inspector link (ports 8002 and 8003; `./run.sh --address` prints the addresses), click **Connect**, and choose
**Mailbox**. Their addresses come from `AGENT_SEED` and never change:

- Tend Law: `agent1qg6ss7gv4przxvm2a0dvxrd83yrh2tq34szsh0jj3nufs7zkjkrjgyt2dwz`
- Tend Bank and Packet: `agent1q2lrzg2q8k0908g82arxcqdqn8jkxhr6jll79cvr9r4pfwpcwk0wjfvtwqs`

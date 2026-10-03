# Tend Navigator (Fetch.ai agent)

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

| | |
|---|---|
| **Agent name** | Tend Navigator |
| **Agent address** | `agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts` |
| **Protocol** | Agent Chat Protocol 0.3.0 (`uagents==0.25.5`), with ASI:One Interactive Cards |
| **Runs as** | a local uAgent with an Agentverse mailbox, so it works behind venue Wi-Fi |

The address comes from `AGENT_SEED` in the repo `.env`, so it stays the same every run. The agent prints it, with
the Agentverse Inspector link, when it starts.

Tend Navigator is the advocate's side of Tend. In an ASI:One chat it:

1. answers questions about any state's crime victim compensation program with the law quoted, a pinpoint, and a
   link, and says "I don't know" when no verified rule supports an answer;
2. runs a Check (state, date, exam, police report) and returns the deadline as a date, the police report rule,
   the exam billing protection, covered costs with limits, and the program's contact details;
3. walks through the fictional demo claim, then pays the rest of the hospital bill through the Tend API's
   propose and confirm flow, only after the person types the one-time code the server issued;
4. never asks for, passes on, or stores what happened.

Nothing in the agent decides law or money. It reads the Tend API, which runs the law engine over the verified rules.

## Run it

You need [uv](https://docs.astral.sh/uv/) and the Tend API.

```
# 1. Start the Tend API (from the repo root)
cd api && uv sync && uv run uvicorn tend_api.main:app --port 8000

# 2. In another terminal, start the agent
cd agent && ./run.sh
```

`run.sh` loads the repo `.env` (the file wins over the shell), creates `AGENT_SEED` in it the first time (the seed
is never printed), and starts the agent. You will see:

```
Tend Navigator is running.
  Address:   agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts
  Inspector: https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A8001&address=agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts
  Tend API:  http://127.0.0.1:8000 (ok, 51 jurisdictions)
  To list it on Agentverse: open the Inspector link, click Connect, and choose Mailbox.
```

To make it reachable from ASI:One (once):

1. Open the Inspector link while the agent runs, sign in to Agentverse, click **Connect**, choose **Mailbox**.
2. The agent's profile on Agentverse uses [AGENTVERSE.md](AGENTVERSE.md) (badges, use cases, limits, keywords).
   Optional: set `AGENT_HANDLE` before connecting so people can type `@your-handle` in ASI:One.
3. In [ASI:One](https://asi1.ai), ask something like "Use Tend Navigator: what is the deadline to apply in Ohio?"

Other modes:

```
./run.sh --address   # print the name, address, and Inspector link, then exit (no network)
./run.sh --chat      # talk to the same agent logic in this terminal, one message per line, no Agentverse
uv run python scripts/rehearse.py   # the demo chat below, typed for you against TEND_API_URL
```

## Example chat

Real output from `scripts/rehearse.py` against the Tend API on this branch. Long quotes and some lines are cut
where marked with `[...]`.

> **You:** What is the deadline to apply in Ohio?
>
> **Tend Navigator:** Here is the deadline to apply in Ohio.
>
> Apply within three years of the crime. The statute points to ORC 2743.60 for exceptions: claimants who were
> minors or young adults at the time get extra time, and the Attorney General may accept a late claim at any time
> for good cause shown. ([ORC 2743.56(B); ORC 2743.60(A)(2)(d)](https://codes.ohio.gov/ohio-revised-code/section-2743.56#:~:text=All%20applications%20for%20an%20award,2743.60%20of%20the%20Revised%20Code.))
> "All applications for an award of reparations may be filed at any time within three years after the occurrence
> of the criminally injurious conduct, except as provided in divisions (A)(2)(b) to (d) of section 2743.60 of the
> Revised Code." [...]

> **You:** check Michigan, June 14 2026, had an exam, not reported
>
> **Tend Navigator:** **You can likely apply in Michigan.** The program decides.
>
> **Deadline:** apply by **June 14, 2031**. A claim must be filed within 5 years after the crime.
> ([MCL 18.355(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355#:~:text=a%20claim%20must%20be%20filed,which%20the%20claim%20is%20based))
>
> **Police report:** your forensic exam counts in place of a police report. ([MCL 18.355a(10)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=For%20payments%20authorized%20under%20this,under%20sections%206%20and%2010.))
>
> **Exam bills:** you should not get a bill for a forensic exam. ([MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket%20expense.))
>
> **Covered costs:** Medical care, Counseling (up to $125 a session, limits vary), Lost wages (up to $1,000 a
> week), Moving (up to $3,800), [...]
>
> **Most you can ask for:** $45,000 in total. **Program:** Michigan Crime Victim Compensation, phone 877-251-7373.

> **You:** show me the demo claim
>
> **Tend Navigator:** **Demo: Rowan Hale, Michigan.** Fictional person and data on Capital One's Nessie mock
> bank. No real person, account, or hospital. Tend read 191 bank records and found these possible costs since
> June 14, 2026: Counseling: 16 charges, $2,400.00 [...] Hospital bill (itemized): 3 lines, $443.00.
> Count these for the demo claim? *[Review card: Count these costs for the demo claim?]*
>
> **You:** yes
>
> **Tend Navigator:** **Amount Rowan Hale can ask for: $2,760.00. The program decides.** [...]
> **Don't pay this line:** forensic exam, $325.00 on the hospital bill. The law says the survivor should not be
> billed. ([MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket%20expense.))
> The rest of the hospital bill is **$118.00**. Want to pay it from Checking ending 0011 (mock bank)? Say
> **pay the bill**. Nothing moves until you type a code.
>
> **You:** pay the bill
>
> **Tend Navigator:** Here is the payment to review. **Nothing moves until you type the code.** To pay $118.00,
> type **524707** here. To stop, say cancel. *[Review card: pay $118.00 to Riverbend General Hospital
> (fictional), from Checking ending 0011, not paid: forensic exam line $325.00, code, Continue / Cancel]*
>
> **You:** 524707
>
> **Tend Navigator:** **Done.** Paid $118.00 to Riverbend General Hospital. Dry run: Tend recorded it and read it
> back, but did not send it to the bank. Bank record: dryrun-5a33[...]. Audit log: aud_000009, in a hash chain with
> no names in it. The forensic exam line, $325.00, stays unpaid.

## How a payment stays safe

- The API issues the code with the proposal. The agent shows it once on the review card and in the message,
  then forgets it. Session state keeps the action id and amount, never the code.
- Only a code the person types (in the chat, or in the code box after **Continue**) is sent to
  `POST /api/actions/confirm`. No button carries the code, and "yes" or "approve" only gets a reminder.
- The API checks the code against a MAC bound to the action id, amount, account, and payee. Codes work once,
  end after 10 minutes, and lock after 5 wrong tries. The agent explains each case and never retries by itself.
- The payment is `kind: pay_bill` for the bill lines the law engine checked, minus the held exam line, from the
  demo persona's own account. `TEND_BANK=dry_run` (the API default) records and reads back without sending;
  `TEND_BANK=nessie` writes to the Nessie mock bank.
- A code typed in someone else's chat does nothing: sessions are per sender.

## Privacy

- The agent never asks what happened, where, or who. If a message starts to describe it, the agent says it does
  not need that, does not pass the message on, and answers from the topic alone (for example "counseling").
- Message text is never stored or logged. Logs hold the kind of turn only, like `turn intent=answer replies=1`.
  The uAgents Inspector's message history, which would keep every message in memory, is switched off.
- Session state lives in memory, ends after two quiet hours, and holds ids, amounts, a state code, and the topic of
  an open question. Check answers (date, exam, report) are dropped as soon as the Check runs. Merchant text from
  the demo is dropped before anything is kept.
- A linked claim (`link ABCD-EFGH`, a one-time code from the Tend app) shows totals and rules only, never bill
  text. The session token is not kept.

## Settings

All optional. The repo `.env` is loaded with override, then these are read.

| Variable | Default | What it does |
|---|---|---|
| `TEND_API_URL` | `http://127.0.0.1:8000` | The Tend API |
| `AGENT_SEED` | created in `.env` on first run | Fixes the agent address. Never printed or committed |
| `AGENT_PORT` | `8001` | Local port for the Inspector link |
| `AGENT_HANDLE` | none | Agentverse handle, sent when you connect through the Inspector |
| `TEND_PUBLIC_URL` | none | The web app's address, offered after a Check ("open Tend on your own device") |
| `TEND_DEMO_PERSONA` | `rowan-mi` | Fictional persona for the demo. Rowan also exists for NY, CA, and TX |
| `TEND_AGENT_KEY` | none | Sent as `X-Agent-Key` if the API asks for one |
| `TEND_API_TIMEOUT` | `30` | Seconds per API call |
| `TEND_ENV_FILE` | nearest `.env` above the repo | Which `.env` to load; empty string loads none |

## What it calls on the Tend API

| Step | Endpoint |
|---|---|
| Cited answer | `POST /api/agent/answer` if the API's OpenAPI lists it; else the agent quotes `GET /api/jurisdictions/{st}` itself |
| Check | `POST /api/agent/check` if listed; else `GET /api/agent/checklist/{st}` |
| Rule summaries, limits, program contact | `GET /api/jurisdictions/{st}` (cached 10 minutes) |
| Demo | `POST /api/scan`, `POST /api/bill/audit`, `POST /api/claim?scan_id=` |
| Payment | `POST /api/actions/propose` (`kind: pay_bill`), then `POST /api/actions/confirm` with the typed code |
| Linked claim | `POST /api/agent/redeem`, `GET /api/agent/claim` |

`/api/agent/answer` and `/api/agent/check` are found through `GET /api/openapi.json`, including their request field
names, so the agent adapts to the names the API chose. Today it sends `{"question", "st"}` and
`{"st", "incident_date", "forensic_exam", "police_report"}` (or the closest names the schema lists), and reads:

- answer: text from `answer` (or `text`, `summary`, `message`); citations from `citations` (or `rules`,
  `sources`) as `{rule_id, pinpoint, quote, fragment_url, summary}`; `known: false` (or `status: "unknown"`)
  becomes "I don't know". Optional `sentences: [{text, citations}]`.
- check: the same shape as `GET /api/agent/checklist/{st}` (`deadline`, `reporting`, `reporting_if_exam`,
  `exam_billing`, `covered`, `program`), plus optional `sentences`.

If the answer route errors, the agent answers from the verified rules instead. If the API is down, it says so and
nothing moves.

## Tests

```
cd agent && uv run pytest
```

152 tests, offline, about 2 seconds. The API is mocked with real captures for the fictional persona
(`tests/fixtures`), and the mock enforces the API's payment rules. They cover parsing (states, dates, exam and
report answers, codes), cited answers and "I don't know", every card against the uagents_core card schemas,
the full demo and payment flow (no confirm without the typed code, wrong, expired, locked, cancelled, stale
clicks, another sender), the story guard (the text never reaches the API or the session), OpenAPI discovery
of the answer and check routes, the uAgents handler (ack first, no text in logs), and a round trip between two
real uAgents over the Chat Protocol with Agentverse pointed at a closed local port.

## Files

```
agent/
  run.sh              start script
  AGENTVERSE.md       the Agentverse profile (badges, use cases, limits, keywords)
  tend_agent/
    agent.py          uAgents wiring: Chat Protocol, cards in and out, acknowledgements
    navigator.py      the conversation; no uAgents, so it is tested directly
    api.py            Tend API client and OpenAPI route discovery
    knowledge.py      cited answers from verified rules, with "I don't know"
    check.py          the Check, every line cited
    demo.py           the fictional claim and the payment views
    cards.py          ASI:One cards (detail, form, review), validated by uagents_core
    parse.py          states, dates, yes / no / not sure, codes, intents, the story guard
  scripts/rehearse.py the example chat above
  tests/
```

## Resources

- Fetch.ai Innovation Lab docs: https://innovationlab.fetch.ai/resources/docs/intro
- Agent Chat Protocol: https://innovationlab.fetch.ai/resources/docs/agent-communication/agent-chat-protocol
- ASI:One Interactive Cards: https://innovationlab.fetch.ai/resources/docs/interactive-cards/asi-interactive-cards
- Agentverse: https://agentverse.ai and ASI:One: https://asi1.ai
- Capital One Nessie (mock bank): http://api.nessieisreal.com
- The Tend API this agent calls: [../api/README.md](../api/README.md)

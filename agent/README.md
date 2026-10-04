# Tend Navigator (Fetch.ai agents)

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

| | |
|---|---|
| **Agent name** | Tend Navigator |
| **Agent address** | `agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts` (Agentverse mailbox, ASI Available) |
| **Helper agents** | Tend Law `agent1qg6ss7gv4przxvm2a0dvxrd83yrh2tq34szsh0jj3nufs7zkjkrjgyt2dwz`, Tend Bank and Packet `agent1q2lrzg2q8k0908g82arxcqdqn8jkxhr6jll79cvr9r4pfwpcwk0wjfvtwqs` |
| **Always on** | `hosted/navigator_hosted.py`, one file to paste into an Agentverse-hosted agent ([AGENTVERSE.md](AGENTVERSE.md)); its address is assigned when it is created |
| **Protocols** | Agent Chat Protocol 0.3.0 (`uagents==0.25.5`) with ASI:One Interactive Cards; typed uAgents messages between the three agents |

The Navigator's address comes from `AGENT_SEED` in the repo `.env`, and the helpers' seeds are derived from it, so all
three addresses stay the same on every run.

## What it does

Tend helps sexual assault survivors recover the crime victim compensation their state already promises. In one
ASI:One chat, the Navigator and its two helpers:

1. answer questions about any of the 51 programs with the law quoted, a pinpoint, and a link, and say "That's not in
   the rules I have" when no verified rule supports an answer;
2. run a Check (state, date, exam, police report) and return the deadline as a date, the police report rule, the
   exam billing protection, covered costs with limits, and the program's contact;
3. run a fictional claim end to end on Capital One's Nessie mock bank: scan the bank, count the costs under the
   state's law, hold the forensic exam line the law says was never billable, and write the letter to the billing
   office that quotes that law;
4. pay the rest of the hospital bill ($118.00 of the $443.00 bill; the $325.00 exam line stays held) only after the
   person types the 6-digit code the server issued, then read the bank record back and log it;
5. seal the packet into an encrypted link for an advocate. It opens in the Tend web app, in the advocate's browser,
   with Michigan's own application (safe fields only), the cited summary, what is still needed, and where to file.

Nothing in the agents decides law or money. They call the Tend API, which runs the law engine over the verified rules
and enforces the payment rules.

## Three agents, one conversation

```
ASI:One  <-- Agent Chat Protocol, cards -->  Tend Navigator   (talks with the person, keeps a short session,
                                                  |             keeps the person's words to itself)
                     typed requests and replies   |
                    +-----------------------------+------------------------------+
                    v                                                            v
               Tend Law                                               Tend Bank and Packet
   LawAnswerRequest, LawCheckRequest,                  DemoStartRequest, DemoCountRequest, PayProposeRequest,
   LawCoverageRequest -> LawReply                      PayConfirmRequest, PayStatusRequest, PacketShareRequest
   (cited answers and Checks)                          (scan, count, hold and letter, payment, sealed packet)
                    |                                                            |
                    +--------------------> Tend API (law engine, Nessie) <-------+
```

- Every request carries a request id. The Navigator waits a set time per attempt (15 s for Law, 25 s for Bank and
  Packet), then sends the same request again; the helper answers each id once and repeats that answer, so nothing
  runs twice. After the last attempt the person gets a plain message naming the helper that is not answering.
- Replies are accepted only from the helper that was asked, and helpers take requests only from the Navigator.
- If a payment confirmation times out, the Navigator never calls it failed: it says it cannot tell yet, and
  "check the payment" asks the Bank and Packet agent to read the payment's status from the API. The code works once.
- By default the three agents run in one process (`./run.sh`), talking through the uAgents dispatcher. With
  `TEND_SUBAGENT_MAILBOX=1` the helpers get their own Agentverse mailboxes too ([AGENTVERSE.md](AGENTVERSE.md)).

## What the agents never see

The agents never receive a survivor's own claim, bank data, or share links. They work on the public law corpus and a
fictional demo person only. The Navigator never asks for a name, what happened, where, or who, and says so in its
first message. If a message starts to describe what happened, the Navigator says it does not need that, does not pass
the message on, and answers from the topic alone ("counseling"); a described act also gets the National Sexual Assault
Hotline (800-656-4673).

- Message text is never stored or logged. Logs hold the kind of turn only, like `turn intent=answer replies=1 cards=0`,
  and the helpers log the kind of request only.
- Session state holds ids, amounts, a state code, and the topic of an open question, for at most two quiet hours. Check
  answers are dropped as soon as the Check runs. The confirm code is shown once and never kept.
- The share key is made by the Bank and Packet agent for one link, goes only into the link it hands back, and is not
  kept. Tend's server stores the ciphertext and an expiry (3 days).

## Example chat

Real output from `scripts/rehearse.py`, which runs the whole loop through the three agents and a stand-in for ASI:One
against a local Tend API (dry-run bank). The full transcript, with every card and every agent-to-agent call, is in
[REHEARSAL.md](REHEARSAL.md). Cuts are marked `[...]`.

> **You:** What is the deadline to apply in Ohio?
>
> **Tend Navigator:** Apply within three years of the crime. The statute points to ORC 2743.60 for exceptions [...]
> [ORC 2743.56(B); ORC 2743.60(A)(2)(d)](https://codes.ohio.gov/ohio-revised-code/section-2743.56#:~:text=All%20applications%20for%20an%20award,2743.60%20of%20the%20Revised%20Code.):
> "All applications for an award of reparations may be filed at any time within three years after the occurrence of
> the criminally injurious conduct [...]"
>
> _Behind the scenes: Navigator asked the Law agent (LawAnswerRequest)._

> **You:** Can I get money for my dog's vet bills in Michigan?
>
> **Tend Navigator:** That's not in the rules I have. I found no verified Michigan rule that answers it, so I won't
> guess. The program can answer it: **Michigan Crime Victim Compensation**, phone 877-251-7373 [...]

> **You:** check Michigan, June 14 2026, had an exam, not reported
>
> **Tend Navigator:** **You can likely apply in Michigan.** The program decides. [...] **Deadline:** apply by
> **June 14, 2031**. [...] **Police report:** your forensic exam counts in place of a police report. (MCL 18.355a(10))
> [...] **Exam bills:** you should not get a bill for a forensic exam. (MCL 18.355a(2)) [...]

> **You:** show me the demo claim
>
> **Tend Navigator:** **Demo: Rowan Hale, Michigan.** Fictional person and data on Capital One's Nessie mock bank.
> Tend read 191 bank records and found these possible costs since June 14, 2026: Counseling: 16 charges, $2,400.00
> [...] Hospital bill (itemized): 3 lines, $443.00. [...] _[Review card: Count these costs for the demo claim?]_

> **You** click **Yes, count them**.
>
> **Tend Navigator:** **Amount Rowan Hale can ask for: $4,008.00. The program decides.** [...] **Don't pay this
> line:** the forensic exam, $325.00 of the $443.00 hospital bill. The law says the survivor should not be billed
> for it. [...] "A health care provider shall not submit a bill for any portion of the costs of a sexual assault
> medical forensic examination to the victim [...]"
>
> **Tend Navigator:** **Letter to the billing office.** Copy it, fill in the [brackets], and send it. [...]
> The rest of the hospital bill is **$118.00**. Want to pay it from Checking ending 0011 (mock bank)? Say
> **pay the bill**. Nothing moves until you type a code.

> **You:** pay the bill
>
> **Tend Navigator:** Here is the payment to review. **Nothing moves until you type the code.** To pay $118.00, type
> **812660** here. [...] _[Review card: pay $118.00 to Riverbend General Hospital (fictional), Not paid: Forensic
> exam line, $325.00 (held by law), Confirm code, Continue / Cancel]_

> **You:** 812660
>
> **Tend Navigator:** **Done.** Paid $118.00 to Riverbend General Hospital. Dry run: Tend recorded it and read it
> back, but did not send it to the bank. Bank record: dryrun-15aa[...]. Audit log: aud_000008, in a hash chain with no
> names in it. The forensic exam line, $325.00, stays unpaid. [...]

> **You** click **Make a locked link for an advocate**.
>
> **Tend Navigator:** **Here is a locked link for an advocate.** It opens the claim in their browser, with the key in
> the link. Tend's server keeps only a copy it cannot read. [...] `https://youreowed.tech/share#<id>.<key>` [...]
> **Still needed** (from Michigan's rules) [...] **Where to file:** Email: MDHHS-MichiganCrimeVictim@Michigan.gov
> [...] **Amount Rowan Hale can ask for: $4,008.00. The program decides.**

After the chat the script fetches the ciphertext the way the advocate's browser does and opens it with the key from
the link: Michigan, 46 costs, $4,008.00, $325.00 held. The same kind of link was also opened in the Tend web app's
share page, which showed the read-only claim with Michigan's application and the cited summary to download.

## Run it

You need [uv](https://docs.astral.sh/uv/) and the Tend API.

```
# 1. The Tend API (from the repo root), or point TEND_API_URL at the deployed one
cd api && uv sync && uv run uvicorn tend_api.main:app --port 8000

# 2. The three agents (the Navigator on its Agentverse mailbox)
cd agent && ./run.sh
```

`run.sh` loads the repo `.env` (the file wins over the shell), creates `AGENT_SEED` in it the first time (never
printed), and starts the Navigator with the Law and Bank and Packet agents in one process. For the demo, point it at
the deployed API so share links open on any phone:

```
TEND_API_URL=https://youreowed.tech TEND_PUBLIC_URL=https://youreowed.tech ./run.sh
```

Run only one copy at a time: two processes on the same mailbox take each other's messages. Other modes:

```
./run.sh --address                     # the three addresses and the Inspector link, nothing started
./run.sh --chat                        # the same conversation in this terminal, no Agentverse
uv run python scripts/rehearse.py      # the whole loop through the three agents; writes REHEARSAL.md
uv run python scripts/build_hosted.py  # rebuild hosted/navigator_hosted.py after a code change
```

Always on: paste `hosted/navigator_hosted.py` into an Agentverse-hosted agent. The steps are in
[AGENTVERSE.md](AGENTVERSE.md). It calls `https://youreowed.tech`, set in two lines at the top of the file.

## Settings

All optional. The repo `.env` is loaded with override, then these are read.

| Variable | Default | What it does |
|---|---|---|
| `TEND_API_URL` | `http://127.0.0.1:8000` | The Tend API |
| `TEND_PUBLIC_URL` | the API's own address | The Tend web app, where share links open and the Check points |
| `AGENT_SEED` | created in `.env` on first run | Fixes the Navigator's address; the helpers' seeds come from it. Never printed or committed |
| `AGENT_PORT` | `8001` | The Navigator's port for the Inspector link (helpers use the next two) |
| `AGENT_HANDLE` | none | Agentverse handle, sent when you connect through the Inspector |
| `TEND_SUBAGENT_MAILBOX` | off | Give the Law and Bank and Packet agents Agentverse mailboxes too |
| `TEND_LAW_ADDRESS`, `TEND_BANK_ADDRESS` | the derived addresses | Point the Navigator at helpers running somewhere else |
| `TEND_LAW_TIMEOUT`, `TEND_BANK_TIMEOUT`, `TEND_AGENT_ATTEMPTS` | `15`, `25`, `2` | Seconds per attempt and attempts per helper request |
| `TEND_SHARE_HOURS` | `72` | How long a share link works (1 to 168) |
| `TEND_DEMO_PERSONA` | `rowan-mi` | Fictional persona for the demo. Rowan also exists for NY, CA, and TX |
| `TEND_AGENT_KEY` | none | Sent as `X-Agent-Key` if the API asks for one |
| `TEND_API_TIMEOUT` | `30` | Seconds per API call |
| `TEND_ENV_FILE` | nearest `.env` above the repo | Which `.env` to load; an empty string loads none |

## What the helpers call on the Tend API

| Step | Agent | Endpoint |
|---|---|---|
| Cited answer | Law | `POST /api/agent/answer`; if it is missing or fails, the agent quotes `GET /api/jurisdictions/{st}` itself |
| Check | Law | `POST /api/agent/check`, plus `GET /api/jurisdictions/{st}` for limits and summaries (cached 10 minutes) |
| Demo | Bank and Packet | `POST /api/scan`, `POST /api/bill/audit`, `POST /api/claim?scan_id=` (no merchant or bill text is sent) |
| Payment | Bank and Packet | `POST /api/actions/propose` (`kind: pay_bill`), `POST /api/actions/confirm` with the typed code, `GET /api/actions/{id}` for a status check |
| Share | Bank and Packet | `POST /api/shares` with ciphertext, IV, `alg`, `expires_hours`, `once` only |

The sealed packet is the web app's own format (`web/lib/share`): `{"format": "tend.share/1", "packet": ...}`,
AES-256-GCM with additional data `tend.share.v1`, a 12-byte IV, and the key in the link's fragment
(`/share#<id>.<key>`), which browsers never send to a server. The agent checks the packet the way the web viewer does
before sealing it.

## Limits

- Information, not legal advice. Rules can have exceptions, and the program makes every decision.
- The agents do not file claims, and they never handle a survivor's own data: the demo person and bank are fictional
  and the bank is a mock. `TEND_BANK=dry_run` on the API (its default) records and reads a payment back without
  sending it; `TEND_BANK=nessie` writes it to Nessie.
- The agent never types the code itself. In ASI:One's planner mode the planner relays what the person writes, so the
  review card and the message ask the person to type it. "Cancel" ends the payment in the chat; the API has no cancel
  endpoint, so the proposal stays valid on the server until its code expires (10 minutes).
- Questions are matched to topics by keywords when the answer route is missing (deadline, police report, exam bills,
  costs, limits, documents, how to apply, privacy, and more). Unusual wording can get "That's not in the rules I have".
- The hosted twin is one agent with both desks inside it (Agentverse hosts one agent per file), and it has its own
  address. Until `https://youreowed.tech/api` is live it answers that it cannot reach Tend's server.

## Tests

```
cd agent && uv run pytest
```

Offline, with the API mocked from real captures of this branch's API for the fictional persona and the public corpus
(`tests/fixtures`, refreshed by `scripts/capture_fixtures.py`); the mock enforces the API's payment rules. They cover
three real uAgents and an ASI:One stand-in completing the whole loop over the Chat Protocol, a helper that never
answers (plain fallback), a slow confirmation (never reported as failed, then "check the payment"), helpers refusing
requests from anyone but the Navigator, retries with the same request id, replies from the wrong address, every card
against the uagents_core schemas, the story guard, cited answers and "not in the rules I have", the payment flow
(no confirm without the typed code; wrong, expired, locked, cancelled, stale, someone else's chat), the sealed share
(opens with its key, not with another; never seals what the web viewer would refuse), the still-needed list and
filing routes against the web app's own output for all 51 jurisdictions (`scripts/web_parity.mts`), and the hosted
file (built from the current code, only allowed imports, the whole loop with every message in a fresh run).

## Files

```
agent/
  run.sh                start script
  PROFILE.md            the Navigator's public profile on Agentverse (published on every start)
  AGENTVERSE.md         the local team, the hosted twin (paste-in steps), and listing the helpers
  REHEARSAL.md          the latest transcript from scripts/rehearse.py
  hosted/
    navigator_hosted.py the Agentverse-hosted Navigator, built by scripts/build_hosted.py
  tend_agent/
    agents.py           the three uAgents and how they run together
    navigator.py        the conversation (no uAgents, so it is tested directly)
    chat.py             the Chat Protocol in and out, cards as plain metadata
    link.py             request and reply between agents: ids, timeouts, retries
    desks.py            the desks interface, idempotent requests, in-process desks
    law.py              the Law agent's work
    bank.py             the Bank and Packet agent's work
    messages.py         the typed messages between the agents
    api.py              the Tend API client
    share.py            sealing a packet in the web app's share format
    packet.py           still needed and where to file (a port of web/lib/packet)
    letter.py           the letter to the billing office
    knowledge.py, check.py, demo.py, cards.py, parse.py, fmt.py, states.py, sessions.py, settings.py, config.py
  scripts/              rehearse.py, build_hosted.py, capture_fixtures.py, web_parity.mts
  tests/
```

## Resources

- Fetch.ai Innovation Lab docs: https://innovationlab.fetch.ai/resources/docs/intro
- Agent Chat Protocol: https://innovationlab.fetch.ai/resources/docs/agent-communication/agent-chat-protocol
- ASI:One Interactive Cards: https://innovationlab.fetch.ai/resources/docs/interactive-cards/asi-interactive-cards
- Agentverse: https://agentverse.ai and ASI:One: https://asi1.ai
- Capital One Nessie (mock bank): https://api.nessieisreal.com
- The Tend API these agents call: [../api/README.md](../api/README.md)

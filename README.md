# Tend

Tend helps sexual assault survivors in all 50 states and DC get the crime victim compensation
their state already promises: it works like tax software for that one form of money, runs on the
survivor's device, and cites the state's own law for every dollar.

Live: https://youreowed.tech. Fictional demo: https://youreowed.tech/check?demo=rowan. Michigan's
public page: https://youreowed.tech/mi.
Built solo by Sanat Gupta for MHacks 2026. Tend is not legal advice. It shows what each state's
rules say, with the quote, and the program decides.

- Judges: [docs/JUDGES.md](docs/JUDGES.md) has a 60-second tour and a claim-by-claim checklist.
- Engineers: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/EVAL.md](docs/EVAL.md),
  [docs/SPEC.md](docs/SPEC.md), [docs/PRIVACY.md](docs/PRIVACY.md).

## What happens in the demo

Rowan Hale is a fictional person in Michigan with a fictional checking account on Capital One's
Nessie mock bank. Every name, merchant, and dollar below is made up.

1. **Check** (`/check?demo=rowan`). Four questions: state, the date it happened (June 14, 2026),
   forensic exam yes, police report no. No name, no story. The answer is computed on the device,
   each sentence with its citation: file by June 14, 2031 (MCL 18.355(2)); the exam counts in
   place of a police report (MCL 18.355a(10)); counseling up to $125 a session; a $45,000 total
   limit (MCL 18.361(1)).
2. **Gather.** "Use the demo bank account" adds Rowan's 190 fictional records (a copy ships with
   the app, so reading it sends nothing), and "Use a sample bill" adds the itemized Riverbend
   General Hospital bill. Tend reads both in the browser and groups the costs: 16 counseling
   sessions, moving and home security, then questions for what it inferred: "Was this ride to
   care?" for 14 rides on counseling days, and "Did you miss this work?" for three paychecks
   $176 short. Prescription copays and a new phone are shown as not counted, with the reason.
3. **The bill.** The $443.00 bill has three lines, and they add up. The $325.00 forensic exam
   line is held: MCL 18.355a(2) says "A health care provider shall not submit a bill for any
   portion of the costs of a sexual assault medical forensic examination to the victim". Tend
   says "Don't pay this line" and writes a letter to the billing office that quotes that law and
   MCL 18.355a(7), which names who pays instead.
4. **Pay the rest, on purpose.** "Pay $118.00 now from Checking 0011", then "Get a code". The
   server issues a 6-digit code; nothing moves until Rowan types it. The API refuses any amount
   that includes the held line, writes the withdrawal to Nessie (on youreowed.tech; a local API
   defaults to a dry run), reads it back, updates the bill to show only the held $325.00, and appends a row to a hash-chained
   audit log. The line under the header changes from "On this device. Nothing has left it." to
   "On this device, except what you chose to send: a payment."
5. **Packet.** Built on the device: Michigan's own application with safe fields only (name,
   signature, SSN, and anything about what happened stay blank), a cited summary PDF, a "still
   needed" list in Michigan's own words, letters, and where to file. It reads "Amount you can ask
   for: $3,848.00. The program decides. It comes from 38 costs the law covers." That is with the
   rules alone. Two lines the rules cannot sort (sheets, $96; a door chain and motion light, $64)
   go to Gemini Nano when Chrome has it, or to cloud AI only after a yes on a consent screen. With
   them counted, as in the agent run, the total is $4,008.00.
6. **Share.** "Make a share link" encrypts the packet in the browser (AES-256-GCM). The server
   stores only ciphertext and an expiry; the key is in the link after `#`, which browsers never
   send to a server. The advocate's browser opens a read-only view of the same claim.
7. **Track.** The garden: one plant per cost (38 here), growing from sprout (confirmed) to leaf
   (document attached), bud (filed), and bloom (paid). The held $325.00 never grows a plant. The
   deadline stays in view.
8. **Airplane mode.** After one visit the footer says "Saved on this device, so the steps work
   without internet." With the network off, Check, reading the statement and the bill, the
   packet, letters, and the vault still work, and a reload works. A payment or a share link says
   it needs the internet and sends nothing.

These steps were walked in Chromium on Oct 4, 2026 against a local API, and `web/e2e/run.sh` runs
the same path online and offline. The same claim also runs
through ASI:One with three Fetch.ai agents (agent/REHEARSAL.md is a full transcript).

## How it works

```
 bank statement (CSV, OFX, PDF)      +  itemized bill (PDF or photo)
             |                                     |
             v                                     v
 ON THE DEVICE -----------------------------------------------------------------------
   parse in the browser (pdf.js)          lines must add up to the bill total
             |                                     |
             v                                     v
   sort into costs: merchant and keyword rules first, then Gemini Nano (Chrome Prompt API),
   fixed labels only; the survivor says yes or no to each line
             |
             v
   claim (integer cents) ---> law VM in WebAssembly (tend.wasm) <--- ST.tlaw (compiled law)
                                          |                               ^
                                          v                               |
   cited decisions: every line = status + amount + rule ids + verbatim quote + source sha256
                                          |                               |
                                          v                               |
   packet: state form (allowlisted fields), cited summary, still needed, letters
 ---------------------------------------------------------------------------|----------
 BUILD TIME                                                                 |
   official source --fetch, sha256--> verify.py (quote must be verbatim) --> rules/verified
       --normalize.py--> law IR (rules/ir) --tendc (C++20 compiler)--> bytecode .tlaw
```

- **The law is data, compiled.** `rules/` holds 2,578 rules for 51 jurisdictions from 824 saved
  official sources. A rule exists only if its quote is a verbatim substring of a saved source
  whose sha256 still matches (`rules/tools/verify.py`).
- **A real compiler and VM.** `tendc` (C++20) compiles each state's IR into a `.tlaw` image: a
  64-byte header, sections, two bytecode programs, and a sha256 trailer. The loader checks every
  byte and runs a bytecode verifier before anything executes. The same C++ is built to
  WebAssembly (183 KB) and runs in the browser.
- **Checked three ways.** A Python reference engine and a plain C++ oracle implement the same
  spec; random claims and random laws must produce byte-identical results.
- **The model proposes; code decides.** Gemini only suggests a cost's label. The engine decides
  eligibility, caps, holds, and totals from verified rules.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Real, fictional, mocked

| Part | Status |
|---|---|
| The law corpus | Real. 51 jurisdictions' statutes, regulations, and program pages, saved with sha256; quotes verified verbatim |
| Rowan Hale, Riverbend General Hospital, every merchant and dollar | Fictional, made for the demo (`seed/`); every snapshot says so |
| The bank | Capital One's Nessie, a mock bank API. On youreowed.tech a confirmed payment is a real Nessie write, in mock money. Tend computes balances from records, because Nessie's balance field never changes |
| Gemini Nano | Runs in Chrome on the device through the Prompt API, when the browser has it. Without it, the rules alone sort costs |
| Cloud Gemini | Only after a yes on a consent screen that names what would leave (`web/components/flow/CloudConsent.tsx`); the API also refuses without `consent: true` (403). Sorting sends merchant, category, and description only, never amounts or record ids; a bill photo is sent as the file |
| Filing | Tend files nothing. The survivor sends the packet |

## Numbers

Each number comes from the command next to it, reproduced Oct 4, 2026 on Linux from `main` at
`f720ae3` (tend 1.3.0) unless marked. [docs/EVAL.md](docs/EVAL.md) has the machine and the full table.

| Number | Command |
|---|---|
| 51 jurisdictions, 2,578 rules, 824 sources, every quote verbatim (51 PASS) | `python3 rules/tools/verify.py all` |
| 1,327 decision rules, 1,189 information rules, 62 set aside with a reason | `python3 -c "import json,glob; d=[json.load(open(f)) for f in glob.glob('rules/ir/*.json')]; r=[x['kind'] for j in d for x in j['rules']]; print(len(r)-r.count('info'), r.count('info'), sum(len(j['skipped']) for j in d))"` |
| 70 C++ test cases, 27,403 assertions, all pass; all 51 shipped law images byte-identical to a fresh build | `make -C engine && make -C engine test` |
| 121,000 claims, 0 mismatches between the C++ and Python engines | `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` |
| 106,000 of 106,000 claims byte-identical, WebAssembly vs native | `make -C engine wasm-parity` |
| 2,517,704 fuzz executions on tend 1.2 and 580,048 on 1.3 under ASan and UBSan, 0 crashes (recorded, macOS) | `make -C engine fuzz FUZZ_SECONDS=420` |
| 14.1M claim lines per second in the VM, single thread (recorded on an M4 Max, tend 1.2) | `cd engine && ./build/tendc ../rules/ir/MI.json -o build/laws/MI.tlaw && ./build/tendvm bench --law build/laws/MI.tlaw --items 1000000 --runs 5` |
| 586 reference engine tests | `cd refengine && uv run pytest` |
| 424 API tests pass, 22 skipped without Neon | `cd api && uv run pytest` |
| 265 agent tests | `cd agent && uv run pytest` |
| 1,234 web unit and screen tests in 42 files | `cd web && npx vitest run` |
| 3 end-to-end tests in Chromium: the demo path, the same path offline, and no request carrying transaction text, a bill line, or the share key | `web/e2e/run.sh` |
| Offline: after a 2.2 s first visit, a reload with no network in 0.34 s and the packet built in 0.17 s | `web/e2e/run.sh` (prints step timings) |

## Privacy in five lines

1. The claim, the statement, the bills, and the answers stay on the device. There is no account.
2. Saved progress is AES-256-GCM in IndexedDB, opened with Touch ID (passkey PRF) or a passphrase.
3. Data leaves only on a tap: a confirmed payment, a sealed share, cloud AI after a yes, demo bank reads.
4. The server holds the public law corpus, share ciphertext, and a hash-chained payment log.
5. No field anywhere stores what happened, where, or who. Quick exit: corner button or Esc twice.

The full contract and threat model: [docs/PRIVACY.md](docs/PRIVACY.md).

## Sponsor technology

| Sponsor | How Tend uses it | Where |
|---|---|---|
| Capital One Nessie | The fictional bank: four Rowan personas seeded with 190 records each, the $443.00 bill, the $118.00 payment written as a withdrawal and read back, the bill updated to show the held $325.00, a demo payout from the program, and a panel that recomputes balances from Nessie's records. Recorded Nessie answers replay in tests with no network | `seed/seeder.py`, `seed/reset_demo.py`, `seed/NESSIE_NOTES.md`, `api/tend_api/nessie.py`, `api/tend_api/actions.py`, `api/tend_api/payout.py`, `web/components/bank/`, `seed/cassettes/` |
| Fetch.ai (uAgents, Agentverse, ASI:One) | Three uAgents on the Agent Chat Protocol with ASI:One cards: Tend Navigator `agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts` (Agentverse mailbox), Tend Law `agent1qg6ss7gv4przxvm2a0dvxrd83yrh2tq34szsh0jj3nufs7zkjkrjgyt2dwz`, Tend Bank and Packet `agent1q2lrzg2q8k0908g82arxcqdqn8jkxhr6jll79cvr9r4pfwpcwk0wjfvtwqs`. Cited answers, a Check, the demo claim, a payment confirmed by a typed code, and a sealed packet. A one-file hosted twin runs on Agentverse | `agent/tend_agent/`, `agent/hosted/navigator_hosted.py`, `agent/README.md`, `agent/AGENTVERSE.md` |
| Neon | Production Postgres for the corpus, shares, and the audit log. Each version of the law corpus is its own Neon branch (`law-<date>-<sha>`); claims name the version they were checked against, and `/api/law/diff` compares two branches rule by rule. Least-privilege roles; quote search on a GIN index | `scripts/neon/law_versions.py`, `scripts/neon/roles.py`, `api/tend_api/db/`, `docs/NEON.md` |
| Google Gemini | On the device: Gemini Nano through Chrome's Prompt API sorts costs the rules miss and reads bill photos, with the output limited to fixed labels. In the cloud, only with consent: `gemini-3.8-flash` with `gemini-3.5-flash-lite` as fallback, 10 s limit, nothing stored | `web/lib/local/deviceai.ts`, `web/lib/local/classify.ts`, `web/lib/local/bill.ts`, `web/lib/local/cloud.ts`, `web/components/flow/CloudConsent.tsx`, `api/tend_api/ai.py`, `api/tend_api/classify.py` |
| .tech domain | `youreowed.tech`: the app, the API behind `/api`, public state pages (`/mi`), and share cards that read "youreowed.tech/mi" | `docs/DEPLOY.md`, `web/app/[st]/` |
| Figma | The design system: color and space variables named like the CSS tokens, text styles, and the flow's components (citation, ledger line, bill line, confirm code, sheets), built by scripts through the Figma Plugin API | `design/figma/`, `web/DESIGN.md`, `web/app/globals.css` |

## Run it

You need a C++20 compiler and `make`, [uv](https://docs.astral.sh/uv/), and Node 22 or newer. The
built WebAssembly engine and law images are committed, so Emscripten is optional.

```sh
git clone https://github.com/thesanatt/tend.git && cd tend
make -C engine            # native engine (optional; the API falls back to the reference engine)
scripts/dev.sh            # API (local SQLite, dry-run bank) + web (next dev) + agent; prints the URLs
scripts/dev.sh --prod     # the production build, the only mode with the offline worker
scripts/dev.sh --no-agent # without the Fetch.ai agent
```

Open http://localhost:3000/check?demo=rowan. No key is needed: the database is a local SQLite file
loaded with the corpus on first start, and the bank is a dry run that records a payment and reads
it back. `TEND_DB=neon` and `TEND_BANK=nessie` use the real services from the repo `.env`.
To try airplane mode, run `--prod`, open the demo once, wait for the footer to say "Saved on this
device", then turn the network off.

## Test it

```sh
make -C engine && make -C engine test
(cd refengine && uv run pytest)
uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000
(cd seed && uv run pytest)
(cd api && uv run pytest)
(cd agent && uv run pytest)
(cd web && npm ci && npx tsc --noEmit && npx vitest run && npx next build)
web/e2e/run.sh            # Playwright in Chromium: demo path, offline path, what each request carried
```

Build the engine first; without `engine/build`, the refengine and API tests that compare against
the C++ engine are skipped. Tests that need a real service are off unless asked for:
`TEND_LIVE=1` in `seed/` (Nessie key) and `TEND_NEON_TEST=1` in `api/` (Neon URL).

## Limits

- Not legal advice. Tend reads the rules it verified; a program can apply exceptions it never
  saw. Every total says "The program decides."
- Only Michigan's application is pre-filled. Other states get the program's blank form, or a note
  that Tend found none.
- Deadlines that can count from discovery (12 jurisdictions) are dated from the incident and
  flagged, so a "late" there reads "The usual deadline was ..." (SPEC v1.3). Periods that start at
  other later events Tend does not ask about (DNA or kit results in KS, MD, and OK; an 18th or 21st
  birthday) are not flagged; their rules carry the words.
- The corpus was built during the hackathon, and laws change. Each law version is a Neon branch,
  but nothing re-fetches sources on a schedule yet.
- The classifier was measured only on fictional data. There is no committed accuracy number for
  Gemini Nano. Without it, the rules alone sort costs, more lines wait for a yes or no, and cloud
  AI is offered behind a consent screen.
- The deployed API has no sign-in. A payment proposal returns its own code, so anyone who finds
  the site can move mock money in the demo accounts (docs/DEPLOY.md says how to contain it).
- The three engines were written from one spec by one author, so a shared misreading would not
  show up as a mismatch.

## Repository

| Folder | What it is |
|---|---|
| `engine/` | C++20 law compiler and bytecode VM, also built to WebAssembly |
| `refengine/` | Python reference engine and the differential test |
| `rules/` | the verified law corpus and the tools that build it |
| `seed/` | fictional demo data on Capital One's Nessie mock bank |
| `api/` | FastAPI service |
| `web/` | Next.js app |
| `agent/` | Fetch.ai uAgents for ASI:One |
| `scripts/` | Neon law branches and roles, Vercel settings |
| `design/figma/` | Figma generator scripts |
| `docs/` | spec, architecture, privacy, UX, evaluation, deploy, Neon, judges' guide, Devpost draft |

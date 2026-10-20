# Tend

Tend is a web app that helps sexual assault survivors in all 50 states and DC apply for crime victim
compensation: it runs each state's verified law on the survivor's own device and quotes that law,
word for word, behind every dollar.

Why it matters ([docs/SOURCES.md](docs/SOURCES.md) says where each number comes from):

- **51 programs.** Every state and DC runs a crime victim compensation program. It can pay a
  survivor back for costs like counseling, medical bills, and lost pay. Tend saved each program's
  own pages or documents, each with its sha256 ([rules/sources](rules/sources)).
- **96 percent.** In 2022, 96 percent of violent crime victims got no victim compensation
  ([Alliance for Safety and Justice survey](https://justsafe.org/news/beyond-headlines-decade-listening-crime-survivors/)),
  and many didn't know it existed
  ([ABC News, June 22, 2024](https://abcnews.com/Health/super-bowl-parade-shooting-survivors-await-promised-donations/story?id=111316701)).

Try it:

- The live site: https://youreowed.tech
- The fictional demo, Rowan Hale in Michigan: https://youreowed.tech/check?demo=rowan
- A state's page, such as Michigan's: https://youreowed.tech/mi
- The 2-minute tour, the same demo with a note at each step: https://youreowed.tech/check?demo=rowan&tour=1

<!-- TODO(Sanat): demo video. Add the unlisted YouTube link to the list above once it is recorded (brief P0.3). -->

Built by Sanat Gupta in 24 hours at MHacks 2026. 1st place, Capital One Best Use of Nessie. The 24
hours are the hackathon build, judged at commit [5d1f7bd](https://github.com/thesanatt/tend/tree/5d1f7bd).
Work continued after the event: the document preview and the 2-minute tour on October 5, 2026, and
fixes and additions in mid-October.

<!-- TODO(Sanat): how Tend was built, in your own words, before this goes public. -->

Tend is not legal advice. It shows what each state's own rules say, with the quote, and the program
decides.

## What's real and what's demo

| Part | Real or demo |
|---|---|
| The law | Real. 2,578 rules for all 51 jurisdictions, each quoting one of 824 saved sources word for word: statutes, regulations, and program pages and documents, each saved with its sha256. 120 of the sources are copies of state law from Justia or Cornell's Legal Information Institute, which reprint the law but are not the official code. A quote check proves the words are in the source, not that Tend reads them right <!-- measured: 2026-10-19 --> |
| Rowan Hale, Riverbend General Hospital, every merchant and dollar | Fictional, made for the demo (`seed/`). Every snapshot says so |
| The bank | Capital One's Nessie, a mock bank for developers. On youreowed.tech a confirmed payment is a real write to Nessie, in mock money. No real money moves |
| Users | None known. Tend is a prototype, and the site runs no analytics, so it does not count visitors |
| Filing | Tend files nothing. It builds a packet; the survivor sends it to the program, and the program decides |

## How it works

1. **The law is data.** Each rule quotes a saved source. `rules/tools/verify.py` keeps a rule only
   if its quote appears word for word in that source and the source's sha256 still matches. The
   numbers in eight of its detail fields (amounts, years, months, weeks, days, counts) must appear
   in the quote, and so must every number in its summary other than 0 and 1.
2. **Compiled ahead of time.** A C++20 compiler, `tendc`, turns each state's rules into a law image
   of 24 to 52 KB: bytecode plus the quotes it cites. The loader, a bytecode verifier, and a small VM
   are built to WebAssembly (183 KB) and run that image in the browser. The loader checks every
   byte before anything runs.
3. **Every dollar carries its proof.** Each line of the answer names its rule, the quote, and the
   source's sha256. Money is integer cents throughout.
4. **The model proposes; code decides.** Merchant and keyword rules sort costs first. Gemini Nano,
   on the device when Chrome has it, may suggest a label from a fixed list for what is left, and
   the survivor says yes or no to each line. Only the engine decides what counts, caps, held bills,
   and totals.
5. **A second engine checks the first.** A Python reference engine, written from the same spec,
   must return the same bytes as the C++ engine. The live server has no native build, so when the
   law is checked there (before a payment, or after a yes when a browser cannot run the
   WebAssembly), the Python engine answers.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Correctness, and how it was measured

Each count comes from the command next to it, run on October 4, 2026 on Linux from `main` at
`f720ae3` (tend 1.3.0), unless the row says otherwise. [docs/EVAL.md](docs/EVAL.md) has the machine,
the other suites, and what these numbers do not show.

| What was checked | Result | Command |
|---|---|---|
| Each quote is word for word in its saved source, and each source's sha256 matches | 51 of 51 jurisdictions pass: 2,578 rules, 824 sources <!-- measured: 2026-10-04 --> | `python3 rules/tools/verify.py all` |
| What the engine does with the rules | 1,327 decision rules, 1,189 information rules, 62 set aside with a reason <!-- measured: 2026-10-04 --> | `python3 -c "import json,glob; d=[json.load(open(f)) for f in glob.glob('rules/ir/*.json')]; r=[x['kind'] for j in d for x in j['rules']]; print(len(r)-r.count('info'), r.count('info'), sum(len(j['skipped']) for j in d))"` |
| The C++ engine against hand-computed answers, a plain C++ oracle, and broken images | 70 test cases, 27,403 assertions, all pass; all 51 shipped law images byte-identical to a fresh build <!-- measured: 2026-10-04 --> | `make -C engine && make -C engine test` |
| The C++ engine against the Python reference engine | 121,000 generated claims, 0 mismatches. The 119,600 valid ones come back byte for byte the same; both refuse the other 1,400, broken on purpose, with the same error code <!-- measured: 2026-10-04 --> | `make -C engine`, then `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` |
| The WebAssembly build against the native build | 106,000 of 106,000 claims byte-identical <!-- measured: 2026-10-04 --> | `make -C engine wasm-parity` |
| Fuzzing under AddressSanitizer and UBSan | 2,517,704 executions on tend 1.2 and 580,048 on 1.3, 0 crashes (recorded on an Apple M4 Max laptop) <!-- measured: 2026-10-03 --> | `make -C engine fuzz FUZZ_SECONDS=420` |

Engines that agree read the spec the same way. That does not prove the spec reads the law
correctly; the verified quotes and hand-computed claims are the check on that. The generated claims
are synthetic, aimed at each law's own numbers.

## Privacy

There is no account, and Tend never asks for a name or what happened. No field anywhere stores
what happened, where, or who did it. Statements and bills are read in the browser, the law runs
there, and saved progress stays there, encrypted (AES-256-GCM in IndexedDB, opened with a passkey
such as Touch ID or with a passcode).

Exit this page, at the top of every screen (or Esc twice), blanks the screen, locks saved progress,
and replaces the page with a neutral one. It replaces only the current history entry, so Back can
still reach an earlier Tend page.

The survivor's data leaves the device only when they tap to send it, and the line under the header
says what went:

- A payment: tapping Get a code sends the amount, the account, and the payee to Tend's server,
  and nothing moves until the 6-digit code is typed. In the demo the payment goes to Nessie, in
  mock money.
- A share link: the packet is encrypted in the browser, and the key stays in the link after `#`,
  which browsers do not send to servers, so Tend's server holds only ciphertext.
- Cloud AI, after a yes on a consent screen: rows Tend could not sort, or a bill it could not
  read, go through Tend's server to Google's Gemini. Tend uses Gemini's free tier, whose terms let
  Google keep what is sent, use it to improve its products, and have people review it. Tend's
  server keeps no copy. In this prototype, don't send a real bill to cloud AI.
- A check on Tend's server, after a yes, offered only when the browser cannot run the law engine:
  it sends the state, the date, the answers, and each cost not said no to, with its description
  from the statement or bill.
- The demo bank in Track, with the fictional account only: its records and a demo payout.

The host sees each visit even without a send. Tend runs no analytics and no third-party scripts,
but Vercel, which hosts it, keeps request logs Tend cannot turn off: for every page, law file, and
API call, the path, the status, and the visitor's IP address and browser. Picking a state loads
that state's public law files, so the host can tell which state was picked. Tend also does not hide
that it was used: the browser's history, the offline copy of its pages, and a passkey named Tend, if
one was made, stay on the device.

The full contract and threat model: [docs/PRIVACY.md](docs/PRIVACY.md).

## License and contact

License: not chosen yet.

<!-- TODO(Sanat): choose a license and add a LICENSE file (brief P0.8 suggests MIT or Apache-2.0 for the code and
CC BY 4.0 for the rules dataset). dataset/README.md has the same TODO. -->

<!-- TODO(Sanat): contact email not chosen yet (brief P1.9). web/components/public/corrections.ts has a matching
empty CORRECTIONS_EMAIL. -->

Found an error in the law data? [Open an issue](https://github.com/thesanatt/tend/issues/new?template=law-error.yml)
with the state, the page, and what the source says. Issues are public, so leave out your name and
anything about your own case.

---

The rest of this page is for people running or checking the code.

## How the pieces fit

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
   saved source --fetch, sha256--> verify.py (quote must be verbatim) --> rules/verified
       --normalize.py--> law IR (rules/ir) --tendc (C++20 compiler)--> bytecode .tlaw
```

The compiler runs only at build time. The browser gets each state's compiled image and runs it in
the WebAssembly VM. When the law is checked on the server, the live site runs the Python reference
engine on the same IR; a local API after `make -C engine` runs the native C++ build.

## Run it

You need a C++20 compiler and `make`, [uv](https://docs.astral.sh/uv/), and Node 22 or newer. The
built WebAssembly engine and law images are committed, so Emscripten is optional.

```sh
git clone https://github.com/thesanatt/tend.git && cd tend
make -C engine            # native engine (optional; the API falls back to the reference engine)
scripts/dev.sh            # API (local SQLite, dry-run bank) + web (next dev); prints the URLs
scripts/dev.sh --prod     # the production build, the only mode with the offline worker
```

Open http://localhost:3000/check?demo=rowan. No key is needed: the database is a local SQLite file
loaded with the corpus on first start, and the bank is a dry run that records a payment and reads
it back. `TEND_DB=neon` and `TEND_BANK=nessie` use the real services, with keys from a `.env` file
that is not in the repository. To try airplane mode, run `--prod`, open the demo once, wait for the
footer to say "Saved on this device", then turn the network off.

## Test it

```sh
make -C engine && make -C engine test
(cd refengine && uv run pytest)
uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000
(cd seed && uv run pytest)
(cd api && uv run pytest)
(cd web && npm ci && npx tsc --noEmit && npx vitest run && npm run lint && npx next build)
web/e2e/run.sh            # Playwright in Chromium: demo path, tour, offline path, what each request carried, layout
```

Build the engine first; without `engine/build`, the refengine and API tests that compare against
the C++ engine are skipped. Tests that need a real service are off unless asked for:
`TEND_LIVE=1` in `seed/` (Nessie key) and `TEND_NEON_TEST=1` in `api/` (Neon URL).

The suite counts and timings below are from the same October 4 run as the table above, unless the
row says otherwise.

| Number | Command |
|---|---|
| 586 reference engine tests <!-- measured: 2026-10-04 --> | `cd refengine && uv run pytest` |
| 424 API tests pass, 22 skipped without Neon <!-- measured: 2026-10-04 --> | `cd api && uv run pytest` |
| 1,234 web unit and screen tests in 42 files <!-- measured: 2026-10-04 --> | `cd web && npx vitest run` |
| 3 end-to-end tests in Chromium: the demo path, the same path offline, and no request carrying transaction text, a bill line, or the share key <!-- measured: 2026-10-04 --> | `web/e2e/run.sh` |
| Offline: after a 2.2 s first visit, a reload with no network in 0.34 s and the packet built in 0.17 s <!-- measured: 2026-10-04 --> | `web/e2e/run.sh` (prints step timings) |
| 14.1M claim lines per second in the VM, single thread (recorded on an Apple M4 Max laptop, tend 1.2) <!-- measured: 2026-10-03 --> | `cd engine && ./build/tendc ../rules/ir/MI.json -o build/laws/MI.tlaw && ./build/tendvm bench --law build/laws/MI.tlaw --items 1000000 --runs 5` |

## Limits

- Not legal advice. Tend reads the rules it verified; a program can apply exceptions it never
  saw. Every total says "The program decides." No test checks that a program will accept a packet.
- Only Michigan's application is pre-filled. Other states get the program's blank form, or a note
  that Tend found none.
- Deadlines that can count from discovery (12 jurisdictions) are dated from the incident and
  flagged, so a "late" there reads "The usual deadline was ..." (SPEC v1.3). Periods that start at
  other later events Tend does not ask about (DNA or kit results in KS, MD, and OK; an 18th or 21st
  birthday) are not flagged; their rules carry the words.
- The sources were saved on October 3, 2026, and laws change. Each version of the corpus can be
  published as a Neon branch, but nothing re-fetches sources on a schedule. 120 of the 824 are
  Justia or Cornell copies of state law rather than the state's own text. <!-- measured: 2026-10-19 -->
- The classifier was measured only on fictional data. There is no committed accuracy number for
  Gemini Nano. Without it, the rules alone sort costs, more lines wait for a yes or no, and cloud
  AI is offered behind a consent screen.
- Cloud AI runs on Gemini's free tier, under Google's terms for it (see Privacy above). The consent
  screen says so before the yes.
- The live server answers with the Python reference engine, because the native library is not
  built on Vercel. Its results match the C++ engine's in the difftest above.
- The demo bank is one shared fictional account, and Tend never pays the same bill lines twice, so
  after one visitor pays the $118.00, the next one hears "already paid". Once the API with
  `api/tend_api/demo_reset.py` is deployed, the account puts itself back when a new payment finds
  the earlier ones all more than 20 minutes old (docs/DEPLOY.md, "Limits worth knowing").
- The deployed API has no sign-in. A payment proposal returns its own code, so anyone who finds
  the site can move mock money in the demo accounts (docs/DEPLOY.md says how to contain it).
- No chat agents. The agents from the hackathon build are retired; the code as judged is commit
  5d1f7bd.
- The three engines were written from one spec, so a shared misreading would not show up as a
  mismatch. <!-- TODO(Sanat): who wrote the engines is yours to state; this line no longer says. -->

## Repository

| Folder | What it is |
|---|---|
| `engine/` | C++20 law compiler (`tendc`) and bytecode VM; the loader, verifier, and VM are also built to WebAssembly |
| `refengine/` | Python reference engine and the differential test |
| `rules/` | the verified law corpus and the tools that build it |
| `dataset/` | the verified rules as an open dataset (v1.0, JSON and CSV), with a data dictionary and methodology |
| `seed/` | fictional demo data on Capital One's Nessie mock bank |
| `api/` | FastAPI service |
| `web/` | Next.js app |
| `scripts/` | local dev, Neon law branches and roles, Vercel settings |
| `design/figma/` | Figma generator scripts |
| `docs/` | spec, architecture, privacy, UX, evaluation, sources, deploy, Neon, judges' guide, Devpost draft |

For judges and anyone checking claims: [docs/JUDGES.md](docs/JUDGES.md) has a 60-second tour, the
demo step by step, the hackathon tools, and a claim-by-claim checklist. Also
[docs/SPEC.md](docs/SPEC.md), [docs/EVAL.md](docs/EVAL.md), and [docs/SOURCES.md](docs/SOURCES.md).

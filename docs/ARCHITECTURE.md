# Tend: architecture

How the parts fit, where each one runs, and what crosses each boundary. docs/SPEC.md (v1.3) is the
contract, docs/PRIVACY.md is the privacy contract, and engine/FORMAT.md is the normative engine
spec. This page points into them instead of restating them.

## Components

```
                         THE SURVIVOR'S DEVICE (browser)                       |  SERVER (Vercel + Neon)
                                                                               |
 bank statement (CSV, OFX, PDF)  -> web/lib/local/statement.ts, csv.ts,        |
 or demo bank (bundled copy)        ofx.ts, statement-pdf.ts (pdf.js)          |
                                        |                                      |
                                        v                                      |
 sorting into costs              -> web/lib/local/rules.ts (merchant and       |
                                    keyword rules), then classify.ts with      |
                                    Gemini Nano (deviceai.ts), fixed labels    |
                                        |                                      |
 bill photo or PDF               -> web/lib/local/bill.ts: lines must add up   |
                                        |                                      |
                                        v                                      |
 law engine                      -> web/lib/engine (tend.wasm + ST.tlaw)  <----|---- public: law images,
                                        |                                      |     verified rules, IR
                                        v                                      |     (web/public, Neon)
 packet                          -> web/lib/packet: state form (pdf-lib,       |
                                    allowlisted fields), cited summary,        |
                                    still needed, letters                      |
                                        |                                      |
 saved progress                  -> web/lib/vault: AES-256-GCM in IndexedDB    |
                                                                               |
 ------ only when the survivor acts ------------------------------------------+----------------------
 picking a state                 -> GET /data/law/ST.json, /data/ir/ST.json, ->|  public law files; their names
                                    /engine/laws/ST.tlaw                       |  show which state
 a payment, set up and confirmed -> POST /api/actions/propose, /confirm ------>|  pending row, Nessie write, audit log
 a packet they share             -> sealed in the browser, POST /api/shares -->|  ciphertext + expiry
 cloud AI, only after a yes      -> POST /api/ai/classify, /api/ai/bill ------>|  Gemini (Google's terms); no copy kept
 a law check, only after a yes   -> POST /api/claim, no item descriptions ---->|  Python reference engine; nothing kept
 demo bank records (Track only)  -> GET /api/bank/{persona}/... -------------->|  Nessie relay; nothing kept
```

Once loaded, the left side keeps working with the network off (see "Offline mode" below).

| Folder | What it is | Runs where |
|---|---|---|
| `rules/` | verified corpus: 51 jurisdiction files, saved sources, the IR, and the tools that build them | build time |
| `engine/` | C++20 compiler (`tendc`), VM (`libtend`), disassembler (`tdis`), CLI (`tendvm`), fuzzer, WASM build | device (WASM, the VM and loader only), CLI and a local API (native); the deployed API has no native build |
| `refengine/` | Python reference engine and the differential test | tests; API fallback |
| `web/` | Next.js app: the survivor flow, public state pages, "How Tend decides" | device |
| `api/` | FastAPI: public corpus, payments, sealed shares, bank relay, opt-in cloud AI | Vercel function |
| `seed/` | the fictional Nessie world: four Rowan personas, snapshots, the itemized bill, recorded Nessie answers | build and rehearsal |
| `scripts/` | Neon law branches and roles (`scripts/neon`), Vercel settings (`scripts/vercel`) | operator |
| `design/figma/` | generator scripts that build the Figma file through the Plugin API | operator |

The three chat agents from the MHacks build are retired. The code as judged is commit 5d1f7bd.

<!-- TODO(Sanat): once the v1.0-mhacks tag exists on 5d1f7bd (git tag v1.0-mhacks 5d1f7bd, then push it), name it here. -->

## Trust boundaries

**The device holds the survivor's data.** Statements, bills, answers, the claim, and the packet
exist only in the browser. They are kept in memory, or in the vault if the survivor saves:
AES-256-GCM in IndexedDB, with the key from a passkey (WebAuthn PRF) or a passphrase
(PBKDF2-SHA-256, 600,000 iterations, `web/lib/vault/crypto.ts:5`). The vault locks after 5 minutes
without input, on Exit this page, and when the tab is closed, reloaded, or leaves the site. Files
downloaded from the packet are ordinary files, outside the vault.

**The server holds three things** (`api/README.md`, `docs/NEON.md`):

1. The public law corpus: 51 jurisdictions, 824 sources (metadata and sha256, no page text),
   the rules (2,578 in production on Oct 19, 2026; rules/verified now holds 2,728, which reach the
   server with the next law load), the sha256 of each compiled law image (102 in production on
   Oct 19, 2026: a tend 1.3.0 and a tend 1.2.0 image for each jurisdiction), and the index of law
   versions.
2. Ciphertext of shared packets with an expiry (`sealed_shares`). The key is in the link's
   fragment (`/share#<id>.<key>`), which browsers do not send to servers.
3. An append-only, hash-chained audit log of confirmed payments (`audit_log`). Each row's hash
   is the sha256 of its canonical JSON body, and the body names the previous row's hash. On
   Postgres, triggers refuse updates, deletes, truncation, and any insert that does not extend
   the head (`api/tend_api/db/migrations/postgres/0003_payments.sql`).

A payment waiting for its code (`pending_actions`) is the only other state. The code works once,
for 10 minutes, and is stored only as an HMAC. The payee is cleared when the payment finishes,
locks, or a confirm or a sweep finds its code expired. The row stays so that a confirm sent again
gets the first answer, and a sweep deletes it once its code has been expired for a day. Sweeps run
when a new payment or share arrives, and within about a minute after something comes due while an
API instance is running, so on a quiet server a row can stay longer. Until then it keeps the
amount, the demo account id, the bill id and lines, and, for a payment that went through, the
bank's withdrawal id and the bill's totals.

**What crosses the boundary**, each only on a tap (docs/PRIVACY.md lists them): a payment, first
set up (amount, account, payee, at Get a code) and then confirmed; a sealed share (ciphertext); cloud
AI (only after a yes; the API refuses a request without `consent: true`, with 403 for false and
422 when it is missing); a check on Tend's server (only after a yes, when the browser cannot run
the engine: `POST /api/claim` with the state, the dates, the answers, and each cost's date, amount,
kind, and record id, never its words; `web/lib/api.ts` `serverClaimBody`); and, in Track with the
demo bank only, the relay (holds the Nessie key, keeps no log lines for those paths). Picking a
state also fetches files named for it, so the server can tell which state was picked. The privacy
line under the header (`web/components/flow/PrivacyLine.tsx`) says "On this device. Nothing has
left it since this page opened." until a state is picked, then "On this device. Only the state you
picked went to Tend's server, to get its law." until something is sent. It is built from
`web/lib/netlog.ts`, which wraps the page's `fetch` and reports each request that carries
something off the device, including any the flow did not expect and any that failed online with
no answer, which may have reached the server first.

Cloud AI has its own consent screen (`web/components/flow/CloudConsent.tsx`). It names what would
leave, starts at no, and saying no keeps the built-in rules working. For sorting: the kind of
transaction, the merchant, its category, and the description; the amount and date fields never go.
From the text, `web/lib/local/cloud.ts` first tries to remove what looks like a date (numeric or
with a month's name), an amount (with a $ or beside a money word), a card or reference number, a
phone number, or an email. That is best effort, so one written an unusual way, or a name or a town,
can still get through. Payments to a person (Zelle, Venmo, Cash App, Apple Cash, P2P) never go.
Rows go from the date it happened on; without that date, every unsorted row goes, and the sheet
says so. For a bill: the file. Both go through Tend's server, which keeps no copy, to Gemini on
Google's free tier, whose terms let Google keep what is sent, use it to improve its products, and
have people review it (docs/PRIVACY.md, item 3).

**There is no field for what happened.** No table, request model, or form field takes a
narrative, a location, or an accused person's name. The state form's crime-detail, offender,
location, signature, and SSN fields stay blank (`web/lib/packet/forms.ts`, allowlist test in
`web/tests/packet.test.ts`).

## The rules pipeline

```
a source page or PDF --fetch_source.py--> rules/sources/ST/ST-Sn.{html,pdf} + .txt, sha256
                                             |
     rules/jurisdictions/ST.json: id, category, params, summary, quote, pinpoint
                                             |
                       verify.py: quote is a verbatim substring of the saved text,
                       numbers in 8 params fields and the summary appear in the quote,
                       source sha256 matches
                                             |
                                             v
                                rules/verified/ST.json (+ text-fragment links)
                                             |
                       normalize.py: one canonical IR per state, money in cents,
                       durations in days, rules it cannot apply set aside with a reason
                                             |
                                             v
                                   rules/ir/ST.json (IR version 2)
```

<!-- TODO(Sanat): the diagram used to say "researcher writes" the jurisdiction files. Who drafted the rules, and who
checked them against the sources, is yours to state. -->

1. **Fetch.** `rules/tools/fetch_source.py ST SOURCE_ID URL` saves the raw bytes, the extracted
   text, and the sha256 of the raw bytes. It tries plain HTTPS first and falls back to a real
   Chrome tab when a site serves a challenge page.
2. **Write.** A rule copies its quote from the saved `.txt`, never paraphrased
   (`rules/SCHEMA.md` has the 19 categories and 18 expense types).
3. **Verify.** `python3 rules/tools/verify.py all` passes a rule only if its quote is a verbatim
   substring of the source text (after Unicode and whitespace normalization), the numbers in eight
   of its params fields (`NUMERIC_PARAMS`: `amount_cents`, `years`, `months`, `weeks`, `days`,
   `within_days`, `count_limit`, `days_lost`) and in its summary (other than 0 and 1) appear in the
   quote, and the source file's sha256 still matches. It does not check other number fields, such
   as `within_hours`, `min_days`, and `min_months`; the dataset's tests
   (`rules/tools/test_export_dataset.py`) check every whole-number param against its quote. Passing
   files go to `rules/verified/`. On Oct 4, 2026 all 51 printed PASS.
4. **Normalize.** `rules/tools/normalize.py` turns 51 different legal styles into one IR: caps per
   claim or per unit, deadlines in days with their anchor, reporting rules with alternatives,
   excluded items mapped to tags. Rules for someone other than the survivor, or with a unit it
   cannot read, go to `skipped` with the reason. Deadlines keep their anchor: 12 jurisdictions
   (AZ, CA, IA, MA, MD, ME, MN, MO, NJ, NY, PA, SC) have one that can count from discovery. A cap
   whose own quote describes an expedited approval, an emergency payment, or an initial award
   becomes information, because it is not the program's limit on the survivor's cost. The corpus
   today: 1,360 decision rules, 1,284 information rules, 84 set aside. The IR records the sha256 of
   the verified file it came from.

Where the pipeline cannot decide, it says so instead of guessing. A rule whose exact effect the
engine cannot apply is shown, with its quote, and not counted.

## The compiler and the .tlaw format

`tendc rules/ir/ST.json -o ST.tlaw` (`engine/src/compiler.cpp`) reads the IR for semantics and the
verified file for quotes, pinpoints, and sources. It refuses stale IR (the IR's `source_sha256` no
longer matches the verified file). The same inputs always give the same bytes: the Michigan image
built on Linux with GCC 13 on Oct 4 had the same sha256 as the one shipped from macOS
(51,812 bytes then; `web/public/engine/laws/index.json` lists the current images and their sha256).

The image (engine/FORMAT.md section 1):

- **Header**, 64 bytes: magic `TLAW`, format 1.3, header size, total size, jurisdiction code,
  sha256 of the verified JSON, section count, flags.
- **Sections**, 8-byte aligned: `STRS` (string pool), `INTS` (money in cents), `SRCS` (sources
  with their sha256), `RULE` (36-byte rule records in proof order), `PROF` (proof lists), `ITEM`
  (per-item bytecode), `AGGR` (aggregate bytecode), and optional `TAGS`, `ANNO` (listing
  comments), `META`.
- **Trailer**: sha256 of every byte before it. `law_image_sha256` in every result is the sha256
  of the whole file, so anyone can check it with `shasum -a 256 ST.tlaw`.

**The loader trusts nothing** (`engine/src/image.cpp`). It rejects an image whose size, magic,
version, sizes, jurisdiction, or flags are wrong; whose trailer does not match; whose sections are
unknown, duplicated, misaligned, out of bounds, or overlapping; whose strings are out of bounds or
not UTF-8; or whose rules, proof lists, tags, or annotations are malformed. Then it runs the
**bytecode verifier** (`Loader::verify`, `engine/src/image.cpp:382`) on both programs:

- every opcode is allowed in its program and every operand is in range;
- every jump goes forward and lands on an instruction start, except `next`, which closes a loop;
  loops do not nest and nothing jumps into one;
- abstract interpretation gives each instruction one stack depth (at most 16) and, in the item
  program, one "decided" state; every item path makes exactly one `decide`; the stack is empty
  at `ret`.

So the interpreter needs no bounds checks and every run terminates. `tdis ST.tlaw` prints the
annotated listing; each rule block starts with its id, pinpoint, and the start of its quote.

## The VM

`engine/src/vm.cpp`. An int64 operand stack (16 deep), 8 registers, saturating arithmetic, and two
programs per law: the **item program** runs once per claim line (window, exam hold, exclusion,
coverage, confirmation, insurance) and the **aggregate program** runs once after (per-expense caps,
per-unit caps with count limits, total cap, minimum loss, deadline, reporting). Opcodes are
domain-level (`decide`, `cap`, `flag`, `check`), and each decision writes a trace entry, so the
result says which rule moved which cent. Native builds use threaded dispatch (computed goto); WASM
uses a `switch`.

Money is integer cents end to end. Adding a jurisdiction is new data, never new code.

**SPEC v1.3** (tend 1.3.0, tlaw 1.3) changed three things the VM and its callers do:

- A deadline that can count from discovery is dated from the incident (the earliest it could
  start) and the deadline check gets the flag `deadline_from_discovery`, after
  `deadline_from_report` when both apply. The engine's check uses the longest deadline rule. The
  flow and the packet lead with the general deadline rule instead (`web/lib/deadline.ts`: the rule
  each state page leads with, or where every rule counts from a later day, as in Washington, the
  first one; a rule for one trip's travel request never leads) and add "Some cases have until
  {date}" when the longest of the engine's rules ends later. Both dates are counted on the
  calendar from the rule's own years, months, and days, not from the IR's days, which count a
  month as 30 days (docs/SPEC.md step 10). A report or discovery note follows the general rule's
  own provision, so a rule for minors counted from the report (MI-FILE-2, KS-DEAD-4) adds none. A
  passed general date is never shown as "File by", and is not shown as plainly late while a longer
  rule's window is open. A general rule's own condition (VA-DEADLINE-2, FL-DEADLINE-1, NE-DEAD-1)
  is shown with the date, unless the condition is a start date ("for a crime on or after ...")
  that the date given meets. Without the IR they fall back to the engine's date and flags. The advocate
  view (`web/components/claim/Checks.tsx`) does the same when the law IR loads;
  `api/tend_api/packet.py` still shows the engine's date.
- `as_of_date` is today in the state's own time zone, the westernmost where a state spans several
  (`api/tend_api/clock.py` and `web/lib/stateTime.ts` share one table), so a late night never
  counts a deadline a day early.
- The loader reads only tlaw 1.3 images, so an older image that cannot raise the new flag is
  refused rather than misread.

The C ABI (`engine/include/tend/tend.h`) is the same natively and in WASM: `tend_eval_json`,
`tend_disasm`, `tend_inspect_json`, `tend_version`, `tend_free`. It keeps no global state, so it
is safe from several threads.

## The WASM build

`make -C engine wasm` (`engine/scripts/build_wasm.sh`, Emscripten, `-O3 -fno-exceptions`) writes
`web/public/engine/tend.js`, `tend.wasm` (183,762 bytes), the wrapper `tend_engine.mjs`,
all 51 `laws/ST.tlaw`, and `laws/index.json` with each image's sha256. These are committed, so the
web app runs without Emscripten installed.

`web/lib/engine/index.ts` picks the backend per evaluation: WASM on the device when `tend.js` and
the state's image exist; the API only when the caller passes `allowApi`, which the flow asks the
survivor for first. There is no third engine. Without either, the screen says the law could not be
checked.

`make -C engine test` fails when any shipped image is not byte-identical to a fresh `tendc` build,
so a rules change cannot ship with a stale image.

## Offline mode

A production build registers a service worker, `web/public/sw.js`, from
`web/components/flow/offline.ts` on the first visit. It saves public files only: the flow's pages
and their page data, `tend.js` and `tend.wasm`, every state's compiled law image, verified rules
and law summary, and Michigan's form. It never caches anyone's answers and never touches `/api/*`.
When everything is saved, `<html data-offline="ready">` is set and the footer says "Saved on this
device, so the steps work without internet."

With the network off, Check, reading a statement or a bill, the claim, the packet and letters, and
the vault still work, and so does a reload. A payment, a share link, or cloud AI needs the
network: offline it says so, sends nothing, and offers to try again. `VERSION` in `sw.js` must
change whenever the engine or the law images change, so a phone never mixes an engine with images
from another release. `scripts/dev.sh --prod` is the local mode that registers the worker.

## The reference engine and differential testing

`refengine/` is a plain Python 3.12 implementation of the same semantics (about 1,900 lines,
standard library only), written to be read and checked by eye. It reads the same IR, accepts or
refuses the same laws with the same messages, and must return the same result document, byte for
byte, trace included. The C++ tests add a third implementation, `engine/tests/oracle.cpp`, which
shares no code with the compiler or VM.

- `refengine/difftest.py` generates seeded claims aimed at each law's own numbers (dates around
  the window, amounts around the caps, units, tags, insurance, broken JSON) plus random laws and
  broken IR, and compares the reference with the C++ engine.
- `make -C engine wasm-parity` replays the difftest's claims through WASM and native.
- `make -C engine fuzz` is a coverage-guided fuzzer under ASan and UBSan on raw images, images
  with a fixed checksum (to reach the verifier), claim JSON, and IR through the compiler.

Numbers are in docs/EVAL.md. The limit: three implementations written from one spec can share a
misreading. The verified quotes and hand-computed golden claims are the check on the spec itself.

<!-- TODO(Sanat): this paragraph used to say "by one author". Who wrote the engines is yours to state. -->

## The API

`api/` (FastAPI, Python 3.12, uv). Routers in `api/tend_api/routers/`. Full list in api/README.md.

| Group | Routes | Notes |
|---|---|---|
| Public corpus | `GET /api/jurisdictions[/{st}[/asm,/images]]`, `GET /api/rules/search` | verified rules with fragment links |
| Law versions | `GET /api/law/versions`, `/law/diff`, `/law/search` | each version is a Neon branch |
| Claims | `POST /api/claim`, `POST /api/packet`, `POST /api/scan`, `POST /api/bill/audit` | native engine through ctypes, reference engine as fallback (`X-Tend-Engine`); nothing stored |
| Payments | `POST /api/actions/propose`, `POST /api/actions/confirm`, `GET /api/audit` | 6-digit code, 10 minutes, locks after 5 wrong tries, held lines refused, read back from Nessie, logged |
| Shares | `POST /api/shares`, `GET`/`DELETE /api/shares/{id}` | ciphertext at most 2 MB, 1 to 168 hours, open-once option |
| Bank relay | `GET /api/bank/{persona}/...` | fictional personas only (403 otherwise) |
| Cloud AI | `POST /api/ai/classify`, `POST /api/ai/bill` | refused without `consent: true` (403 for false, 422 when missing); the model sees each row's kind, merchant, category, and description, never its amount, date field, or id; a bill photo goes as the file; Tend stores nothing, and Google's free-tier terms apply to what reaches Gemini |

Storage is one repository interface with two backends: Neon Postgres in production and SQLite
offline (`api/tend_api/db`). The test suite runs entirely on SQLite with no keys and no network.

**Neon.** Each version of the corpus is published as its own Neon branch, named
`law-<date>-<short git sha>` (`scripts/neon/law_versions.py`). The first is schema-only, so no
share or audit row is ever copied into a law branch; each later one is a child of the one
before, and only the states whose files changed are written. `POST /api/claim` names the version
it was checked against (`law_version`) when that state's files match a published version, and
`null` otherwise; `GET /api/law/diff` compares two versions rule by rule. On Oct 19, 2026 the live
`/api/law/versions` reported no current version: commit 4737814 changed the IR for 11 states after
the newest published one, law-2026-10-03-c959cb6, and that change is not published yet.
Two least-privilege roles (`scripts/neon/roles.py`): `tend_reader` can only read the corpus, and
`tend_app` can write shares and pending payments and append to the audit log, never rewrite it.
They exist and pass their checks, but production does not use them yet: it is set up with the
owner's database URLs. docs/NEON.md has the details and measurements.

## Deployment

docs/DEPLOY.md is the runbook. Two Vercel projects serve one origin, https://youreowed.tech (live):

- `tend-web` (Next.js) serves the pages, the WASM engine, and the 51 law images, and proxies
  `/api/*` to the API with a bypass header (`web/vercel.json`). The CSP allows no other origin.
- `tend-api` (FastAPI, one function in `cle1`, next to Neon in `us-east-2`) sits behind Vercel
  Authentication. On Linux it has no `libtend`, so it answers `/api/claim` with the reference
  engine (`X-Tend-Engine: reference`) and the shipped law images' hashes.

Production deploys are staged; `vercel promote` is the approval step. In production, confirmed
payments are written to Nessie (`TEND_BANK=nessie`), and Neon Postgres holds the corpus, shares,
payments waiting for a code, and the audit log.

For local work, `scripts/dev.sh` starts the API (SQLite, dry-run bank) and the web app in one
command; `--prod` serves the production build with the offline worker.

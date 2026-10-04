# Tend: architecture

How the parts fit, where each one runs, and what crosses each boundary. docs/SPEC.md is the
contract, docs/PRIVACY.md is the privacy contract, and engine/FORMAT.md is the normative engine
spec. This page points into them instead of restating them.

## Components

```
                         THE SURVIVOR'S DEVICE (browser)                       |  SERVER (Vercel + Neon)
                                                                               |
 bank statement (CSV, OFX, PDF)  -> web/lib/local/statement.ts, csv.ts,        |
 or demo bank (Nessie relay)        ofx.ts, statement-pdf.ts (pdf.js)          |
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
 a payment they confirm          -> POST /api/actions/propose, /confirm   ---->|  Nessie write, audit log
 a packet they share             -> sealed in the browser, POST /api/shares -->|  ciphertext + expiry
 cloud AI, only after a yes      -> POST /api/ai/classify, /api/ai/bill  ---->|  Gemini, nothing stored
```

| Folder | What it is | Runs where |
|---|---|---|
| `rules/` | verified corpus: 51 jurisdiction files, saved sources, the IR, and the tools that build them | build time |
| `engine/` | C++20 compiler (`tendc`), VM (`libtend`), disassembler (`tdis`), CLI (`tendvm`), fuzzer, WASM build | device (WASM), server and CLI (native) |
| `refengine/` | Python reference engine and the differential test | tests; API fallback |
| `web/` | Next.js app: the survivor flow, public state pages, "How Tend decides" | device |
| `api/` | FastAPI: public corpus, payments, sealed shares, bank relay, opt-in cloud AI, agent routes | Vercel function |
| `agent/` | three Fetch.ai uAgents for ASI:One | laptop (mailbox) or Agentverse (hosted) |
| `seed/` | the fictional Nessie world: four Rowan personas, snapshots, the itemized bill, recorded Nessie answers | build and rehearsal |
| `scripts/` | Neon law branches and roles (`scripts/neon`), Vercel settings (`scripts/vercel`) | operator |
| `design/figma/` | generator scripts that build the Figma file through the Plugin API | operator |

## Trust boundaries

**The device holds the survivor's data.** Statements, bills, answers, the claim, and the packet
exist only in the browser. They are kept in memory, or in the vault if the survivor saves:
AES-256-GCM in IndexedDB, with the key from a passkey (WebAuthn PRF) or a passphrase
(PBKDF2-SHA-256, 600,000 iterations, `web/lib/vault/crypto.ts:5`). The vault locks after 5 minutes
without input and on Exit this page.

**The server holds three things** (`api/README.md`, `docs/NEON.md`):

1. The public law corpus: 51 jurisdictions, 824 sources (metadata and sha256, no page text),
   2,578 rules, 51 law image hashes, and the index of law versions.
2. Ciphertext of shared packets with an expiry (`sealed_shares`). The key is in the link's
   fragment (`/share#<id>.<key>`), which browsers do not send to servers.
3. An append-only, hash-chained audit log of confirmed payments (`audit_log`). Each row's hash
   is the sha256 of its canonical JSON body, and the body names the previous row's hash. On
   Postgres, triggers refuse updates, deletes, truncation, and any insert that does not extend
   the head (`api/tend_api/db/migrations/postgres/0003_payments.sql`).

A payment waiting for its code (`pending_actions`) is the only other state. It lasts 10 minutes,
the code is stored only as an HMAC, and the payee is cleared when the action finishes.

**What crosses the boundary**, each only on a tap (docs/PRIVACY.md lists them): a confirmed
payment (amount, account, payee), a sealed share (ciphertext), cloud AI (only after a yes; the
API returns 403 without `consent: true`), and the demo bank relay (holds the Nessie key, keeps no
log lines for those paths). The privacy line under the header
(`web/components/flow/PrivacyLine.tsx`) says "On this device. Nothing has left it." until one of
these happens.

**There is no field for what happened.** No table, request model, or form field takes a
narrative, a location, or an accused person's name. The state form's crime-detail, offender,
location, signature, and SSN fields stay blank (`web/lib/packet/forms.ts`, allowlist test in
`web/tests/packet.test.ts`).

## The rules pipeline

```
official page or PDF --fetch_source.py--> rules/sources/ST/ST-Sn.{html,pdf} + .txt, sha256
                                             |
researcher writes rules/jurisdictions/ST.json (id, category, params, summary, quote, pinpoint)
                                             |
                       verify.py: quote is a verbatim substring of the saved text,
                       every number in params appears in the quote, source sha256 matches
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

1. **Fetch.** `rules/tools/fetch_source.py ST SOURCE_ID URL` saves the raw bytes, the extracted
   text, and the sha256 of the raw bytes. It tries plain HTTPS first and falls back to a real
   Chrome tab when a site serves a challenge page.
2. **Write.** A rule copies its quote from the saved `.txt`, never paraphrased
   (`rules/SCHEMA.md` has the 19 categories and 18 expense types).
3. **Verify.** `python3 rules/tools/verify.py all` passes a rule only if its quote is a verbatim
   substring of the source text (after Unicode and whitespace normalization), every number in its
   params and summary appears in the quote, and the source file's sha256 still matches. Passing
   files go to `rules/verified/`. On Oct 4, 2026 all 51 printed PASS.
4. **Normalize.** `rules/tools/normalize.py` turns 51 different legal styles into one IR: caps per
   claim or per unit, deadlines in days with their anchor, reporting rules with alternatives,
   excluded items mapped to tags. Rules for someone other than the survivor, or with a unit it
   cannot read, go to `skipped` with the reason. The corpus today: 1,331 decision rules, 1,187
   information rules, 60 set aside. The IR records the sha256 of the verified file it came from.

Where the pipeline cannot decide, it says so instead of guessing. A rule whose exact effect the
engine cannot apply is shown, with its quote, and not counted.

## The compiler and the .tlaw format

`tendc rules/ir/ST.json -o ST.tlaw` (`engine/src/compiler.cpp`) reads the IR for semantics and the
verified file for quotes, pinpoints, and sources. It refuses stale IR (the IR's `source_sha256` no
longer matches the verified file). The same inputs always give the same bytes: the Michigan image
built on Linux with GCC 13 on Oct 4 had the same sha256 as the one shipped from macOS
(`54f9809e...`, 51,812 bytes).

The image (engine/FORMAT.md section 1):

- **Header**, 64 bytes: magic `TLAW`, format 1.2, header size, total size, jurisdiction code,
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
**bytecode verifier** (`Loader::verify`, `engine/src/image.cpp:381`) on both programs:

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

The C ABI (`engine/include/tend/tend.h`) is the same natively and in WASM: `tend_eval_json`,
`tend_disasm`, `tend_inspect_json`, `tend_version`, `tend_free`. It keeps no global state, so it
is safe from several threads.

## The WASM build

`make -C engine wasm` (`engine/scripts/build_wasm.sh`, Emscripten, `-O3 -fno-exceptions`) writes
`web/public/engine/tend.js`, `tend.wasm` (183,398 bytes on main), the wrapper `tend_engine.mjs`,
all 51 `laws/ST.tlaw`, and `laws/index.json` with each image's sha256. These are committed, so the
web app runs without Emscripten installed.

`web/lib/engine/index.ts` picks the backend per evaluation: WASM on the device when `tend.js` and
the state's image exist; the API only when the caller passes `allowApi`, which the flow asks the
survivor for first. There is no third engine. Without either, the screen says the law could not be
checked.

`make -C engine test` fails when any shipped image is not byte-identical to a fresh `tendc` build,
so a rules change cannot ship with a stale image.

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

Numbers are in docs/EVAL.md. The limit: three implementations written from one spec by one author
can share a misreading. The verified quotes and hand-computed golden claims are the check on the
spec itself.

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
| Cloud AI | `POST /api/ai/classify`, `POST /api/ai/bill` | 403 without `consent: true`; sorting sends no amounts or ids; a bill photo goes as the file; nothing stored |
| Agent | `POST /api/agent/answer`, `/agent/check`, `/agent/pay`, `/agent/confirm` | used by the Fetch.ai agents |

Storage is one repository interface with two backends: Neon Postgres in production and SQLite
offline (`api/tend_api/db`). The test suite runs entirely on SQLite with no keys and no network.

**Neon.** Each version of the corpus is published as its own Neon branch, named
`law-<date>-<short git sha>` (`scripts/neon/law_versions.py`). The first is schema-only, so no
share or audit row is ever copied into a law branch; each later one is a child of the one
before, and only the states whose files changed are written. `POST /api/claim` names the version
it was checked against (`law_version`), and `GET /api/law/diff` compares two versions rule by rule.
Two least-privilege roles (`scripts/neon/roles.py`): `tend_reader` can only read the corpus, and
`tend_app` can write shares and pending payments and append to the audit log, never rewrite it.
docs/NEON.md has the details and measurements.

## The agents

`agent/` has three uAgents (`uagents==0.25.5`, Agent Chat Protocol 0.3.0):

- **Tend Navigator** talks with the person in ASI:One and keeps a short session (ids and amounts,
  two hours at most). It never stores or logs message text, and it never forwards a message that
  describes what happened or names someone.
- **Tend Law** answers questions and runs a Check from the verified corpus, through
  `POST /api/agent/answer` and `/agent/check`. No verified rule means "That's not in the rules I
  have."
- **Tend Bank and Packet** runs the fictional demo claim, the payment (the person types the
  6-digit code), and seals a packet in the web app's share format.

Requests between them carry ids, retries are answered from a 90-second cache so nothing runs
twice, and replies are accepted only from the agent that was asked. The agents decide nothing
about law or money; they call the API. Addresses are in agent/README.md.

## Deployment

docs/DEPLOY.md is the runbook. Two Vercel projects serve one origin, `youreowed.tech`:

- `tend-web` (Next.js) serves the pages, the WASM engine, and the 51 law images, and proxies
  `/api/*` to the API with a bypass header (`web/vercel.json`). The CSP allows no other origin.
- `tend-api` (FastAPI, one function in `cle1`, next to Neon in `us-east-2`) sits behind Vercel
  Authentication. On Linux it has no `libtend`, so it answers `/api/claim` with the reference
  engine (`X-Tend-Engine: reference`) and the shipped law images' hashes.

Production deploys are staged; `vercel promote` is the approval step.

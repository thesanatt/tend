# Tend API

FastAPI service for Tend, built to docs/PRIVACY.md. The survivor's claim lives on their device. This
server holds three things: the public law corpus, the ciphertext of shared packets, and an
append-only, hash-chained log of confirmed payments. A payment waiting for its confirm code is the
only other state: the code works once, for ten minutes, the payee is cleared when the payment ends or
a sweep finds the code expired, and the row is deleted a day or more after the code expires. Claims,
scans, bills, and plaintext shares are never stored. Money is integer cents everywhere.

## Run

```
cd api
uv sync
uv run python -m tend_api.loader          # migrate Neon and load rules/verified + rules/ir (once, then on change)
uv run uvicorn tend_api.main:app --port 8000
```

Docs at http://localhost:8000/api/docs. Secrets load from `TEND_ENV_FILE`, or the nearest `.env` above the
repo, and the file wins over the shell (a stale `GEMINI_API_KEY` in a shell profile once broke every model call).

```
uv run pytest                                   # offline: SQLite, fake engine and bank, no keys, no network
TEND_NEON_TEST=1 uv run pytest -k "neon or live" # the same repository contract on Neon, plus the API end to end
```

The live run uses throwaway schemas (`tend_test_<random>`) and drops them, except one read-only test that checks
the loaded public corpus against the files on disk.

The access log keeps only the method, the path without its query, and the status: no client address. Requests
whose path is private (shares, the bank relay, cloud AI, claims, packets, rule search) leave no line at all. On
Vercel, the platform's own request logs are separate and keep those paths, with the visitor's IP address
(docs/PRIVACY.md, "What our server holds"). pypdf's warnings, which quote bytes from a damaged file, are switched
off. Request bodies over 16 MB are refused with 413, including chunked ones with no Content-Length.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `TEND_DB` | Neon when `DATABASE_URL_POOLED` or `DATABASE_URL` is set, else `api/.data/tend.sqlite3` | `neon`, a postgres URL, a SQLite path, or `:memory:`. Requests use the pooled URL; migrations use `DATABASE_URL`. |
| `TEND_DB_SCHEMA` | `public` | Postgres schema. Tests use their own. |
| `DATABASE_URL_APP` | unset | The least-privilege `tend_app` role (docs/NEON.md). When set, requests use it; `DATABASE_URL` stays the owner, for migrations only. |
| `DATABASE_URL_READER` | unset | The SELECT-only `tend_reader` role for public corpus reads and for reading published law branches. |
| `TEND_MIGRATE` | on | Off starts the API without running migrations, for a deploy that holds only the two role URLs. |
| `TEND_BANK` | `dry_run` | `dry_run` records confirmed payments in memory and reads them back; `nessie` writes them to Nessie. |
| `TEND_RELAY_LIVE` | on when `NESSIE_API_KEY` is set | The bank relay reads live Nessie and falls back to the snapshot. |
| `TEND_CLOUD_AI` | on | Off turns `/api/ai/*` down to the deterministic rules even with `GEMINI_API_KEY` set. |
| `TEND_SECRET` | stored in the database | Hex key for confirm-code MACs and the audit log's keyed hashes. Set it in production. |
| `TEND_RULES_DIR`, `TEND_IR_DIR` | `rules/verified`, `rules/ir` | The corpus. |
| `TEND_SEED_DIR` | `seed` | Persona snapshots and itemized bills. |
| `TEND_ENGINE_BUILD` | `engine/build` | `libtend.dylib` (or `.so`), `tendc`, and `laws/ST.tlaw`. |
| `TEND_REFENGINE_DIR` | `refengine` | Python reference engine, the fallback. |
| `TEND_LIVE_SCAN` | off | Lets `/scan` by `customer_id` call Nessie when no snapshot matches. |
| `TEND_PUBLIC_URL` | empty | Prefix for share links. |
| `TEND_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. |

## Endpoints (all under `/api`)

Public corpus
- `GET /jurisdictions`, `GET /jurisdictions/{st}` (verified rules with fragment links), `GET /jurisdictions/{st}/asm`
  (503 until the native engine can compile the IR), `GET /jurisdictions/{st}/images` (law image hashes the loader recorded).
- `GET /rules/search?q=&st=&limit=`: full-text search. Neon ranks with a weighted tsvector (heading, summary, quote,
  pinpoint) and `ts_rank_cd`; SQLite uses FTS5 with the porter stemmer. Both feed the same ranking, which adds the
  question's intents (deadline, police report, an expense). Each result carries the quote, pinpoint, fragment link,
  and the source's sha256.

Law versions, each a Neon branch (docs/NEON.md)
- `GET /law/versions?st=`: the published versions, oldest first, with `current` (the one production has loaded, or
  null when the loaded rules are not a published version, as on Oct 19, 2026; docs/NEON.md).
- `GET /law/diff?from=&to=&st=`: rules added, removed, and changed between two versions, with quotes and source links,
  read from both branches as `tend_reader` when `DATABASE_URL_READER` is set; without `st`, counts per state. An
  unchanged state is answered from the index.
- `GET /law/search?q=&st=&version=&limit=`: full-text search over the verbatim quotes only (GIN index on a generated
  tsvector, `websearch_to_tsquery`, `ts_headline` offsets in `marks`). Falls back to any word, and says `matched: any`.
- `POST /claim` and `POST /packet` name the version they were checked against (`law_version`, `X-Tend-Law-Version`)
  when the state's files match a published version, and null otherwise.

Claims, evaluated and returned
- `POST /claim`: SPEC v1.2 engine input in, engine output out, header `X-Tend-Engine: native | reference`. Native
  is the C++ engine through ctypes; the reference reads `rules/ir` when it can and the verified file otherwise.
  When the reference stands in, `law_image_sha256` is the sha256 of the compiled image on disk for exactly these
  rules (so both engines give the same document), or the verified file's sha256 when there is no such image.
  Items may carry `unit` and `tags`, and a ClassifiedItem's `source`, `reason`, and `confidence` are accepted and
  dropped. An item's `description` defaults to "", and the web leaves it out, so a bank or bill line's words stay
  on the device (`web/lib/api.ts` `serverClaimBody`). Output that does not add up is refused with a 500 rather
  than shown.
- `POST /packet?persona_id=`: the cited packet PDF (with the state's form when Tend has it), rendered and returned.
  A deadline counted from the police report or from discovery (docs/SPEC.md v1.3) gets its note and is never
  labeled "Past the filing deadline".
- `POST /scan` `{persona_id | customer_id, st, incident_date?}`: a demo persona's bank as v1.2 items, server-side.
  `scan_id` is a label made from what the scan found, which `/bill/audit` accepts back; nothing is kept.
- `POST /bill/audit` `{persona_id | bill_id, scan_id?}`: a demo persona's itemized bill. Lines must add up and match the
  snapshot's sha256 and the Nessie bill; the engine holds the exam line. Returns `holds`, `payable_cents`, and
  `payable_item_ids`. Survivors' own bills go to `/ai/bill` instead.

Bank relay (stateless, not logged)
- `GET /bank/{persona}/transactions?from=&to=&account=checking|cushion`: `txns` are StatementTxn rows
  (web/lib/contracts.ts: `id` as `nessie:<id>`, `date`, `amount_cents` with money out positive, `description`,
  `merchant`, `origin: "nessie"`, plus `kind` and `category`). Also `account`, `bills` (pending bills, with
  `document_path` and `service_date` when itemized), `documents` (the itemized bills' records, where web/lib/local
  reads the service date it counts a same-day ride against), `source: live | snapshot`, `fictional`, `notice`.
- `GET /bank/{persona}/bills/{bill_id}/document`: the itemized bill, checked against the snapshot's sha256.
- `GET /bank/{persona}/activity`: the bank activity panel (web/components/bank). Every Nessie record Tend read or
  wrote, with its id; each account's balance computed term by term (opening, deposits, purchases, withdrawals,
  transfers out and in) next to Nessie's frozen balance field; each bill against the itemized total, the payments
  that paid it, and the line still held; and `calls`, the Nessie requests behind the view. Only fictional demo data:
  records in the committed snapshot or in Tend's own formats. Anything else on the account is counted
  (`hidden_count`), never shown. Fictional personas only (403 otherwise).
- `POST /bank/{persona}/payout` `{st, amount_cents}`, demo only: a Nessie deposit from the state's program into the
  persona's checking account for the amount the device computed as claimable, in whole dollars, read back. The
  same request again the same day returns the same deposit; another amount, or a deposit from an earlier day, is
  replaced (`replaced` lists the old ids), so the deposit a visitor sees carries today's date, the date the demo
  reset counts from. `DELETE /bank/{persona}/payout` removes it.

Payments
- `POST /actions/propose` `{from, payee, amount_cents, kind?: "pay_bill", bill_id?, item_ids?, dry_run?}` returns
  `action_id`, `confirm_code` (six digits, once, ten minutes), `expires_at`. With `bill_id`, the server reads the
  demo bill again and runs the engine on it: held lines are refused, the amount must equal the lines paid, and
  leaving out `item_ids` pays every line that is not held. Paying every line that is not held takes the audit's
  `payable_cents`, which already subtracts any credit the bill prints (a payment made earlier); some of the lines
  take their own amounts. Live writes must be whole dollars, from a persona account.
  A plain payment of exactly what a demo bill has left to pay, to that bill's payee, from its account, is tied to the
  bill the same way (`kind: "pay_bill"` in the answer); exactly the whole bill, held line and all, is refused (409), and so is any amount that adds up to the held line, alone or with other lines (after the rest is paid, that is what the bill still shows).
  Lines Tend already paid are refused (409), here and again at confirm. With `TEND_BANK=nessie`, when every earlier
  payment of those lines is a demo payment last touched more than 20 minutes ago, the proposal first deletes Tend's demo
  writes that old and puts the bill back with seed/reset_demo.py's reset, then looks again (tend_api/demo_reset.py). It
  skips the reset while a newer Tend payment is on any of the persona's accounts, or when they differ from its snapshot
  in other ways.
- `POST /actions/confirm` `{action_id, confirm_code}`: Nessie withdrawal described as `Payment to <payee> [tend:<action id>]`,
  plus `[bill:<bill id>#<lines>]` for a bill, read back and compared, then logged. For a bill, the bill is then updated
  with a PUT and read back (`bill` in the answer): what is left, still pending, its nickname naming the held rule
  (`$325.00 held under MCL 18.355a(2) (MI-EXAM-1). Do not pay.`). Wrong codes lock the action after five tries.
  Idempotent: the same confirm again returns the first result (`replayed: true`) and moves nothing; for a payment
  whose answer never came back, it looks for the withdrawal by its label first. tend_api/payments.py has the rules.
- `GET /actions/{action_id}`, `GET /audit` (rows plus the chain recomputed).

Sealed shares
- `POST /shares` `{ciphertext, iv, expires_hours?: 1..168 (72), once?: false}` (base64 or base64url; `nonce`,
  `ttl_hours`, `open_once` also accepted) returns `201 {id, expires_at, once, api_path}`. Ciphertext is at most 2 MB;
  over that is 413, which web/lib/share shows as "too large to share".
- `GET /shares/{id}`: `{ciphertext, iv, alg: "AES-256-GCM", encoding: "base64url", created_at, expires_at, once}`,
  base64url with no padding, the alphabet web/lib/share decodes. An open-once share loses its ciphertext in the
  same transaction; a second read gets 410.
- `DELETE /shares/{id}`: 204. Expired shares, and the payee of expired proposals, are swept on every new share
  or payment, and by the app within a minute of expiring. It checks once a minute but queries only when something
  it stored has come due, so an idle server lets Neon's compute suspend. A proposal's row is deleted at the first
  sweep a day or more after its code expired.

Cloud AI, only with `consent: true` (403 for false, 422 when it is missing). Tend logs and stores nothing, but what
reaches Gemini is under Google's terms for its free tier, which let Google keep it, use it to improve its products, and
have people review it (docs/PRIVACY.md, item 3).
- `POST /ai/classify` `{consent, st?, incident_date?, txns: [{id, description, merchant?, category?, date?, amount_cents?, kind?}]}`:
  rules first, then `gemini-3.8-flash` (low thinking, 10 s, one try) with `gemini-3.5-flash-lite` as the fallback,
  output constrained to the expense enum. The model sees each row's kind, merchant, category, and description,
  never its amount, date, or id. The API removes only Tend's own tags from the description; the web app first tries to
  take dates, amounts, and similar details out of it (web/lib/local/cloud.ts), which is best effort. Returns `labels`
  (one per row) and `items` (ClassifiedItems for rows with a date and an amount).
- `POST /ai/bill` `{consent, file (base64, 10 MB), mime}`: a PDF or text file with a text layer is read by code and
  never sent; a photo or scan goes to the model, which copies lines as printed. Code parses every amount and
  checks the lines against the amount due: `status: ok | unreliable`, `lines` (`line_id`, `description`,
  `amount_cents`, `expense`), `sums_match`, `source: rule | cloud_ai`. Code's own reading of a line's words wins
  over the model's label; the model's label is used only for a line code cannot place.

## Storage

`tend_api/db`: one Repository protocol, two backends, migrations in `db/migrations/{postgres,sqlite}`:

- `0001_corpus`: `categories`, `jurisdictions`, `sources` (metadata and sha256, no text), `rules` (quote, pinpoint,
  fragment link, category, expense, params, the IR form, a generated `tsvector` with a GIN index), `law_images`.
- `0002_shares`: `sealed_shares` (id, ciphertext, iv, size, once, created_at, expires_at, opened_at). No keys.
- `0003_payments`: `pending_actions` (the code is stored only as a MAC; the payee is cleared when the action finishes,
  leaving a keyed hash), `audit_log`, and `meta` (the fallback secret).
- `db/ensure/law_versions.sql`: `law_versions` and `law_version_files`, the index of the Neon branches that each
  hold one version of the corpus. `db/ensure/quote_search.sql`: `rules.quote_search`, a generated tsvector over the
  quote alone, with a GIN index. Idempotent and never recorded in `schema_migrations`, so API builds from before
  them keep starting against the shared database (docs/NEON.md). SQLite has the same index as migration `0004`.

The audit log is append-only and hash-chained: each row's hash is the sha256 of its canonical JSON body, and the
body names the previous row's hash. In Neon, triggers refuse updates, deletes, and truncation, and an insert must
follow the head exactly (next seq, previous hash) with `hash = sha256(body)` computed in SQL, so the chain holds
even against a direct insert. SQLite checks the links in a trigger and Python checks the hashes.
Migrations are checksummed; editing one that already ran is refused. A SQLite file from the first API, which kept
claims, loses those tables on upgrade.

The first load on Neon (Oct 3) wrote 19 categories, 51 jurisdictions, 824 sources, and 2,578 rules in 12.3 s. A
rerun with nothing changed took 1.5 s (2.1 s at 7:30 PM). It recorded no law images, because the engine build at the
time (tend 1.1.0) refused IR v2. On Oct 19, 2026, `/api/health` on youreowed.tech reported the same corpus, 102 law
images, and no stale states. Each jurisdiction has two images: a tend 1.3.0 one compiled Oct 4, the same file as
`web/public/engine/laws/<ST>.tlaw` on Oct 19 (Michigan: `6f51413c...`, 51,812 bytes), and an older tend 1.2.0 one
compiled Oct 3 (Michigan: `54f9809e...`).

## What the API expects from the other parts

- **Engine:** `libtend` exports `tend_eval_json`, `tend_disasm`, `tend_version`, `tend_free`, and optionally
  `tend_inspect_json`. Images come from `laws/ST.tlaw`; a missing or stale one is compiled with
  `tendc rules/ir/ST.json --verified rules/verified/ST.json -o OUT` into `api/.cache/laws`. Errors with code
  `bad_image` or `vm_trap` fall back to the reference; `bad_input` is a 422.
- **Reference engine:** `tend_ref.evaluate(law, engine_input, law_sha256=...)` in `refengine/`. The API offers the IR
  first and the verified file second, and remembers which one it accepts.
- **Classifier and Nessie client:** `tend_api.classify` and `tend_api.nessie` (shared with `seed/`).
- **Seed:** `seed/snapshots/<persona>.json` in `tend-bank-snapshot/1`, with `meta.documents` naming each itemized bill.
  The live demo's own reset imports `seed/reset_demo.py` and the seeder from `seed/`, which deploys with the API.

# Tend API

FastAPI service for Tend, built to docs/PRIVACY.md. The survivor's claim lives on their device. This
server holds three things: the public law corpus, the ciphertext of shared packets, and an
append-only, hash-chained log of confirmed payments. A payment waiting for its confirm code is the
only other state, and it lasts ten minutes. Claims, scans, bills, and plaintext shares are never
stored. Money is integer cents everywhere.

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
whose path is private (shares, the bank relay, cloud AI, claims, packets, the agent routes, rule search) leave
no line at all. Request bodies over 16 MB are refused with 413, including chunked ones with no Content-Length.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `TEND_DB` | Neon when `DATABASE_URL_POOLED` or `DATABASE_URL` is set, else `api/.data/tend.sqlite3` | `neon`, a postgres URL, a SQLite path, or `:memory:`. Requests use the pooled URL; migrations use `DATABASE_URL`. |
| `TEND_DB_SCHEMA` | `public` | Postgres schema. Tests use their own. |
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

Claims, evaluated and returned
- `POST /claim`: SPEC v1.2 engine input in, engine output out, header `X-Tend-Engine: native | reference`. Native
  is the C++ engine through ctypes; the reference reads `rules/ir` when it can and the verified file otherwise.
  When the reference stands in, `law_image_sha256` is the sha256 of the compiled image on disk for exactly these
  rules (so both engines give the same document), or the verified file's sha256 when there is no such image.
  Items may carry `unit` and `tags`, and a ClassifiedItem's `source`, `reason`, and `confidence` are accepted and
  dropped. Output that does not add up is refused with a 500 rather than shown.
- `POST /packet?persona_id=`: the cited packet PDF (with the state's form when Tend has it), rendered and returned.
- `POST /scan` `{persona_id | customer_id, st, incident_date?}`: a demo persona's bank as v1.2 items, server-side.
  `scan_id` is a label made from what the scan found (clients of the first API send it back); nothing is kept.
- `POST /bill/audit` `{persona_id | bill_id, scan_id?}`: a demo persona's itemized bill. Lines must add up and match the
  snapshot's sha256 and the Nessie bill; the engine holds the exam line. Returns `holds`, `payable_cents`, and
  `payable_item_ids`. Survivors' own bills go to `/ai/bill` instead.

Bank relay (stateless, not logged)
- `GET /bank/{persona}/transactions?from=&to=&account=checking|cushion`: `txns` are StatementTxn rows
  (web/lib/contracts.ts: `id` as `nessie:<id>`, `date`, `amount_cents` with money out positive, `description`,
  `merchant`, `origin: "nessie"`, plus `kind` and `category`). Also `account`, `bills` (pending bills, with
  `document_path` when itemized), `source: live | snapshot`, `fictional`, `notice`.
- `GET /bank/{persona}/bills/{bill_id}/document`: the itemized bill, checked against the snapshot's sha256.

Payments
- `POST /actions/propose` `{from, payee, amount_cents, kind?: "pay_bill", bill_id?, item_ids?, dry_run?}` returns
  `action_id`, `confirm_code` (six digits, once, ten minutes), `expires_at`. With `bill_id`, the server reads the
  demo bill again and runs the engine on it: held lines are refused, the amount must equal the lines paid, and
  leaving out `item_ids` pays every line that is not held. Live writes must be whole dollars, from a persona account.
- `POST /actions/confirm` `{action_id, confirm_code}`: Nessie withdrawal described as `Payment to <payee> [tend:<action id>]`,
  read back and compared, then logged. Wrong codes lock the action after five tries.
- `GET /actions/{action_id}`, `GET /audit` (rows plus the chain recomputed).

Sealed shares
- `POST /shares` `{ciphertext, iv, expires_hours?: 1..168 (72), once?: false}` (base64 or base64url; `nonce`,
  `ttl_hours`, `open_once` also accepted) returns `201 {id, expires_at, once, api_path}`. Ciphertext is at most 2 MB;
  over that is 413, which web/lib/share shows as "too large to share".
- `GET /shares/{id}`: `{ciphertext, iv, alg: "AES-256-GCM", encoding: "base64url", created_at, expires_at, once}`,
  base64url with no padding, the alphabet web/lib/share decodes. An open-once share loses its ciphertext in the
  same transaction; a second read gets 410.
- `DELETE /shares/{id}`: 204. Expired shares are swept on every new share.

Cloud AI, only with `consent: true` (403 otherwise; nothing logged or stored)
- `POST /ai/classify` `{consent, st?, incident_date?, txns: [{id, description, merchant?, category?, date?, amount_cents?, kind?}]}`:
  rules first, then `gemini-3.8-flash` (low thinking, 10 s, one try) with `gemini-3.5-flash-lite` as the fallback,
  output constrained to the expense enum. The model sees merchant, category, and description, never an amount or
  id. Returns `labels` (one per row) and `items` (ClassifiedItems for rows with a date and an amount).
- `POST /ai/bill` `{consent, file (base64, 10 MB), mime}`: a PDF or text file with a text layer is read by code and
  never sent; a photo or scan goes to the model, which copies lines as printed. Code parses every amount and
  checks the lines against the amount due: `status: ok | unreliable`, `lines` (`line_id`, `description`,
  `amount_cents`, `expense`), `sums_match`, `source: rule | cloud_ai`. Code's own reading of a line's words wins
  over the model's label; the model's label is used only for a line code cannot place.

Agent (the Fetch.ai agent in ASI:One)
- `POST /agent/answer` `{question, st?}`: an answer built from verified rule summaries, each point with its quote,
  pinpoint, fragment link, and source hash; or `answered: false` with the program's phone when no rule supports
  one. The state can come from the question ("in Ohio"). `citations` lists the same rules in the shape the agent
  quotes from; the first leaves out its summary, which is the `answer` itself.
- `POST /agent/check` `{st, incident_date?, forensic_exam?: true | false | null, police_report?: yes | no | not_yet | unknown}`
  (also `GET /agent/check?st=`): the Check summary from docs/UX.md, every sentence with its rule ids and citations:
  `headline`, `deadline`, `reporting` (and `reporting_if_exam` when the exam answer is "not sure"), `covered`
  ("Counseling, up to $125 a session"), `total_cap`, `minimum_loss`, `exam` (also as `exam_billing`:
  `protection` and `who_pays`), `not_covered`, `privacy`, `program`. When any deadline counts from the police
  report, `deadline.flags` holds `deadline_from_report` and the text says the survivor may have longer.
- `tests/test_agent_contract.py` replays the requests the agent on main sends; run it after changing these routes.
- `POST /agent/pay` `{persona_id | from, account?, payee, amount_cents, bill_id?, item_ids?}` returns the proposal plus
  `confirm_phrase` ("confirm 118.00") and `ask_user`. `POST /agent/confirm` `{action_id, confirm_code, typed}` moves
  money only when `typed` names the exact amount. App and agent payments cannot be confirmed through each other.

## Storage

`tend_api/db`: one Repository protocol, two backends, three migrations each (`db/migrations/{postgres,sqlite}`):

- `0001_corpus`: `categories`, `jurisdictions`, `sources` (metadata and sha256, no text), `rules` (quote, pinpoint,
  fragment link, category, expense, params, the IR form, a generated `tsvector` with a GIN index), `law_images`.
- `0002_shares`: `sealed_shares` (id, ciphertext, iv, size, once, created_at, expires_at, opened_at). No keys.
- `0003_payments`: `pending_actions` (the code is stored only as a MAC; the payee is cleared when the action finishes,
  leaving a keyed hash), `audit_log`, and `meta` (the fallback secret).

The audit log is append-only and hash-chained: each row's hash is the sha256 of its canonical JSON body, and the
body names the previous row's hash. In Neon, triggers refuse updates, deletes, and truncation, and an insert must
follow the head exactly (next seq, previous hash) with `hash = sha256(body)` computed in SQL, so the chain holds
even against a direct insert. SQLite checks the links in a trigger and Python checks the hashes.
Migrations are checksummed; editing one that already ran is refused. A SQLite file from the first API, which kept
claims, loses those tables on upgrade.

The loader on Neon (Oct 3): 19 categories, 51 jurisdictions, 824 sources, 2,578 rules, 0 law images; 12.3 s the
first time, 1.5 s when nothing changed (2.1 s on a rerun at 7:30 PM). The engine build in this checkout (tend 1.1.0)
refuses IR v2, so image hashes wait for the v1.2 engine: rerun the loader after it lands. Run against the tend 1.2.0
build into a scratch SQLite file, the same command recorded 51 images (MI: `54f9809e...`, 51,812 bytes). Rules for
AZ, ID, and WY changed on main after this corpus was loaded, so `/api/health` lists them as stale until the next run.

## What the API expects from the other parts

- **Engine:** `libtend` exports `tend_eval_json`, `tend_disasm`, `tend_version`, `tend_free`, and optionally
  `tend_inspect_json`. Images come from `laws/ST.tlaw`; a missing or stale one is compiled with
  `tendc rules/ir/ST.json --verified rules/verified/ST.json -o OUT` into `api/.cache/laws`. Errors with code
  `bad_image` or `vm_trap` fall back to the reference; `bad_input` is a 422.
- **Reference engine:** `tend_ref.evaluate(law, engine_input, law_sha256=...)` in `refengine/`. The API offers the IR
  first and the verified file second, and remembers which one it accepts.
- **Classifier and Nessie client:** `tend_api.classify` and `tend_api.nessie` (shared with `seed/`).
- **Seed:** `seed/snapshots/<persona>.json` in `tend-bank-snapshot/1`, with `meta.documents` naming each itemized bill.

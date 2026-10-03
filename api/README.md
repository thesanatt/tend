# Tend API

FastAPI service for Tend. It scans a persona's (mock) bank history, evaluates claims with the law engine,
audits itemized bills, builds the cited packet, runs confirm-gated payments, and serves read-only share links.
Money is integer cents everywhere. Nothing moves without a confirm code.

## Run

```
cd api
uv sync
uv run uvicorn tend_api.main:app --reload --port 8000
```

Docs at http://localhost:8000/api/docs. Secrets load from `TEND_ENV_FILE`, or the nearest `.env` above the repo.

```
uv run pytest        # offline, no keys, no network
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `TEND_BANK` | `dry_run` | `dry_run` records confirmed payments in memory and reads them back the same way; `nessie` sends them to Nessie. |
| `TEND_RULES_DIR` | `rules/verified` | Verified jurisdiction files. |
| `TEND_SEED_DIR` | `seed` | Persona snapshots and itemized bills. |
| `TEND_ENGINE_BUILD` | `engine/build` | Where `libtend.dylib` (or `.so`), `tendc`, and `laws/ST.tlaw` live. |
| `TEND_REFENGINE_DIR` | `refengine` | Python reference engine, used when the native engine is not built. |
| `TEND_DB` | `api/.data/tend.sqlite3` | SQLite file (`:memory:` works for throwaway runs). |
| `TEND_SECRET` | stored in the database | Hex key for confirm-code MACs. |
| `TEND_LIVE_SCAN` | off | Lets `/scan` by `customer_id` call Nessie when no snapshot matches. |
| `TEND_PUBLIC_URL` | empty | Prefix for share links, e.g. the web app's domain. |
| `TEND_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. |

## Endpoints (all under `/api`)

- `GET /jurisdictions`, `GET /jurisdictions/{st}`, `GET /jurisdictions/{st}/asm` (503 until the native engine is built)
- `POST /scan` `{persona_id | customer_id, st, incident_date?}`: classified items, all unconfirmed until the survivor says yes, plus a ready `engine_input`
- `POST /claim?scan_id=...` engine input in, engine output out, plus `claim_id`, `refused`, and `evidence`. `X-Tend-Engine` says `native` or `reference`. With `scan_id`, a line whose id, amount, or date does not match the scan is refused with the reason.
- `GET /claims/{claim_id}`: every line joined to its transaction and the verbatim rule quote
- `POST /bill/audit` `{st, bill_id | persona_id | bill_text, scan_id?, incident_date?}`: lines must add up to the bill's total or the audit refuses; the exam line is held with the law quoted; `payable_cents` is what is left to pay
- `POST /actions/propose`, `POST /actions/confirm`, `GET /actions/{id}`, `GET /audit` (hash chain check included)
- `GET /packet/{claim_id}.pdf` (summary plus the state application when Tend has it), `/packet/{claim_id}/application.pdf`, `/packet/{claim_id}/needed`
- `POST /share`, `GET /share/{token}`, `GET /share/{token}/packet.pdf`, `DELETE /share/{token}`
- Agent: `GET /agent/checklist/{st}`, `POST /agent/link`, `POST /agent/redeem`, `GET /agent/claim`, `POST /agent/pay`, `POST /agent/confirm` (Bearer token from redeem)

## What the API expects from the other parts

- **Engine:** `libtend` exports `tend_eval_json(img, len, json) -> char*`, `tend_disasm(img, len) -> char*`, `tend_version()`, `tend_free(ptr)`. Law images come from `laws/ST.tlaw`. If an image is missing or older than the rules, the API compiles one with `tendc RULES.json -o OUT` into `api/.cache/laws`.
- **Reference engine:** package `tend_ref` in `refengine/` (or `refengine/src`) with `evaluate(rules, engine_input) -> dict`. `evaluate(engine_input, rules)` and `evaluate(engine_input)` also work.
- **Nessie client:** `tend_api.nessie.NessieClient()` with `create_withdrawal(account_id, amount_cents=..., description=...)` and `get_withdrawal(withdrawal_id)`. Live scans also need `snapshot(customer_id)` returning the snapshot shape below.
- **Classifier:** `tend_api.classify.classify_transactions(transactions, st)` returns engine items (`item_id`, `date`, integer `amount_cents`, `expense`, ...) plus optional `confidence` and `reason`. Anything with confidence below 1 is stored as unconfirmed.
- **Seed:** `seed/snapshots/<persona_id>.json` with `fictional`, `display_name`, `context` (`incident_date`, `as_of_date`, `police_report`, `forensic_exam`), `customer`, `accounts`, `merchants`, and `purchases` / `bills` / `withdrawals` / `transfers` / `deposits` (or one `transactions` list). The persona's itemized bill is `itemized_bill` (a path under `seed/` or an inline object), or `seed/bills/<bill_id>.json|.pdf|.txt`. JSON bills use `lines: [{date, description, amount_cents}]`, `total_cents`, and optional `amount_due_cents` and `nessie_bill_id`.

The fixtures in `tests/fixtures` show each format.

## Storage

SQLite behind the `Repository` protocol in `tend_api/storage.py`. A Postgres (Neon) class can implement the same
methods. The audit table rejects updates and deletes, and each row's sha256 covers the row before it.
Share tokens, agent link codes, and agent tokens are stored only as hashes. Confirm codes are never stored; the
database keeps a MAC of the code bound to the action id, amount, account, and payee.

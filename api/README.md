# Tend API

FastAPI service for Tend. It scans a persona's (mock) bank history, evaluates claims with the law engine,
audits itemized bills, builds the cited packet, runs confirm-gated payments, and serves expiring share links.
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

`tests/test_integration.py` runs the real seed, classifier, reference, and native engine once they sit in the
same checkout, and skips until then.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `TEND_BANK` | `dry_run` | `dry_run` records confirmed payments in memory and reads them back the same way; `nessie` sends them to Nessie. |
| `TEND_RULES_DIR` | `rules/verified` | Verified jurisdiction files (quotes, pinpoints, sources). |
| `TEND_IR_DIR` | `rules/ir` | The law IR both engines read (SPEC v1.1). Stale IR is refused. |
| `TEND_SEED_DIR` | `seed` | Persona snapshots and itemized bills. |
| `TEND_ENGINE_BUILD` | `engine/build` | Where `libtend.dylib` (or `.so`), `tendc`, and `laws/ST.tlaw` live. |
| `TEND_REFENGINE_DIR` | `refengine` | Python reference engine, used when the native engine cannot serve a claim. |
| `TEND_DB` | `api/.data/tend.sqlite3` | SQLite file (`:memory:` works for throwaway runs). |
| `TEND_SECRET` | stored in the database | Hex key for confirm-code MACs and audit tags. |
| `TEND_LIVE_SCAN` | off | Lets `/scan` by `customer_id` call Nessie when no snapshot matches. |
| `TEND_PUBLIC_URL` | empty | Prefix for share links, e.g. the web app's domain. |
| `TEND_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. |

## Endpoints (all under `/api`)

- `GET /jurisdictions`, `GET /jurisdictions/{st}`, `GET /jurisdictions/{st}/asm` (503 until the native engine is built)
- `POST /scan` `{persona_id | customer_id, st, incident_date?}`: classified items plus the persona's itemized bill as
  verified lines (they replace the single bank bill), the checking `account`, `read_count`, and a ready `engine_input`.
  Inferred items stay unconfirmed until the survivor says yes.
- `POST /claim?scan_id=...` engine input in, engine output out, plus `claim_id`, `refused`, and `evidence`. Output
  that does not add up (one line per item, allowed within requested, totals equal to their lines, known statuses)
  is refused with a 500 rather than shown.
  `X-Tend-Engine` says `native` or `reference`. With `scan_id`, a line whose id, amount, or date does not match
  the scan is refused with the reason.
- `GET /claims/{claim_id}`: every line joined to its transaction and the verbatim rule quote
- `POST /bill/audit` `{bill_id | persona_id | bill_text, st?, scan_id?, incident_date?}`: the lines must add up to
  the bill's total, the file must match the snapshot's sha256, and the total must match the Nessie bill, or the
  audit refuses. The exam line is held with the law quoted; `payable_cents` is what is left to pay.
- `POST /actions/propose` (`{from | from_account_id, payee, amount_cents}`, optionally `kind: "pay_bill"` with
  `bill_id` and `item_ids`: the amount must equal those lines, the bill must have been through `/bill/audit` so the
  law engine has seen every line, and none may be held; with `claim_id` and `item_id`, the amount may not exceed
  that line), `POST /actions/confirm`,
  `GET /actions/{id}`, `GET /audit` (hash chain check included)
- `GET /packet/{claim_id}.pdf` (summary plus the state application when Tend has it), `POST /packet` (same,
  rendered from an engine input and not stored), `/packet/{claim_id}/application.pdf`, `/packet/{claim_id}/needed`
- `POST /share` with `ciphertext` and `nonce` (sealed in the browser; `open_once` optional), or with `claim_id`,
  or with `input` (the server evaluates it again). `GET /share/{token}`, `GET /share/{token}/packet.pdf`,
  `DELETE /share/{token}`.
- Agent: `GET /agent/checklist/{st}?incident_date=&forensic_exam=&police_report=` (when `forensic_exam` is not
  given, `reporting` assumes no exam and `reporting_if_exam` gives the other answer), `POST /agent/link`, `POST /agent/redeem`, `GET /agent/claim`,
  `POST /agent/pay`, `POST /agent/confirm` (Bearer token from redeem; payments need the typed `confirm 118.00`)

## What the API expects from the other parts

- **Engine:** `libtend` exports `tend_eval_json`, `tend_disasm`, `tend_version`, `tend_free`, and optionally
  `tend_inspect_json`. Images come from `laws/ST.tlaw`; a missing or stale one is compiled with
  `tendc rules/ir/ST.json --verified rules/verified/ST.json -o OUT` into `api/.cache/laws`. Errors with code
  `bad_image` or `vm_trap` fall back to the reference; `bad_input` is a 422.
- **Reference engine:** package `tend_ref` in `refengine/` with `evaluate(law, engine_input, law_sha256=...)`.
  The API offers the IR first and the verified file second, and remembers which one this `tend_ref` accepts.
- **Nessie client:** `tend_api.nessie.NessieClient.from_env()` with `create_withdrawal(account_id, *,
  amount_cents, date, description)`, `get_txn("withdrawal", id)`, `find_txns(account_id, "withdrawal", marker)`,
  and for live scans `snapshot(customer_id)`. Live payments must be whole dollars.
- **Classifier:** `tend_api.classify.classify_transactions(transactions, st)`, or `classify_snapshot(snapshot)`,
  whose candidates the API turns into engine items (each counseling charge is one session).
- **Seed:** `seed/snapshots/<persona>.json` in `tend-bank-snapshot/1` (`meta.notice`, `meta.demo_inputs`,
  `meta.documents` naming each itemized bill by Nessie bill id, path, and sha256). Bills may be PDF, text, or JSON.

The fixtures in `tests/fixtures` show each format.

## Storage and privacy

SQLite behind the `Repository` protocol in `tend_api/storage.py`. A Postgres (Neon) class can implement the same
methods. The audit table rejects updates and deletes, each row's sha256 covers the row before it, and rows hold
amounts, ids, and keyed hashes of the payee and account, never names. Sealed shares hold only ciphertext; the key
stays in the link's fragment. Share tokens, agent link codes, and agent tokens are stored only as hashes. Confirm
codes are never stored; the database keeps a MAC of the code bound to the action id, amount, account, and payee.

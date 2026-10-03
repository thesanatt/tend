# seed: the fictional bank world

Everything here is invented for the demo. Nessie is Capital One's mock bank, and the people,
merchants, hospital, and bill are fictional. Every snapshot says so in `meta.notice`.
What the Nessie API actually does is in [NESSIE_NOTES.md](NESSIE_NOTES.md).

## Personas

| id | home | law |
|---|---|---|
| `rowan-mi` | Ann Arbor | Michigan (main demo) |
| `rowan-ny` | Rochester | New York |
| `rowan-ca` | Sacramento | California |
| `rowan-tx` | Austin | Texas |

All four are Rowan Hale with the same history. Only the state changes, so the claim can be
recomputed under each state's law.

## The history

April 1 to October 2, 2026. The demo incident date is 2026-06-14.

- Checking opens at $2,850 and Cushion savings at $900.
- 190 records across 13 merchants: 162 purchases, 14 payroll deposits, 8 transfers, 6 ATM withdrawals.
- Payroll from Fernway Books every other Friday: $398 to $419 before the incident (median $412),
  three checks of $236 after it, then back to about $412.
- Clearwater Counseling Group: 16 weekly sessions at $150, Wednesdays from June 17.
- Wayfare Rides: 14 rides on counseling days ($12 to $14) and 13 on other days.
- After the incident: locksmith $185, sheets and pillows $96, door chain and motion light $64,
  new phone $299, apartment security deposit $650, moving truck $189, four prescription copays.
- Riverbend General Hospital: a pending Nessie bill for $443 due October 20, and an itemized PDF
  in `bills/` with three lines: emergency visit copay $75, medical forensic exam with the
  deductible applied $325, lab coinsurance $43.
- Computed checking balance at the end: $803. Nessie's own balance field stays at $2,850.

## Commands

Run from `seed/` (Python 3.12, uv):

```
uv sync
uv run python seeder.py plan            # what will be seeded; no network
uv run python seeder.py seed all        # create or converge in Nessie, then refresh snapshots
uv run python seeder.py reset rowan-mi  # undo demo writes such as the $118 payment (about 2 s)
uv run python seeder.py snapshot all    # re-read live Nessie into snapshots/
uv run python seeder.py classify all    # score classification against the plan's labels
uv run pytest                           # offline; TEND_LIVE=1 also checks live Nessie
```

Keys come from the nearest `.env` above this folder, and that file wins over the shell.

## Using it from the API

```python
from tend_api.nessie import NessieClient, read_persona
from tend_api.classify import classify_snapshot

with NessieClient.from_env() as client:
    read = read_persona("rowan-mi", client)  # read.source is "live", or "snapshot" if Nessie is down
labels = classify_snapshot(read.snapshot)   # Nessie id -> Classification
```

## Snapshot format

`snapshots/<persona>.json`, format `tend-bank-snapshot/1`. All money is integer cents; engine item
ids are `nessie:<id>`.

- `meta`: persona_id, display_name, jurisdiction, fictional, notice, demo_inputs (incident_date,
  as_of_date), account_keys (checking, cushion), documents (the itemized bill: bill_id, path,
  sha256, statement_date, service_date, due_date, total_cents), history_fingerprint.
- `customer`, `accounts` (with opening_balance_cents), `merchants` (name, category, address, lat, lng).
- `transactions`: id, kind (purchase, deposit, withdrawal, transfer), account_id, date,
  amount_cents, status, description, medium, merchant_id, payee_account_id.
- `bills`: id, account_id, payee, nickname, status, amount_cents, payment_date, recurring_date,
  upcoming_payment_date, creation_date.
- `balances`: per account, opening_cents and computed_cents.

## Files

- `personas.py`, `history.py` (the plan and its ground-truth labels), `seeder.py`, `bill_pdf.py`
- `snapshots/`, `bills/`, `cache/classify_cache.json` (the model's answers): committed
- `.manifest/`: Nessie ids from the last seed, gitignored

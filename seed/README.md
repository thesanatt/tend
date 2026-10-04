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
  three checks of $236 after it, then back to about $412. The plan labels those three
  `short_payroll`: each is $176 of lost pay over a two-week period.
- Clearwater Counseling Group: 16 weekly sessions at $150, Wednesdays from June 17.
- Wayfare Rides: 14 rides on counseling days ($12 to $14) and 13 on other days.
- After the incident: locksmith $185, sheets and pillows $96, door chain and motion light $64,
  new phone $299, apartment security deposit $650, moving truck $189, four prescription copays.
- Riverbend General Hospital: a pending Nessie bill for $443 due October 20, and an itemized PDF
  in `bills/` with three lines: emergency visit copay $75, medical forensic exam with the
  deductible applied $325, lab coinsurance $43.
- Computed checking balance at the end: $803. Nessie's own balance field stays at $2,850.

## Before every rehearsal

```
cd seed && uv run python reset_demo.py
```

One command puts Rowan's bank back at the demo start (2.6 s on Oct 3). It deletes what a demo run
wrote to Nessie (the $118 payment tagged `[tend:<action>] [bill:<id>#1,3]`, the program's demo deposit
tagged `[tend:payout-MI]`), puts the Riverbend bill back to $443.00 pending under the same id, and then
reads the bank again and compares it with `snapshots/rowan-mi.json`. It prints what it undid and
`rowan-mi: at the demo start ... bill pending $443.00, computed balances: Checking $803.00, Cushion $590.00`,
and exits 0. `--check` only lists what a reset would undo. `--persona all` does all four. It writes no
file in the repository. If records ever had to be recreated with new ids, it says so and exits 1,
because the snapshot and the web's sample would need regenerating.

Then clear the browser side too: Exit this page, or Delete saved progress.

## Commands

Run from `seed/` (Python 3.12, uv):

```
uv sync
uv run python reset_demo.py             # the demo start, checked against the snapshot (see above)
uv run python seeder.py plan            # what will be seeded; no network
uv run python seeder.py seed all        # create or converge in Nessie, then refresh snapshots
uv run python seeder.py reset rowan-mi  # converge and rewrite the snapshot (reset_demo.py writes nothing)
uv run python seeder.py snapshot all    # re-read live Nessie into snapshots/ (read-only)
uv run python seeder.py classify all    # score classification against the plan's labels
uv run python seeder.py items all       # write classified/: the statement's ClassifiedItems; offline
uv run pytest                           # offline; TEND_LIVE=1 also checks live Nessie
```

## Recorded Nessie answers

`cassettes/` holds what the demo sent to live Nessie and what Nessie answered, recorded on Oct 3 by
`cd api && uv run python ../seed/record_cassettes.py` (it resets rowan-mi before and after, and checks
the key is in no file). `pay-bill.json` is the $118 payment and the bill update, `payout.json` the demo
deposit, `activity.json` the bank activity read-out, `reset.json` the reset undoing all of it.
`api/tests/test_nessie_recorded.py` and `tests/test_cassettes.py` replay them with no network: every
request must match a recorded one exactly (path and body), so a second payment would fail the test.
Re-record after changing what Tend sends to Nessie.

Snapshots were last read from live Nessie on Oct 3 at about 5:25 PM Detroit time: 190 records per
persona, checking computed at $803, the bill pending at $443, the same records as the plan.

Keys come from the nearest `.env` above this folder, and that file wins over the shell.

## Using it from the API

```python
from tend_api.nessie import NessieClient, read_persona
from tend_api.classify import classify_snapshot

with NessieClient.from_env() as client:
    read = read_persona("rowan-mi", client)  # read.source is "live", or "snapshot" if Nessie is down
labels = classify_snapshot(read.snapshot)   # Nessie id -> Classification
```

`classify_snapshot` sets two kinds of record aside (candidate and confirmed both false) so no
dollar is offered twice. The first is a Nessie bill that has an itemized document in
`meta.documents`: the scan reads its lines from the PDF, and the forensic exam line is the one
the engine holds. The second is a payment Tend made, which carries `[tend:<action id>]` in its
description. The document's service date also counts as a care day when rides are linked.

The client redacts the API key from httpx's request log. New cache entries keep only the label,
reason, and model unless the cache is opened with `record_text=True`, which only the seeder does
for the fictional personas.

## Items (SPEC v1.2)

Each label carries the shape of its engine item, and `snapshot_items` or `classify_statement`
turns labels into ClassifiedItems (web/lib/contracts.ts):

- a counseling charge is one session: `unit: "session"`, `units: 1`
- a paycheck that came in at least $20 and a tenth under the usual one, after the date it
  happened, is lost pay: `expense: "lost_wages"`, the shortfall as the amount, `unit: "day"`,
  and as `units` the workdays it probably stands for: the shortfall's share of the usual check
  times the workdays in the pay period (5 a week), rounded, never more than the period. Rowan's
  $176 dip on a biweekly $412 check is 4 days. It is an estimate, so it starts unconfirmed. The
  usual amount is the median of at least three checks before the date.
- a ride has no unit; short-term lodging counts days (`unit: "day"`, nights read from the text
  when they are there)
- a replaced phone, purse, or other property is tagged with the normalizer's own keyword table,
  so `["phone"]` meets an excluded rule that names phones; nothing else is tagged
- only a direct match (a known merchant or a keyword) may start confirmed. A model pick, a ride
  linked to care, a pay gap, and anything unresolved always start unconfirmed.

`classified/<persona>.json` (format `tend-classified/1`) holds those items for each persona's
checking statement, built offline from the snapshot and the committed cache. Rowan has 43: 16
counseling sessions, 14 rides to care, 4 prescriptions, 3 pay gaps of $176, 2 moving costs,
2 security, bedding, and the phone. `tests/test_classified.py` fails when a file falls behind
the classifier, and checks that the statement path and the snapshot path agree.

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
- `reset_demo.py` (the rehearsal reset), `record_cassettes.py` (records `cassettes/`)
- `snapshots/`, `classified/`, `bills/`, `cassettes/`, `cache/classify_cache.json` (the model's answers): committed
- `.manifest/`: Nessie ids from the last seed, gitignored

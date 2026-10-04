# Nessie notes: what the API really does

I checked the 2026 Nessie API by hand at https://api.nessieisreal.com with our key on Oct 3, 2026,
around 3 PM Detroit time. Where this file disagrees with the published spec (OpenAPI 3.0.3 on
nessieisreal.com), this file wins. `api/tend_api/nessie.py` is built to match it, and
`seed/tests/fake_nessie.py` copies the same behavior so the tests run offline.

The spike used a fictional customer, "Spike Probe". I deleted every probe record that Nessie lets
you delete. The customer and one merchant (renamed "Unused probe merchant") are still there,
because Nessie has no route to delete either.

## Hosts and the key

- `api.nessieisreal.com` and `prod-api.nessieisreal.com` both answer, with the same data.
- The key goes in the query string: `?key=...`.
- A wrong key is not rejected. `GET /customers?key=<anything>` returns `200 []`, so a typo in the
  key looks like an empty bank. The client refuses an empty key, and the seeder fails loudly when
  it cannot find what it seeded.
- No key at all: `502 {"message": "Internal server error"}`.
- An unknown route, including the wrong singular or plural, answers
  `403 {"message": "Missing Authentication Token"}`. That is AWS API Gateway saying the route does
  not exist. It is not an auth problem.

## IDs

- UUIDs (36 characters), not the 24-character ObjectIds in the spec.
- Objects use `_id`, except transfers: list and single reads key them as `id`. The create answer
  for a transfer still says `_id`.

## Creating records

| resource | route | answer |
|---|---|---|
| customer | `POST /customers` | `201 {code, message: "Customer created", objectCreated}` |
| account | `POST /customers/{id}/accounts` | `201`, objectCreated adds `account_number` (16 digits) and `customer_id` |
| merchant | `POST /merchants` | `201`, objectCreated |
| purchase | `POST /accounts/{id}/purchases` | `201`, objectCreated adds `type: "merchant"` and `payer_id` |
| deposit | `POST /accounts/{id}/deposits` | `201`, objectCreated adds `creation_date` (today) |
| withdrawal | `POST /accounts/{id}/withdrawals` | `201`, adds `type: "withdrawal"`, `payer_id`, `creation_date` |
| transfer | `POST /accounts/{id}/transfers` | `201`, objectCreated |
| bill | `POST /accounts/{id}/bills` | `201`, adds `creation_date`, `account_id`, and `upcoming_payment_date` (only when `recurring_date` was sent) |

Every create I made came back in the `{code, message, objectCreated}` wrapper. The spec says creates
return a bare string such as `"Withdrawal created"`. The client unwraps both, and when no object comes
back it lists the collection and matches on what it sent. Updates (`PUT`) answer
`202 {code, message, objectUpdated}`.

## Amounts

- Transactions store whole numbers. `11.20` became `11` and `412.75` became `412`, with no error.
- Bills keep decimals: `payment_amount: 44.5` stayed `44.5`, and `443` reads back as `443.0`.
- `"abc"` is rejected (`400 value is not a valid integer`). `-5` and `0` are accepted.
- Tend reads the Nessie unit as whole US dollars and works in cents (dollars x 100). The client
  refuses to write an amount that is not a whole dollar instead of letting Nessie truncate it.

## Validation, or the lack of it

- Deposits accepted `transaction_date: "not-a-date"`, a negative amount, and an account id that does
  not exist (`201` each). The client checks dates, amounts, and statuses before it sends anything.
- Purchases need `merchant_id` (`400` without it), but any string passes: a made-up UUID was
  accepted. Purchases need a merchant we create, and nothing checks that it exists.
- Transfers require `transaction_date`, `status`, `amount`, `description`. They reject `medium` and
  `payee_id` with `400 extra fields not permitted`. There is no destination field at all, so Tend
  appends `[payee:<account id>]` to the description and parses it back on read.
- `PUT /purchase/{id}` accepts `description`, `amount`, `purchase_date`, `medium`, `payer_id`. It
  rejects `status` and `merchant_id`.

## Poisoned lists (the dangerous one)

- A purchase created without `purchase_date` or `status` is stored. From then on
  `GET /accounts/{id}/purchases` and `GET /merchants/{id}/purchases` answer
  `400 "2 validation errors for Purchase ... field required"` for the whole account, and a GET of
  that one purchase fails the same way.
- A bill created without `payment_date` and `recurring_date` does the same to
  `GET /accounts/{id}/bills` and `GET /customers/{id}/bills`
  (`upcoming_payment_date field required`).
- `PUT` cannot repair either: `status` is not updatable on purchases, and `upcoming_payment_date` is
  only computed at create. Only `DELETE` by id fixes the list, so you need the id from somewhere else.
- So the client always sends the full record: purchases with `purchase_date` and `status`, bills with
  `payment_date` and `recurring_date`. `recurring_date` is required in practice even for a one-time
  bill; Tend sets it to the due day.

## Reading

- Empty sub-collections: purchases, deposits, withdrawals, bills, and loans answer `200 []`.
  Transfers answer `404 "No transfers found for this account"`. The client reads a 404 on a list
  as `[]`.
- A transfer is listed only on the sending account. The receiving account's transfer list is 404.
- Single-object routes are inconsistent: `/purchase/{id}` and `/withdrawal/{id}` are singular, while
  `/deposits/{id}`, `/transfers/{id}`, and `/bills/{id}` are plural. The other spelling gives 403.
- Deposits and transfers carry no account field. Purchases and withdrawals carry `payer_id`.
- `GET /accounts/{bad id}` answers 404 with an empty body; `GET /accounts/{bad id}/purchases`
  answers `200 []`.

## Balances

- `account.balance` never changes. I checked after a deposit, a withdrawal, purchases, a transfer,
  and a bill marked `completed`: Checking stayed 2400 and Savings stayed 0.
- Tend computes balances: opening balance + deposits - purchases - withdrawals - transfers out +
  transfers in (by payee tag), skipping cancelled records. Bills are not ledger entries; a paid bill
  shows up as the withdrawal that paid it.

## Deleting

- `DELETE` on `/purchase/{id}`, `/withdrawal/{id}`, `/deposits/{id}`, `/transfers/{id}`,
  `/bills/{id}`, and `/accounts/{id}` answers 200. The body varies: `"Purchase deleted"`,
  `"Bill deleted"`, or `""`.
- It answers 200 again for an id that is already gone, so it tells you nothing about existence.
- After a delete, GET answers 404 with a message that varies by type.
- Deleting an account does not cascade. Its 20 withdrawals stayed listed under the dead account id
  and stayed readable by id. Delete the children first.
- There is no `DELETE` for customers or merchants (403). They last as long as the key, so the seeder
  finds and reuses them.

## Who can see what

- `GET /customers`, `/accounts`, and `/merchants` are scoped to the key.
- With a different, made-up key, `GET /accounts/{our id}/deposits`, `/accounts/{our id}/bills`, and
  `/customers/{our id}/accounts` still returned our records. `GET /accounts/{id}` and
  `/customers/{id}` did not.
- `GET /enterprise/customers` listed 1,331 customers across every key.
- Anything seeded is readable by anyone who has an id. Seed only fictional data.

## Speed

- 20 sequential POSTs took 1.29 s in total (55 to 81 ms each), with no 429s.
- Some GETs take about 1.2 s now and then. `/enterprise/deposits` did not answer within 15 s.

## Paying a bill (checked Oct 3, about 8 PM, on a throwaway account and then on rowan-mi)

- There is no route that pays a bill. Tend pays one with a withdrawal and then a `PUT /bills/{id}`.
- `PUT /bills/{id}` with `payment_amount`, `nickname`, and `status` answers `202 {code, message, objectUpdated}`.
  An int stays an int (`325`), `upcoming_payment_date` and `recurring_date` survive, and a 79-character
  nickname was kept whole. A later `GET /bills/{id}` shows the same values.
- So after the $118 payment the Riverbend bill reads `pending`, `325`, nickname
  `Riverbend General statement: $325.00 held under MCL 18.355a(2) (MI-EXAM-1). Do not pay.`
- A description holding `[tend:act_...] [bill:<id>#1,3]` is stored and read back unchanged.
- `GET /deposits/{id}` has no account field, so Tend checks a deposit's account by finding its id in
  `GET /accounts/{id}/deposits`.
- Nessie's own date for `creation_date` was already Oct 4 at 8 PM Detroit time: it runs on UTC.

## How the client handles all this

- Takes cents, writes whole dollars, and refuses anything Nessie would truncate.
- Validates dates, statuses, and required fields before sending, so it cannot poison a list.
- Unwraps `objectCreated` and `objectUpdated`, accepts `_id` or `id`, and falls back to
  list-and-match when a create answers with only a message.
- Reads 404 on a list as empty, and raises `NessieListCorrupt` with a hint when a list is poisoned.
- Uses a 10 s timeout. GETs get one retry on a 5xx or a network error. Writes are never retried,
  because Nessie has no idempotency keys; a write that times out raises with `maybe_applied=True`,
  and `find_txns(account, kind, marker)` checks whether it landed.
- Computes balances from records and keeps the payee of a transfer in its description.
- Keeps a log of every call it made (`client.calls`: method, path, status, milliseconds, list size; never
  the key), which the bank activity panel shows.
- Ties a bill payment to its bill in the withdrawal's description, `[bill:<id>#<lines>]`, and uses that tag
  as the idempotency key Nessie does not have: lines already paid are never paid again.

# Tend on Neon

Tend is local-first (docs/PRIVACY.md is the contract). A survivor's claim, bank rows, bills, and
answers stay on their device. The server keeps only what is public or sealed, and Neon holds all of
it in one Postgres 18 project, `tend` (us-east-2). This page says what lives there and why, how each
version of the law becomes its own Neon branch, and the numbers we measured.

## What lives in Neon

| What | Tables | Who can touch it | Why it is on a server at all |
|---|---|---|---|
| The public law corpus | `categories`, `jurisdictions`, `sources`, `rules`, `law_images` | read: `tend_reader`, `tend_app`; write: the owner (loader) only | Public, verified rules that every page, the agent, and the API cite |
| The law version index | `law_versions`, `law_version_files` | read: both roles; write: the owner (publish script) | Names every published law branch, so the API can read and compare them |
| Sealed shares | `sealed_shares` | `tend_app` only | Ciphertext an advocate opens with a key that never reaches the server |
| Payments waiting for a code | `pending_actions` | `tend_app` only | Ten minutes at most; the code is stored only as a MAC, the payee is cleared after |
| The payment audit log | `audit_log` | `tend_app` may read and append, never change | Hash-chained; triggers refuse updates, deletes, truncation, and any insert that does not extend the chain |

Never in Neon: claims, scans, bills, statements, names, or anything about what happened. There is no
column for any of it.

## Each law version is a Neon branch

The verified corpus changed four times on October 3 as research added rules, the law engine's reading
of them changed, and saved source pages were saved again. A packet should say which law it was
checked against, and anyone should be able to see what changed since. So every version of the corpus
is published as its own branch, named `law-<date>-<short git sha>`:

```
production                       br-winter-mode-b4n4qlij       the API's database: corpus, shares, audit log, version index

law-2026-10-03-52abf94           br-square-leaf-b4kaa61u       schema-only root: 1,818 rules from 641 sources
`- law-2026-10-03-c8304df        br-weathered-mouse-b4jae2vp   +663 rules: documents to send, how to file, processing times
   `- law-2026-10-03-d83289a     br-lucky-mountain-b4nuurep    +97 rules: address confidentiality, record confidentiality
      `- law-2026-10-03-1e96ad5  br-young-frost-b43l8bnn       the law engine reads 66 rules differently (rule format v2)
         `- law-2026-10-03-c959cb6  br-billowing-violet-b4h7wdk1  13 source pages saved again (AZ, ID, WY); in use now
```

How `scripts/neon/law_versions.py publish` builds one:

1. `git archive` gives `rules/verified` and `rules/ir` exactly as committed, so every file's sha256
   matches the commit.
2. The first version is a **schema-only branch** of production: it gets the tables and none of the
   rows, so no sealed share or audit row is ever copied into a law branch. Every later version is a
   **child of the version before**, so it starts as an exact copy and only the states whose files
   changed are written again.
3. The corpus is loaded as the owner, then checked: the sha256 of the branch's own
   `jurisdictions` hashes must equal the version's corpus hash, or nothing is published.
4. The branch records itself in its own `law_versions` table, and production's index gets the same
   row plus one `law_version_files` row per state.

A published branch is never loaded again. When the corpus changes, running `publish` again adds the
newest corpus commit as a new child branch.

### Reading and comparing versions

- `GET /api/law/versions` lists the index; `current` is the version whose corpus hash equals the one
  production has loaded (today `law-2026-10-03-c959cb6`).
- `GET /api/law/diff?from=&to=&st=` compares two versions. When a state's file hashes are the same in
  both, the index answers "unchanged" without opening a branch. Otherwise the API connects to both
  branches by host, **as `tend_reader`**, reads them at the same time, and lines up every rule by id:
  added, removed, or changed, each with its verbatim quote, pinpoint, and a link to the sentence. A
  change is labeled by kind: the quote itself, Tend's reading of it, what the law engine does with
  it, or a source page saved again. Program details (phone, website, form) are compared too.
- Before a branch is trusted, it must name the version in its own `law_versions` table and hold
  exactly that version's files. A misrouted host is refused with a 502 instead of shown.
- A published version never changes, so the API keeps what it read in memory.
- `web/app/law/changes` is the public page. With `TEND_API_URL` set it asks the API and says when the
  branches were compared; otherwise it uses `snapshot.json`, written from the same branches by
  `law_versions.py snapshot`, and says it is a saved copy.

### Claims and packets name their version

`POST /api/claim` returns `law_version` (and the `X-Tend-Law-Version` header): the newest published
version whose files for that state match, by sha256, the files the server evaluated with, or `null`
when the rules are not a published version. `POST /api/packet` prints the same in a "Which law this
used" paragraph, with the rules file and law image hashes.

## Search over the law's own words

`GET /api/law/search?q=&st=&version=` searches the verbatim quotes only, never Tend's summaries.

- `rules.quote_search` is a generated `tsvector` over the quote, with a GIN index (`db/ensure/quote_search.sql`).
- `websearch_to_tsquery` reads what someone types (`"a phrase"`, `or`, `-word`) and never raises on it.
- `ts_headline` marks the matched words; the API turns the marks into `[start, end)` offsets.
- When no quote has every word, the API searches for any of them and says `"matched": "any"`.
- With `version=`, the same query runs on that version's branch.
- Results carry only the quote, rule id, pinpoint, source id, and the link to the sentence. The API's
  access log leaves these requests out, as it does for the older `/api/rules/search`.

The state pages do not get a server-backed search box. docs/PRIVACY.md lists what may leave the
device, and a typed search is not on it. Adding one would also need the "Nothing has left it" line to
change after a search. The endpoint serves the Fetch.ai agent instead.

## Least privilege

| Role | Can | Cannot |
|---|---|---|
| `tend_reader` | SELECT the corpus and the version index | read shares, payments, or the audit log; write anything (its transactions are read-only by default; statements stop at 5 s) |
| `tend_app` | read and write `sealed_shares` and `pending_actions`; read and append `audit_log` and `meta`; read the corpus | change or delete a rule, rewrite or truncate the audit log, create a table or schema (statements stop at 15 s) |
| `neondb_owner` | migrations, the corpus loader, publishing law branches | is never needed by the running API |

The two roles are created with SQL (`scripts/neon/roles.py`), so they are not members of
`neon_superuser` (roles made in the console are). Their passwords are 256-bit random strings kept in
the `.env` file as `DATABASE_URL_READER` and `DATABASE_URL_APP` (pooled URLs). Default privileges give
`tend_app` read and write, never DDL, on tables a later migration adds; the reader sees nothing new
until it is named. The publish script sets both roles' passwords on the law root, and each child
branch copies its parent's roles, so the API reads every law branch with the one reader URL.

`roles.py` proves this by running 14 statements as each role, each in a transaction that is rolled
back and written so it cannot change a row even if allowed. On production and on a fresh branch:
28 of 28 as expected.

```
check                       tend_reader  tend_app
read the rules              allowed      allowed
search the quotes           allowed      allowed
read the law version index  allowed      allowed
change a rule               refused      refused
delete rules                refused      refused
read sealed shares          refused      allowed
write a sealed share        refused      allowed
read the audit log          refused      allowed
append to the audit log     refused      allowed
rewrite the audit log       refused      refused
delete from the audit log   refused      refused
truncate the audit log      refused      refused
create a table              refused      refused
create a schema             refused      refused
```

The API uses `DATABASE_URL_APP` when it is set (otherwise the old pooled URL), sends corpus reads
through `DATABASE_URL_READER`, and runs migrations only with the owner's `DATABASE_URL`. A deploy that
holds only the two role URLs sets `TEND_MIGRATE=0`; migrations then run from the loader.

## Numbers

Measured October 3, 2026, between 8:20 and 9:00 PM ET, from a laptop to Neon in us-east-2. Server
times are from `EXPLAIN ANALYZE`, run as `tend_reader` (`scripts/neon/measure.py`).

**Rows.** Production: 19 categories, 51 jurisdictions, 824 sources, 2,578 rules, 51 law images,
5 law versions, 255 version files. Sealed shares, pending payments, and audit rows: 0 at the time.

**Branches.** 6 of the free plan's 10 (production and 5 law versions); 2 of its 3 root branches.

| Version | Branch made in | Loaded in | States written | Rules | Sources | Logical size |
|---|---|---|---|---|---|---|
| law-2026-10-03-52abf94 (schema-only root) | 5.0 s | 10.0 s | 51 of 51 | 1,818 | 641 | 36.7 MB |
| law-2026-10-03-c8304df | 1.5 s | 21.2 s | 51 of 51 | 2,481 | 678 | 43.0 MB |
| law-2026-10-03-d83289a | 2.3 s | 12.8 s | 51 of 51 | 2,578 | 824 | 49.5 MB |
| law-2026-10-03-1e96ad5 | 1.5 s | 14.4 s | 51 of 51 | 2,578 | 824 | 54.6 MB |
| law-2026-10-03-c959cb6 | 2.0 s | 2.7 s | 3 of 51 (161 rules) | 2,578 | 824 | 55.1 MB |

The four enrichment commits touched every state's file, so those versions rewrote every state. The
last one touched three, so it wrote 161 of 2,578 rules and kept the rest from its parent. Logical
size is Neon's figure for each branch's whole database, so it does not show what branches share;
this plan's API does not break storage down further.

**Queries on the server (as `tend_reader`).**

| Query | Planning | Execution | Plan |
|---|---|---|---|
| Quote search, one state | 0.13 ms | 0.30 ms | Bitmap Index Scan on `rules_quote_search_idx` |
| Quote search, all 51 | 0.12 ms | 1.13 ms | Bitmap Index Scan on `rules_quote_search_idx` |
| Quote search on a law branch, one state | 0.17 ms | 2.34 ms | BitmapAnd of `rules_quote_search_idx` and `rules_category_idx` |
| Version index | 0.07 ms | 0.04 ms | Seq Scan (5 rows) |
| Which version holds this file | 0.09 ms | 0.05 ms | Index Scan on `law_version_files_lookup_idx` |
| One state's rules for a diff (law branch) | 0.18 ms | 0.21 ms | Index Scans on `rules_category_idx` and `sources_pkey` |

**End to end, from the laptop.**

| Request | Time |
|---|---|
| Quote search (production) | 36 to 42 ms median; the round trip is most of it |
| One state's diff, two branches, fresh connections, both computes awake | 0.48 to 0.55 s |
| Idaho's diff with one of the two computes scaled to zero | 1.18 s |
| The same diff again (versions never change, so it is kept in memory) | 0.4 ms |
| All 51 states, first version against the newest | 0.9 to 1.6 s |
| `tests/test_neon_law.py`, which makes a branch, publishes into it, checks it, and deletes it | 13 to 15 s |

**Tests.** `uv run pytest` (offline: SQLite stands in for the branches) and
`TEND_NEON_TEST=1 uv run pytest -k "neon or live"` (31 tests on Neon, about 65 s). The live run reads
production only as `tend_reader`, and proves the publish path and the role limits on a throwaway
branch that Neon deletes within an hour even if the run dies.

## Running it

```
cd api
uv run python ../scripts/neon/roles.py                     # roles, grants, and the 28-check proof
uv run python ../scripts/neon/law_versions.py publish      # one branch per corpus version not yet published
uv run python ../scripts/neon/law_versions.py list
uv run python ../scripts/neon/law_versions.py diff --from law-2026-10-03-c8304df --to law-2026-10-03-d83289a --st MI
uv run python ../scripts/neon/law_versions.py snapshot     # the saved copy web/app/law/changes falls back to
uv run python ../scripts/neon/measure.py                   # the numbers above
```

`NEON_API_KEY` is a project-scoped key named `tend-hackathon`; it can manage only the `tend` project,
and only the scripts use it. The API never holds it.

### Why the law tables are not numbered migrations

Every API build, old and new, shares the one production database, and an API build refuses to start
against a database whose `schema_migrations` lists a version it does not know. So the law version
index and quote search live in `api/tend_api/db/ensure/` instead of `db/migrations/`: idempotent SQL
that `migrate()` and the scripts run only where something is missing, and never record. Production
still lists 0001 to 0003, so an API build from before this change keeps starting, and a new build's
startup check finds nothing to do and runs no DDL.

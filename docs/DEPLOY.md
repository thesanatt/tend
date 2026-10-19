# Deploying Tend on Vercel

Two Vercel projects in the `thesanatts-projects` team serve one origin, `youreowed.tech`:

| Project | Deploys from | What it is |
|---|---|---|
| `tend-web` | `web/` | Next.js. Pages, the WebAssembly engine, the 51 law images, the corpus copies. `web/vercel.json` proxies `/api/*` to `tend-api` at request time. |
| `tend-api` | repository root | FastAPI on Vercel's Python runtime, one function (`api/index.py`) in `cle1` (Cleveland), next to Neon in `us-east-2`. |

The browser only ever talks to `youreowed.tech`. The CSP allows no other origin, so a request for `/api/claim`
goes to the web project, whose route forwards it to `TEND_API_URL` with the header
`x-vercel-protection-bypass: $TEND_API_BYPASS`. Both values are project environment variables, read at request
time; nothing secret is in the repository or in any page bundle.

## How the two projects are protected

- `tend-api` uses Vercel Authentication on **all** deployments, production included. The API has no public
  address of its own: it answers the web proxy (which carries the bypass secret), `vercel curl`, and team
  members signed in to Vercel.
- `tend-web` uses the default (everything except custom domains): previews need a Vercel login or the bypass,
  and `youreowed.tech` is public once it is attached.
- Production is staged on both projects (`autoAssignCustomDomains: false`). `vercel deploy --prod` builds a
  production deployment that serves nothing until someone runs `vercel promote`. That promote is the approval.
- Vercel makes a project's first deployment a production one even without `--prod`. Staging is what keeps that
  first build off the public `.vercel.app` domain.
- The Vercel toolbar is off on `tend-web` for previews and production, so no `vercel.live` script loads (the CSP
  would refuse it anyway).

## What runs on Vercel

- **Engine.** `libtend` is not built on Linux, so the API answers `/api/claim` with the Python reference engine
  (`X-Tend-Engine: reference`). The function carries `web/public/engine/laws/*.tlaw`, so its answers name the
  same `law_image_sha256` as the engine on the device (the hash `web/public/engine/laws/index.json` lists for that
  state). `/api/jurisdictions/{st}/asm` answers 503; the law pages ship their own listings.
- **Lowercase law links.** `web/proxy.ts` answers a law path whose code has a lowercase letter with a 308 to the
  same code in capitals (`/law/mi` to `/law/MI`, `/law/dc` to `/law/DC`). The 51 law pages stay static. A redirect in `next.config.ts` cannot do this: its matching ignores
  case, so it would loop on `/law/MI`.
- **Bundle.** `.vercelignore` at the root is an allowlist. `api/` and `seed/` go up whole, minus tests, virtual
  environments, caches, and the local SQLite file, so a new folder the API reads ships without an edit. From
  `rules/` only `verified` and `ir`, from `refengine/` only `tend_ref`, from `web/` only the law images. Never
  `.env`, never the 192 MB in `rules/sources`. If a route ever needs the source text, allow
  `rules/sources/**/*.txt` (14 MB), never the HTML or PDFs.
- **Dependencies.** Vercel installs from `requirements.txt` at the root, exported from `api/uv.lock`.
  `api/tests/test_deploy.py` fails when the two disagree. After changing API dependencies:
  `uv export --project api --frozen --no-dev --no-hashes --no-emit-project --format requirements-txt -o requirements.txt`
- **Deployed mode.** `api/index.py` sets `TEND_DEPLOYED=1`: `/api/health` leaves out the database endpoint and
  file paths, every JSON error has local paths taken out, and `/api/audit` returns only the chain head, its
  length, and counts per event. `TEND_AUDIT_ROWS=1` lists the rows again for a demo. httpx and the Gemini SDK
  log warnings only, so the bank relay's outgoing reads leave no log lines.
- **Startup.** No heavy work: migrations are one advisory-locked transaction that applies nothing when current,
  and the corpus is loaded ahead of time with the loader. Measured on the preview from Ann Arbor: first request
  after a deploy 0.44 s, warm `/api/health` 0.08 to 0.15 s, the live Nessie relay read 0.64 s.

## Settings

Push them with `scripts/vercel/env.py`, which reads `.env` (or `TEND_ENV_FILE`) and never prints a value:

```
uv run --project api python scripts/vercel/env.py api preview
uv run --project api python scripts/vercel/env.py api production
uv run --project api python scripts/vercel/env.py web preview --api-url https://<tend-api preview>.vercel.app
uv run --project api python scripts/vercel/env.py web production --api-url https://tend-api-pi.vercel.app
```

| Project | Variable | Preview | Production |
|---|---|---|---|
| tend-api | `DATABASE_URL_POOLED`, `DATABASE_URL`, `NESSIE_API_KEY`, `NESSIE_BASE_URL`, `GEMINI_API_KEY` | from `.env` | from `.env` |
| tend-api | `TEND_SECRET` | its own, made once | its own, made once (kept out of the database) |
| tend-api | `TEND_BANK` | `dry_run` | `nessie` (confirmed payments write to Nessie) |
| tend-api | `TEND_DB_SCHEMA` | `vercel_preview` (its own tables) | unset (`public`) |
| tend-api | `TEND_PUBLIC_URL`, `TEND_CORS_ORIGINS` | unset | `https://youreowed.tech`, plus `www` for CORS |
| tend-web | `TEND_API_URL` | the API preview it should use | `https://tend-api-pi.vercel.app` |
| tend-web | `TEND_API_BYPASS` | the API project's bypass secret | the same |

Previews never move mock money and never write to production's append-only audit chain. Their schema has its
own copy of the corpus; refresh it after rules change: `cd api && uv run python -m tend_api.loader --schema vercel_preview`.
To try a real Nessie write in a preview, set `TEND_BANK=nessie` for Preview and redeploy (it changes Rowan's
fictional account for everyone).

## Previews

Link once per checkout (the links live in gitignored `.vercel/` folders):

```
vercel link --yes --project tend-api --scope thesanatts-projects
vercel link --yes --cwd web --project tend-web --scope thesanatts-projects
```

Then, from the repository root:

```
vercel deploy --yes                         # tend-api preview; note its URL
uv run --project api python scripts/vercel/env.py web preview --api-url https://<that URL>
(cd web && vercel deploy --yes)             # tend-web preview, proxying /api to that API preview
(cd web && vercel curl /api/health --deployment https://<web preview URL>)
(cd web && vercel curl /mi --deployment https://<web preview URL>)
```

A preview reads its environment when it is built, so a new API preview needs the `env.py web preview` line and
a new web preview. To open a preview in a browser, sign in to Vercel, or use a share link from the dashboard.

## Going live (Sanat's approval)

1. Make sure `main` has everything, the suites pass, and Neon's public schema is current:
   `make -C engine && make -C engine laws && cd api && uv run python -m tend_api.loader`.
   The loader records each state's law image hash only when the native engine is built, and only a build
   from current `main` gives the hash the device reports (`/api/jurisdictions/MI/images` should list the
   `law_image_sha256` that `web/public/engine/laws/index.json` gives for MI; the retired tlaw 1.2 image
   `54f9809e...` stays listed too, so seeing it proves nothing). Without the engine it still loads the rules and
   leaves the recorded hashes alone. The
   preview schema was loaded without it, so its `/images` lists are empty; nothing in the app reads them.
   Then put the demo bank at its start: `cd seed && uv run python reset_demo.py` must exit 0 ("at the demo
   start"). The API's own reset only deletes Tend's stale writes and puts the bill back, so it leaves alone an
   account whose seeded records, accounts, or bill ids differ from `seed/snapshots/<persona>.json`, and there
   every visitor after one payment keeps hearing "already paid".
2. API, from the repository root:
   ```
   vercel deploy --prod --yes                                   # staged: serves nothing yet
   vercel curl /api/health --deployment https://<staged URL>    # expect "ok": true, "bank": "nessie"
   vercel promote https://<staged URL> --yes                    # now https://tend-api-pi.vercel.app
   ```
3. Web, from `web/` (its production `TEND_API_URL` already points at `https://tend-api-pi.vercel.app`):
   ```
   vercel deploy --prod --yes
   vercel curl /api/health --deployment https://<staged URL>    # the proxy reaches the promoted API
   vercel curl /mi --deployment https://<staged URL>
   vercel promote https://<staged URL> --yes
   ```
4. Domain, from `web/`. The apex A record already points at Vercel (`76.76.21.21`); `www` has no record yet.
   Add `www CNAME cname.vercel-dns.com.` at the .tech registrar's DNS, then:
   ```
   vercel domains add youreowed.tech tend-web
   vercel domains add www.youreowed.tech tend-web
   vercel api /v9/projects/tend-web/domains/www.youreowed.tech -X PATCH -f redirect=youreowed.tech -F redirectStatusCode=308
   ```
5. Check from outside: `curl -sI https://youreowed.tech/mi` (200 and the `content-security-policy` header),
   `curl -s https://youreowed.tech/api/health` (`"bank": "nessie"`), then open `youreowed.tech/mi` on a phone.
   Then rehearse the Wi-Fi-off moment on the real domain: open `/check?demo=rowan` online, wait for the page
   to settle, turn Wi-Fi off, and walk Gather, the bill, and Packet. Without a service worker (`web/public/sw.js`)
   any step whose page was not already fetched fails to load; on the Oct 3 preview, Check to Gather worked offline
   and Gather to the bill did not.
   To see the demo bank put itself back, pay the $118.00 from `/check?demo=rowan`, wait 21 minutes, and tap
   **Get a code** in another browser. It should give a code, and the API's function log should have no "demo
   reset left rowan-mi alone" or "demo reset for rowan-mi did not finish" warning.

With staging on, every later `--prod` deploy waits for `vercel promote` too. To let `--prod` go live directly:
`vercel api /v9/projects/tend-web -X PATCH -F autoAssignCustomDomains=true` (and the same for `tend-api`).

## Rolling back

Each project rolls back on its own; run the command where that project is linked (`web/` for the web, the
repository root for the API).

```
vercel list tend-web --environment production      # earlier production deployments
vercel rollback https://<earlier deployment URL> --yes
vercel rollback status
```

`vercel promote https://<earlier URL> --yes` does the same through promotion. Roll both projects back together
when the API's routes changed with the web. To take the site off the domain entirely:
`vercel domains rm youreowed.tech` (the deployments stay).

## Limits worth knowing

- Vercel refuses request bodies over 4.5 MB before the API sees them (the API itself allows 16 MB). A cloud AI
  bill photo over about 3.3 MB (base64 adds a third) gets a 413; shares (2 MB cap) fit.
- A function call may run 60 s (`vercel.json`); the Gemini calls time out at 10 s.
- The API has no sign-in, and a proposal returns its own confirm code, so anyone who finds `youreowed.tech` can
  make live Nessie payments from the demo personas' accounts (only those accounts; mock money). That can change
  Rowan's balance and ledger between rehearsal and the table. If it happens, a Vercel Firewall rate limit on
  `POST /api/actions/*` (dashboard, tend-web, Firewall) or switching Production to `TEND_BANK=dry_run` and
  redeploying contains it.
- From the first tend-api deploy that includes `api/tend_api/demo_reset.py` (Going live, step 5 checks it), the
  demo account puts itself back. A paid bill line is never paid twice, so without it, after one visitor pays the
  $118.00, every later visitor hears "already paid" until someone runs `cd seed && uv run python reset_demo.py`.
  With it, when a proposal finds earlier payments of a demo bill and each was last touched more than 20 minutes ago
  (twice a code's 10 minutes; its newest audit row, or the end of its date in Detroit when the audit log does not
  know it), the API first runs `seed/reset_demo.py`'s reset on that persona, then looks again. Tend's own payments
  and demo deposits that old are deleted and the bill goes back to $443.00 pending under its id. A newer Tend
  payment anywhere on the account means someone may be mid-demo, so nothing is undone. A demo deposit has only a
  date, so it stays until 20 minutes after that day ends. The tradeoff: someone who paid and opens Track's bank
  records more than 20 minutes later may find their payment gone, if another visitor proposed one in between.
  Track's payout demo and bank records never start a reset: nothing there is blocked by an earlier visitor (a new
  demo deposit replaces an old one), and the bank records are where the visitor who paid looks for their payment.
- Nothing else on the account is touched. Records not in Tend's own formats stay where they are, and the reset's
  Nessie client refuses every other write before it is sent. An account that differs from
  `seed/snapshots/<persona>.json` in other ways (a seeded record missing or changed, an extra account or bill) is
  not reset at all, and the function log gets a warning. `cd seed && uv run python reset_demo.py` puts it back; if
  that has to recreate records, it says so, and the API's reset waits until the new snapshot is deployed with it.
  One attempt runs at a time per persona across all instances (a Postgres advisory lock; a lock in one process
  would not cover a second instance), and each write is safe to repeat. An attempt gets 8 s, waiting included.
  When it stops before undoing anything, the visitor gets the old "already paid" answer and the next proposal tries
  again. When it stops partway, what it undid stays undone. If that included the earlier payment, the proposal goes
  ahead, and Nessie's bill can show $325.00 until the next payment settles it. In the recorded replay one reset is
  52 Nessie reads and 3 writes. It runs only with `TEND_BANK=nessie`, and it adds no audit row. A scheduled reset
  was the other option: on the Hobby plan Vercel runs a cron job at most once a day, and a GitHub Actions schedule
  would need the Nessie key as a repository secret.
- Every JSON error a deployed API sends has local paths and credentials taken out: the API keys, `TEND_SECRET`,
  the database addresses, and any `?key=` in a quoted URL become `[hidden]`.
- Vercel's own request log keeps the method, path, and status of every function call, so a share id
  (`/api/shares/<id>`) and the demo persona in `/api/bank/rowan-mi/...` appear there even though the API's own
  access log drops those lines. A share id alone opens nothing: the key stays in the link's fragment.
- The CSP allows inline scripts because Next.js puts each prerendered page's data in inline scripts; a nonce
  would make every page render per request and break the offline path. Every script file, connection, frame,
  and font must come from this origin, plugins and framing are refused, and `'wasm-unsafe-eval'` lets the law
  engine compile. Engine files, law images, data, and forms are cached for an hour and then served while they
  revalidate, so a dropped connection mid-session still has them.

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
  members signed in to Vercel. The Fetch.ai agent must use `TEND_API_URL=https://youreowed.tech`.
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
  same `law_image_sha256` as the engine on the device (Michigan: `54f9809e...`). `/api/jurisdictions/{st}/asm`
  answers 503; the law pages ship their own listings.
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
   from current `main` gives the hash the device reports (`/api/jurisdictions/MI/images` should list
   `54f9809e...`). Without the engine it still loads the rules and leaves the recorded hashes alone. The
   preview schema was loaded without it, so its `/images` lists are empty; nothing in the app reads them.
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
6. Point the Fetch.ai agent at the same origin: `TEND_API_URL=https://youreowed.tech`.

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

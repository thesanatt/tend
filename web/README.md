# Tend web

Next.js (App Router, TypeScript) front end for Tend. It runs on its own with built-in fixtures, and
uses the API and the WebAssembly engine when they are present.

## Run

Everything at once, from the repo root (the API, this app, and the Fetch.ai agent when it is there):

```sh
scripts/dev.sh              # API + web (next dev) + agent; prints the URLs
scripts/dev.sh --prod       # the web app as a production build: the only mode with the offline worker
scripts/dev.sh --no-agent   # without the agent
```

It uses API_PORT 8000 and WEB_PORT 3000, or the next free ports, a local SQLite database
(`TEND_DB=neon` uses Neon from the repo `.env`), and a dry-run bank (`TEND_BANK=nessie` writes confirmed
payments to Capital One's Nessie sandbox). Open `http://localhost:<port>/check?demo=rowan`.

Tend pays a bill's lines once. With `TEND_BANK=nessie`, run `cd seed && uv run python reset_demo.py` between
rehearsals; otherwise the next $118.00 payment of Rowan's bill says Tend already paid it and nothing moves.
The dry-run bank forgets its payments when the API restarts.

Just this app:

```sh
npm install
npm run dev            # http://localhost:3000
npm test               # vitest
npm run lint && npm run typecheck && npm run build
```

End-to-end tests (Playwright for Python through uv, Chromium), one command from anywhere:

```sh
web/e2e/run.sh                    # builds, starts the API and the app, runs the demo path, offline, privacy
E2E_SKIP_BUILD=1 web/e2e/run.sh   # reuse the last e2e build
web/e2e/run.sh -k offline         # pytest options pass through
```

The API there runs in memory, with a dry-run bank and without the repo `.env`, so a run writes nothing to
Neon or Nessie and calls no model. The tests drive the judges' path (Check, Gather, the held exam line and
letter, the $118 payment with its code, the packet, a share link the advocate opens, Track), then the
survivor path with both servers stopped and the browser offline, then check that no request carried
transaction text, a bill line, or the share key. Step timings print at the end.

## Offline (airplane mode)

In a production build the flow registers `public/sw.js` on its first visit. It saves the flow's pages and
their page data, the WebAssembly engine, every state's compiled law image, verified rules and law
summary, and Michigan's form (public files only, never anyone's answers), then sets
`<html data-offline="ready">`. After that, Check, reading a statement or a bill, the claim, the packet and
letters, and the vault work with the network off, and a reload works too. A payment or a share link needs
the network: offline it says so, sends nothing, and offers Try again. The worker never touches `/api/*`.
Bump `VERSION` in `sw.js` when it changes. `NEXT_PUBLIC_TEND_SW=1` turns it on in `next dev`.

The privacy line comes from what actually left: `lib/netlog.ts` watches every `fetch` the page makes and
reports each request that carries something off the device (a payment, a share, the bank, the server
engine, cloud AI, or anything unexpected), so the line cannot miss a send.

## Screens

The survivor flow lives in `app/(flow)` and `components/flow` (docs/UX.md). Every string comes from
`lib/i18n` (English and Spanish, typed so a missing key fails the build).

| Route            | What it shows                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/`              | The law garden: one plant per state, grown by verified rule count; counts fixed at build                                              |
| `/[st]`          | A state's public page (`/mi`): what its law promises, every line cited, share card                                                    |
| `/[st]/card.png` | The 1200x630 share card for that state (next/og, static PNG made at build)                                                            |
| `/check`         | Check: four questions (Not sure always allowed) and a cited summary                                                                   |
| `/gather`        | Gather: statement upload, demo bank, bills; costs in groups with yes / no                                                             |
| `/gather/bills`  | Bill triage: held lines with the law and a letter, then pay or claim                                                                  |
| `/packet`        | Packet: the state's form, cited summary, still needed, where to file, share                                                           |
| `/track`         | Track: the garden as the status tracker; the deadline stays in view                                                                   |
| `/law/[st]`      | How Tend decides: verified rules with what the engine does with each, set-aside rules, sources with SHA-256, and the compiled listing |
| `/share`         | Opens an end-to-end encrypted share link (`/share#<id>.<key>`) in the browser                                                         |
| `/share/[token]` | Read-only advocate view (`/share/demo` works with fixtures)                                                                           |

`/start`, `/ledger`, `/bill`, `/claim`, and `/garden` redirect to the new steps. `/check?demo=rowan`
fills in the fictional demo answers.

The flow codes against `lib/contracts.ts` and imports the real modules by those paths (`lib/local`,
`lib/vault`, `lib/share`, `lib/packet`); the flow's own tests use the thin mocks in `lib/mocks`, and
`tests/flow-trust.test.tsx` drives the screens on the real vault, share, and packet modules.

## Where the claim math runs

`lib/engine/index.ts` picks a backend for every evaluation:

1. **WebAssembly on the device** when `public/engine/tend.js` exists (checked at server start) and
   `public/engine/laws/<ST>.tlaw` exists for the state (`make -C ../engine wasm` builds both).
2. **The API** (`POST /api/claim`) only when the caller passes `allowApi`. The flow asks the survivor
   first, because that sends the claim off the device, and the privacy line says so afterward.

There is no third engine. Without either, the screens say the law could not be checked.

## Configuration

| Variable               | Default                                   | Effect                                  |
| ---------------------- | ----------------------------------------- | --------------------------------------- |
| `TEND_API_URL`         | unset                                     | Proxies `/api/*` to the FastAPI service |
| `NEXT_PUBLIC_EXIT_URL` | `https://www.google.com/search?q=weather` | Where Exit this page goes               |

Without `TEND_API_URL` nothing is sent anywhere: the demo bank is a copy of Rowan's fictional Nessie
account that ships with the app, and a payment walks through the same confirm sheet and ends with
"Nothing was sent."

## API calls the app makes

The survivor flow calls the API only for what the survivor sends: `POST /api/actions/propose
{from_account_id, payee, amount_cents}` and `POST /api/actions/confirm {action_id, confirm_code}` for a
payment, `POST /api/claim <engine input>` after they agree to check on the server, a sealed share
through `lib/share` (`POST /api/shares` with the ciphertext only; `DELETE` stops a link), and, only after
a yes on the cloud AI consent screen, `POST /api/ai/classify` or `POST /api/ai/bill` for one file. The
share key stays in the link's `#fragment`. The law and advocate pages also use `GET /api/jurisdictions`,
`GET /api/jurisdictions/{st}`, `GET /api/jurisdictions/{st}/asm`, and `GET /api/shares/{id}`.
Response shapes are in `lib/types.ts`; examples are in `fixtures/` (Rowan from the seed, made by
`uv run --project api python web/scripts/scan-fixtures.py` and `npm run fixtures`).

## Data

- `public/data/jurisdictions.json`: all 51 jurisdictions as `{st, name, rules, sources, ...}`, plus the
  IR's decision, information, and set-aside counts.
- `public/data/law/<ST>.json`: byte-for-byte copies of `rules/verified/<ST>.json`.
- `public/data/ir/<ST>.json`: `rules/ir/<ST>.json` without the program block, with the IR's SHA-256 and
  whether it was made from the current verified file.
- Refresh these after research changes: `npm run sync:rules -- ../rules` (or a path to `rules/`), then
  `npm run fixtures`.
- `public/data/asm/<ST>.txt` and `index.json`: the compiled listing for each state. `npm run sync:asm`
  runs `../engine/build/tdis` on `public/engine/laws/<ST>.tlaw` (or `../engine/build/laws`), falls back
  to `TEND_API_URL`, and otherwise keeps the committed listings. `npm run build` runs it first.
- `NEXT_PUBLIC_SITE_URL` (default `https://youreowed.tech`) is the address printed on share cards and
  used for their Open Graph links.
- `fixtures/`: Rowan's fictional Michigan scan, engine input and output, the bill audit, the advocate
  view, and a stand-in compiled listing. `npm run fixtures` rebuilds the engine fixtures with the
  WebAssembly engine.
- `components/flow/samples/rowan.ts`: the sample statement rows and the sample itemized bill (PDF),
  generated from `seed/snapshots/rowan-mi.json` and `seed/bills/rowan-mi-riverbend.pdf`. Fictional.

## Privacy and safety

Answers and costs live in memory. Save this puts them in the encrypted vault on the device (`lib/vault`,
AES-256-GCM in IndexedDB), behind Touch ID (a passkey with PRF) or a passcode; nothing is written in the
clear. The vault locks itself after 5 minutes without a tap or key, and the screen clears with it.
Exit this page also closes any on-device AI session. The line under the header says where the data
is and changes only when something is sent (a confirmed payment, a share link, or, with consent, a
claim checked on the server). Exit this page (or Esc twice) locks the vault, blanks the screen,
clears the tab, and replaces the history entry. Tend stores no names and never asks what happened.
Responses send `Referrer-Policy: no-referrer`, so opening a source link does not reveal the page it
came from.

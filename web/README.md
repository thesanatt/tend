# Tend web

Next.js (App Router, TypeScript) front end for Tend. It runs on its own with built-in fixtures, and
uses the API and the WebAssembly engine when they are present.

```sh
npm install
npm run dev            # http://localhost:3000
npm test               # vitest
npm run lint && npm run typecheck && npm run build
```

## Screens

The survivor flow lives in `app/(flow)` and `components/flow` (docs/UX.md). Every string comes from
`lib/i18n` (English and Spanish, typed so a missing key fails the build).

| Route            | What it shows                                                                 |
| ---------------- | ----------------------------------------------------------------------------- |
| `/`              | The law garden: one plant per state, grown by verified rule count             |
| `/check`         | Check: four questions (Not sure always allowed) and a cited summary           |
| `/gather`        | Gather: statement upload, demo bank, bills; costs in groups with yes / no     |
| `/gather/bills`  | Bill triage: held lines with the law and a letter, then pay or claim          |
| `/packet`        | Packet: the state's form, cited summary, still needed, where to file, share   |
| `/track`         | Track: the garden as the status tracker; the deadline stays in view           |
| `/law/[st]`      | A state's verified rules, sources with SHA-256, and the compiled listing      |
| `/share/[token]` | Read-only advocate view (`/share/demo` works with fixtures)                   |

`/start`, `/ledger`, `/bill`, `/claim`, and `/garden` redirect to the new steps. `/check?demo=rowan`
fills in the fictional demo answers.

The flow codes only against `lib/contracts.ts`. `lib/local`, `lib/vault`, `lib/share`, and
`lib/packet` are placeholders over `lib/mocks` until those modules land; tests use `lib/mocks`.

## Where the claim math runs

`lib/engine/index.ts` picks a backend for every evaluation:

1. **WebAssembly on the device** when `public/engine/tend.js` exists (checked at server start) and
   `public/engine/laws/<ST>.tlaw` exists for the state (`make -C ../engine wasm` builds both).
2. **The API** (`POST /api/claim`) only when the caller passes `allowApi`. The flow asks the survivor
   first, because that sends the claim off the device, and the privacy line says so afterward.

There is no third engine. Without either, the screens say the law could not be checked.

## Configuration

| Variable              | Default                                  | Effect                                        |
| --------------------- | ---------------------------------------- | --------------------------------------------- |
| `TEND_API_URL`        | unset                                    | Proxies `/api/*` to the FastAPI service       |
| `NEXT_PUBLIC_EXIT_URL`| `https://www.google.com/search?q=weather`| Where Exit this page goes                     |

Without `TEND_API_URL` nothing is sent anywhere: the demo bank is a copy of Rowan's fictional Nessie
account that ships with the app, and a payment walks through the same confirm sheet and ends with
"Nothing was sent."

## API calls the app makes

The survivor flow calls the API only for what the survivor sends: `POST /api/actions/propose
{from_account_id, payee, amount_cents}` and `POST /api/actions/confirm {action_id, confirm_code}` for a
payment, and `POST /api/claim <engine input>` after they agree to check on the server. Shares go
through `lib/share`. The law and advocate pages also use `GET /api/jurisdictions`,
`GET /api/jurisdictions/{st}/asm`, and `GET /api/share/{token}`.
Response shapes are in `lib/types.ts`; examples are in `fixtures/`.

## Data

- `public/data/jurisdictions.json`: all 51 jurisdictions as `{st, name, rules, sources, ...}`.
- `public/data/law/<ST>.json`: byte-for-byte copies of `rules/verified/<ST>.json`.
- Refresh both after research changes: `npm run sync:rules -- ../rules` (or a path to `rules/`).
- `fixtures/`: Rowan's fictional Michigan scan, engine input and output, the bill audit, the advocate
  view, and a stand-in compiled listing. `npm run fixtures` rebuilds the engine fixtures with the
  WebAssembly engine.
- `components/flow/samples/rowan.ts`: the sample statement rows and the sample itemized bill (PDF),
  generated from `seed/snapshots/rowan-mi.json` and `seed/bills/rowan-mi-riverbend.pdf`. Fictional.

## Privacy and safety

Answers and costs live in memory. Save this puts them in the encrypted vault on the device, behind
Touch ID or a passcode; nothing is written in the clear. The line under the header says where the data
is and changes only when something is sent (a confirmed payment, a share link, or, with consent, a
claim checked on the server). Exit this page (or Esc twice) locks the vault, blanks the screen,
clears the tab, and replaces the history entry. Tend stores no names and never asks what happened.
Responses send `Referrer-Policy: no-referrer`, so opening a source link does not reveal the page it
came from.

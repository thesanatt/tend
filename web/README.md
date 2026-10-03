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
payment, `POST /api/claim <engine input>` after they agree to check on the server, and a sealed share
through `lib/share` (`POST /api/shares`, or the API's `POST /api/share` with `ciphertext` and `nonce`;
`DELETE` stops a link). The key stays in the link's `#fragment`. The law and advocate pages also use
`GET /api/jurisdictions`, `GET /api/jurisdictions/{st}/asm`, and `GET /api/share/{token}`.
Response shapes are in `lib/types.ts`; examples are in `fixtures/`.

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

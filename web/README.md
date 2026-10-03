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

| Route            | What it shows                                                                 |
| ---------------- | ----------------------------------------------------------------------------- |
| `/`              | The law garden: one plant per state, grown by verified rule count; counts fixed at build |
| `/[st]`          | A state's public page (`/mi`): what its law promises, every line cited, share card |
| `/[st]/card.png` | The 1200x630 share card for that state (next/og, static PNG made at build)    |
| `/start`         | State, date, optional questions, consent to read the account                  |
| `/ledger`        | Costs in beds, status and citation per line, yes / no / not sure on guesses   |
| `/bill`          | Itemized bill with the exam line held and the law beside it; pay the rest     |
| `/claim`         | Amount you can ask for, checks, packet, share link, compare states            |
| `/claim/packet`  | Printable packet: each cost with its record id, rule ids, and quoted law      |
| `/garden`        | The survivor's garden: plants grow only for money that comes back            |
| `/law/[st]`      | How Tend decides: verified rules with what the engine does with each, set-aside rules, sources with SHA-256, and the compiled listing |
| `/share/[token]` | Read-only advocate view (`/share/demo` works with fixtures)                   |

## Where the claim math runs

`lib/engine/index.ts` picks a backend for every evaluation, in this order:

1. **WebAssembly on the device** when `public/engine/tend.js` exists (checked at server start) and
   `public/engine/laws/<ST>.tlaw` exists for the state. Build flags the loader expects:
   `-sMODULARIZE=1 -sEXPORT_NAME=createTendModule` (or `-sEXPORT_ES6=1`), exporting
   `_tend_eval_json, _tend_disasm, _tend_version, _tend_free, _malloc, _free` and `HEAPU8`.
   Strings and law images go through `_malloc`, never the wasm stack.
2. **The API** (`POST /api/claim`) when `TEND_API_URL` is set and answers. The engine name comes from
   the `x-tend-engine` response header.
3. **A TypeScript preview** of the SPEC semantics (`lib/engine/preview.ts`), labeled "Preview engine
   in this browser" in the footer and the audit trail. It exists so the demo works with nothing else
   running. Where the SPEC leaves room it makes the same readings as the Python reference
   (`refengine/README.md`), so lines, totals, checks, and the trace match whichever backend runs.
   `tests/parity.test.ts` replays reference outputs for every state; rebuild them with
   `python3 scripts/parity-fixtures.py --refengine ../refengine` after the rules or the reference change.

## Configuration

| Variable              | Default                                  | Effect                                        |
| --------------------- | ---------------------------------------- | --------------------------------------------- |
| `TEND_API_URL`        | unset                                    | Proxies `/api/*` to the FastAPI service       |
| `NEXT_PUBLIC_EXIT_URL`| `https://www.google.com/search?q=weather`| Where Exit this page goes                     |

Without `TEND_API_URL` the app uses `fixtures/` and says "built-in demo fixtures" in the footer. A
payment in that mode walks through the same confirm sheet and ends with "Nothing was sent."

## API calls the app makes

`GET /api/jurisdictions`, `POST /api/scan {persona_id, st, incident_date}`,
`POST /api/bill/audit {bill_id, persona_id}`, `POST /api/claim <engine input>`,
`POST /api/actions/propose {kind: "pay_bill", bill_id, item_ids, amount_cents, from_account_id, payee}`,
`POST /api/actions/confirm {action_id, confirm_code}`, `POST /api/share {input, output}`,
`GET /api/share/{token}`, `GET /api/jurisdictions/{st}/asm`, `GET /api/packet/{claim_id}.pdf`.
Response shapes are in `lib/types.ts`; examples are in `fixtures/`.

## Data

- `public/data/jurisdictions.json`: all 51 jurisdictions as `{st, name, rules, sources, ...}`, plus the
  IR's decision, information, and set-aside counts.
- `public/data/law/<ST>.json`: byte-for-byte copies of `rules/verified/<ST>.json`.
- `public/data/ir/<ST>.json`: `rules/ir/<ST>.json` without the program block, with the IR's SHA-256 and
  whether it was made from the current verified file.
- Refresh these after research changes: `npm run sync:rules -- ../rules` (or a path to `rules/`), then
  `npm run fixtures` and `python3 scripts/parity-fixtures.py --refengine ../refengine`.
- `public/data/asm/<ST>.txt` and `index.json`: the compiled listing for each state. `npm run sync:asm`
  runs `../engine/build/tdis` on `public/engine/laws/<ST>.tlaw` (or `../engine/build/laws`), falls back
  to `TEND_API_URL`, and otherwise keeps the committed listings. `npm run build` runs it first.
- `NEXT_PUBLIC_SITE_URL` (default `https://youreowed.tech`) is the address printed on share cards and
  used for their Open Graph links.
- `fixtures/`: Rowan's fictional Michigan scan, engine input and output, the bill audit, the advocate
  view, and a stand-in compiled listing. `npm run fixtures` rebuilds the engine fixtures.
- `fixtures/parity/<ST>.json`: reference engine outputs for random claims and Rowan's costs in every
  state, tied to the sha256 of the law file they were made from.

## Privacy and safety

Answers live in this browser tab only (`sessionStorage`). Exit this page (or Esc twice) blanks the
screen, clears that storage, and replaces the history entry; a page restored later from the back
cache reloads blank. Tend stores no names and never asks what happened. Responses send
`Referrer-Policy: no-referrer`, so opening a source link does not reveal the page it came from.

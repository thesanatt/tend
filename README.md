# Tend

Tend helps a sexual assault survivor recover what their state's crime victim compensation
program already promises, in all 50 states and DC. docs/SPEC.md is the full spec. Each
folder has its own README.

| Folder | What it is |
|---|---|
| `engine/` | C++20 law compiler and bytecode VM, also built to WebAssembly |
| `refengine/` | Python reference engine, compared with `engine/` byte for byte |
| `rules/` | the verified law corpus and the tools that build it |
| `seed/` | fictional demo data on Capital One's Nessie mock bank |
| `api/` | FastAPI service |
| `web/` | Next.js app |
| `agent/` | Fetch.ai uAgent for ASI:One |
| `docs/` | spec, privacy, UX, and test results |

## Build and test

You need a C++20 compiler with `make`, [uv](https://docs.astral.sh/uv/), and Node 22 or newer.
uv fetches Python 3.12 if you do not have it. Emscripten is only needed to rebuild the
WebAssembly engine; the built one is committed in `web/public/engine/`.

```sh
git clone https://github.com/thesanatt/tend.git
cd tend
make -C engine && make -C engine test
(cd refengine && uv run pytest)
(cd seed && uv run pytest)
(cd api && uv run pytest)
(cd agent && uv run pytest)
(cd web && npm ci && npx tsc --noEmit && npx vitest run && npx next build)
```

Build the engine first. Without `engine/build`, the refengine and api tests that compare
against the C++ engine are skipped instead of run.

No test needs a key. Tests that talk to a real service are skipped unless you turn them on:
`TEND_LIVE=1` in `seed/` (needs a Nessie key) and `TEND_NEON_TEST=1` in `api/` (needs a Neon
database URL).

## Run it

```sh
cd web && npm run dev    # http://localhost:3000, runs on built-in fixtures
```

The API runs offline on SQLite. From `api/`: `uv run python -m tend_api.loader`, then
`uv run uvicorn tend_api.main:app --port 8000`. The agent talks to the API; see
`agent/README.md`.

# Tend: a guide for judges

Two parts: a 60-second tour of the app, and a 5-minute list of claims, each with the file that
implements it, the test that proves it, and the command to run. All people and money in the demo
are fictional. The bank is Capital One's Nessie mock bank.

## 60 seconds

Open **https://youreowed.tech/check?demo=rowan** (or run it locally: README.md, "Run it"). A phone
or a laptop both work.

| Seconds | Do this | Notice |
|---|---|---|
| 0 to 10 | Read the Check page. The demo answers are filled in: Michigan, June 14, 2026, exam yes, report no | No name, no account, no "what happened". The line under the header says "On this device. Nothing has left it." Every sentence has a citation; tap one (for example `MCL 18.355a(10)`) to see the verbatim quote and a link that opens the statute at that sentence |
| 10 to 20 | **Find my costs**, then **Use the demo bank account**, then **Add another record** and **Use a sample bill** | The statement and bill are read in the browser. Costs come in groups, each with the law behind it. Inferred lines ask "Was this ride to care? Yes / No / Not sure". Tap **Yes to all** on each group |
| 20 to 35 | **Next: your bill** | The $443.00 Riverbend General bill: the $325.00 forensic exam line is **Held**, with the quote from MCL 18.355a(2). **Get a letter for the billing office** shows a letter that quotes the law |
| 35 to 45 | **Pay $118.00 now from Checking 0011**, then **Get a code**, type the six digits, **Pay $118.00** | Nothing moves until the code is typed. The result says the bank's record matches and the bill now shows only the held $325.00. The header line now names the payment |
| 45 to 55 | **Build my packet**, then **Make a share link** | Michigan's own form with safe fields only, a cited summary PDF, "Still needed" in the program's words. "Amount you can ask for: $3,848.00. The program decides." The link's key is after `#`; open it in another browser to see the advocate's read-only view |
| 55 to 60 | **See your garden** | One plant per cost, with the deadline in view. The held exam line grows nothing |

For the law itself: **https://youreowed.tech/law/mi** lists every verified Michigan rule, what
the engine does with it, the saved sources with their sha256, and the compiled bytecode listing.

The total is $3,848.00 in a browser without Gemini Nano. With a model sorting two more lines
(sheets and a door chain), as in the agent run, it is $4,008.00. docs/EVAL.md explains.

## 5 minutes: check the claims

Setup once, from the repository root: `make -C engine` (about a minute). Every command below is
run from the root unless it says `cd`. All of them work offline with no keys.

| # | Claim | Implemented in | Proved by | Command |
|---|---|---|---|---|
| 1 | Every rule quotes its official source word for word, and the saved source still has its sha256 | `rules/tools/verify.py` | the verifier itself, over all 51 files | `python3 rules/tools/verify.py all` (51 PASS, no file changes) |
| 2 | Each state's law is compiled to bytecode, and the shipped image is exactly what the compiler builds | `engine/src/compiler.cpp`, `engine/tools/tendc.cpp` | `engine/tests/test_corpus.cpp`: "the law images shipped to the browser are the ones tendc builds now" | `make -C engine test`; `shasum -a 256 web/public/engine/laws/MI.tlaw` gives `54f9809e...` |
| 3 | The compiled law is readable, with each rule's pinpoint and quote | `engine/src/disasm.cpp` | `engine/tests/test_capi.cpp`: "the listing comments each rule block with pinpoint and quote start" | `engine/build/tdis web/public/engine/laws/MI.tlaw \| grep -A4 "; MI-EXAM-1"` |
| 4 | A law image is checked byte by byte before it runs; malformed bytecode is refused, never executed | `engine/src/image.cpp` (`Loader::verify`, line 381) | `engine/tests/test_loader.cpp`: "verifier rejects malformed bytecode", "every single-byte corruption is caught by the checksum" | `make -C engine test` |
| 5 | Two independent engines give byte-identical results | `engine/` (C++), `refengine/tend_ref/` (Python) | `refengine/difftest.py` (121,000 claims, 0 mismatches) | `uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000` (about 1 minute) |
| 6 | The browser runs the same engine as the server | `engine/scripts/build_wasm.sh`, `web/lib/engine/index.ts` | `engine/tests/wasm_parity.mjs` (106,000 of 106,000 identical) | `make -C engine wasm-parity` |
| 7 | The claim never leaves the device unless the survivor says yes | `web/lib/engine/index.ts` | `web/tests/engine-adapter.test.ts`: "never sends the claim to the server without the survivor's yes" | `cd web && npm ci && npx vitest run tests/engine-adapter.test.ts` |
| 8 | A forensic exam line is held when the state has an exam no-bill rule | engine item program (engine/FORMAT.md section 4) | `engine/tests/test_semantics.cpp`: "step 2: forensic exams are held only when an exam_no_bill rule exists" | `make -C engine test` |
| 9 | The held line cannot be paid, through any route | `api/tend_api/actions.py` | `api/tests/test_actions.py::test_held_bill_line_cannot_be_paid` | `cd api && uv run pytest tests/test_actions.py -k held` |
| 10 | Money moves only after a 6-digit code: once, within 10 minutes, locked after 5 wrong tries, never stored in the clear | `api/tend_api/actions.py:49`, `:126`, `:241` | `test_actions.py`: `test_wrong_code_is_rejected_then_locks_after_five`, `test_code_expires_after_ten_minutes`, `test_code_is_never_stored_or_logged`, `test_concurrent_confirms_execute_exactly_once` | `cd api && uv run pytest tests/test_actions.py` |
| 11 | The payment log is append-only and hash-chained, with no names | `api/tend_api/db/migrations/postgres/0003_payments.sql` (triggers), `api/tend_api/actions.py` | `test_actions.py::test_audit_table_is_append_only_and_extends_only_its_head`, `::test_verify_chain_detects_tampering`; `test_privacy.py::test_audit_log_holds_no_names` | `cd api && uv run pytest tests/test_actions.py tests/test_privacy.py` |
| 12 | A shared packet is encrypted in the browser; the server sees only ciphertext; the key never leaves the link | `web/lib/share/index.ts` | `web/tests/share.test.ts`: "seals, opens to the same packet, and never sends the key"; `api/tests/test_privacy.py::test_sealed_share_returns_exactly_the_ciphertext` | `cd web && npx vitest run tests/share.test.ts` |
| 13 | Saved progress is encrypted (AES-256-GCM, PBKDF2-SHA-256 with 600,000 iterations, or a passkey) | `web/lib/vault/crypto.ts:5` | `web/tests/vault.test.ts`: "round-trips records and keeps only ciphertext in storage", "uses PBKDF2 with 600,000 iterations and a random salt by default" | `cd web && npx vitest run tests/vault.test.ts` |
| 14 | The state form gets only allowlisted, safe fields; name, signature, SSN, and crime details stay blank | `web/lib/packet/specs.ts` (`NEVER_FILL`, line 88), `web/lib/packet/forms.ts` | `web/tests/packet.test.ts`: "fills only allowlisted fields of the Michigan application", "refuses anything outside it, and a changed blank form" | `cd web && npx vitest run tests/packet.test.ts` |
| 15 | Cloud AI runs only after an explicit yes, and the model never sees amounts | `api/tend_api/ai.py:134` | `api/tests/test_ai.py::test_nothing_happens_without_consent`, `::test_rules_first_then_the_model_without_amounts`, `::test_cloud_ai_stores_nothing` | `cd api && uv run pytest tests/test_ai.py` |
| 16 | A model only suggests a label; it can never mark a forensic exam or lost pay | `web/lib/local/classify.ts:262` | `web/tests/local/classify.test.ts`: "never takes a forensic exam or lost pay from a model" | `cd web && npx vitest run tests/local/classify.test.ts` |
| 17 | Money is integer cents everywhere | `api/tend_api/money.py`, engine/FORMAT.md section 5 | `api/tests/test_money_models.py::test_integer_cents_guard_rejects_floats_bools_strings` | `cd api && uv run pytest tests/test_money_models.py` |
| 18 | Each version of the law is a Neon branch, and two versions can be compared rule by rule | `scripts/neon/law_versions.py`, `api/tend_api/law.py` | `api/tests/test_law.py::test_a_state_diff_reads_both_branches` (offline, SQLite stands in for branches); `test_neon_law.py` on real Neon | `cd api && uv run pytest tests/test_law.py` |
| 19 | The agent never passes on a message that describes what happened | `agent/tend_agent/parse.py` (`story_kind`, line 362), `agent/tend_agent/navigator.py` | `agent/tests/test_navigator.py::test_story_is_never_passed_on`, `agent/tests/test_parse.py::test_story_guard` | `cd agent && uv run pytest tests/test_navigator.py tests/test_parse.py` |
| 20 | The whole loop works through three Fetch.ai agents: Check, held exam line, $118.00 paid with a typed code, sealed share opened with its key | `agent/tend_agent/` | `agent/scripts/rehearse.py` (writes agent/REHEARSAL.md; 4.0 s on Oct 4) | start the API (README.md, "Run it"), then `cd agent && uv run python scripts/rehearse.py` |

## What Tend does not claim

- It is not legal advice and decides nothing. It shows what the state's own rules say, with the
  quote, and every total says "The program decides."
- It files nothing. The survivor sends the packet.
- Only Michigan's application is pre-filled; the other 50 get the program's blank form or a note.
- The demo data is fictional, and the bank is a mock. No real money moves.
- Known test failures in this checkout, with causes, are listed in docs/EVAL.md.

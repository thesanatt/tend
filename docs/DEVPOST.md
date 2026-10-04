# Tend (Devpost draft)

## Inspiration

Every state and DC runs a crime victim compensation program, written into law. For a sexual
assault survivor it can pay for counseling, lost pay, moving, and medical bills. In the corpus I
verified, 49 of 51 jurisdictions also say the survivor should not be billed for the forensic exam.
Getting the money still means finding the statute, the deadline, and the form, then matching bank
charges to covered costs. Tax software solved this for another form. I wanted that for this one,
without asking anyone for a name or a story.

## What it does

Tend is local-first. In the demo, a fictional survivor, Rowan, answers four questions (state,
date, exam, police report). Tend reads Rowan's bank history from Capital One's Nessie mock bank and
an itemized hospital bill, in the browser, and proposes costs with the law behind each one.

The $443.00 Riverbend General bill has a $325.00 forensic exam line. Tend holds it, quotes
MCL 18.355a(2) ("A health care provider shall not submit a bill for any portion of the costs of a
sexual assault medical forensic examination to the victim"), and writes a letter to the billing
office. The other $118.00 is paid only after Rowan types a 6-digit code from the server.

Then Tend builds the packet on the device: Michigan's own application with safe fields only, a
cited summary, and a still-needed checklist. A share link encrypts it for an advocate; the server
stores only ciphertext. The total reads "Amount you can ask for: $3,848.00. The program decides."
That is with the rules alone; when a model sorts two more lines, it is $4,008.00. Tend is not legal
advice. The same flow runs in ASI:One through three Fetch.ai agents.

## How I built it

**The law as data.** I saved 824 official sources for 51 jurisdictions with their sha256 and wrote
2,578 rules. `rules/tools/verify.py` accepts a rule only if its quote is a verbatim substring of
the saved source and every number in it appears in the quote. `normalize.py` turns 51 legal styles
into one IR: 1,331 decision rules, 1,187 for display, and 60 set aside with a written reason.

**A compiler and a VM.** `tendc` (C++20) compiles each state's IR into a `.tlaw` image: header,
rule table, two bytecode programs, and a sha256 trailer. The loader runs a bytecode verifier
(forward jumps, stack depth, one decision per line) before anything executes, and every result
names the rules behind each cent. Emscripten builds the same C++ into a 183 KB WebAssembly module.

**Checking it three ways.** I wrote a Python reference engine and a separate C++ oracle from the
same spec. `refengine/difftest.py` compared 121,000 claims with 0 mismatches, and 106,000 of 106,000
were byte-identical between WebAssembly and native.

**The app.** Next.js. Costs are sorted by rules first, then Gemini Nano through Chrome's Prompt
API, limited to fixed labels; cloud Gemini only after a yes. Saved progress is AES-256-GCM in
IndexedDB, behind a passkey or a passphrase.

**The server.** FastAPI on Vercel with Neon Postgres holds the public corpus, share ciphertext, and
a hash-chained payment log whose triggers refuse updates and deletes. Each version of the corpus is
its own Neon branch, and a claim names the version it used. Nessie holds four fictional personas.
The agents are uAgents: Navigator, Law, and Bank and Packet. The site is youreowed.tech, and Figma
holds the design system, built by scripts through the Plugin API.

## Challenges I ran into

- Fifty-one legal systems do not share a format. Caps are per claim, per session, per week, or per
  mile; deadlines count from the crime, the report, or discovery. Rules that apply to family members
  go to `skipped` with a reason, so they never touch the survivor's own claim.
- Byte-identical engines forced me to settle the gaps in my own spec: error messages, integer
  bounds, repeated keys, what `null` means. engine/FORMAT.md sections 4 and 5 hold those answers.
- In Chrome, Gemini Nano labeled a phone bill payment as lost wages. Now a model can never set
  `lost_wages` or `forensic_exam`; code decides those.
- Privacy versus helpfulness: a typed search box would send text to the server, so the state
  pages do not have one.

## Accomplishments that I'm proud of

- Every dollar points to a transaction, a rule, and a verbatim quote with its source hash.
- The held exam line cannot be paid through the app, the agent, or the API
  (`test_held_bill_line_cannot_be_paid`).
- The Michigan law image is the same 51,812 bytes on macOS and Linux.
- Nothing in the schema can hold what happened, where, or who.

## What I learned

- Implementing my spec twice and diffing the results showed me where it was vague. FORMAT.md
  section 4 now lists 7 choices the spec had left open.
- An on-device model works best as a suggester. The survivor says yes or no, and code decides.
- The verbatim-quote rule kept me honest. If I could not quote it, Tend could not use it.

## What's next

- Pre-fill more states' forms. Only Michigan's is filled today; the rest link the program's form.
- Flag deadlines that count from discovery, and count "today" in each state's own time zone
  (SPEC v1.3, on a branch now).
- Re-fetch sources on a schedule, with a new Neon branch whenever a law changes.
- Measure Gemini Nano on the two 32-row held-out sets. The harness exists; no result is committed.

## Built with

- C++20
- WebAssembly (Emscripten)
- Python
- FastAPI
- TypeScript
- Next.js
- React
- pdf.js
- pdf-lib
- Web Crypto API
- IndexedDB
- WebAuthn
- Gemini Nano (Chrome Prompt API)
- Google Gemini API
- Capital One Nessie API
- Fetch.ai uAgents
- Agentverse
- ASI:One
- Neon Postgres
- Vercel
- Figma
- .tech domain (youreowed.tech)
- uv
- pytest
- Vitest
- doctest

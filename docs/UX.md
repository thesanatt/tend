# Tend: the survivor flow (contract for web/ and api/)

Usability beats features. A survivor uses Tend on a phone, possibly late at night, possibly on a
shared device, after the worst week of their life. Every screen has one next action. Nothing asks
what happened, who did it, or where.

## Stay Jane Doe (the principle behind every screen)
No account, no name, no story. Everything happens on the device unless the survivor chooses to send something. The survivor's name appears only
on the state's own form at the very end, typed by them. Tend surfaces the legal protections that
can keep their address and claim records private: the address confidentiality program (a
substitute address for government forms, where the program covers survivors) and the rules on who
can see claim records, both cited like every other rule.

## Share cards (awareness, the biggest barrier)
Every jurisdiction gets a public page and a share card generated only from verified rules, e.g.
"If you're Jane Doe in Michigan: you can ask for up to $45,000, and a forensic exam can count
instead of a police report. youreowed.tech/mi". Anyone can post it, so posting it reveals nothing about the
person sharing. No tracking on these pages.

## The three steps

### 1. Check (about 2 minutes, nothing shared)
Four inputs, all optional to answer precisely ("Not sure" is always allowed):
- state (51 jurisdictions)
- date it happened (only the date)
- had a forensic exam: yes / no / not sure
- reported to police: yes / no / not yet

Output, computed by the engine from verified rules, each sentence carrying its citation:
- "You can likely apply in {state}." (never "you qualify")
- filing deadline as a date, with the rule
- whether a police report is needed, and which alternatives count (exam, protective order, advocate)
- what is covered, as a short list with caps ("Counseling, up to $125 a session")
- the program phone and website, from the verified corpus
- one button: "Find my costs" (goes to step 2). Also "Save this" and "Not today".

### 2. Gather (taps, not typing)
Inputs, in this order of privacy:
1. Upload a bank statement (CSV, OFX, or PDF). Parsed on the device where possible. Default option.
2. Connect a bank (demo: Capital One via Nessie, fictional customer, clearly labeled).
3. Photo or PDF of a bill. Line items are extracted and must sum to the bill total, or the bill is
   shown as "couldn't read this reliably" with the original image.

Tend proposes costs in groups (Care, Counseling, Getting there, Home, Work). Each line shows the
transaction, the amount, and the plain-English reason with the law behind it. The survivor answers:
- direct matches: pre-checked, one tap to uncheck
- inferred lines (a ride on a counseling day, a dip in pay): "Was this ride to care? Yes / No / Not sure"
- groups: "Confirm all 12 counseling sessions" with the list visible
Not covered items are shown, not hidden, with the rule that excludes them.

Bill triage, for each bill:
- held lines (e.g. a forensic exam the law says cannot be billed): "Don't pay this line." Primary
  action: a ready-to-send letter to the billing office citing the law; secondary: the exam payment
  program's contact.
- remaining balance: "Pay now from Checking" (confirm code) or "Leave unpaid and claim it". Both
  are fine; the screen says which costs the program can repay either way.

### 3. Packet (what finishes the job)
- The state's own application, pre-filled from an allowlist of safe fields only (Michigan's today;
  other states get the program's blank form when Tend found one). Signature, crime details,
  offender, location, and SSN fields stay blank with a note: "Only you fill these in."
- A cited summary: every line that counts or is held, with amount, transaction, rule, quote, and
  link.
- "Still needed" checklist, specific to the state and the lines claimed, each with a template:
  ID copy, itemized bills (attached when uploaded), employer wage letter (template to send),
  counseling provider statement (template), exam documentation if the state uses it for reporting.
- Where and how to file (mail address, upload portal, phone) from the verified corpus.
- Share with an advocate: an expiring read-only link to the same packet.
- Totals read: "Amount you can ask for: $X. The program decides."

### Track (the garden)
One plant per claim line. Stage = real status: sprout (confirmed), leaf (document attached),
bud (filed), bloom (paid). The deadline is always visible. Reminders are opt-in, with neutral text.

## Always on
- Local-first and encrypted (docs/PRIVACY.md is the contract). A small persistent line on every
  screen says what is happening: "On this device. Nothing has left it since this page opened." It
  changes when something leaves the device: the state's law request, a payment set up or
  confirmed, an encrypted share, a check on Tend's server, cloud AI, a request to the demo bank, or
  any request the flow did not expect.
- Unlock the saved vault with Touch ID (passkey) or a passphrase.
- Quick exit: corner button and Esc twice; replaces the page with a neutral one.
- Neutral tab title ("Tend"). No push notifications. No analytics.
- Pause and resume: nothing is kept until the survivor taps Save this. Then progress is stored on the
  device, encrypted, and locked with Touch ID or screen lock (a passkey) or a passcode of at least 6
  characters. It locks itself after 5 minutes without use and when the page is left.
- Plain-English summary first, the exact quote one tap away.
- English and Spanish UI. Legal quotes stay in their original language (English). Rule summaries are
  written in English. In Spanish, Tend shows a translation only when the browser's built-in translator
  (Chrome's Translator API) already has its English-to-Spanish model on the device; otherwise the
  English summary shows with a note saying so.
- Phone-first layout. Buttons and form fields are 48 px tall and the survivor flow's other tap targets
  at least 44 px; a few controls elsewhere are smaller. The color tokens meet WCAG AA contrast against
  the page in light and dark themes (ratios in web/DESIGN.md). Keyboard and screen-reader use are
  design goals with some unit tests; no accessibility audit (Lighthouse, axe, or a screen-reader pass)
  is recorded in this repository yet.
- Reading level around grade 6 to 8 for Tend's own English sentences (web/tests/i18n.test.ts checks
  the UI copy and web/tests/public-summary.test.ts the sentences templated from the rules). The rule
  summaries shown above each quote are not held to it yet; by the same formula they average about
  grade 11.

## Separate from the survivor flow
- "How Tend decides": the verified rules, sources, and the compiled law listing for any state.
  For advocates, judges, and anyone checking the work.
- Advocate view: a share link opens a read-only copy of the claim in the advocate's browser, with
  the amount, the checks, every cost with the law behind it, and the cited summary PDF. The
  survivor picks when the link expires and whether it opens only once.

## Not building
Voice, iMessage, crypto, points or streaks, chatbots in the survivor flow, anything that stores a
narrative.

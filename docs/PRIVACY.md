# Tend: local-first and encrypted (the privacy contract)

Survivors do not share this kind of information because they fear who will see it. Tend is built
so that the answer to "who can see my data?" is: only you, until you act to send something. A
packet you share is locked in your browser before it leaves, so our server cannot read it. The
other sends can be read by our server while it handles them: a payment, a law check on our server,
cloud AI (which also goes to Google's Gemini), and the demo bank's records. Each one happens only
when you tap it, and the list below names all five.

## What runs on your device

| Step | Where it runs | How |
|---|---|---|
| Eligibility check (state, date, exam, report) | Device, or Tend's server after you say yes | C++ law engine compiled to WebAssembly, with the state's compiled law image. Loading that image shows Tend's host which state you picked (see "What loading the law shows") |
| Reading a bank statement (CSV, OFX, PDF) | Device | Parsers in the browser; PDF text via pdf.js |
| Sorting transactions into costs | Device, or cloud AI after you say yes | Deterministic merchant and keyword rules first, then Gemini Nano running on the device through Chrome's built-in Prompt API, constrained to a fixed list of categories |
| Reading a bill photo or PDF | Device, or cloud AI after you say yes | A PDF with a text layer is read by code; a photo, or a PDF that is only a picture, goes to Gemini Nano's image input on the device. Line items must add up to the bill total or the bill is marked "couldn't read reliably" |
| Deciding eligibility, caps, held bills, totals | Device, or Tend's server after you say yes | The same WebAssembly law engine; every dollar carries its proof |
| Filling the state's application (Michigan only today) | Device | pdf-lib fills the program's own PDF form in the browser from an allowlist of safe fields |
| Translation (Spanish) | Device | Rule summaries are written in English. Chrome's on-device Translator API translates them only when its model is already on the device; UI strings are written in both languages |
| Storage between sessions | Device, encrypted | IndexedDB vault encrypted with AES-256-GCM; the key is derived from a passkey (WebAuthn PRF, Touch ID) or a passphrase (PBKDF2-SHA-256, 600,000 iterations); the key lives only in memory while unlocked |

## What leaves your device, and only when you act

1. **A payment you set up and confirm.** When Tend is connected to a bank, tapping Get a code
   sends the amount, the account, and the payee to Tend's server, and no money moves yet. After
   you type the code, the server sends the payment to the bank (Capital One's Nessie, a mock bank,
   in the demo), labeled with the payee, Tend's payment id, and for a bill its id and line numbers.
   The server keeps the payee until the payment finishes or locks, or until a cleanup finds its
   code expired. The rest of the record (the amount, the account, the bill and its lines, and for a
   payment that went through, the bank's withdrawal id and the bill's totals) is deleted at a
   cleanup a day or more after the code expired. The payment log keeps amounts and ids, never a
   name.
2. **A packet you choose to share.** It is encrypted in your browser with a fresh random AES-256-GCM
   key. Our server stores only the ciphertext and an expiry. The key travels in the link's
   fragment (`#...`), which browsers never send to servers, so we cannot decrypt it. Links expire,
   can be revoked, and can be set to open once.
3. **Cloud AI, only if you ask.** On a phone or browser without on-device AI, Tend offers cloud AI
   for the rows it could not sort or a bill it could not read, with a consent screen naming what
   is sent. Default is off; the deterministic rules still work without it. Rows go as the kind of
   transaction, the merchant, its category, and the description, from the date it happened on (or
   every unsorted row, when you did not give a date). Tend first tries to take dates, amounts, card
   and reference numbers, phone numbers, emails, and the name in a payment app line out of that
   text; the filter looks for the usual formats, so something written another way can still go. A
   bill goes as the file itself, with everything printed on it. Both go through Tend's server, which
   keeps no copy, to Google's Gemini API. Tend calls Gemini on Google's free tier, whose terms
   ([Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms), last updated
   April 28, 2026) let Google keep what is sent, use it to improve its products, and have people
   review it, and ask that nothing sensitive or personal be sent. The consent screen says so before
   the yes. A bill picture can carry a name, an address, and the care someone got, so in this
   prototype a real bill should not be sent to cloud AI.
4. **The demo bank (fictional).** Adding the demo bank in Gather reads a copy of the fictional
   account that ships with Tend, so nothing is sent. In Track, with the demo bank only, the bank
   records panel asks Tend's relay for that account's records, and the demo of the program paying
   sends the claim's total. The relay holds the Nessie key and stores nothing. Each request happens
   only when tapped, and the privacy line shows it.
5. **A check on Tend's server, only after a yes.** If this browser cannot run the law engine, Tend
   asks first. A yes sends your state, the incident date, your exam and police answers, and every
   cost you have not said no to, with its amount, date, kind, and description as it reads on your
   statement or bill. Tend's server checks them, sends back the answer, and keeps nothing. After
   that yes, each change to the claim is checked there too.

**What loading the law shows.** Choosing a state loads that state's public law files from Tend's
site: its compiled law, its verified rules, and its law summary, and on the Packet step the API's
copy of its rules. None of it carries what you entered, and the privacy line does not count it, but
the file names show Tend's host which state you picked, and its request logs can hold that next to
your IP address (see "Request logs" below).

## What our server holds

- The public law corpus (Neon Postgres): verified rules with their quotes, each source's title,
  address, and sha256 (not its text), and the sha256 of each compiled law image. The compiled
  images and the verified rules are also public files the website sends to every browser.
- Ciphertext of shared packets, with expiry (Neon Postgres). No keys.
- Payments waiting for a code (`pending_actions`): the amount, the account, and the payee, kept as
  item 1 above describes. The code itself is stored only as a keyed hash.
- An append-only, hash-chained audit log of payments: an action id, the amount, timestamps, keyed
  hashes of the account and the payee, and for a payment that went through, the bank's withdrawal
  id and the bill's id. No names, no descriptions of what happened.
- Request logs. Tend's API logs only the method, the path without its query, and the status, and
  leaves out private paths (shares, the bank relay, cloud AI, claims, packets) entirely. Vercel,
  which hosts Tend, keeps its own request logs, which Tend's code cannot turn off. For every request
  it serves, including pages, law files, and API calls, they can hold the time, the method, the path
  with its query, the status, and the visitor's IP address and browser (user agent)
  ([Vercel's log fields](https://vercel.com/docs/drains/reference/logs)). When a visit starts from a
  link on another site, they can also hold that page's address, or as much of it as that site lets
  the browser send (the referrer). Tend's own pages tell the browser to send no referrer. So a share
  id, the fictional demo persona (such as `/api/bank/rowan-mi/activity`), or the state whose law was
  loaded can appear there next to an IP address. A share id alone opens nothing: the key stays in
  the link.

Cleanups run when a new payment or share arrives, and within about a minute after something comes
due while the API is running, so on a quiet server a row can stay longer than the times above.

## What Tend never collects

What happened, where, or who did it. There is no field for it anywhere, on the device or the
server. The state form's crime-detail, offender, location, signature, and SSN fields are left
blank for the survivor to fill in.

## Shared-device safety

- Quick exit (the Exit this page button at the top, or Esc twice) replaces the page and drops the
  in-memory key. It replaces only the current history entry: Back can still open an earlier Tend
  page, and the browser's history still lists the site.
- The vault locks after 5 minutes without a tap, key, or scroll, and when the tab is closed,
  reloaded, or leaves the site. What it saves is stored only encrypted. Files you download (the
  filled form, the summary PDF, letters) are ordinary files. If you lock with Touch ID or screen
  lock, your device keeps a passkey for youreowed.tech named Tend. Anyone who opens that password
  manager can see it, and with iCloud Keychain or Google Password Manager it can sync to your other
  devices. Deleting saved progress does not remove it.
- Until something is sent, the privacy line says "On this device. Nothing has left it since this
  page opened." It vouches only for the page on screen: a reload, or a tab the browser reopens,
  is a new page.
- So that a reload does not hide a send, the line keeps, for this tab only, the kind of each thing
  sent and when, in sessionStorage. It holds no amounts, payees, ids, or keys. The browser writes
  sessionStorage to its profile folder, so these kinds and times can sit on the device's disk,
  unencrypted, until the browser clears them. Only a reload keeps the list. Any other load starts
  it over, including a closed tab the browser reopens (which gets its sessionStorage back) and a
  Back the browser's page cache does not serve; the line then leaves out what the tab sent before.
  Quick exit clears it with the rest of the tab. Deleting saved progress, saving over it, and Close
  Tend on a claim that was never saved clear it too.
- While saved progress is locked, the line says only "On this device." Sends made after Start over
  without it, while saved progress stays locked, are not kept for the tab, so opening that progress
  never names them to its owner as theirs. After Lock now, Close Tend, or Delete, the line also says
  only "On this device." until something new is sent or the page loads again, because what the page
  sent before is no longer on the line. So once saved progress locks, or the survivor exits or ends
  the claim, the next person at the device cannot read from the line what was sent or when.
- Neutral tab title, no notifications, no analytics, no third-party scripts in the survivor flow.

## Threat model, honestly

Protects what you enter from: someone who later uses this browser (nothing you entered is kept
unencrypted, and saved progress is locked), a breach of our database (it holds locked shares,
short-lived payment rows, the audit log, and the public law), and network observers reading your
data (every request is HTTPS).

It does not hide that Tend was used. The browser's history lists the site, and Exit this page
replaces only the current page. The offline copy of Tend's public pages, saved progress, packets
and letters you downloaded, and a passkey named Tend, if you made one, stay on the device, and the
passkey can sync to your other devices through the password manager. A network observer can see
that youreowed.tech was visited, and Tend's host can see each visit's IP address and which state's
law was loaded. Anything you choose to send for a payment, a check on our server, or cloud AI can be
read by our server while it is handled (cloud AI also by Google).

Does not protect against: malware on the device, or someone watching the screen. The demo uses
fictional people and data.

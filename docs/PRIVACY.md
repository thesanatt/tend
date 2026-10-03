# Tend: local-first and encrypted (the privacy contract)

Survivors do not share this kind of information because they fear who will see it. Tend is built
so that the answer to "who can see my data?" is: only you, unless you choose to share, and even
then our server cannot read it.

## What runs on your device

| Step | Where it runs | How |
|---|---|---|
| Eligibility check (state, date, exam, report) | Device | C++ law engine compiled to WebAssembly, with the state's compiled law image |
| Reading a bank statement (CSV, OFX, PDF) | Device | Parsers in the browser; PDF text via pdf.js |
| Sorting transactions into costs | Device | Deterministic merchant and keyword rules first, then Gemini Nano running on the device through Chrome's built-in Prompt API, constrained to a fixed list of categories |
| Reading a bill photo or PDF | Device | Gemini Nano with image input on the device; line items must add up to the bill total or the bill is marked "couldn't read reliably" |
| Deciding eligibility, caps, held bills, totals | Device | The same WebAssembly law engine; every dollar carries its proof |
| Filling the state's application | Device | pdf-lib fills the official PDF in the browser from an allowlist of safe fields |
| Translation (Spanish) | Device | Chrome's on-device Translator API for dynamic text; UI strings are pre-translated |
| Storage between sessions | Device, encrypted | IndexedDB vault encrypted with AES-256-GCM; the key is derived from a passkey (WebAuthn PRF, Touch ID) or a passphrase (PBKDF2-SHA-256, 600,000 iterations); the key lives only in memory while unlocked |

## What leaves your device, and only when you act

1. **A payment you confirm.** The amount, the account, and the payee go to your bank (Capital One's
   Nessie in the demo). Nothing else.
2. **A packet you choose to share.** It is encrypted in your browser with a fresh random AES-256-GCM
   key. Our server stores only the ciphertext and an expiry. The key travels in the link's
   fragment (`#...`), which browsers never send to servers, so we cannot decrypt it. Links expire,
   can be revoked, and can be set to open once.
3. **Cloud AI, only if you ask.** On a phone or browser without on-device AI, Tend offers cloud
   Gemini per file, with a clear consent screen naming exactly what is sent. Default is off; the
   deterministic rules still work without it.
4. **Bank connection (demo).** Fetching transactions from the bank passes through a relay that
   holds the API key, keeps no logs, and stores nothing. Statement upload avoids even that.

## What our server holds

- The public law corpus: verified rules, source snapshots, compiled law images (Neon Postgres).
- Ciphertext of shared packets, with expiry (Neon Postgres). No keys.
- An append-only, hash-chained audit log of confirmed payments: action id, amount, timestamps,
  and hashes. No names, no descriptions of what happened.

## What Tend never collects

What happened, where, or who did it. There is no field for it anywhere, on the device or the
server. The state form's crime-detail, offender, location, signature, and SSN fields are left
blank for the survivor to fill in.

## Shared-device safety

- Quick exit (corner button or Esc twice) replaces the page and drops the in-memory key.
- The vault locks on exit and after inactivity; nothing readable stays on disk.
- Neutral tab title, no notifications, no analytics, no third-party scripts in the survivor flow.

## Threat model, honestly

Protects against: someone else using the same browser later, a curious server operator, a
breach of our database, network observers. Does not protect against: malware on the device, or
someone watching the screen. The demo uses fictional people and data.

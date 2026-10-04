**A survivor shouldn't have to give up her name to get money the law already owes her.**

## Inspiration

Every state and DC runs a crime victim compensation program. It can pay a sexual assault survivor back
for therapy, hospital bills, lost pay, moving, and new locks. In 2022, 96% of violent crime victims got
none of it ([Alliance for Safety and Justice](https://justsafe.org/news/beyond-headlines-decade-listening-crime-survivors/)).

The money is there. Getting it means finding your state's statute, its deadline, and its form, then
matching months of bank charges to what the law covers, and handing your story to strangers to start.

This week, people flooded social media with "I am Jane Doe" to protect one survivor's anonymity
([AP, Oct 4](https://abcnews.com/US/wireStory/jane-doe-solidarity-posts-flood-social-media-after-136984033)).
That became my design rule: **you should be able to claim what you're owed and stay Jane Doe.**

## What it does

Tend is tax software for crime victim compensation, in all 50 states and DC. It never asks your name or
what happened. Here's the demo with Rowan, who is fictional and lives in Michigan:

1. **Answer four questions:** state, date, exam, police report. Tend answers with the law: you can likely
   apply, file by June 14, 2031, and your exam counts in place of a police report.
2. **Upload a bank statement.** A 5-page PDF becomes 190 transactions, read on your device, and Tend
   pulls out the costs the law covers.
3. **Upload the hospital bill.** It's $443, and $325 of it is the forensic exam. Michigan law says "a health
   care provider shall not submit a bill for any portion" of that exam to the victim (MCL 18.355a(2)).
   Tend holds that line and writes the letter to billing.
4. **Pay the $118 you actually owe** through Capital One's Nessie bank, only after typing a 6-digit code.
   It can't pay twice, and it can never pay the held line.
5. **Get your packet:** Michigan's own form with safe fields only (name, SSN, and story stay blank), a
   summary where every dollar shows its law, and a checklist of what's still needed. Rowan can ask for
   $3,848. The program decides.
6. **Share it with an advocate** through a locked link. My server keeps a copy it can't read.
7. **Track it** as a garden. Each cost is a plant that grows when something real happens. The $325 never
   grows, because it was never Rowan's to pay.

Turn the Wi-Fi off after the payment and the packet still builds. The law runs on your device.

Try it: **[youreowed.tech](https://youreowed.tech)**. Open /check?demo=rowan, or your own state's page.

## How I built it

**The law as code.** I saved 824 official sources for 51 jurisdictions and wrote 2,578 rules. A rule gets
in only if its quote appears word for word in the saved source and every number in it is in the quote.

**A compiler and a tiny VM.** C++20 turns each state's rules into a small bytecode file, and a verifier
checks every file before it runs: it can't crash or loop forever, and each cost gets exactly one
decision. The instruction that sets each dollar also records the rule and quote behind it, so the
explanation can't drift from the math. The same C++ runs in your browser as 183 KB of WebAssembly.

**Two engines, zero disagreements.** I wrote a second engine in Python from the same spec. On 121,000
random claims, the two agree byte for byte.

**Private by default.** Statements and bills are read in the browser. Plain rules sort charges first, and
Gemini Nano, built into Chrome, suggests labels for the rest on the device. Cloud Gemini runs only after
you say yes on a consent screen. Saved progress is AES-256-GCM encrypted in the browser.

**The rest.** Next.js, and FastAPI on Vercel with Neon Postgres, which holds only the public law, locked
shares, and an append-only payment log. Every version of the law is its own Neon branch, so you can see
exactly what changed. Three Fetch.ai agents run the same claim inside ASI:One, and the payment still waits
for a code only a person can type.

## Challenges I ran into

- 51 states write law 51 ways: caps per claim, per session, per week, per mile. I had to fit all of it in
  one format without bending a single rule.
- Some deadlines count from when a crime is discovered, which Tend never asks. In 12 jurisdictions, Tend
  flags that instead of telling someone they're late.
- Gemini Nano once labeled a phone bill as lost wages. Now AI only suggests, and code decides money.

## Accomplishments that I'm proud of

- **Every dollar traces to a transaction, a rule, and a word-for-word quote.**
- The held exam line can't be paid through the app, the agent, or the API.
- It works with the Wi-Fi off.
- Nothing in the database can hold who you are or what happened.

## What I learned

If I couldn't quote it, Tend couldn't use it. That one rule kept everything honest.

## What's next

Put it in front of state compensation navigators and campus advocates before any survivor uses it.
Pre-fill more states' forms (only Michigan's today). Re-check every source on a schedule.

Tend is not legal advice. It shows what each state's own rules say, with the quote, and the program
decides. Every person and dollar in the demo is fictional.

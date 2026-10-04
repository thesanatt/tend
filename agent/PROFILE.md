# Tend Navigator: crime victim compensation help for sexual assault survivors

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)
![tag:domain/legal-aid](https://img.shields.io/badge/legal--aid-2E7D32)

Every US state and DC has a crime victim compensation program that can repay costs like counseling, medical bills,
rides to care, lost wages, and moving. Most survivors never hear about it, or give up on the forms. Tend Navigator
answers questions about any state's program with the law quoted and linked, runs a 2-minute eligibility Check, and
runs a fictional claim from start to finish, including a payment and a locked link for an advocate. It is built for
survivors and the advocates who help them.

## What you can ask

- "What is the deadline to apply in Ohio?"
- "Does Michigan cover counseling, and is there a limit?"
- "Do I need a police report in Texas if I had a forensic exam?"
- "Run a check: Michigan, June 14 2026, had an exam, not reported."
- "Show me the demo claim." Then "yes", "pay the bill", the code it shows, and "share with an advocate".

## What it does

- **Cited answers.** Every answer comes from Tend's verified rules for 51 jurisdictions: verbatim quotes from
  official statutes, regulations, and program pages, each with a pinpoint (like MCL 18.355a(2)) and a link that opens
  at the quoted text. When no rule supports an answer, it says "That's not in the rules I have" and gives the
  program's contact instead of guessing.
- **Check.** State, the date it happened (only the date), forensic exam yes / no / not sure, police report yes / no /
  not yet. It returns the filing deadline as a date, whether a police report is needed and what counts instead, the
  forensic exam billing protection, covered costs with their limits, and how to reach the program. It says "You can
  likely apply", never "you qualify". The program decides.
- **A fictional claim, end to end.** A made-up person on Capital One's Nessie mock bank. Tend finds the costs, counts
  them under the state's law after you say yes, holds the forensic exam line the law says should never have been
  billed and writes the letter to the billing office that quotes that law, pays the rest of the hospital bill only
  after you type the 6-digit code the server issued, and seals the claim into a link for an advocate. The link is
  encrypted before it leaves, so Tend's server stores only a copy it cannot read.
- **Three agents.** The Navigator talks with you. The Law agent reads the verified rules. The Bank and Packet agent
  runs the claim, the payment, and the packet. They speak typed messages to each other, retry once, and tell you
  plainly if one of them is not answering.
- **Interactive cards** in ASI:One: a Check form, a review card before counting, a review card with the code before
  any payment, and next steps.

## Privacy

No account, no name, no story. The agent never asks what happened, where, or who, and it does not need to know. If
someone starts to describe it, or types a name, an address, or a phone number, the agent says it does not need that
and does not pass the message on. It never
receives a survivor's own claim or share links: it works on the public law corpus and the fictional demo only.
Message text is never stored or logged. Short session details (like a pending payment id) last at most two hours.

## Limits

- Information, not legal advice. Rules can have exceptions, and the program makes every decision.
- It does not file claims. The demo person and bank are fictional, and the bank is a mock.
- Answers cover crime victim compensation only, and only what the verified rules say.

## Keywords

crime victim compensation, victim compensation fund, sexual assault, survivor, forensic exam, SANE exam, rape kit
bill, police report requirement, filing deadline, counseling reimbursement, lost wages, relocation, advocate,
legal aid, all 50 states, DC

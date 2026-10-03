# Tend Navigator: crime victim compensation help for sexual assault survivors

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)
![tag:domain/legal-aid](https://img.shields.io/badge/legal--aid-2E7D32)

Every US state and DC has a crime victim compensation program that can repay costs like counseling, medical
bills, rides to care, lost wages, and moving. Most survivors never hear about it, or give up on the forms. Tend
Navigator answers questions about any state's program with the law quoted and linked, runs a 2-minute eligibility
Check, and walks through a fictional claim end to end. It is built for survivors and the advocates who help them.

## What you can ask

- "What is the deadline to apply in Ohio?"
- "Does Michigan cover counseling, and is there a limit?"
- "Do I need a police report in Texas if I had a forensic exam?"
- "Run a check: Michigan, June 14 2026, had an exam, not reported."
- "Show me the demo claim." Then "pay the bill", then type the code it shows.

## What it does

- **Cited answers.** Every answer comes from Tend's verified rules for 51 jurisdictions. Each rule is a verbatim
  quote from an official statute, regulation, or program page, with a pinpoint (like MCL 18.355a(2)) and a link
  that opens at the quoted text. When no rule supports an answer, it says "I don't know" and gives the program's
  phone number.
- **Check.** State, date it happened (only the date), forensic exam yes / no / not sure, police report yes / no /
  not yet. It returns the filing deadline as a date, whether a police report is needed and what counts instead,
  the forensic exam billing protection, covered costs with their limits, the most you can ask for, and how to reach
  the program. It says "You can likely apply", never "you qualify". The program decides.
- **Demo claim.** A fictional person on Capital One's Nessie mock bank. The agent shows the costs Tend found,
  counts them under the state's law after you say yes, flags the forensic exam line the law says should never be
  billed, and offers to pay the rest of the hospital bill. The payment happens only after you type the one-time
  code the server issues. It is checked against the bank record and written to a hash-chained audit log.
- **Interactive cards** in ASI:One: a Check form, a review card before any payment, and a box for the code.

## Privacy

No account, no name, no story. The agent never asks what happened, where, or who, and it does not need to know.
If someone starts to describe it, the agent says it does not need that and does not pass the message on. Message
text is never stored or logged. Short session details (like a pending payment id) live in memory for at most two
hours.

## Limits

- Information, not legal advice. Rules can have exceptions, and the program makes every decision.
- It does not file claims. Bank data in the demo is fictional and the bank is a mock.
- Answers cover crime victim compensation only, and only what the verified rules say.

## Keywords

crime victim compensation, victim compensation fund, sexual assault, survivor, forensic exam, SANE exam, rape kit
bill, police report requirement, filing deadline, counseling reimbursement, lost wages, relocation, advocate,
legal aid, all 50 states, DC

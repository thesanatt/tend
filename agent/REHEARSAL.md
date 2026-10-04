# Rehearsal: the whole loop in one chat

Produced by `agent/scripts/rehearse.py` on 2026-10-03 21:08 EDT against the Tend API at `http://127.0.0.1:8791`. Three uAgents (Navigator, Law, Bank and Packet) and a stand-in for ASI:One talked over the Agent Chat Protocol and the agents' typed messages. The person is fictional and so is every number from the bank. The share link's key is cut from this file (`KEY`).

---

**You:** hi

**Tend Navigator:**

Hi. I'm Tend Navigator. I help sexual assault survivors, and the advocates who support them, get the crime victim compensation their state already promises.

I never ask for your name, what happened, or anything that identifies you. You don't need an account, and I don't keep messages.

- **Ask** about any state's program. I quote the law and link it, or I tell you it's not in the rules I have.
- **Check**: the state, the date it happened (only the date), and whether there was a forensic exam or a police report. You get the deadline, the police report rules, and what is covered.
- **Demo**: a fictional claim from start to finish. Costs from a mock bank, a hospital bill line the law says should never have been billed, a payment you approve with a code, and a locked link for an advocate.

Three agents work on this: I talk with you, the Law agent reads the verified rules, and the Bank and Packet agent runs the fictional claim.

> Detail card: **Tend Navigator** | Ask: Questions about any state's program, answered with the law quoted; Check: Deadline, police report rules, and what is covered (2 minutes); Demo: A fictional claim: a held bill line, a mock payment you approve, and a locked link; Privacy: No account, no name, no story. I never ask what happened. | buttons: Run a Check, See the demo claim

---

**You:** What is the deadline to apply in Ohio?

**Tend Navigator:**

Apply within three years of the crime. The statute points to ORC 2743.60 for exceptions: claimants who were minors or young adults at the time get extra time, and the Attorney General may accept a late claim at any time for good cause shown.

[ORC 2743.56(B); ORC 2743.60(A)(2)(d)](https://codes.ohio.gov/ohio-revised-code/section-2743.56#:~:text=All%20applications%20for%20an%20award,2743.60%20of%20the%20Revised%20Code.):
> "All applications for an award of reparations may be filed at any time within three years after the occurrence of the criminally injurious conduct, except as provided in divisions (A)(2)(b) to (d) of section 2743.60 of the Revised Code."

If the claimant was under twenty-one when the crime happened, the claim is not time-barred until after the claimant's twenty-fourth birthday. ([ORC 2743.60(A)(2)(b)](https://codes.ohio.gov/ohio-revised-code/section-2743.60#:~:text=If%20the%20claimant%20was%20under,after%20the%20claimant%27s%20twenty%2Dfourth%20birthday.))
> "If the claimant was under twenty-one years of age at the time of the criminally injurious conduct, the claim is not barred under division (A)(2)(a) of this section until after the claimant's twenty-fourth birthday."

_Behind the scenes: Navigator asked the Law agent (LawAnswerRequest), answered in 0.04 s._

---

**You:** Can I get money for my dog's vet bills in Michigan?

**Tend Navigator:**

That's not in the rules I have. I found no verified Michigan rule that answers it, so I won't guess.

The program can answer it: **Michigan Crime Victim Compensation**, phone 877-251-7373, [website](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/applying-for-compensation).

_Behind the scenes: Navigator asked the Law agent (LawAnswerRequest), answered in 0.02 s._

---

**You:** check Michigan, June 14 2026, had an exam, not reported

**Tend Navigator:**

**You can likely apply in Michigan.** The program decides.

_Based on: Michigan, date June 14, 2026, had an exam, not reported yet. These answers are not saved._

**Deadline:** apply by **June 14, 2031**. This is measured from the date it happened. In one case Michigan's law counts from the police report instead ([MCL 18.355(2)(a)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355#:~:text=a%20claim%20based%20on%20the,delay%20in%20reporting%20the%20crime.)): For criminal sexual conduct (first through third degree) where police records show the victim was under 18, a claim may be filed within 5 years after the crime was reported, if reported before age 28 or later with good cause for the delay.
A claim must be filed within 5 years after the crime. ([MCL 18.355(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355#:~:text=a%20claim%20must%20be%20filed,which%20the%20claim%20is%20based))
> "a claim must be filed by the claimant not later than 5 years after the occurrence of the crime upon which the claim is based"

**Police report:** your forensic exam counts in place of a police report.
For sexual assault, having a sexual assault forensic exam satisfies the prompt police-reporting and cooperation requirements for compensation. ([MCL 18.355a(10)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=For%20payments%20authorized%20under%20this,under%20sections%206%20and%2010.))
> "For payments authorized under this section or for payments made to victims under section 6, administration to the victim of a sexual assault medical forensic examination satisfies the requirements for prompt law enforcement reporting and victim cooperation under sections 6 and 10."

**Exam bills:** you should not get a bill for a forensic exam.
A health care provider may not bill a sexual assault survivor for any part of a forensic exam, including insurance deductibles, co-pays, or a denied insurance claim. ([MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket%20expense.))
> "A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other out-of-pocket expense."

**Covered costs:** Medical care, Counseling (up to $125 a session, limits vary), Lost wages (up to $1,000 a week), Moving (up to $3,800), A temporary place to stay, Rides and travel to care (up to $5,000, limits vary), Child care, Dental care, Eyeglasses, hearing aids, dentures, prosthetic or other prescription devices.

**Most you can ask for:** $45,000 in total ([MCL 18.361(1)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=The%20aggregate%20award%20under%20this,not%20exceed%20%2445%2C000.00%20per%20claimant.)). The program decides.

**Program:** **Michigan Crime Victim Compensation**, phone 877-251-7373, [website](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/applying-for-compensation).

Rules can have exceptions. To find costs the program can repay, open Tend on your own device: https://youreowed.tech/mi

To see how a claim comes together, say **show me the demo claim**. It uses a fictional person.

_Behind the scenes: Navigator asked the Law agent (LawCheckRequest), answered in 0.01 s._

---

**You:** show me the demo claim

**Tend Navigator:**

**Demo: Rowan Hale, Michigan.** Fictional person and data on Capital One's Nessie mock bank. No real person, account, or hospital.
Tend read 191 bank records and found these possible costs since June 14, 2026:

- Counseling: 16 charges, $2,400.00
- Moving: 2 charges, $839.00
- Lost wages: 3 charges, $528.00
- Replacing property: 1 charge, $299.00
- Locks and home security: 2 charges, $249.00
- Rides and travel to care: 14 charges, $178.00
- Clothing and bedding: 1 charge, $96.00
- Prescriptions: 4 charges, $70.00
- Hospital bill (itemized): 3 lines, $443.00. The lines add up to the total.

Nothing counts until the survivor says yes. Count these for the demo claim? Say **yes** or **not now**.

> Review card: **Count these costs for the demo claim?** | Counseling: 16 charges, $2,400.00; Moving: 2 charges, $839.00; Lost wages: 3 charges, $528.00; Replacing property: 1 charge, $299.00; Locks and home security: 2 charges, $249.00; Rides and travel to care: 14 charges, $178.00; Clothing and bedding: 1 charge, $96.00; Prescriptions: 4 charges, $70.00; Hospital bill (itemized): 3 lines, $443.00; Data: Fictional person on Capital One's Nessie mock bank | buttons: Yes, count them, Not now

_Behind the scenes: Navigator asked the Bank and Packet agent (DemoStartRequest), answered in 0.02 s._

---

**You** click **Yes, count them** on the card.

**Tend Navigator:**

**Amount Rowan Hale can ask for: $4,008.00. The program decides.**

_Fictional person and data on Capital One's Nessie mock bank. No real person, account, or hospital._

What counts:
- Counseling: $2,000.00 of $2,400.00 (16 charges; limit $125 a session) ([MCL 18.361(6)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=except%20that%20the%20maximum%20hourly,to%20practice%20in%20this%20state.))
- Moving: $839.00 (2 charges) ([MCL 18.361(2)(c)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=An%20award%20for%20expenses%20under,not%20exceed%20%243%2C800.00%20per%20claimant.))
- Lost wages: $528.00 (3 charges) ([MCL 18.361(4)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=An%20award%20must%20not%20exceed,each%20week%20of%20lost%20earnings.))
- Locks and home security: $249.00 (2 charges) ([MCL 18.361(2)(f)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=%28f%29%20Reasonable%20costs%20of%20not,increasing%20the%20number%20of%20locks))
- Rides and travel to care: $178.00 (14 charges) ([MCL 18.361(2)(e)(ii)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=%28ii%29%20If%20the%20expense%20is,miles%20of%20the%20claimant%27s%20residence.))
- Medical care: $118.00 (2 charges) ([MCL 18.361(2)(a)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=%28a%29%20Medical%20care%20for%20the%20victim%20or%20intervenor.))
- Clothing and bedding: $96.00 (1 charge) ([MCL 18.361(2)(j)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-361#:~:text=%28j%29%20Replacement%20costs%20of%20not,as%20evidence%20of%20a%20crime.))

Not included:
- Prescriptions, $70.00: no verified rule covers this yet, so ask the program
- Replacing property, $299.00: not covered ([MDHHS What Costs May Be Covered, Costs that are NOT Covered](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/what-costs-may-be-covered-for-crime-victims#:~:text=Damage%2C%20repair%20or%20loss%20to,a%20purse%20or%20cell%20phone.))

**Don't pay this line:** the forensic exam, $325.00 of the $443.00 hospital bill. The law says the survivor should not be billed for it.
A health care provider may not bill a sexual assault survivor for any part of a forensic exam, including insurance deductibles, co-pays, or a denied insurance claim. ([MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket%20expense.))
> "A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other out-of-pocket expense."

Apply by June 14, 2031 ([MCL 18.355(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355#:~:text=a%20claim%20must%20be%20filed,which%20the%20claim%20is%20based)). This is measured from the date it happened. In one case Michigan's law counts from the police report instead ([MCL 18.355(2)(a)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355#:~:text=a%20claim%20based%20on%20the,delay%20in%20reporting%20the%20crime.)): For criminal sexual conduct (first through third degree) where police records show the victim was under 18, a claim may be filed within 5 years after the crime was reported, if reported before age 28 or later with good cause for the delay. The forensic exam counts in place of a police report.

**Tend Navigator:**

**Letter to the billing office.** Copy it, fill in the [brackets], and send it. It asks billing to remove the exam line and quotes the law:

```
[Date]

To: Billing office, [hospital or clinic name]
About: Account [account number]

I am writing about this charge on my account for a sexual assault forensic exam:

    Medical forensic exam, deductible applied, June 14, 2026: $325.00

Michigan law says I should not be billed for this exam:

"A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other out-of-pocket expense." (MCL 18.355a(2))

Please remove the exam charge from my account, stop any collection on it, and send me an updated statement.

The law names who pays for the exam instead:

"The commission shall pay a health care provider not more than $1,200.00 for the cost of performing a sexual assault medical forensic examination" (MCL 18.355a(7))

If you have questions, please contact me in writing.

Thank you,
[Your name]
[A safe way to reach you]
```

The rest of the hospital bill is **$118.00**. Want to pay it from Checking ending 0011 (mock bank)? Say **pay the bill**. Nothing moves until you type a code. Or say **share with an advocate** for a locked link to this claim.

> Detail card: **What next?** | Held by law: The forensic exam line stays unpaid; Data: Fictional, on a mock bank | buttons: Pay the $118.00 left on the bill, Make a locked link for an advocate

_Behind the scenes: Navigator asked the Bank and Packet agent (DemoCountRequest), answered in 0.03 s._

---

**You:** pay the bill

**Tend Navigator:**

Here is the payment to review. **Nothing moves until you type the code.** To pay $118.00, type **300318** here. To stop, say cancel. The code works once and ends in 10 minutes. (Fictional demo data on a mock bank.)

> Review card: **Review: pay $118.00** | Pay to: Riverbend General Hospital (fictional); Amount: $118.00; From: Checking ending 0011 (Nessie mock bank); Pays: 2 lines of the itemized bill; Not paid: Forensic exam line, $325.00 (held by law); Confirm code: 300318; Code ends: in 10 minutes, works once; Bank: Dry run: recorded and read back, not sent | buttons: Continue, Cancel

_Behind the scenes: Navigator asked the Bank and Packet agent (PayProposeRequest), answered in 0.01 s._

---

**You:** 300318

**Tend Navigator:**

**Done.** Paid $118.00 to Riverbend General Hospital. Dry run: Tend recorded it and read it back, but did not send it to the bank.

- Bank record: dryrun-f1dc7d168c224afa83433eb0fa0374b3. Tend read it back and it matches what you approved.
- Audit log: aud_000004, in a hash chain with no names in it.

The forensic exam line, $325.00, stays unpaid. The law says the hospital should not bill it ([MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket%20expense.)).

Next, say **share with an advocate** for a locked link to this claim.

> Detail card: **What next?** | Held by law: The forensic exam line stays unpaid; Data: Fictional, on a mock bank | buttons: Make a locked link for an advocate

_Behind the scenes: Navigator asked the Bank and Packet agent (PayConfirmRequest), answered in 0.01 s._

---

**You** click **Make a locked link for an advocate** on the card.

**Tend Navigator:**

**Here is a locked link for an advocate.** It opens the claim in their browser, with the key in the link. Tend's server keeps only a copy it cannot read. It stops working October 7, 2026.

https://youreowed.tech/share#bPPTJpZWek0n9Qxu_Z3CWA.KEY

**In the packet:**
- Michigan's own application with safe fields only. Name, signature, Social Security number, and anything about what happened stay blank for the survivor to fill in.
- The cited summary: every cost with its record and the exact words of the law.
- The letter to the billing office about the exam line.

**Still needed** (from Michigan's rules):
- Social Security number (if you have one) and date of birth on the application. (Application Checklist, For All Applications, item 1)
- Itemized bills (Application Checklist, Medical, Dental, Equipment, Nonmedical Remedial Treatment, and/or Counseling, item 1)
- Receipts for costs you paid (Application Checklist, Medical, Dental, Equipment, Nonmedical Remedial Treatment, and/or Counseling, item 1)
- Explanation of Benefits from insurance, Medicaid, or Medicare, if applicable. (Application Checklist, Medical, Dental, Equipment, Nonmedical Remedial Treatment, and/or Counseling, item 2)
- Copy of the prescription, itemized bill or estimate, and receipt for medication or replacement medical equipment. (Application Checklist, Medical, Dental, Equipment, Nonmedical Remedial Treatment, and/or Counseling, item 3)
- And 15 more items in the packet.

**Where to file:**
- Email: MDHHS-MichiganCrimeVictim@Michigan.gov ([Applying for Compensation, How do I apply?](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/applying-for-compensation#:~:text=Email%20completed%20applications%20to%20MDHHS%2DMichiganCrimeVictim%40Michigan.gov%20or%20fax%20them%20to%20517%2D335%2D2439.))
- Mail: Michigan Department of Health and Human Services Division of Victim Services Crime Victim Services Commission Grand Tower, Suite 1113 235 South Grand Avenue, PO Box 30037 Lansing MI 48909 ([Applying for Compensation, How do I apply?](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/applying-for-compensation#:~:text=Applications%20can%20still%20be%20submitted,Box%2030037%20Lansing%20MI%2048909))
- Fax: 517-335-2439 ([Applying for Compensation, How do I apply?](https://www.michigan.gov/mdhhs/safety-injury-prev/publicsafety/crimevictims/crime-victim-compensation/applying-for-compensation#:~:text=Email%20completed%20applications%20to%20MDHHS%2DMichiganCrimeVictim%40Michigan.gov%20or%20fax%20them%20to%20517%2D335%2D2439.))

**Amount Rowan Hale can ask for: $4,008.00. The program decides.**

> Detail card: **Locked link for an advocate** | Opens: In the advocate's browser, with the key in the link; Tend's server: Keeps a locked copy it cannot read; Link stops working: October 7, 2026; Still needed: 20 documents; Left blank: Name, signature, Social Security number, and anything about what happened | buttons: Run a Check

_Behind the scenes: Navigator asked the Bank and Packet agent (PacketShareRequest), answered in 0.04 s._

---

**Checked after the chat:** the link's ciphertext, fetched from the API like the advocate's browser does, opened with the key from the link: MI, 46 costs, $4,008.00 the program can be asked for, $325.00 held. Whole chat: 3.9 s.

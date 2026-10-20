# Jurisdiction rules: the data contract

Every jurisdiction (50 states + DC) gets one file, `rules/jurisdictions/<ST>.json`, plus its
source snapshots in `rules/sources/<ST>/`. The engine never reads a rule that `verify.py`
rejects. A rule exists only if its `quote` is a verbatim substring of a saved official source.

## File shape

```json
{
  "jurisdiction": "MI",
  "name": "Michigan",
  "program": {
    "program_name": "Crime Victim Compensation",
    "agency": "Michigan Department of Health and Human Services, Crime Victim Services Commission",
    "website": "https://www.michigan.gov/...",
    "apply_url": "https://...",
    "application_pdf_url": "https://...pdf or null",
    "phone": "877-251-7373",
    "phone_source_id": "MI-S3",
    "statute_citation": "MCL 18.351 to 18.368",
    "application_form": {"source_id": "MI-S12", "fillable": true, "field_count": 202}
  },
  "sources": [
    {
      "id": "MI-S1",
      "title": "MCL 18.355a",
      "url": "https://legislature.mi.gov/...",
      "kind": "statute | regulation | agency_page | agency_pdf | application_form",
      "retrieved_at": "2026-10-03T19:10:00Z",
      "raw_path": "rules/sources/MI/MI-S1.html",
      "text_path": "rules/sources/MI/MI-S1.txt",
      "sha256": "hex of the raw bytes"
    }
  ],
  "rules": [
    {
      "id": "MI-EXAM-1",
      "category": "exam_no_bill",
      "expense": "forensic_exam",
      "params": { "insurance_billing": "consent_required" },
      "summary": "A provider may not bill the survivor for any part of a sexual assault forensic exam.",
      "quote": "A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim",
      "source_id": "MI-S1",
      "pinpoint": "MCL 18.355a(2)"
    }
  ],
  "coverage": {
    "found": ["exam_no_bill", "total_cap", "..."],
    "not_found": ["emergency_award"],
    "notes": "Where something could not be found or verified, say so here."
  },
  "confidence": "high | medium | low",
  "researcher_notes": "Anything a reviewer should know."
}
```

## Categories (`category`)

| category | meaning | params |
|---|---|---|
| `exam_no_bill` | survivor may not be billed for a sexual assault forensic exam | `insurance_billing`: prohibited, consent_required, required, allowed, unspecified; optional `scope`, `condition`, `detail` |
| `exam_payment` | who pays for the exam (state fund, program, county), or who pays for care at the exam visit that the exam payment does not cover | `payer` (text); optional `condition`, `outside_total_cap` |
| `total_cap` | maximum total award | `amount_cents`; optional `exception`, `condition`. A total_cap with no amount states something about the limit (some services can be paid beyond it) and is shown in its own words. A higher tier or an added award (a total_cap with a larger amount, or with none) that carries an `exception` hedges the total line, tile and card, and is cited there instead of being repeated. |
| `expense_cap` | cap on one expense type | `expense`, `amount_cents`, `per` (claim, week, session, hour, mile, day, month, item), optional `count_limit`, `item`, `scope`, `outside_total_cap`. A cap with a `scope` is information only, on the page and in the app's Check. A cap with no amount (a count, a time window, a distance, or another limit on the cost in its own words, such as Texas's subpoenaed court trips) is shown under its cost and never applied. With `outside_total_cap` and no amount it says the cost is paid on top of the total (North Carolina's funeral costs). |
| `covered_expense` | an expense type is reimbursable | `expense`; optional `scope`, `item` (with expense `other`), `detail`, `only_benefit_if`, `total_condition` (with `only_benefit_if`) |
| `excluded_expense` | an expense type is not reimbursable | `expense` or `item` (text) |
| `filing_deadline` | time limit to apply | `years`, `months` or `days`, `from` (crime, incident, injury, offense, occurrence, discovery, report, age_18, age_21, charge, diagnosis, trip), optional `extension`, `condition` |
| `reporting_requirement` | police report rules | `required` (bool), optional `within_days`, `within_hours` or `within_months`, `alternatives` (list: forensic_exam, protective_order, advocate, medical_provider, other), `exception`, `exam_condition`, `scope`, `charge_required` (bool), `expense` (forensic_exam only, for a waiver that covers only the exam), `report_gate` (bool), `waiver_records` (list, as `alternatives`). The last two are read by the state page only. `report_gate` on a required rule whose other records are none an anonymous adult can get on her own (Delaware 9010(a)(5)) makes the share card say the program asks for a police report. `waiver_records` on a required rule names records that let the program waive the report in its discretion (Iowa r. 61-9.29(4)(c)); with forensic_exam, the card says a forensic exam can sometimes count. Where the exam is also among the rule's `alternatives` (Rhode Island 12-25-22(a), which gives the office only "the authority to allow" the claim), the tile and the card say the exam counts in some cases. The engines still read only `required` and `alternatives`. A rule about cooperating with police gets a `scope` and shows in its own words. |
| `minimum_loss` | minimum out-of-pocket loss to qualify | `amount_cents` and/or `days_lost`, optional `waived_for`. With neither, it states a need test in its own words (Kansas financial stress, Florida serious financial hardship) and is information only. |
| `collateral_source` | program pays after insurance and other sources | none |
| `conduct_reduction` | award may be reduced for the victim's conduct (shown as information only; Tend never screens on it). A rule about cooperating with police or the program is shown in the police section. | none |
| `emergency_award` | emergency or advance award exists | optional `amount_cents` |
| `eligible_crime` | sexual assault (or similar) is a covered crime | none |
| `residency` | who can apply (residents, crimes in state, out-of-state victims, and other who-can-apply rules the program states) | `rule` (text) |
| `submission` | how to file: one rule per method | `method` (mail, online, email, fax, in_person), `target` (the address, URL, email, or fax number exactly as written), optional `condition` (who may use this way to file) |
| `required_document` | a document the program asks applicants to include or provide | `document` (photo_id, itemized_bill, receipts, police_report, exam_record, wage_verification, medical_records, insurance_statement, counseling_statement, proof_of_residency, other), optional `note` |
| `processing_time` | stated time for a decision or payment | `days` (or `weeks`/`months`) |
| `address_confidentiality` | the state's address confidentiality program (substitute address for survivors on government records and forms) | `program_name`, `agency`, `covers_sexual_assault` (bool), `enroll` (how, as written) |
| `record_confidentiality` | the compensation program's records or claims are confidential by law, or a program's stated privacy procedure | optional `scope` (only some records are confidential) |

## Expense types (`expense`)

`medical`, `forensic_exam`, `counseling`, `lost_wages`, `transportation`, `relocation`,
`temporary_housing`, `security`, `crime_scene_cleanup`, `childcare`, `property_replacement`,
`clothing_bedding`, `prescription`, `dental`, `funeral`, `legal`, `tuition`, `other`.

## Words the page prints from params

Some params are plain text that the state page puts into its own sentences. Each one must
say no more than the rule's own quote, and every number in it must appear in that quote
(verify.py checks this). Write them in plain words, short enough that the sentence they
join stays at grade 9 or below. Never use "never".

- `condition`: when or for whom the rule holds. On exam_no_bill and exam_payment it is an
  "if" clause that reads after "You should not have to pay for a forensic exam":
  "if you are 16 or older", "if done within 15 days of the assault", "if the crime was in
  Ohio". On total_cap and filing_deadline it is a phrase that reads after the amount or the
  period: "for a crime on or after July 1, 2025", "not counting funeral, cremation, and
  burial costs". On submission it says who may use that way to file.
- `scope`: what the rule covers, as a noun phrase. On exam_no_bill it replaces "a forensic
  exam" ("the forensic part of an exam or the evidence kit"). On covered_expense it names
  the row ("mileage to medical or mental health treatment only, at least 5 miles one way").
  On reporting_requirement and expense_cap it marks a rule about something narrower than
  the program's general rule; those rules are shown in their own words only and the
  normalizer lists them as information.
- `exception`: a clause printed after a total amount or a report window, usually starting
  with "or", "unless" or "counted from": "or up to $25,000 in extraordinary cases". When the
  window itself holds only for some crimes, the clause starts with that limit: "for a crime
  on or after October 1, 2019, or later with good cause".
- `extension`: on the general deadline rule, a clause that starts with "or" or "unless"
  ("or later if the board finds good cause"), or one plain sentence. It must come from
  the rule's own quote. Other deadline rules may keep any text.
- `exam_condition`: a phrase that reads after "a forensic exam": "done within 120 hours of
  the assault".
- `item`: the thing a cap or an "other" cost covers, as a noun phrase.
- `only_benefit_if`: an "if" clause naming who can get only this cost.
- `total_condition`: on the rule with `only_benefit_if`, an "if" clause from its quote naming whom the
  program's total is for, which the total tile and the card add after the amount: "if you were
  physically hurt".
- `detail`, `outside_total_cap`, `charge_required`: booleans, described in the table above.

## Page notes

A jurisdiction file may have `page_notes`, an object from a section id (costs, exam,
police, deadline, privacy, urgent) to one note in Tend's own words. Use it only when a
program's own documents disagree with the law the page follows, or to say what Tend
searched and did not find. Start it with "Note: ". It is shown first in its section, styled
as a note, with no citation.

## Rules for researchers

1. Quotes are copied from the `.txt` snapshot, never paraphrased. One sentence or clause is enough.
2. Every number in `params` (dollars, days, years, weeks) must appear in that rule's quote.
3. Prefer statutes and regulations; use agency pages and PDFs when they state the rule more plainly or the statute is unavailable. Statutes win when sources disagree; record the disagreement in `researcher_notes`.
4. Never name people or describe specific crimes. No case law.
5. Run `python3 rules/tools/verify.py <ST>` until it prints `PASS`.
6. A text param must come from the rule's own quote. If the words you need are in the next
   sentence, extend the quote or add a rule; do not write them into the param.
7. Use `applies_to` only for a rule about someone other than the survivor (a family member,
   an institution). For a narrower case of the survivor's own claim use `condition` or `scope`.
8. A rule that waives the police report only for the forensic exam gets `expense:
   "forensic_exam"`, so it never reads as a waiver for the compensation claim.

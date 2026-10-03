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
| `exam_no_bill` | survivor may not be billed for a sexual assault forensic exam | `insurance_billing`: prohibited, consent_required, allowed, unspecified |
| `exam_payment` | who pays for the exam (state fund, program, county) | `payer` (text) |
| `total_cap` | maximum total award | `amount_cents` |
| `expense_cap` | cap on one expense type | `expense`, `amount_cents`, `per` (claim, week, session, hour, mile, day), optional `count_limit` |
| `covered_expense` | an expense type is reimbursable | `expense` |
| `excluded_expense` | an expense type is not reimbursable | `expense` or `item` (text) |
| `filing_deadline` | time limit to apply | `years` or `days`, `from` (crime, discovery, report, age_18), optional `extension` |
| `reporting_requirement` | police report rules | `required` (bool), optional `within_days`, `alternatives` (list: forensic_exam, protective_order, advocate, medical_provider, other) |
| `minimum_loss` | minimum out-of-pocket loss to qualify | `amount_cents` and/or `days_lost`, optional `waived_for` |
| `collateral_source` | program pays after insurance and other sources | none |
| `conduct_reduction` | award may be reduced for the victim's conduct (shown as information only; Tend never screens on it) | none |
| `emergency_award` | emergency or advance award exists | optional `amount_cents` |
| `eligible_crime` | sexual assault (or similar) is a covered crime | none |
| `residency` | who can apply (residents, crimes in state, out-of-state victims) | `rule` (text) |
| `submission` | how to file: one rule per method | `method` (mail, online, email, fax, in_person), `target` (the address, URL, email, or fax number exactly as written) |
| `required_document` | a document the program asks applicants to include or provide | `document` (photo_id, itemized_bill, receipts, police_report, exam_record, wage_verification, medical_records, insurance_statement, counseling_statement, proof_of_residency, other), optional `note` |
| `processing_time` | stated time for a decision or payment | `days` (or `weeks`/`months`) |

## Expense types (`expense`)

`medical`, `forensic_exam`, `counseling`, `lost_wages`, `transportation`, `relocation`,
`temporary_housing`, `security`, `crime_scene_cleanup`, `childcare`, `property_replacement`,
`clothing_bedding`, `prescription`, `dental`, `funeral`, `legal`, `tuition`, `other`.

## Rules for researchers

1. Quotes are copied from the `.txt` snapshot, never paraphrased. One sentence or clause is enough.
2. Every number in `params` (dollars, days, years, weeks) must appear in that rule's quote.
3. Prefer statutes and regulations; use agency pages and PDFs when they state the rule more plainly or the statute is unavailable. Statutes win when sources disagree; record the disagreement in `researcher_notes`.
4. Never name people or describe specific crimes. No case law.
5. Run `python3 rules/tools/verify.py <ST>` until it prints `PASS`.

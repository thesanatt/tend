# Tend verified rules, version 1.0

Tend's law library as data: the rules of the crime victim compensation programs in the 50 states and
DC that Tend (https://youreowed.tech) found and verified. Each rule pairs a plain-language summary with a verbatim
quote from a source that Tend saved (a statute, a regulation, or a program's own page, PDF, or
application form), the pinpoint citation, the source's address, and the sha256 of the saved copy.

Tend is a prototype built by Sanat Gupta at MHacks 2026 to help sexual assault survivors claim crime
victim compensation. This dataset is made from `rules/verified` and `rules/ir` in https://github.com/thesanatt/tend by
`rules/tools/export_dataset.py`.

Tend is not legal advice. It shows what each program's own rules say, with the quote. The program
decides.

## What is in version 1.0

- 2,578 rules for 51 jurisdictions (the 50 states and DC), quoted from 617 of the 824 sources Tend saved. The other 207 were saved and fingerprinted too, but no rule quotes them.
- Current as of the dates the sources were saved: Oct 3, 2026, between 18:47 and 20:02 UTC. 120 of them are copies from sites that republish state law, which may lag behind it (see Limitations).
- 1,327 decision rules, 1,189 information rules, and 62 set aside (see engine_use below).
- 1,546 rules quote an HTML source and have a link that opens the page at the quote.
- Rules per jurisdiction: from 33 (West Virginia) to 83 (Michigan). The number shows how much Tend found and quoted, not how generous a state's law is.
- Confidence, as recorded for each jurisdiction: 38 high, 13 medium, 0 low.

| Source kind | Sources | Rules quoting them |
|---|---|---|
| agency_page | 241 | 431 |
| agency_pdf | 92 | 293 |
| application_form | 57 | 344 |
| regulation | 70 | 454 |
| statute | 364 | 1,056 |

## Files

| File | What it holds | Bytes |
|---|---|---|
| `tend-rules-v1.0.json` | Everything in one file: `metadata`, `jurisdictions`, `sources`, and `rules` | 3,952,384 |
| `tend-rules-v1.0.csv` | One row per rule (2,578 rows) | 2,126,975 |
| `tend-sources-v1.0.csv` | One row per saved source (824 rows) | 307,190 |
| `tend-jurisdictions-v1.0.csv` | One row per jurisdiction (51 rows): the program, coverage notes, and counts | 332,142 |
| `README.md` | This file |  |
| `SHA256SUMS` | The sha256 of every other file |  |

Check a download with `shasum -a 256 -c --ignore-missing SHA256SUMS` (macOS) or
`sha256sum -c --ignore-missing SHA256SUMS` (Linux), run in the folder that holds the files. Without
`--ignore-missing`, each file you did not download is reported as FAILED.

The CSV files are UTF-8 without a byte order mark, comma separated, with one header row and LF line
ends. A field is quoted only when it has to be (RFC 4180 quoting); quotes keep their line breaks, so
some quoted fields span lines, which any CSV reader handles. An empty cell means no value (`null` in
the JSON). Booleans are `true` and `false`. Cells that hold an object or a list (`params`,
`coverage_found`, `coverage_not_found`) hold it as JSON.

In Excel, open a CSV with Data > From Text/CSV and choose UTF-8; opened directly, characters such as
the section sign can show up garbled. Values are written exactly as they are in the rules.
One cell starts with `-`, `=`, `+`, or `@` (the `quote` of VT-TRAVEL-2), which a spreadsheet may try to read as a formula; import the columns as text to see every
value as written.

## Data dictionary

### Rules (`tend-rules-v1.0.csv`, and `rules` in the JSON)

In the JSON, `params` is an object and an empty cell is `null`; otherwise the columns are the same.

| Column | Type | Meaning |
|---|---|---|
| `rule_id` | text | The rule's id, unique in the dataset. It starts with the jurisdiction code, for example `MI-EXAM-1`. |
| `jurisdiction` | text | Two-letter code of the state, or `DC`. |
| `jurisdiction_name` | text | The jurisdiction's name. |
| `category` | text | What the rule is about. One of the categories in the table below. |
| `expense` | text or empty | The expense type the rule is about, one of the expense types below: the rule's own `expense` field, or `params.expense` when that is the only one (`verify.py` and `normalize.py` read it the same way). Empty when the rule is not about one expense type. |
| `params` | JSON object | The rule's details, as written in `rules/verified/ST.json`. See Params below. Money is in cents: `4500000` is $45,000. |
| `summary` | text | Tend's plain-language reading of the quote. Not a quote, and not the law's words. |
| `quote` | text | The words of the source, exactly as stored in the rule, line breaks included. See Methodology for how it was checked. |
| `pinpoint` | text | Where in the source the quote is: a section, subsection, or page, for example `MCL 18.355a(2)`. |
| `source_id` | text | The source the quote is from. Matches `source_id` in the sources file. |
| `source_title` | text | The source's title. |
| `source_kind` | text | `statute`, `regulation`, `agency_page`, `agency_pdf`, or `application_form`. |
| `source_url` | URL | Where the source was saved from. Some are copies on sites that republish state law; see Limitations. |
| `fragment_url` | URL or empty | `source_url` with a text fragment (`#:~:text=`) that opens the page at the quote, in browsers that support text fragments. Only for HTML sources; empty for PDFs. |
| `retrieved_at` | timestamp | When the source was saved, in UTC (ISO 8601). |
| `source_sha256` | hex | The sha256 of the saved source file, 64 hex characters. |
| `engine_use` | text | What Tend's law engine does with the rule: `decision`, `information`, or `set_aside`. See below. |
| `set_aside_reason` | text or empty | Why `normalize.py` set the rule aside. Empty unless `engine_use` is `set_aside`. |

#### Categories

Meanings and params as `rules/SCHEMA.md` defines them.

| `category` | Meaning | Params (rules/SCHEMA.md) | Rules | Jurisdictions |
|---|---|---|---|---|
| `exam_no_bill` | survivor may not be billed for a sexual assault forensic exam | `insurance_billing`: prohibited, consent_required, allowed, unspecified | 105 | 50 |
| `exam_payment` | who pays for the exam (state fund, program, county) | `payer` (text) | 113 | 47 |
| `total_cap` | maximum total award | `amount_cents` | 55 | 49 |
| `expense_cap` | cap on one expense type | `expense`, `amount_cents`, `per` (claim, week, session, hour, mile, day), optional `count_limit` | 308 | 49 |
| `covered_expense` | an expense type is reimbursable | `expense` | 410 | 51 |
| `excluded_expense` | an expense type is not reimbursable | `expense` or `item` (text) | 174 | 50 |
| `filing_deadline` | time limit to apply | `years` or `days`, `from` (crime, discovery, report, age_18), optional `extension` | 89 | 48 |
| `reporting_requirement` | police report rules | `required` (bool), optional `within_days`, `alternatives` (list: forensic_exam, protective_order, advocate, medical_provider, other) | 144 | 50 |
| `minimum_loss` | minimum out-of-pocket loss to qualify | `amount_cents` and/or `days_lost`, optional `waived_for` | 14 | 13 |
| `collateral_source` | program pays after insurance and other sources | none | 93 | 51 |
| `conduct_reduction` | award may be reduced for the victim's conduct (shown as information only; Tend never screens on it) | none | 92 | 50 |
| `emergency_award` | emergency or advance award exists | optional `amount_cents` | 44 | 40 |
| `eligible_crime` | sexual assault (or similar) is a covered crime | none | 90 | 51 |
| `residency` | who can apply (residents, crimes in state, out-of-state victims) | `rule` (text) | 87 | 51 |
| `submission` | how to file: one rule per method | `method` (mail, online, email, fax, in_person), `target` (the address, URL, email, or fax number exactly as written) | 154 | 51 |
| `required_document` | a document the program asks applicants to include or provide | `document` (photo_id, itemized_bill, receipts, police_report, exam_record, wage_verification, medical_records, insurance_statement, counseling_statement, proof_of_residency, other), optional `note` | 468 | 51 |
| `processing_time` | stated time for a decision or payment | `days` (or `weeks`/`months`) | 41 | 31 |
| `address_confidentiality` | the state's address confidentiality program (substitute address for survivors on government records and forms) | `program_name`, `agency`, `covers_sexual_assault` (bool), `enroll` (how, as written) | 49 | 48 |
| `record_confidentiality` | the compensation program's records or claims are confidential by law | none | 48 | 48 |

The Rules and Jurisdictions columns include rules that are set aside (see engine_use).
In WY for `exam_no_bill`, CT and IL for `total_cap`, and SC for `expense_cap`, every rule of the category is set aside, so the engine uses none of them there.

#### Expense types

| `expense` | Rules |
|---|---|
| `medical` | 114 |
| `forensic_exam` | 240 |
| `counseling` | 131 |
| `lost_wages` | 136 |
| `transportation` | 83 |
| `relocation` | 57 |
| `temporary_housing` | 20 |
| `security` | 42 |
| `crime_scene_cleanup` | 48 |
| `childcare` | 24 |
| `property_replacement` | 64 |
| `clothing_bedding` | 30 |
| `prescription` | 32 |
| `dental` | 34 |
| `funeral` | 38 |
| `legal` | 21 |
| `tuition` | 5 |
| `other` | 42 |

1,417 rules name no expense type.

#### Params

`params` holds what `rules/SCHEMA.md` asks for in each category (the table above). Some rules also
have keys the schema does not define, where it had no field; their meaning is in the rule's quote.
`normalize.py` reads three of them: `applies_to` (a rule whose `applies_to` does not name the survivor
is set aside; see engine_use), `scope` (a reporting rule or a cap on one expense with a scope becomes
information), and `within_hours` (turned into days, rounded up).
`verify.py` checks that the numbers in `amount_cents`, `years`, `months`, `weeks`, `days`, `within_days`, `count_limit`, and `days_lost` appear in the quote.
In this release every integer value in `params` does, including the keys `verify.py` does not check (`hours_per_week`, `min_days`, `min_months`, and `within_hours`).
Numbers written inside text values, such as section numbers in a `note` or `extension`, are not checked.

| Key | Rules | Types | In rules/SCHEMA.md |
|---|---|---|---|
| `expense` | 705 | text | yes |
| `note` | 487 | text | yes |
| `document` | 468 | text | yes |
| `amount_cents` | 393 | integer, null | yes |
| `per` | 308 | text | yes |
| `item` | 162 | text | yes |
| `method` | 154 | text | yes |
| `target` | 154 | text | yes |
| `required` | 144 | boolean | yes |
| `payer` | 113 | text | yes |
| `insurance_billing` | 105 | text | yes |
| `alternatives` | 103 | list of text | yes |
| `rule` | 87 | text | yes |
| `from` | 84 | text | yes |
| `extension` | 73 | text | yes |
| `years` | 68 | integer | yes |
| `agency` | 49 | text | yes |
| `covers_sexual_assault` | 49 | boolean | yes |
| `enroll` | 49 | text | yes |
| `program_name` | 49 | text | yes |
| `days` | 31 | integer | yes |
| `applies_to` | 27 | text | no |
| `count_limit` | 26 | integer | yes |
| `county` | 15 | text | no |
| `months` | 14 | integer | yes |
| `within_days` | 14 | integer | yes |
| `stage` | 10 | text | no |
| `waived_for` | 8 | list of text, text | yes |
| `weeks` | 8 | integer | yes |
| `scope` | 6 | text | no |
| `min_days` | 4 | integer | no |
| `within_hours` | 4 | integer | no |
| `basis` | 3 | text | no |
| `good_cause_exception` | 3 | boolean | no |
| `min_months` | 3 | integer | no |
| `days_lost` | 2 | integer | yes |
| `cooperation_required` | 1 | boolean | no |
| `hours_per_week` | 1 | integer | no |

Values found for the keys `rules/SCHEMA.md` gives a fixed list for. Values in the last column are
not in the schema's list.

| Key | Schema values (rules in this release) | Other values (rules) |
|---|---|---|
| `insurance_billing` | prohibited (20), consent_required (22), allowed (15), unspecified (48) | none |
| `per` | claim (251), week (23), session (10), hour (9), mile (0), day (8) | crime_scene (1), item (4), month (1), residence (1) |
| `from` | crime (57), discovery (7), report (7), age_18 (11) | age_21 (1), receipt of all required information (1) |
| `alternatives` | forensic_exam (35), protective_order (20), advocate (12), medical_provider (22), other (28) | none |
| `method` | mail (65), online (32), email (23), fax (25), in_person (9) | none |
| `document` | photo_id (2), itemized_bill (60), receipts (53), police_report (29), exam_record (6), wage_verification (58), medical_records (26), insurance_statement (38), counseling_statement (18), proof_of_residency (2), other (176) | none |

#### engine_use

`rules/tools/normalize.py` turns each verified file into the law IR the engine runs (`rules/ir/ST.json`).
The IR either carries a rule, as a decision or as information, or lists it under `skipped` with a reason.

| Value | Rules | Meaning |
|---|---|---|
| `decision` | 1,327 | Compiled into the law the engine runs: exam billing and who pays for the exam, total caps, caps on one expense, covered and excluded expenses, filing deadlines, police reporting, minimum loss, and paying after insurance (`collateral_source`). Such a rule can decide a line's status or amount or a check's result, or be cited as proof for one. Where several rules of one kind apply, `docs/SPEC.md` says how they combine; for example, the smallest total cap and the longest deadline are used. |
| `information` | 1,189 | Shown with its quote. It changes no amount and no status. |
| `set_aside` | 62 | Not used. `set_aside_reason` says why. |

How `normalize.py` decides:

- Information: every rule in `conduct_reduction`, `emergency_award`, `eligible_crime`, `residency`,
  `submission`, `required_document`, `processing_time`, `address_confidentiality`, and
  `record_confidentiality`. Also a rule the engine cannot apply as written: a covered expense with no
  expense type; an exclusion whose item matches none of the engine's tags (phone, purse, jewelry, cash,
  vehicle, pain and suffering), or that names neither an expense nor an item; a deadline with no length,
  or one counted from something other than the crime, the incident, its discovery, the injury, the
  offense, or the police report (an 18th birthday, for example); a minimum loss with no amount and no
  number of days, unless its quote says there is no minimum; a reporting rule or a cap on one expense
  whose `params` has a `scope`; and two caps whose own quote describes something other than the program's limit on the
  survivor's cost (NV-CAP-WAGE-3, an approval a Compensation Officer may give alone, and TX-EXAM-3, an
  emergency payment made apart from the award).
- Set aside: a rule whose `params.applies_to` does not name the survivor (it names family members or
  secondary victims, or a narrower case such as travel to court or crimes from certain dates); a cap
  with no amount, no expense type, or a unit `normalize.py` cannot read; and a cap that duplicates
  another cap on the same expense and unit and is no more generous. The most generous cap is kept, the
  first of them when two are equal; of those set aside, 28 are lower than the cap kept and 3 are equal
  to it. Their `set_aside_reason` says "less generous duplicate of" either way.
- Decision: every other rule.

`normalize.py` can also narrow how a decision rule applies. AK-COUNSEL-1, for example, keeps its $200
a session rate but not its 24-session initial award. `rules/ir` has the engine's exact reading of
every rule.

One kind of decision rule can end up as information. Who pays for the exam (`exam_payment`) is cited
as proof for a held exam line, and the engine holds an exam line only where the jurisdiction has an
`exam_no_bill` rule with `engine_use` decision.
Rhode Island has no `exam_no_bill` rule in this release.
Wyoming's only `exam_no_bill` rule, WY-EXAM-2, is set aside because it covers only exams reported to law enforcement.
So the engine lists their 5 `exam_payment` rules (RI-EXAM-1, WY-EXAM-1, WY-EXAM-4, WY-EXAM-5, WY-EXAM-7) as information.

| Reasons for set_aside | Rules |
|---|---|
| A duplicate of another cap, no more generous | 31 |
| `params.applies_to` does not name the survivor | 20 |
| `expense_cap without amount or expense` | 11 |

### Sources (`tend-sources-v1.0.csv`, and `sources` in the JSON)

| Column | Type | Meaning |
|---|---|---|
| `source_id` | text | The source's id, unique in the dataset, for example `MI-S4`. |
| `jurisdiction` | text | Two-letter code of the state, or `DC`. |
| `title` | text | The source's title. |
| `kind` | text | `statute`, `regulation`, `agency_page`, `agency_pdf`, or `application_form`. |
| `format` | text | `html` or `pdf`: the saved file's type, read from its extension the way `verify.py` reads it. |
| `url` | URL | Where the source was saved from. Some are copies on sites that republish state law; see Limitations. |
| `retrieved_at` | timestamp | When it was saved, in UTC (ISO 8601). |
| `sha256` | hex | The sha256 of the saved file, recorded when it was saved. For the 13 pages whose `note` says so, it was recorded again after API keys embedded in the page were redacted. `verify.py` checks it on every run. |
| `text_sha256` | hex | The sha256 of the text extracted from the saved file, which quotes are matched against. Computed by the export; not recorded when the source was saved. |
| `raw_path` | path | The saved file in the repository (https://github.com/thesanatt/tend). |
| `text_path` | path | The extracted text in the repository. |
| `note` | text or empty | A note about the saved copy. |
| `rules` | integer | How many rules quote this source. It is 0 for 207 sources, which were saved but are quoted by no rule; 11 of those are where a program's phone number or application form comes from. |

### Jurisdictions (`tend-jurisdictions-v1.0.csv`, and `jurisdictions` in the JSON)

In the JSON, the `program_name` to `statute_citation` columns and the `application_form_` columns are
the `program` object (with `application_form` inside it), and the `coverage_` columns are the
`coverage` object, all as written in `rules/verified/ST.json`.

| Column | Type | Meaning |
|---|---|---|
| `code` | text | Two-letter code of the state, or `DC`. |
| `name` | text | The jurisdiction's name. |
| `program_name` | text | The compensation program's name. |
| `agency` | text | The agency that runs it. |
| `website` | URL | The program's website. |
| `apply_url` | URL | Where the program says how to apply. |
| `application_pdf_url` | URL or empty | The application form, when there is one to download. |
| `phone` | text | The program's phone number. |
| `phone_source_id` | text | The source the phone number was taken from. |
| `statute_citation` | text | The statute that sets up the program. |
| `application_form_source_id` | text or empty | The saved copy of the application form. Empty for ME, ND, and TN, which have none saved. |
| `application_form_fillable` | boolean | Whether that PDF has fillable fields; `false` when no form is saved. |
| `application_form_field_count` | integer | How many fields it has; `0` when no form is saved. |
| `confidence` | text | `high`, `medium`, or `low`, as recorded for the jurisdiction. |
| `coverage_found` | JSON list of text | Categories the research found for this jurisdiction. GA, LA, and MS also list some as category:expense, for example `covered_expense:childcare`. |
| `coverage_not_found` | JSON list of text | What the research looked for and did not find or could not verify, in its own words. |
| `coverage_notes` | text | Notes on what was and was not found. |
| `researcher_notes` | text | Anything a reviewer should know, such as where sources disagree. |
| `rules` | integer | Rules for this jurisdiction. |
| `sources` | integer | Saved sources for this jurisdiction. |
| `decision_rules` | integer | Rules with `engine_use` decision. |
| `information_rules` | integer | Rules with `engine_use` information. |
| `set_aside_rules` | integer | Rules with `engine_use` set_aside. |
| `verified_sha256` | hex | The sha256 of `rules/verified/ST.json` in the repository. A law image compiled from that file names the same sha256 in its header. |
| `ir_sha256` | hex | The sha256 of `rules/ir/ST.json`, where `engine_use` comes from. |

### `tend-rules-v1.0.json`

One object with four keys. `metadata` has `name`, `version`, `description`, `homepage`, `repository`,
`generated_by`, `current_as_of` (the first and last `retrieved_at` of the sources, and in
`justia_code_years` the year of the code the saved Justia copies show), `counts`, `license`, and
`not_legal_advice`. It has no timestamp of its own. `jurisdictions`, `sources`, and `rules` are arrays
with the columns described above.

## Methodology

How the rules were made, as `rules/SCHEMA.md` and `docs/ARCHITECTURE.md` in the repository describe it:

1. Save the source. `rules/tools/fetch_source.py` saves the raw bytes of a page or PDF, the text
   extracted from it, and the sha256 of the raw bytes. It tries a plain HTTPS request first and falls
   back to a real Chrome tab when a site serves a challenge page.
   For 8 pages the saved text is not what it extracts; see the end of this section.
2. Write the rule. Each rule is written in `rules/jurisdictions/ST.json`: its category, params, a
   plain summary, the quote, copied from the saved text and never paraphrased, and a pinpoint
   citation. `rules/SCHEMA.md` says to prefer statutes and regulations, to use agency pages and PDFs
   when they state the rule more plainly or the statute is unavailable, to let statutes win when
   sources disagree and record the disagreement in `researcher_notes`, and never to name people,
   describe specific crimes, or cite case law.

   > **TODO (Sanat): placeholder.** Say who drafted the rules and how they were reviewed.

3. Verify. `rules/tools/verify.py` accepts a rule only if three things hold:
   - Its quote is a substring of the saved source's text after both are normalized the same way:
     Unicode NFKC, soft hyphens removed, curly quotes made straight, en and em dashes made hyphens,
     and each run of whitespace made one space.
   - The numbers in its params and its summary appear in the quote: `amount_cents` (as dollars),
     `years`, `months`, `weeks`, `days`, `within_days`, `count_limit`, and `days_lost`, and every number
     in the summary except 0 and 1. Numbers written as words count: "thirty days" is 30.
   - The saved source file's sha256 still matches the one recorded for it.

   `verify.py` also accepts a quote that matches only when case is ignored, with a warning. No quote
   in this release needs that: each one matches with its case as written. Passing files go to
   `rules/verified`, with a text-fragment link for each rule from an HTML source.
4. Decide what the engine does with each rule. `rules/tools/normalize.py` writes the law IR
   (`rules/ir`) and so decides `engine_use`, as described above.
5. Export. `rules/tools/export_dataset.py` reads `rules/verified` and `rules/ir` and writes these files.
   It reads no clock, so the same inputs give the same bytes.

Check it yourself on macOS or Linux, from a clone of the repository:

```sh
python3 rules/tools/verify.py all                    # every jurisdiction prints PASS
python3 rules/tools/export_dataset.py --check        # these files match the rules they came from
uv run --with pytest pytest rules/tools/test_export_dataset.py
```

The tests check every quote against its saved source text with `verify.py`'s own normalization,
every sha256 against the saved files, that the CSV and JSON files agree, and that the export gives
the same bytes each time.

The sha256 recorded for a source covers its raw file, not the extracted text (`text_path`) that quotes
are matched against. With BeautifulSoup and pdftotext installed, the tests also extract the text again
from each raw file and look for every quote in it:

```sh
uv run --with pytest --with beautifulsoup4 pytest rules/tools/test_export_dataset.py
```

In version 1.0, every quote is found that way too: in all the text BeautifulSoup reads from an
HTML page, and in what pdftotext 26.04 reads from a PDF.

A second opt-in test runs `fetch_source.py`'s own extraction on each saved HTML page and compares it
with the saved text, after `verify.py`'s normalization. They match for every HTML source but 8:
OH-S16, TN-S15, WI-S3, WI-S4, WI-S5, WI-S6, WI-S7, and WI-S9, quoted by 22 rules. Each of these pages holds its text inside a
`<form>`, which `fetch_source.py` drops, so it finds almost no text and would refuse the page as
"blocked or empty". Their saved text is what the same extraction gives when it keeps the form, and
every quote from them is in the raw file, as above. `fetch_source.py` would also refuse WV-S12,
a short page, though its saved text is what `fetch_source.py` extracts. This test needs a Python whose
HTML parser reads a page's `<title>` as plain text, as current releases do. It skips on an older one,
such as the Python 3.9.6 that macOS runs as `/usr/bin/python3`.

## Limitations

- A verbatim quote check proves the words exist in the saved source. It does not prove that Tend's
  reading of them is right. The category, the params, the summary, the pinpoint, and `engine_use` are
  Tend's interpretation (`verify.py` checks only that a pinpoint is present), and a rule can be
  misread even when its quote is exact.
- Summaries are Tend's plain-language readings, not the law. Rely on the quote and the source.
- The data is current as of the dates the sources were saved (Oct 3, 2026). Laws and program
  pages change, and nothing re-fetches the sources on a schedule.
- 120 sources are copies on sites that republish state law, not the state's own publication: 103 statutes from Justia (law.justia.com) and 17 regulations from Cornell's Legal Information Institute (law.cornell.edu).
  Each saved Justia page shows its state's 2025 code and says it may not be the most recent version.
  Each saved Cornell page says state regulations are updated there quarterly.
  The 234 rules that quote these copies match the copies, so check the state's own code before relying on one.
- A sha256 shows that the saved copy has not changed since its sha256 was recorded. It cannot show what
  the live page says today, and a live page can differ byte for byte even when its text is the same.
- 13 saved pages have a `note` about third-party API keys embedded in the
  page. The keys were redacted after the page was saved, so their sha256 is of the redacted copy.
- Quotes are matched against the text extracted from each saved file (`text_path`). Text the
  extraction missed could not be quoted.
- Coverage gaps are gaps in Tend's research, not findings about the law. When a category is missing
  for a jurisdiction, or listed in `coverage_not_found`, Tend did not find or verify it in the sources
  it saved. The law may still provide it.
- The dataset is not a full copy of any program's rules. The categories in `rules/SCHEMA.md` are built
  around a sexual assault survivor's own claim.
- Text-fragment links exist only for HTML sources. They open at the quote only in browsers that
  support text fragments, and only while the live page still has those words.
- Some `params` keys are not defined in `rules/SCHEMA.md` (see Params). Read their rule's quote.
- Not legal advice. The program decides.

## How to cite

> **TODO (Sanat): placeholder.** Add the citation once the release is published. There is no DOI
> yet; do not cite one. Shape to fill in: Sanat Gupta, *Tend verified rules*, version 1.0 [data set],
> [release URL], [DOI, if one is minted].

## License

> **TODO (Sanat): no license has been chosen yet.** Suggested for the data: CC BY 4.0. Until a
> license is added here, this dataset has no stated license.

## Contact

> **TODO (Sanat): placeholder.** Add an address for corrections and questions.

# Sources

Where each number comes from. The same list is live at https://youreowed.tech/sources.

## The problem

- **In 2022, 96 percent of violent crime victims got no victim compensation.**
  "In 2022, 96% of violent crime victims did not receive any victim compensation to help them recover."
  Alliance for Safety and Justice (now Just Safe), [Beyond the Headlines: A Decade of Listening to Crime Survivors](https://justsafe.org/news/beyond-headlines-decade-listening-crime-survivors/), October 1, 2025.
  The same 2022 survey is cited by [ABC News, June 22, 2024](https://abcnews.com/Health/super-bowl-parade-shooting-survivors-await-promised-donations/story?id=111316701):
  "96% of victims did not receive that support and many didn't know it existed."
- **Every state and DC runs a crime victim compensation program.** Tend's library holds the official program
  page for all 51, each saved with its sha256 (`rules/sources/`, `rules/verified/`).
- **In 49 of 51 jurisdictions, the rules say a survivor should not be billed for the forensic exam.** Counted
  from the verified rules with category `exam_no_bill` in `rules/ir/`. Rhode Island and Wyoming have none.
- **Michigan: the hospital may not bill the survivor for the exam.** "A health care provider shall not submit a
  bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the
  sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other
  out-of-pocket expense." [MCL 18.355a(2)](https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket).
- **48 jurisdictions have an address confidentiality program.** Counted from the verified rules with category
  `address_confidentiality`.
- **In October 2026, people posted "I am Jane Doe" to protect a survivor's anonymity.** The Associated Press,
  via [ABC News, October 4, 2026](https://abcnews.com/US/wireStory/jane-doe-solidarity-posts-flood-social-media-after-136984033).
  Tend has no tie to her or to the posts.

## Tend's own numbers

- **2,578 rules from 824 saved official sources, for 51 jurisdictions.** `rules/verified/`, checked by
  `rules/tools/verify.py` (every quote word for word in its saved source, every number in its quote).
- **121,000 test claims, 0 differences between the C++ engine and the Python reference engine.**
  `uv run --project refengine python refengine/difftest.py`. All counts: [EVAL.md](EVAL.md).
- **The law engine runs in the browser as 183 KB of WebAssembly.** `web/public/engine/tend.wasm`.

Tend is not legal advice. It shows what each program's own rules say, with the quote. The program decides.

import type { Metadata } from "next";
import Link from "next/link";
import styles from "./sources.module.css";

// Where each number about the problem comes from, and how to rerun Tend's own numbers. Static, no tracking.
export const metadata: Metadata = {
  title: "Sources",
  description: "Where each number Tend cites comes from, with links, and how to rerun Tend's own numbers.",
};

const MCL_18_355A_2 =
  "https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket";
const REPO = "https://github.com/thesanatt/tend";

export default function Sources() {
  return (
    <div className={`page ${styles.sources}`}>
      <h1>Sources</h1>
      <p className={styles.lead}>
        Where each number comes from. Outside facts link to the place that said them. Tend&apos;s own numbers come
        from its code, and you can rerun them.
      </p>

      <section className={styles.group} aria-labelledby="problem">
        <h2 id="problem">The problem</h2>

        <div className={styles.claim}>
          <h3>In 2022, 96 percent of violent crime victims got no victim compensation.</h3>
          <blockquote className={styles.quote}>
            &quot;In 2022, 96% of violent crime victims did not receive any victim compensation to help them
            recover.&quot;
          </blockquote>
          <p className={styles.where}>
            Alliance for Safety and Justice (now Just Safe),{" "}
            <a href="https://justsafe.org/news/beyond-headlines-decade-listening-crime-survivors/">
              Beyond the Headlines: A Decade of Listening to Crime Survivors
            </a>
            , October 1, 2025. The same 2022 survey is cited by{" "}
            <a href="https://abcnews.com/Health/super-bowl-parade-shooting-survivors-await-promised-donations/story?id=111316701">
              ABC News, June 22, 2024
            </a>
            : &quot;96% of victims did not receive that support and many didn&apos;t know it existed.&quot;
          </p>
        </div>

        <div className={styles.claim}>
          <h3>Every state and DC runs a crime victim compensation program.</h3>
          <p className={styles.where}>
            Tend&apos;s law library holds the official program pages for all 51, each saved with a sha256 fingerprint.
            Start at the <Link href="/">law garden</Link> and open any state; each page links to its program.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>In 49 of 51 jurisdictions, the rules say a survivor should not be billed for the forensic exam.</h3>
          <p className={styles.where}>
            Counted from Tend&apos;s verified rules (category exam_no_bill), each a word-for-word quote of its source.
            Rhode Island and Wyoming have no such rule in the library. See any state&apos;s{" "}
            <Link href="/law/MI">How Tend decides</Link> page for the rule and its quote.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>Michigan: the hospital may not bill the survivor for the exam.</h3>
          <blockquote className={styles.quote}>
            &quot;A health care provider shall not submit a bill for any portion of the costs of a sexual assault
            medical forensic examination to the victim of the sexual assault, including any insurance deductible or
            co-pay, denial of claim by an insurer, or any other out-of-pocket expense.&quot;
          </blockquote>
          <p className={styles.where}>
            <a href={MCL_18_355A_2}>MCL 18.355a(2)</a>, Michigan Legislature. The link opens the statute at that
            sentence.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>48 jurisdictions have an address confidentiality program.</h3>
          <p className={styles.where}>
            Counted from Tend&apos;s verified rules (category address_confidentiality). Each state page shows its
            program and the quote, under Privacy.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>In October 2026, people posted &quot;I am Jane Doe&quot; to protect a survivor&apos;s anonymity.</h3>
          <p className={styles.where}>
            The Associated Press, via{" "}
            <a href="https://abcnews.com/US/wireStory/jane-doe-solidarity-posts-flood-social-media-after-136984033">
              ABC News, October 4, 2026
            </a>
            : the posts were meant to protect her from people trying to find her real name online. Tend has no tie to
            her or to the posts; it borrows only the idea that you should not have to give your name.
          </p>
        </div>
      </section>

      <section className={styles.group} aria-labelledby="tend">
        <h2 id="tend">Tend&apos;s own numbers</h2>

        <div className={styles.claim}>
          <h3>2,578 rules from 824 saved official sources, for 51 jurisdictions.</h3>
          <p className={styles.where}>
            The rules are in <a href={`${REPO}/tree/main/rules/verified`}>rules/verified</a>. A rule is accepted only if
            its quote appears word for word in the saved source and every number in it appears in the quote (
            <a href={`${REPO}/blob/main/rules/tools/verify.py`}>verify.py</a>).
          </p>
        </div>

        <div className={styles.claim}>
          <h3>121,000 test claims, 0 differences between the two law engines.</h3>
          <p className={styles.where}>
            The C++ engine and a separate Python engine written from the same spec agree byte for byte. Rerun:{" "}
            <code>uv run --project refengine python refengine/difftest.py</code>. Every test count is in{" "}
            <a href={`${REPO}/blob/main/docs/EVAL.md`}>docs/EVAL.md</a>.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>The law engine runs in your browser as 183 KB of WebAssembly.</h3>
          <p className={styles.where}>
            The file is <a href="/engine/tend.wasm">/engine/tend.wasm</a>; each state&apos;s compiled law is under{" "}
            <a href="/engine/laws/index.json">/engine/laws</a>.
          </p>
        </div>
      </section>

      <p className={styles.note}>
        Tend is not legal advice. It shows what each program&apos;s own rules say, with the quote. The program
        decides.
      </p>
    </div>
  );
}

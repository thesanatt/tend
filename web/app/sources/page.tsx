import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { engineKb } from "@/app/how-it-works/engine";
import { loadCorpus } from "@/components/public/data";
import { sitePreview } from "@/components/public/og/siteCard";
import { addressPrograms, examNoBill, names, republished, type ExamCount } from "./counts";
import styles from "./sources.module.css";

// Where each number about the problem comes from, and how to rerun Tend's own numbers. Static, no tracking.
export const metadata: Metadata = {
  title: "Sources",
  description: "Where each number Tend cites comes from, with links, and how to rerun Tend's own numbers.",
  ...sitePreview("sources"),
};

const MCL_18_355A_2 =
  "https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket";
const USC_34_10449 =
  "https://www.govinfo.gov/content/pkg/USCODE-2024-title34/html/USCODE-2024-title34-subtitleI-chap101-subchapXIX-sec10449.htm";
const GAO_24_106036 = "https://www.gao.gov/products/gao-24-106036";
const REPO = "https://github.com/thesanatt/tend";

const n = (x: number) => x.toLocaleString("en-US");
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const word = (x: number) => WORDS[x] ?? n(x);
const Word = (x: number) => word(x).charAt(0).toUpperCase() + word(x).slice(1);

// GAO-24-106036, page 12: the six states with no law or policy that explicitly says survivors must not be billed.
const GAO_SIX: Record<string, string> = {
  HI: "Hawaii",
  ID: "Idaho",
  OK: "Oklahoma",
  RI: "Rhode Island",
  VA: "Virginia",
  WY: "Wyoming",
};

// Why a GAO state is still counted, in its rule's own terms. Shown only while the state is counted.
const STILL_COUNTED: Record<string, ReactNode> = {
  OK: (
    <>
      An <Link href="/law/OK#OK-EXAM-1">Oklahoma statute</Link> lists a free forensic exam among a sexual assault
      victim&apos;s rights.
    </>
  ),
  VA: (
    <>
      <Link href="/law/VA#VA-EXAM-3">Virginia&apos;s notice to patients</Link> says evidence collection is at no cost to
      them.
    </>
  ),
};

// Why a jurisdiction is not counted. Shown only while it is not; others get a sentence built from the data.
const NOT_COUNTED: Record<string, ReactNode> = {
  WY: (
    <>
      <Link href="/law/WY#WY-EXAM-2">Wyoming&apos;s rule</Link> covers only survivors who report to police, so Tend does
      not apply it to every exam.
    </>
  ),
  RI: <>For Rhode Island, Tend&apos;s verified rules don&apos;t include an exam-billing rule.</>,
  ID: (
    <>
      <Link href="/law/ID">Idaho&apos;s rules</Link> are narrower. An adult&apos;s private insurance should not be
      billed, and a provider the program has paid may not collect more from the survivor unless the program can&apos;t
      pay the full amount (Idaho Code 72-1026). None of Tend&apos;s verified Idaho rules says the survivor must not be
      billed.
    </>
  ),
  HI: (
    <>
      <Link href="/law/HI#HI-EXAM-1">Hawaii&apos;s rule</Link> is a sentence on the Attorney General&apos;s program page
      about what police are to do, so Tend does not apply it to a bill.
    </>
  ),
};

function notCounted({ st, name, why, rules }: ExamCount["missing"][number]): ReactNode {
  if (NOT_COUNTED[st]) return NOT_COUNTED[st];
  if (why === "none") return <>For {name}, Tend&apos;s verified rules don&apos;t include an exam-billing rule.</>;
  return (
    <>
      <Link href={`/law/${st}#${rules[0]}`}>{name}&apos;s rule</Link> is set aside, so Tend does not apply it to every
      exam.
    </>
  );
}

// Programs Tend found that are not open to sexual assault survivors as such, each in a few words.
const NARROW_ADDRESS: Record<string, string> = {
  FL: "Florida's program covers domestic violence, dating violence, and stalking.",
  AR: "Arkansas's program puts a post office box on the driver's license or ID card of domestic violence victims.",
  SD: "South Dakota's program only keeps a voter record private.",
};

export default function Sources() {
  const kb = engineKb();
  const corpus = loadCorpus();
  const exam = examNoBill();
  const gaoCounted = Object.keys(GAO_SIX).filter((st) => exam.counted.includes(st));
  const address = addressPrograms();
  const copies = republished();
  return (
    <div className={`page ${styles.sources}`}>
      <h1>Sources</h1>
      <p className={styles.lead}>
        Where each number comes from. Outside facts link to the place that said them. Tend&apos;s own numbers come from
        its code, and you can rerun them.
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
            Tend&apos;s law library holds pages or documents saved from each program&apos;s own website, for all 51,
            each with a sha256 fingerprint. For Kentucky, Tend saved the program&apos;s PDFs, such as its FAQ, brochure,
            and application, but no web page. Start at the <Link href="/">law garden</Link> and open any state; each
            page links to its program.
          </p>
        </div>

        <div className={styles.claim}>
          <h3>
            In {exam.counted.length} of {exam.counted.length + exam.missing.length} jurisdictions, Tend&apos;s verified
            rules say a survivor should not be billed for the forensic exam.
          </h3>
          <p className={styles.where}>
            Counted from the verified rules (category exam_no_bill) that Tend&apos;s law engine applies, each a
            word-for-word quote of its source. Some of the counted rules have limits, such as an exam within 96 hours of
            the attack in Arkansas, or only the forensic part of the exam in Texas. See any state&apos;s{" "}
            <Link href="/law/MI">How Tend decides</Link> page for its rules and their quotes.
          </p>
          {exam.missing.length ? (
            <p className={styles.where}>
              {Word(exam.missing.length)} {exam.missing.length === 1 ? "is" : "are"} not counted.
              {exam.missing.map((m) => (
                <Fragment key={m.st}> {notCounted(m)}</Fragment>
              ))}
            </p>
          ) : null}
          <p className={styles.where}>
            A 2024 federal review found six states with no law or policy that explicitly says survivors must not be
            billed: {names(Object.values(GAO_SIX))} (<a href={GAO_24_106036}>GAO-24-106036</a>, page 12).
            {gaoCounted.length ? ` Tend still counts ${word(gaoCounted.length)} of them.` : null}
            {gaoCounted.map((st) => (
              <Fragment key={st}>
                {" "}
                {STILL_COUNTED[st] ?? (
                  <>{GAO_SIX[st]}&apos;s verified rules include one against billing the survivor.</>
                )}
              </Fragment>
            ))}{" "}
            Every state certifies to the Justice Department that a government entity pays the full cost of these exams,
            which federal grant law requires (<a href={USC_34_10449}>34 U.S.C. 10449</a>).
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
          <h3>
            In {address.counted.length} jurisdictions, Tend&apos;s verified rules include an address confidentiality
            program open to sexual assault survivors.
          </h3>
          <p className={styles.where}>
            Counted from the verified rules (category address_confidentiality) whose program covers sexual assault. Many
            of these programs have other conditions, and each program decides who can enroll.
            {address.counted.includes("AK")
              ? " Alaska's program is counted, though none of the Alaska sources Tend saved says how to enroll."
              : null}
          </p>
          <p className={styles.where}>
            {address.narrow.length ? `${Word(address.narrow.length)} more are not counted.` : null}
            {address.narrow.map(({ st, name }) => (
              <Fragment key={st}>
                {" "}
                {NARROW_ADDRESS[st] ?? `${name}'s program is not open to sexual assault survivors as such.`}
              </Fragment>
            ))}
            {address.none.length ? ` Tend's rules include none for ${names(address.none.map((s) => s.name))}.` : null}{" "}
            Each state page shows its program and the quote, under Privacy.
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
          <h3>
            {n(corpus.rules)} rules from {n(corpus.sources)} saved sources, for {corpus.programs} jurisdictions.
          </h3>
          <p className={styles.where}>
            The rules are in <a href={`${REPO}/tree/main/rules/verified`}>rules/verified</a>. A rule is accepted only if
            its quote appears word for word in the saved source and every number in it appears in the quote (
            <a href={`${REPO}/blob/main/rules/tools/verify.py`}>verify.py</a>).
          </p>
          {copies.sources ? (
            <p className={styles.where}>
              {n(copies.sources)} of the sources are copies of state statutes and regulations saved from Justia (
              {n(copies.justia)}) or Cornell&apos;s Legal Information Institute ({n(copies.cornell)}), which reprint
              state law. The {n(copies.rules)} rules that quote them match those copies, so check the state&apos;s own
              code before relying on one. Each state&apos;s How Tend decides page shows where every source was saved
              from.
            </p>
          ) : null}
        </div>

        <div className={styles.claim}>
          <h3>121,000 test claims, 0 mismatches between the two law engines.</h3>
          <p className={styles.where}>
            A separate Python engine, written from the same spec, checks the C++ engine. On the 119,599 claims that are
            valid JSON, both return the same bytes. The other 1,401 are broken on purpose, and both refuse them with the
            same error code (the messages differ). To rerun it, build the engine, then run the test from the repo root.
            It takes about a minute.
          </p>
          <pre className={styles.command} tabIndex={0} aria-label="Commands that rerun the engine test">
            <code>
              {
                "make -C engine\nuv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000"
              }
            </code>
          </pre>
          <p className={styles.where}>
            Every test count is in <a href={`${REPO}/blob/main/docs/EVAL.md`}>docs/EVAL.md</a>.
          </p>
        </div>

        {kb ? (
          <div className={styles.claim}>
            <h3>The law VM runs in your browser as {kb} KB of WebAssembly.</h3>
            <p className={styles.where}>
              The file is <a href="/engine/tend.wasm">/engine/tend.wasm</a>. The compiler, tendc, is not in it: it
              builds each state&apos;s law ahead of time, and each compiled law is its own file under{" "}
              <a href="/engine/laws/index.json">/engine/laws</a>.
            </p>
          </div>
        ) : null}
      </section>

      <p className={styles.note}>
        Tend is not legal advice. It shows what each program&apos;s own rules say, with the quote. The program decides.
      </p>
    </div>
  );
}

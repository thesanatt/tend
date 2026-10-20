import type { Metadata } from "next";
import Link from "next/link";
import { allStates, loadCorpus } from "@/components/public/data";
import LawGarden from "@/components/public/LawGarden";
import { sitePreview } from "@/components/public/og/siteCard";
import StateFinder from "@/components/public/StateFinder";
import { LINKS } from "@/components/tour/links";
import { TOUR_START } from "@/components/tour/tour";
import styles from "./page.module.css";

// The tab keeps the site's title; a posted link shows the home card (/card.png).
export const metadata: Metadata = sitePreview("home");

// Counts come from public/data/jurisdictions.json when the site is built (scripts/sync-rules.mjs).
export default function Home() {
  const corpus = loadCorpus();
  const all = corpus.verified === corpus.programs;
  return (
    <div className={`page ${styles.home}`}>
      {/* For visitors who have never heard of crime victim compensation: what this is, in two minutes. */}
      <section className={styles.visitor} aria-label="About Tend">
        <div className={styles.visitorText}>
          <p className={styles.visitorWhat}>
            Tend helps sexual assault survivors apply for crime victim compensation from their state, without giving
            Tend their name.
          </p>
          {/* The prize links to the Devpost page, the public record a reader can check. It shows "Winner" but not
              the place, so the line does not claim one. */}
          <p className={styles.visitorProof}>
            Built by Sanat Gupta at MHacks 2026 (Oct 3 to 4).{" "}
            <a href={LINKS.devpost}>Winner of Capital One&apos;s Best Use of Nessie prize</a>.
          </p>
          <p className="meta">All people and money in the demo are fictional.</p>
        </div>
        <div className={`btn-row ${styles.visitorActions}`}>
          <Link href={TOUR_START} className="btn btn-primary">
            Take the 2-minute tour
          </Link>
          <Link href="/how-it-works" className="btn btn-secondary">
            How it works
          </Link>
        </div>
      </section>

      <section className={styles.intro}>
        <h1>Every state has money set aside to pay survivors back.</h1>
        <p className="lead">
          Crime victim compensation programs can pay for costs like medical bills, counseling, and lost pay after a
          sexual assault. Tend reads each state&apos;s law and keeps only the rules it can quote word for word from a
          saved copy of its source.
        </p>
        <StateFinder states={allStates()} />
        <p className={styles.count}>
          <strong>{corpus.rules.toLocaleString("en-US")}</strong> verified rules from{" "}
          <strong>{corpus.sources.toLocaleString("en-US")}</strong> saved sources,{" "}
          {all
            ? `for all ${corpus.programs} programs in the 50 states and DC.`
            : `for ${corpus.verified} of ${corpus.programs} programs so far.`}
        </p>
      </section>

      <LawGarden jurisdictions={corpus.jurisdictions} />

      <section className={styles.forYou} aria-labelledby="for-you">
        <h2 id="for-you">If you are here for yourself</h2>
        <div className={styles.forYouBody}>
          <p>
            Stay Jane Doe. Tend needs no account, and it never asks your name. Your state&apos;s page shows what its law
            covers and who to call, without asking you anything. It shows the filing deadline too, when Tend has
            verified one.
          </p>
          {/* Most states, not all: the engine holds an exam charge only where it applies a no-bill rule. */}
          <p>
            When you are ready, Tend can look through your bank records for costs your program covers and build a claim
            where every dollar points to the law. In most states it can also hold a forensic exam charge on a bill and
            show you the rule on exam bills, including when it applies. It never asks what happened.
          </p>
          <p>Tend files nothing: you send the claim to the program yourself. No money moves unless you say yes.</p>
          <p className={styles.prototype}>
            Tend is a prototype. Check what it tells you with your state&apos;s program before you rely on it. The
            program&apos;s phone number is on your state&apos;s page.
          </p>
          <div className="btn-row">
            <Link href="/start" className="btn btn-primary">
              Start a check
            </Link>
            <Link href="/start?demo=rowan" className={styles.demoLink}>
              Or try it with a fictional demo account
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

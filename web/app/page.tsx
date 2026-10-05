import Link from "next/link";
import { allStates, loadCorpus } from "@/components/public/data";
import LawGarden from "@/components/public/LawGarden";
import StateFinder from "@/components/public/StateFinder";
import { TOUR_START } from "@/components/tour/tour";
import styles from "./page.module.css";

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
            Tend helps sexual assault survivors claim the crime victim compensation their state already owes them,
            without giving up their name.
          </p>
          <p className={styles.visitorProof}>
            Built solo in 24 hours at MHacks 2026. 1st place, Capital One Best Use of Nessie.
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
          sexual assault. Tend reads each state&apos;s law and keeps only the rules it can quote word for word from an
          official source.
        </p>
        <StateFinder states={allStates()} />
        <p className={styles.count}>
          <strong>{corpus.rules.toLocaleString("en-US")}</strong> verified rules from{" "}
          <strong>{corpus.sources.toLocaleString("en-US")}</strong> official sources,{" "}
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
            Stay Jane Doe. Tend needs no account, no name, and no story. Your state&apos;s page shows what the law
            covers, the deadline, and who to call, without asking you anything.
          </p>
          <p>
            When you are ready, Tend can look through your bank records for costs your program covers, hold a bill you
            should never have been sent, and build a claim where every dollar points to the law. It never asks what
            happened. Nothing is filed and no money moves unless you say yes.
          </p>
          <div className="btn-row">
            <Link href="/start" className="btn btn-primary">
              Start a check
            </Link>
            <Link href="/start?demo=rowan">Or try it with a fictional demo account</Link>
          </div>
        </div>
      </section>
    </div>
  );
}

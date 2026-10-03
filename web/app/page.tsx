import Link from "next/link";
import NationalGarden from "@/components/NationalGarden";
import data from "@/public/data/jurisdictions.json";
import type { JurisdictionSummary } from "@/lib/types";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={`page ${styles.home}`}>
      <section className={styles.intro}>
        <h1>Every state has money set aside to pay survivors back.</h1>
        <p className="lead">
          Crime victim compensation programs cover costs like medical bills, counseling, and rides to care. Tend reads
          each state&apos;s law, keeps only the rules it can quote word for word from an official source, and checks
          costs against them.
        </p>
      </section>

      <NationalGarden initial={data as JurisdictionSummary[]} />

      <section className={styles.forYou} aria-labelledby="for-you">
        <h2 id="for-you">If you are here for yourself</h2>
        <div className={styles.forYouBody}>
          <p>
            Tend can look through a bank account for costs your program covers, hold a bill you should never have been
            sent, and put together a claim where every dollar points to the law. It never asks what happened. Nothing is
            filed and no money moves unless you say yes.
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

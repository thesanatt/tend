import type { Metadata } from "next";
import Link from "next/link";
import { LINKS } from "@/components/tour/links";
import { TOUR_START } from "@/components/tour/tour";
import styles from "./tour.module.css";

// Where the tour ends: a one-page recap with links. Static, no tracking.
export const metadata: Metadata = {
  title: "What you just saw",
  description: "A one-page recap of the Tend tour, with links to how it works, the code, and the sources.",
};

const SAW: { step: string; text: string }[] = [
  {
    step: "Check",
    text: "Four questions and no name. Michigan's law ran in your browser, and each answer cited its sentence.",
  },
  {
    step: "Gather",
    text: "A 190-transaction statement and an itemized bill, read on the device. Costs sorted, with guesses waiting for a yes.",
  },
  {
    step: "Bills",
    text: "The $325 exam line held under MCL 18.355a(2), with a letter for the billing office. The other $118 paid on purpose, with a typed code.",
  },
  {
    step: "Packet",
    text: "Michigan's real application with safe fields only, a cited summary, and letters, all built in the browser.",
  },
  {
    step: "Track",
    text: "One plant per cost, growing as the claim moves. The held line grows nothing.",
  },
];

export default function TourSummary() {
  return (
    <div className={`page ${styles.summary}`}>
      <h1>What you just saw</h1>
      <p className={styles.lead}>
        A survivor in Michigan claimed money the state already owes, without giving a name or saying what happened.
      </p>
      <ol className={styles.saw}>
        {SAW.map((s) => (
          <li key={s.step}>
            <strong>{s.step}.</strong> {s.text}
          </li>
        ))}
      </ol>
      <p className={styles.note}>
        Rowan, the hospital, and every dollar are fictional. The law is real, and every rule quotes it word for word.
        The bank is Capital One&apos;s Nessie mock bank.
      </p>
      <h2 className={styles.moreTitle}>Read more</h2>
      <ul className={styles.more}>
        <li>
          <Link href="/how-it-works">How it works</Link>: the engine, the numbers, and the privacy model
        </li>
        <li>
          <a href={LINKS.repo}>The code on GitHub</a>
        </li>
        <li>
          <a href={LINKS.devpost}>The Devpost write-up</a>
        </li>
        <li>
          <Link href="/sources">Sources</Link> for every number about the problem
        </li>
      </ul>
      <div className="btn-row">
        <Link href="/how-it-works" className="btn btn-primary">
          How it works
        </Link>
        <Link href={TOUR_START} className="btn btn-quiet">
          Take the tour again
        </Link>
      </div>
    </div>
  );
}

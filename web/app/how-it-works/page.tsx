import { statSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { loadCorpus } from "@/components/public/data";
import { TOUR_START } from "@/components/tour/tour";
import { LINKS } from "@/components/tour/links";
import styles from "./how.module.css";

// For technical visitors: the pipeline, the numbers, what is real, the privacy model, the stack.
// Static, no tracking. Corpus counts and the engine size are read when the site is built.
export const metadata: Metadata = {
  title: "How it works",
  description:
    "How Tend reads records on the device, runs each state's verified law in WebAssembly, and cites the exact sentence for every dollar.",
};

function engineKb(): number | null {
  try {
    return Math.floor(statSync(path.join(process.cwd(), "public/engine/tend.wasm")).size / 1000);
  } catch {
    return null;
  }
}

const n = (x: number) => x.toLocaleString("en-US");

export default function HowItWorks() {
  const corpus = loadCorpus();
  const kb = engineKb();

  const numbers: { figure: string; label: string; means: string }[] = [
    {
      figure: n(corpus.programs),
      label: "jurisdictions",
      means: "Every state and DC. Each runs its own crime victim compensation program with its own law.",
    },
    {
      figure: n(corpus.sources),
      label: "saved official sources",
      means: "Statutes, regulations, and program pages, each saved with a sha256 fingerprint.",
    },
    {
      figure: n(corpus.rules),
      label: "rules quoted word for word",
      means: "A rule exists only if its quote is found, exactly, in a saved source whose fingerprint still matches.",
    },
    {
      figure: "121,000",
      label: "test claims, 0 mismatches",
      means:
        "The C++ engine and an independent Python engine must give byte-identical results on random claims and random laws.",
    },
    ...(kb
      ? [
          {
            figure: `${kb} KB`,
            label: "engine",
            means: "The whole law engine, as WebAssembly. It downloads once and runs in the browser.",
          },
        ]
      : []),
  ];

  return (
    <div className={`page ${styles.how}`}>
      <header className={styles.head}>
        <h1>How Tend works</h1>
        <p className={styles.lead}>
          Tend helps sexual assault survivors claim the crime victim compensation their state already owes them, without
          giving up their name.
        </p>
        <p>
          Every state and DC has a program that can pay back costs like medical bills, counseling, and lost pay. In
          2022, 96 percent of violent crime victims got none of it (<Link href="/sources">sources</Link>). The forms are
          long and each state&apos;s rules are different. Tend reads a survivor&apos;s own records on their device,
          checks every cost against the state&apos;s law, and builds the claim, with the exact sentence of law behind
          each dollar.
        </p>
        <div className="btn-row">
          <Link href={TOUR_START} className="btn btn-primary">
            Take the 2-minute tour
          </Link>
          <a href={LINKS.repo} className="btn btn-secondary">
            Code on GitHub
          </a>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="pipeline">
        <h2 id="pipeline">The path of a claim</h2>
        <p className={styles.sectionLead}>All four steps run in the browser. Nothing in them needs a server.</p>
        <ol className={styles.flow}>
          <li className={styles.box}>
            <span className={styles.boxN} aria-hidden="true">
              1
            </span>
            <h3>Read on the device</h3>
            <p>
              A bank statement (CSV, OFX, or PDF) and an itemized bill, read by parsers in the browser. Nothing is
              uploaded.
            </p>
          </li>
          <li className={styles.box}>
            <span className={styles.boxN} aria-hidden="true">
              2
            </span>
            <h3>Law engine</h3>
            <p>
              C++ compiled to WebAssembly. It runs the state&apos;s law, compiled from {n(corpus.rules)} verified rules.
            </p>
          </li>
          <li className={styles.box}>
            <span className={styles.boxN} aria-hidden="true">
              3
            </span>
            <h3>Cited decisions</h3>
            <p>Each cost gets a status, an amount in integer cents, and the exact quote of the law behind it.</p>
          </li>
          <li className={styles.box}>
            <span className={styles.boxN} aria-hidden="true">
              4
            </span>
            <h3>Packet</h3>
            <p>The state&apos;s own form with safe fields only, a cited summary, and letters. The survivor sends it.</p>
          </li>
        </ol>
        <div className={styles.build}>
          <p className={styles.buildLabel}>Before any of this, when the law is built</p>
          <ol className={styles.buildSteps}>
            <li>Official source, saved with sha256</li>
            <li>Quote checked word for word</li>
            <li>Compiled by tendc (C++20) to bytecode</li>
            <li>Checked byte by byte before it runs</li>
          </ol>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="numbers">
        <h2 id="numbers">The numbers</h2>
        <dl className={styles.numbers}>
          {numbers.map((x) => (
            <div key={x.label} className={styles.number}>
              <dt>
                <span className={styles.figure}>{x.figure}</span> {x.label}
              </dt>
              <dd>{x.means}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.small}>
          Each number comes from a command you can rerun. The commands are in the README and{" "}
          <a href={LINKS.eval}>docs/EVAL.md</a>.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="real">
        <h2 id="real">Real and fictional</h2>
        <dl className={styles.facts}>
          <div>
            <dt>Real</dt>
            <dd>
              The law: 51 jurisdictions&apos; statutes, regulations, and program pages, with every quote verified.
              Michigan&apos;s real application form. The engine and its tests.
            </dd>
          </div>
          <div>
            <dt>Fictional</dt>
            <dd>
              Rowan Hale, Riverbend General Hospital, every merchant, and every dollar. All people and money in the demo
              are made up.
            </dd>
          </div>
          <div>
            <dt>Mock</dt>
            <dd>
              The bank. Nessie is Capital One&apos;s mock bank API. On this site a confirmed payment writes a real
              Nessie record, in mock money. No real money moves, and Tend files nothing.
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="privacy">
        <h2 id="privacy">Privacy</h2>
        <ul className={styles.bullets}>
          <li>The claim, the statement, the bills, and the answers stay on the device. There is no account.</li>
          <li>
            Data leaves only on a tap: a confirmed payment, an encrypted share link, or cloud AI after a yes on a
            consent screen.
          </li>
          <li>
            Saved progress and shared packets are encrypted in the browser (AES-256-GCM). A share link&apos;s key stays
            after the #, which browsers never send to a server.
          </li>
          <li>No field anywhere stores what happened, where, or who. There are no analytics.</li>
        </ul>
        <p className={styles.small}>
          The full contract and threat model: <a href={LINKS.privacy}>docs/PRIVACY.md</a>.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="stack">
        <h2 id="stack">The stack</h2>
        <dl className={styles.facts}>
          <div>
            <dt>Web</dt>
            <dd>Next.js, React, and TypeScript. pdf.js and pdf-lib read and fill PDFs in the browser.</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>A law compiler and bytecode VM in C++20, built to WebAssembly. A Python reference engine checks it.</dd>
          </div>
          <div>
            <dt>Server</dt>
            <dd>
              FastAPI on Vercel. Neon Postgres holds the public law, encrypted shares, and a hash-chained payment log.
            </dd>
          </div>
          <div>
            <dt>AI</dt>
            <dd>
              Gemini Nano on the device suggests labels for costs the rules miss. The engine decides. Cloud Gemini runs
              only after a yes.
            </dd>
          </div>
          <div>
            <dt>Sponsors</dt>
            <dd>
              Capital One Nessie (the bank), Fetch.ai (three agents on ASI:One), Neon, Google Gemini, Figma, and .tech.
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="limits">
        <h2 id="limits">Limits</h2>
        <ul className={styles.bullets}>
          <li>Tend is not legal advice. Every total says &quot;The program decides.&quot;</li>
          <li>Only Michigan&apos;s application is pre-filled. Other states get the program&apos;s blank form.</li>
          <li>
            The engines were written from one spec by one author, so a shared misreading would not show up as a
            mismatch.
          </li>
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="links">
        <h2 id="links">Links</h2>
        <ul className={styles.links}>
          <li>
            <a href={LINKS.repo}>Code on GitHub</a>
          </li>
          <li>
            <a href={LINKS.devpost}>Devpost write-up</a>
          </li>
          <li>
            <a href={LINKS.judges}>Guide for judges</a>, with each claim, its test, and the command to run it
          </li>
          <li>
            <Link href="/sources">Sources</Link> for every number about the problem
          </li>
          <li>
            <a href={LINKS.figma}>Figma design system</a>
          </li>
          <li>
            <a href={LINKS.agent}>The ASI:One agent chat</a>, the same claim through three Fetch.ai agents
          </li>
        </ul>
        <p className={styles.small}>
          Built solo in 24 hours at MHacks 2026. 1st place, Capital One Best Use of Nessie.
        </p>
      </section>
    </div>
  );
}

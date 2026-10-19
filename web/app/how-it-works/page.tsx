import { statSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { loadCorpus } from "@/components/public/data";
import { sitePreview } from "@/components/public/og/siteCard";
import { TOUR_START } from "@/components/tour/tour";
import { LINKS } from "@/components/tour/links";
import styles from "./how.module.css";

// For visitors checking the work: how Tend keeps a survivor safe, the pipeline, the numbers, what is real,
// the stack. Static, no tracking. Corpus counts and the engine size are read when the site is built.
export const metadata: Metadata = {
  title: "How it works",
  description:
    "How Tend reads records on the device, runs each state's verified law in WebAssembly, and cites the exact sentence for every dollar.",
  ...sitePreview("how"),
};

function engineKb(): number | null {
  try {
    return Math.floor(statSync(path.join(process.cwd(), "public/engine/tend.wasm")).size / 1000);
  } catch {
    return null;
  }
}

const n = (x: number) => x.toLocaleString("en-US");

// Each safety claim names the files that make it true, so a reader can check it on GitHub.
// tests/how-it-works.test.tsx keeps the numbers in this copy matched to the code. A path can break
// after any slash, so a phone wraps it between folders instead of inside a file name.
function See({ files }: { files: string[] }) {
  const last = files.length - 1;
  return (
    <p className={styles.see}>
      See{" "}
      {files.map((file, i) => (
        <Fragment key={file}>
          {i === 0 ? "" : i < last ? ", " : last > 1 ? ", and " : " and "}
          <a href={`${LINKS.repo}/blob/main/${file}`}>
            <code>{file.split("/").flatMap((part, j) => (j ? ["/", <wbr key={j} />, part] : [part]))}</code>
          </a>
        </Fragment>
      ))}
      .
    </p>
  );
}

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

      <section className={styles.section} aria-labelledby="safety">
        <h2 id="safety">Design for safety</h2>
        <p className={styles.sectionLead}>
          A survivor may open Tend on a phone or laptop that someone else can pick up. Each protection below links to
          the files behind it, so you can check.
        </p>
        <ul className={styles.guards}>
          <li className={styles.guard}>
            <h3>Exit this page</h3>
            <div className={styles.guardBody}>
              <p>
                The button sits in the top right corner of every page, with a copy inside every panel that opens.
                Pressing <kbd>Esc</kbd> twice within a second does the same. Tend blanks the screen and locks any saved
                progress. It clears the tab&apos;s storage, keeping only a flag that marks the exit, and swaps the page
                for a Google search for the weather.
              </p>
              <p>
                Exit replaces only the page that was open. Back can still reach an earlier Tend page in the same tab.
                That page opens without the person&apos;s answers, and if the browser kept a copy in memory, the flag
                hides that copy and reloads the page. Even so, the page shows Tend was in use, and the browser&apos;s
                history lists the visit. Other tabs stay open too, such as a bill opened in its own tab.
              </p>
              <See files={["web/components/QuickExit.tsx", "web/components/flow/ExitControl.tsx", "docs/UX.md"]} />
            </div>
          </li>
          <li className={styles.guard}>
            <h3>No name, no story</h3>
            <div className={styles.guardBody}>
              <p>
                Check asks four things: the state, the date, whether there was a medical forensic exam, and whether it
                has been reported to police. Beyond the state, no field anywhere asks where it happened, and none asks
                what happened or who did it.
              </p>
              <p>
                Michigan&apos;s application is the only state form Tend fills so far. It checks only the boxes for kinds
                of cost, plus one line noting the attached itemized list and its total. Name, signature, Social Security
                number, and every question about the crime stay blank. Then Tend reads the saved file back and refuses
                it if any other field holds a value.
              </p>
              <See
                files={[
                  "web/components/flow/check/CheckScreen.tsx",
                  "web/lib/packet/specs.ts",
                  "web/lib/packet/forms.ts",
                ]}
              />
            </div>
          </li>
          <li className={styles.guard}>
            <h3>On this device</h3>
            <div className={styles.guardBody}>
              <p>
                The law runs in the browser as WebAssembly, and bank statements and bills are read there too. There is
                no account and no analytics. The site&apos;s security policy blocks scripts from other sites and stops
                the page from sending requests to them in the background.
              </p>
              <p>
                Costs, files, and every answer except the state stay on the device until the person taps to send
                something. Cloud AI runs only after a yes on a screen that names what would be sent.
              </p>
              <p>
                Checking the law on Tend&apos;s server also waits for a yes, and is offered only when the law engine
                cannot run in the browser. It sends the state, the date, the answers, and every cost the person has not
                left out. That includes bank rows Tend could not sort, which can be ordinary spending. Each goes with
                its amount, its date, and the bank&apos;s or bill&apos;s description, which can include a person&apos;s
                name. Tend asks once, and that yes covers later checks.
              </p>
              <p>
                A line at the top of every page starts as &quot;On this device. Nothing has left it since this page
                opened.&quot; The page builds that line from the requests it actually makes. It changes when any of the
                person&apos;s data is sent. Loading pages and public law files does not change it. Those requests still
                reach Tend&apos;s web host, and the law file a browser asks for can show which state was picked.
              </p>
              <See
                files={[
                  "web/lib/engine/index.ts",
                  "web/components/flow/claim.ts",
                  "web/lib/local/index.ts",
                  "web/lib/api.ts",
                  "web/lib/netlog.ts",
                  "web/next.config.ts",
                ]}
              />
            </div>
          </li>
          <li className={styles.guard}>
            <h3>Saved progress</h3>
            <div className={styles.guardBody}>
              <p>
                Saving is optional. Until then, progress is held only in the page&apos;s memory and is gone when the tab
                closes or reloads. Saved progress is encrypted with <span className={styles.term}>AES-256-GCM</span> in
                the browser&apos;s own storage. It opens with a passkey, such as Touch ID or the phone&apos;s screen
                lock, or with a passcode. A passcode is turned into a key by{" "}
                <span className={styles.term}>PBKDF2-SHA-256</span> with 600,000 iterations.
              </p>
              <p>
                The unlocked key is held only in memory. The vault locks after five minutes without a tap, key press, or
                scroll. Closing or reloading the tab locks it too, as does going to another site. Switching to another
                app or tab does not lock it, though the five-minute clock keeps running.
              </p>
              <p>
                A passcode can be as short as six characters, and Tend cannot reset a forgotten one. Anyone who opens
                Check or another step in that browser later can see that saved progress exists, though not what it
                holds.
              </p>
              <See
                files={[
                  "web/lib/vault/crypto.ts",
                  "web/lib/vault/index.ts",
                  "web/lib/vault/idle.ts",
                  "web/components/flow/FlowProvider.tsx",
                  "web/components/flow/FlowFrame.tsx",
                ]}
              />
            </div>
          </li>
          <li className={styles.guard}>
            <h3>Sharing with an advocate</h3>
            <div className={styles.guardBody}>
              <p>
                The browser locks the packet with a new <span className={styles.term}>AES-256-GCM</span> key before
                anything is sent. Tend&apos;s server gets the locked packet, its expiry, and whether it opens once, but
                never the key. The key sits after the # in the link, and browsers never send that part of an address to
                a server.
              </p>
              <p>
                A link expires after one, three, or seven days. Until then, anyone holding the whole link can open it,
                unless it was set to open once and has already been opened. The survivor can stop it sooner on the
                Packet step, during the same visit or after opening saved progress. Tend shows no stop button for a link
                from a visit that was never saved.
              </p>
              <See
                files={["web/lib/share/index.ts", "web/components/flow/packet/ShareBox.tsx", "api/tend_api/share.py"]}
              />
            </div>
          </li>
          <li className={styles.guard}>
            <h3>Payments</h3>
            <div className={styles.guardBody}>
              <p>
                In the demo, Tend can pay what is left on a bill from Capital One&apos;s Nessie mock bank, in mock
                money. Tend shows a 6-digit code, and nothing moves until it is typed back. The code works once, for ten
                minutes, and five wrong tries lock the payment.
              </p>
              <p>
                The server will not pay a held exam line, alone or together with other lines of the same bill. The code
                makes paying deliberate. It does not stop someone who is holding the phone.
              </p>
              <See files={["api/tend_api/actions.py"]} />
            </div>
          </li>
        </ul>
        <div className={styles.cannot}>
          <h3>What Tend cannot stop</h3>
          <p>Malware on the device, or someone watching the screen.</p>
          <p>
            Someone watching the network, such as whoever runs the home Wi-Fi, can still see that Tend&apos;s site was
            visited, though not what was sent.
          </p>
          <p>
            Anything downloaded from the packet, such as the filled form, is an ordinary file on the device, outside
            Tend&apos;s lock.
          </p>
          <p>
            The protections above are aimed at someone using the same browser later, a curious server operator, a breach
            of Tend&apos;s database, and anyone watching the network. The full contract is in{" "}
            <a href={LINKS.privacy}>docs/PRIVACY.md</a>.
          </p>
        </div>
      </section>

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
          Built by Sanat Gupta in 24 hours at MHacks 2026. 1st place, Capital One Best Use of Nessie.
        </p>
      </section>
    </div>
  );
}

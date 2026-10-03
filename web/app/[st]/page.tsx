import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Plant from "@/components/Plant";
import { loadIr, loadLaw, siteUrl, stateFromParam } from "@/components/public/data";
import LawRefs from "@/components/public/LawRefs";
import Linkified from "@/components/public/Linkified";
import ShareButtons from "@/components/public/ShareButtons";
import styles from "@/components/public/public.module.css";
import { buildStateSummary, type Fact, type KeyFact } from "@/components/public/summary";
import { lawGrowth, lawStage } from "@/lib/garden";
import type { Rule, Source } from "@/lib/types";

// One static page per jurisdiction at /mi, /ny, ... (params come from layout.tsx). Built from
// public/data; no request-time work.
function load(param: string) {
  const ref = stateFromParam(param);
  if (!ref || param !== ref.st.toLowerCase()) return null;
  const loaded = loadLaw(ref.st);
  if (!loaded) return null;
  return { ref, law: loaded.law, summary: buildStateSummary(loaded.law, loadIr(ref.st)) };
}

export async function generateMetadata({ params }: { params: Promise<{ st: string }> }): Promise<Metadata> {
  const { st } = await params;
  const found = load(st);
  if (!found) return {};
  const { ref, summary } = found;
  const title = `If you're Jane Doe in ${summary.place}`;
  // The card (card.png/route.tsx) is a static PNG made at build time; its alt text is its sentence.
  const image = { url: `/${st}/card.png`, width: 1200, height: 630, type: "image/png", alt: summary.share.text };
  return {
    metadataBase: siteUrl(),
    // The tab says only the state, so a shared screen shows little.
    title: ref.name,
    description: summary.share.text,
    alternates: { canonical: `/${st}` },
    openGraph: {
      type: "website",
      siteName: "Tend",
      title,
      description: summary.share.text,
      url: `/${st}`,
      images: [image],
    },
    twitter: { card: "summary_large_image", title, description: summary.share.text, images: [image] },
  };
}

const KEY_TARGET: Record<KeyFact["id"], string> = {
  total: "costs",
  deadline: "deadline",
  report: "police",
  exam: "exam",
};

export default async function StatePage({ params }: { params: Promise<{ st: string }> }) {
  const { st } = await params;
  const found = load(st);
  if (!found) notFound();
  const { ref, law, summary } = found;
  const rules = new Map<string, Rule>(law.rules.map((r) => [r.id, r]));
  const sources = new Map<string, Source>(law.sources.map((s) => [s.id, s]));
  const ids = new Set([...rules.keys(), ...sources.keys()]);
  const pinpoint = (id: string) => rules.get(id)?.pinpoint ?? sources.get(id)?.title ?? id;
  const path = `/${st}`;
  const cardPath = `${path}/card.png`;

  const renderFact = (f: Fact) => (
    <li key={f.key} className={styles.fact}>
      <p className={`${styles.factText} ${f.kind === "note" ? styles.note : ""}`}>
        {f.label ? <span className={styles.factLabel}>{f.label}</span> : null}
        {f.label && (f.text || f.href) ? " " : null}
        {f.href ? <a href={f.href}>{f.text}</a> : <Linkified text={f.text} st={ref.st} ids={ids} />}
      </p>
      {f.details ? (
        <ul className={styles.details}>
          {f.details.map((d) => (
            <li key={d.cite}>
              <Linkified text={d.text} st={ref.st} ids={ids} />
            </li>
          ))}
        </ul>
      ) : null}
      {f.cites.length ? (
        <LawRefs
          st={ref.st}
          ids={f.cites}
          rules={rules}
          sources={sources}
          shown={f.verbatimSummary ? f.cites : (f.details ?? []).map((d) => d.cite)}
        />
      ) : null}
    </li>
  );

  return (
    <div className={`page ${styles.state}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.crumb}>
            <Link href="/">Law garden</Link> / {ref.name}
          </p>
          <h1>If you&apos;re Jane Doe in {summary.place}</h1>
          <p className="lead">
            What {ref.name}&apos;s crime victim compensation law says, in plain words. Each line links to the exact
            sentence it comes from.
          </p>
          <p className={styles.program}>
            {summary.programName}, run by {summary.agency}.
          </p>
        </div>
        {summary.phone ? (
          <div className={styles.contact}>
            <span>Program phone</span>
            <a href={summary.phone.href}>{summary.phone.text}</a>
            <LawRefs st={ref.st} ids={summary.phone.cites} rules={rules} sources={sources} />
          </div>
        ) : null}
        <div className={styles.plant} aria-hidden="true">
          <Plant
            stage={lawStage(law.rules.length)}
            growth={lawGrowth(law.rules.length)}
            seedKey={ref.st}
            ground={false}
          />
        </div>
      </header>

      {summary.keyFacts.length ? (
        <ul className={styles.keyFacts} aria-label="At a glance">
          {summary.keyFacts.map((k) => (
            <li key={k.id}>
              <a className={styles.keyFact} href={`#${KEY_TARGET[k.id]}`}>
                <span className={styles.keyBig}>{k.big}</span>
                <span className={styles.keySmall}>{k.small}</span>
                <span className={styles.keyCite}>{pinpoint(k.cites[0])}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <nav aria-label="On this page" className={styles.toc}>
        <ul>
          {summary.sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.nav}</a>
            </li>
          ))}
          <li>
            <a href="#share">Share</a>
          </li>
        </ul>
      </nav>

      <div className={styles.sections}>
        {summary.sections.map((s) => (
          <section key={s.id} id={s.id} className={styles.section} aria-labelledby={`h-${s.id}`}>
            <h2 id={`h-${s.id}`}>{s.title}</h2>
            <ul className={styles.facts}>{s.facts.map(renderFact)}</ul>
          </section>
        ))}
      </div>

      <section id="share" className={styles.share} aria-labelledby="h-share">
        <div className={styles.shareText}>
          <h2 id="h-share">Share this page</h2>
          <p className={styles.shareLine}>{summary.share.text}</p>
          <p>
            Anyone can post this card. It says nothing about the person who shares it, and this page keeps no record of
            who opens it.
          </p>
          <ShareButtons
            path={path}
            title={`If you're Jane Doe in ${summary.place}`}
            text={summary.share.text}
            imageHref={cardPath}
            imageName={`tend-${st}.png`}
          />
        </div>
        <figure className={styles.card}>
          {/* The card is the same static image people see when the link is posted. Its sentence is
              already on the page beside it, so the alt text says what the image is instead. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cardPath}
            width={1200}
            height={630}
            alt={`The share card for ${summary.place}, as it looks when the link is posted`}
            loading="lazy"
            decoding="async"
          />
          <figcaption className={styles.cardCites}>
            From{" "}
            {[...new Set(summary.share.clauses.flatMap((c) => c.cites))].map((id, i, all) => (
              <span key={id}>
                <a href={`/law/${ref.st}#${id}`}>{pinpoint(id)}</a>
                {i < all.length - 1 ? "; " : ""}
              </span>
            ))}
            . The program decides every claim.
          </figcaption>
        </figure>
      </section>

      <section className={styles.next} aria-labelledby="h-next">
        <h2 id="h-next">When you are ready</h2>
        <p>
          Tend can check your own costs against this law on your device. It never asks what happened, and nothing leaves
          your device unless you send it.
        </p>
        <div className="btn-row">
          <Link href={`/start?st=${ref.st}`} className="btn btn-primary">
            Start a check
          </Link>
          <Link href={`/law/${ref.st}`} className="btn btn-secondary">
            How Tend decides in {summary.place}
          </Link>
        </div>
      </section>
    </div>
  );
}

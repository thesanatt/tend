import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { longDate } from "@/components/public/format";
import { CARD_SIZE } from "@/components/public/og/card";
import { siteCardAlt, siteCardPath } from "@/components/public/og/siteCard";
import { LINKS } from "@/components/tour/links";
import { DEMO, pressFacts, type PressSource } from "./facts";
import { bytesOf, FACT_SHEET, LINK_CARD, LOGOS, pngSize, SHOT_DIR, SHOTS, sizeText, type Shot } from "./files";
import styles from "./press.module.css";

// For reporters: what Tend is, each fact with its source, what is real and what is demo, and the files to
// download. The facts live in facts.ts, which the fact sheet PDF is printed from too
// (scripts/press-factsheet.ts); the screenshots come from scripts/press-screenshots.py. Static, no tracking.
const TITLE = "Tend press kit";
const DESCRIPTION =
  "Facts about Tend with their sources, what is real and what is demo, logos, screenshots, and a one-page fact sheet.";
// A posted link shows the home page's card; this page has no card of its own.
const CARD = { url: siteCardPath("home"), ...CARD_SIZE, type: "image/png", alt: siteCardAlt("home") };

export const metadata: Metadata = {
  title: "Press kit",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Tend",
    title: TITLE,
    description: DESCRIPTION,
    url: "/press",
    images: [CARD],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [CARD] },
};

const file = (name: string) => `/press/${name}`;

// Pages on this site go through Link; files and other sites are plain links.
function To({ href, children }: { href: string; children: ReactNode }) {
  const page = href.startsWith("/") && !/\.\w+$/.test(href.split(/[?#]/)[0]);
  return page ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>;
}

function Sources({ sources }: { sources: PressSource[] }) {
  return (
    <p className={styles.source}>
      {sources.length > 1 ? "Sources: " : "Source: "}
      {sources.map((s, i) => (
        <Fragment key={s.href}>
          {i ? "; " : null}
          <To href={s.href}>{s.label}</To>
        </Fragment>
      ))}
    </p>
  );
}

// A dashed box for what Sanat has yet to write or choose.
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className={styles.placeholder}>
      <p className={styles.placeholderLabel}>Placeholder</p>
      {children}
    </div>
  );
}

// A script's path, linked to the file on GitHub. A phone breaks it only after a slash, never at the hyphen
// inside a name.
function Script({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <a href={`${LINKS.repo}/blob/main/${path}`}>
      <code>
        {parts.map((part, i) => (
          <Fragment key={i}>
            <span className={styles.nowrap}>{i < parts.length - 1 ? `${part}/` : part}</span>
            {i < parts.length - 1 ? <wbr /> : null}
          </Fragment>
        ))}
      </code>
    </a>
  );
}

function ShotItem({ shot }: { shot: Shot }) {
  const name = `${SHOT_DIR}/${shot.file}`;
  const { width, height } = pngSize(name);
  return (
    <li>
      <figure className={styles.shot}>
        <a href={file(name)} download className={styles.shotLink}>
          {/* The file itself, shown smaller; it is the full-size download too. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={file(name)} width={width} height={height} alt={shot.alt} loading="lazy" decoding="async" />
        </a>
        <figcaption>
          {shot.caption}{" "}
          <span className={styles.fileMeta}>
            PNG, {width} x {height}, {sizeText(bytesOf(name))}
          </span>
        </figcaption>
      </figure>
    </li>
  );
}

export default function PressPage() {
  const kit = pressFacts();
  const sheetSize = sizeText(bytesOf(FACT_SHEET));
  const card = pngSize(LINK_CARD.file);
  const desktop = SHOTS.filter((s) => s.device === "desktop");
  const phone = SHOTS.filter((s) => s.device === "phone");

  return (
    <div className={`page ${styles.press}`}>
      <header className={styles.head}>
        <h1>Press kit</h1>
        <p className={styles.about}>{kit.about}</p>
        <p className={styles.builder}>
          {kit.builder}{" "}
          <span className={styles.source}>
            Source: <a href={kit.builderSource.href}>{kit.builderSource.label}</a>
          </span>
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href={file(FACT_SHEET)} download>
            Download the fact sheet (PDF)
          </a>
          <Link className="btn btn-secondary" href={DEMO}>
            Try the fictional demo
          </Link>
        </div>
        <p className="meta">Facts checked {longDate(kit.checked)}.</p>
      </header>

      <section className={styles.section} aria-labelledby="words">
        <h2 id="words">In Sanat&apos;s words</h2>
        {kit.why ? (
          <blockquote className={styles.why}>
            <p>{kit.why}</p>
          </blockquote>
        ) : (
          <Placeholder>
            <p>Two or three sentences from Sanat Gupta on why he built Tend go here. He has not written them yet.</p>
          </Placeholder>
        )}
      </section>

      <section className={styles.section} aria-labelledby="facts">
        <h2 id="facts">Key facts</h2>
        <ul className={styles.facts}>
          {kit.facts.map((fact) => (
            <li key={fact.id} id={`fact-${fact.id}`}>
              <p>{fact.text}</p>
              <Sources sources={fact.sources} />
            </li>
          ))}
        </ul>
      </section>

      <section className={`${styles.section} ${styles.real}`} aria-labelledby="real">
        <h2 id="real">What&apos;s real and what&apos;s demo</h2>
        <dl>
          {kit.real.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={`${styles.section} ${styles.files}`} aria-labelledby="files">
        <h2 id="files">Files</h2>

        <div className={styles.sheet}>
          <a className={styles.fileName} href={file(FACT_SHEET)} download>
            {FACT_SHEET}
          </a>
          <span className={styles.fileMeta}>PDF, 1 page, {sheetSize}</span>
          <p>The key facts and the real and demo box on one printable page, with every source linked.</p>
        </div>

        <h3>Logos</h3>
        <ul className={styles.logos}>
          {LOGOS.map((logo) => {
            const png = pngSize(logo.png);
            return (
              <li key={logo.svg}>
                <figure>
                  <div className={styles.swatch}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file(logo.svg)} alt={logo.alt} />
                  </div>
                  <figcaption>
                    <strong>{logo.name}.</strong> {logo.note}
                    <span className={styles.downloads}>
                      <a href={file(logo.svg)} download>
                        SVG<span className="visually-hidden">, {logo.name}</span>
                      </a>
                      <a href={file(logo.png)} download>
                        PNG, {png.width} x {png.height}
                        <span className="visually-hidden">, {logo.name}</span>
                      </a>
                    </span>
                  </figcaption>
                </figure>
              </li>
            );
          })}
          <li>
            <figure>
              <div className={styles.swatch}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={file(LINK_CARD.file)} alt={LINK_CARD.alt} loading="lazy" decoding="async" />
              </div>
              <figcaption>
                <strong>Link card.</strong> The picture a posted link to youreowed.tech shows.
                <span className={styles.downloads}>
                  <a href={file(LINK_CARD.file)} download>
                    PNG, {card.width} x {card.height}
                    <span className="visually-hidden">, link card</span>
                  </a>
                </span>
              </figcaption>
            </figure>
          </li>
        </ul>

        <h3>Screenshots</h3>
        <p className={styles.small}>
          Taken in Chromium from the site as built, at twice the window&apos;s pixels so they stay sharp in print. The
          bill and the packet are Rowan Hale&apos;s fictional demo claim, and nothing in any of them was typed by a
          person. Select one to download it at full size.
        </p>
        <h4 className={styles.shotsTitle}>Desktop, a window 1280 pixels wide</h4>
        <ul className={`${styles.shots} ${styles.shotsDesktop}`}>
          {desktop.map((shot) => (
            <ShotItem key={shot.file} shot={shot} />
          ))}
        </ul>
        <h4 className={styles.shotsTitle}>Phone, a screen 390 pixels wide</h4>
        <ul className={`${styles.shots} ${styles.shotsPhone}`}>
          {phone.map((shot) => (
            <ShotItem key={shot.file} shot={shot} />
          ))}
        </ul>

        <h3>Video</h3>
        {kit.video ? (
          <p>
            <a href={kit.video}>The demo video</a>
          </p>
        ) : (
          <Placeholder>
            <p>A video of the fictional demo is not published yet.</p>
          </Placeholder>
        )}

        <p className={styles.small}>
          How these are made: <Script path="web/scripts/press-factsheet.ts" /> prints the fact sheet from the same facts
          as this page. <Script path="web/scripts/press-screenshots.py" /> clicks through the site in Chromium for the
          screenshots. <Script path="web/scripts/press-logos.py" /> draws the logos and{" "}
          <Script path="web/scripts/press-social.tsx" /> the link card. Each script says how to run it in its first
          lines.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        {kit.contact ? (
          <p>
            <a href={`mailto:${kit.contact}`}>{kit.contact}</a>
          </p>
        ) : (
          <Placeholder>
            <p>The address for reporters is not chosen yet.</p>
          </Placeholder>
        )}
      </section>

      <section className={styles.section} aria-labelledby="links">
        <h2 id="links">Links</h2>
        <ul className={styles.links}>
          {kit.links.map((l) => (
            <li key={l.href}>
              <To href={l.href}>{l.label}</To>
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.note}>{kit.notAdvice}</p>
    </div>
  );
}

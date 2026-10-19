import type { Source } from "@/lib/types";
import { CORRECTIONS_EMAIL, reportErrorUrl, savedDays } from "./corrections";
import { siteUrl } from "./data";
import { longDate } from "./format";
import styles from "./SourceNote.module.css";

// When Tend saved a jurisdiction's sources, and the public way to report an error, on /mi and /law/MI.
// The date is the save, not a later look at the live law, so the note says to ask the program.
// It does not call the sources official: some saved copies are Justia or Cornell LII reproductions.
// GitHub shows the poster's username on every issue, so the report link says so.
export default function SourceNote({
  st,
  sources,
  path,
  email = CORRECTIONS_EMAIL,
}: {
  st: string;
  sources: Source[];
  path: string;
  email?: string;
}) {
  const days = savedDays(sources);
  return (
    <div className={styles.note}>
      {days ? (
        <p>
          Tend saved copies of this page&apos;s sources <Saved {...days} /> and checked every quote against those
          copies word for word. Laws change, so ask the program before you rely on a date or amount.
        </p>
      ) : null}
      <p>
        <a href={reportErrorUrl(st, new URL(path, siteUrl()).href)} className={styles.report}>
          <span className={styles.reportLabel}>Report an error on this page</span>{" "}
          <span className={styles.reportNote}>
            Opens a public page on GitHub, where you need an account and your username shows on what you post.
            Don&apos;t share anything about yourself or anyone&apos;s case there.
          </span>
        </a>
      </p>
      {email ? (
        <p>
          No GitHub account? Email the error to <a href={`mailto:${email}`}>{email}</a>. Leave out anything about
          yourself or anyone&apos;s case.
        </p>
      ) : null}
    </div>
  );
}

function Saved({ first, last }: { first: string; last: string }) {
  if (first === last) {
    return (
      <>
        on <time dateTime={first}>{longDate(first)}</time>
      </>
    );
  }
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return (
    <>
      between <time dateTime={first}>{longDate(first, !sameYear)}</time> and{" "}
      <time dateTime={last}>{longDate(last)}</time>
    </>
  );
}

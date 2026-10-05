"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { boldParts, exitTour, startTourFromUrl, TOUR_NOTES, TOUR_STEPS, tourStep, useTourMode } from "./tour";
import styles from "./tour.module.css";

function Text({ text }: { text: string }) {
  return (
    <>{boldParts(text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}</>
  );
}

// One small note at the top of each step, shown only in tour mode and only in English.
export default function TourNote() {
  const { lang } = useI18n();
  const path = usePathname() ?? "";
  const on = useTourMode();
  useEffect(() => {
    startTourFromUrl();
  }, []);

  const step = tourStep(path);
  if (!on || !step || lang !== "en") return null;
  const note = TOUR_NOTES[step];
  const n = TOUR_STEPS.indexOf(step) + 1;

  function exit() {
    exitTour();
    // The note is gone, so focus goes to the page's own heading instead of the top of the page.
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }

  return (
    <aside className={`${styles.note} no-print`} aria-labelledby="tour-note-title" data-tour-step={step}>
      <div className={styles.head}>
        <p id="tour-note-title" className={styles.title}>
          Tour, step {n} of {TOUR_STEPS.length}: {note.title}
        </p>
        <button type="button" className={`btn btn-quiet ${styles.exit}`} onClick={exit}>
          Exit tour
        </button>
      </div>
      <p>
        <Text text={note.what} />
      </p>
      <p className={styles.why}>
        <Text text={note.why} />
      </p>
      <p className={styles.next}>
        <span className={styles.nextLabel}>Next: </span>
        <Text text={note.next} />
        {note.link ? (
          <>
            {" "}
            <Link href={note.link.href}>{note.link.label}</Link>
          </>
        ) : null}
      </p>
    </aside>
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import styles from "./ContentNote.module.css";

interface ContentNoteProps {
  id: string;
  title?: string;
  note: ReactNode;
  action?: string;
  children: ReactNode;
}

const key = (id: string) => `tend.note.${id}`;

// Holds sensitive content behind a plain note until the person chooses to see it (once per tab).
export default function ContentNote({
  id,
  title = "Before you look",
  note,
  action = "Show it",
  children,
}: ContentNoteProps) {
  const [shown, setShown] = useState<boolean | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(key(id)) === "1";
    } catch {
      seen = false;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(seen);
  }, [id]);

  if (shown === null) return null;
  if (shown) return <>{children}</>;

  return (
    <section className={styles.note} aria-labelledby={`note-${id}`}>
      <h2 id={`note-${id}`} className={styles.title}>
        {title}
      </h2>
      <div className={styles.body}>{note}</div>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            try {
              sessionStorage.setItem(key(id), "1");
            } catch {
              // fine: the note shows again next time
            }
            setShown(true);
          }}
        >
          {action}
        </button>
      </div>
    </section>
  );
}

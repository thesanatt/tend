"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { DEMO, useSession, type Session } from "@/lib/session";
import styles from "./FlowGate.module.css";

// Flow pages need a scan. Before storage loads, show nothing; with no scan, offer a way in.
export default function FlowGate({ children }: { children: (session: Session) => ReactNode }) {
  const { ready, session, begin } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return <p className={`meta ${styles.loading}`}>Loading</p>;
  if (session) return <>{children(session)}</>;

  return (
    <section className={styles.empty}>
      <h1>Nothing to show yet</h1>
      <p className="lead">
        Start a check to see the costs Tend finds, or open the demo. It uses Rowan, a fictional person with a fictional
        bank history in Michigan.
      </p>
      <div className="btn-row">
        <Link replace href="/start" className="btn btn-primary">
          Start a check
        </Link>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await begin(DEMO);
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Opening the demo" : "Open the demo"}
        </button>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          The demo did not load: {error}
        </p>
      ) : null}
    </section>
  );
}

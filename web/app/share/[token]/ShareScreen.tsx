"use client";

// /share/<token>: links the server can read (made before end-to-end sharing) and /share/demo.
// End-to-end links live at /share#<id>.<key> (../OpenShare.tsx).
import { useEffect, useState } from "react";
import { fetchShare } from "@/lib/api";
import type { ShareView } from "@/lib/types";
import SharedClaim from "../SharedClaim";
import styles from "../share.module.css";

type State = { view: ShareView; expired: boolean } | null | "loading" | "sealed" | { error: string };

export default function ShareScreen({ token }: { token: string }) {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let live = true;
    fetchShare(token)
      .then((v) => {
        if (!live) return;
        // An encrypted share fetched without its key: nothing here can read it.
        if (v && ((v as unknown as { sealed?: boolean }).sealed === true || !v.input)) return setState("sealed");
        // The demo fixture has fixed dates, so it never shows as expired.
        setState(v ? { view: v, expired: v.token !== "demo" && Date.parse(v.expires_at) < Date.now() } : null);
      })
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
    };
  }, [token]);

  if (state === "loading") return <p className="meta">Loading the shared claim</p>;
  if (state === "sealed") {
    return (
      <div className={styles.state}>
        <h1>This link is missing its key</h1>
        <p className="lead">
          The claim is locked, and the key travels only in the full link, after the # sign. Ask the person who shared it
          to send the whole link again.
        </p>
      </div>
    );
  }
  if (state && typeof state === "object" && "error" in state)
    return <p className={styles.expired}>This shared claim could not load: {state.error}</p>;
  if (!state) {
    return (
      <div className={styles.state}>
        <h1>This link does not work</h1>
        <p className="lead">It may have expired. Ask the person who shared it for a new one.</p>
      </div>
    );
  }
  const { view, expired } = state;
  return (
    <SharedClaim
      input={view.input}
      output={view.output}
      createdAt={view.created_at}
      expiresAt={view.expires_at}
      sealed={false}
      expired={expired}
      engine={view.engine ?? null}
      demo={view.token === "demo"}
    />
  );
}

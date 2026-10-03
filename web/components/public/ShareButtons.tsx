"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import styles from "./public.module.css";

interface ShareButtonsProps {
  path: string;
  title: string;
  text: string;
  imageHref: string;
  imageName: string;
}

const noSubscribe = () => () => {};

// Copy and the phone's own share sheet. Nothing here calls a third party or records a share.
export default function ShareButtons({ path, title, text, imageHref, imageName }: ShareButtonsProps) {
  // Read on the client only, so the server render and the first client render agree.
  const canShare = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false,
  );
  const [status, setStatus] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const url = () => new URL(path, window.location.origin).toString();

  async function copy() {
    const link = url();
    try {
      await navigator.clipboard.writeText(link);
      setFallback(null);
      setStatus("Link copied.");
    } catch {
      setFallback(link);
      setStatus("Your browser did not allow copying. The link is in the box below.");
      requestAnimationFrame(() => field.current?.select());
    }
  }

  async function share() {
    try {
      await navigator.share({ title, text, url: url() });
      setStatus("");
    } catch (err) {
      // Closing the share sheet is not an error.
      if ((err as Error)?.name !== "AbortError") setStatus("The share sheet did not open. Copy the link instead.");
    }
  }

  return (
    <div className={styles.shareButtons}>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={copy}>
          Copy link
        </button>
        {canShare ? (
          <button type="button" className="btn btn-secondary" onClick={share}>
            Share
          </button>
        ) : null}
        <a className="btn btn-quiet" href={imageHref} download={imageName}>
          Save the card
        </a>
      </div>
      {fallback ? (
        <label className={styles.fallback}>
          <span>Link to this page</span>
          <input ref={field} type="text" readOnly value={fallback} onFocus={(e) => e.currentTarget.select()} />
        </label>
      ) : null}
      <p className={styles.shareStatus} role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

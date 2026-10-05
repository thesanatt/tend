"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { hold } from "./release";
import styles from "./preview.module.css";

// A bill photo, shown from an object URL that is revoked when the sheet closes.
export default function ImagePreview({ file }: { file: File }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    const made = URL.createObjectURL(file);
    const release = hold(() => URL.revokeObjectURL(made));
    setUrl(made);
    return () => {
      release();
      setUrl(null);
    };
  }, [file]);

  // Some phone photos (HEIC) are read fine but cannot be shown by every browser.
  if (failed) return <p className={styles.note}>{t.preview.failed}</p>;
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimizable asset
  return <img src={url} alt={t.preview.imageAlt(file.name)} className={styles.image} onError={() => setFailed(true)} />;
}

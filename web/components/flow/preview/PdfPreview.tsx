"use client";

import { useEffect, useRef, useState } from "react";
import { openPdfView } from "@/lib/local/pdf";
import { useI18n } from "@/lib/i18n";
import { hold } from "./release";
import styles from "./preview.module.css";

type PdfDoc = Awaited<Awaited<ReturnType<typeof openPdfView>>["promise"]>;

// Past 3x a phone's canvas grows large for no visible gain.
const MAX_RATIO = 3;

// The canvas fills the sheet's width; its backing store is that many device pixels, so text is crisp.
export function pageSize(pageWidth: number, pageHeight: number, cssWidth: number, devicePixelRatio: number) {
  const scale = cssWidth / pageWidth;
  const ratio = Math.min(Math.max(devicePixelRatio || 1, 1), MAX_RATIO);
  return {
    scale,
    ratio,
    width: Math.floor(pageWidth * scale * ratio),
    height: Math.floor(pageHeight * scale * ratio),
  };
}

// One page at a time, drawn on this device by pdf.js. The document is destroyed when the sheet closes.
export default function PdfPreview({ file, kind }: { file: File; kind: "statement" | "bill" }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let release = () => {};
    file
      .arrayBuffer()
      .then((buffer) => openPdfView(new Uint8Array(buffer)))
      .then((task) => {
        release = hold(() => void task.destroy());
        if (!live) {
          release();
          return;
        }
        return task.promise.then((d) => {
          if (!live) return;
          setDoc(d);
          setPages(d.numPages);
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      release();
    };
  }, [file]);

  // The sheet's width, now and whenever it changes (a phone turned sideways).
  useEffect(() => {
    const el = box.current;
    if (!el || !doc) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  useEffect(() => {
    const el = canvas.current;
    if (!doc || !el || !width) return;
    let live = true;
    let task: ReturnType<Awaited<ReturnType<PdfDoc["getPage"]>>["render"]> | null = null;
    let current: Awaited<ReturnType<PdfDoc["getPage"]>> | null = null;
    doc
      .getPage(page)
      .then((p) => {
        current = p;
        if (!live) return;
        const base = p.getViewport({ scale: 1 });
        const size = pageSize(base.width, base.height, width, window.devicePixelRatio);
        el.width = size.width;
        el.height = size.height;
        task = p.render({
          canvas: el,
          viewport: p.getViewport({ scale: size.scale }),
          transform: size.ratio === 1 ? undefined : [size.ratio, 0, 0, size.ratio, 0, 0],
        });
        return task.promise;
      })
      .catch((err: { name?: string }) => {
        if (live && err?.name !== "RenderingCancelledException") setFailed(true);
      })
      .finally(() => current?.cleanup());
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, page, width]);

  if (failed) return <p className={styles.note}>{t.preview.failed}</p>;

  const at = (n: number) => () => {
    if (n >= 1 && n <= pages) setPage(n);
  };
  const first = page <= 1;
  const last = page >= pages;

  return (
    <div className={styles.pdf}>
      {doc && pages === 1 ? (
        <p className={styles.pageCount}>{t.preview.page(1, 1)}</p>
      ) : doc ? (
        <nav className={styles.pager} aria-label={t.preview.pages}>
          {/* aria-disabled, not disabled, so focus stays on the button at the first or last page. */}
          <button type="button" className="btn btn-quiet" aria-disabled={first || undefined} onClick={at(page - 1)}>
            {t.preview.previous}
          </button>
          <p className={styles.pageCount} aria-live="polite">
            {t.preview.page(page, pages)}
          </p>
          <button type="button" className="btn btn-quiet" aria-disabled={last || undefined} onClick={at(page + 1)}>
            {t.preview.next}
          </button>
        </nav>
      ) : (
        <p className="meta" role="status">
          {t.preview.opening}
        </p>
      )}
      <div ref={box} className={styles.pageBox} hidden={!doc}>
        <canvas
          ref={canvas}
          className={styles.page}
          role="img"
          aria-label={doc ? t.preview.pageLabel(page, pages, kind) : undefined}
        />
      </div>
    </div>
  );
}

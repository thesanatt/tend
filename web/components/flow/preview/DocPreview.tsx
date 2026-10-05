"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { isPdf } from "@/lib/local/pdf";
import FlowSheet from "../FlowSheet";
import { useFlow, type PreviewSource } from "../FlowProvider";
import ImagePreview from "./ImagePreview";
import PdfPreview from "./PdfPreview";
import TablePreview from "./TablePreview";
import styles from "./preview.module.css";

export interface PreviewTarget {
  id: string; // the record's id in the flow (a statement, the demo bank, a bill)
  name: string; // the file name, or the demo bank's name; the sheet's heading
  kind: "statement" | "bank" | "bill";
}

type View = "pdf" | "image" | "table";

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;

// Which preview fits a file. The bytes decide a PDF, the way the readers do; a photo goes by its type,
// its name, or its first bytes; everything else is a statement export (CSV, OFX, QFX) shown as rows.
export async function previewView(file: File): Promise<View> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (isPdf(head)) return "pdf";
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (file.type.startsWith("image/") || IMAGE_NAME.test(file.name) || jpeg || png) return "image";
  return "table";
}

function Body({ target, source }: { target: PreviewTarget; source: PreviewSource }) {
  const { t } = useI18n();
  const { file, rows } = source;
  const [view, setView] = useState<View | null>(file ? null : "table");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!file) return;
    let live = true;
    previewView(file)
      .then((v) => live && setView(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [file]);

  if (failed) return <p className={styles.note}>{t.preview.failed}</p>;
  if (!view) return <p className="meta">{t.preview.opening}</p>;
  if (view === "pdf" && file) return <PdfPreview file={file} kind={target.kind === "bill" ? "bill" : "statement"} />;
  if (view === "image" && file) return <ImagePreview file={file} />;
  if (rows) return <TablePreview name={target.name} rows={rows} />;
  return <p className={styles.note}>{t.preview.failed}</p>;
}

// A record's own file, shown in the sheet. It is drawn from memory on this device: nothing is sent,
// nothing is stored, and the privacy line does not change.
export default function DocPreview({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  const { previewDoc } = useFlow();
  const source = target ? previewDoc(target.id) : null;
  return (
    <FlowSheet open={Boolean(target && source)} onClose={onClose} title={target?.name ?? ""}>
      {target && source ? (
        <div className={styles.preview}>
          <p className={styles.stays}>{t.preview.stays}</p>
          <Body key={target.id} target={target} source={source} />
        </div>
      ) : null}
    </FlowSheet>
  );
}

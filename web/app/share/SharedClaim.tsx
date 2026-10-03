"use client";

// The read-only claim an advocate sees: the amount, the checks, every cost with the law behind it,
// and the cited summary PDF, built in this browser from what was shared.
import { useRef, useState } from "react";
import Checks from "@/components/claim/Checks";
import Bed from "@/components/ledger/Bed";
import Money from "@/components/Money";
import { formatDay, formatTimestamp } from "@/lib/dates";
import { buildRows, groupBeds } from "@/lib/ledger";
import type { BuiltPacket, TendPacketBuilder } from "@/lib/packet";
import { FORM_SPECS, isDemo } from "@/lib/packet/specs";
import STATES from "@/lib/states.json";
import type { EngineInput, EngineOutput } from "@/lib/types";
import { useLaw } from "@/lib/useLaw";
import styles from "./share.module.css";

const noop = () => {};

export interface SharedClaimProps {
  input: EngineInput;
  output: EngineOutput;
  createdAt: string | null;
  expiresAt: string | null;
  // Opened in this browser from an end-to-end encrypted link.
  sealed: boolean;
  once?: boolean;
  expired?: boolean;
  notes?: string | null;
  engine?: string | null;
  // The built-in demo link with fictional data.
  demo?: boolean;
  builder?: TendPacketBuilder;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// pdf-lib loads only when someone asks for a PDF.
const loadBuilder = async () => (await import("@/lib/packet")).packetBuilder;

function Downloads({
  input,
  output,
  builder,
}: {
  input: EngineInput;
  output: EngineOutput;
  builder?: TendPacketBuilder;
}) {
  const st = output.jurisdiction.toUpperCase();
  const spec = FORM_SPECS[st] ?? null;
  const built = useRef<Promise<BuiltPacket> | null>(null);
  const [busy, setBusy] = useState<"summary" | "form" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function get(kind: "summary" | "form") {
    setBusy(kind);
    setProblem(null);
    try {
      built.current ??= (builder ? Promise.resolve(builder) : loadBuilder()).then((b) => b.build(st, input, output));
      const packet = await built.current;
      if (kind === "summary") save(packet.summaryPdf, `claim-summary-${st}.pdf`);
      else if (packet.formPdf) save(packet.formPdf, `${st}-application.pdf`);
      else setProblem(packet.notes[0] ?? "The state's form could not be made here.");
    } catch (e) {
      built.current = null;
      setProblem(`The PDF could not be made: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.downloads} aria-labelledby="share-downloads">
      <h2 id="share-downloads">Print or save</h2>
      <p>
        The summary lists every cost with its record and the exact words of the law, ready to send with the application.
        It is made in this browser. Nothing is uploaded.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => get("summary")} disabled={busy !== null}>
          {busy === "summary" ? "Making the PDF" : "Download the cited summary (PDF)"}
        </button>
        {spec ? (
          <button type="button" className="btn btn-secondary" onClick={() => get("form")} disabled={busy !== null}>
            {busy === "form" ? "Filling the form" : "Download the state's application (PDF)"}
          </button>
        ) : null}
      </div>
      {spec ? (
        <p className="meta">
          The application has only safe fields filled in: the kinds of costs and a note that a list is attached. Name,
          signature, Social Security number, and anything about what happened stay blank.
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className={styles.problem}>
          {problem}
        </p>
      ) : null}
    </section>
  );
}

export default function SharedClaim({
  input,
  output,
  createdAt,
  expiresAt,
  sealed,
  once,
  expired,
  notes,
  engine,
  demo,
  builder,
}: SharedClaimProps) {
  const law = useLaw(input.jurisdiction);
  const rows = buildRows(input.items, {}, output);
  const beds = groupBeds(rows, output);
  const name = STATES.find((s) => s.st === input.jurisdiction)?.name ?? input.jurisdiction;
  const fictional = demo || isDemo(input);

  return (
    <div className={styles.share}>
      <div className={styles.banner} role="note">
        <p>
          <strong>Read-only view for an advocate.</strong>{" "}
          {sealed
            ? "It opened in this browser with the key in the link. Tend's server keeps only a locked copy it cannot read."
            : "It shows costs and the law behind them, not bank account details."}
        </p>
        <p>
          {createdAt ? `Shared ${formatTimestamp(createdAt)}. ` : ""}
          {expiresAt ? `The link stops working ${formatTimestamp(expiresAt)}.` : ""}
        </p>
        {once ? (
          <p className={styles.once}>
            This link opens one time only. It will not open again, so download the summary if you need to keep it.
          </p>
        ) : null}
        {fictional ? <p>This claim uses fictional demo data from Capital One&apos;s Nessie, a mock bank.</p> : null}
      </div>
      {expired ? (
        <p className={styles.expired}>This link has expired. Ask the person who shared it for a new one.</p>
      ) : null}

      <header className={styles.head}>
        <h1>Claim summary</h1>
        <p className={styles.meta}>
          {name} law. Costs from {formatDay(input.context.incident_date)} to {formatDay(input.context.as_of_date)}.
        </p>
      </header>

      <section className={styles.total}>
        <p className={styles.totalLabel}>Amount they can ask for. The program decides.</p>
        <p className={styles.totalFigure}>
          <Money cents={output.totals.allowed_cents} face="inherit" />
        </p>
        {output.totals.held_cents > 0 ? (
          <p className={styles.held}>
            Held: <Money cents={output.totals.held_cents} face="inherit" /> on a bill the law says they should not be
            sent.
          </p>
        ) : null}
      </section>

      <Downloads input={input} output={output} builder={builder} />

      {notes ? (
        <section aria-labelledby="share-notes" className={styles.section}>
          <h2 id="share-notes">Note from the person who shared this</h2>
          <p className={styles.note}>{notes}</p>
        </section>
      ) : null}

      <section aria-labelledby="share-checks" className={styles.section}>
        <h2 id="share-checks">Checks</h2>
        <Checks checks={output.checks} law={law} policeReport={input.context.police_report} />
      </section>

      <section aria-labelledby="share-costs" className={styles.section}>
        <h2 id="share-costs">Costs and the law behind each</h2>
        {beds.map((bed) => (
          <Bed key={bed.expense} bed={bed} law={law} onAnswer={noop} readOnly />
        ))}
      </section>

      <p className="meta">
        Prepared with Tend. Tend is not legal advice. The program decides every claim.
        {engine ? ` Math by: ${engine}.` : ""}
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Checks from "@/components/claim/Checks";
import Bed from "@/components/ledger/Bed";
import Money from "@/components/Money";
import { fetchShare } from "@/lib/api";
import { formatDay, formatTimestamp } from "@/lib/dates";
import { buildRows, groupBeds } from "@/lib/ledger";
import STATES from "@/lib/states.json";
import type { ShareView } from "@/lib/types";
import { useLaw } from "@/lib/useLaw";
import styles from "./share.module.css";

const noop = () => {};

function Shared({ view, expired }: { view: ShareView; expired: boolean }) {
  const law = useLaw(view.input.jurisdiction);
  const rows = buildRows(view.input.items, {}, view.output);
  const beds = groupBeds(rows, view.output);
  const name = STATES.find((s) => s.st === view.input.jurisdiction)?.name ?? view.input.jurisdiction;

  return (
    <div className={styles.share}>
      <p className={styles.banner} role="note">
        <strong>Read-only view for an advocate.</strong> Shared {formatTimestamp(view.created_at)}. The link stops
        working {formatTimestamp(view.expires_at)}. It shows costs and the law behind them, not bank account details.
        {view.token === "demo" ? " This demo link uses fictional data." : ""}
      </p>
      {expired ? (
        <p className={styles.expired}>This link has expired. Ask the person who shared it for a new one.</p>
      ) : null}

      <header className={styles.head}>
        <h1>Claim summary</h1>
        <p className={styles.meta}>
          {name} law. Costs from {formatDay(view.input.context.incident_date)} to{" "}
          {formatDay(view.input.context.as_of_date)}.
        </p>
      </header>

      <section className={styles.total}>
        <p className={styles.totalLabel}>Amount they can ask for. The program decides.</p>
        <p className={styles.totalFigure}>
          <Money cents={view.output.totals.allowed_cents} face="inherit" />
        </p>
        {view.output.totals.held_cents > 0 ? (
          <p className={styles.held}>
            Held: <Money cents={view.output.totals.held_cents} /> on a bill the law says they should not be sent.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="share-checks" className={styles.section}>
        <h2 id="share-checks">Checks</h2>
        <Checks checks={view.output.checks} law={law} policeReport={view.input.context.police_report} />
      </section>

      <section aria-labelledby="share-costs" className={styles.section}>
        <h2 id="share-costs">Costs and the law behind each</h2>
        {beds.map((bed) => (
          <Bed key={bed.expense} bed={bed} law={law} onAnswer={noop} readOnly />
        ))}
      </section>

      <p className="meta">
        Prepared with Tend. Tend is not legal advice. The program decides every claim.
        {view.engine ? ` Math by: ${view.engine}.` : ""}
      </p>
    </div>
  );
}

export default function ShareScreen({ token }: { token: string }) {
  const [state, setState] = useState<{ view: ShareView; expired: boolean } | null | "loading" | { error: string }>(
    "loading",
  );

  useEffect(() => {
    let live = true;
    fetchShare(token)
      // The demo fixture has fixed dates, so it never shows as expired.
      .then(
        (v) =>
          live &&
          setState(v ? { view: v, expired: v.token !== "demo" && Date.parse(v.expires_at) < Date.now() } : null),
      )
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
    };
  }, [token]);

  if (state === "loading") return <p className="meta">Loading the shared claim</p>;
  if (state && "error" in state)
    return <p className={styles.expired}>This shared claim could not load: {state.error}</p>;
  if (!state) {
    return (
      <div className={styles.share}>
        <h1>This link does not work</h1>
        <p className="lead">It may have expired. Ask the person who shared it for a new one.</p>
      </div>
    );
  }
  return <Shared view={state.view} expired={state.expired} />;
}

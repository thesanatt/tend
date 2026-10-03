"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Money from "@/components/Money";
import type { ChecklistItem, FilingRoute, Letter, LetterKind } from "@/lib/contracts";
import type { EngineOutput } from "@/lib/types";
import { useI18n, useSummary, type Dict } from "@/lib/i18n";
import { useLaw, type LawIndex } from "@/lib/useLaw";
import Cite from "../Cite";
import EngineNotice from "../EngineNotice";
import { useFlow } from "../FlowProvider";
import LetterSheet from "../LetterSheet";
import { usePacket } from "../usePacket";
import styles from "../flow.module.css";
import ShareBox from "./ShareBox";

// The template that helps get each kind of document, when a letter does not name its rule itself.
const TEMPLATE_FOR: Record<string, LetterKind> = {
  wage_verification: "employer_wages",
  counseling_statement: "provider_statement",
  itemized_bill: "itemized_bill_request",
};

// The kind of document a checklist line asks for, from its rule (photo_id, itemized_bill, other...).
export function docType(item: ChecklistItem, law: LawIndex): string {
  const fromRule = law.rule(item.rule_id)?.params?.document;
  if (typeof fromRule === "string" && fromRule) return fromRule;
  return /^[a-z_]+$/.test(item.document) ? item.document : "other";
}

// A letter that quotes this line's own rule fits best; otherwise the template for its kind.
export function templateFor(item: ChecklistItem, type: string, letters: Letter[]): Letter | null {
  return (
    letters.find((l) => l.rule_ids.includes(item.rule_id)) ?? letters.find((l) => l.kind === TEMPLATE_FOR[type]) ?? null
  );
}

// The program's own words for a document, when its rule has a note; otherwise only its kind.
export function docNote(item: ChecklistItem, law: LawIndex): string | null {
  const note = law.rule(item.rule_id)?.params?.note;
  if (typeof note === "string" && note.trim()) return item.document;
  return null;
}

// Short enough to name the document in a button's label for a screen reader.
const excerpt = (text: string) => (text.length > 60 ? `${text.slice(0, 60).replace(/\s+\S*$/, "")}...` : text);

// In English the program's own description leads. In Spanish the kind of document comes first, in
// Spanish, with the program's words under it (translated on the device when it can be).
function DocName({ type, note }: { type: string; note: string | null }) {
  const { t, lang } = useI18n();
  const detail = useSummary(note ?? undefined);
  if (!note) return <span>{docLabel(t, type)}</span>;
  if (lang === "en") return <span>{note}</span>;
  return (
    <span>
      {docLabel(t, type)}
      <span className={styles.sub} lang={detail.original ? "en" : undefined}>
        {detail.text}
      </span>
    </span>
  );
}

function useBlobUrl(blob: Blob | null | undefined): string | null {
  const url = useMemo(
    () => (blob && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null),
    [blob],
  );
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

export function docLabel(t: Dict, document: string): string {
  return t.docs[document as keyof Dict["docs"]] ?? document.replace(/_/g, " ");
}

function Route({ route, t }: { route: FilingRoute; t: Dict }) {
  const target = route.target.trim();
  if (route.method === "online" && /^https?:\/\//i.test(target))
    return (
      <a href={target} target="_blank" rel="noopener noreferrer">
        {target.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 60)}
        <span className="visually-hidden"> {t.common.newTab}</span>
      </a>
    );
  if (route.method === "email" && /@/.test(target)) return <a href={`mailto:${target}`}>{target}</a>;
  return <span className={route.method === "mail" ? styles.address : undefined}>{target}</span>;
}

// The program's minimum loss, said only when it is not simply met: it can decide the claim.
function MinimumNote({ check, law }: { check: EngineOutput["checks"]["minimum_loss"]; law: LawIndex }) {
  const { t, f } = useI18n();
  if (!check.rule_ids.length || check.status === "met") return null;
  const amounts = check.rule_ids
    .map((id) => law.rule(id)?.params?.amount_cents)
    .filter((c): c is number => typeof c === "number" && Number.isSafeInteger(c) && c > 0);
  const min = amounts.length ? f.money(Math.max(...amounts)) : null;
  const text =
    check.status === "unknown" || !min
      ? t.packet.minimumDays
      : check.status === "not_met" || check.status === "may_be_waived" || check.status === "waived"
        ? t.packet.minimum[check.status](min)
        : null;
  if (!text) return null;
  return (
    <p className={styles.minimumNote}>
      {text} <Cite ruleIds={check.rule_ids} law={law} subject={t.packet.subjectMinimum} />
    </p>
  );
}

export default function PacketScreen() {
  const { t, f, lang } = useI18n();
  const { state, input, claim, dispatch, today } = useFlow();
  const law = useLaw(state.check.st || null);
  const output = claim.evaluation?.output.jurisdiction === state.check.st ? claim.evaluation.output : null;
  const pk = usePacket(Boolean(output));
  const formUrl = useBlobUrl(pk.packet?.formPdf);
  const summaryUrl = useBlobUrl(pk.packet?.summaryPdf);
  const [letter, setLetter] = useState<Letter | null>(null);

  if (!state.check.st) {
    return (
      <section className={styles.needState}>
        <h1>{t.packet.title}</h1>
        <p className="lead">{t.gather.needState}</p>
        <Link replace href="/check" className="btn btn-primary">
          {t.gather.toCheck}
        </Link>
      </section>
    );
  }

  const eligible = output?.lines.filter((l) => l.status === "eligible" && l.allowed_cents > 0) ?? [];
  const items = new Map(state.items.map((i) => [i.item_id, i]));
  const program = law.law?.program;
  const have = (c: ChecklistItem) => state.have[`${c.document}:${c.rule_id}`] ?? c.have_it;

  return (
    <div className={styles.packet}>
      <header className={styles.screenHead}>
        <h1>{t.packet.title}</h1>
        <p className="lead">{t.packet.lead}</p>
      </header>

      <section className={styles.packetTotal} aria-live="polite">
        <p className={styles.tallyLabel}>{t.common.askFor}</p>
        <p className={styles.bigFigure}>
          {output ? <Money cents={output.totals.allowed_cents} face="inherit" /> : "..."}
        </p>
        <p>
          {t.common.programDecides} {output ? t.packet.fromCosts(eligible.length) : null}
        </p>
        {output && output.totals.held_cents > 0 ? (
          <p className={styles.heldNote}>{t.packet.held(f.money(output.totals.held_cents))}</p>
        ) : null}
        {output ? <MinimumNote check={output.checks.minimum_loss} law={law} /> : null}
        <EngineNotice />
      </section>

      {pk.status === "building" ? (
        <p className="meta" role="status">
          {t.packet.building}
        </p>
      ) : null}
      {pk.status === "error" ? (
        <div role="alert" className={styles.problem}>
          <p>{t.packet.buildFailed}</p>
          <button type="button" className="link-button" onClick={pk.retry}>
            {t.common.tryAgain}
          </button>
        </div>
      ) : null}

      <ol className={styles.packetParts}>
        <li className={styles.part} aria-labelledby="part-form">
          <h2 id="part-form">{t.packet.formTitle}</h2>
          <p>{t.packet.formBody(law.law?.name ?? "")}</p>
          <p className={styles.onlyYou}>{t.packet.onlyYou}</p>
          {formUrl ? (
            <a href={formUrl} download={`${state.check.st}-application.pdf`} className="btn btn-primary">
              {t.packet.formDownload}
            </a>
          ) : pk.status === "ready" && program?.application_pdf_url ? (
            <>
              <p className="meta">{t.packet.formBlank}</p>
              <a href={program.application_pdf_url} target="_blank" rel="noopener noreferrer">
                {t.packet.formBlankLink}
                <span className="visually-hidden"> {t.common.newTab}</span>
              </a>
            </>
          ) : pk.status === "ready" ? (
            <p className="meta">{t.packet.formNone}</p>
          ) : null}
        </li>

        <li className={styles.part} aria-labelledby="part-summary">
          <h2 id="part-summary">{t.packet.summaryTitle}</h2>
          <p>{t.packet.summaryBody}</p>
          {summaryUrl ? (
            <a href={summaryUrl} download={`${state.check.st}-claim-summary.pdf`} className="btn btn-secondary">
              {t.packet.summaryDownload}
            </a>
          ) : null}
          {eligible.length ? (
            <details className={styles.lines}>
              <summary>{t.packet.summaryShow(eligible.length)}</summary>
              <table className={styles.lineTable}>
                <thead>
                  <tr>
                    <th scope="col">{t.packet.colCost}</th>
                    <th scope="col" className={styles.num}>
                      {t.packet.colAmount}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((l) => {
                    const it = items.get(l.item_id);
                    const subject = it ? `${it.description}, ${f.date(it.date)}` : l.item_id;
                    return (
                      <tr key={l.item_id}>
                        <td>
                          {it?.description ?? l.item_id}
                          <span className={styles.sub}>
                            {t.expense[l.expense]}
                            {it && it.origin !== "bill" ? `, ${f.date(it.date, "short")}` : ""}
                          </span>
                          {/* The law sits under its cost, so two columns fit a narrow phone. */}
                          <Cite
                            ruleIds={[...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : [])]}
                            law={law}
                            subject={subject}
                          />
                        </td>
                        <td className={styles.num}>
                          <Money cents={l.allowed_cents} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          ) : output ? (
            <p className="meta">{t.packet.noLines}</p>
          ) : null}
        </li>

        <li className={styles.part} aria-labelledby="part-needed">
          <h2 id="part-needed">{t.packet.neededTitle}</h2>
          <p>{t.packet.neededBody}</p>
          {pk.packet?.stillNeeded.length ? (
            <ul className={styles.checklist}>
              {pk.packet.stillNeeded.map((c) => {
                const key = `${c.document}:${c.rule_id}`;
                const type = docType(c, law);
                const note = docNote(c, law);
                const template = templateFor(c, type, pk.packet!.letters);
                // "Other documents" says nothing on its own, so the program's words name those.
                const name =
                  note && lang === "en"
                    ? excerpt(note)
                    : note && type === "other"
                      ? `${docLabel(t, type)}: ${excerpt(note)}`
                      : docLabel(t, type);
                return (
                  <li key={key}>
                    <label className={styles.checkLine}>
                      <input
                        type="checkbox"
                        checked={have(c)}
                        onChange={(e) => dispatch({ type: "have", key, value: e.target.checked })}
                      />
                      <DocName type={type} note={note} />
                    </label>
                    <div className={styles.checkActions}>
                      <Cite ruleIds={[c.rule_id]} law={law} subject={name} />
                      {template ? (
                        <button type="button" className="link-button" onClick={() => setLetter(template)}>
                          {t.packet.template}
                          <span className="visually-hidden">: {name}</span>
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : pk.status === "ready" ? (
            <p className="meta">{t.packet.neededNone}</p>
          ) : null}
        </li>

        <li className={styles.part} aria-labelledby="part-file">
          <h2 id="part-file">{t.packet.fileTitle}</h2>
          {pk.packet?.filing.length ? (
            <ul className={styles.routes}>
              {pk.packet.filing.map((r) => (
                <li key={`${r.method}-${r.rule_id}-${r.target}`}>
                  <span className={styles.method}>{t.methods[r.method]}</span>
                  <Route route={r} t={t} />
                  <Cite ruleIds={[r.rule_id]} law={law} subject={t.methods[r.method]} />
                </li>
              ))}
              {program?.phone ? (
                <li>
                  <span className={styles.method}>{t.methods.phone}</span>
                  <a href={`tel:${program.phone.replace(/[^\d+]/g, "")}`}>{program.phone}</a>
                </li>
              ) : null}
            </ul>
          ) : pk.status === "ready" ? (
            <p className="meta">{t.packet.fileNone}</p>
          ) : null}
        </li>

        <li className={styles.part} aria-labelledby="part-share">
          <h2 id="part-share">{t.packet.shareTitle}</h2>
          <p>{t.packet.shareBody}</p>
          {input && output ? <ShareBox input={input} output={output} /> : null}
        </li>

        <li className={styles.part} aria-labelledby="part-sent">
          <h2 id="part-sent">{t.packet.sentTitle}</h2>
          <p>{t.packet.sentBody}</p>
          {state.filed_at ? (
            <p className={styles.done}>
              {t.packet.sentDone(f.date(state.filed_at))}{" "}
              <button type="button" className="link-button" onClick={() => dispatch({ type: "filed", at: null })}>
                {t.common.undo}
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!eligible.length}
              onClick={() => dispatch({ type: "filed", at: today })}
            >
              {t.packet.sentButton}
            </button>
          )}
        </li>
      </ol>

      <div className={styles.nextRow}>
        <Link href="/track" className="btn btn-primary">
          {t.packet.toTrack}
        </Link>
      </div>

      <LetterSheet open={letter !== null} onClose={() => setLetter(null)} letter={letter} law={law} />
    </div>
  );
}

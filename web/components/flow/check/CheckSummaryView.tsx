"use client";

import { useI18n, type Dict } from "@/lib/i18n";
import type { LawIndex } from "@/lib/useLaw";
import { capText, spanText, type CheckSummary } from "../checkSummary";
import Cite from "../Cite";
import { useFlow } from "../FlowProvider";
import styles from "../flow.module.css";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Fact({ children, cite }: { children: React.ReactNode; cite?: React.ReactNode }) {
  return (
    <li className={styles.fact}>
      <div className={styles.factText}>{children}</div>
      {cite ? <div className={styles.factCite}>{cite}</div> : null}
    </li>
  );
}

export default function CheckSummaryView({
  summary,
  law,
  ready,
}: {
  summary: CheckSummary;
  law: LawIndex;
  ready: boolean;
}) {
  const { t, f } = useI18n();
  const { state, today } = useFlow();
  const { check } = state;
  const s = summary;
  const d = s.deadline;
  const r = s.reporting;
  const alternatives = r.alternatives.map((a) => t.alt[a as keyof Dict["alt"]] ?? t.alt.other);

  return (
    <ul className={styles.facts} aria-busy={!ready}>
      <Fact
        cite={
          s.apply.length ? (
            <Cite ruleIds={s.apply} law={law} subject={t.check.subjectApply} explain={t.check.applyNote} />
          ) : null
        }
      >
        <p className={styles.factLead}>{t.check.apply(s.name)}</p>
        <p className={styles.factNote}>{t.check.applyNote}</p>
      </Fact>

      {ready ? (
        <Fact
          cite={
            d.kind !== "none" && d.ruleIds.length ? (
              <Cite ruleIds={d.ruleIds} law={law} subject={t.check.subjectDeadline} />
            ) : null
          }
        >
          {d.kind === "date" ? (
            <>
              <p className={styles.factLead}>
                {d.late ? t.check.deadlineLate(f.date(d.date)) : t.check.deadlineDate(f.date(d.date))}
              </p>
              {!d.late ? (
                <p className={styles.factNote}>{t.check.deadlineLeft(f.span(today, d.date) ?? "")}</p>
              ) : (
                <p className={styles.factNote}>{d.canExtend ? t.check.deadlineExtend : t.check.deadlineAsk}</p>
              )}
              {d.fromReport ? <p className={styles.factNote}>{t.check.deadlineFromReport}</p> : null}
            </>
          ) : d.kind === "span" ? (
            <>
              <p className={styles.factLead}>{t.check.deadlineSpan(spanText(d, t, f))}</p>
              <p className={styles.factNote}>{t.check.deadlineSpanNote}</p>
            </>
          ) : d.kind === "unknown" ? (
            <p className={styles.factLead}>{t.check.deadlineUnknown}</p>
          ) : (
            <p className={styles.factLead}>{t.check.deadlineNone}</p>
          )}
        </Fact>
      ) : null}

      {ready ? (
        <Fact
          cite={
            r.ruleIds.length && r.status !== "none" ? (
              <Cite ruleIds={r.ruleIds} law={law} subject={t.check.subjectReport} />
            ) : null
          }
        >
          <p className={styles.factLead}>
            {r.status === "met_by_report"
              ? t.check.reportByReport
              : r.status === "met_by_exam"
                ? t.check.reportByExam
                : r.status === "required"
                  ? t.check.reportRequired
                  : r.status === "not_required"
                    ? t.check.reportNotRequired
                    : r.status === "none"
                      ? t.check.reportNone
                      : t.check.reportDepends}
          </p>
          {alternatives.length && (r.status === "required" || r.status === "depends") ? (
            <p className={styles.factNote}>{t.check.reportAlternatives(f.or(alternatives))}</p>
          ) : null}
          {check.police !== "yes" ? <p className={styles.factNote}>{t.check.reportChoice}</p> : null}
        </Fact>
      ) : null}

      {s.examNoBill.length && check.exam !== "no" ? (
        <Fact cite={<Cite ruleIds={s.examNoBill} law={law} subject={t.check.subjectExam} tone="held" />}>
          <p className={styles.factLead}>{t.check.examNoBill}</p>
          <p className={styles.factNote}>{t.check.examNoBillNote}</p>
        </Fact>
      ) : null}

      <li className={styles.fact}>
        <div className={styles.factText}>
          <p className={styles.factLead}>{t.check.coveredTitle}</p>
          {s.covered.length ? (
            <ul className={styles.covered}>
              {s.covered.map((c) => {
                const cap = capText(c, t, f);
                return (
                  <li key={c.expense}>
                    <span>
                      {t.expense[c.expense]}
                      {cap ? `, ${cap}` : ""}
                    </span>
                    <Cite ruleIds={c.ruleIds} law={law} subject={t.expense[c.expense]} />
                  </li>
                );
              })}
              {s.totalCap ? (
                <li className={styles.coveredTotal}>
                  <span>{t.check.totalCap(f.moneyShort(s.totalCap.cents))}</span>
                  <Cite ruleIds={s.totalCap.ruleIds} law={law} subject={t.check.subjectTotal} />
                </li>
              ) : null}
            </ul>
          ) : (
            <p className={styles.factNote}>{t.check.coveredNone}</p>
          )}
        </div>
      </li>

      {s.acp || s.records.length ? (
        <li className={styles.fact}>
          <div className={styles.factText}>
            <p className={styles.factLead}>{t.check.privateTitle}</p>
            <ul className={styles.covered}>
              {s.acp ? (
                <li>
                  <span>
                    {s.acp.coversSexualAssault
                      ? t.check.acp(s.acp.programName ?? t.check.acpGeneric)
                      : t.check.acpMaybe(s.acp.programName ?? t.check.acpGeneric)}
                  </span>
                  <Cite ruleIds={s.acp.ruleIds} law={law} subject={t.check.subjectAcp} />
                </li>
              ) : null}
              {s.records.length ? (
                <li>
                  <span>{t.check.records}</span>
                  <Cite ruleIds={s.records} law={law} subject={t.check.subjectRecords} />
                </li>
              ) : null}
            </ul>
          </div>
        </li>
      ) : null}

      <li className={styles.fact}>
        <div className={styles.factText}>
          <p className={styles.factLead}>{t.check.programTitle}</p>
          <p>
            {s.program.name}
            <span className={styles.agency}>{s.program.agency}</span>
          </p>
          <dl className={styles.contact}>
            {s.program.phone ? (
              <div>
                <dt>{t.check.phone}</dt>
                <dd>
                  <a href={`tel:${s.program.phone.replace(/[^\d+]/g, "")}`}>{s.program.phone}</a>
                </dd>
              </div>
            ) : null}
            {s.program.website ? (
              <div>
                <dt>{t.check.website}</dt>
                <dd>
                  <a href={s.program.website} target="_blank" rel="noopener noreferrer">
                    {host(s.program.website)}
                    <span className="visually-hidden"> {t.common.newTab}</span>
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          {s.program.phoneSourceId && law.source(s.program.phoneSourceId) ? (
            <p className="meta">
              {t.check.contactFrom}{" "}
              <a href={law.source(s.program.phoneSourceId)!.url} target="_blank" rel="noopener noreferrer">
                {law.source(s.program.phoneSourceId)!.title}
                <span className="visually-hidden"> {t.common.newTab}</span>
              </a>
            </p>
          ) : null}
        </div>
      </li>
    </ul>
  );
}

"use client";

import { deadlineTerms, spanText } from "@/lib/deadline";
import { useI18n, type Dict } from "@/lib/i18n";
import type { LawIndex } from "@/lib/useLaw";
import { capText, type CheckSummary } from "../checkSummary";
import Cite from "../Cite";
import { useFlow } from "../FlowProvider";
import RuleTerms from "../RuleTerms";
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
              {/* Never "File by" a date that has passed. */}
              <p className={styles.factLead}>
                {(d.late
                  ? d.condition
                    ? t.check.deadlineLateIf
                    : t.check.deadlineLate
                  : d.condition
                    ? t.check.deadlineDateIf
                    : t.check.deadlineDate)(f.date(d.date))}
              </p>
              {d.condition ? <RuleTerms text={deadlineTerms(d.condition)} className={styles.factNote} /> : null}
              {d.condition ? <p className={styles.factNote}>{t.check.deadlineOtherCases}</p> : null}
              {d.late ? null : <p className={styles.factNote}>{t.check.deadlineLeft(f.span(today, d.date) ?? "")}</p>}
              {d.longer && !d.late ? (
                <p className={styles.factNote}>{t.check.deadlineLonger(f.date(d.longer))}</p>
              ) : null}
              {d.late ? (
                <p className={styles.factNote}>
                  {d.open && d.longer ? t.check.deadlineLongerAsk(f.date(d.longer)) : t.check.deadlineAsk}
                </p>
              ) : null}
              {d.fromReport ? <p className={styles.factNote}>{t.check.deadlineFromReport}</p> : null}
              {d.fromDiscovery ? <p className={styles.factNote}>{t.check.deadlineFromDiscovery}</p> : null}
              {d.late && d.laterElsewhere ? <p className={styles.factNote}>{t.check.deadlineLaterElsewhere}</p> : null}
            </>
          ) : d.kind === "span" ? (
            <>
              <p className={styles.factLead}>
                {(d.condition ? t.check.deadlineSpanIf : t.check.deadlineSpan)(spanText(d, t.units, f.and))}
              </p>
              {d.condition ? <RuleTerms text={deadlineTerms(d.condition)} className={styles.factNote} /> : null}
              {d.condition ? <p className={styles.factNote}>{t.check.deadlineOtherCases}</p> : null}
              {d.longer ? <p className={styles.factNote}>{t.check.deadlineSpanLonger}</p> : null}
              {d.fromReport ? <p className={styles.factNote}>{t.check.deadlineSpanFromReport}</p> : null}
              {d.fromDiscovery ? <p className={styles.factNote}>{t.check.deadlineFromDiscovery}</p> : null}
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
              // The rules that name the other records are cited too, and the ones that limit the exam.
              <Cite
                ruleIds={[...new Set([...r.ruleIds, ...r.altRuleIds, ...r.examCountsIf])]}
                law={law}
                subject={t.check.subjectReport}
              />
            ) : null
          }
        >
          <p className={styles.factLead}>
            {r.status === "met_by_report"
              ? t.check.reportByReport
              : r.status === "met_by_exam"
                ? r.examCountsIf.length
                  ? t.check.reportByExamIf
                  : t.check.reportByExam
                : r.status === "required"
                  ? t.check.reportRequired
                  : r.status === "not_required"
                    ? alternatives.length
                      ? t.check.reportNotOnly
                      : t.check.reportNotRequired
                    : r.status === "none"
                      ? t.check.reportNone
                      : t.check.reportDepends}
          </p>
          {alternatives.length && (r.status === "required" || r.status === "depends" || r.status === "not_required") ? (
            <p className={styles.factNote}>{t.check.reportAlternatives(f.or(alternatives))}</p>
          ) : null}
          {check.police !== "yes" ? <p className={styles.factNote}>{t.check.reportChoice}</p> : null}
        </Fact>
      ) : null}

      {s.examNoBill.length && check.exam !== "no" ? (
        <Fact cite={<Cite ruleIds={s.examNoBill} law={law} subject={t.check.subjectExam} tone="held" />}>
          {s.examConditional ? (
            <>
              <p className={styles.factLead}>{t.check.examNoBillIf}</p>
              {s.examTerms ? <RuleTerms text={s.examTerms} className={styles.factNote} /> : null}
              <p className={styles.factNote}>{t.check.examNoBillNoteIf}</p>
            </>
          ) : (
            <>
              <p className={styles.factLead}>{t.check.examNoBill}</p>
              <p className={styles.factNote}>{t.check.examNoBillNote}</p>
            </>
          )}
        </Fact>
      ) : null}

      <li className={styles.fact}>
        <div className={styles.factText}>
          <p className={styles.factLead}>{t.check.coveredTitle}</p>
          {s.covered.length ? (
            <ul className={styles.covered}>
              {s.covered.map((c) => {
                const cap = capText(c, t, f);
                // A cost the law pays only on a condition, such as bedding kept as evidence, is named with it.
                const name = c.condition ? t.check.clothingKept[c.condition] : t.expense[c.expense];
                return (
                  <li key={c.expense}>
                    <span>
                      {name}
                      {cap ? `, ${cap}` : ""}
                    </span>
                    <Cite ruleIds={c.ruleIds} law={law} subject={name} />
                  </li>
                );
              })}
              {s.totalCap ? (
                <li className={styles.coveredTotal}>
                  <span>
                    {s.totalCap.hedged
                      ? t.check.totalCapIf(f.moneyShort(s.totalCap.cents))
                      : t.check.totalCap(f.moneyShort(s.totalCap.cents))}
                  </span>
                  <Cite ruleIds={s.totalCap.ruleIds} law={law} subject={t.check.subjectTotal} />
                </li>
              ) : null}
              {!s.totalCap && s.totalCapsDepend.length ? (
                <li className={styles.coveredTotal}>
                  <span>{t.check.totalCapDepends(f.or(s.totalCapsDepend.map((c) => f.moneyShort(c.cents))))}</span>
                  <Cite
                    ruleIds={s.totalCapsDepend.flatMap((c) => c.ruleIds)}
                    law={law}
                    subject={t.check.subjectTotal}
                  />
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

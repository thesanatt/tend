"use client";

import Citation from "@/components/Citation";
import { describeSpan, formatDay, todayIso } from "@/lib/dates";
import { generalDeadline, type LawIr } from "@/lib/deadline";
import { examCountsIf, reportAltRules } from "@/lib/hedge";
import { en } from "@/lib/i18n/en";
import { formatCents } from "@/lib/money";
import {
  checkCopy,
  DEADLINE,
  deadlineCopy,
  deadlineNotes,
  FROM_REPORT,
  MINIMUM_LOSS,
  reportingCopy,
} from "@/lib/status";
import type { EngineChecks, Jurisdiction, PoliceReport } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import styles from "./claim.module.css";

// The law IR and the date it happened, so the advocate sees the general deadline the PDF leads with.
export interface DeadlineContext {
  law: Jurisdiction | null;
  ir: LawIr | null | undefined;
  incident: string;
}

interface ChecksProps {
  checks: EngineChecks;
  law: LawIndex;
  policeReport: PoliceReport;
  deadline?: DeadlineContext;
}

const LATE_ASK = "Ask the program whether a late claim can still be filed.";

// The deadline check as the advocate reads it: the general rule's date (lib/deadline.ts), as Check and
// the cited summary PDF give it, with the engine's longer date when some cases have one. Without the
// law IR, the engine's own date. No sentence says the program extends a deadline: only the rules can.
export function deadlineCheck(
  c: EngineChecks["deadline"],
  today = todayIso(),
  ctx?: DeadlineContext,
): { text: string; copy: { label: string; tone: "good" | "warn" | "neutral" }; ruleIds: string[] } {
  const dated = Boolean(c.deadline_date) && (c.status === "ok" || c.status === "late");
  const general = ctx?.law && ctx.ir && dated ? generalDeadline(ctx.law, ctx.ir, ctx.incident, c) : null;
  if (general) {
    const notes = [
      general.fromReport ? FROM_REPORT : null,
      general.fromDiscovery ? en.check.deadlineFromDiscovery : null,
    ]
      .filter(Boolean)
      .map((n) => ` ${n}`)
      .join("");
    const day = formatDay(general.date);
    if (general.date >= today) {
      const longer = general.longer ? ` Some cases have until ${formatDay(general.longer)}. The rule says when.` : "";
      return {
        text: `File by ${day}. That is ${describeSpan(today, general.date)} from today.${longer}${notes}`,
        copy: DEADLINE.ok,
        ruleIds: general.ruleIds,
      };
    }
    const open = Boolean(general.longer && general.longer >= today);
    const after = open
      ? ` Some cases have until ${formatDay(general.longer!)}. Ask the program whether theirs is one.`
      : general.laterElsewhere
        ? " Another rule in this state counts from a later day, such as the report or when it was discovered. Ask the program whether it fits them."
        : ` ${LATE_ASK}`;
    const maybe = open || general.laterElsewhere || notes.length > 0;
    return {
      text: `The usual deadline was ${day}.${after}${notes}`,
      copy: maybe ? { label: "May have more time", tone: "neutral" } : DEADLINE.late,
      ruleIds: general.ruleIds,
    };
  }
  return { text: deadlineText(c, today), copy: deadlineCopy(c), ruleIds: c.rule_ids };
}

export function deadlineText(c: EngineChecks["deadline"], today = todayIso(), ctx?: DeadlineContext): string {
  if (ctx) return deadlineCheck(c, today, ctx).text;
  const notes = deadlineNotes(c)
    .map((n) => ` ${n}`)
    .join("");
  if (c.status === "ok" && c.deadline_date) {
    return `File by ${formatDay(c.deadline_date)}. That is ${describeSpan(today, c.deadline_date)} from today.${notes}`;
  }
  if (c.status === "late" && c.deadline_date) {
    return `The usual deadline was ${formatDay(c.deadline_date)}. ${LATE_ASK}${notes}`;
  }
  // Rules counted in months or from a later event (age 18, a report) cannot be dated from the incident.
  if (c.rule_ids.length)
    return "Tend could not turn this state's deadline into a date. Read the rule, or ask the program.";
  return "Tend found no filing deadline in the verified rules. Ask the program.";
}

export function reportingText(c: EngineChecks["reporting"], law: LawIndex, police: PoliceReport): string {
  if (c.status === "satisfied") {
    if (!c.rule_ids.length) return "Tend found no police report rule in this state's verified rules.";
    if (police === "yes") return "They said it was reported, which meets this rule.";
    // The exam counts only within a limit, only sometimes, or with a criminal charge (lib/hedge.ts).
    return law.law && examCountsIf(law.law).length
      ? "Their forensic exam may count in place of a police report here. The rule says when."
      : "Their forensic exam counts in place of a police report here.";
  }
  if (c.status === "required") return "This program asks for a police report. Reporting is still their choice.";
  if (c.status === "not_required")
    return law.law && reportAltRules(law.law).length
      ? "A police report is not the only record that counts here. The rule says which others count, and when."
      : "This program does not require a police report.";
  const alt = c.rule_ids.some((id) => (law.rule(id)?.params?.alternatives ?? []).length > 0);
  return alt
    ? "This depends on their answers. Some ways other than a police report count here."
    : "This depends on whether it was reported. They do not have to say.";
}

function waiverText(waivedFor: unknown): string | null {
  const list = (Array.isArray(waivedFor) ? waivedFor : [waivedFor]).filter(
    (w): w is string => typeof w === "string" && !!w,
  );
  return list.length ? list.map((w) => w.replace(/_/g, " ")).join("; ") : null;
}

export function minimumText(c: EngineChecks["minimum_loss"], law: LawIndex): string {
  const rules = c.rule_ids.map((id) => law.rule(id)).filter((r) => r !== undefined);
  const amount = rules.map((r) => r.params?.amount_cents).find((a) => typeof a === "number");
  const min = typeof amount === "number" ? formatCents(amount) : null;
  const waiver = rules.map((r) => waiverText(r.params?.waived_for)).find((w) => w);
  if (c.status === "met")
    return min ? `Their costs are at or over the program's minimum of ${min}.` : "No minimum loss rule applies.";
  if (c.status === "waived") return "The minimum loss rule is waived here for survivors of sexual assault.";
  if (c.status === "may_be_waived")
    return `The costs so far are under the program's minimum${min ? ` of ${min}` : ""}, and the program can waive it for survivors of sexual assault.`;
  if (c.status === "not_met") {
    const base = `The program's minimum is ${min ?? "not stated"}. The costs so far are under it.`;
    return waiver ? `${base} The law lets the program waive it for: ${waiver}. Ask whether that applies.` : base;
  }
  return "The minimum here is counted in days of work missed. Ask the program how it applies to them.";
}

export default function Checks({ checks, law, policeReport, deadline }: ChecksProps) {
  const due = deadlineCheck(checks.deadline, todayIso(), deadline);
  const rows = [
    {
      key: "deadline",
      title: "Deadline",
      copy: due.copy,
      text: due.text,
      ruleIds: due.ruleIds,
    },
    {
      key: "reporting",
      title: "Reporting to police",
      copy: reportingCopy(checks.reporting),
      text: reportingText(checks.reporting, law, policeReport),
      ruleIds: checks.reporting.rule_ids,
    },
    {
      key: "minimum",
      title: "Minimum loss",
      copy: checkCopy(MINIMUM_LOSS, checks.minimum_loss.status),
      text: minimumText(checks.minimum_loss, law),
      ruleIds: checks.minimum_loss.rule_ids,
    },
  ];

  return (
    <ul className={styles.checks}>
      {rows.map((r) => (
        <li key={r.key} className={styles.check} data-tone={r.copy.tone}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={styles.checkMark}>
            {r.copy.tone === "good" ? (
              <path
                d="M3 8.5L6.5 12L13 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : r.copy.tone === "warn" ? (
              <path d="M8 3V9.5M8 12.5V13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            )}
          </svg>
          <div className={styles.checkBody}>
            <h3 className={styles.checkTitle}>
              {r.title}: <span>{r.copy.label}</span>
            </h3>
            <p>{r.text}</p>
            {r.ruleIds.length ? (
              <Citation
                ruleIds={r.ruleIds}
                status="eligible"
                law={law}
                subject={r.title}
                title={`The rule behind this: ${r.title.toLowerCase()}`}
                explain={r.text}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

"use client";

import Citation from "@/components/Citation";
import { describeSpan, formatDay, todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { checkCopy, DEADLINE, MINIMUM_LOSS, REPORTING } from "@/lib/status";
import type { EngineChecks, PoliceReport } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import styles from "./claim.module.css";

interface ChecksProps {
  checks: EngineChecks;
  law: LawIndex;
  policeReport: PoliceReport;
}

function deadlineText(c: EngineChecks["deadline"]): string {
  if (c.status === "ok" && c.deadline_date) {
    return `File by ${formatDay(c.deadline_date)}. That is ${describeSpan(todayIso(), c.deadline_date)} from today.`;
  }
  if (c.status === "late" && c.deadline_date) {
    return `The usual deadline was ${formatDay(c.deadline_date)}. Many programs extend it for good cause, so it is still worth asking.`;
  }
  return "Tend found no filing deadline in the verified rules. Ask the program.";
}

function reportingText(c: EngineChecks["reporting"], law: LawIndex, police: PoliceReport): string {
  if (c.status === "satisfied") {
    return police === "yes"
      ? "You said it was reported, which meets this rule."
      : "Your forensic exam counts in place of a police report here.";
  }
  if (c.status === "required")
    return "This program asks for a police report. An advocate can help with this step if you want it.";
  if (c.status === "none") return "Tend found no reporting rule in the verified rules.";
  const alt = c.rule_ids.some((id) => (law.rule(id)?.params?.alternatives ?? []).length > 0);
  return alt
    ? "This depends on your answers. Some ways other than a police report count here."
    : "This depends on whether it was reported. You do not have to say.";
}

function minimumText(c: EngineChecks["minimum_loss"], law: LawIndex): string {
  const amount = c.rule_ids.map((id) => law.rule(id)?.params?.amount_cents).find((a) => typeof a === "number");
  const min = typeof amount === "number" ? formatCents(amount) : null;
  if (c.status === "met")
    return min ? `Your costs are over the program's minimum of ${min}.` : "No minimum loss rule applies.";
  if (c.status === "waived") return "The minimum loss rule is waived here for survivors of sexual assault.";
  if (c.status === "not_met") return `The program's minimum is ${min ?? "not stated"}. The costs so far are under it.`;
  return "The minimum here is counted in days of work missed. Ask the program how it applies to you.";
}

export default function Checks({ checks, law, policeReport }: ChecksProps) {
  const rows = [
    {
      key: "deadline",
      title: "Deadline",
      copy: checkCopy(DEADLINE, checks.deadline.status),
      text: deadlineText(checks.deadline),
      ruleIds: checks.deadline.rule_ids,
    },
    {
      key: "reporting",
      title: "Reporting to police",
      copy: checkCopy(REPORTING, checks.reporting.status),
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

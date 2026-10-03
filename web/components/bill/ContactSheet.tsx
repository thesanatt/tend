"use client";

import { useState } from "react";
import RuleCard from "@/components/RuleCard";
import Sheet from "@/components/Sheet";
import { formatDay } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { BillAudit } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import styles from "./bill.module.css";

interface ContactSheetProps {
  open: boolean;
  onClose: () => void;
  law: LawIndex;
  bill: BillAudit;
  heldCents: number;
}

export function contactScript(law: LawIndex, bill: BillAudit, heldCents: number): string {
  const noBill = law.byCategory("exam_no_bill")[0];
  const payer = law.byCategory("exam_payment")[0]?.params?.payer;
  const state = law.law?.name ?? "State";
  const parts = [
    `I got a bill from ${bill.provider} for a forensic exam on ${formatDay(bill.service_date)}` +
      `${bill.account_ref ? `, account ${bill.account_ref}` : ""}, for ${formatCents(heldCents)}.`,
  ];
  if (noBill) parts.push(`${state} law, ${noBill.pinpoint}, says I should not be billed for any part of this exam.`);
  parts.push(`Can you help me have this bill sent to ${typeof payer === "string" ? payer : "the program"} instead?`);
  return parts.join(" ");
}

export default function ContactSheet({ open, onClose, law, bill, heldCents }: ContactSheetProps) {
  const [copied, setCopied] = useState(false);
  const program = law.law?.program;
  const noBill = law.byCategory("exam_no_bill")[0];
  const payRule = law.byCategory("exam_payment")[0];
  const script = contactScript(law, bill, heldCents);

  return (
    <Sheet open={open} onClose={onClose} title="Contact the exam payment program" tone="held">
      <div className={styles.contact}>
        {payRule ? (
          <p>
            <strong>Who pays for the exam: </strong>
            {typeof payRule.params?.payer === "string" ? payRule.params.payer : payRule.summary}
          </p>
        ) : null}
        {program ? (
          <dl className={styles.terms}>
            <div>
              <dt>Program</dt>
              <dd>
                {program.program_name}
                <span className={styles.agency}>{program.agency}</span>
              </dd>
            </div>
            {program.phone ? (
              <div>
                <dt>Phone</dt>
                <dd>
                  <a href={`tel:${program.phone.replace(/[^\d+]/g, "")}`}>{program.phone}</a>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Website</dt>
              <dd>
                <a href={program.website} target="_blank" rel="noopener noreferrer">
                  {new URL(program.website).hostname.replace(/^www\./, "")}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <section className={styles.script} aria-labelledby="say-title">
        <h3 id="say-title">What you can say</h3>
        <p className={styles.scriptText}>{script}</p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(script);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy what to say"}
          </button>
        </div>
        <p className="meta">Tend does not call or write to anyone for you. You choose if and when to reach out.</p>
      </section>

      {noBill ? (
        <section className={styles.contactLaw}>
          <h3>The law to point to</h3>
          <RuleCard rule={noBill} source={law.source(noBill.source_id)} />
        </section>
      ) : null}
    </Sheet>
  );
}

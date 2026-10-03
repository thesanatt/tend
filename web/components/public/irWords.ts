// Plain words for what the law engine does with each verified rule, read from the law IR
// (rules/ir, docs/SPEC.md v1.1 and v1.2). Shown on "How Tend decides".
import { formatCentsShort } from "@/lib/money";
import { expenseName } from "./summary";
import type { IrRule, IrSkip } from "./types";

export type Use = "decides" | "info" | "set_aside" | "not_compiled";

export interface RuleUse {
  use: Use;
  text: string;
}

const UNIT_WORD: Record<string, string> = {
  session: "session",
  week: "week",
  hour: "hour",
  mile: "mile",
  day: "day",
  month: "month",
  item: "item",
};

const FROM_WORD: Record<string, string> = {
  crime: "the crime",
  incident: "the incident",
  injury: "the injury",
  offense: "the offense",
  discovery: "discovery of the crime",
  report: "the police report (counted from the date it happened)",
};

const ALT_WORD: Record<string, string> = {
  forensic_exam: "a forensic exam",
  protective_order: "a protective order",
  medical_provider: "medical records",
  advocate: "an advocate",
  other: "other proof",
};

function money(cents: unknown): string | null {
  return typeof cents === "number" && Number.isSafeInteger(cents) ? formatCentsShort(cents) : null;
}

function lower(expense: unknown): string {
  return typeof expense === "string" ? expenseName(expense).toLowerCase() : "a cost";
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

// What the compiler did with a rule. The text is one plain sentence.
export function ruleUse(ir: IrRule | undefined, skip: IrSkip | undefined): RuleUse {
  if (skip) return { use: "set_aside", text: `Set aside: ${skipReason(skip.reason)}` };
  if (!ir) return { use: "not_compiled", text: "Not in the compiled law yet." };
  switch (ir.kind) {
    case "exam_no_bill":
      return { use: "decides", text: "Decides: an exam bill is held, not counted, and you are told not to pay it." };
    case "exam_payment":
      return { use: "decides", text: "Decides: listed with a held exam bill as who should pay instead." };
    case "total_cap": {
      const m = money(ir.cap_cents);
      return { use: "decides", text: m ? `Decides: the total for the claim stops at ${m}.` : "Decides: a total limit." };
    }
    case "expense_cap": {
      const m = money(ir.cap_cents);
      const what = lower(ir.expense);
      let text =
        ir.per === "unit" && ir.unit
          ? `Decides: ${what} is limited to ${m ?? "a set amount"} per ${UNIT_WORD[ir.unit] ?? ir.unit}`
          : `Decides: ${what} is limited to ${m ?? "a set amount"} in total`;
      if (typeof ir.count_limit === "number") text += `, for up to ${ir.count_limit} ${UNIT_WORD[ir.unit ?? ""] ?? "unit"}s`;
      text += ".";
      if (ir.alt_rule_ids?.length) text += ` Lower limits kept beside it: ${ir.alt_rule_ids.join(", ")}.`;
      return { use: "decides", text };
    }
    case "covered":
      return { use: "decides", text: `Decides: ${lower(ir.expense)} counts as a covered cost.` };
    case "excluded": {
      const tags = ir.tags?.length ? ` when it is a ${list(ir.tags.map((t) => t.replace(/_/g, " ")))}` : "";
      return {
        use: "decides",
        text: ir.expense
          ? `Decides: ${lower(ir.expense)} is not covered${tags}.`
          : `Decides: a cost is not covered${tags}.`,
      };
    }
    case "deadline": {
      const from = FROM_WORD[ir.from ?? ""] ?? (ir.from ? `the ${ir.from}` : "the date it happened");
      return {
        use: "decides",
        text: `Decides: the filing deadline, ${typeof ir.days === "number" ? ir.days.toLocaleString("en-US") : "some"} days after ${from}.`,
      };
    }
    case "reporting": {
      const alts = (ir.alternatives ?? []).map((a) => ALT_WORD[a] ?? a.replace(/_/g, " "));
      const base = ir.required ? "a police report is required" : "a police report is not required";
      return {
        use: "decides",
        text: `Decides: ${base}${alts.length ? `, and ${list(alts)} can count instead` : ""}.`,
      };
    }
    case "minimum_loss": {
      const parts: string[] = [];
      const m = money(ir.cap_cents);
      if (m) parts.push(`at least ${m} in costs`);
      if (typeof ir.days_lost === "number") parts.push(`${ir.days_lost} days of lost pay`);
      const waiver = ir.waiver_for_sexual_assault
        ? ir.waiver === "automatic"
          ? " It does not apply after a sexual assault."
          : " The program may waive it after a sexual assault."
        : "";
      return {
        use: "decides",
        text: `Decides: the minimum loss, ${parts.length ? parts.join(" or ") : "with no set amount"}.${waiver}`,
      };
    }
    case "collateral":
      return { use: "decides", text: "Decides: insurance and other payments come off first." };
    case "info":
      return { use: "info", text: "Shown for information. The engine does not use it in the math." };
    default:
      return { use: "decides", text: `Compiled as ${ir.kind.replace(/_/g, " ")}.` };
  }
}

// The normalizer's reasons, in plain words, with the original kept in view.
export function skipReason(reason: string): string {
  let m = reason.match(/^less generous duplicate of (\S+)$/);
  if (m) return `a more generous limit for the same cost, ${m[1]}, is used instead. This one is kept beside it.`;
  m = reason.match(/^applies_to "(.+)"$/);
  if (m) return `it applies only to ${m[1]}. The engine does not check that, so it leaves this rule out of the math.`;
  if (/^expense_cap without amount or expense$/.test(reason)) {
    return "it names a limit without an amount or without a kind of cost, so there is nothing to compute.";
  }
  return reason;
}

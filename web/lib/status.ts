import type { EngineChecks, LineStatus } from "./types";

export interface StatusCopy {
  label: string;
  // One plain sentence shown under the citation sheet title.
  explain: string;
  sheetTitle: string;
}

export const STATUS: Record<LineStatus, StatusCopy> = {
  eligible: {
    label: "Eligible",
    explain: "The law names this kind of cost. It counts toward the amount you can ask for.",
    sheetTitle: "Why this can be claimed",
  },
  held: {
    label: "Held",
    explain:
      "The law says you should not be billed for this. Do not pay it. Tend routes it to the exam payment program.",
    sheetTitle: "Why this bill is held",
  },
  excluded: {
    label: "Excluded",
    explain: "The law says the program does not pay for this kind of cost.",
    sheetTitle: "Why this is excluded",
  },
  needs_confirmation: {
    label: "Needs confirmation",
    explain: "Tend guessed what this is. It is not counted until you say yes.",
    sheetTitle: "The rule that would apply",
  },
  unknown_rule: {
    label: "Not included",
    explain:
      "None of this state's verified rules name this kind of cost, so Tend leaves it out. An advocate or the program can tell you if it is covered.",
    sheetTitle: "Why this is not included",
  },
  out_of_window: {
    label: "Before the date",
    explain: "This happened before the date you gave, so it is not counted.",
    sheetTitle: "Why this is not counted",
  },
};

export function statusCopy(status: string): StatusCopy {
  return STATUS[status as LineStatus] ?? { label: status, explain: "", sheetTitle: "Rules" };
}

type CheckCopy = Record<string, { label: string; tone: "good" | "warn" | "neutral" }>;

export const DEADLINE: CheckCopy = {
  ok: { label: "On time", tone: "good" },
  late: { label: "Past the deadline", tone: "warn" },
  unknown: { label: "Ask the program", tone: "neutral" },
};

export const MINIMUM_LOSS: CheckCopy = {
  met: { label: "Met", tone: "good" },
  waived: { label: "Waived", tone: "good" },
  may_be_waived: { label: "May be waived", tone: "neutral" },
  not_met: { label: "Not met yet", tone: "warn" },
  unknown: { label: "Depends on days of work missed", tone: "neutral" },
};

export const REPORTING: CheckCopy = {
  satisfied: { label: "Satisfied", tone: "good" },
  required: { label: "A police report is required", tone: "warn" },
  unknown: { label: "Depends on your answers", tone: "neutral" },
  not_required: { label: "No police report needed", tone: "good" },
};

export function checkCopy(table: CheckCopy, status: string) {
  return table[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as const };
}

// With no reporting rule the engines say "satisfied"; the label should not suggest a rule was met.
export function reportingCopy(c: EngineChecks["reporting"]) {
  return c.status === "satisfied" && !c.rule_ids.length
    ? { label: "No rule found", tone: "neutral" as const }
    : checkCopy(REPORTING, c.status);
}

export type CheckKey = keyof EngineChecks;

// Flags look like "rate_unverified:MI-CAP-9".
export function parseFlag(flag: string): { kind: string; ruleId: string | null } {
  const i = flag.indexOf(":");
  return i === -1 ? { kind: flag, ruleId: null } : { kind: flag.slice(0, i), ruleId: flag.slice(i + 1) };
}

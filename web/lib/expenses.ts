import type { ItemExpense } from "./types";

interface ExpenseCopy {
  label: string;
  // Asked when the scan inferred the category and the survivor has not confirmed it.
  question: string;
}

const COPY: Record<ItemExpense, ExpenseCopy> = {
  medical: { label: "Medical care", question: "Was this care you needed afterward?" },
  forensic_exam: { label: "Forensic exam", question: "Was this for the forensic exam?" },
  counseling: { label: "Counseling", question: "Was this a counseling session for you?" },
  lost_wages: { label: "Lost pay", question: "Did you miss this work to recover or get care?" },
  transportation: { label: "Rides to care", question: "Was this ride to care?" },
  relocation: { label: "Moving", question: "Was this part of moving somewhere safer?" },
  temporary_housing: { label: "Temporary housing", question: "Was this a place to stay for your safety?" },
  security: { label: "Home security", question: "Was this to make your home safer?" },
  crime_scene_cleanup: { label: "Cleanup", question: "Was this cleanup after what happened?" },
  childcare: { label: "Child care", question: "Was this child care while you got care or recovered?" },
  property_replacement: { label: "Replaced belongings", question: "Did this replace something you lost?" },
  clothing_bedding: {
    label: "Clothing and bedding",
    question: "Did this replace clothing or bedding kept as evidence?",
  },
  prescription: { label: "Prescriptions", question: "Was this medicine you needed afterward?" },
  dental: { label: "Dental care", question: "Was this dental care you needed afterward?" },
  funeral: { label: "Funeral costs", question: "Was this a funeral cost?" },
  legal: { label: "Legal help", question: "Was this legal help you needed afterward?" },
  tuition: { label: "School costs", question: "Was this a school cost you had because of this?" },
  other: { label: "Other costs", question: "Is this cost related?" },
  unknown: { label: "Not sorted yet", question: "Is this cost related?" },
};

// Bed order on the ledger: the costs people usually have first.
const ORDER: ItemExpense[] = [
  "medical",
  "forensic_exam",
  "counseling",
  "prescription",
  "dental",
  "transportation",
  "lost_wages",
  "security",
  "relocation",
  "temporary_housing",
  "childcare",
  "clothing_bedding",
  "property_replacement",
  "crime_scene_cleanup",
  "legal",
  "tuition",
  "funeral",
  "other",
  "unknown",
];

export function expenseLabel(expense: string): string {
  return COPY[expense as ItemExpense]?.label ?? expense.replace(/_/g, " ");
}

export function expenseQuestion(expense: string): string {
  return COPY[expense as ItemExpense]?.question ?? COPY.unknown.question;
}

export function expenseRank(expense: string): number {
  const i = ORDER.indexOf(expense as ItemExpense);
  return i === -1 ? ORDER.length : i;
}

// What a unit means for each per-unit cap (SPEC: weeks, sessions, miles).
export function unitLabel(expense: string, units: number): string | null {
  if (units <= 0) return null;
  const plural = units === 1 ? "" : "s";
  if (expense === "lost_wages") return `${units} week${plural}`;
  if (expense === "counseling") return `${units} session${plural}`;
  if (expense === "transportation") return `${units} mile${plural}`;
  return `${units} unit${plural}`;
}

import type { RuleCategory } from "./types";

export const CATEGORY_LABEL: Record<RuleCategory, string> = {
  exam_no_bill: "You should not be billed for the exam",
  exam_payment: "Who pays for the exam",
  covered_expense: "Costs the program covers",
  expense_cap: "Limits on a kind of cost",
  total_cap: "Total limit",
  excluded_expense: "Costs the program does not cover",
  collateral_source: "Insurance and other payments come first",
  filing_deadline: "Deadline to apply",
  submission: "How to send a claim",
  required_document: "Documents the program asks for",
  processing_time: "How long a decision takes",
  reporting_requirement: "Reporting to police",
  minimum_loss: "Minimum loss",
  emergency_award: "Emergency awards",
  eligible_crime: "Who can apply",
  residency: "Where you live and where it happened",
  conduct_reduction: "How the program reviews a claim",
};

// Law view order: what helps a survivor first, the program's own review last.
export const CATEGORY_ORDER: RuleCategory[] = [
  "exam_no_bill",
  "exam_payment",
  "covered_expense",
  "expense_cap",
  "total_cap",
  "excluded_expense",
  "collateral_source",
  "filing_deadline",
  "submission",
  "required_document",
  "processing_time",
  "reporting_requirement",
  "minimum_loss",
  "emergency_award",
  "eligible_crime",
  "residency",
  "conduct_reduction",
];

export function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c as RuleCategory] ?? c.replace(/_/g, " ");
}

// Where and how to send a claim (submission rules), and the two protections that keep a survivor
// anonymous with the state: the address confidentiality program and the law that keeps claim
// files confidential. All of it comes from verified rules, each with its quote.
import type { FilingRoute } from "../contracts";
import type { Rule } from "../types";
import { param, type LawBook } from "./law";

const METHODS: FilingRoute["method"][] = ["online", "email", "mail", "fax", "in_person"];

export const METHOD_LABEL: Record<FilingRoute["method"], string> = {
  online: "Online",
  email: "Email",
  mail: "Mail",
  fax: "Fax",
  in_person: "In person",
};

export function filingRoutes(law: LawBook): FilingRoute[] {
  const seen = new Set<string>();
  const routes: (FilingRoute & { order: number })[] = [];
  law.byCategory("submission").forEach((r, order) => {
    const method = param<string>(r, "method") as FilingRoute["method"] | undefined;
    const target = param<string>(r, "target");
    if (!method || !METHODS.includes(method) || typeof target !== "string" || !target.trim()) return;
    const key = `${method}|${target.trim().toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, target: target.trim(), rule_id: r.id, order });
  });
  return routes
    .sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method) || a.order - b.order)
    .map(({ method, target, rule_id }) => ({ method, target, rule_id }));
}

export interface AddressProgram {
  rule: Rule;
  program_name: string | null;
  agency: string | null;
  covers_sexual_assault: boolean | null;
  enroll: string | null;
}

export interface PrivacyNotes {
  address: AddressProgram[];
  records: Rule[];
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function privacyNotes(law: LawBook): PrivacyNotes {
  return {
    address: law.byCategory("address_confidentiality").map((rule) => ({
      rule,
      program_name: text(param(rule, "program_name")),
      agency: text(param(rule, "agency")),
      covers_sexual_assault:
        typeof param(rule, "covers_sexual_assault") === "boolean"
          ? (param<boolean>(rule, "covers_sexual_assault") ?? null)
          : null,
      enroll: text(param(rule, "enroll")),
    })),
    records: law.byCategory("record_confidentiality"),
  };
}

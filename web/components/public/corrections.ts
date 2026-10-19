// The public correction path for the law pages, and the dates their sources were saved.
import { LINKS } from "@/components/tour/links";
import type { Source } from "@/lib/types";

// TODO(Sanat): choose the address that takes corrections by email, for people without a GitHub
// account. While this is empty, the state and law pages show no email line.
export const CORRECTIONS_EMAIL: string = "";

// The issue form in .github/ISSUE_TEMPLATE/law-error.yml, with the jurisdiction and the page filled in.
// Field ids are the query keys. Nothing else goes in the link, so it says nothing about who opened it.
export function reportErrorUrl(st: string, page: string): string {
  const query = new URLSearchParams({ template: "law-error.yml", jurisdiction: st, page_url: page });
  return `${LINKS.repo}/issues/new?${query}`;
}

// The first and last day (UTC, YYYY-MM-DD) Tend saved any of these sources. verify.py checks every quote
// against those saved copies; nothing re-reads the live pages after that.
export function savedDays(sources: Pick<Source, "retrieved_at">[]): { first: string; last: string } | null {
  const days = sources
    .map((s) => new Date(s.retrieved_at))
    .filter((d) => !Number.isNaN(d.getTime()))
    .map((d) => d.toISOString().slice(0, 10))
    .sort();
  return days.length ? { first: days[0], last: days[days.length - 1] } : null;
}

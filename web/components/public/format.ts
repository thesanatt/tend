// Small display helpers shared by the public pages.

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isPdf(url: string | undefined, rawPath?: string): boolean {
  return Boolean(rawPath?.endsWith(".pdf") || /\.pdf($|[?#])/i.test(url ?? ""));
}

// "Oct 3, 2026" in UTC, so a build anywhere prints the same date.
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    d,
  );
}

export function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// The vault and the share module say what went wrong with a code. The survivor reads it in their own
// language; the modules' English messages are never shown as they are.
import type { Dict } from "@/lib/i18n";

export function codeOf(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

function pick<T extends Record<string, string>>(table: T, err: unknown): string {
  const code = codeOf(err);
  return code !== null && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : table.other;
}

export const saveProblem = (err: unknown, t: Dict) => pick(t.vault.saveProblem, err);
export const openProblem = (err: unknown, t: Dict) => pick(t.vault.openProblem, err);
export const shareProblem = (err: unknown, t: Dict) => pick(t.share.problem, err);

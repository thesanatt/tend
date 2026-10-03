// Reads a bank statement file on the device: CSV, OFX or QFX, or PDF. Nothing is uploaded.
import { parseCsv } from "./csv";
import { fetchNessie, fromNessieRelay } from "./nessie";
import { looksLikeOfx, parseOfx } from "./ofx";
import { isPdf } from "./pdf";
import { parsePdfStatement } from "./statement-pdf";
import type { LocalStatementParser, StatementResult } from "./types";

export const MAX_STATEMENT_BYTES = 25 * 1024 * 1024;

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Older exports are Windows-1252; a run of replacement characters gives that away.
  if ((utf8.match(/\ufffd/g) ?? []).length > 3) return new TextDecoder("windows-1252").decode(bytes);
  return utf8;
}

export function parseStatementText(text: string): StatementResult {
  return looksLikeOfx(text) ? parseOfx(text) : parseCsv(text);
}

export async function parseStatementBytes(bytes: Uint8Array): Promise<StatementResult> {
  if (bytes.byteLength > MAX_STATEMENT_BYTES)
    return {
      txns: [],
      warnings: ["This file is too large to read. Try one month at a time."],
      format: "csv",
      layout: "unknown",
    };
  if (isPdf(bytes)) {
    try {
      return await parsePdfStatement(bytes);
    } catch {
      return { txns: [], warnings: ["This PDF could not be opened."], format: "pdf", layout: "unknown" };
    }
  }
  return parseStatementText(decodeText(bytes));
}

export const statementParser: LocalStatementParser = {
  async parse(file) {
    return parseStatementBytes(new Uint8Array(await file.arrayBuffer()));
  },
  parseText: parseStatementText,
  parseBytes: parseStatementBytes,
  fromNessie: fromNessieRelay,
  fetchNessie,
};

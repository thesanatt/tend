// Sample files built in the browser from fictional data, so anyone can try every step without a
// real statement or bill. The files go through the same on-device readers as real ones.
import type { StatementTxn } from "@/lib/contracts";
import {
  ROWAN_ACCOUNT,
  ROWAN_BANK_BILL,
  ROWAN_OPENING_CENTS,
  ROWAN_ROWS,
  SAMPLE_BILL_BASE64,
  SAMPLE_BILL_NAME,
} from "./rowan";

export const SAMPLE_STATEMENT_NAME = "sample-statement-fictional.csv";
export { ROWAN_ACCOUNT, SAMPLE_BILL_NAME };

const OUT = new Set(["purchase", "withdrawal", "transfer", "bill"]);

function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const csvCell = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// A plain bank export: money out is negative, as most banks write it.
export function sampleStatementCsv(): string {
  let balance = ROWAN_OPENING_CENTS;
  const lines = ["Date,Description,Amount,Balance"];
  for (const [date, kind, cents, merchant, description] of ROWAN_ROWS) {
    const signed = OUT.has(kind) ? -cents : cents;
    balance += signed;
    const text = merchant ? `${merchant} - ${description}` : description;
    lines.push([usDate(date), csvCell(text), dollars(signed), dollars(balance)].join(","));
  }
  return lines.join("\n") + "\n";
}

export function sampleStatementFile(): File {
  return new File([sampleStatementCsv()], SAMPLE_STATEMENT_NAME, { type: "text/csv" });
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sampleBillFile(): File {
  return new File([base64Bytes(SAMPLE_BILL_BASE64) as BlobPart], SAMPLE_BILL_NAME, { type: "application/pdf" });
}

// The same fictional account as the demo bank holds it in Nessie, used when Tend is not connected
// to the bank relay. The pending hospital bill is one transaction; its itemized statement explains it.
export function demoBankTxns(): { txns: StatementTxn[]; billIds: string[] } {
  const txns: StatementTxn[] = ROWAN_ROWS.map(([date, kind, cents, merchant, description], i) => ({
    id: `rowan-${i + 1}`,
    date,
    amount_cents: OUT.has(kind) ? cents : -cents,
    description,
    merchant: merchant || undefined,
    origin: "nessie" as const,
  }));
  txns.push({
    id: ROWAN_BANK_BILL.id,
    date: ROWAN_BANK_BILL.date,
    amount_cents: ROWAN_BANK_BILL.amount_cents,
    description: "hospital statement",
    merchant: ROWAN_BANK_BILL.payee,
    origin: "nessie",
  });
  return { txns, billIds: [ROWAN_BANK_BILL.id] };
}

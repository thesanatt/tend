// Writes Rowan's fictional checking statement as a bank-style PDF, the same file "Use a sample
// statement" builds in the browser (components/flow/samples/statement-pdf.ts), and checks that the
// on-device reader gets the same transactions back from the PDF as from the CSV. Run from web/:
//   npx tsx scripts/make-demo-statement.mts [out.pdf]
import { writeFileSync } from "node:fs";
import { pdfLines } from "../lib/local/pdf";
import { parseStatementBytes } from "../lib/local/statement";
import { sampleStatementCsv, sampleStatementPdf } from "../components/flow/samples/index";

const out = process.argv[2] ?? "rowan-checking-statement-FICTIONAL.pdf";
const bytes = await sampleStatementPdf();
writeFileSync(out, bytes);

const { pages } = await pdfLines(bytes);
const fromPdf = await parseStatementBytes(bytes);
const fromCsv = await parseStatementBytes(new TextEncoder().encode(sampleStatementCsv()));
const key = (t: { date: string; amount_cents: number }) => `${t.date} ${t.amount_cents}`;
const pdfKeys = fromPdf.txns.map(key).sort();
const csvKeys = fromCsv.txns.map(key).sort();
const same = pdfKeys.length === csvKeys.length && pdfKeys.every((k, i) => k === csvKeys[i]);
console.log(`wrote ${out}: ${pages} pages, ${bytes.length} bytes`);
console.log(`PDF read: ${fromPdf.txns.length} transactions (${fromPdf.format}, ${fromPdf.layout}); CSV: ${fromCsv.txns.length}; same dates and amounts: ${same}`);
if (fromPdf.warnings.length) console.log("warnings:", fromPdf.warnings.slice(0, 5));
if (!same) process.exit(1);

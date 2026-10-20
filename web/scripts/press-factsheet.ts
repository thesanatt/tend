// Writes the one-page fact sheet, public/press/tend-fact-sheet.pdf, from the facts /press shows
// (app/press/facts.ts), so the PDF and the page say the same thing. Run it from web/, where the facts
// find the site's data, whenever a fact or a count changes:
//   npx tsx scripts/press-factsheet.ts
// tests/press.test.tsx fails until the PDF in the repo matches what this writes.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildFactSheet } from "../app/press/factsheet";
import { FACT_SHEET, pressFile } from "../app/press/files";

// tsx runs this file as CommonJS, so the work is wrapped instead of using top-level await.
void (async () => {
  const { bytes } = await buildFactSheet();
  const out = pressFile(FACT_SHEET);
  writeFileSync(out, bytes);
  console.log(`wrote ${path.relative(process.cwd(), out)}: 1 page, ${bytes.length} bytes`);
})();

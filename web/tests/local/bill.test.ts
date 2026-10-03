import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBill } from "@/lib/local/bill";
import parity from "./fixtures/classify-parity.json";
import { FakeLanguageModel, install, uninstall } from "./fake-lm";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIX = path.join(import.meta.dirname, "fixtures");
const file = (p: string, type = "application/pdf") => new File([readFileSync(p)], path.basename(p), { type });

afterEach(() => uninstall());

describe("PDF bills read the same as api/tend_api/bill.py", () => {
  it.each(parity.bills.map((b) => [b.file, b] as const))("%s", async (_, b) => {
    const got = await readBill(file(path.join(ROOT, b.file)));
    expect(got.sha256).toBe(b.sha256);
    if ("refused" in b && b.refused) {
      expect(got.status).toBe("unreliable");
      expect(got.lines).toEqual([]);
      return;
    }
    const ref = b as Exclude<typeof b, { refused: string }> & {
      lines: {
        item_id: string;
        date: string;
        description: string;
        amount_cents: number;
        columns_cents: number[];
        expense: string;
      }[];
    };
    expect(
      got.lines.map((l) => ({
        id: l.line_id,
        date: l.date,
        description: l.description,
        cents: l.amount_cents,
        columns: l.columns_cents,
        expense: l.expense,
      })),
    ).toEqual(
      ref.lines.map((l) => ({
        id: l.item_id,
        date: l.date,
        description: l.description,
        cents: l.amount_cents,
        columns: l.columns_cents,
        expense: l.expense,
      })),
    );
    expect(got.provider).toBe(ref.provider);
    expect(got.total_cents).toBe(ref.total_cents ?? ref.amount_due_cents);
    expect(got.amount_due_cents).toBe(ref.amount_due_cents);
    expect(got.service_date).toBe(ref.service_date);
    expect(got.adjustments).toEqual(ref.adjustments);
    expect(got.source).toBe("rule");
    expect(got.format).toBe("pdf");
  });
});

describe("bill status", () => {
  it("is ok when the lines add up, and tags the exam line", async () => {
    const got = await readBill(file(path.join(FIX, "bill-lakeside.pdf")));
    expect(got).toMatchObject({
      status: "ok",
      sums_match: true,
      provider: "Lakeside Medical Center",
      total_cents: 103500,
      lines_sum_cents: 103500,
    });
    expect(got.lines.find((l) => l.expense === "forensic_exam")).toMatchObject({
      amount_cents: 90000,
      description: "Sexual assault medical forensic exam",
    });
    expect(got.fictional).toBe(true);
    expect(got.statement_date).toBe("2026-09-15");
  });

  it("is unreliable when the lines do not add up to the total", async () => {
    const got = await readBill(file(path.join(FIX, "bill-mismatch.pdf")));
    expect(got).toMatchObject({ status: "unreliable", sums_match: false, total_cents: 99900, lines_sum_cents: 95000 });
    expect(got.checks.find((c) => c.name === "lines_equal_total")?.ok).toBe(false);
    expect(got.warnings.join(" ")).toMatch(/do not add up/);
  });

  it("is unreliable for a picture-only PDF when no model can read it", async () => {
    const got = await readBill(file(path.join(FIX, "bill-scan-only.pdf")));
    expect(got).toMatchObject({ status: "unreliable", lines: [], total_cents: null });
    expect(got.warnings[0]).toMatch(/picture/);
  });

  it("reads a plain text bill with the same parser", async () => {
    const text = [
      "Fictional Test Clinic",
      "Statement date: 09/01/2026",
      "1  09/01/2026  Counseling intake session  $120.00",
      "2  09/01/2026  Dental x-ray  $80.00",
      "Payment received  $50.00",
      "Total  $200.00",
      "Amount due  $150.00",
    ].join("\n");
    const got = await readBill(new File([text], "bill.txt", { type: "text/plain" }));
    expect(got).toMatchObject({ status: "ok", format: "text", total_cents: 20000, amount_due_cents: 15000 });
    expect(got.adjustments).toEqual([{ label: "Payment received", amount_cents: 5000 }]);
    expect(got.lines.map((l) => l.expense)).toEqual(["counseling", "dental"]);
  });

  it("is unreliable when a bill states no total", async () => {
    const got = await readBill(new File(["1  09/01/2026  Clinic visit  $120.00"], "bill.txt", { type: "text/plain" }));
    expect(got).toMatchObject({ status: "unreliable", sums_match: false, total_cents: null });
  });
});

describe("bill photos go to Gemini Nano on the device", () => {
  const photo = () => file(path.join(FIX, "bill-photo.png"), "image/png");
  const answer = (o: object) => () => JSON.stringify(o);

  it("is ok when the copied lines add up to the copied total; the last column is what is owed", async () => {
    const fake = install(
      new FakeLanguageModel({
        answer: answer({
          provider: "Lakeside Medical Center",
          statement_date: "09/15/2026",
          amount_due: "$1,035.00",
          lines: [
            {
              date: "09/02/2026",
              description: "Emergency department visit, copay",
              amounts: ["$980.00", "$780.00", "$150.00", "$50.00"],
            },
            {
              date: "09/02/2026",
              description: "Sexual assault medical forensic exam",
              amounts: ["$900.00", "$0.00", "$0.00", "$900.00"],
            },
            { date: "09/02/2026", description: "Laboratory services", amounts: ["43.00"] },
            { date: "", description: "Pharmacy, medication", amounts: ["$42"] },
          ],
          totals: ["$2,137.00", "$912.00", "$190.00", "$1,035.00"],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got).toMatchObject({
      status: "ok",
      source: "device_ai",
      format: "image",
      total_cents: 103500,
      sums_match: true,
    });
    expect(got.lines.map((l) => [l.amount_cents, l.expense, l.date])).toEqual([
      [5000, "medical", "2026-09-02"],
      [90000, "forensic_exam", "2026-09-02"],
      [4300, "medical", "2026-09-02"],
      [4200, "medical", null],
    ]);
    expect(got.lines.every((l) => Number.isInteger(l.amount_cents))).toBe(true);
    expect(got.lines[0].columns_cents).toEqual([98000, 78000, 15000, 5000]);
    expect(got.service_date).toBe("2026-09-02");
    // The image went in as an image part, with the JSON schema as the constraint.
    const call = fake.prompts[0];
    const parts = (call.input as { content: { type: string; value: unknown }[] }[])[0].content;
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
    expect(parts[1].value).toBeInstanceOf(Blob);
    expect(call.options?.responseConstraint).toBeTruthy();
    expect(JSON.stringify(fake.creates[0])).toContain('"image"');
  });

  it("is unreliable when the model's numbers do not add up", async () => {
    install(
      new FakeLanguageModel({
        answer: answer({
          amount_due: "$500.00",
          totals: ["$500.00"],
          lines: [
            { description: "Clinic visit", amounts: ["$120.00"] },
            { description: "Lab", amounts: ["$80.00"] },
          ],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got).toMatchObject({ status: "unreliable", sums_match: false, lines_sum_cents: 20000, total_cents: 50000 });
  });

  it("is unreliable when a line's amount cannot be read, even if the rest add up", async () => {
    install(
      new FakeLanguageModel({
        answer: answer({
          amount_due: "$120.00",
          totals: ["$120.00"],
          lines: [
            { description: "Clinic visit", amounts: ["$120.00"] },
            { description: "Lab", amounts: ["about forty"] },
          ],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got.status).toBe("unreliable");
    expect(got.warnings.join(" ")).toMatch(/could not be read/);
  });

  it("is unreliable when the model copies the charges total instead of what is owed", async () => {
    install(
      new FakeLanguageModel({
        answer: answer({
          amount_due: "$443.00",
          totals: ["$2,445.00"],
          lines: [
            { description: "Emergency department visit, copay", amounts: ["$75.00"] },
            { description: "Medical forensic exam, deductible applied", amounts: ["$325.00"] },
            { description: "Laboratory services, coinsurance", amounts: ["$43.00"] },
          ],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got).toMatchObject({ status: "unreliable", lines_sum_cents: 44300, total_cents: 244500 });
    expect(got.checks).toEqual([
      { name: "lines_equal_total", ok: false },
      { name: "total_less_adjustments_equals_due", ok: false },
    ]);
  });

  it("a credit on a photo is an adjustment, not a line", async () => {
    install(
      new FakeLanguageModel({
        answer: answer({
          amount_due: "$100.00",
          totals: ["$150.00"],
          lines: [
            { description: "Clinic visit", amounts: ["$150.00"] },
            { description: "Payment received", amounts: ["($50.00)"] },
          ],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got).toMatchObject({ status: "ok", total_cents: 15000, amount_due_cents: 10000 });
    expect(got.adjustments).toEqual([{ label: "Payment received", amount_cents: 5000 }]);
  });

  it("says so plainly when the device has no model", async () => {
    install(new FakeLanguageModel({ availability: { image: "unavailable" } }));
    const got = await readBill(photo());
    expect(got).toMatchObject({ status: "unreliable", source: "rule", lines: [] });
    expect(got.warnings[0]).toMatch(/not ready/);
  });

  it("works with no LanguageModel at all", async () => {
    const got = await readBill(photo());
    expect(got.status).toBe("unreliable");
  });

  it("falls back to unreliable when the model answers with something that is not JSON", async () => {
    install(new FakeLanguageModel({ answer: () => "Sure! Here is the bill:" }));
    const got = await readBill(photo());
    expect(got).toMatchObject({ status: "unreliable", source: "device_ai", lines: [] });
  });
});

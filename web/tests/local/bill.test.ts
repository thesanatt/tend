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

  it("is ok when the copied lines add up to the copied total", async () => {
    const fake = install(
      new FakeLanguageModel({
        answer: answer({
          provider: "Lakeside Medical Center",
          statement_date: "09/15/2026",
          total: "$1,035.00",
          amount_due: "$1,035.00",
          lines: [
            { date: "09/02/2026", description: "Emergency department visit, copay", amount: "$50.00" },
            { date: "09/02/2026", description: "Sexual assault medical forensic exam", amount: "$900.00" },
            { date: "09/02/2026", description: "Laboratory services", amount: "43.00" },
            { date: "", description: "Pharmacy, medication", amount: "$42" },
          ],
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
          total: "$500.00",
          lines: [
            { description: "Clinic visit", amount: "$120.00" },
            { description: "Lab", amount: "$80.00" },
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
          total: "$120.00",
          lines: [
            { description: "Clinic visit", amount: "$120.00" },
            { description: "Lab", amount: "about forty" },
          ],
        }),
      }),
    );
    const got = await readBill(photo());
    expect(got.status).toBe("unreliable");
    expect(got.warnings.join(" ")).toMatch(/could not be read/);
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

import { describe, expect, it } from "vitest";
import type { BillReader, Classifier, StatementParser } from "@/lib/contracts";
import * as local from "@/lib/local";

describe("web/lib/local exports what the flow codes against", () => {
  it("statementParser, classifier, billReader, deviceAiStatus, startModelDownload", async () => {
    const parser: StatementParser = local.statementParser;
    const classifier: Classifier = local.classifier;
    const reader: BillReader = local.billReader;
    expect(typeof parser.parse).toBe("function");
    expect(typeof classifier.classify).toBe("function");
    expect(typeof classifier.deviceAi).toBe("function");
    expect(typeof reader.read).toBe("function");
    expect(await local.deviceAiStatus()).toBe("unavailable");
    expect(await local.startModelDownload()).toBe("unavailable");
    expect(typeof local.releaseDeviceAi).toBe("function");
  });

  it("a File goes in and contract-shaped rows come out", async () => {
    const file = new File(["Date,Description,Amount\n2026-06-17,Clearwater Counseling Group,-150.00\n"], "s.csv", {
      type: "text/csv",
    });
    const { txns, warnings } = await local.statementParser.parse(file);
    expect(warnings).toEqual(["Read negative amounts as money spent."]);
    const [item] = await local.classifier.classify(txns, { st: "MI", incident_date: "2026-06-14" });
    expect(Object.keys(item).sort()).toEqual(
      [
        "amount_cents",
        "confidence",
        "confirmed",
        "date",
        "description",
        "expense",
        "insurance_paid_cents",
        "is_bill",
        "item_id",
        "linked_item_ids",
        "method",
        "reason",
        "source",
        "tags",
        "unit",
        "units",
      ].sort(),
    );
  });
});

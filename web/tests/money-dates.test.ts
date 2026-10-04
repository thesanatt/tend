import { describe, expect, it } from "vitest";
import { addDays, addYears, describeSpan, formatDay, isIsoDay, localDay, todayIso } from "@/lib/dates";
import { assertCents, formatCents, formatCentsShort, parseDollars, sumCents } from "@/lib/money";

describe("money", () => {
  it("formats integer cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(139400)).toBe("$1,394.00");
    expect(formatCents(321425)).toBe("$3,214.25");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-32500)).toBe("-$325.00");
    expect(formatCentsShort(139400)).toBe("$1,394");
    expect(formatCentsShort(2340)).toBe("$23.40");
  });

  it("refuses anything that is not integer cents", () => {
    expect(() => assertCents(12.5)).toThrow();
    expect(() => formatCents(0.1)).toThrow();
    expect(() => sumCents([1, 2.5])).toThrow();
    expect(sumCents([118000, 21400])).toBe(139400);
  });

  it("parses typed dollar amounts", () => {
    expect(parseDollars("40")).toBe(4000);
    expect(parseDollars("$1,200.00")).toBe(120000);
    expect(parseDollars("12.5")).toBe(1250);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
  });
});

describe("dates", () => {
  it("validates ISO days", () => {
    expect(isIsoDay("2026-06-14")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("06/14/2026")).toBe(false);
  });

  it("adds calendar years and clamps Feb 29", () => {
    expect(addYears("2026-06-14", 5)).toBe("2031-06-14");
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-06-14", 365)).toBe("2027-06-14");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("describes a span for deadlines", () => {
    expect(describeSpan("2026-10-03", "2031-06-14")).toBe("4 years, 8 months");
    expect(describeSpan("2026-10-03", "2026-10-13")).toBe("10 days");
    expect(describeSpan("2026-10-03", "2025-01-01")).toBe("past");
  });

  it("formats days without time zone drift", () => {
    expect(formatDay("2026-06-14")).toBe("June 14, 2026");
    expect(formatDay("2026-06-14", "short")).toBe("Jun 14");
    expect(todayIso(new Date(2026, 9, 3, 23, 59))).toBe("2026-10-03");
  });
});

describe("a payment's day", () => {
  it("is the day on this device, not the UTC day of the timestamp", () => {
    const before = process.env.TZ;
    process.env.TZ = "America/Detroit";
    try {
      // 9:20 PM in Michigan on October 3 is already October 4 in UTC.
      expect(localDay("2026-10-04T01:20:00Z")).toBe("2026-10-03");
      expect(localDay("2026-10-04T16:30:00.000Z")).toBe("2026-10-04");
      expect(localDay("2026-10-03")).toBe("2026-10-03");
      expect(localDay("not a time")).toBe("not a time");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

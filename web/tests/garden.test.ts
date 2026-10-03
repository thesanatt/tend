import { describe, expect, it } from "vitest";
import { lawGrowth, lawStage, moneyGrowth, moneyStage, plantShape } from "@/lib/garden";

describe("law garden stages", () => {
  it("grows with the number of verified rules", () => {
    expect([0, 1, 14, 15, 24, 25, 34, 35, 51].map(lawStage)).toEqual([
      "seed",
      "sprout",
      "sprout",
      "leaf",
      "leaf",
      "bud",
      "bud",
      "bloom",
      "bloom",
    ]);
  });

  it("keeps growth inside each stage between 0 and 1", () => {
    for (const n of [0, 1, 10, 15, 30, 48, 120]) {
      const g = lawGrowth(n);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
    expect(lawGrowth(34)).toBeGreaterThan(lawGrowth(25));
  });
});

describe("survivor garden stages", () => {
  it("only grows once money is confirmed, then follows receipt, filing, payment", () => {
    expect(moneyStage(false, undefined)).toBeNull();
    expect(moneyStage(true, undefined)).toBe("sprout");
    expect(moneyStage(true, { receipt: "r.pdf" })).toBe("leaf");
    expect(moneyStage(true, { receipt: "r.pdf", filed_at: "2026-10-03" })).toBe("bud");
    expect(moneyStage(true, { filed_at: "2026-10-03", paid_at: "2026-11-01" })).toBe("bloom");
  });

  it("sizes plants by amount on a log scale", () => {
    expect(moneyGrowth(2340)).toBeLessThan(moneyGrowth(118000));
    expect(moneyGrowth(100)).toBe(0);
    expect(moneyGrowth(1_000_000_000)).toBe(1);
  });
});

describe("plant drawing", () => {
  it("is deterministic per key and differs between keys", () => {
    expect(plantShape("bloom", 0.5, "MI")).toEqual(plantShape("bloom", 0.5, "MI"));
    expect(plantShape("bloom", 0.5, "MI")).not.toEqual(plantShape("bloom", 0.5, "NY"));
  });

  it("draws the parts each stage promises", () => {
    expect(plantShape("seed", 1, "k")).toMatchObject({ stem: null, leaves: [], petals: 0, bud: false });
    expect(plantShape("sprout", 1, "k")).toMatchObject({ cotyledons: true, bud: false, petals: 0 });
    expect(plantShape("bud", 1, "k").bud).toBe(true);
    expect(plantShape("bloom", 1, "k").petals).toBeGreaterThanOrEqual(5);
    const tall = plantShape("bloom", 1, "k").top.y;
    const short = plantShape("sprout", 1, "k").top.y;
    expect(tall).toBeLessThan(short);
  });

  it("stays inside the drawing box", () => {
    for (const stage of ["sprout", "leaf", "bud", "bloom"] as const) {
      for (const key of ["AK", "MI", "TX", "DC"]) {
        const s = plantShape(stage, 1, key);
        expect(s.top.y).toBeGreaterThan(10);
        for (const leaf of s.leaves) expect(leaf.x).toBeGreaterThan(5);
      }
    }
  });
});

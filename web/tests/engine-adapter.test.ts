import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDataModeForTests } from "@/lib/api";
import { evaluateClaim, toEngineInput } from "@/lib/engine";
import type { EngineInput, ScanResult } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const lawBytes = readFileSync(path.join(web, "public/data/law/MI.json"));
const fixtureOut = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.output.json"), "utf8"));
const scan = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.scan.json"), "utf8")) as ScanResult;

const input: EngineInput = {
  jurisdiction: "MI",
  context: { incident_date: scan.incident_date, as_of_date: scan.as_of_date, police_report: "no", forensic_exam: true },
  items: scan.items,
};

type Route = (init?: RequestInit) => Response | Promise<Response>;

function stubFetch(routes: Record<string, Route>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes[url];
    return route
      ? route(init)
      : new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => resetDataModeForTests());
afterEach(() => vi.unstubAllGlobals());

describe("engine adapter", () => {
  it("strips scan extras so engines see only SPEC fields", () => {
    const clean = toEngineInput(input);
    for (const it of clean.items) {
      expect(Object.keys(it).sort()).toEqual(
        [
          "amount_cents",
          "confirmed",
          "date",
          "description",
          "expense",
          "insurance_paid_cents",
          "is_bill",
          "item_id",
          "units",
        ].sort(),
      );
    }
  });

  it("falls back to the labeled preview when there is no engine build and no API", async () => {
    stubFetch({ "/data/law/MI.json": () => new Response(lawBytes, { status: 200 }) });
    const result = await evaluateClaim(input);
    expect(result.backend).toBe("preview");
    expect(result.output).toEqual(fixtureOut);
  });

  it("uses the API when it answers, and reports which engine ran", async () => {
    const fetch = stubFetch({
      "/api/jurisdictions": () => json([{ st: "MI", name: "Michigan", rule_count: 48, source_count: 17 }]),
      "/api/claim": () => json({ ...fixtureOut, claim_id: "c-1" }, { "x-tend-engine": "refengine" }),
    });
    const result = await evaluateClaim(input);
    expect(result).toMatchObject({ backend: "api", detail: "refengine" });
    expect(result.output.claim_id).toBe("c-1");
    const [, init] = fetch.mock.calls.find(([u]) => u === "/api/claim")!;
    expect(JSON.parse(String(init?.body))).toEqual(toEngineInput(input));
  });

  it("says why it fell back when the API engine fails", async () => {
    stubFetch({
      "/api/jurisdictions": () => json([{ st: "MI", name: "Michigan", rules: 48, sources: 17 }]),
      "/api/claim": () => new Response("boom", { status: 500 }),
      "/data/law/MI.json": () => new Response(lawBytes, { status: 200 }),
    });
    const result = await evaluateClaim(input);
    expect(result.backend).toBe("preview");
    expect(result.detail).toMatch(/claim failed: 500/);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDataModeForTests } from "@/lib/api";
import { EngineUnavailableError, evaluateClaim, toEngineInput } from "@/lib/engine";
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

  it("passes the v1.2 unit and tags through when the caller has them", () => {
    const withUnits = {
      ...input,
      items: [{ ...input.items[0], unit: "session", tags: ["phone"] } as EngineInput["items"][number]],
    };
    const item = toEngineInput(withUnits).items[0] as unknown as Record<string, unknown>;
    expect(item.unit).toBe("session");
    expect(item.tags).toEqual(["phone"]);
  });

  it("has no third engine: without WebAssembly or the API it says the engine is unavailable", async () => {
    stubFetch({ "/data/law/MI.json": () => new Response(lawBytes, { status: 200 }) });
    const err = await evaluateClaim(input, { allowApi: true }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(err.serverAvailable).toBe(false);
  });

  it("never sends the claim to the server without the survivor's yes", async () => {
    const fetch = stubFetch({
      "/api/jurisdictions": () => json([{ st: "MI", name: "Michigan", rule_count: 48, source_count: 17 }]),
      "/api/claim": () => json(fixtureOut, { "x-tend-engine": "native" }),
    });
    const err = await evaluateClaim(input).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(err.serverAvailable).toBe(true);
    expect(fetch.mock.calls.some(([u]) => u === "/api/claim")).toBe(false);
  });

  it("uses the API with the survivor's yes, and reports which engine ran", async () => {
    const fetch = stubFetch({
      "/api/jurisdictions": () => json([{ st: "MI", name: "Michigan", rule_count: 48, source_count: 17 }]),
      "/api/claim": () => json({ ...fixtureOut, claim_id: "c-1" }, { "x-tend-engine": "refengine" }),
    });
    const result = await evaluateClaim(input, { allowApi: true });
    expect(result).toMatchObject({ backend: "api", detail: "refengine" });
    expect(result.output.claim_id).toBe("c-1");
    const [, init] = fetch.mock.calls.find(([u]) => u === "/api/claim")!;
    expect(JSON.parse(String(init?.body))).toEqual(toEngineInput(input));
  });

  it("says why when the API engine fails, instead of guessing", async () => {
    stubFetch({
      "/api/jurisdictions": () => json([{ st: "MI", name: "Michigan", rules: 48, sources: 17 }]),
      "/api/claim": () => new Response("boom", { status: 500 }),
    });
    const err = await evaluateClaim(input, { allowApi: true }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(err.message).toMatch(/claim failed: 500/);
  });
});

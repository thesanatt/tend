// @vitest-environment jsdom
// docs/SPEC.md v1.3: the engine's as_of_date is today in the state's own time (its westernmost zone),
// and a deadline that may count from discovery is explained, never shown as plainly late.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckScreen from "@/components/flow/check/CheckScreen";
import { buildCheckSummary } from "@/components/flow/checkSummary";
import { FlowProvider, useFlow } from "@/components/flow/FlowProvider";
import { EMPTY_CHECK } from "@/components/flow/state";
import { formatters, I18nProvider } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { es } from "@/lib/i18n/es";
import { STANDARD_OFFSET_HOURS, STATE_EAST_TIME_ZONES, STATE_TIME_ZONES, stateToday } from "@/lib/stateTime";
import type { EngineInput } from "@/lib/types";
import { MI_CHECK, MI_LAW, michiganOutput, renderFlow, stateFrom, stubLawFetch, testServices } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/check",
}));

// 1:30 AM on Oct 4 in Detroit; 7:30 PM on Oct 3 in Honolulu.
const LATE_NIGHT = new Date("2026-10-04T05:30:00Z");

describe("today in the state's own time", () => {
  it("covers all 51 jurisdictions with zones this runtime knows", () => {
    expect(Object.keys(STATE_TIME_ZONES)).toHaveLength(51);
    for (const zone of Object.values(STATE_TIME_ZONES)) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
      expect(STANDARD_OFFSET_HOURS[zone]).toBeTypeOf("number");
    }
  });

  it("counts a late night in the state, not in Detroit", () => {
    // A device on Honolulu's date, the earliest of all: every state's westernmost date.
    const got = Object.fromEntries(
      ["HI", "AK", "CA", "AZ", "TX", "NY", "MI", "IL"].map((st) => [st, stateToday(st, LATE_NIGHT, "2026-10-03")]),
    );
    expect(got).toEqual({
      HI: "2026-10-03",
      AK: "2026-10-03",
      CA: "2026-10-03",
      AZ: "2026-10-03",
      TX: "2026-10-03",
      NY: "2026-10-04",
      MI: "2026-10-04",
      IL: "2026-10-04",
    });
    // 12:30 AM in Detroit is 11:30 PM in Michigan's Central time counties: still the day before there.
    expect(stateToday("mi", new Date("2026-10-04T04:30:00Z"), "2026-10-03")).toBe("2026-10-03");
  });

  it("keeps the device's date when the state is on it, so today is never in the future", () => {
    const detroit = new Date("2026-10-04T04:30:00Z"); // 12:30 AM in Detroit, 11:30 PM in Menominee
    // A survivor in Detroit just after midnight: today is Oct 4 there, and the Check must accept it.
    expect(stateToday("MI", detroit, "2026-10-04")).toBe("2026-10-04");
    // The same moment on a device in Menominee.
    expect(stateToday("MI", detroit, "2026-10-03")).toBe("2026-10-03");
    // Houston at 12:30 AM CDT; El Paso is still on Oct 3.
    const houston = new Date("2026-10-04T05:30:00Z");
    expect(stateToday("TX", houston, "2026-10-04")).toBe("2026-10-04");
    // Anchorage at 12:30 AM AKDT; Adak is still on Oct 3.
    const anchorage = new Date("2026-10-04T08:30:00Z");
    expect(stateToday("AK", anchorage, "2026-10-04")).toBe("2026-10-04");
    // Arizona in summer: the Navajo Nation keeps daylight time, an hour ahead of Phoenix.
    const window = new Date("2026-07-01T06:30:00Z"); // 12:30 AM MDT, 11:30 PM MST
    expect(stateToday("AZ", window, "2026-07-01")).toBe("2026-07-01");
    // In winter both are on MST: there is no hour when the state is on two dates.
    expect(stateToday("AZ", new Date("2026-01-15T06:30:00Z"), "2026-01-15")).toBe("2026-01-14");
  });

  it("uses the westernmost date for a device whose date the state is not on", () => {
    // A device in Detroit at 1:30 AM looking at Hawaii, California, or Texas: the state's own date.
    expect(stateToday("HI", LATE_NIGHT, "2026-10-04")).toBe("2026-10-03");
    expect(stateToday("CA", LATE_NIGHT, "2026-10-04")).toBe("2026-10-03");
    expect(stateToday("TX", new Date("2026-10-04T06:30:00Z"), "2026-10-05")).toBe("2026-10-04");
    // A device behind the state (Honolulu looking at New York) moves forward to the state's date.
    expect(stateToday("NY", LATE_NIGHT, "2026-10-03")).toBe("2026-10-04");
    // A device two days off, or a wrong clock, never moves the date outside the state's.
    expect(stateToday("MI", LATE_NIGHT, "2026-10-06")).toBe("2026-10-04");
  });

  it("names an eastern zone only for states that span several, each one the runtime knows", () => {
    for (const [st, zone] of Object.entries(STATE_EAST_TIME_ZONES)) {
      expect(STATE_TIME_ZONES[st]).toBeDefined();
      expect(zone).not.toBe(STATE_TIME_ZONES[st]);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
    }
  });

  it("falls back to standard time when the zone is unknown to the browser, which is never early", () => {
    const real = Intl.DateTimeFormat;
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: function () {
        throw new RangeError("Invalid time zone");
      },
    });
    try {
      // 12:30 AM CDT on July 1 is 11:30 PM CST on June 30.
      expect(stateToday("IL", new Date("2026-07-01T05:30:00Z"), "2026-07-01")).toBe("2026-06-30");
      expect(stateToday("HI", LATE_NIGHT, "2026-10-04")).toBe("2026-10-03");
      // A state that spans zones keeps its westernmost date when the browser cannot name its zones.
      expect(stateToday("MI", new Date("2026-10-04T04:30:00Z"), "2026-10-04")).toBe("2026-10-03");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(Intl.DateTimeFormat).toBe(real);
  });

  it("keeps the device's date before a state is chosen", () => {
    const noon = new Date(2026, 9, 3, 12, 0); // local noon
    expect(stateToday("", noon)).toBe("2026-10-03");
    expect(stateToday("ZZ", noon)).toBe("2026-10-03");
  });
});

describe("the flow's engine input", () => {
  beforeEach(() => {
    stubLawFetch();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LATE_NIGHT);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function Probe() {
    const { input, today } = useFlow();
    return (
      <output data-testid="probe">
        {today} {input?.context.as_of_date ?? "none"}
      </output>
    );
  }

  it("dates the claim in the chosen state's time", () => {
    const evaluate = vi.fn(async (input: EngineInput) => ({
      output: michiganOutput(input),
      backend: "wasm" as const,
      detail: "test",
    }));
    const hawaii = stateFrom([{ type: "check", patch: { st: "HI", date: "2025-04-11", exam: "yes", police: "no" } }]);
    render(
      <I18nProvider initial="en">
        <FlowProvider services={testServices({ evaluate })} initial={hawaii}>
          <Probe />
        </FlowProvider>
      </I18nProvider>,
    );
    // Detroit time would say October 4, a day early for a Hawaii deadline.
    expect(screen.getByTestId("probe").textContent).toBe("2026-10-03 2026-10-03");
    expect(evaluate.mock.calls[0][0].context.as_of_date).toBe("2026-10-03");
  });
});

describe("just after midnight on a device in the state's eastern zone", () => {
  const tz = process.env.TZ;
  beforeEach(() => {
    stubLawFetch();
    process.env.TZ = "America/Detroit";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T04:30:00Z")); // 12:30 AM in Detroit, 11:30 PM in Menominee
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("takes today's date, and today's bills count", async () => {
    const evaluate = vi.fn(async (input: EngineInput) => ({
      output: michiganOutput(input),
      backend: "wasm" as const,
      detail: "test",
    }));
    const tonight = stateFrom([{ type: "check", patch: { st: "MI", date: "2026-10-04", exam: "yes", police: "no" } }]);
    render(
      <I18nProvider initial="en">
        <FlowProvider services={testServices({ evaluate })} initial={tonight}>
          <CheckScreen />
        </FlowProvider>
      </I18nProvider>,
    );
    // The Michigan date the device is on: not in the future, and the engine counts bills dated today.
    expect(screen.queryByText(en.check.dateFuture)).toBeNull();
    expect(evaluate.mock.calls[0][0].context.as_of_date).toBe("2026-10-04");
  });
});

describe("a deadline that may count from discovery", () => {
  beforeEach(() => stubLawFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is a fact the Check summary keeps", () => {
    const out = michiganOutput({
      jurisdiction: "MI",
      context: { incident_date: "2020-01-01", as_of_date: "2026-10-03", police_report: "no", forensic_exam: true },
      items: [],
    });
    const flags = (status: "ok" | "late", list: string[]) => ({
      ...out,
      checks: { ...out.checks, deadline: { ...out.checks.deadline, status, flags: list } },
    });
    const answers = { ...EMPTY_CHECK, st: "MI", date: "2026-06-14", exam: "yes" as const, police: "not_yet" as const };
    expect(buildCheckSummary(MI_LAW, flags("late", ["deadline_from_discovery"]), answers, true).deadline).toMatchObject(
      {
        kind: "date",
        late: true,
        fromDiscovery: true,
        fromReport: false,
      },
    );
    expect(buildCheckSummary(MI_LAW, flags("ok", []), answers, true).deadline).toMatchObject({ fromDiscovery: false });
  });

  for (const lang of ["en", "es"] as const) {
    it(`is explained in the Check summary (${lang})`, async () => {
      const evaluate = vi.fn(async (input: EngineInput) => {
        const out = michiganOutput(input);
        const deadline = { ...out.checks.deadline, status: "late" as const, deadline_date: "2025-06-14" };
        Object.assign(deadline, { flags: ["deadline_from_discovery"] });
        return { output: { ...out, checks: { ...out.checks, deadline } }, backend: "wasm" as const, detail: "test" };
      });
      renderFlow(<CheckScreen />, { services: testServices({ evaluate }), initial: stateFrom([MI_CHECK], lang), lang });
      const dict = lang === "en" ? en : es;
      expect(await screen.findByText(dict.check.deadlineFromDiscovery)).toBeTruthy();
      // Late, but never plainly late: the usual-deadline wording and the note come together.
      expect(screen.getByText(dict.check.deadlineLate(formatters(lang).date("2025-06-14")))).toBeTruthy();
      expect(screen.queryByText(dict.check.deadlineFromReport)).toBeNull();
    });
  }

  it("uses the same plain words in English and Spanish, with no dashes", () => {
    expect(en.check.deadlineFromDiscovery).toBe(
      "This deadline may count from when the crime was discovered, which can be later than the date it happened. The program decides.",
    );
    expect(es.check.deadlineFromDiscovery.endsWith(es.common.programDecides)).toBe(true);
    for (const text of [en.check.deadlineFromDiscovery, es.check.deadlineFromDiscovery]) {
      expect(text).not.toMatch(/[–—!]/);
    }
  });
});

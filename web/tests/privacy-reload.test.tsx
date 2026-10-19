// @vitest-environment jsdom
// The privacy line stays true for the tab. A reload keeps what the tab sent, as the kind and the
// time only; the page's first HTML never says nothing left before it has looked; Exit this page
// forgets it all.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitControl } from "@/components/flow/ExitControl";
import { FlowProvider, useFlow } from "@/components/flow/FlowProvider";
import { keepSend, withKept } from "@/components/flow/keptSends";
import PrivacyLine from "@/components/flow/PrivacyLine";
import { navigation } from "@/components/QuickExit";
import { I18nProvider, type Lang } from "@/lib/i18n";
import { SENT_KEY } from "@/lib/keys";
import { MI_CHECK, stateFrom, stubLawFetch, testServices, TODAY } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/packet",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.exiting;
});

// One page of the flow: a fresh provider, as after a reload, with the privacy line and a handle on
// the flow for sending.
function page(lang: Lang = "en", extra?: ReactNode) {
  const box: { flow: ReturnType<typeof useFlow> | null } = { flow: null };
  function Grab() {
    box.flow = useFlow();
    return null;
  }
  render(
    <I18nProvider initial={lang}>
      <FlowProvider services={testServices()} today={TODAY} initial={stateFrom([MI_CHECK])}>
        <PrivacyLine />
        {extra}
        <Grab />
      </FlowProvider>
    </I18nProvider>,
  );
  return box;
}

const line = () => screen.getByRole("status").textContent;

function pay(flow: ReturnType<typeof useFlow>, id: string) {
  act(() => {
    flow.logSent({
      kind: "payment_setup",
      amount_cents: 11800,
      to: "Riverbend General Hospital",
      action_id: id,
      ref: `setup:${id}`,
    });
    flow.logSent({
      kind: "payment",
      amount_cents: 11800,
      to: "Riverbend General Hospital",
      action_id: id,
      ref: `pay:${id}`,
    });
  });
}

describe("the privacy line after a reload", () => {
  it("still says what this tab sent, and keeps only the kind and the time", () => {
    const flow = page().flow!;
    expect(line()).toBe("On this device. Nothing has left it.");
    pay(flow, "act_7f3a");
    act(() => flow.logSent({ kind: "share", ref: "share:tok_91c2" }));
    const after = "On this device, except what you chose to send: a payment and a locked share link.";
    expect(line()).toBe(after);

    // What the tab holds: the kinds and times, never the amount, the payee, or any id.
    const raw = sessionStorage.getItem(SENT_KEY)!;
    const kept = JSON.parse(raw) as { kind: string; at: string }[];
    expect(kept.map((k) => k.kind)).toEqual(["payment", "share"]);
    for (const k of kept) expect(Object.keys(k).sort()).toEqual(["at", "kind"]);
    for (const secret of ["11800", "118", "Riverbend", "act_7f3a", "tok_91c2"]) expect(raw).not.toContain(secret);

    // A reload: the flow starts over in memory, the tab remembers.
    cleanup();
    page();
    expect(line()).toBe(after);
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(
      sheet.getByText(/: a payment\. After a reload, this list keeps only what was sent and when\.$/),
    ).toBeTruthy();
    expect(sheet.getByText(/: a share link\. The packet was locked on this device first/)).toBeTruthy();
    expect(sheet.queryByText(/\$118\.00|Riverbend/)).toBeNull();
  });

  it("says it in Spanish too", () => {
    pay(page("es").flow!, "act_1");
    cleanup();
    page("es");
    expect(line()).toBe("En este dispositivo, salvo lo que decidiste enviar: un pago.");
  });

  it("keeps a payment that was started and not finished, and says a later one once", () => {
    const first = page().flow!;
    act(() =>
      first.logSent({ kind: "payment_setup", amount_cents: 11800, to: "Riverbend", action_id: "a1", ref: "setup:a1" }),
    );
    cleanup();
    const second = page().flow!;
    expect(line()).toBe("On this device, except what you chose to send: a payment you started.");
    pay(second, "a2");
    expect(line()).toBe("On this device, except what you chose to send: a payment and a payment you started.");
    cleanup();
    page();
    expect(line()).toBe("On this device, except what you chose to send: a payment and a payment you started.");
  });

  it("counts one send reported twice (by the screen and by the net log) once", () => {
    const flow = page().flow!;
    act(() => {
      flow.logSent({ kind: "share", ref: "share:s1", at: "2026-10-03T17:00:00.000Z" });
      flow.logSent({ kind: "share", ref: "share:s1", at: "2026-10-03T17:00:01.000Z" });
    });
    expect(JSON.parse(sessionStorage.getItem(SENT_KEY)!)).toEqual([{ kind: "share", at: "2026-10-03T17:00:00.000Z" }]);
    expect(
      withKept(
        [{ kind: "share", at: "2026-10-03T17:00:00.000Z", ref: "share:s1" }],
        [
          { kind: "share", at: "2026-10-03T17:00:00.000Z" },
          { kind: "bank", at: "2026-10-03T16:00:00.000Z" },
        ],
      ),
    ).toEqual([
      { kind: "bank", at: "2026-10-03T16:00:00.000Z", kept: true },
      { kind: "share", at: "2026-10-03T17:00:00.000Z", ref: "share:s1" },
    ]);
  });

  it("ignores anything else in its place in storage", () => {
    sessionStorage.setItem(
      SENT_KEY,
      JSON.stringify([{ kind: "payment", at: "x", amount_cents: 11800 }, { kind: "wire", at: "y" }, 3, null]),
    );
    page();
    expect(line()).toBe("On this device. Nothing has left it.");
  });

  it("never says nothing left in the page's first HTML, before it can look", () => {
    const html = renderToString(
      <I18nProvider initial="en">
        <FlowProvider services={testServices()} today={TODAY}>
          <PrivacyLine />
        </FlowProvider>
      </I18nProvider>,
    );
    expect(html).toContain("On this device.");
    expect(html).not.toContain("Nothing has left it");
  });
});

describe("Exit this page", () => {
  it("clears what the tab kept, and a reply that lands after it does not write it back", () => {
    const replace = vi.fn();
    const real = navigation.replace;
    navigation.replace = replace;
    try {
      pay(page("en", <ExitControl />).flow!, "a1");
      expect(sessionStorage.getItem(SENT_KEY)).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Exit this page" }));
      expect(replace).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
      keepSend({ kind: "share", at: new Date().toISOString(), ref: "share:late" });
      expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
    } finally {
      navigation.replace = real;
    }
  });
});

// @vitest-environment jsdom
// The privacy line stays true for the tab. A reload keeps what the tab sent, as the kind and the
// time only; the page's first HTML never says nothing left before it has looked; saved progress
// that is locked hides it; Exit this page forgets it all.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { MI_CHECK, stateFrom, stubLawFetch, testServices, TODAY, type TestServices } from "./helpers/flow";

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
// the flow for sending. Pass the same services to keep the same saved progress across pages.
function mount(lang: Lang = "en", extra?: ReactNode, services: TestServices = testServices()) {
  const box: { flow: ReturnType<typeof useFlow> | null } = { flow: null };
  function Grab() {
    box.flow = useFlow();
    return null;
  }
  render(
    <I18nProvider initial={lang}>
      <FlowProvider services={services} today={TODAY} initial={stateFrom([MI_CHECK])}>
        <PrivacyLine />
        {extra}
        <Grab />
      </FlowProvider>
    </I18nProvider>,
  );
  return box;
}

// The same page once it knows whether there is saved progress, which is when the line can name
// what the tab sent.
async function page(lang: Lang = "en", extra?: ReactNode, services?: TestServices) {
  const box = mount(lang, extra, services);
  await waitFor(() => expect(box.flow!.vault.status).not.toBe("checking"));
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
  it("still says what this tab sent, and keeps only the kind and the time", async () => {
    const flow = (await page()).flow!;
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
    await page();
    expect(line()).toBe(after);
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(
      sheet.getByText(/: a payment\. After a reload, this list keeps only what was sent and when\.$/),
    ).toBeTruthy();
    expect(sheet.getByText(/: a share link\. The packet was locked on this device first/)).toBeTruthy();
    expect(sheet.queryByText(/\$118\.00|Riverbend/)).toBeNull();
  });

  it("says it in Spanish too", async () => {
    pay((await page("es")).flow!, "act_1");
    cleanup();
    await page("es");
    expect(line()).toBe("En este dispositivo, salvo lo que decidiste enviar: un pago.");
  });

  it("keeps a payment that was started and not finished, and says a later one once", async () => {
    const first = (await page()).flow!;
    act(() =>
      first.logSent({ kind: "payment_setup", amount_cents: 11800, to: "Riverbend", action_id: "a1", ref: "setup:a1" }),
    );
    cleanup();
    const second = (await page()).flow!;
    expect(line()).toBe("On this device, except what you chose to send: a payment you started.");
    pay(second, "a2");
    expect(line()).toBe("On this device, except what you chose to send: a payment and a payment you started.");
    cleanup();
    await page();
    expect(line()).toBe("On this device, except what you chose to send: a payment and a payment you started.");
  });

  it("counts one send reported twice (by the screen and by the net log) once", async () => {
    const flow = (await page()).flow!;
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

  it("ignores anything else in its place in storage", async () => {
    sessionStorage.setItem(
      SENT_KEY,
      JSON.stringify([{ kind: "payment", at: "x", amount_cents: 11800 }, { kind: "wire", at: "y" }, 3, null]),
    );
    await page();
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

describe("the privacy line behind the lock", () => {
  const passphrase = "garden gate 41";

  it("says only what is always true while saved progress is locked, and names the sends once it opens", async () => {
    const services = testServices();
    const flow = (await page("en", undefined, services)).flow!;
    await act(async () => flow.save({ passphrase }));
    pay(flow, "a1");
    act(() => flow.logSent({ kind: "share", ref: "share:s1" }));
    const named = "On this device, except what you chose to send: a payment and a locked share link.";
    expect(line()).toBe(named);

    // Lock now; the quiet-time lock takes the same path. The next person at the device learns nothing.
    act(() => flow.lockNow());
    expect(line()).toBe("On this device.");
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.queryByRole("heading", { name: "What you sent" })).toBeNull();
    expect(sheet.queryByText(/Nothing yet|this list keeps only what was sent|a share link\. The packet/)).toBeNull();

    // A reload with saved progress: still locked, still quiet.
    cleanup();
    const again = (await page("en", undefined, services)).flow!;
    expect(again.vault.status).toBe("locked");
    expect(line()).toBe("On this device.");

    // Opening the saved progress brings the whole line back.
    await act(async () => {
      expect(await again.openSaved({ passphrase })).toBe(true);
    });
    expect(line()).toBe(named);
  });

  it("names none of the tab's sends before it knows whether there is saved progress", () => {
    keepSend({ kind: "payment", at: "2026-10-03T17:00:00.000Z" });
    const services = testServices();
    // The vault has not answered yet, as on a slow phone.
    services.vault.exists = () => new Promise<boolean>(() => {});
    mount("en", undefined, services);
    expect(line()).toBe("On this device.");
  });
});

describe("Exit this page", () => {
  it("clears what the tab kept, and a reply that lands after it does not write it back", async () => {
    const replace = vi.fn();
    const real = navigation.replace;
    navigation.replace = replace;
    try {
      pay((await page("en", <ExitControl />)).flow!, "a1");
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

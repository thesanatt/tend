// @vitest-environment jsdom
// The privacy line stays true for the tab. It says nothing left only since this page opened; a
// reload keeps only that the tab sent something, never what or when; the page's first HTML never says
// nothing left before it has looked; saved progress that is locked hides it; ending the claim here
// (Close Tend on a claim never saved, deleting or saving over locked progress) and Exit this page
// forget it, and a page that put a new claim on screen stops saying nothing left.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitControl } from "@/components/flow/ExitControl";
import { FlowProvider, useFlow, VAULT_KEY } from "@/components/flow/FlowProvider";
import { dropUnlessReload, keepSend, reloadKeptForTests } from "@/components/flow/keptSends";
import PrivacyLine from "@/components/flow/PrivacyLine";
import type { FlowState } from "@/components/flow/state";
import { navigation } from "@/components/QuickExit";
import { I18nProvider, type Lang } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
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
  // A new page reads what the tab kept, as the module does when a page loads.
  reloadKeptForTests();
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
const QUIET = "On this device. Only the state you picked went to Tend's server, to get its law.";
const kept = () => JSON.parse(sessionStorage.getItem(SENT_KEY) ?? "{}") as { sent?: true; state?: true };
const BEFORE = "something this tab sent before a reload";

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
  it("still says this tab sent something, and keeps no kind, time, amount, or id", async () => {
    const flow = (await page()).flow!;
    expect(line()).toBe(QUIET);
    pay(flow, "act_7f3a");
    act(() => flow.logSent({ kind: "share", ref: "share:tok_91c2" }));
    expect(line()).toBe("On this device, except: the state you picked, a payment, and a locked share link.");

    // What the tab holds: two flags. Not that it was a payment or a share, and not when.
    const raw = sessionStorage.getItem(SENT_KEY)!;
    expect(JSON.parse(raw)).toEqual({ sent: true, state: true });
    for (const secret of ["payment", "share", "11800", "Riverbend", "act_7f3a", "tok_91c2", "202"]) {
      expect(raw).not.toContain(secret);
    }

    // A reload: the flow starts over in memory, and the tab remembers only that something went.
    cleanup();
    await page();
    expect(line()).toBe(`On this device, except: the state you picked and ${BEFORE}.`);
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.getByText(en.privacy.eventBefore)).toBeTruthy();
    expect(sheet.queryByText(/: a payment of|: a share link\.|\$118\.00|Riverbend/)).toBeNull();
  });

  it("says it in Spanish too", async () => {
    pay((await page("es")).flow!, "act_1");
    cleanup();
    await page("es");
    expect(line()).toBe(
      "En este dispositivo, salvo: el estado que elegiste y algo que esta pestaña envió antes de recargarse.",
    );
  });

  it("keeps a payment that was started and not finished, and names what this page sends", async () => {
    const first = (await page()).flow!;
    act(() =>
      first.logSent({ kind: "payment_setup", amount_cents: 11800, to: "Riverbend", action_id: "a1", ref: "setup:a1" }),
    );
    cleanup();
    const second = (await page()).flow!;
    expect(line()).toBe(`On this device, except: the state you picked and ${BEFORE}.`);
    pay(second, "a2");
    expect(line()).toBe(`On this device, except: the state you picked, a payment, and ${BEFORE}.`);
    cleanup();
    await page();
    expect(line()).toBe(`On this device, except: the state you picked and ${BEFORE}.`);
  });

  it("keeps one flag however many sends there are", async () => {
    const flow = (await page()).flow!;
    act(() => {
      flow.logSent({ kind: "share", ref: "share:s1", at: "2026-10-03T17:00:00.000Z" });
      flow.logSent({ kind: "share", ref: "share:s1", at: "2026-10-03T17:00:01.000Z" });
      flow.logSent({ kind: "bank", ref: "bank" });
    });
    expect(JSON.parse(sessionStorage.getItem(SENT_KEY)!)).toEqual({ sent: true, state: true });
  });

  it("ignores anything else in its place in storage", async () => {
    for (const junk of [
      [{ kind: "payment", at: "x" }],
      { sent: "yes" },
      { sent: true, kind: "payment" },
      { sent: false },
      3,
      null,
    ]) {
      sessionStorage.setItem(SENT_KEY, JSON.stringify(junk));
      await page();
      expect(line(), JSON.stringify(junk)).toBe(QUIET);
      cleanup();
    }
  });

  it("says nothing left only since this page opened, in its sheet too and in Spanish", async () => {
    await page();
    expect(line()).toBe(QUIET);
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    // A state is picked, so its law request is the one line the sheet lists.
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.getByText("The state you picked, to Tend's server, to get its law.")).toBeTruthy();
    expect(sheet.queryByText("Nothing since this page opened.")).toBeNull();
    cleanup();
    await page("es");
    expect(line()).toBe("En este dispositivo. Solo el estado que elegiste fue al servidor de Tend, para traer su ley.");
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

// Chromium gives a closed tab it reopens (Cmd+Shift+T, History) its sessionStorage back, and that
// load counts as back_forward. Only a reload may bring the list back.
describe("the privacy line on a page that is not a reload", () => {
  const one = JSON.stringify({ sent: true });

  // The page loading again: a fresh copy of the module, with the browser's navigation type.
  async function load(type: string) {
    const spy = vi
      .spyOn(performance, "getEntriesByType")
      .mockReturnValue([{ type } as PerformanceNavigationTiming] as unknown as PerformanceEntryList);
    try {
      vi.resetModules();
      await import("@/components/flow/keptSends");
    } finally {
      spy.mockRestore();
    }
  }

  it("keeps the tab's list only across a reload", async () => {
    sessionStorage.setItem(SENT_KEY, one);
    dropUnlessReload("reload");
    expect(sessionStorage.getItem(SENT_KEY)).toBe(one);
    for (const type of ["back_forward", "navigate", "prerender", undefined]) {
      sessionStorage.setItem(SENT_KEY, one);
      dropUnlessReload(type);
      expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
    }
    await page();
    expect(line()).toBe(QUIET);
  });

  it("forgets it when the page loads as a reopened tab, and keeps it when the page reloads", async () => {
    sessionStorage.setItem(SENT_KEY, one);
    await load("reload");
    expect(sessionStorage.getItem(SENT_KEY)).toBe(one);
    await load("back_forward");
    expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
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
    const named = "On this device, except: the state you picked, a payment, and a locked share link.";
    expect(line()).toBe(named);

    // Lock now; the quiet-time lock takes the same path. The next person at the device learns nothing.
    act(() => flow.lockNow());
    expect(line()).toBe("On this device.");
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.queryByRole("heading", { name: "What you sent" })).toBeNull();
    expect(
      sheet.queryByText(
        /Nothing since this page opened|sent something before it was reloaded|a share link\. The packet/,
      ),
    ).toBeNull();

    // A reload with saved progress: still locked, still quiet.
    cleanup();
    const again = (await page("en", undefined, services)).flow!;
    expect(again.vault.status).toBe("locked");
    expect(line()).toBe("On this device.");

    // Opening the saved progress brings the line back. The payment and the share came after the save,
    // so the saved claim does not hold them; the tab says only that something went before the reload.
    await act(async () => {
      expect(await again.openSaved({ passphrase })).toBe(true);
    });
    expect(line()).toBe(`On this device, except: the state you picked and ${BEFORE}.`);
  });

  it("does not keep what is sent after Start over without it, so the owner never sees it as theirs", async () => {
    const services = testServices();
    const flow = (await page("en", undefined, services)).flow!;
    await act(async () => flow.save({ passphrase }));
    act(() => flow.lockNow());

    // Someone else at the device starts over without the locked progress and shares a packet. Their
    // own line names it; the tab does not keep it.
    act(() => flow.logSent({ kind: "share", ref: "share:s9" }));
    expect(line()).toBe("On this device, except: a locked share link.");
    expect(kept().sent).toBeUndefined();

    // A reload, then the owner opens their progress: nothing of the other person's share.
    cleanup();
    const again = (await page("en", undefined, services)).flow!;
    expect(line()).toBe("On this device.");
    await act(async () => {
      expect(await again.openSaved({ passphrase })).toBe(true);
    });
    expect(line()).toBe(QUIET);
  });

  it("keeps nothing sent before it knows whether there is saved progress", () => {
    const services = testServices();
    services.vault.exists = () => new Promise<boolean>(() => {});
    const flow = mount("en", undefined, services).flow!;
    act(() => flow.logSent({ kind: "share", ref: "share:s10" }));
    expect(line()).toBe("On this device, except: the state you picked and a locked share link.");
    expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
  });

  // lib/netlog reports a send when its answer comes back, which can fall between the vault's word and
  // the render that shows it. The tab goes by what the vault said last.
  it("keeps a send that lands after the vault finds no saved progress, before the screen shows it", async () => {
    const services = testServices();
    let answer!: (exists: boolean) => void;
    services.vault.exists = () => new Promise<boolean>((resolve) => (answer = resolve));
    const box = mount("en", undefined, services);
    await act(async () => {
      answer(false);
      await Promise.resolve();
      expect(box.flow!.vault.status).toBe("checking");
      box.flow!.logSent({ kind: "share", ref: "share:s11" });
    });
    expect(box.flow!.vault.status).toBe("none");
    expect(kept().sent).toBe(true);
  });

  it("keeps nothing that lands after Lock now, before the screen shows the lock", async () => {
    const services = testServices();
    const flow = (await page("en", undefined, services)).flow!;
    await act(async () => flow.save({ passphrase }));
    act(() => {
      flow.lockNow();
      flow.logSent({ kind: "share", ref: "share:s12" });
    });
    expect(kept().sent).toBeUndefined();
  });

  it("names none of the tab's sends before it knows whether there is saved progress", () => {
    keepSend();
    const services = testServices();
    // The vault has not answered yet, as on a slow phone.
    services.vault.exists = () => new Promise<boolean>(() => {});
    mount("en", undefined, services);
    expect(line()).toBe("On this device.");
  });
});

// Each step reads the flow from the latest render: save, Delete, and Close Tend act on the vault's
// status as the screen showed it.
describe("the privacy line when the claim ends here", () => {
  const passphrase = "garden gate 41";
  const forgotten = () => {
    expect(kept().sent).toBeUndefined();
    expect(line()).not.toMatch(/payment|share link|before a reload/);
  };

  it("forgets what the tab sent when locked progress is deleted, which needs no passcode", async () => {
    const services = testServices();
    const box = await page("en", undefined, services);
    await act(async () => box.flow!.save({ passphrase }));
    pay(box.flow!, "a1");
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s1" }));
    act(() => box.flow!.lockNow());

    await act(async () => box.flow!.forget());
    forgotten();
    // The payment and the share left from this page, so it does not say that nothing did.
    expect(line()).toBe("On this device.");
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    expect(
      within(screen.getByRole("dialog")).queryByText(/before it was reloaded|a share link\. The packet|Nothing since/),
    ).toBeNull();

    cleanup();
    await page("en", undefined, services);
    forgotten();
    expect(line()).toBe(QUIET);
  });

  it("forgets what the tab sent before when someone saves over locked progress, and keeps their own", async () => {
    const services = testServices();
    const box = await page("en", undefined, services);
    await act(async () => box.flow!.save({ passphrase }));
    pay(box.flow!, "a1");
    act(() => box.flow!.lockNow());

    // Start over without it, share, then Save this with another passcode.
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s2" }));
    await act(async () => box.flow!.save({ passphrase: "another code 77" }));
    expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
    const own = "On this device, except: a locked share link.";
    expect(line()).toBe(own);

    // A reload locks it; opening the new progress names the share and still not the payment.
    services.vault.lock();
    cleanup();
    const again = await page("en", undefined, services);
    expect(line()).toBe("On this device.");
    await act(async () => {
      expect(await again.flow!.openSaved({ passphrase: "another code 77" })).toBe(true);
    });
    expect(line()).toBe(own);
  });

  it("forgets what the tab sent when Close Tend ends a claim that was never saved", async () => {
    const box = await page();
    pay(box.flow!, "a1");
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s1" }));
    act(() => box.flow!.endSession());
    forgotten();
    expect(line()).toBe("On this device.");

    cleanup();
    await page();
    forgotten();
    expect(line()).toBe(QUIET);
  });

  it("after Close Tend on this page, names what is sent next but never says nothing left", async () => {
    const box = await page();
    act(() => box.flow!.endSession());
    // Nothing was sent, and the line still says only what it can always say: the next person learns
    // nothing from it about the claim that ended.
    expect(line()).toBe("On this device.");
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s4" }));
    expect(line()).toBe("On this device, except: a locked share link.");
  });

  it("does not tell the owner nothing left after someone else shared from this page", async () => {
    const services = testServices();
    const box = await page("en", undefined, services);
    await act(async () => box.flow!.save({ passphrase }));
    act(() => box.flow!.lockNow());

    // Someone else starts over without it, shares a packet, and closes Tend. The owner opens it.
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s5" }));
    act(() => box.flow!.endSession());
    await act(async () => {
      expect(await box.flow!.openSaved({ passphrase })).toBe(true);
    });
    // Not the other person's share, and not "Nothing has left it since this page opened" either.
    expect(line()).toBe("On this device.");
    fireEvent.click(screen.getByRole("button", { name: "What stays here" }));
    expect(
      within(screen.getByRole("dialog")).queryByText(/a share link\. The packet|Nothing since|before it was reloaded/),
    ).toBeNull();
  });

  it("forgets it too on Close Tend after starting over without locked progress", async () => {
    const services = testServices();
    const box = await page("en", undefined, services);
    await act(async () => box.flow!.save({ passphrase }));
    pay(box.flow!, "a1");
    // The vault takes each change a quarter second later.
    await waitFor(() => expect((services.vault.snapshot().get(VAULT_KEY) as FlowState).sent).toHaveLength(2));
    act(() => box.flow!.lockNow());

    // Someone else starts over without it, shares a packet, and closes Tend.
    act(() => box.flow!.logSent({ kind: "share", ref: "share:s3" }));
    act(() => box.flow!.endSession());
    forgotten();
    expect(line()).toBe("On this device.");

    // The owner opens it: the line names their payment, from the vault, and not that share.
    await act(async () => {
      expect(await box.flow!.openSaved({ passphrase })).toBe(true);
    });
    expect(line()).toBe("On this device, except: the state you picked and a payment.");
  });

  it("keeps the sends of open saved progress behind its lock on Close Tend, and names them once it opens", async () => {
    const services = testServices();
    // A payment, then a reload, then a save: the saved claim does not hold the payment, the tab does.
    pay((await page("en", undefined, services)).flow!, "a1");
    cleanup();
    const box = await page("en", undefined, services);
    await act(async () => box.flow!.save({ passphrase }));
    const paid = `On this device, except: the state you picked and ${BEFORE}.`;
    expect(line()).toBe(paid);

    act(() => box.flow!.endSession());
    expect(box.flow!.vault.status).toBe("locked");
    expect(line()).toBe("On this device.");
    expect(kept().sent).toBe(true);

    cleanup();
    const again = await page("en", undefined, services);
    expect(line()).toBe("On this device.");
    await act(async () => {
      expect(await again.flow!.openSaved({ passphrase })).toBe(true);
    });
    expect(line()).toBe(paid);
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
      keepSend();
      expect(sessionStorage.getItem(SENT_KEY)).toBeNull();
    } finally {
      navigation.replace = real;
    }
  });
});

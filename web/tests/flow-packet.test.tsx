// @vitest-environment jsdom
// Packet and Track (docs/UX.md steps 3 and the garden), and pause and resume through the vault.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckScreen from "@/components/flow/check/CheckScreen";
import FlowFrame from "@/components/flow/FlowFrame";
import { IDLE_LOCK_MS } from "@/components/flow/FlowProvider";
import PacketScreen from "@/components/flow/packet/PacketScreen";
import PrivacyLine from "@/components/flow/PrivacyLine";
import type { Action, FlowItem } from "@/components/flow/state";
import TrackScreen, { reminderDate, reminderIcs } from "@/components/flow/track/TrackScreen";
import { MI_CHECK, renderFlow, stateFrom, stubLawFetch } from "./helpers/flow";

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
  vi.useRealTimers();
});

function session(id: string, date: string): FlowItem {
  return {
    item_id: id,
    date,
    amount_cents: 4000,
    expense: "counseling",
    confirmed: true,
    insurance_paid_cents: 0,
    is_bill: false,
    units: 1,
    unit: "session",
    tags: [],
    description: "Clearwater Counseling Group - session",
    source: "rule",
    reason: "A counseling provider charge",
    confidence: 0.95,
    origin: "statement",
    merchant: "Clearwater Counseling Group",
  };
}

const gathered: Action[] = [
  MI_CHECK,
  {
    type: "addSource",
    source: { id: "s", kind: "statement", label: "s.csv", read: 2, found: 2, warnings: [], sample: true },
    items: [session("a", "2026-06-17"), session("b", "2026-06-24")],
  },
];

describe("Packet", () => {
  it("is built on the device: the form note, the still-needed list, and where to file, each cited", async () => {
    const { services } = renderFlow(<PacketScreen />, { initial: stateFrom(gathered) });
    expect(await screen.findByText("$80.00")).toBeTruthy();
    expect(screen.getByText(/The program decides\./)).toBeTruthy();
    expect(
      screen.getByText(
        "Only you fill these in: your name, your signature, what happened, who, where, and your Social Security number.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Receipts")).toBeTruthy();
    expect(screen.getByRole("button", { name: /show the law for Receipts/ })).toBeTruthy();
    expect(screen.getByText("By mail")).toBeTruthy();
    expect(screen.getByText(/PO Box 30037 Lansing MI 48909/)).toBeTruthy();
    expect(screen.getByText("By email")).toBeTruthy();
    expect(screen.getByRole("link", { name: "MDHHS-MichiganCrimeVictim@Michigan.gov" }).getAttribute("href")).toBe(
      "mailto:MDHHS-MichiganCrimeVictim@Michigan.gov",
    );
    expect(services.evaluate).toHaveBeenCalled();
  });

  it("checking off a document is remembered", async () => {
    renderFlow(<PacketScreen />, { initial: stateFrom(gathered) });
    const box = (await screen.findByLabelText("Receipts")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(((await screen.findByLabelText("Receipts")) as HTMLInputElement).checked).toBe(true);
  });

  it("shares a locked link, says so on the privacy line, and can stop it", async () => {
    const { services } = renderFlow(
      <>
        <PrivacyLine />
        <PacketScreen />
      </>,
      { initial: stateFrom(gathered) },
    );
    await screen.findByText("$80.00");
    fireEvent.click(screen.getByLabelText("Let it open only once"));
    fireEvent.click(screen.getByRole("button", { name: "Make a share link" }));
    const link = (await screen.findByLabelText("Share this link with your advocate:")) as HTMLInputElement;
    expect(link.value).toMatch(/\/share\/[\w-]+#k=\w+/);
    expect(screen.getByText(/It opens once\./)).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a locked share link.")).toBeTruthy();
    const sealed = [...services.share.sealed.values()][0];
    expect(sealed.st).toBe("MI");
    expect(sealed.input.items).toHaveLength(2);
    expect(JSON.stringify(sealed)).not.toMatch(/name|story/i);

    fireEvent.click(screen.getByRole("button", { name: "Stop this link" }));
    expect(await screen.findByText("A link you stopped no longer works.")).toBeTruthy();
    expect(services.share.sealed.size).toBe(0);
  });

  it("marks the claim as sent, which buds every plant", async () => {
    renderFlow(
      <>
        <PacketScreen />
        <TrackScreen />
      </>,
      { initial: stateFrom(gathered) },
    );
    expect(await screen.findAllByRole("img", { name: /^Sprout: / })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "I sent my claim" }));
    expect(await screen.findByText("You marked your claim as sent on October 3, 2026.")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Bud: / })).toHaveLength(2);
  });
});

describe("Track", () => {
  it("keeps the deadline in view and grows a leaf when a document is attached", async () => {
    renderFlow(<TrackScreen />, { initial: stateFrom(gathered) });
    expect(await screen.findByText("File by June 14, 2031.")).toBeTruthy();
    const plants = await screen.findAllByRole("img", { name: /^Sprout: Clearwater Counseling Group - session, \$40\.00$/ });
    expect(plants).toHaveLength(2);
    const attach = screen.getAllByLabelText(/^Attach a document/)[0];
    fireEvent.change(attach, { target: { files: [new File(["x"], "receipt.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("Attached: receipt.pdf")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Leaf: / })).toHaveLength(1);
  });

  it("offers a neutral calendar reminder that names nothing", () => {
    expect(reminderDate("2026-10-03", "2031-06-14")).toBe("2026-11-02");
    expect(reminderDate("2026-10-03", "2026-10-20")).toBe("2026-10-13");
    expect(reminderDate("2026-10-03", "2026-10-05")).toBe("2026-10-04");
    const ics = reminderIcs("2026-11-02", "Check on paperwork", "20261003T170000Z");
    expect(ics).toContain("SUMMARY:Check on paperwork");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102");
    expect(ics).not.toMatch(/tend|claim|assault|compensation|victim/i);
  });
});

describe("pause and resume", () => {
  it("saves behind a passcode, locks, and opens again only with the right one", async () => {
    const { services } = renderFlow(
      <FlowFrame>
        <CheckScreen />
      </FlowFrame>,
      { initial: stateFrom([MI_CHECK]) },
    );
    expect(await screen.findByText("Not saved yet")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Steps" }).parentElement!).getByRole("button", { name: "Save this" }));
    const sheet = await screen.findByRole("dialog");
    const code = within(sheet).getByLabelText("Passcode");
    fireEvent.change(code, { target: { value: "short" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save with this passcode" }));
    expect(await within(sheet).findByText("Use at least 6 characters.")).toBeTruthy();
    fireEvent.change(code, { target: { value: "garden-42" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save with this passcode" }));
    expect(await screen.findByText("Saved on this device")).toBeTruthy();
    await waitFor(() => expect(services.vault.snapshot().get("tend.flow")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeTruthy();
    expect(services.vault.isUnlocked()).toBe(false);

    fireEvent.change(screen.getByLabelText("Passcode"), { target: { value: "wrong-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That passcode did not work. Try again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Passcode"), { target: { value: "garden-42" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("You can likely apply in Michigan.")).toBeTruthy();
    expect((screen.getByLabelText("Which state did it happen in?") as HTMLSelectElement).value).toBe("MI");
  });

  it("locks itself after a quiet stretch on a shared device", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { services } = renderFlow(
      <FlowFrame>
        <CheckScreen />
      </FlowFrame>,
      { initial: stateFrom([MI_CHECK]) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save this" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Passcode"), { target: { value: "garden-42" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save with this passcode" }));
    expect(await screen.findByText("Saved on this device")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 20_000);
    expect(await screen.findByText("It locked after 10 minutes without use, to keep it private.")).toBeTruthy();
    expect(services.vault.isUnlocked()).toBe(false);
  });

  it("can delete saved progress for good", async () => {
    const { services } = renderFlow(
      <FlowFrame>
        <CheckScreen />
      </FlowFrame>,
      { initial: stateFrom([MI_CHECK]) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save this" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Passcode"), { target: { value: "garden-42" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save with this passcode" }));
    fireEvent.click(await screen.findByRole("button", { name: "Lock now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete saved progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    await waitFor(async () => expect(await services.vault.exists()).toBe(false));
    expect(await screen.findByRole("heading", { name: "See what your state can pay for" })).toBeTruthy();
  });
});

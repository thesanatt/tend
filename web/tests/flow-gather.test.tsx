// @vitest-environment jsdom
// Gather and bill triage (docs/UX.md step 2), through the thin mocks of the local modules.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillsScreen from "@/components/flow/bills/BillsScreen";
import { ROWAN_ACCOUNT } from "@/components/flow/samples";
import GatherScreen from "@/components/flow/gather/GatherScreen";
import PrivacyLine from "@/components/flow/PrivacyLine";
import type { Action, BillRecord, FlowItem } from "@/components/flow/state";
import { SAMPLE_BILL_READING } from "@/lib/mocks";
import { MI_CHECK, MI_LAW, renderFlow, stateFrom, stubLawFetch, testServices } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/gather",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function figure() {
  return screen.getByText(/^\$[\d,]+\.\d\d$/, { selector: "p[class*=tallyFigure] span" }).textContent;
}

// The tally keeps the last total while the engine works, so wait until no line is still being checked.
async function settled() {
  await waitFor(() => {
    expect(figure()).not.toBe("...");
    expect(document.querySelectorAll('li[data-status="checking"]')).toHaveLength(0);
  });
}

describe("Gather", () => {
  it("asks for the state first", () => {
    renderFlow(<GatherScreen />);
    expect(screen.getByText("First, tell Tend which state it happened in.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Check" }).getAttribute("href")).toBe("/check");
  });

  it("offers the statement first, then the demo bank, then a bill, all read on this device", () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    const options = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(options).toEqual(["Bank statement", "Demo bank", "A bill"]);
    // The statement upload is the one primary action on an empty screen.
    expect(screen.getByText("Upload a statement").className).toMatch(/btn-primary/);
    expect(screen.getByText("Add a bill").className).not.toMatch(/btn-primary/);
  });

  it("reads a statement, groups the costs, and confirms a group in one tap", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    expect(await screen.findByText("What Tend found")).toBeTruthy();
    expect(screen.getByText(/sample-statement-fictional\.pdf: 190 transactions read/)).toBeTruthy();
    await settled();
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(expect.arrayContaining(["Counseling", "Getting there", "Home", "Work", "Not covered"]));

    // Direct matches start checked; guesses are questions with Yes / No / Not sure.
    const counseling = screen.getByRole("region", { name: "Counseling" });
    const boxes = within(counseling).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.checked)).toBe(true);
    const ride = screen.getAllByRole("group", { name: /Was this ride to care\?/ })[0];
    expect(
      within(ride)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Yes", "No", "Not sure"]);

    await settled();
    const before = figure();
    const confirmAll = screen.getByRole("button", { name: /^Yes to all \d+ rides$/ });
    fireEvent.click(confirmAll);
    await waitFor(() => expect(figure()).not.toBe(before));
    expect(screen.queryByRole("button", { name: /^Yes to all \d+ rides$/ })).toBeNull();

    // Not covered lines stay visible, each with the rule that excludes it.
    const notCovered = screen.getByRole("region", { name: "Not covered" });
    expect(within(notCovered).getByText("Brightline Wireless - new phone")).toBeTruthy();
    expect(within(notCovered).getByRole("button", { name: /show the law for Brightline Wireless/ })).toBeTruthy();
    // A yes would not change what the law says, so these lines ask nothing.
    expect(within(notCovered).queryAllByRole("group")).toHaveLength(0);
  });

  it("unchecking a direct match takes it out of the total, one tap", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    await screen.findByText("What Tend found");
    await settled();
    const before = figure();
    const box = within(screen.getByRole("region", { name: "Counseling" })).getAllByRole("checkbox")[0];
    fireEvent.click(box);
    await waitFor(() => expect(figure()).not.toBe(before));
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("says plainly when a file has no transactions it can read", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.change(document.getElementById("statement-file")!, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(
      await screen.findByText("Tend could not find transactions in this file. Try a CSV or PDF from your bank."),
    ).toBeTruthy();
  });

  it("reads a bill on the device and says whether its lines add up", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample bill" }));
    expect(await screen.findByText(/Riverbend General Hospital: 3 lines, adding up to \$443\.00\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next: your bill" }).getAttribute("href")).toBe("/gather/bills");
  });

  it("marks a bill it cannot read reliably, and adds none of its lines", async () => {
    const { services } = renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.change(document.getElementById("bill-file")!, {
      target: { files: [new File(["blurry"], "photo.jpg", { type: "image/jpeg" })] },
    });
    expect(await screen.findByText("photo.jpg: Tend couldn't read this reliably.")).toBeTruthy();
    expect(services.evaluate).not.toHaveBeenCalledWith(
      expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ is_bill: true })]) }),
      expect.anything(),
    );
  });
});

const billLines: FlowItem[] = SAMPLE_BILL_READING.lines.map((l, i) => ({
  item_id: `bill:abc:${l.line_id}`,
  date: "2026-06-14",
  amount_cents: l.amount_cents,
  expense: l.expense,
  confirmed: true,
  insurance_paid_cents: 0,
  is_bill: true,
  units: 0,
  unit: null,
  tags: [],
  description: l.description,
  source: "rule",
  reason: "",
  confidence: 1,
  origin: "bill",
  merchant: "Riverbend General Hospital",
  bill_id: "bill-abc",
  line_no: i + 1,
}));
const bill: BillRecord = {
  id: "bill-abc",
  label: "riverbend.pdf",
  reading: SAMPLE_BILL_READING,
  replaces: null,
  choice: null,
  sample: true,
};
const withBill: Action[] = [MI_CHECK, { type: "addBill", bill, items: billLines }];
const withBank: Action = {
  type: "addSource",
  source: { id: "bank", kind: "bank", label: "Checking", read: 0, found: 0, warnings: [], sample: true },
  items: [],
  account: ROWAN_ACCOUNT,
};

describe("bill triage", () => {
  it("holds the exam line with the law beside it, and offers a ready letter that quotes the law", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    expect(await screen.findByRole("heading", { name: "Don't pay this line" })).toBeTruthy();
    expect(
      screen.getByText(
        "Medical forensic exam, deductible applied, $325.00. Michigan law says you should not be billed for it.",
      ),
    ).toBeTruthy();
    const noBill = MI_LAW.rules.find((r) => r.id === "MI-EXAM-1")!;
    expect(screen.getByText(noBill.quote)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The rest: $118.00" })).toBeTruthy();
    expect(
      screen.getByText("Both choices are fine. The program can pay you back for these, whether you pay now or not:"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get a letter for the billing office" }));
    const letter = await screen.findByText((_, el) => el?.tagName === "PRE" && el.textContent!.includes(noBill.quote));
    expect(letter.textContent).toContain(`Michigan law, ${noBill.pinpoint}, says:`);
    expect(letter.textContent).toContain("Riverbend General Hospital");
    expect(screen.getByText("Tend does not send anything for you. You choose if and when.")).toBeTruthy();
  });

  it("without a connected bank, paying is not offered; leaving it unpaid and claiming it is", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    const pay = (await screen.findByRole("button", { name: "Pay $118.00 now" })) as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave unpaid and claim it" }));
    expect(await screen.findByText("You chose to leave it unpaid and claim it. It is in your packet.")).toBeTruthy();
  });

  it("pays only with the six-digit code, and the privacy line changes only after the bank took it", async () => {
    const { services } = renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { initial: stateFrom([...withBill, withBank]) },
    );
    expect(screen.getByText("On this device. Nothing has left it.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("$118.00")).toBeTruthy();
    expect(within(dialog).getByText("Riverbend General Hospital")).toBeTruthy();
    expect(
      within(dialog).getByText(/Medical forensic exam, deductible applied, \$325\.00\. It stays held\./),
    ).toBeTruthy();
    // Opening the sheet sends nothing; asking for the code does.
    expect(services.propose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    await within(dialog).findByLabelText("Confirmation code");
    expect(screen.getByText("On this device, except what you chose to send: a payment you started.")).toBeTruthy();
    expect(services.propose).toHaveBeenCalledWith(
      expect.objectContaining({ amount_cents: 11800, payee: "Riverbend General Hospital", from: ROWAN_ACCOUNT }),
    );

    const payButton = within(dialog).getByRole("button", { name: "Pay $118.00" }) as HTMLButtonElement;
    const code = within(dialog).getByLabelText("Confirmation code");
    expect(payButton.disabled).toBe(true);
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(payButton);
    expect(
      await within(dialog).findByText("That code does not match. Check the six digits and try again."),
    ).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a payment you started.")).toBeTruthy();

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(payButton);
    expect(await within(dialog).findByText("Paid $118.00.")).toBeTruthy();
    expect(within(dialog).getByText("The bank's record matches this payment.")).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
  });

  it("a demo payment sends nothing, so the privacy line stays the same", async () => {
    const services = testServices({
      propose: vi.fn(async (req) => ({
        action_id: "demo-1",
        amount_cents: req.amount_cents,
        from: "Checking 0011",
        payee: req.payee,
        confirm_code: "123456",
        expires_at: "2026-10-03T23:00:00Z",
        demo: true,
      })),
      confirm: vi.fn(async () => ({
        action_id: "demo-1",
        status: "not_sent",
        amount_cents: 11800,
        at: "2026-10-03T17:00:00Z",
      })),
    });
    renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { services, initial: stateFrom([...withBill, withBank]) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    expect(await within(dialog).findByText(/Demo mode: Tend is not connected to the bank/)).toBeTruthy();
    expect(screen.getByText("On this device. Nothing has left it.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Confirmation code"), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pay $118.00" }));
    expect(await within(dialog).findByText("Nothing was sent.")).toBeTruthy();
    expect(screen.getByText("On this device. Nothing has left it.")).toBeTruthy();
  });

  it("refuses a proposal whose amount differs from the bill, before any code is asked for", async () => {
    const services = testServices({
      propose: vi.fn(async (req) => ({
        action_id: "a1",
        amount_cents: 44300,
        from: "Checking 0011",
        payee: req.payee,
        confirm_code: "123456",
        expires_at: "2026-10-03T23:00:00Z",
        demo: false,
      })),
    });
    renderFlow(<BillsScreen />, { services, initial: stateFrom([...withBill, withBank]) });
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    expect(
      await within(dialog).findByText(
        "The payment service proposed $443.00, but the bill shows $118.00. Nothing was sent.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText("Confirmation code")).toBeNull();
    expect(services.confirm).not.toHaveBeenCalled();
  });
});

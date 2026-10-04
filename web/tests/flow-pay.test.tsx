// @vitest-environment jsdom
// Review fixes: paying a bill against the real API's answers (api/tend_api/actions.py), what the
// privacy line says when a payment stops partway, who a payment goes to, and expired share links.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillsScreen, { PAYEE_FALLBACK, payeeFor } from "@/components/flow/bills/BillsScreen";
import { confirmProblem, proposeProblem } from "@/components/flow/bills/PaySheet";
import { buildEngineInput } from "@/components/flow/claim";
import ShareBox, { expired } from "@/components/flow/packet/ShareBox";
import PrivacyLine from "@/components/flow/PrivacyLine";
import { ROWAN_ACCOUNT } from "@/components/flow/samples";
import { initialState, reducer, type Action, type BillRecord, type FlowItem } from "@/components/flow/state";
import { ApiError } from "@/lib/api";
import { DICTS } from "@/lib/i18n";
import { SAMPLE_BILL_READING } from "@/lib/mocks";
import GatherScreen from "@/components/flow/gather/GatherScreen";
import { MI_CHECK, michiganOutput, renderFlow, stateFrom, stubLawFetch, testServices, TODAY } from "./helpers/flow";

const { en, es } = DICTS;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/gather/bills",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const setup: Action[] = [
  MI_CHECK,
  { type: "addBill", bill, items: billLines },
  {
    type: "addSource",
    source: { id: "bank", kind: "bank", label: "Checking", read: 0, found: 0, warnings: [], sample: true },
    items: [],
    account: ROWAN_ACCOUNT,
  },
];

async function openWithCode(services = testServices(), lang: "en" | "es" = "en") {
  const view = renderFlow(
    <>
      <PrivacyLine />
      <BillsScreen />
    </>,
    { services, initial: stateFrom(setup, lang), lang },
  );
  const t = lang === "en" ? en : es;
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${t.bills.payNow("\\$118\\.00", "")}`) }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: t.pay.getCode }));
  return { ...view, dialog, t };
}

function typeCode(dialog: HTMLElement, code: string, t = en) {
  fireEvent.change(within(dialog).getByLabelText(t.pay.codeLabel), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole("button", { name: t.pay.pay("$118.00") }));
}

describe("payment errors, worded by status and never in the service's English", () => {
  it("maps the API's statuses", () => {
    expect(confirmProblem(new ApiError("That code does not match this action.", 403), en)).toEqual({
      text: en.pay.codeWrong,
      phase: "ready",
    });
    expect(confirmProblem(new ApiError("x", 400), en).phase).toBe("ready");
    expect(confirmProblem(new ApiError("expired", 410), en)).toEqual({ text: en.pay.codeExpired, phase: "dead" });
    expect(confirmProblem(new ApiError("already done", 409), en).phase).toBe("dead");
    expect(confirmProblem(new ApiError("locked", 423), en)).toEqual({ text: en.pay.codeLocked, phase: "dead" });
    expect(confirmProblem(new ApiError("bank refused", 502), en)).toEqual({ text: en.pay.bankUnsure, phase: "unsure" });
    expect(confirmProblem(new TypeError("Failed to fetch"), en).phase).toBe("unsure");
    expect(proposeProblem(new ApiError("Nessie stores whole dollars", 422), es)).toBe(es.pay.wholeDollars);
    expect(proposeProblem(new ApiError("demo persona", 403), en)).toBe(en.pay.notDemoAccount);
    expect(proposeProblem(new Error("boom"), en)).toBe(en.pay.prepareFailed);
  });

  it("a wrong code from the API (403) says so in Spanish, and the same code box stays", async () => {
    const { dialog } = await openWithCode(testServices(), "es");
    await within(dialog).findByLabelText(es.pay.codeLabel);
    typeCode(dialog, "000000", es);
    expect(await within(dialog).findByText(es.pay.codeWrong)).toBeTruthy();
    expect(within(dialog).queryByText(/does not match this action/)).toBeNull();
  });

  it("an expired code offers a new one, and the new one pays", async () => {
    let n = 0;
    const services = testServices({
      propose: vi.fn(async (req) => ({
        action_id: `a${++n}`,
        amount_cents: req.amount_cents,
        from: ROWAN_ACCOUNT.id,
        payee: req.payee,
        confirm_code: "123456",
        expires_at: "2026-10-03T23:00:00Z",
        demo: false,
      })),
      confirm: vi.fn(async (actionId: string) => {
        if (actionId === "a1") throw new ApiError("This confirm code expired.", 410);
        return { action_id: actionId, status: "done", amount_cents: 11800, at: "2026-10-03T17:00:00Z" };
      }),
    });
    const { dialog } = await openWithCode(services);
    await within(dialog).findByLabelText(en.pay.codeLabel);
    typeCode(dialog, "123456");
    expect(await within(dialog).findByText(en.pay.codeExpired)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.newCode }));
    await within(dialog).findByLabelText(en.pay.codeLabel);
    typeCode(dialog, "123456");
    expect(await within(dialog).findByText("Paid $118.00.")).toBeTruthy();
    expect(services.propose).toHaveBeenCalledTimes(2);
    // Two codes were asked for, one payment went ahead: the line counts each once.
    expect(
      screen.getByText("On this device, except what you chose to send: a payment and a payment you started."),
    ).toBeTruthy();
  });

  it("a bank error (502) may have gone through: no new code, and the line says a payment left", async () => {
    const services = testServices({
      confirm: vi.fn(async () => {
        throw new ApiError("The bank did not answer, so this payment may have gone through", 502);
      }),
    });
    const { dialog } = await openWithCode(services);
    await within(dialog).findByLabelText(en.pay.codeLabel);
    typeCode(dialog, "123456");
    expect(await within(dialog).findByText(en.pay.bankUnsure)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: en.pay.newCode })).toBeNull();
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: en.common.done }));
    expect(await screen.findByText(en.bills.unverified("$118.00"))).toBeTruthy();
  });

  it("an 'unverified' result is not 'Nothing was sent'", async () => {
    const services = testServices({
      confirm: vi.fn(async (actionId: string) => ({
        action_id: actionId,
        status: "unverified",
        amount_cents: 11800,
        nessie_id: "w-9",
        read_back_matches: false,
        at: "2026-10-03T17:00:00Z",
      })),
    });
    const { dialog } = await openWithCode(services);
    await within(dialog).findByLabelText(en.pay.codeLabel);
    typeCode(dialog, "123456");
    expect(await within(dialog).findByText(en.pay.resultUnverified)).toBeTruthy();
    expect(within(dialog).queryByText(en.pay.resultNotSent)).toBeNull();
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
  });

  it("a cent amount on the live bank (422) explains whole dollars", async () => {
    const services = testServices({
      propose: vi.fn(async () => {
        throw new ApiError("Nessie stores whole dollars, so a live payment has to be a whole-dollar amount.", 422);
      }),
    });
    const { dialog } = await openWithCode(services);
    expect(await within(dialog).findByText(en.pay.wholeDollars)).toBeTruthy();
    expect(screen.getByText("On this device. Nothing has left it.")).toBeTruthy();
  });

  it("stopping after the code still says what left, in the privacy sheet too", async () => {
    const { dialog } = await openWithCode();
    await within(dialog).findByLabelText(en.pay.codeLabel);
    fireEvent.click(within(dialog).getByRole("button", { name: en.common.cancel }));
    expect(screen.getByText("On this device, except what you chose to send: a payment you started.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.privacy.more }));
    expect(await screen.findByText(/the amount \$118\.00 and the payee Riverbend General Hospital/)).toBeTruthy();
  });
});

describe("who a payment goes to", () => {
  const reading = (provider: string | null) => ({ reading: { ...SAMPLE_BILL_READING, provider } });

  it("never uses the file name, which could say anything", () => {
    expect(payeeFor(reading(null))).toBe(PAYEE_FALLBACK);
    expect(payeeFor(reading("   "))).toBe(PAYEE_FALLBACK);
  });

  it("matches what the bank stores: printable, one line, at most 80 characters", () => {
    expect(payeeFor(reading("  Riverbend\u0000 General\n Hospital "))).toBe("Riverbend General Hospital");
    expect(payeeFor(reading("A".repeat(120)))).toHaveLength(80);
  });

  it("an unnamed bill is paid to the billing office", async () => {
    const unnamed: BillRecord = {
      ...bill,
      label: "my-private-file.pdf",
      reading: { ...SAMPLE_BILL_READING, provider: null },
    };
    const { services } = renderFlow(<BillsScreen />, {
      initial: stateFrom([MI_CHECK, { type: "addBill", bill: unnamed, items: billLines }, setup[2]]),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Pay \$118\.00 now/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.getCode }));
    await within(dialog).findByLabelText(en.pay.codeLabel);
    expect(services.propose).toHaveBeenCalledWith(expect.objectContaining({ payee: PAYEE_FALLBACK }));
    expect(JSON.stringify((services.propose as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("my-private-file");
  });
});

describe("share links past their expiry", () => {
  it("knows an expired time", () => {
    expect(expired("2026-10-03T10:00:00Z", Date.parse("2026-10-03T11:00:00Z"))).toBe(true);
    expect(expired("2026-10-03T12:00:00Z", Date.parse("2026-10-03T11:00:00Z"))).toBe(false);
    expect(expired("not a time")).toBe(false);
  });

  it("an expired link is not offered for copying, and a new one can be made", async () => {
    const state = stateFrom([
      MI_CHECK,
      {
        type: "share",
        record: {
          id: "s1",
          url: "https://x/share#s1.key",
          expires_at: "2020-01-01T00:00:00Z",
          once: false,
          revoked: false,
        },
      },
    ]);
    const input = buildEngineInput(state, TODAY)!;
    renderFlow(<ShareBox input={input} output={michiganOutput(input)} />, { initial: state });
    expect(screen.queryByDisplayValue("https://x/share#s1.key")).toBeNull();
    expect(screen.getByText(en.share.lapsed)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.share.make })).toBeTruthy();
  });
});

describe("saved progress from an earlier build", () => {
  it("restores with any newer field started empty", () => {
    const old = { ...initialState("en") } as Record<string, unknown>;
    delete old.have;
    delete old.serverConsent;
    const restored = reducer(initialState("en"), { type: "restore", state: old as never });
    expect(restored.have).toEqual({});
    expect(restored.serverConsent).toBe(false);
  });
});

describe("Yes to all never confirms a line out of sight", () => {
  it("keeps a long group open while its new lines are still being checked", async () => {
    const rides: FlowItem[] = Array.from({ length: 7 }, (_, i) => ({
      ...billLines[0],
      item_id: `stmt:abc:r${i}`,
      date: `2026-06-${String(15 + i).padStart(2, "0")}`,
      amount_cents: 1800 + i,
      expense: "transportation",
      confirmed: false,
      is_bill: false,
      description: `Ride ${i + 1}`,
      origin: "statement",
      bill_id: undefined,
      line_no: undefined,
      reason: "A ride on a counseling day",
    }));
    // The engine has not answered yet, so every line is still being checked.
    const services = testServices({ evaluate: vi.fn(() => new Promise<never>(() => {})) });
    renderFlow(<GatherScreen />, {
      services,
      initial: stateFrom([
        MI_CHECK,
        {
          type: "addSource",
          source: { id: "stmt:abc", kind: "statement", label: "s.csv", read: 7, found: 7, warnings: [], sample: true },
          items: rides,
        },
      ]),
    });
    expect(await screen.findByRole("button", { name: /^Yes to all 7 rides$/ })).toBeTruthy();
    for (let i = 1; i <= 7; i++) expect(screen.getByText(`Ride ${i}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

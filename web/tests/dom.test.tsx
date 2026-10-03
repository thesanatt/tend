// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Plant from "@/components/Plant";
import QuickExit, { EXIT_URL, navigation, onPageShow } from "@/components/QuickExit";
import StatusTag from "@/components/StatusTag";
import LedgerRow from "@/components/ledger/LedgerRow";
import { useJustChanged } from "@/lib/hooks";
import type { Row } from "@/lib/ledger";
import type { EngineLine, ScanItem } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";

afterEach(() => cleanup());

describe("Exit this page", () => {
  let replace: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    replace = vi.fn();
    navigation.replace = replace as unknown as typeof navigation.replace;
    delete document.documentElement.dataset.exiting;
    sessionStorage.clear();
    sessionStorage.setItem("tend.session.v1", "{}");
  });

  it("leaves from the button, clears the tab's data, and blanks the page first", () => {
    render(<QuickExit />);
    fireEvent.click(screen.getByRole("button", { name: "Exit this page" }));
    expect(replace).toHaveBeenCalledWith(EXIT_URL);
    expect(sessionStorage.getItem("tend.session.v1")).toBeNull();
    expect(document.documentElement.dataset.exiting).toBe("true");
    expect(document.title).toBe("Weather");
  });

  it("leaves on Esc pressed twice, not once", () => {
    vi.useFakeTimers();
    render(<QuickExit />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(replace).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(replace).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("blanks and reloads a page restored from the back cache after leaving", () => {
    const reload = vi.fn();
    navigation.reload = reload;
    const restored = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted }) as PageTransitionEvent;

    onPageShow(restored(true));
    expect(reload).not.toHaveBeenCalled();

    render(<QuickExit />);
    fireEvent.click(screen.getByRole("button", { name: "Exit this page" }));
    delete document.documentElement.dataset.exiting;
    onPageShow(restored(false));
    expect(reload).not.toHaveBeenCalled();
    onPageShow(restored(true));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.exiting).toBe("true");
  });

  it("ignores two presses far apart", () => {
    const now = vi.spyOn(performance, "now");
    render(<QuickExit />);
    now.mockReturnValue(1000);
    fireEvent.keyDown(window, { key: "Escape" });
    now.mockReturnValue(2500);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(replace).not.toHaveBeenCalled();
    now.mockRestore();
  });
});

describe("Plant", () => {
  it("animates only when the stage grows, never on first paint", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Plant stage="sprout" seedKey="k" />);
    const svg = () => container.querySelector("svg")!;
    expect(svg().getAttribute("class")).not.toMatch(/growing/);
    rerender(<Plant stage="leaf" seedKey="k" />);
    expect(svg().getAttribute("class")).toMatch(/growing/);
    act(() => vi.advanceTimersByTime(1000));
    expect(svg().getAttribute("class")).not.toMatch(/growing/);
    rerender(<Plant stage="sprout" seedKey="k" />);
    expect(svg().getAttribute("class")).not.toMatch(/growing/);
    vi.useRealTimers();
  });

  it("is hidden from screen readers unless labeled", () => {
    const { container, rerender } = render(<Plant stage="bloom" seedKey="k" />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<Plant stage="bloom" seedKey="k" label="Bloom for $40.00" />);
    expect(screen.getByRole("img", { name: "Bloom for $40.00" })).toBeTruthy();
  });
});

function Probe({ value, settled }: { value: string; settled: boolean }) {
  return <span>{useJustChanged(value, settled) ? "changed" : "still"}</span>;
}

describe("useJustChanged", () => {
  it("ignores loading values and the first settled value, then marks real changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe value="checking" settled={false} />);
    rerender(<Probe value="eligible" settled />);
    expect(screen.getByText("still")).toBeTruthy();
    rerender(<Probe value="needs_confirmation" settled />);
    expect(screen.getByText("changed")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1300));
    expect(screen.getByText("still")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("StatusTag", () => {
  it("names each status in words, not color alone", () => {
    render(
      <>
        <StatusTag status="eligible" />
        <StatusTag status="held" />
        <StatusTag status="excluded" />
        <StatusTag status="needs_confirmation" />
        <StatusTag status="unknown_rule" />
      </>,
    );
    for (const label of ["Eligible", "Held", "Excluded", "Needs confirmation", "Not included"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

describe("Ledger row", () => {
  const law: LawIndex = {
    law: null,
    sha256: null,
    rule: () => undefined,
    source: () => undefined,
    byCategory: () => [],
  };
  const exam: ScanItem = {
    item_id: "rcpt:1",
    date: "2026-06-14",
    amount_cents: 32500,
    expense: "forensic_exam",
    confirmed: true,
    insurance_paid_cents: 0,
    is_bill: true,
    units: 0,
    description: "Forensic exam",
  };
  const line: EngineLine = {
    item_id: "rcpt:1",
    expense: "medical",
    status: "eligible",
    requested_cents: 32500,
    allowed_cents: 32500,
    rule_ids: [],
    cap_rule_id: null,
    flags: [],
  };

  it("explains an exam counted as medical care from the engine's expense, not a preview-only flag", () => {
    const row: Row = { item: exam, line, answer: undefined, status: "eligible", bed: "medical" };
    render(<LedgerRow row={row} law={law} onAnswer={() => {}} readOnly />);
    expect(screen.getByText(/counts it as medical care/)).toBeTruthy();
  });

  it("says nothing extra for a medical bill", () => {
    const row: Row = {
      item: { ...exam, expense: "medical" },
      line,
      answer: undefined,
      status: "eligible",
      bed: "medical",
    };
    render(<LedgerRow row={row} law={law} onAnswer={() => {}} readOnly />);
    expect(screen.queryByText(/counts it as medical care/)).toBeNull();
  });
});

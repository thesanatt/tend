// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Plant from "@/components/Plant";
import QuickExit, { EXIT_URL, navigation } from "@/components/QuickExit";
import StatusTag from "@/components/StatusTag";

afterEach(() => cleanup());

describe("Exit this page", () => {
  let replace: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    replace = vi.fn();
    navigation.replace = replace as unknown as typeof navigation.replace;
    delete document.documentElement.dataset.exiting;
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

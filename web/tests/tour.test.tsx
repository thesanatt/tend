// @vitest-environment jsdom
// The visitor tour: notes appear only in tour mode, one per step, in English only, and Exit tour ends it.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FlowFrame from "@/components/flow/FlowFrame";
import { leaveNow, navigation } from "@/components/QuickExit";
import TourNote from "@/components/tour/TourNote";
import {
  boldParts,
  exitTour,
  TOUR_NOTES,
  TOUR_START,
  TOUR_STEPS,
  TOUR_SUMMARY,
  tourInUrl,
  tourStep,
  type TourStep,
} from "@/components/tour/tour";
import { TOUR_KEY } from "@/lib/keys";
import { MI_CHECK, renderFlow, stateFrom, stubLawFetch } from "./helpers/flow";

const nav = vi.hoisted(() => ({ replace: vi.fn(), path: "/check" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  usePathname: () => nav.path,
}));

const PATHS: Record<TourStep, string> = {
  check: "/check",
  gather: "/gather",
  bills: "/gather/bills",
  packet: "/packet",
  track: "/track",
};

function at(path: string, search = "") {
  nav.path = path;
  window.history.replaceState(null, "", path + search);
}

function note() {
  return screen.queryByRole("complementary", { name: /^Tour, step/ });
}

beforeEach(() => {
  stubLawFetch();
  sessionStorage.clear();
  at("/check");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.documentElement.lang = "en";
});

describe("tour mode", () => {
  it("shows no tour note to a normal visitor", () => {
    for (const step of TOUR_STEPS) {
      at(PATHS[step]);
      const { unmount } = renderFlow(<TourNote />);
      expect(note()).toBeNull();
      expect(screen.queryByRole("button", { name: "Exit tour" })).toBeNull();
      unmount();
    }
    expect(sessionStorage.getItem(TOUR_KEY)).toBeNull();
  });

  it("starts from tour=1 in the link and stays on for the tab", () => {
    at("/check", "?demo=rowan&tour=1");
    const first = renderFlow(<TourNote />);
    expect(note()).not.toBeNull();
    expect(sessionStorage.getItem(TOUR_KEY)).toBe("1");
    first.unmount();

    // The step links carry no tour=1; the tab remembers it.
    at("/gather");
    renderFlow(<TourNote />);
    expect(note()?.getAttribute("data-tour-step")).toBe("gather");
  });

  it("shows the right note on each step, with what to click next", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    TOUR_STEPS.forEach((step, i) => {
      at(PATHS[step]);
      const { unmount } = renderFlow(<TourNote />);
      const aside = note()!;
      expect(aside.getAttribute("data-tour-step")).toBe(step);
      expect(screen.getByText(`Tour, step ${i + 1} of 5: ${TOUR_NOTES[step].title}`)).toBeTruthy();
      expect(aside.textContent).toContain(
        boldParts(TOUR_NOTES[step].what)
          .map((p) => p.text)
          .join(""),
      );
      expect(aside.textContent).toContain("Next: ");
      expect(screen.getByRole("button", { name: "Exit tour" })).toBeTruthy();
      unmount();
    });
  });

  it("names the exact buttons to click, in bold", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    const expected: Record<TourStep, string[]> = {
      check: ["Find my costs"],
      gather: [
        "See the sample statement (PDF)",
        "Use a sample statement",
        "Add another record",
        "Use a sample bill",
        "Use the demo bank account",
        "Next: your bill",
      ],
      bills: ["Pay $118.00 now from Checking 0011", "Get a code", "Pay $118.00", "Build my packet"],
      packet: ["See your garden"],
      track: [],
    };
    for (const step of TOUR_STEPS) {
      at(PATHS[step]);
      const { container, unmount } = renderFlow(<TourNote />);
      expect([...container.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(expected[step]);
      unmount();
    }
  });

  it("says the facts each step is about", () => {
    expect(TOUR_NOTES.check.why).toContain("every line links to the exact sentence");
    expect(TOUR_NOTES.gather.what).toContain("190 transactions on this device; nothing is uploaded");
    expect(TOUR_NOTES.bills.what).toContain("Line 2 is a $325 forensic exam");
    expect(TOUR_NOTES.bills.what).toContain("$118");
    expect(TOUR_NOTES.packet.what).toContain("Michigan's real application, filled with safe fields only");
    expect(TOUR_NOTES.packet.why).toContain("Wi-Fi off");
    expect(TOUR_NOTES.track.what).toContain("The $325 never grows.");
  });

  it("ends on Track with a link to the summary", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    at("/track");
    renderFlow(<TourNote />);
    const link = screen.getByRole("link", { name: "What you just saw" });
    expect(link.getAttribute("href")).toBe(TOUR_SUMMARY);
  });

  it("shows nothing off the five steps", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    for (const path of ["/", "/mi", "/sources", "/how-it-works", "/share", "/law/MI"]) {
      expect(tourStep(path)).toBeNull();
    }
  });

  it("shows no English note in the Spanish UI", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    renderFlow(<TourNote />, { lang: "es" });
    expect(note()).toBeNull();
  });

  it("Exit tour hides the note, clears the flag, drops tour=1, and does not come back", () => {
    at("/check", "?demo=rowan&tour=1");
    const first = renderFlow(<TourNote />);
    fireEvent.click(screen.getByRole("button", { name: "Exit tour" }));
    expect(note()).toBeNull();
    expect(sessionStorage.getItem(TOUR_KEY)).toBeNull();
    expect(window.location.search).toBe("?demo=rowan");
    first.unmount();

    at("/gather");
    renderFlow(<TourNote />);
    expect(note()).toBeNull();
  });

  it("Exit this page ends the tour with the rest of the tab", () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    const replace = vi.spyOn(navigation, "replace").mockImplementation(() => {});
    leaveNow();
    expect(sessionStorage.getItem(TOUR_KEY)).toBeNull();
    replace.mockRestore();
    delete document.documentElement.dataset.exiting;
  });

  it("sits at the top of each flow step, above the screen", async () => {
    sessionStorage.setItem(TOUR_KEY, "1");
    at("/gather");
    renderFlow(
      <FlowFrame>
        <h1>Gather your costs</h1>
      </FlowFrame>,
      { initial: stateFrom([MI_CHECK]) },
    );
    await act(async () => {});
    const aside = note()!;
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(aside.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    exitTour();
  });

  it("starts at the Rowan demo with tour=1", () => {
    expect(TOUR_START).toBe("/check?demo=rowan&tour=1");
    expect(tourInUrl("?demo=rowan&tour=1")).toBe(true);
    expect(tourInUrl("?demo=rowan")).toBe(false);
    expect(tourInUrl("?tour=0")).toBe(false);
  });
});

describe("tour copy", () => {
  const all = TOUR_STEPS.flatMap((s) => {
    const n = TOUR_NOTES[s];
    return [n.title, n.what, n.why, n.next, n.link?.label ?? ""];
  });

  it("is ASCII, with no dashes standing in for punctuation and no exclamation marks", () => {
    for (const text of all) {
      expect(text).toMatch(/^[\x20-\x7e]*$/);
      expect(text).not.toMatch(/!| - |--/);
    }
  });

  it("uses no hype words", () => {
    for (const text of all) {
      expect(text).not.toMatch(/\b(revolutionary|cutting-edge|seamless|empower|unlock)\b/i);
    }
  });

  it("keeps sentences short", () => {
    for (const text of all) {
      for (const sentence of text.split(/(?<=\.)\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(28);
    }
  });
});

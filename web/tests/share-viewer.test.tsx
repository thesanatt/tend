// @vitest-environment jsdom
// The advocate viewer at /share#<id>.<key>: opens once per link, shows the claim read-only, and
// builds the cited summary in the browser.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenShare from "@/app/share/OpenShare";
import ShareScreen from "@/app/share/[token]/ShareScreen";
import type { SharedPacket } from "@/lib/contracts";
import type { BuiltPacket, TendPacketBuilder } from "@/lib/packet";
import { ShareError, type ShareMeta, type TendShare } from "@/lib/share";
import { rowanInput, rowanOutput, webLaw } from "./trust-helpers";

const KEY = "k".repeat(43);
const packet = (): SharedPacket => ({
  st: "MI",
  created_at: "2026-10-03T16:20:00Z",
  input: rowanInput(),
  output: rowanOutput(),
  notes: "Fictional demo claim for the walkthrough",
  date_known: true,
});

function client(open: (link: string) => Promise<{ packet: SharedPacket; meta: ShareMeta }>) {
  const calls: string[] = [];
  const c: TendShare = {
    seal: vi.fn(),
    open: vi.fn(),
    revoke: vi.fn(),
    openWithMeta: (link: string) => {
      calls.push(link);
      return open(link);
    },
  };
  return { client: c, calls };
}

let n = 0;
const link = () => `#tok_viewer_test_${String(++n).padStart(4, "0")}.${KEY}`;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).startsWith("/data/law/MI.json")
        ? new Response(JSON.stringify(webLaw("MI")), { status: 200 })
        : new Response("not found", { status: 404 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the built-in demo link", () => {
  it("does not say a fixed date when the link stops working", async () => {
    render(<ShareScreen token="demo" />);
    expect(await screen.findByRole("heading", { name: "Claim summary" })).toBeTruthy();
    expect(screen.queryByText(/The link stops working/)).toBeNull();
    expect(screen.queryByText(/This link has expired/)).toBeNull();
  });
});

describe("the advocate viewer", () => {
  it("opens the link once, even when React renders twice, and shows the claim read-only", async () => {
    window.location.hash = link();
    const meta: ShareMeta = {
      id: "x",
      expires_at: "2026-10-10T16:20:00Z",
      once: true,
      created_at: "2026-10-03T16:20:00Z",
    };
    const { client: c, calls } = client(async () => ({ packet: packet(), meta }));
    render(
      <StrictMode>
        <OpenShare client={c} />
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "Claim summary" })).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(screen.getByText(/Read-only view for an advocate/)).toBeTruthy();
    expect(screen.getByText(/Tend's server keeps only a locked copy it cannot read/)).toBeTruthy();
    // What a share holds, said plainly: guesses and unsorted purchases come with their bank words.
    expect(
      screen.getByText(/guesses still waiting for a yes and purchases Tend could not sort, each with its date/),
    ).toBeTruthy();
    expect(screen.queryByText(/not bank account details/)).toBeNull();
    expect(screen.getByText(/This link opens one time only/)).toBeTruthy();
    expect(screen.getByText("Amount they can ask for. The program decides.")).toBeTruthy();
    expect(screen.getAllByText("$3,142.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Fictional demo claim for the walkthrough")).toBeTruthy();
    // Read-only: no yes / no answers to give.
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("cites a ride to the rule that covers rides to care, then both trip-length limits", async () => {
    window.location.hash = link();
    const meta: ShareMeta = { id: "x", expires_at: "2026-10-10T16:20:00Z", once: false, created_at: null };
    const { client: c } = client(async () => ({ packet: packet(), meta }));
    render(<OpenShare client={c} />);
    const cites = await screen.findAllByRole("button", { name: /show the law for Wayfare Rides/ });
    // Not MCL 18.361(2)(e)(ii), the $5,000 limit for trips of 50 miles or more.
    await waitFor(() => expect(cites[0].textContent).toMatch(/^MCL 18\.361\(2\)\(e\) \+2:/));
    // jsdom has no modal dialogs, so the sheet opens as a plain open dialog.
    const proto = HTMLDialogElement.prototype as { showModal?: () => void };
    const showModal = proto.showModal;
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    try {
      fireEvent.click(cites[0]);
      await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
      const sheet = document.querySelector("dialog[open]")!;
      const law = webLaw("MI");
      for (const id of ["MI-COV-7", "MI-CAP-7", "MI-CAP-8"]) {
        expect(sheet.textContent).toContain(law.rules.find((r) => r.id === id)!.quote);
      }
      expect(sheet.textContent).toContain("The law sets more than one limit for this kind of cost.");
    } finally {
      proto.showModal = showModal;
    }
  });

  it("explains a link with no key, and a link that no longer works", async () => {
    const { client: none } = client(async () => {
      throw new Error("not called");
    });
    render(<OpenShare client={none} />);
    expect(await screen.findByRole("heading", { name: "Open a shared claim" })).toBeTruthy();
    cleanup();

    window.location.hash = link();
    const { client: gone } = client(async () => {
      throw new ShareError("gone");
    });
    render(<OpenShare client={gone} />);
    expect(await screen.findByRole("heading", { name: "This link does not work now" })).toBeTruthy();
    expect(screen.getByText(/expired, was turned off, or was already opened once/)).toBeTruthy();
  });

  it("offers to try again after a dropped connection", async () => {
    window.location.hash = link();
    let fail = true;
    const meta: ShareMeta = { id: "x", expires_at: null, once: false, created_at: null };
    const { client: c, calls } = client(async () => {
      if (fail) throw new ShareError("network");
      return { packet: packet(), meta };
    });
    render(<OpenShare client={c} />);
    expect(await screen.findByRole("heading", { name: "Tend could not reach its server" })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Claim summary" })).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("builds the cited summary in the browser when asked", async () => {
    window.location.hash = link();
    const meta: ShareMeta = { id: "x", expires_at: null, once: false, created_at: null };
    const { client: c } = client(async () => ({ packet: packet(), meta }));
    const summaryPdf = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const build = vi.fn(async () => ({ summaryPdf, formPdf: null, notes: [] }) as unknown as BuiltPacket);
    const builder = { build, letterPdf: vi.fn() } as unknown as TendPacketBuilder;
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:summary"));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<OpenShare client={c} builder={builder} />);
    const button = await screen.findByRole("button", { name: "Download the cited summary (PDF)" });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(build).toHaveBeenCalledWith("MI", packet().input, packet().output, { dateKnown: true });
    expect(created).toEqual([summaryPdf]);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("with no date shared, gives no day to file by, on the page or in the PDF", async () => {
    window.location.hash = link();
    const meta: ShareMeta = { id: "x", expires_at: null, once: false, created_at: null };
    // The earliest cost stands in for the date it happened; the engine dated its deadline from it.
    const undated = { ...packet(), date_known: false };
    const { client: c } = client(async () => ({ packet: undated, meta }));
    const build = vi.fn(async () => ({ summaryPdf: new Blob(["%PDF-1.7"]), formPdf: null, notes: [] }) as unknown as BuiltPacket);
    const builder = { build, letterPdf: vi.fn() } as unknown as TendPacketBuilder;
    URL.createObjectURL = vi.fn(() => "blob:summary");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<OpenShare client={c} builder={builder} />);
    expect(await screen.findByText(/^They have 5 years from the date it happened to apply\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/File by|The usual deadline was/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download the cited summary (PDF)" }));
    });
    await waitFor(() => expect(build).toHaveBeenCalledWith("MI", undated.input, undated.output, { dateKnown: false }));
    click.mockRestore();
  });

  it("shows a plain message, not a library error, when the PDF cannot be made", async () => {
    window.location.hash = link();
    const meta: ShareMeta = { id: "x", expires_at: null, once: false, created_at: null };
    const { client: c } = client(async () => ({ packet: packet(), meta }));
    const build = vi.fn(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'getForm')");
    });
    const builder = { build, letterPdf: vi.fn() } as unknown as TendPacketBuilder;
    render(<OpenShare client={c} builder={builder} />);
    const button = await screen.findByRole("button", { name: "Download the cited summary (PDF)" });
    await act(async () => {
      fireEvent.click(button);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The PDF could not be made in this browser.");
    expect(alert.textContent).not.toContain("getForm");
  });

  it("speaks to the advocate about the survivor: they and their, never you and your", async () => {
    window.location.hash = link();
    const meta: ShareMeta = { id: "x", expires_at: null, once: false, created_at: null };
    const { client: c } = client(async () => ({ packet: packet(), meta }));
    render(<OpenShare client={c} />);
    // Once the law loads, every citation names its law; their sheets are in the page, closed.
    const cites = await screen.findAllByRole("button", { name: /^MCL / }, { timeout: 15_000 });
    expect(cites.length).toBeGreaterThan(40);
    // A rule's quote and plain summary are law data, changed only through rules/tools/verify.py; this
    // checks Tend's own words around them.
    let text = document.body.textContent!;
    for (const rule of webLaw("MI").rules) {
      for (const own of [rule.quote, rule.summary]) if (own) text = text.split(own).join(" ");
    }
    for (const sentence of [
      "Their forensic exam counts in place of a police report here.",
      "The law counts from their report, so they may have longer.",
      "Their costs are at or over the program's minimum of $200.00.",
      "The law says they should not be billed for this, so it should not be paid.",
      "It is not counted until they say yes.",
      "It counts toward the amount they can ask for.",
    ]) {
      expect(text).toContain(sentence);
    }
    expect(text).toContain("Billing them for the forensic exam");
    // Nothing here speaks to the survivor. ("You" would be the advocate, and nothing on this claim needs it.)
    expect(text.match(/[^.]*\b(you|your)\b[^.]*/gi) ?? []).toEqual([]);
    // The whole claim with its 60-odd citations takes a while to draw when the suite runs in parallel.
  }, 20_000);

  it("gives every citation a 44 px target", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../components/Citation.module.css"), "utf8");
    expect(css).toMatch(/\.cite \{[^}]*min-height: 44px;/);
  });
});

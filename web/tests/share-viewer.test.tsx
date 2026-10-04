// @vitest-environment jsdom
// The advocate viewer at /share#<id>.<key>: opens once per link, shows the claim read-only, and
// builds the cited summary in the browser.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenShare from "@/app/share/OpenShare";
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
    expect(screen.getByText(/This link opens one time only/)).toBeTruthy();
    expect(screen.getByText("Amount they can ask for. The program decides.")).toBeTruthy();
    expect(screen.getAllByText("$3,142.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Fictional demo claim for the walkthrough")).toBeTruthy();
    // Read-only: no yes / no answers to give.
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
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
    expect(build).toHaveBeenCalledWith("MI", packet().input, packet().output);
    expect(created).toEqual([summaryPdf]);
    expect(click).toHaveBeenCalledTimes(1);
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
});

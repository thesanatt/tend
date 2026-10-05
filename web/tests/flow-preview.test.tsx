// @vitest-environment jsdom
// Previewing a record in Gather: PDF pages, statement rows, and bill photos, all from memory on this
// device. pdf.js drawing is stubbed (jsdom has no canvas); the readers are the flow's usual ones.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitControl } from "@/components/flow/ExitControl";
import GatherScreen from "@/components/flow/gather/GatherScreen";
import { pageSize } from "@/components/flow/preview/PdfPreview";
import { heldCount } from "@/components/flow/preview/release";
import TablePreview from "@/components/flow/preview/TablePreview";
import PrivacyLine from "@/components/flow/PrivacyLine";
import { sampleStatementCsv } from "@/components/flow/samples";
import { navigation } from "@/components/QuickExit";
import type { StatementTxn } from "@/lib/contracts";
import { I18nProvider } from "@/lib/i18n";
import { MI_CHECK, renderFlow, stateFrom, stubLawFetch } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/gather",
}));

// pdf.js stands in for the preview only; reading the statement still uses the real lib/local/pdf.
const pdf = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/local/pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local/pdf")>()),
  openPdfView: pdf.open,
}));

interface Drawn {
  page: number;
  width: number;
  height: number;
  transform?: number[];
}

// A letter-size document of `pages` pages that records what it was asked to draw.
function fakePdf(pages: number) {
  const drawn: Drawn[] = [];
  const cleanups = vi.fn();
  const destroy = vi.fn(async () => {});
  const doc = {
    numPages: pages,
    getPage: vi.fn(async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }),
      render: ({ canvas, transform }: { canvas: HTMLCanvasElement; transform?: number[] }) => {
        drawn.push({ page: n, width: canvas.width, height: canvas.height, transform });
        return { promise: Promise.resolve(), cancel: vi.fn() };
      },
      cleanup: cleanups,
    })),
  };
  pdf.open.mockImplementation(async () => ({ promise: Promise.resolve(doc), destroy }));
  return { drawn, destroy, cleanups, doc };
}

const QUIET = "On this device. Nothing has left it.";
let fetchMock: ReturnType<typeof stubLawFetch>;
let replace: ReturnType<typeof vi.fn>;
const originalReplace = navigation.replace;

beforeEach(() => {
  fetchMock = stubLawFetch();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.stubGlobal("devicePixelRatio", 2);
  replace = vi.fn();
  navigation.replace = replace as unknown as typeof navigation.replace;
  delete document.documentElement.dataset.exiting;
  pdf.open.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  navigation.replace = originalReplace;
  delete document.documentElement.dataset.exiting;
});

function gather() {
  return renderFlow(
    <>
      <PrivacyLine />
      <ExitControl />
      <GatherScreen />
    </>,
    { initial: stateFrom([MI_CHECK]) },
  );
}

// Once something is read, the ways to add a record (and the list of what was read) fold away.
function openAddMore() {
  const details = screen.queryByText("Add another record")?.closest("details");
  if (details) details.open = true;
}

describe("PDF preview", () => {
  it("sizes the canvas to the sheet and the device's pixels", () => {
    expect(pageSize(612, 792, 400, 2)).toEqual({ scale: 400 / 612, ratio: 2, width: 800, height: 1035 });
    expect(pageSize(612, 792, 306, 1)).toMatchObject({ scale: 0.5, ratio: 1, width: 306, height: 396 });
    // A missing ratio counts as 1; a very dense screen is held to 3x.
    expect(pageSize(612, 792, 306, 0).ratio).toBe(1);
    expect(pageSize(612, 792, 306, 4).ratio).toBe(3);
  });

  it("opens the sample statement at page 1, pages through, and destroys the document on close", async () => {
    const { drawn, destroy, cleanups } = fakePdf(5);
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    expect(await screen.findByText(/sample-statement-fictional\.pdf: 190 transactions read/)).toBeTruthy();
    openAddMore();
    const fetchesBefore = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Preview sample-statement-fictional.pdf" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { level: 2, name: "sample-statement-fictional.pdf" })).toBeTruthy();
    expect(within(sheet).getByText("This preview stays on your device.")).toBeTruthy();
    expect(await within(sheet).findByText("Page 1 of 5")).toBeTruthy();
    const canvas = within(sheet).getByRole("img", { name: "Page 1 of 5 of the statement" });
    await waitFor(() => expect(drawn).toHaveLength(1));
    // Page 1 first, as wide as the sheet (400px) times the device's 2x pixels.
    expect(drawn[0]).toEqual({ page: 1, width: 800, height: 1035, transform: [2, 0, 0, 2, 0, 0] });
    expect((canvas as HTMLCanvasElement).width).toBe(800);
    expect(pdf.open).toHaveBeenCalledTimes(1);
    expect(new TextDecoder("latin1").decode((pdf.open.mock.calls[0][0] as Uint8Array).slice(0, 5))).toBe("%PDF-");

    const previous = within(sheet).getByRole("button", { name: "Previous page" });
    const next = within(sheet).getByRole("button", { name: "Next page" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(within(sheet).getByText("Page 1 of 5")).toBeTruthy();
    fireEvent.click(next);
    expect(await within(sheet).findByText("Page 2 of 5")).toBeTruthy();
    expect(within(sheet).getByRole("img", { name: "Page 2 of 5 of the statement" })).toBeTruthy();
    await waitFor(() => expect(drawn.map((d) => d.page)).toEqual([1, 2]));
    for (let i = 0; i < 5; i++) fireEvent.click(next);
    expect(await within(sheet).findByText("Page 5 of 5")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-disabled")).toBeNull();
    await waitFor(() => expect(cleanups).toHaveBeenCalled());

    // Nothing was fetched and the privacy line did not move.
    expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
    expect(screen.getAllByText(QUIET).length).toBeGreaterThan(0);
    expect(heldCount()).toBe(1);

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(heldCount()).toBe(0);
  });

  it("shows a one-page bill without page buttons, named for the bill", async () => {
    fakePdf(1);
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use a sample bill" }));
    expect(await screen.findByText(/Riverbend General Hospital: 3 lines/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview riverbend-itemized-statement-fictional.pdf" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("img", { name: "Page 1 of 1 of the bill" })).toBeTruthy();
    expect(within(sheet).getByText("Page 1 of 1")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("says so when the file cannot be shown", async () => {
    pdf.open.mockRejectedValue(new Error("bad file"));
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    expect(await screen.findByText(/190 transactions read/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview sample-statement-fictional.pdf" }));
    expect(await screen.findByText("Tend could not show a preview of this file.")).toBeTruthy();
  });
});

describe("table preview", () => {
  it("shows a CSV statement's first 25 rows with headers, the count, and signed amounts", async () => {
    gather();
    fireEvent.change(document.getElementById("statement-file")!, {
      target: { files: [new File([sampleStatementCsv()], "rowan.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText(/rowan\.csv: 190 transactions read/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview rowan.csv" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { level: 2, name: "rowan.csv" })).toBeTruthy();
    expect(within(sheet).getByText("rowan.csv: 190 rows.")).toBeTruthy();
    expect(within(sheet).getByText("Showing 25 of 190 rows")).toBeTruthy();
    const table = within(sheet).getByRole("table", { name: "The first rows of rowan.csv" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Date", "Description", "Amount"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(25);
    expect(rows[0].textContent).toBe("04/01/2026Larkfield Market - groceries-$19.00");
    expect(rows[1].textContent).toBe("04/03/2026Fernway Books payroll+$412.00");
    // The table scrolls in its own region, which the keyboard can reach.
    const region = within(sheet).getByRole("region", { name: /Rows from the file/ });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.contains(table)).toBe(true);
    expect(pdf.open).not.toHaveBeenCalled();
  });

  it("shows the demo bank's rows as Tend read them", async () => {
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use the demo bank account" }));
    expect(await screen.findByText(/Demo bank: 191 transactions read/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo bank (Checking)" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { level: 2, name: "Demo bank (Checking)" })).toBeTruthy();
    expect(within(sheet).getByText("Showing 25 of 191 rows")).toBeTruthy();
    expect(within(sheet).getAllByRole("row")[1].textContent).toBe("04/01/2026Larkfield Market - groceries-$19.00");
  });

  it("counts a short file whole, and says when there are no rows", () => {
    const txn = (i: number, cents: number): StatementTxn => ({
      id: `csv:${i}`,
      date: "2026-06-1" + i,
      amount_cents: cents,
      description: `Row ${i}`,
      origin: "csv",
    });
    render(
      <I18nProvider initial="es">
        <TablePreview name="corto.csv" rows={[txn(1, 500), txn(2, -1200), txn(3, 99)]} />
      </I18nProvider>,
    );
    expect(screen.getByText("Mostrando las 3 filas")).toBeTruthy();
    expect(screen.getByText("corto.csv: 3 filas.")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Fecha", "Descripción", "Monto"]);
    expect(screen.getByText("+$12.00")).toBeTruthy();
    cleanup();
    render(
      <I18nProvider initial="en">
        <TablePreview name="empty.csv" rows={[]} />
      </I18nProvider>,
    );
    expect(screen.getByText("Tend found no rows in this file.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("image preview", () => {
  function stubObjectUrls() {
    let n = 0;
    const create = vi.fn(() => `blob:tend/${++n}`);
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    return { create, revoke };
  }

  async function addPhoto() {
    fireEvent.change(document.getElementById("bill-file")!, {
      target: { files: [new File(["\xff\xd8 photo"], "bill-photo.jpg", { type: "image/jpeg" })] },
    });
    expect(await screen.findByText("bill-photo.jpg: Tend couldn't read this reliably.")).toBeTruthy();
    openAddMore();
  }

  it("shows a bill photo from its own object URL and revokes it when the sheet closes", async () => {
    const { create, revoke } = stubObjectUrls();
    gather();
    await addPhoto();
    const made = create.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Preview bill-photo.jpg" }));
    const sheet = await screen.findByRole("dialog");
    const img = (await within(sheet).findByRole("img", {
      name: "The photo you added: bill-photo.jpg",
    })) as HTMLImageElement;
    expect(create).toHaveBeenCalledTimes(made + 1);
    const url = create.mock.results[made].value as string;
    expect(img.getAttribute("src")).toBe(url);
    expect(revoke).not.toHaveBeenCalledWith(url);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
    expect(heldCount()).toBe(0);
  });

  it("falls back to a note when the browser cannot show the photo", async () => {
    stubObjectUrls();
    gather();
    await addPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Preview bill-photo.jpg" }));
    const img = await screen.findByRole("img", { name: "The photo you added: bill-photo.jpg" });
    fireEvent.error(img);
    expect(await screen.findByText("Tend could not show a preview of this file.")).toBeTruthy();
  });
});

describe("quick exit with a preview open", () => {
  it("Esc twice still leaves: the first closes the sheet, the second blanks the page and releases everything", async () => {
    const { destroy } = fakePdf(5);
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:tend/bill"), revokeObjectURL: revoke }),
    );
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use a sample bill" }));
    expect(await screen.findByText(/Riverbend General Hospital: 3 lines/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview riverbend-itemized-statement-fictional.pdf" }));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText("Page 1 of 5");

    // First Esc: the window hears it in the capture phase, and the dialog's own cancel closes the sheet.
    act(() => {
      fireEvent.keyDown(sheet, { key: "Escape" });
      fireEvent(sheet, new Event("cancel", { cancelable: true }));
    });
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.exiting).toBe("true");
    // The bill's own object URL from reading it is released too.
    expect(revoke).toHaveBeenCalledWith("blob:tend/bill");
  });

  it("Exit this page inside the sheet releases the open document", async () => {
    const { destroy } = fakePdf(5);
    gather();
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    expect(await screen.findByText(/190 transactions read/)).toBeTruthy();
    openAddMore();
    fireEvent.click(screen.getByRole("button", { name: "Preview sample-statement-fictional.pdf" }));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText("Page 1 of 5");
    expect(heldCount()).toBe(1);
    fireEvent.click(within(sheet).getByRole("button", { name: "Exit this page" }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(heldCount()).toBe(0);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("offers no preview once the file is gone from memory", () => {
    renderFlow(<GatherScreen />, {
      initial: stateFrom([
        MI_CHECK,
        {
          type: "addSource",
          source: {
            id: "stmt:x",
            kind: "statement",
            label: "saved.csv",
            read: 3,
            found: 0,
            warnings: [],
            sample: false,
          },
          items: [],
        },
      ]),
    });
    openAddMore();
    expect(screen.getByText(/saved\.csv: 3 transactions read/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Preview/ })).toBeNull();
  });
});

// @vitest-environment jsdom
// The survivor flow on the real trust modules: the encrypted vault (lib/vault), sealed share links
// (lib/share), and the packet built on the device (lib/packet). Only storage, the passkey prompt,
// and the share server are stand-ins.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckScreen from "@/components/flow/check/CheckScreen";
import FlowFrame from "@/components/flow/FlowFrame";
import PacketScreen from "@/components/flow/packet/PacketScreen";
import PrivacyLine from "@/components/flow/PrivacyLine";
import type { Action, FlowItem } from "@/components/flow/state";
import { createPacketBuilder } from "@/lib/packet";
import { createShare, parseShareLink } from "@/lib/share";
import { createVault, memoryStore, type PasskeyProvider } from "@/lib/vault";
import { MI_CHECK, renderFlow, stateFrom, stubLawFetch, testServices } from "./helpers/flow";
import { blankForm, fakeShareServer, webLaw } from "./trust-helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/check",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A passkey that always answers with the same PRF secret, as one device's authenticator would.
function fakePasskeys(): PasskeyProvider {
  const secret = new Uint8Array(32).fill(7);
  return {
    available: async () => true,
    register: async () => ({ credentialId: "cred-1", secret: secret.slice() }),
    secret: async () => secret.slice(),
  };
}

function realVault(opts: { idleMs?: number } = {}) {
  const store = memoryStore();
  const vault = createVault({ store, passkeys: fakePasskeys(), iterations: 1000, idleMs: opts.idleMs ?? 0 });
  return { store, vault, services: testServices({ vault, passkeySupported: () => vault.passkeyAvailable() }) };
}

function renderCheck(services: ReturnType<typeof testServices>, lang: "en" | "es" = "en") {
  return renderFlow(
    <FlowFrame>
      <CheckScreen />
    </FlowFrame>,
    { services, initial: stateFrom([MI_CHECK], lang), lang },
  );
}

async function saveWith(how: "passcode" | "passkey", passcode = "garden-42") {
  fireEvent.click(within(screen.getByRole("navigation", { name: /Steps|Pasos/ }).parentElement!).getByRole("button"));
  const sheet = await screen.findByRole("dialog");
  if (how === "passkey") {
    fireEvent.click(await within(sheet).findByRole("button", { name: "Lock with Touch ID or screen lock" }));
  } else {
    fireEvent.change(within(sheet).getByLabelText(/passcode|código/i), { target: { value: passcode } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save with this passcode|Guardar con este código/ }));
  }
  return sheet;
}

describe("the encrypted vault", () => {
  it("saves only ciphertext, offers only the way it was saved, and opens with the right passcode", async () => {
    const { store, services } = realVault();
    renderCheck(services);
    expect(await screen.findByText("You can likely apply in Michigan.")).toBeTruthy();
    await saveWith("passcode");
    expect((await screen.findAllByText("Saved on this device")).length).toBeGreaterThan(0);
    await waitFor(() => expect(store.records.size).toBeGreaterThan(1));
    const disk = JSON.stringify([...store.records.values()]);
    expect(disk).not.toContain("2026-06-14");
    expect(disk).not.toContain('"st"');

    fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeTruthy();
    expect(await screen.findByText("It was saved with a passcode.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open with Touch ID or screen lock" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Passcode"), { target: { value: "garden-43" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That passcode did not work. Try again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Passcode"), { target: { value: "garden-42" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("You can likely apply in Michigan.")).toBeTruthy();
    expect((screen.getByLabelText("Which state did it happen in?") as HTMLSelectElement).value).toBe("MI");
  });

  it("a passkey save opens with the passkey alone", async () => {
    const { services } = realVault();
    renderCheck(services);
    await saveWith("passkey");
    expect((await screen.findAllByText("Saved on this device")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
    expect(await screen.findByText("It was saved with Touch ID or screen lock.")).toBeTruthy();
    expect(screen.queryByLabelText("Passcode")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open with Touch ID or screen lock" }));
    expect(await screen.findByText("You can likely apply in Michigan.")).toBeTruthy();
  });

  it("when the vault locks itself after a quiet stretch, the screen clears and says why", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { vault, services } = realVault({ idleMs: 60_000 });
    renderCheck(services);
    await saveWith("passcode");
    expect((await screen.findAllByText("Saved on this device")).length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeTruthy();
    expect(screen.getByText("It locked by itself after a few minutes without use, to keep it private.")).toBeTruthy();
    expect(vault.isUnlocked()).toBe(false);
    expect(screen.queryByText("You can likely apply in Michigan.")).toBeNull();
  });

  it("a passcode the vault refuses gets a plain reason in Spanish", async () => {
    const { vault, services } = realVault();
    renderCheck(services, "es");
    // Six UTF-16 units but three characters: the sheet lets it through, the vault does not.
    const sheet = await saveWith("passcode", "\u{1F331}\u{1F331}\u{1F331}");
    expect(await within(sheet).findByText("Usa un código más largo.")).toBeTruthy();
    expect(await vault.exists()).toBe(false);
  });
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

const payDip: FlowItem = {
  ...session("stmt:abc:csv:40:pay", "2026-06-26"),
  amount_cents: 21400,
  expense: "lost_wages",
  units: 2,
  unit: "week",
  description: "Fernway Books payroll",
  reason: "A paycheck smaller than usual",
  merchant: undefined,
};

const gathered: Action[] = [
  MI_CHECK,
  {
    type: "addSource",
    source: { id: "s", kind: "statement", label: "s.csv", read: 3, found: 3, warnings: [], sample: true },
    items: [session("stmt:abc:csv:1", "2026-06-17"), session("stmt:abc:csv:2", "2026-06-24"), payDip],
  },
  { type: "answer", ids: [payDip.item_id], value: "yes" },
];

describe("sealed share links", () => {
  it("the server gets only ciphertext; the link carries the key and opens the same claim", async () => {
    const server = fakeShareServer();
    const share = createShare({ fetch: server.fetch, origin: "https://tend.example" });
    renderFlow(
      <>
        <PrivacyLine />
        <PacketScreen />
      </>,
      { services: testServices({ share }), initial: stateFrom(gathered) },
    );
    expect(await screen.findByText("On this device. Nothing has left it.")).toBeTruthy();
    await screen.findByText("$294.00");
    fireEvent.click(screen.getByRole("button", { name: "Make a share link" }));
    const link = (await screen.findByLabelText("Share this link with your advocate:")) as HTMLInputElement;
    expect(link.value).toMatch(/^https:\/\/tend\.example\/share#[\w-]+\.[\w-]{43}$/);
    expect(screen.getByText("On this device, except what you chose to send: a locked share link.")).toBeTruthy();
    expect(screen.getByText(/Stops working/)).toBeTruthy();

    const posts = server.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0].body!);
    expect(Object.keys(body).sort()).toEqual(["alg", "ciphertext", "expires_hours", "iv", "once"]);
    expect(posts[0].body).not.toMatch(/Clearwater|Fernway|MI-|2026-06/);
    expect(posts[0].url).not.toContain(parseShareLink(link.value).key);

    const opened = await createShare({ fetch: server.fetch, origin: null }).open(link.value);
    expect(opened.st).toBe("MI");
    expect(opened.input.items.map((i) => i.item_id)).toEqual(
      expect.arrayContaining(["stmt:abc:csv:1", "stmt:abc:csv:2", payDip.item_id]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop this link" }));
    expect(await screen.findByText("A link you stopped no longer works.")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("with no share server, no link is made and the privacy line stays as it was", async () => {
    const share = createShare({ fetch: fakeShareServer("none").fetch, origin: null });
    renderFlow(
      <>
        <PrivacyLine />
        <PacketScreen />
      </>,
      { services: testServices({ share }), initial: stateFrom(gathered), lang: "es" },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Crear un enlace para compartir" }));
    expect(
      await screen.findByText(
        "Para compartir hace falta el servidor de Tend, y ahora no está conectado. No se creó ningún enlace.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("En este dispositivo. No ha salido nada.")).toBeTruthy();
  });
});

describe("the packet built on the device", () => {
  const packetBuilder = createPacketBuilder({ loadLaw: async (st) => webLaw(st), loadForm: blankForm });

  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:packet"), revokeObjectURL: vi.fn() }));
  });

  // Role queries are slow on a page this long in jsdom, so these look things up by text.
  it("fills Michigan's form, lists what is still needed in the program's words, and offers the right letters", async () => {
    renderFlow(<PacketScreen />, { services: testServices({ packetBuilder }), initial: stateFrom(gathered) });
    const form = await screen.findByText("Download the filled form", {}, { timeout: 10_000 });
    expect(form.getAttribute("download")).toBe("MI-application.pdf");
    expect(screen.getByText("Download the summary (PDF)").getAttribute("href")).toBe("blob:packet");

    const wages = screen.getByLabelText("Pay stubs from just before the injury, if not self-employed.");
    fireEvent.click(within(wages.closest("li")!).getByText("Template"));
    const letter = await screen.findByRole("dialog");
    expect(within(letter).getByText("Letter for your employer")).toBeTruthy();
    expect(letter.querySelector("pre")!.textContent).toContain("To: [Employer name]");

    expect(screen.getByText("By email")).toBeTruthy();
    expect(screen.getByText("By mail")).toBeTruthy();
    expect(screen.getByText("By fax")).toBeTruthy();
  }, 20_000);

  it("in Spanish, each document is named in Spanish with the program's own words under it", async () => {
    renderFlow(<PacketScreen />, {
      services: testServices({ packetBuilder }),
      initial: stateFrom(gathered),
      lang: "es",
    });
    const detail = await screen.findByText(
      "Pay stubs from just before the injury, if not self-employed.",
      {},
      { timeout: 10_000 },
    );
    expect(detail.getAttribute("lang")).toBe("en");
    expect(detail.closest("label")!.textContent).toContain("Una carta de tu empleador sobre el trabajo que perdiste");
  }, 20_000);
});

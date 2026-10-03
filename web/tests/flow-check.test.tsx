// @vitest-environment jsdom
// Check (docs/UX.md step 1) and the always-on pieces: the privacy line, language, Exit this page.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppHeader from "@/components/flow/AppHeader";
import CheckScreen from "@/components/flow/check/CheckScreen";
import EngineNotice from "@/components/flow/EngineNotice";
import { ExitControl } from "@/components/flow/ExitControl";
import { useFlow } from "@/components/flow/FlowProvider";
import { EXIT_URL, navigation } from "@/components/QuickExit";
import { EngineUnavailableError } from "@/lib/engine";
import { MI_CHECK, MI_LAW, michiganOutput, renderFlow, stateFrom, stubLawFetch, testServices } from "./helpers/flow";

const nav = vi.hoisted(() => ({ replace: vi.fn(), path: "/check" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  usePathname: () => nav.path,
}));

beforeEach(() => {
  stubLawFetch();
  nav.replace.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.lang = "en";
});

function StateProbe() {
  const { state } = useFlow();
  return <output data-testid="probe">{state.check.st || "empty"}</output>;
}

describe("Check", () => {
  it("asks four things, each with Not sure, and nothing about what happened", () => {
    renderFlow(<CheckScreen />);
    expect(screen.getByLabelText("Which state did it happen in?")).toBeTruthy();
    expect(screen.getByLabelText("On what date did it happen?")).toBeTruthy();
    expect(screen.getByLabelText("I'm not sure of the date")).toBeTruthy();
    const exam = screen.getByRole("group", { name: "Did you have a medical forensic exam?" });
    expect(
      within(exam)
        .getAllByRole("radio")
        .map((r) => r.parentElement!.textContent),
    ).toEqual(["Yes", "No", "Not sure"]);
    const police = screen.getByRole("group", { name: "Has it been reported to police?" });
    expect(
      within(police)
        .getAllByRole("radio")
        .map((r) => r.parentElement!.textContent),
    ).toEqual(["Yes", "Not yet", "No", "Not sure"]);
    expect(screen.getByText("Tend never asks what happened, where, or who.")).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows an instant summary where every sentence carries its citation", async () => {
    renderFlow(<CheckScreen />);
    fireEvent.change(screen.getByLabelText("Which state did it happen in?"), { target: { value: "MI" } });
    fireEvent.change(screen.getByLabelText("On what date did it happen?"), { target: { value: "2026-06-14" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Did you have a medical forensic exam?" })).getByLabelText("Yes"),
    );

    expect(await screen.findByText("You can likely apply in Michigan.")).toBeTruthy();
    expect(await screen.findByText("File by June 14, 2031.")).toBeTruthy();
    expect(screen.getByText("That is 4 years, 8 months from today.")).toBeTruthy();
    expect(screen.getByText("Your forensic exam counts in place of a police report here.")).toBeTruthy();
    expect(screen.getByText("Counseling, up to $125 a session, for up to 35 sessions")).toBeTruthy();
    expect(screen.getByText("In total, up to $45,000")).toBeTruthy();
    expect(
      screen.getByText(
        "Address Confidentiality Program (ACP) gives survivors a substitute address to use on government forms.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("The law keeps your compensation records confidential.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "877-251-7373" }).getAttribute("href")).toBe("tel:8772517373");
    expect(screen.queryByText(/you qualify/i)).toBeNull();

    // Each fact's citation opens the exact words of the law.
    for (const name of [
      /show the law for Who can apply/,
      /show the law for The deadline to apply/,
      /show the law for Police report rules/,
      /show the law for Counseling/,
      /show the law for Keeping your address private/,
      /show the law for Confidential records/,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: /show the law for The deadline to apply/ }));
    const quote = MI_LAW.rules.find((r) => r.id === "MI-FILE-1")!.quote;
    expect(await screen.findByText(quote)).toBeTruthy();

    expect(screen.getByRole("link", { name: "Find my costs" }).getAttribute("href")).toBe("/gather");
    expect(screen.getByRole("button", { name: "Save this" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not today" })).toBeTruthy();
  });

  it("with Not sure for the date, gives the length of time from the rule, never a made-up date", async () => {
    renderFlow(<CheckScreen />, { initial: stateFrom([MI_CHECK, { type: "check", patch: { dateUnsure: true } }]) });
    expect(await screen.findByText("You have 5 years from the date it happened to apply.")).toBeTruthy();
    expect(screen.queryByText(/File by/)).toBeNull();
  });

  it("fills in Rowan's fictional answers only for the demo link", async () => {
    renderFlow(
      <>
        <CheckScreen demo />
        <StateProbe />
      </>,
    );
    expect((await screen.findByTestId("probe")).textContent).toBe("MI");
  });

  it("Not today ends the session without saving and goes back to the start", async () => {
    renderFlow(
      <>
        <CheckScreen />
        <StateProbe />
      </>,
      { initial: stateFrom([MI_CHECK]) },
    );
    fireEvent.click(screen.getByRole("button", { name: "Not today" }));
    expect(await screen.findByText("Nothing stays on this device unless you save it.")).toBeTruthy();
    expect(screen.getByText("In Michigan, the usual deadline is June 14, 2031.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Tend" }));
    expect(nav.replace).toHaveBeenCalledWith("/");
    expect(screen.getByTestId("probe").textContent).toBe("empty");
  });
});

describe("the law engine", () => {
  it("asks before using the server when this browser cannot run the engine, and says so after", async () => {
    const evaluate = vi.fn(async (input, opts: { allowApi: boolean }) => {
      if (!opts.allowApi) throw new EngineUnavailableError("no WebAssembly", true);
      return { output: michiganOutput(input), backend: "api" as const, detail: "native" };
    });
    renderFlow(
      <>
        <AppHeader />
        <EngineNotice />
      </>,
      { services: testServices({ evaluate }), initial: stateFrom([MI_CHECK]) },
    );
    expect(await screen.findByText("Check on Tend's server instead?")).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("On this device. Nothing has left it.");
    fireEvent.click(screen.getByRole("button", { name: "Check on the server" }));
    await screen.findByText(/your claim, to check the law on Tend's server/);
    expect(evaluate).toHaveBeenLastCalledWith(expect.anything(), { allowApi: true });
  });
});

describe("language", () => {
  it("switches every string to Spanish; the law's own words stay in English", async () => {
    renderFlow(
      <>
        <AppHeader />
        <CheckScreen />
      </>,
      { initial: stateFrom([MI_CHECK]) },
    );
    await screen.findByText("You can likely apply in Michigan.");
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    expect(await screen.findByText("Mira lo que tu estado puede pagar")).toBeTruthy();
    expect(document.documentElement.lang).toBe("es");
    expect(screen.getByText("En este dispositivo. No ha salido nada.")).toBeTruthy();
    expect(screen.getByText("Presenta la solicitud a más tardar el 14 de junio de 2031.")).toBeTruthy();
    expect(screen.getByText("Probablemente puedes presentar una solicitud en Michigan.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ver la ley sobre El plazo para presentar la solicitud/ }));
    const quote = MI_LAW.rules.find((r) => r.id === "MI-FILE-1")!.quote;
    const shown = await screen.findByText(quote);
    expect(shown.closest("blockquote")!.getAttribute("lang")).toBe("en");
    expect(screen.getByText("La ley se cita en su idioma original, el inglés.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByText("See what your state can pay for")).toBeTruthy();
  });
});

describe("Exit this page", () => {
  let replace: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    replace = vi.fn();
    navigation.replace = replace as unknown as typeof navigation.replace;
    delete document.documentElement.dataset.exiting;
  });

  it("locks the vault, closes on-device AI, blanks the page, and leaves from the button", () => {
    const releaseDeviceAi = vi.fn();
    const { services } = renderFlow(<ExitControl />, { services: testServices({ releaseDeviceAi }) });
    const lock = vi.spyOn(services.vault, "lock");
    fireEvent.click(screen.getByRole("button", { name: "Exit this page" }));
    expect(lock).toHaveBeenCalled();
    expect(releaseDeviceAi).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(EXIT_URL);
    expect(document.documentElement.dataset.exiting).toBe("true");
  });

  it("leaves on Esc pressed twice, and its label follows the language", () => {
    renderFlow(<ExitControl />, { lang: "es" });
    expect(screen.getByRole("button", { name: "Salir de esta página" })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

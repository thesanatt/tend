// @vitest-environment jsdom
// How it works, as a reporter reads it: Design for safety comes first, every protection links to a file
// that exists in this repo, and each number and limit in the copy is still what the code does.
import { cleanup, render, screen, within } from "@testing-library/react";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HowItWorks from "@/app/how-it-works/page";
import { buildEngineInput } from "@/components/flow/claim";
import { initialState, reducer, type FlowItem, type SourceRecord } from "@/components/flow/state";
import { DOUBLE_PRESS_MS, EXIT_URL, leaveNow, navigation } from "@/components/QuickExit";
import { SITE_CARDS } from "@/components/public/og/siteCard";
import { LINKS } from "@/components/tour/links";
import { fetchLaw } from "@/lib/api";
import { toEngineInput } from "@/lib/engine";
import { en } from "@/lib/i18n/en";
import { LEFT_KEY, TOUR_KEY } from "@/lib/keys";
import { classifier, parseStatementText } from "@/lib/local";
import { classifyRequest } from "@/lib/netlog";
import { MAX_EXPIRES_HOURS } from "@/lib/share";
import STATES from "@/lib/states.json";
import { createVault, memoryStore, MIN_PASSPHRASE } from "@/lib/vault";
import { PBKDF2_ITERATIONS } from "@/lib/vault/crypto";
import { DEFAULT_IDLE_MS } from "@/lib/vault/idle";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");
const BLOB = `${LINKS.repo}/blob/main/`;

const GUARDS = [
  "Exit this page",
  "No name, no story",
  "On this device",
  "Saved progress",
  "Sharing with an advocate",
  "Payments",
];

let section: HTMLElement;
beforeEach(() => {
  render(HowItWorks());
  section = screen.getByRole("region", { name: "Design for safety" });
});
afterEach(() => cleanup());

const text = () => section.textContent!.replace(/\s+/g, " ");
const guard = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li")!;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("Design for safety on /how-it-works", () => {
  it("comes right after the header and takes the place of the old Privacy section", () => {
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2[0]).toBe("Design for safety");
    expect(h2).toContain("The path of a claim");
    expect(h2).not.toContain("Privacy");
  });

  it("names each protection, then what it cannot stop", () => {
    const h3 = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(h3).toEqual([...GUARDS, "What Tend cannot stop"]);
    expect(text()).toContain("Malware on the device, or someone watching the screen.");
    // Check asks which state it happened in, so the copy cannot say no field asks where.
    expect(text()).toContain("Beyond the state, no field anywhere asks where it happened");
    // The four questions are the Check screen's fields, so the item links that screen.
    const check = `a[href="${BLOB}web/components/flow/check/CheckScreen.tsx"]`;
    expect(guard("No name, no story").querySelector(check)).not.toBeNull();
    // HTTPS hides what was sent from the network, but not the site's name.
    expect(readFileSync(path.join(web, "next.config.ts"), "utf8")).toContain('key: "Strict-Transport-Security"');
    expect(text()).toContain("can still see that Tend's site was visited, though not what was sent.");
    expect(within(section).getByRole("link", { name: "docs/PRIVACY.md" }).getAttribute("href")).toBe(LINKS.privacy);
  });

  it("links every protection to files that exist in this repo", () => {
    for (const name of GUARDS) {
      const links = [...guard(name).querySelectorAll<HTMLAnchorElement>(`a[href^="${BLOB}"]`)];
      expect(links.length, name).toBeGreaterThan(0);
      for (const a of links) {
        const file = a.getAttribute("href")!.slice(BLOB.length);
        expect(a.textContent).toBe(file);
        expect(existsSync(path.join(repo, file)), file).toBe(true);
        // A phone wraps the path at a slash, never inside a file name.
        expect(a.querySelectorAll("wbr").length, file).toBe(file.split("/").length - 1);
      }
    }
  });

  it("says what Exit this page does, and what it leaves behind", () => {
    expect(EXIT_URL).toBe("https://www.google.com/search?q=weather");
    expect(DOUBLE_PRESS_MS).toBe(1000);
    const exit = guard("Exit this page").textContent!.replace(/\s+/g, " ");
    expect(exit).toContain("swaps the page for a Google search for the weather");
    expect(exit).toContain("twice within a second");
    expect(exit).toContain("keeping only a flag that marks the exit");
    expect(exit).toContain("Back can still reach an earlier Tend page in the same tab.");
    expect(exit).toContain("Other tabs stay open too");

    // The tab's storage is left holding the one flag and nothing else.
    const replace = navigation.replace;
    navigation.replace = vi.fn();
    sessionStorage.setItem(TOUR_KEY, "1");
    try {
      leaveNow();
      expect(Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))).toEqual([LEFT_KEY]);
    } finally {
      navigation.replace = replace;
      sessionStorage.clear();
      delete document.documentElement.dataset.exiting;
    }
  });

  it("says what the privacy line counts, and what a law file can show", async () => {
    const origin = "https://youreowed.tech";
    const kind = (method: string, p: string) => classifyRequest(method, new URL(p, origin), origin);
    expect(kind("GET", "/data/law/MI.json")).toBeNull();
    expect(kind("GET", "/engine/laws/MI.tlaw")).toBeNull();
    expect(kind("POST", "/api/claim")).toBe("server_engine");
    expect(kind("POST", "/api/shares")).toBe("share");
    // Each state's law is its own file, so the address asked for names the state.
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(String(url));
        return new Response("", { status: 404 });
      }),
    );
    try {
      await fetchLaw("wy");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked).toEqual(["/data/law/WY.json"]);
    const device = guard("On this device").textContent!.replace(/\s+/g, " ");
    // The line's own words, as the flow shows them.
    expect(device).toContain(`starts as "${en.privacy.quiet}"`);
    expect(device).toContain("every answer except the state stay on the device");
    expect(device).toContain("Loading pages and public law files does not change it.");
    expect(device).toContain("can show which state was picked");
  });

  it("says what checking the law on Tend's server sends, and that one yes covers later checks", async () => {
    // Read with the rules alone: the hospital is sorted, the Zelle row is not, and the diner is left out.
    const { txns } = parseStatementText(
      [
        "Date,Description,Amount",
        "2026-06-02,RIVERBEND GENERAL HOSPITAL ER,-412.00",
        "2026-06-04,ZELLE TO JORDAN SMITH,-80.00",
        "2026-06-06,BLUE HERON DINER,-9.40",
      ].join("\n"),
    );
    const read = await classifier.classify(txns, { st: "MI", incident_date: "2026-06-01" }, { deviceAi: false });
    const items: FlowItem[] = read.map((it) => ({ ...it, origin: "statement" }));
    const row = (words: string) => items.find((it) => it.description === words)!;
    expect(row("ZELLE TO JORDAN SMITH").expense).toBe("unknown");
    const diner = row("BLUE HERON DINER").item_id;
    const source: SourceRecord = {
      id: "s",
      kind: "statement",
      label: "s.csv",
      read: 3,
      found: 3,
      warnings: [],
      sample: false,
    };
    let s = reducer(initialState(), { type: "check", patch: { st: "MI", date: "2026-06-01" } });
    s = reducer(s, { type: "addSource", source, items });
    s = reducer(s, { type: "answer", ids: [diner], value: "no" });
    // The body POST /api/claim carries (tests/engine-adapter.test.ts): the unsorted row goes too,
    // unanswered, with the name in its words.
    const body = toEngineInput(buildEngineInput(s, "2026-10-19")!);
    expect(body.items.map((it) => [it.description, it.confirmed])).toEqual([
      ["RIVERBEND GENERAL HOSPITAL ER", true],
      ["ZELLE TO JORDAN SMITH", false],
    ]);
    // The yes stays in the flow state and every later check passes it on, so Tend does not ask again.
    const provider = readFileSync(path.join(web, "components/flow/FlowProvider.tsx"), "utf8");
    expect(provider).toContain(".evaluate(input, { allowApi: state.serverConsent })");
    const yes = reducer(s, { type: "serverConsent" });
    expect(reducer(yes, { type: "answer", ids: [diner], value: null }).serverConsent).toBe(true);
    const device = guard("On this device").textContent!.replace(/\s+/g, " ");
    expect(device).toContain("every cost the person has not left out");
    expect(device).toContain("That includes bank rows Tend could not sort");
    expect(device).toContain("which can include a person's name");
    expect(device).toContain("Tend asks once, and that yes covers later checks.");
  });

  it("says when saved progress locks, and that switching away is not one of those times", async () => {
    const activity = new EventTarget();
    const exit = new EventTarget();
    const vault = createVault({ store: memoryStore(), iterations: 1000, activity, exit });
    await vault.create({ passphrase: "maple river 42" });
    activity.dispatchEvent(new Event("visibilitychange"));
    expect(vault.isUnlocked()).toBe(true);
    exit.dispatchEvent(new Event("pagehide"));
    expect(vault.isUnlocked()).toBe(false);
    const idle = readFileSync(path.join(web, "lib/vault/idle.ts"), "utf8");
    expect(idle).toContain('const EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;');
    const saved = guard("Saved progress").textContent!.replace(/\s+/g, " ");
    expect(saved).toContain("without a tap, key press, or scroll");
    expect(saved).toContain("Switching to another app or tab does not lock it");
    expect(saved).toContain("can see that saved progress exists, though not what it holds");
  });

  it("says when a share link can be stopped, and when it cannot", () => {
    // The stop button lists the flow's share records: kept for the visit and in saved progress,
    // dropped when the visit ends.
    const record = { id: "s1", url: "/share#s1.k", expires_at: "2026-10-22T00:00:00Z", once: false, revoked: false };
    const visit = reducer(initialState(), { type: "share", record });
    expect(visit.shares).toEqual([record]);
    expect(reducer(visit, { type: "reset", lang: "en" }).shares).toEqual([]);
    expect(reducer(initialState(), { type: "restore", state: visit }).shares).toEqual([record]);
    // ShareBox on the Packet step is the only place that stops a link; the /share viewer has none.
    const stops = ["app", "components", "lib"].flatMap((d) => files(path.join(web, d)));
    expect(
      stops.filter((f) => readFileSync(f, "utf8").includes("share.revoke(")).map((f) => path.relative(web, f)),
    ).toEqual(["components/flow/packet/ShareBox.tsx"]);
    const share = guard("Sharing with an advocate").textContent!.replace(/\s+/g, " ");
    expect(share).toContain("on the Packet step, during the same visit or after opening saved progress");
    expect(share).toContain("no stop button for a link from a visit that was never saved");
    // An open-once link is gone after its first read.
    const api = readFileSync(path.join(repo, "api/tend_api/share.py"), "utf8");
    expect(api).toContain('raise ShareError("This link could be opened once, and it has been.", 410)');
    expect(share).toContain("unless it was set to open once and has already been opened");
  });

  it("matches the vault and share numbers in the code", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(DEFAULT_IDLE_MS).toBe(5 * 60_000);
    expect(MIN_PASSPHRASE).toBe(6);
    expect(MAX_EXPIRES_HOURS).toBe(7 * 24);
    const box = readFileSync(path.join(web, "components/flow/packet/ShareBox.tsx"), "utf8");
    expect(box).toContain("const HOURS = [24, 72, 168] as const;");
    expect(text()).toContain("PBKDF2-SHA-256 with 600,000 iterations");
    expect(text()).toContain("locks after five minutes");
    expect(text()).toContain("as short as six characters");
    expect(text()).toContain("one, three, or seven days");
  });

  it("matches the payment rules in api/tend_api/actions.py", () => {
    const actions = readFileSync(path.join(repo, "api/tend_api/actions.py"), "utf8");
    expect(actions).toMatch(/^CODE_TTL = dt\.timedelta\(minutes=10\)$/m);
    expect(actions).toMatch(/^MAX_ATTEMPTS = 5$/m);
    expect(actions).toContain('code = f"{secrets.randbelow(1_000_000):06d}"');
    expect(actions).toContain("if any(i in held for i in item_ids):");
    // A plain payment is refused only when it adds up to bill lines that include the held one.
    expect(actions).toContain("if req.amount_cents in facts.amounts_with_held():");
    const pay = guard("Payments").textContent!.replace(/\s+/g, " ");
    expect(pay).toContain("6-digit code");
    expect(pay).toContain("works once, for ten minutes, and five wrong tries lock the payment");
    expect(pay).toContain("will not pay a held exam line, alone or together with other lines of the same bill");
  });

  it("keeps the copy plain: ASCII, no dashes for punctuation, no exclamation marks, short sentences", () => {
    expect(text()).toMatch(/^[\x20-\x7e]*$/);
    expect(text()).not.toMatch(/!| - |--/);
    for (const p of section.querySelectorAll("p")) {
      for (const sentence of p.textContent!.trim().split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(28);
      }
    }
  });

  it("still says Tend is not legal advice and the program decides", () => {
    expect(document.body.textContent).toContain("Tend is not legal advice.");
    expect(document.body.textContent).toContain("The program decides.");
  });
});

// The retired chat agents are gone from the repo, so the page must not send a reader looking for them.
describe("the retired agents", () => {
  it("are not named or linked anywhere on the page", () => {
    expect(document.body.textContent).not.toMatch(/Fetch\.ai|ASI:One|Agentverse/i);
    expect(document.querySelector('a[href*="asi1.ai"]')).toBeNull();
  });
});

// Some saved copies are Justia or Cornell LII reproductions, as /data says, so this page calls them saved.
describe("the sources", () => {
  it("are counted as saved, never as official", () => {
    expect(document.body.textContent).toContain("saved sources");
    expect(document.body.textContent).toContain("Source saved with sha256");
    expect(document.body.textContent).not.toMatch(/official/i);
  });
});

// The lead says what Tend does in the home card's words: survivors apply, and Tend never asks for a name.
describe("the lead", () => {
  it("matches the home page's sentence and promises no money", () => {
    expect(document.body.textContent!.replace(/\s+/g, " ")).toContain(SITE_CARDS.home.sentence);
    expect(document.body.textContent).not.toMatch(/already owes/i);
  });
});

// Built at MHacks, but this page and the tour came later. The prize and the last commit before the deadline are links.
describe("who built it, and when", () => {
  it("names the event, links the prize and the last commit before the deadline, and calls the rest later work", () => {
    const small = screen.getByText(/^Built by Sanat Gupta at MHacks 2026 \(Oct 3 to 4\)\./);
    expect(
      within(small).getByRole("link", { name: "Winner of Capital One's Best Use of Nessie prize" }),
    ).toHaveProperty("href", LINKS.devpost);
    expect(within(small).getByRole("link", { name: "5d1f7bd" }).getAttribute("href")).toBe(
      `${LINKS.repo}/tree/5d1f7bd`,
    );
    expect(small.textContent).toContain(
      "Every commit after it is later work, including this page and the guided tour.",
    );
    expect(document.body.textContent).not.toMatch(/24 hours|1st place|solo/i);
  });
});

// A Hackaday reader can check this against engine/scripts/build_wasm.sh: the compiler is not in the WebAssembly.
describe("the engine", () => {
  it("says only the runtime is WebAssembly, and how big the engine and each compiled law are", () => {
    const build = readFileSync(path.join(repo, "engine/scripts/build_wasm.sh"), "utf8");
    expect(build).toContain("src/vm.cpp");
    expect(build).not.toContain("compiler.cpp");
    const wasm = statSync(path.join(web, "public/engine/tend.wasm")).size;
    const laws = readdirSync(path.join(web, "public/engine/laws"))
      .filter((f) => f.endsWith(".tlaw"))
      .map((f) => statSync(path.join(web, "public/engine/laws", f)).size);
    expect(laws).toHaveLength(51);
    const lo = Math.floor(Math.min(...laws) / 1000);
    const hi = Math.ceil(Math.max(...laws) / 1000);
    const numbers = screen.getByRole("region", { name: "The numbers" }).textContent!.replace(/\s+/g, " ");
    expect(numbers).toContain(`${Math.floor(wasm / 1000)} KB law VM`);
    expect(numbers).toContain(`Each state's law arrives already compiled, as its own ${lo} to ${hi} KB file.`);
    const stack = screen.getByRole("region", { name: "The stack" }).textContent!.replace(/\s+/g, " ");
    expect(stack).toContain("tendc compiles each state's law ahead of time and is not part of the WebAssembly build.");
    expect(stack).toContain("so the Python reference engine runs the law on the server");
    expect(document.body.textContent).not.toMatch(/whole law engine|independent/i);
  });
});

describe("what the page says about forms, uploads, and the hackathon", () => {
  it("names the states with no form to link, read from the corpus", () => {
    const none = STATES.filter(({ st }) => {
      const law = JSON.parse(readFileSync(path.join(web, `public/data/law/${st}.json`), "utf8"));
      return st !== "MI" && !law.program.application_pdf_url;
    }).map((s) => s.name);
    expect(none).toEqual(["Maine", "North Dakota", "Tennessee"]);
    const limits = screen.getByRole("region", { name: "Limits" }).textContent!.replace(/\s+/g, " ");
    expect(limits).toContain(
      "Only Michigan's application is pre-filled. For 47 other states, Tend links the program's blank form. For Maine, North Dakota, and Tennessee, it found no form to link.",
    );
    expect(limits).not.toMatch(/one author/);
    const packet = screen.getByRole("heading", { level: 3, name: "Packet" }).closest("li")!;
    expect(packet.textContent).toContain("a link to the program's form when Tend found one");
  });

  it("says a file leaves only after a yes to cloud AI, and that the sponsors backed the hackathon", () => {
    const read = screen.getByRole("heading", { level: 3, name: "Read on the device" }).closest("li")!;
    expect(read.textContent!.replace(/\s+/g, " ")).toContain("Nothing is uploaded unless you say yes to cloud AI.");
    const stack = screen.getByRole("region", { name: "The stack" });
    const terms = within(stack)
      .getAllByRole("term")
      .map((t) => t.textContent);
    expect(terms).toContain("Hackathon tools");
    expect(terms).not.toContain("Sponsors");
    expect(stack.textContent).toContain("The sponsors backed the hackathon, not Tend.");
  });
});

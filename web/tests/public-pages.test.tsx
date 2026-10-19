// @vitest-environment jsdom
// The public pages as people get them: rendered from the synced corpus, every line cited, and the
// share and state-finder controls working without any outside service.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LawPage from "@/app/law/[st]/page";
import Home from "@/app/page";
import StatePage, { generateMetadata } from "@/app/[st]/page";
import LawRefs from "@/components/public/LawRefs";
import { SITE_CARDS } from "@/components/public/og/siteCard";
import ShareButtons from "@/components/public/ShareButtons";
import StateFinder from "@/components/public/StateFinder";
import { LINKS } from "@/components/tour/links";
import STATES from "@/lib/states.json";
import type { Jurisdiction } from "@/lib/types";

const push = vi.fn();
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

const web = path.resolve(import.meta.dirname, "..");
const mi = JSON.parse(readFileSync(path.join(web, "public/data/law/MI.json"), "utf8")) as Jurisdiction;

afterEach(() => cleanup());

async function html(el: Promise<React.ReactElement> | React.ReactElement): Promise<string> {
  return renderToStaticMarkup(await el);
}

describe("state page /mi", () => {
  let page: string;
  beforeEach(async () => {
    page ??= await html(StatePage({ params: Promise.resolve({ st: "mi" }) }));
  });

  it("opens with the Jane Doe heading, the program phone, and four cited key facts", () => {
    expect(page).toContain("If you&#x27;re Jane Doe in Michigan</h1>");
    expect(page).toContain('href="tel:8772517373"');
    for (const pin of ["MCL 18.361(1)", "MCL 18.355(2)", "MCL 18.355a(10)", "MCL 18.355a(2)"])
      expect(page).toContain(pin);
  });

  it("gives every line a disclosure with the quote and a link to the rule", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const facts = [...doc.querySelectorAll("section > ul > li")];
    expect(facts.length).toBeGreaterThan(40);
    for (const li of facts) {
      const details = li.querySelector("details");
      expect(details, li.textContent ?? "").not.toBeNull();
      expect(details!.querySelector("mark, a[href]")).not.toBeNull();
    }
    expect(doc.querySelector('a[href="/law/MI#MI-CAP-1"]')).not.toBeNull();
  });

  it("shows the share card, its sentence, and its citations", () => {
    expect(page).toContain('src="/mi/card.png"');
    expect(page).toContain(
      "If you&#x27;re Jane Doe in Michigan: you can ask for up to $45,000, and a forensic exam can count instead of a police report.",
    );
    expect(page).toContain('href="/law/MI#MI-REPORT-1"');
  });

  it("loads no third-party script or image", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    for (const el of doc.querySelectorAll("script[src], img[src], iframe")) {
      expect(el.getAttribute("src")!.startsWith("/")).toBe(true);
    }
  });

  it("gives the tab a neutral title and the link preview the card sentence", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ st: "mi" }) });
    expect(meta.title).toBe("Michigan");
    expect(meta.description).toMatch(/^If you're Jane Doe in Michigan: /);
    const image = {
      url: "/mi/card.png",
      width: 1200,
      height: 630,
      alt: "If you're Jane Doe in Michigan: you can ask for up to $45,000, and a forensic exam can count instead of a police report.",
    };
    expect(meta.openGraph).toMatchObject({ url: "/mi", title: "If you're Jane Doe in Michigan", images: [image] });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [image] });
    expect(String(meta.metadataBase)).toBe("https://youreowed.tech/");
  });

  it("answers only lowercase two-letter codes it knows", async () => {
    await expect(StatePage({ params: Promise.resolve({ st: "MI" }) })).rejects.toThrow();
    await expect(StatePage({ params: Promise.resolve({ st: "zz" }) })).rejects.toThrow();
    expect(await generateMetadata({ params: Promise.resolve({ st: "zz" }) })).toEqual({});
  });
});

describe("law page /law/MI", () => {
  let page: string;
  beforeEach(async () => {
    page ??= await html(LawPage({ params: Promise.resolve({ st: "MI" }) }));
  });

  it("has an anchor, a quote, and the engine's use for every verified rule", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    for (const r of mi.rules) {
      const article = doc.getElementById(r.id);
      expect(article, r.id).not.toBeNull();
      expect(article!.querySelector("mark")!.textContent).toBe(r.quote);
    }
    expect(doc.querySelectorAll("article").length).toBe(mi.rules.length);
  });

  it("calls the plain-words page what the law says, not what it promises", () => {
    expect(page).toContain(">What Michigan&#x27;s law says, in plain words</a>");
  });

  // Each set-aside reason the normalizer gives today: another person, a case the engine cannot check, nothing to
  // compute, and a less generous duplicate.
  it("names every reason a rule can be set aside", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const steps = doc.querySelector('section[aria-labelledby="h-check"]')!.textContent!.replace(/\s+/g, " ");
    expect(steps).toContain(
      "It sets a rule aside, with a reason, when the rule is about someone other than the survivor, holds only in cases the engine cannot check, has nothing to compute, or sits beside a more generous limit for the same cost.",
    );
    const reasons = new Set(
      STATES.flatMap(({ st }) =>
        (
          JSON.parse(readFileSync(path.join(web, `public/data/ir/${st}.json`), "utf8")) as {
            skipped: { reason: string }[];
          }
        ).skipped.map((s) => s.reason.replace(/ .*$/, "")),
      ),
    );
    expect([...reasons].sort()).toEqual(["applies_to", "expense_cap", "less"]);
  });

  // Indiana's statutes were saved from Justia; Michigan's sources are all its own.
  it("says when some of a state's text was saved from a site that reprints state law", async () => {
    const indiana = await html(LawPage({ params: Promise.resolve({ st: "IN" }) }));
    expect(indiana).toContain(
      "Some statute or regulation text on this page was saved from Justia, which reprints state law. Check the state&#x27;s own code before you rely on it.",
    );
    const fl = await html(LawPage({ params: Promise.resolve({ st: "FL" }) }));
    expect(fl).toContain("saved from Cornell&#x27;s Legal Information Institute, which reprints state law.");
    expect(page).not.toContain("reprints state law");
  });

  it("lists the set-aside rules with their reasons", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const set = doc.getElementById("set-aside")!;
    expect(set.querySelectorAll("li")).toHaveLength(3);
    expect(set.textContent).toContain("less generous duplicate of MI-CAP-3");
  });

  it("prints every source with its full SHA-256 and its saved date", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    for (const s of mi.sources) {
      const li = doc.getElementById(s.id)!;
      expect(li.textContent).toContain(s.sha256);
      expect(li.querySelector("time")!.getAttribute("dateTime")).toBe(s.retrieved_at);
    }
  });

  it("renders the compiled listing at build time, with rule ids linked", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const pre = doc.querySelector("#compiled pre")!;
    const listing = readFileSync(path.join(web, "public/data/asm/MI.txt"), "utf8");
    expect(pre.textContent).toBe(listing.endsWith("\n") ? listing : `${listing}\n`);
    expect(pre.querySelector('a[href="#MI-EXAM-1"]')).not.toBeNull();
    expect(doc.getElementById("asm-aggregate")).not.toBeNull();
  });

  it("says whether the listing was compiled from these rules and this IR", () => {
    const index = JSON.parse(readFileSync(path.join(web, "public/data/asm/index.json"), "utf8")).states.MI;
    const ir = JSON.parse(readFileSync(path.join(web, "public/data/ir/MI.json"), "utf8"));
    const doc = new DOMParser().parseFromString(page, "text/html");
    const facts = doc.querySelector("#compiled dl")!.textContent!;
    expect(facts).toContain(index.rules_fresh ? "Yes. The image names the same SHA-256" : "No. The image was compiled");
    expect(facts).toContain(
      index.ir_fresh ? "Yes. The image carries the SHA-256 of the IR" : `the IR is now version ${ir.ir_version}`,
    );
  });
});

describe("home page", () => {
  it("counts the corpus at build time and links each tile to its state page", async () => {
    render(Home());
    const list = JSON.parse(readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8")) as {
      rules: number;
      sources: number;
    }[];
    const rules = list.reduce((n, j) => n + j.rules, 0).toLocaleString("en-US");
    const sources = list.reduce((n, j) => n + j.sources, 0).toLocaleString("en-US");
    expect(rules).toBe("2,578");
    expect(sources).toBe("824");
    expect(document.body.textContent).toContain(`${rules} verified rules from ${sources} saved sources`);
    // Some saved copies are Justia or Cornell LII reproductions, so neither the count nor the garden says official.
    expect(document.body.textContent).not.toMatch(/official/i);
    expect(screen.getByRole("link", { name: "MI Michigan, 83 rules verified, in bloom" }).getAttribute("href")).toBe(
      "/mi",
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(51);
  });

  // Nothing is owed until the program says yes, and the state's own form asks for a name, so the intro and its
  // link card say "apply" and "without giving Tend their name", in the same words.
  it("says what Tend does in its link card's words, and promises no money", () => {
    render(Home());
    const intro = screen.getByRole("region", { name: "About Tend" });
    expect(intro.textContent!.replace(/\s+/g, " ")).toContain(SITE_CARDS.home.sentence);
    expect(document.body.textContent).not.toMatch(/already owes|promises/i);
  });

  // The Devpost page shows "Winner" for the prize but not the place, and most of the site came after the event.
  it("says when Tend was built and links the prize to a page a reader can check", () => {
    render(Home());
    const intro = screen.getByRole("region", { name: "About Tend" });
    expect(intro.textContent).toContain("Built by Sanat Gupta at MHacks 2026 (Oct 3 to 4).");
    const prize = within(intro).getByRole("link", { name: "Winner of Capital One's Best Use of Nessie prize" });
    expect(prize.getAttribute("href")).toBe(LINKS.devpost);
    expect(intro.textContent).not.toMatch(/24 hours|1st place|solo/i);
  });

  it("tells a survivor that Tend files nothing, that it is a prototype, and where to check", () => {
    render(Home());
    const forYou = screen.getByRole("region", { name: "If you are here for yourself" });
    const text = forYou.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Tend files nothing: you send the claim to the program yourself.");
    expect(text).toContain("No money moves unless you say yes.");
    expect(text).not.toMatch(/Nothing is filed|never been sent/);
    const note = within(forYou).getByText(/^Tend is a prototype\./);
    const start = within(forYou).getByRole("link", { name: "Start a check" });
    expect(note.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // "The program's phone number is on your state's page": the page shows a phone only with its saved source.
    const synced = list().filter((j) => j.rules > 0);
    expect(synced).toHaveLength(51);
    for (const { st } of synced) {
      const law = JSON.parse(readFileSync(path.join(web, `public/data/law/${st}.json`), "utf8")) as Jurisdiction;
      expect(law.program.phone, st).toBeTruthy();
      expect(
        law.sources.some((s) => s.id === law.program.phone_source_id),
        st,
      ).toBe(true);
    }
  });

  // The engine holds an exam charge only where it applies a no-bill rule, so "in most states" needs a majority.
  it("says most states, not all, hold a forensic exam charge", () => {
    render(Home());
    expect(document.body.textContent).toContain("In most states it can also hold a forensic exam charge on a bill");
    const holds = list().filter(({ st }) => {
      const ir = JSON.parse(readFileSync(path.join(web, `public/data/ir/${st}.json`), "utf8")) as {
        rules: { kind: string }[];
      };
      return ir.rules.some((r) => r.kind === "exam_no_bill");
    });
    expect(holds.length).toBeGreaterThan(51 / 2);
    expect(holds.length).toBeLessThan(51);
  });
});

function list(): { st: string; rules: number }[] {
  return JSON.parse(readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8"));
}

describe("share buttons", () => {
  const props = {
    path: "/mi",
    title: "If you're Jane Doe in Michigan",
    text: "If you're Jane Doe in Michigan: you can ask for up to $45,000.",
    imageHref: "/mi/card.png",
    imageName: "tend-mi.png",
  };

  afterEach(() => {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the page link and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ShareButtons {...props} />);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mi`);
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    expect(screen.getByRole("link", { name: "Save the card" }).getAttribute("download")).toBe("tend-mi.png");
  });

  it("shows the link to copy by hand when the browser blocks copying", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<ShareButtons {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect((screen.getByLabelText("Link to this page") as HTMLInputElement).value).toBe(`${window.location.origin}/mi`);
  });

  it("opens the phone's share sheet when there is one, and stays quiet when it is closed", async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" }));
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<ShareButtons {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Share" })));
    expect(share).toHaveBeenCalledWith({ title: props.title, text: props.text, url: `${window.location.origin}/mi` });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("state finder", () => {
  it("asks for a state before it goes anywhere, then opens that state's page", () => {
    push.mockClear();
    render(
      <StateFinder
        states={[
          { st: "MI", name: "Michigan" },
          { st: "NY", name: "New York" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "See what its law says" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a state first.");
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Find your state"), { target: { value: "NY" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See what its law says" }));
    expect(push).toHaveBeenCalledWith("/ny");
  });
});

describe("law references", () => {
  it("names the first pinpoint, counts the rest, and links each rule", () => {
    const rules = new Map(mi.rules.map((r) => [r.id, r]));
    const sources = new Map(mi.sources.map((s) => [s.id, s]));
    const { container } = render(
      <LawRefs st="MI" ids={["MI-COV-2", "MI-CAP-3", "MI-S9"]} rules={rules} sources={sources} />,
    );
    const summary = container.querySelector("summary")!;
    expect(summary.textContent).toBe("Show the law for this line: MCL 18.361(2)(b)and 2 more");
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelector('a[href="/law/MI#MI-S9"]')).not.toBeNull();
    // MI-S9 is the program's web page; other states' phones come from PDFs, forms, or a regulation.
    expect(container.textContent).toContain("A web page, saved by Tend.");
    expect(container.querySelector('a[href^="https://legislature.mi.gov/"]')!.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });
});

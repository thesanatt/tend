// @vitest-environment jsdom
// The public pages as people get them: rendered from the synced corpus, every line cited, and the
// share and state-finder controls working without any outside service.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LawPage from "@/app/law/[st]/page";
import Home from "@/app/page";
import StatePage, { generateMetadata } from "@/app/[st]/page";
import LawRefs from "@/components/public/LawRefs";
import ShareButtons from "@/components/public/ShareButtons";
import StateFinder from "@/components/public/StateFinder";
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
    for (const pin of ["MCL 18.361(1)", "MCL 18.355(2)", "MCL 18.355a(10)", "MCL 18.355a(2)"]) expect(page).toContain(pin);
  });

  it("gives every line a disclosure with the quote and a link to the rule", () => {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const facts = [...doc.querySelectorAll("section li")];
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
    expect(document.body.textContent).toContain(`${rules} verified rules from ${sources} official sources`);
    expect(screen.getByRole("link", { name: "MI Michigan, 83 rules verified, in bloom" }).getAttribute("href")).toBe(
      "/mi",
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(51);
  });
});

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
    render(<StateFinder states={[{ st: "MI", name: "Michigan" }, { st: "NY", name: "New York" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "See what it promises" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a state first.");
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Find your state"), { target: { value: "NY" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See what it promises" }));
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
    expect(container.querySelector('a[href^="https://legislature.mi.gov/"]')!.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });
});

// @vitest-environment jsdom
// Each state's two pages say when Tend saved their sources and give a public way to report an error.
// Also here: the GitHub issue form that link opens, /law/mi in lowercase, and what /law/MI says about
// where the engine runs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StatePage from "@/app/[st]/page";
import LawPage, { generateStaticParams as lawParams } from "@/app/law/[st]/page";
import { CORRECTIONS_EMAIL, reportErrorUrl } from "@/components/public/corrections";
import SourceNote from "@/components/public/SourceNote";
import STATES from "@/lib/states.json";
import type { Jurisdiction, Source } from "@/lib/types";
import { config, proxy } from "@/proxy";

// js-yaml comes with ESLint, already a dev dependency. The form is plain YAML.
const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");
const mi = JSON.parse(readFileSync(path.join(web, "public/data/law/MI.json"), "utf8")) as Jurisdiction;

const ISSUES = "https://github.com/thesanatt/tend/issues/new";

async function parse(el: Promise<React.ReactElement> | React.ReactElement): Promise<Document> {
  return new DOMParser().parseFromString(renderToStaticMarkup(await el), "text/html");
}

const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const savedLine = (d: Document) => [...d.querySelectorAll("p")].find((p) => words(p).startsWith("Tend saved copies"));

// Worked out here from the saved sources, apart from the page's own helpers.
function expectedSaved(sources: Pick<Source, "retrieved_at">[]): string {
  const days = sources.map((s) => new Date(s.retrieved_at).toISOString().slice(0, 10)).sort();
  const first = days[0];
  const last = days[days.length - 1];
  const say = (day: string, year: boolean) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      ...(year ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  return first === last
    ? `on ${say(first, true)}`
    : `between ${say(first, first.slice(0, 4) !== last.slice(0, 4))} and ${say(last, true)}`;
}

const sentence = (place: string, when: string) =>
  `Tend saved copies of ${place}'s official sources ${when} and checked every quote against those copies word ` +
  `for word. Laws change, so ask the program before you rely on a date or amount.`;

describe("the saved date and the report link on /mi", () => {
  it("says when Michigan's sources were saved, right under the key facts", async () => {
    const d = await parse(StatePage({ params: Promise.resolve({ st: "mi" }) }));
    const when = expectedSaved(mi.sources);
    expect(when).toMatch(/^(on|between) [A-Z][a-z]+ \d{1,2}/);
    const line = savedLine(d)!;
    expect(words(line)).toBe(sentence("Michigan", when));
    const times = [...line.querySelectorAll("time")].map((t) => t.getAttribute("dateTime"));
    const days = mi.sources.map((s) => s.retrieved_at.slice(0, 10)).sort();
    expect(times).toEqual([...new Set([days[0], days[days.length - 1]])]);
    // Under the at-a-glance facts and before the page's own contents, so a phone shows it early.
    const facts = d.querySelector('ul[aria-label="At a glance"]')!;
    const nav = d.querySelector('nav[aria-label="On this page"]')!;
    expect(facts.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the issue form with Michigan and this page filled in, and nothing else", async () => {
    const d = await parse(StatePage({ params: Promise.resolve({ st: "mi" }) }));
    const links = d.querySelectorAll(`a[href^="${ISSUES}"]`);
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute("href")!;
    expect(href).toBe(`${ISSUES}?template=law-error.yml&jurisdiction=MI&page_url=https%3A%2F%2Fyoureowed.tech%2Fmi`);
    expect([...new URL(href).searchParams.keys()]).toEqual(["template", "jurisdiction", "page_url"]);
    expect(words(links[0])).toContain("Report an error on this page");
    expect(words(links[0])).toContain("Opens a public page on GitHub");
    // GitHub shows who posted, so leaving a name out of the text does not make a report anonymous.
    expect(words(links[0])).toContain("your username shows on what you post");
    expect(words(links[0])).toContain("Don't share anything about yourself or anyone's case there.");
  });

  it("shows an email line only when Sanat has set the address", async () => {
    const d = await parse(StatePage({ params: Promise.resolve({ st: "mi" }) }));
    const email = [...d.querySelectorAll("p")].filter((p) => words(p).startsWith("No GitHub account?"));
    expect(email).toHaveLength(CORRECTIONS_EMAIL ? 1 : 0);
  });
});

describe("the saved date and the report link on /law/MI", () => {
  it("says when the sources were saved, in the header", async () => {
    const d = await parse(LawPage({ params: Promise.resolve({ st: "MI" }) }));
    const line = savedLine(d)!;
    expect(words(line)).toBe(sentence("Michigan", expectedSaved(mi.sources)));
    expect(line.closest("header")).not.toBeNull();
  });

  it("opens the issue form with Michigan and the law page filled in", async () => {
    const d = await parse(LawPage({ params: Promise.resolve({ st: "MI" }) }));
    const links = d.querySelectorAll(`a[href^="${ISSUES}"]`);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(
      `${ISSUES}?template=law-error.yml&jurisdiction=MI&page_url=https%3A%2F%2Fyoureowed.tech%2Flaw%2FMI`,
    );
  });
});

describe("the note on its own", () => {
  const at = (iso: string): Source => ({ ...mi.sources[0], retrieved_at: iso });
  const line = (sources: Source[], email = "") =>
    parse(<SourceNote st="MI" place="Michigan" sources={sources} path="/mi" email={email} />);

  it("names the first and last day when the saves span days or years", async () => {
    const days = [at("2026-10-09T01:00:00Z"), at("2026-10-03T18:47:18Z"), at("2026-10-05T09:00:00Z")];
    expect(words(savedLine(await line(days)))).toContain("sources between October 3 and October 9, 2026 and checked");
    const years = [at("2027-01-02T12:00:00Z"), at("2026-12-30T12:00:00Z")];
    expect(words(savedLine(await line(years)))).toContain("between December 30, 2026 and January 2, 2027 and");
  });

  it("leaves the date out when no source has one, and keeps the report link", async () => {
    const d = await line([]);
    expect(savedLine(d)).toBeUndefined();
    expect(d.querySelector(`a[href^="${ISSUES}"]`)).not.toBeNull();
  });

  it("adds the email line once an address is set", async () => {
    expect(words((await line(mi.sources)).body)).not.toContain("No GitHub account?");
    const d = await line(mi.sources, "corrections@example.org");
    const mail = d.querySelector('a[href="mailto:corrections@example.org"]')!;
    expect(words(mail.parentElement)).toBe(
      "No GitHub account? Email the error to corrections@example.org. Leave out anything about yourself.",
    );
  });
});

describe("the lowercase law path", () => {
  it("sends /law/mi and every other lowercase code to the uppercase page, permanently", () => {
    for (const { st } of STATES) {
      const res = proxy(new NextRequest(`https://youreowed.tech/law/${st.toLowerCase()}`));
      expect(res.status, st).toBe(308);
      expect(res.headers.get("location"), st).toBe(`https://youreowed.tech/law/${st}`);
    }
  });

  it("keeps the query, fixes mixed case, and passes everything else through", () => {
    expect(proxy(new NextRequest("https://youreowed.tech/law/mi?from=judges")).headers.get("location")).toBe(
      "https://youreowed.tech/law/MI?from=judges",
    );
    expect(proxy(new NextRequest("https://youreowed.tech/law/Mi")).headers.get("location")).toBe(
      "https://youreowed.tech/law/MI",
    );
    for (const url of ["/law/MI", "/law/zz", "/law/changes"]) {
      const res = proxy(new NextRequest(`https://youreowed.tech${url}`));
      expect(res.headers.get("location"), url).toBeNull();
      expect(res.headers.get("x-middleware-next"), url).toBe("1");
    }
  });

  it("runs only for a two-letter code with a lowercase letter in it", () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    expect(runs("/law/mi")).toBe(true);
    expect(runs("/law/mI")).toBe(true);
    expect(runs("/law/MI")).toBe(false);
    expect(runs("/law/changes")).toBe(false);
    expect(runs("/law/mi/more")).toBe(false);
    expect(runs("/mi")).toBe(false);
  });

  it("leaves the law pages built once each, under the uppercase code", () => {
    expect(lawParams()).toEqual(STATES.map((s) => ({ st: s.st })));
  });
});

interface FormElement {
  type: string;
  id?: string;
  attributes: { label?: string; value?: string; options?: { label: string; required?: boolean }[] };
  validations?: { required?: boolean };
}

describe("the issue form (.github/ISSUE_TEMPLATE/law-error.yml)", () => {
  const file = path.join(repo, ".github/ISSUE_TEMPLATE/law-error.yml");
  const raw = readFileSync(file, "utf8");
  const form = yaml.load(raw) as { name: string; description: string; title?: string; body: FormElement[] };
  const fields = form.body.filter((b) => b.type !== "markdown");
  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));

  it("is a GitHub issue form whose fields the report link can fill", () => {
    expect(form.name).toBeTruthy();
    expect(form.description).toBeTruthy();
    const ids = fields.map((f) => f.id!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    const link = new URL(reportErrorUrl("MI", "https://youreowed.tech/mi"));
    expect(link.searchParams.get("template")).toBe(path.basename(file));
    for (const key of link.searchParams.keys()) if (key !== "template") expect(ids).toContain(key);
  });

  it("asks for the page, the rule, what is wrong, and the official source", () => {
    expect(byId.jurisdiction).toMatchObject({ type: "input", validations: { required: true } });
    expect(byId.page_url).toMatchObject({ type: "input", validations: { required: true } });
    expect(byId.rule).toMatchObject({ type: "input", validations: { required: false } });
    expect(byId.problem).toMatchObject({ type: "textarea", validations: { required: true } });
    expect(byId.source_url).toMatchObject({ type: "input", validations: { required: true } });
    expect(byId.source_text).toMatchObject({ type: "textarea", validations: { required: true } });
  });

  it("says it is public before any field, and cannot be sent without the privacy box ticked", () => {
    expect(form.body[0].type).toBe("markdown");
    expect(form.body[0].attributes.value).toContain("public page");
    expect(form.body[0].attributes.value).toContain("with your GitHub username on it");
    expect(byId.privacy).toMatchObject({
      type: "checkboxes",
      attributes: { options: [{ label: "I have not included anything about myself or anyone's case", required: true }] },
    });
  });

  it("is plain ASCII", () => {
    expect(raw).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
  });
});

describe("where /law/MI says the engine runs", () => {
  it("names the Python reference on the server, with numbers docs/EVAL.md records", async () => {
    const d = await parse(LawPage({ params: Promise.resolve({ st: "MI" }) }));
    const steps = words(d.querySelector('section[aria-labelledby="h-check"]'));
    expect(steps).not.toContain("The same image runs on the server");
    expect(steps).toContain("When you check a claim, your browser runs this compiled law in WebAssembly.");
    expect(steps).toContain("the Python reference engine answers it from the same IR");
    const evalMd = readFileSync(path.join(repo, "docs/EVAL.md"), "utf8");
    expect(evalMd).toContain("119,600 well-formed claims byte-identical");
    expect(evalMd).toContain("106,000 of 106,000 claims byte-identical");
    expect(steps).toContain("byte for byte on 119,600 claims");
    expect(steps).toContain("on 106,000 of 106,000");
  });
});

// The facts on /press and in its one-page fact sheet (public/press/tend-fact-sheet.pdf). Both read this
// module, so the two cannot say different things: app/press/page.tsx renders it and
// scripts/press-factsheet.ts prints it. Counts are read from the site's own files when it is built; every
// other number is quoted from docs/SOURCES.md, docs/EVAL.md, docs/PRIVACY.md, docs/JUDGES.md, or the README.
// tests/press.test.tsx checks both, and tests/press-factsheet.test.ts that the PDF in public/press is what
// these facts make today. It reads the file system, so only server components and scripts run from web/
// may import it.
import { statSync } from "node:fs";
import path from "node:path";
import { loadCorpus } from "@/components/public/data";
import { LINKS } from "@/components/tour/links";

// The day these facts were last checked against the docs and the data. Change it along with any fact.
export const CHECKED = "2026-10-19";

// TODO(Sanat): two or three sentences, in your own words, on why you built Tend. Until then /press shows a
// marked placeholder and the fact sheet leaves it out.
export const WHY: string | null = null;

// TODO(Sanat): the address reporters should write to. Until then /press and the fact sheet say it is not
// chosen yet.
export const CONTACT: string | null = null;

// TODO(Sanat): the demo video's unlisted YouTube link, once it is recorded. It stays a link: the site's
// security policy allows no frames, so an embed would not load.
export const VIDEO: string | null = null;

export interface PressSource {
  label: string;
  // A page on this site ("/data") or a full address.
  href: string;
}

export interface PressFact {
  id: string;
  text: string;
  sources: PressSource[];
}

export interface PressRow {
  label: string;
  text: string;
}

export interface PressFacts {
  checked: string;
  about: string;
  builder: string;
  builderSource: PressSource;
  why: string | null;
  facts: PressFact[];
  real: PressRow[];
  links: PressSource[];
  contact: string | null;
  video: string | null;
  notAdvice: string;
}

// The line from the press brief, word for word.
export const BUILDER =
  "Built by Sanat Gupta, a computer science senior at the University of Michigan, at MHacks 2026, where it took 1st place in Capital One's track.";

export const NOT_ADVICE =
  "Tend is not legal advice. It shows what each program's own rules say, with the quote. The program decides.";

export const DEMO = "/check?demo=rowan";

const JUST_SAFE = "https://justsafe.org/news/beyond-headlines-decade-listening-crime-survivors/";
// Opens the statute at the sentence, as on /sources.
const MCL_18_355A_2 =
  "https://legislature.mi.gov/Laws/MCL?objectName=mcl-18-355a#:~:text=A%20health%20care%20provider%20shall,or%20any%20other%20out%2Dof%2Dpocket";
const VERIFY = `${LINKS.repo}/blob/main/rules/tools/verify.py`;
const ENGINE = "/engine/tend.wasm";

const n = (x: number) => x.toLocaleString("en-US");

// Decimal kilobytes, rounded down, as How it works and docs/SOURCES.md count the engine.
function engineKb(): number {
  return Math.floor(statSync(path.join(process.cwd(), "public", ENGINE)).size / 1000);
}

export function pressFacts(): PressFacts {
  const corpus = loadCorpus();
  // Without the synced data every count would read 0, and a page or a PDF must never print that.
  if (!corpus.programs) throw new Error("No law data in public/data. Run this from web/.");
  const all = corpus.verified === corpus.programs;
  const covered = all ? "all 50 states and DC" : `${corpus.verified} of the ${corpus.programs} programs so far`;

  return {
    checked: CHECKED,
    about: [
      "Tend helps sexual assault survivors claim crime victim compensation.",
      "Every state and DC has money set aside to pay back costs like medical bills, counseling, and lost pay.",
      "A survivor answers four questions.",
      "Then Tend reads their bank statement and bills on their own device, checks each cost against their state's law, and builds the claim.",
      "Every dollar in it comes with the exact sentence of law behind it.",
      "Tend never asks for a name or what happened.",
      `It covers ${covered}, though only Michigan's application form is filled in so far.`,
      "Tend is a prototype.",
      "It is not legal advice, and the program decides every claim.",
    ].join(" "),
    builder: BUILDER,
    builderSource: { label: "Devpost", href: LINKS.devpost },
    why: WHY,
    facts: [
      {
        id: "unpaid",
        text: "In 2022, 96 percent of violent crime victims got no victim compensation.",
        sources: [
          {
            label:
              "Alliance for Safety and Justice (now Just Safe), Beyond the Headlines: A Decade of Listening to Crime Survivors, October 1, 2025",
            href: JUST_SAFE,
          },
        ],
      },
      {
        id: "programs",
        text: `Every state and DC runs a crime victim compensation program under its own law. Tend has rules for ${all ? `all ${corpus.programs}` : `${corpus.verified} of them`}.`,
        sources: [{ label: "Tend's rules data", href: "/data" }],
      },
      {
        id: "rules",
        text: `Tend's law library holds ${n(corpus.rules)} rules from ${n(corpus.sources)} saved sources. A rule gets in only if its quote appears word for word in the saved copy of its source.`,
        // Not "open data": /data says no license is chosen yet.
        sources: [
          { label: "The rules as JSON and CSV", href: "/data" },
          { label: "verify.py, the check", href: VERIFY },
        ],
      },
      {
        id: "device",
        text: `Each state's law runs in the browser, in an engine written in C++ and compiled to ${engineKb()} KB of WebAssembly. Bank statements and bills are read there too. Only a yes moves the law check to Tend's server, or bills and bank rows to cloud AI.`,
        // Design for safety and docs/PRIVACY.md both cover cloud AI and the server law check.
        sources: [
          { label: "tend.wasm, the engine itself", href: ENGINE },
          { label: "Design for safety", href: "/how-it-works#safety" },
          { label: "docs/PRIVACY.md", href: LINKS.privacy },
        ],
      },
      {
        id: "tested",
        text: "On 121,000 test claims, the C++ engine and a separate Python engine showed 0 differences. That shows both read Tend's spec the same way. It does not show the spec reads the law correctly.",
        sources: [{ label: "docs/EVAL.md", href: LINKS.eval }],
      },
      {
        id: "safety",
        text: "Tend has no accounts and never asks for a name or what happened. Every page has an Exit this page button that swaps Tend for a Google search for the weather.",
        sources: [
          { label: "Design for safety", href: "/how-it-works#safety" },
          { label: "docs/PRIVACY.md", href: LINKS.privacy },
        ],
      },
      {
        id: "share",
        text: "A share link for an advocate is locked in the browser with AES-256-GCM. The key sits after the # in the link, a part browsers never send to a server.",
        sources: [{ label: "docs/PRIVACY.md", href: LINKS.privacy }],
      },
      {
        id: "demo",
        text: "In the demo, a fictional survivor's $443.00 hospital bill includes a $325.00 forensic exam. Tend holds that line and drafts a letter to the billing office. Michigan law says a health care provider \"shall not submit a bill for any portion\" of the exam's costs to the victim.",
        sources: [
          { label: "MCL 18.355a(2)", href: MCL_18_355A_2 },
          { label: "The fictional demo", href: DEMO },
        ],
      },
    ],
    real: [
      {
        label: "Real",
        text: `The law: statutes, regulations, and program pages for ${all ? `all ${corpus.programs}` : corpus.verified} jurisdictions, each saved with its SHA-256, and Michigan's real application form. A word-for-word quote shows the words are in the source. It does not show Tend read them correctly.`,
      },
      {
        label: "Fictional",
        text: "Rowan Hale, Riverbend General Hospital, every merchant, and every dollar in the demo.",
      },
      {
        label: "Mock",
        text: "The bank. Nessie is Capital One's mock bank API, so a payment confirmed in the demo moves only mock money.",
      },
      {
        label: "Prototype",
        text: "No real users and no partners. Tend files nothing: the survivor sends the packet. Only Michigan's application is filled in. Other states get the program's blank form, or a note that Tend found none.",
      },
      {
        label: "AI",
        text: "Gemini Nano, on the device when Chrome has it, reads photos and scans of bills, and suggests labels for costs the rules miss. The engine decides what counts and how much. Cloud Gemini can do the same, but only after a yes on a screen that names what would be sent and what Google may do with it.",
      },
    ],
    links: [
      { label: "Live site", href: "/" },
      { label: "Fictional demo", href: DEMO },
      { label: "How it works", href: "/how-it-works" },
      { label: "Sources", href: "/sources" },
      { label: "Rules data", href: "/data" },
      { label: "Code on GitHub", href: LINKS.repo },
      { label: "Devpost write-up", href: LINKS.devpost },
    ],
    contact: CONTACT,
    video: VIDEO,
    notAdvice: NOT_ADVICE,
  };
}

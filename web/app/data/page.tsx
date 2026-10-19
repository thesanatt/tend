import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { shortDate } from "@/components/public/format";
import { LINKS } from "@/components/tour/links";
import styles from "./data.module.css";

// The verified rules as a download: the files with their sizes and SHA-256, the counts, what the columns
// hold, how the quotes were checked, and what that check does not prove. Read when the site is built from
// public/downloads, which rules/tools/export_dataset.py writes. Static, no tracking.
export const metadata: Metadata = {
  title: "Rules data",
  description:
    "Tend's verified rules as JSON and CSV. Each rule quotes its source word for word, with the source's address and SHA-256.",
};

const VERSION = "1.0";
const DOWNLOADS = path.join(process.cwd(), "public", "downloads");
// The rule shown column by column: Michigan's exam billing rule, the one the demo holds a bill with.
const EXAMPLE = "MI-EXAM-1";

interface DataRule {
  rule_id: string;
  jurisdiction: string;
  jurisdiction_name: string;
  category: string;
  expense: string | null;
  params: Record<string, unknown>;
  summary: string;
  quote: string;
  pinpoint: string;
  source_id: string;
  source_title: string;
  source_kind: string;
  source_url: string;
  fragment_url: string | null;
  retrieved_at: string;
  source_sha256: string;
  engine_use: "decision" | "information" | "set_aside";
  set_aside_reason: string | null;
}

interface Dataset {
  metadata: {
    version: string;
    current_as_of: { first_retrieved_at: string; last_retrieved_at: string; justia_code_years: string[] };
    counts: {
      jurisdictions: number;
      sources: number;
      rules: number;
      sources_quoted: number;
      rules_by_engine_use: Record<DataRule["engine_use"], number>;
      sources_from_republishers: Record<string, number>;
      rules_quoting_republishers: number;
      sources_redacted: number;
    };
  };
  rules: DataRule[];
}

interface DownloadFile {
  name: string;
  what: string;
  bytes: number;
  sha256: string;
}

function read(name: string): { bytes: Buffer; file: Omit<DownloadFile, "what"> } {
  const bytes = readFileSync(path.join(DOWNLOADS, name));
  return { bytes, file: { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

// Decimal units, like the engine size on How it works.
function size(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

const n = (x: number) => x.toLocaleString("en-US");

const FIELDS: { key: keyof DataRule; what: string }[] = [
  { key: "rule_id", what: "The rule's id. It starts with the state's code." },
  { key: "jurisdiction", what: "The state's two-letter code, or DC." },
  { key: "jurisdiction_name", what: "The state's name." },
  { key: "category", what: "What the rule is about, such as total_cap or filing_deadline." },
  { key: "expense", what: "The kind of cost it is about, when it is about one." },
  { key: "params", what: "The rule's details as data. Money is in cents." },
  { key: "summary", what: "Tend's plain-language reading. Not the law's words." },
  { key: "quote", what: "The source's own words, checked against the saved copy." },
  { key: "pinpoint", what: "Where in the source the quote is." },
  { key: "source_id", what: "The saved source, as listed in the sources file." },
  { key: "source_title", what: "The source's title." },
  { key: "source_kind", what: "statute, regulation, agency_page, agency_pdf, or application_form." },
  { key: "source_url", what: "Where the source was saved from." },
  { key: "fragment_url", what: "A link that opens the page at the quote. HTML sources only." },
  { key: "retrieved_at", what: "When the source was saved, in UTC." },
  { key: "source_sha256", what: "The SHA-256 of the saved source file." },
  { key: "engine_use", what: "decision, information, or set_aside: what Tend's law engine does with the rule." },
  { key: "set_aside_reason", what: "Why a rule is set aside. Empty for every other rule." },
];

// Browsers break a line after the hyphen; this keeps the name in one piece in running text.
const SHA256 = <span className={styles.nowrap}>SHA-256</span>;

function Value({ rule, field }: { rule: DataRule; field: keyof DataRule }) {
  const v = rule[field];
  if (v === null || v === "") return <span className={styles.empty}>empty</span>;
  if (field === "quote") return <mark className={styles.quote}>{rule.quote}</mark>;
  if (field === "summary") return <span className={styles.prose}>{rule.summary}</span>;
  if (field === "params") return <code>{JSON.stringify(rule.params)}</code>;
  if (field === "source_url" || field === "fragment_url") return <a href={String(v)}>{String(v)}</a>;
  return <code>{String(v)}</code>;
}

export default function DataPage() {
  const json = read(`tend-rules-v${VERSION}.json`);
  const data = JSON.parse(json.bytes.toString("utf8")) as Dataset;
  const { counts, current_as_of: asOf } = data.metadata;
  const uses = counts.rules_by_engine_use;
  const example = data.rules.find((r) => r.rule_id === EXAMPLE);
  const firstDay = shortDate(asOf.first_retrieved_at);
  const lastDay = shortDate(asOf.last_retrieved_at);
  const savedOn = firstDay === lastDay ? firstDay : `${firstDay} to ${lastDay}`;
  // Copies saved from sites that republish state law, counted by the export from each source's address.
  const republished = counts.sources_from_republishers;
  const copies = Object.values(republished).reduce((total, count) => total + count, 0);
  const justia = republished["law.justia.com"] ?? 0;
  // The year of the code the saved Justia pages show, read by the export from each page's citation line.
  const codeYears = asOf.justia_code_years.join(" or ");

  const files: DownloadFile[] = [
    {
      ...json.file,
      what: "Everything in one file: the jurisdictions with their programs and research notes, the sources, and the rules.",
    },
    { ...read(`tend-rules-v${VERSION}.csv`).file, what: `One row per rule: ${n(counts.rules)} rows.` },
    { ...read(`tend-sources-v${VERSION}.csv`).file, what: `One row per saved source: ${n(counts.sources)} rows.` },
    {
      ...read(`tend-jurisdictions-v${VERSION}.csv`).file,
      what: `One row per jurisdiction: ${n(counts.jurisdictions)} rows. Each has the program's details and Tend's research notes.`,
    },
    { ...read("README.md").file, what: "Every column explained, and how the rules were checked." },
    { ...read("SHA256SUMS").file, what: "The SHA-256 of every other file." },
  ];

  return (
    <div className={`page ${styles.data}`}>
      <h1>The rules, as data</h1>
      <p className={styles.lead}>
        Every rule Tend has verified, as JSON and CSV. Each rule quotes its source word for word and says where that
        source lives, with the {SHA256} of the copy Tend saved. This is version {data.metadata.version}.
      </p>

      <section className={styles.section} aria-labelledby="download">
        <h2 id="download">Download</h2>
        <ul className={styles.files}>
          {files.map((f) => (
            <li key={f.name}>
              <div className={styles.fileHead}>
                <a className={styles.fileName} href={`/downloads/${f.name}`} download>
                  {f.name}
                </a>
                <span className={styles.size}>{size(f.bytes)}</span>
              </div>
              <p className={styles.what}>{f.what}</p>
              <p className={styles.hash}>
                {SHA256} <code>{f.sha256}</code>
              </p>
            </li>
          ))}
        </ul>
        <p className={styles.small}>
          To check what you saved, put SHA256SUMS in the same folder and run{" "}
          <code>shasum -a 256 -c --ignore-missing SHA256SUMS</code> there. Without <code>--ignore-missing</code>, each
          file you did not download is reported as failed.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="contents">
        <h2 id="contents">What is in version {data.metadata.version}</h2>
        <dl className={styles.counts}>
          <div>
            <dt>Rules</dt>
            <dd>{n(counts.rules)}</dd>
          </div>
          <div>
            <dt>Jurisdictions</dt>
            <dd>
              {n(counts.jurisdictions)}
              {counts.jurisdictions === 51 ? ", the 50 states and DC" : null}
            </dd>
          </div>
          <div>
            <dt>Sources saved</dt>
            <dd>
              {n(counts.sources)}, of which {n(counts.sources_quoted)} are quoted by a rule
            </dd>
          </div>
          <div>
            <dt>What the engine does with them</dt>
            <dd>
              {n(uses.decision)} compiled as decision rules, {n(uses.information)} kept as information,{" "}
              {n(uses.set_aside)} set aside with a reason
            </dd>
          </div>
          <div>
            <dt>Current as of</dt>
            <dd>
              {savedOn}, when the sources were saved
              {justia > 0 ? `; the ${n(justia)} statutes copied from Justia show each state's ${codeYears} code` : null}
            </dd>
          </div>
        </dl>
      </section>

      {example ? (
        <section className={styles.section} aria-labelledby="columns">
          <h2 id="columns">The columns, with one rule</h2>
          <p className={styles.sectionLead}>
            Each row of the rules file is one rule. This is {example.jurisdiction_name}&apos;s rule on exam bills,{" "}
            {example.rule_id}, column by column. The <a href="/downloads/README.md">README</a> covers every column of
            all three files, with types and allowed values.
          </p>
          <dl className={styles.fields}>
            {FIELDS.map(({ key, what }) => (
              <div key={key}>
                <dt>
                  <code>{key}</code>
                </dt>
                <dd>
                  <span className={styles.fieldWhat}>{what}</span>
                  <span className={styles.value}>
                    <Value rule={example} field={key} />
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="method">
        <h2 id="method">How the rules were checked</h2>
        <ol className={styles.steps}>
          <li>
            <strong>Saved.</strong> Each page or PDF was saved with the text extracted from it and the {SHA256} of the
            saved file.
          </li>
          {/* TODO(Sanat): say who drafted the rules and how they were reviewed. This step describes only the process. */}
          <li>
            <strong>Quoted.</strong> Each rule&apos;s quote was copied from the saved text, never paraphrased, and
            recorded with its category, details, plain summary, and pinpoint citation.
          </li>
          <li>
            <strong>Verified.</strong> <a href={`${LINKS.repo}/blob/main/rules/tools/verify.py`}>verify.py</a> accepts a
            rule only if its quote appears word for word in the saved text, after both are normalized the same way
            (Unicode, quote marks, dashes, and spacing). It also accepts a match that differs only in capital letters,
            with a warning; no rule in version {data.metadata.version} needed that. The numbers in eight of its detail
            fields, which hold amounts, counts, and lengths of time, must appear in the quote, and so must every number
            in its summary other than 0 and 1. The saved file&apos;s {SHA256} must still match. The dataset&apos;s own
            tests run the quote and {SHA256} checks again on every rule in these files. They also check that every
            detail that is a whole number appears in the rule&apos;s quote, including fields verify.py does not check.
          </li>
          <li>
            <strong>Sorted for the engine.</strong>{" "}
            <a href={`${LINKS.repo}/blob/main/rules/tools/normalize.py`}>normalize.py</a> decides which rules the law
            engine applies. When it cannot apply a rule as written, it keeps the rule as information or sets it aside
            with the reason, instead of guessing.
          </li>
        </ol>
        <p className={styles.small}>
          Check it yourself on macOS or Linux, from a clone of the <a href={LINKS.repo}>repository</a>:
        </p>
        <pre className={styles.code} tabIndex={0} aria-label="Commands that check the dataset">
          <code>
            {[
              "python3 rules/tools/verify.py all",
              "python3 rules/tools/export_dataset.py --check",
              "uv run --with pytest pytest rules/tools/test_export_dataset.py",
            ].join("\n")}
          </code>
        </pre>
      </section>

      <section className={styles.section} aria-labelledby="limits">
        <h2 id="limits">What the check does not prove</h2>
        <ul className={styles.limits}>
          <li>
            A word-for-word quote proves the words are in the saved source. It does not prove Tend read them correctly.
            The category, the details, the summary, the pinpoint citation, and what the engine does with a rule are
            Tend&apos;s reading, and a rule can be misread even when its quote is exact. verify.py checks only that a
            rule has a pinpoint citation, not that it points to the right place in the source.
          </li>
          <li>
            The rules are current as of {savedOn}, when the sources were saved. Laws and program pages change, and
            nothing fetches them again on a schedule yet.
          </li>
          {copies > 0 ? (
            <li>
              {n(copies)} sources are copies on sites that republish state law, not the state&apos;s own publication:{" "}
              {n(justia)} statutes from Justia and {n(republished["www.law.cornell.edu"] ?? 0)} regulations from
              Cornell&apos;s Legal Information Institute. Justia&apos;s pages show each state&apos;s {codeYears} code
              and say it may not be the most recent version, and Cornell&apos;s say state regulations are updated there
              quarterly. The {n(counts.rules_quoting_republishers)} rules that quote these copies match the copies, so
              check the state&apos;s own code before relying on one.
            </li>
          ) : null}
          <li>
            A gap is a gap in Tend&apos;s research, not a finding about the law. When a state has no rule in a category,
            Tend did not find or verify one in the sources it saved.
          </li>
          <li>
            A {SHA256} shows the saved copy has not changed since its {SHA256} was recorded. It cannot show what the
            live page says today.
            {counts.sources_redacted > 0 ? (
              <>
                {" "}
                On {n(counts.sources_redacted)} saved pages, third-party API keys embedded in the page were redacted
                after the page was saved, so their {SHA256} is of the redacted copy.
              </>
            ) : null}
          </li>
          <li>
            Links that open a page at the quote exist only for HTML sources. They work in browsers that support text
            fragments, and only while the page still has those words.
          </li>
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="cite">
        <h2 id="cite">Citing and reuse</h2>
        {/* TODO(Sanat): replace both lines once the release is published (citation, DOI if any) and a license is chosen. */}
        <div className={styles.placeholder}>
          <p className={styles.placeholderLabel}>Not decided yet</p>
          <p>
            <strong>How to cite:</strong> not set up yet. This version has no DOI.
          </p>
          <p>
            <strong>License:</strong> not chosen yet.
          </p>
        </div>
      </section>

      <p className={styles.note}>
        Tend is not legal advice. It shows what each program&apos;s own rules say, with the quote. The program decides.
      </p>
    </div>
  );
}

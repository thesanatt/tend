import Link from "next/link";
import { hostOf, isPdf } from "@/components/public/format";
import { ruleUse } from "@/components/public/irWords";
import lawStyles from "@/components/public/law.module.css";
import { lawCategoryLabel } from "@/components/public/LawParts";
import type { IrRule } from "@/components/public/types";
import STATES from "@/lib/states.json";
import type { AllStatesDiff, LawRule, RuleChange, SourceChange, StateDiff, VersionRef } from "./data";
import styles from "./changes.module.css";

const NAMES = new Map(STATES.map((s) => [s.st, s.name]));

export function stateName(st: string): string {
  return NAMES.get(st) ?? st;
}

export function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// "Oct 3, 2026, 3:03 PM ET": versions are moments, and the people checking them are in US time zones.
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(d);
  return `${text} ET`;
}

export function compareHref(from: string, to: string, st?: string): string {
  const q = new URLSearchParams({ from, to, ...(st ? { st } : {}) });
  return `/law/changes?${q}`;
}

// One plain paragraph on what a version changed, from the comparison with the version before it.
export function versionNote(s: AllStatesDiff | undefined): string | null {
  if (!s) return null;
  const parts: string[] = [];
  const top = (byCategory: Record<string, number>) =>
    Object.entries(byCategory)
      .slice(0, 3)
      .map(([c, n]) => `${lawCategoryLabel(c).toLowerCase()} (${n.toLocaleString("en-US")})`)
      .join(", ");
  if (s.totals.added) parts.push(`Added ${count(s.totals.added, "rule", "rules")}: ${top(s.by_category.added)}.`);
  if (s.totals.removed) parts.push(`Removed ${count(s.totals.removed, "rule", "rules")}.`);
  const k = s.changed_kinds;
  if (k.text) parts.push(`${count(k.text, "quote", "quotes")} changed.`);
  if (k.meaning) parts.push(`Tend's reading of ${count(k.meaning, "rule", "rules")} changed.`);
  if (k.engine) parts.push(`The law engine now uses ${count(k.engine, "rule", "rules")} differently.`);
  if (k.source_copy)
    parts.push(
      `${count(s.totals.sources_changed, "saved source page was", "saved source pages were")} saved again, so ${count(k.source_copy, "rule points", "rules point")} to the new copy.`,
    );
  if (!parts.length && s.files_changed_states)
    parts.push(`No rule changed. The files for ${count(s.files_changed_states, "program", "programs")} were rebuilt.`);
  return parts.join(" ") || "Nothing changed.";
}

const FIELD: Record<string, string> = {
  quote: "The quote",
  pinpoint: "Where it is in the source",
  source_id: "Which source it quotes",
  fragment_url: "The link to the sentence",
  category: "Kind of rule",
  expense: "Kind of cost",
  params: "Numbers and terms Tend reads from it",
  summary: "Tend's plain summary",
  ir: "What the law engine does with it",
  ir_kind: "What the law engine does with it",
  skipped_reason: "What the law engine does with it",
  source_sha256: "The saved copy of its source",
};

const STATE_FIELD: Record<string, string> = {
  name: "Name",
  confidence: "Research confidence",
  ir_version: "Rule format the law engine reads",
  skipped_count: "Rules the engine sets aside",
  "program.program_name": "Program name",
  "program.agency": "Agency",
  "program.phone": "Program phone",
  "program.phone_source_id": "Where the phone number comes from",
  "program.website": "Website",
  "program.apply_url": "Where to apply",
  "program.application_pdf_url": "Application PDF",
  "program.statute_citation": "Statute",
  "program.application_form": "The state's application form",
};

function plain(value: unknown): string {
  if (value === null || value === undefined || value === "") return "not recorded";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("fillable" in o || "field_count" in o) {
      const fields = typeof o.field_count === "number" ? `, ${o.field_count} fields` : "";
      return `${o.fillable ? "a fillable PDF" : "a PDF to print"}${fields}${o.source_id ? ` (source ${o.source_id})` : ""}`;
    }
    return Object.entries(o)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("; ");
  }
  return String(value);
}

function SourceLink({ rule }: { rule: LawRule }) {
  const href = rule.fragment_url ?? rule.source_url;
  if (!href) return null;
  return (
    <p className={lawStyles.sourceLink}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {rule.fragment_url
          ? `Read this sentence on ${hostOf(href)}`
          : `Open the ${isPdf(rule.source_url ?? undefined) ? "PDF" : "source"} on ${hostOf(href)}`}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </p>
  );
}

function Provenance({ rule }: { rule: LawRule }) {
  return (
    <p className={lawStyles.provenance}>
      From {rule.source_title ?? rule.source_id}
      {rule.source_sha256 ? (
        <>
          , saved copy SHA-256 <code title={rule.source_sha256}>{rule.source_sha256.slice(0, 12)}</code>
        </>
      ) : null}
    </p>
  );
}

export function RuleCard({ rule, tone }: { rule: LawRule; tone: "added" | "removed" }) {
  return (
    <article className={`${lawStyles.rule} ${styles.card} ${styles[tone]}`} aria-labelledby={`${tone}-${rule.rule_id}`}>
      <p className={lawStyles.cite}>
        <span id={`${tone}-${rule.rule_id}`} className={lawStyles.pinpoint}>
          {rule.pinpoint}
        </span>
        <span className={lawStyles.ruleId}>{rule.rule_id}</span>
      </p>
      <p className={styles.kind}>
        <span className={styles.tag}>{tone === "added" ? "Added" : "Removed"}</span> {lawCategoryLabel(rule.category)}
      </p>
      <p className={lawStyles.summary}>{rule.summary}</p>
      <blockquote
        className={`${lawStyles.quote} ${tone === "removed" ? styles.gone : ""}`}
        cite={rule.source_url ?? undefined}
      >
        <p>{tone === "added" ? <mark>{rule.quote}</mark> : rule.quote}</p>
      </blockquote>
      <SourceLink rule={rule} />
      <Provenance rule={rule} />
    </article>
  );
}

function engineWords(side: Record<string, unknown>, ruleId: string): string {
  const ir = side.ir as IrRule | null | undefined;
  const reason = side.skipped_reason as string | null | undefined;
  return ruleUse(ir ?? undefined, reason ? { id: ruleId, reason } : undefined).text;
}

export function ChangeCard({ change }: { change: RuleChange }) {
  const { before, after, rule } = change;
  const shown = new Set<string>();
  const rows: { label: string; was: string; now: string; quote?: boolean }[] = [];
  for (const field of change.fields) {
    const label = FIELD[field] ?? field;
    if (shown.has(label)) continue;
    shown.add(label);
    if (field === "ir" || field === "ir_kind" || field === "skipped_reason") {
      rows.push({ label, was: engineWords(before, rule.rule_id), now: engineWords(after, rule.rule_id) });
    } else if (field === "source_sha256") {
      rows.push({
        label,
        was: `SHA-256 ${String(before.source_sha256 ?? "").slice(0, 12)}`,
        now: `SHA-256 ${String(after.source_sha256 ?? "").slice(0, 12)}, saved again`,
      });
    } else if (field === "category") {
      rows.push({
        label,
        was: lawCategoryLabel(String(before.category)),
        now: lawCategoryLabel(String(after.category)),
      });
    } else {
      rows.push({ label, was: plain(before[field]), now: plain(after[field]), quote: field === "quote" });
    }
  }
  return (
    <article
      className={`${lawStyles.rule} ${styles.card} ${styles.changed}`}
      aria-labelledby={`changed-${rule.rule_id}`}
    >
      <p className={lawStyles.cite}>
        <span id={`changed-${rule.rule_id}`} className={lawStyles.pinpoint}>
          {rule.pinpoint}
        </span>
        <span className={lawStyles.ruleId}>{rule.rule_id}</span>
      </p>
      <p className={styles.kind}>
        <span className={styles.tag}>Changed</span> {lawCategoryLabel(rule.category)}
      </p>
      <dl className={styles.delta}>
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>
              <span className={styles.was}>
                <span className={styles.whenLabel}>Before</span> {r.quote ? <q>{r.was}</q> : r.was}
              </span>
              <span className={styles.now}>
                <span className={styles.whenLabel}>Now</span> {r.quote ? <q>{r.now}</q> : r.now}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {change.fields.includes("quote") ? null : (
        <blockquote className={lawStyles.quote} cite={rule.source_url ?? undefined}>
          <p>{rule.quote}</p>
        </blockquote>
      )}
      <SourceLink rule={rule} />
    </article>
  );
}

function SourceRow({ s, note }: { s: SourceChange; note: string }) {
  return (
    <li>
      {s.url ? (
        <a href={s.url} target="_blank" rel="noopener noreferrer">
          {s.title ?? s.source_id}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      ) : (
        (s.title ?? s.source_id)
      )}{" "}
      <span className={lawStyles.ruleId}>{s.source_id}</span>
      <span className={styles.sourceNote}>{note}</span>
    </li>
  );
}

export function StateChanges({ d }: { d: StateDiff }) {
  const name = stateName(d.st);
  const c = d.counts;
  if (d.unchanged) {
    return (
      <section className={styles.result} aria-labelledby="h-result">
        <h2 id="h-result">No change in {name}</h2>
        <p className={styles.none}>
          {d.files_changed
            ? `${name}'s files were rebuilt between these versions, but no rule, quote, or program detail changed.`
            : `${name}'s rules are the same, byte for byte, in both versions.`}
        </p>
      </section>
    );
  }
  return (
    <section className={styles.result} aria-labelledby="h-result">
      <h2 id="h-result">What changed in {name}</h2>
      <dl className={lawStyles.counts}>
        <div>
          <dt>Rules added</dt>
          <dd>{c.added}</dd>
        </div>
        <div>
          <dt>Rules removed</dt>
          <dd>{c.removed}</dd>
        </div>
        <div>
          <dt>Rules changed</dt>
          <dd>{c.changed}</dd>
        </div>
        <div>
          <dt>Sources added or saved again</dt>
          <dd>{c.sources_added + c.sources_changed}</dd>
        </div>
      </dl>

      {d.state.length ? (
        <div className={styles.block}>
          <h3>About the program</h3>
          <dl className={styles.delta}>
            {d.state.map((f) => (
              <div key={f.field}>
                <dt>{STATE_FIELD[f.field] ?? f.field.replace(/^program\./, "").replace(/_/g, " ")}</dt>
                <dd>
                  <span className={styles.was}>
                    <span className={styles.whenLabel}>Before</span> {plain(f.before)}
                  </span>
                  <span className={styles.now}>
                    <span className={styles.whenLabel}>Now</span> {plain(f.after)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {d.added.length ? (
        <div className={styles.block}>
          <h3>Added</h3>
          <div className={lawStyles.rules}>
            {d.added.map((r) => (
              <RuleCard key={r.rule_id} rule={r} tone="added" />
            ))}
          </div>
        </div>
      ) : null}

      {d.removed.length ? (
        <div className={styles.block}>
          <h3>Removed</h3>
          <div className={lawStyles.rules}>
            {d.removed.map((r) => (
              <RuleCard key={r.rule_id} rule={r} tone="removed" />
            ))}
          </div>
        </div>
      ) : null}

      {d.changed.length ? (
        <div className={styles.block}>
          <h3>Changed</h3>
          <div className={lawStyles.rules}>
            {d.changed.map((ch) => (
              <ChangeCard key={ch.rule_id} change={ch} />
            ))}
          </div>
        </div>
      ) : null}

      {d.sources.added.length || d.sources.changed.length || d.sources.removed.length ? (
        <div className={styles.block}>
          <h3>Sources</h3>
          <ul className={styles.sources}>
            {d.sources.added.map((s) => (
              <SourceRow key={`a-${s.source_id}`} s={s} note="New source" />
            ))}
            {d.sources.changed.map((s) => (
              <SourceRow
                key={`c-${s.source_id}`}
                s={s}
                note={`Saved again: SHA-256 ${String(s.sha256_before ?? "").slice(0, 12)} is now ${String(s.sha256 ?? "").slice(0, 12)}`}
              />
            ))}
            {d.sources.removed.map((s) => (
              <SourceRow key={`r-${s.source_id}`} s={s} note="No longer quoted" />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function AllStates({ d }: { d: AllStatesDiff }) {
  const moved = d.states.filter((r) => !r.unchanged).sort((a, b) => stateName(a.st).localeCompare(stateName(b.st)));
  const same = d.states.length - moved.length;
  return (
    <section className={styles.result} aria-labelledby="h-result">
      <h2 id="h-result">
        {moved.length ? `${count(moved.length, "program", "programs")} changed` : "Nothing changed"}
      </h2>
      <p className={styles.none}>{versionNote(d)}</p>
      {moved.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Changes by program</caption>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Added</th>
                <th scope="col">Removed</th>
                <th scope="col">Changed</th>
                <th scope="col">Sources</th>
              </tr>
            </thead>
            <tbody>
              {moved.map((r) => (
                <tr key={r.st}>
                  <th scope="row">
                    <Link href={compareHref(d.from.name, d.to.name, r.st)}>{stateName(r.st)}</Link>
                  </th>
                  <td>{r.added}</td>
                  <td>{r.removed}</td>
                  <td>{r.changed}</td>
                  <td>{r.sources_added + r.sources_changed + r.sources_removed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {same && moved.length ? (
        <p className="meta">{count(same, "other program is", "other programs are")} the same in both.</p>
      ) : null}
    </section>
  );
}

export function VersionList({
  versions,
  current,
  notes,
  st,
}: {
  versions: VersionRef[];
  current: string | null;
  notes: Record<string, AllStatesDiff>;
  st?: string;
}) {
  return (
    <ol className={styles.versions} reversed>
      {[...versions].reverse().map((v) => {
        const prev = versions.find((p) => p.seq === v.seq - 1);
        return (
          <li key={v.name} className={styles.version}>
            <p className={styles.versionName}>
              <code>{v.name}</code>
              {v.name === current ? <span className={styles.inUse}>In use now</span> : null}
            </p>
            <p className="meta">
              {when(v.committed_at)}. {count(v.rules, "rule", "rules")} from {count(v.sources, "source", "sources")}.
              Branch <code>{v.branch_id}</code>
            </p>
            <p>
              {prev
                ? (versionNote(notes[v.name]) ?? "Compare it with the version before to see what changed.")
                : "The first version: every program's rules, with the law engine's reading of each."}
            </p>
            <p className="meta">Change note: {v.subject}</p>
            {prev ? (
              <p>
                <Link href={compareHref(prev.name, v.name, st)}>Compare with the version before</Link>
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

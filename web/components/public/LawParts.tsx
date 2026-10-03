import type { ReactNode } from "react";
import { categoryLabel } from "@/lib/categories";
import type { Rule, Source } from "@/lib/types";
import { asmHeader } from "./asm";
import Linkified from "./Linkified";
import AsmCode from "./AsmCode";
import { hostOf, isPdf, shortDate } from "./format";
import { ruleUse, skipReason } from "./irWords";
import type { Asm, IrRule, IrSkip } from "./types";
import styles from "./law.module.css";

const EXTRA_LABEL: Record<string, string> = {
  address_confidentiality: "Address confidentiality program",
  record_confidentiality: "Claim records kept confidential",
};

// Survivor-first order, the program's own review last. Unknown categories follow, so none is hidden.
export const LAW_ORDER = [
  "exam_no_bill",
  "exam_payment",
  "covered_expense",
  "expense_cap",
  "total_cap",
  "excluded_expense",
  "collateral_source",
  "filing_deadline",
  "reporting_requirement",
  "address_confidentiality",
  "record_confidentiality",
  "submission",
  "required_document",
  "processing_time",
  "minimum_loss",
  "emergency_award",
  "eligible_crime",
  "residency",
  "conduct_reduction",
];

export function lawCategoryLabel(category: string): string {
  return EXTRA_LABEL[category] ?? categoryLabel(category);
}

export function groupRules(rules: Rule[]): { category: string; rules: Rule[] }[] {
  const seen = [...new Set(rules.map((r) => r.category as string))];
  const order = [...LAW_ORDER.filter((c) => seen.includes(c)), ...seen.filter((c) => !LAW_ORDER.includes(c))];
  return order.map((category) => ({ category, rules: rules.filter((r) => r.category === category) }));
}

const USE_LABEL = { decides: "Decides", info: "Information", set_aside: "Set aside", not_compiled: "Not compiled" };

export function RuleEntry({
  rule,
  source,
  ir,
  skip,
  ids,
}: {
  rule: Rule;
  source?: Source;
  ir?: IrRule;
  skip?: IrSkip;
  // Rule ids on this page, so a summary that names another rule links to it.
  ids?: Set<string>;
}) {
  const href = rule.fragment_url ?? source?.url;
  const use = ruleUse(ir, skip);
  return (
    <article id={rule.id} className={styles.rule} aria-labelledby={`${rule.id}-pin`}>
      <p className={styles.cite}>
        <span id={`${rule.id}-pin`} className={styles.pinpoint}>
          {rule.pinpoint}
        </span>
        <a href={`#${rule.id}`} className={styles.ruleId} aria-label={`Link to rule ${rule.id}`}>
          {rule.id}
        </a>
      </p>
      <p className={styles.summary}>
        {ids ? <Linkified text={rule.summary} st={rule.id.slice(0, 2)} ids={ids} samePage /> : rule.summary}
      </p>
      <blockquote className={styles.quote} cite={source?.url}>
        <p>
          <mark>{rule.quote}</mark>
        </p>
      </blockquote>
      {href ? (
        <p className={styles.sourceLink}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {rule.fragment_url
              ? `Read this sentence on ${hostOf(href)}`
              : `Open the ${isPdf(source?.url, source?.raw_path) ? "PDF" : "source"} on ${hostOf(href)}`}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      ) : null}
      {source ? (
        <p className={styles.provenance}>
          From <a href={`#${source.id}`}>{source.title}</a>, saved {shortDate(source.retrieved_at)}, SHA-256{" "}
          <code title={source.sha256}>{source.sha256.slice(0, 12)}</code>
        </p>
      ) : null}
      <p className={`${styles.use} ${styles[`use_${use.use}`]}`}>
        <span className={styles.useTag}>{USE_LABEL[use.use]}</span> {use.text.replace(/^(Decides|Set aside): /, "")}
      </p>
    </article>
  );
}

export function SetAsideList({ st, skipped, rules }: { st: string; skipped: IrSkip[]; rules: Map<string, Rule> }) {
  const ids = new Set(rules.keys());
  return (
    <ul className={styles.setAside}>
      {skipped.map((s) => {
        const rule = rules.get(s.id);
        return (
          <li key={s.id}>
            <p className={styles.cite}>
              <a href={`#${s.id}`} className={styles.pinpoint}>
                {rule?.pinpoint ?? s.id}
              </a>
              <span className={styles.ruleId}>{s.id}</span>
            </p>
            {rule ? <p className={styles.summary}>{rule.summary}</p> : null}
            <p>
              <strong>Why: </strong>
              <Linkified text={skipReason(s.reason)} st={st} ids={ids} samePage />
            </p>
            <p className={styles.raw}>
              Normalizer note: <code>{s.reason}</code>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function SourceList({ sources, rules }: { sources: Source[]; rules: Rule[] }) {
  return (
    <ul className={styles.sources}>
      {sources.map((s) => {
        const quoted = rules.filter((r) => r.source_id === s.id).length;
        return (
          <li key={s.id} id={s.id} className={styles.source}>
            <p className={styles.sourceTitle}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </p>
            <dl className={styles.sourceFacts}>
              <div>
                <dt>Id</dt>
                <dd>
                  <code>{s.id}</code>
                </dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{s.kind.replace(/_/g, " ")}</dd>
              </div>
              <div>
                <dt>Saved</dt>
                <dd>
                  <time dateTime={s.retrieved_at}>{shortDate(s.retrieved_at)}</time>
                </dd>
              </div>
              <div>
                <dt>Rules quoting it</dt>
                <dd>{quoted}</dd>
              </div>
              <div className={styles.shaRow}>
                <dt>SHA-256 of the saved copy</dt>
                <dd>
                  <code className={styles.sha}>{s.sha256}</code>
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function Fresh({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={ok ? styles.ok : styles.warn}>{children}</span>;
}

export function AsmView({
  st,
  name,
  asm,
  ruleIds,
  lawSha,
}: {
  st: string;
  name: string;
  asm: Asm;
  ruleIds: Set<string>;
  lawSha: string;
}) {
  const head = asmHeader(asm.text);
  const meta = asm.meta;
  const rulesMatch = head.rules_sha256 === lawSha;
  const how =
    meta?.via === "api" ? "the law engine on the Tend server (tdis)" : "the engine's disassembler, tdis, when the site was built";
  return (
    <div className={styles.asm}>
      <dl className={styles.asmFacts}>
        <div>
          <dt>Listing from</dt>
          <dd>{how}</dd>
        </div>
        {head.compiler ? (
          <div>
            <dt>Compiled by</dt>
            <dd>
              {head.compiler}, image format {head.format}
            </dd>
          </div>
        ) : null}
        {head.counts ? (
          <div>
            <dt>Contents</dt>
            <dd>{head.counts}</dd>
          </div>
        ) : null}
        <div>
          <dt>Compiled from these rules</dt>
          <dd>
            <Fresh ok={rulesMatch}>
              {rulesMatch
                ? "Yes. The image names the same SHA-256 as the verified rules above."
                : "No. The image was compiled from a different version of the verified rules."}
            </Fresh>
          </dd>
        </div>
        {meta && meta.ir_fresh === false ? (
          <div>
            <dt>Compiled from the current law IR</dt>
            <dd>
              <Fresh ok={false}>
                Not yet. The image predates the latest normalizer update (IR version 2).{" "}
                {meta.kind_changes?.length
                  ? `${meta.kind_changes.length} rule${meta.kind_changes.length === 1 ? " is" : "s are"} treated differently now: ${meta.kind_changes.join(", ")}. The tags above show the current treatment.`
                  : "No rule changed kind."}{" "}
                It refreshes when the engine is rebuilt.
              </Fresh>
            </dd>
          </div>
        ) : null}
        {head.image_sha256 ? (
          <div className={styles.shaRow}>
            <dt>Image SHA-256</dt>
            <dd>
              <code className={styles.sha}>{head.image_sha256}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className={styles.asmJump}>
        Jump to: <a href="#asm-rules">rule table</a>, <a href="#asm-item">per-cost program</a>,{" "}
        <a href="#asm-aggregate">totals program</a>, or{" "}
        <a href={`/data/asm/${st}.txt`} download={`${st}.asm.txt`}>
          download the listing
        </a>
        .
      </p>
      <AsmCode text={asm.text} ruleIds={[...ruleIds]} name={name} />
    </div>
  );
}

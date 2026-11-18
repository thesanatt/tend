// A second labeling pass over the held-out rows, made by a model, and how it compares with the labels
// the rows' writer proposed. It is not a person's review. Nothing here builds a Review, and these
// labels never become the labels a committed result is scored against: a person's labels go in
// classifier-heldout.reviewed.csv. Nothing here reads a file or calls a model.
import { setHash, type HeldOutSet } from "./heldout";
import { dayText, plain, table } from "./heldout-doc";
import { NO_COST, rateText, SCORE_LABELS, wilson, type ScoredRow } from "./score";

export const SECOND_PASS_FILES = {
  labels: "classifier-heldout.second-pass.json",
  agreement: "classifier-heldout.second-pass.agreement.json",
} as const;

export const SECOND_START = "<!-- classifier-second-pass:start -->";
export const SECOND_END = "<!-- classifier-second-pass:end -->";

export interface SecondRow {
  id: string;
  label: string; // a cost label, or "unknown" for no cost
  unsure?: boolean;
  note?: string;
}

export interface SecondPass {
  notice: string;
  labeler: string;
  labeled: string; // the day the labels were made
  set_hash: string;
  seen: string[]; // rows whose proposed labels the labeler had seen before it labeled
  rows: SecondRow[];
}

// The file as committed, checked against the rows it labels: every row once, and only known labels.
export function readSecondPass(json: unknown, set: HeldOutSet): SecondPass {
  const j = json as Partial<SecondPass>;
  for (const key of ["notice", "labeler", "labeled", "set_hash"] as const)
    if (typeof j[key] !== "string" || !j[key]) throw new Error(`the second pass file needs "${key}"`);
  if (!Array.isArray(j.seen) || !Array.isArray(j.rows)) throw new Error('the second pass file needs "seen" and "rows"');
  if (j.set_hash !== setHash(set))
    throw new Error(`the second pass was made from other rows (set hash ${j.set_hash}); it cannot be compared`);
  const ids = new Set(set.rows.map((r) => r.id));
  const done = new Set<string>();
  for (const r of j.rows) {
    if (!ids.has(r.id)) throw new Error(`second pass row ${r.id} is not in the set`);
    if (done.has(r.id)) throw new Error(`second pass row ${r.id} is listed twice`);
    done.add(r.id);
    if (!SCORE_LABELS.includes(r.label)) throw new Error(`second pass row ${r.id}: "${r.label}" is not a label`);
  }
  const left = set.rows.filter((r) => !done.has(r.id)).map((r) => r.id);
  if (left.length) throw new Error(`the second pass has no label for ${left.join(", ")}`);
  for (const id of j.seen) if (!ids.has(id)) throw new Error(`seen row ${id} is not in the set`);
  return j as SecondPass;
}

export interface Count {
  k: number;
  n: number;
}

export interface Differ {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  proposed: string;
  second: string;
  writer_note: string;
  second_note: string;
}

// The rules-only run, counted against one set of labels.
export interface RulesCount {
  all: Count;
  cost: Count; // rows the labels give a cost label
  none: Count; // rows the labels give none
}

// Counts only. A rate is worked out from its two counts where it is shown.
export interface Agreement {
  set_hash: string;
  labeler: string;
  labeled: string;
  measured: string; // the day the comparison was made
  not_a_review: string;
  seen: string[];
  same: Count;
  same_unseen: Count; // the same, leaving out the rows in seen
  kappa: number; // Cohen's kappa, to four places
  cost_rows: { proposed: number; second: number };
  unsure: { writer: number; second: number; both: number };
  differ: Differ[];
  rules: { proposed: RulesCount; second: RulesCount; agreed: RulesCount };
}

export const NOT_A_REVIEW =
  "Both sets of labels were made by AI models. No person has reviewed either, so nothing here is accuracy.";

const writerUnsure = (note: string | undefined) => (note ?? "").startsWith("unsure");

function rulesCount(rows: { expect: string; got: string }[]): RulesCount {
  const right = (list: typeof rows) => ({ k: list.filter((r) => r.got === r.expect).length, n: list.length });
  return {
    all: right(rows),
    cost: right(rows.filter((r) => r.expect !== NO_COST)),
    none: right(rows.filter((r) => r.expect === NO_COST)),
  };
}

// ruled is the rules-only run over the same rows (runHeldOut with no answers). What the rules give a
// row does not depend on its label, so the one run can be counted against either set of labels.
export function agreement(set: HeldOutSet, second: SecondPass, ruled: ScoredRow[], measured: string): Agreement {
  const label = new Map(second.rows.map((r) => [r.id, r]));
  const got = new Map(ruled.map((r) => [r.id, r.got]));
  const seen = new Set(second.seen);
  const pairs = set.rows.map((r) => {
    const s = label.get(r.id)!;
    if (!got.has(r.id)) throw new Error(`the rules run has no row ${r.id}`);
    return { row: r, proposed: r.expect, second: s.label, s, got: got.get(r.id)! };
  });
  const n = pairs.length;
  const same = pairs.filter((p) => p.proposed === p.second);
  const unseen = pairs.filter((p) => !seen.has(p.row.id));

  // Cohen's kappa: agreement beyond what two labelers with these label counts would reach by chance.
  const chance = SCORE_LABELS.reduce(
    (sum, l) =>
      sum + (pairs.filter((p) => p.proposed === l).length / n) * (pairs.filter((p) => p.second === l).length / n),
    0,
  );
  const kappa = (same.length / n - chance) / (1 - chance);

  return {
    set_hash: setHash(set),
    labeler: second.labeler,
    labeled: second.labeled,
    measured,
    not_a_review: NOT_A_REVIEW,
    seen: [...second.seen],
    same: { k: same.length, n },
    same_unseen: { k: unseen.filter((p) => p.proposed === p.second).length, n: unseen.length },
    kappa: Number(kappa.toFixed(4)),
    cost_rows: {
      proposed: pairs.filter((p) => p.proposed !== NO_COST).length,
      second: pairs.filter((p) => p.second !== NO_COST).length,
    },
    unsure: {
      writer: pairs.filter((p) => writerUnsure(p.row.note)).length,
      second: pairs.filter((p) => p.s.unsure).length,
      both: pairs.filter((p) => writerUnsure(p.row.note) && p.s.unsure).length,
    },
    differ: pairs
      .filter((p) => p.proposed !== p.second)
      .map((p) => ({
        id: p.row.id,
        date: p.row.date,
        amount_cents: p.row.amount_cents,
        description: p.row.description,
        proposed: p.proposed,
        second: p.second,
        writer_note: p.row.note ?? "",
        second_note: `${p.s.unsure ? "unsure: " : ""}${p.s.note ?? ""}`,
      })),
    rules: {
      proposed: rulesCount(pairs.map((p) => ({ expect: p.proposed, got: p.got }))),
      second: rulesCount(pairs.map((p) => ({ expect: p.second, got: p.got }))),
      agreed: rulesCount(same.map((p) => ({ expect: p.proposed, got: p.got }))),
    },
  };
}

// Whether two comparisons hold the same numbers. The day they were made is not a number.
export function sameAgreement(a: Agreement, b: Agreement): boolean {
  return JSON.stringify({ ...a, measured: "" }) === JSON.stringify({ ...b, measured: "" });
}

const rate = (c: Count) => rateText(wilson(c.k, c.n));
const name = (label: string) => (label === NO_COST ? "no cost label" : `\`${label}\``);
const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// The part of docs/EVAL.md that holds the comparison, written from the committed counts.
export function secondDocBlock(a: Agreement): string {
  const rules = (title: string, r: RulesCount) => [title, rate(r.all), rate(r.cost), rate(r.none)];
  return [
    SECOND_START,
    "<!-- Written by `cd web && npx tsx scripts/classifier-second-pass.ts --write` from the second pass file in",
    "     web/tests/local/fixtures. Change a number by running that, not by editing between these marks. -->",
    "",
    `The second pass: ${a.labeler}, on ${dayText(a.labeled)} (\`${SECOND_PASS_FILES.labels}\`, compared on ` +
      `${dayText(a.measured)}). ${a.not_a_review}`,
    "",
    ...table(
      ["", "Proposed labels against the second pass"],
      [
        ["Rows given the same label", rate(a.same)],
        [
          `... leaving out the ${a.seen.length} rows whose proposed labels the second labeler had seen`,
          rate(a.same_unseen),
        ],
        ["Cohen's kappa, which takes out the agreement two labelers reach by chance", a.kappa.toFixed(4)],
        ["Rows given a cost label", `${a.cost_rows.proposed} proposed, ${a.cost_rows.second} in the second pass`],
        [
          "Rows flagged unsure",
          `${a.unsure.writer} by the writer, ${a.unsure.second} in the second pass, ${a.unsure.both} by both`,
        ],
        [
          "Rows labeled differently",
          `${a.differ.length}${a.differ.length ? `: ${a.differ.map((d) => d.id).join(", ")}` : ""}`,
        ],
      ],
    ),
    "",
    ...(a.differ.length
      ? [
          "The rows the two passes label differently, which are the first ones for a person to settle:",
          "",
          ...table(
            ["Row", "Date", "Amount", "Bank text", "Proposed", "Second pass", "Writer's note", "Second labeler's note"],
            a.differ.map((d) => [
              d.id,
              d.date,
              dollars(d.amount_cents),
              plain(d.description),
              name(d.proposed),
              name(d.second),
              plain(d.writer_note),
              plain(d.second_note),
            ]),
          ),
          "",
        ]
      : []),
    "The rules-only run counted against each set of labels. What the rules give a row does not depend on its " +
      "label, so this is one run counted three ways:",
    "",
    ...table(
      ["Labels", "All rows right", "Rows that should get a cost label, right", "Rows that should get none, right"],
      [
        rules("Proposed", a.rules.proposed),
        rules("Second pass", a.rules.second),
        rules(`Only the ${a.same.k} rows both passes label the same`, a.rules.agreed),
      ],
    ),
    SECOND_END,
  ].join("\n");
}

export function withSecondBlock(doc: string, block: string): string {
  const start = doc.indexOf(SECOND_START);
  const end = doc.indexOf(SECOND_END);
  if (start < 0 || end < start) throw new Error("docs/EVAL.md has lost the classifier-second-pass marks");
  return doc.slice(0, start) + block + doc.slice(end + SECOND_END.length);
}

export function secondBlockIn(doc: string): string | null {
  const start = doc.indexOf(SECOND_START);
  const end = doc.indexOf(SECOND_END);
  return start < 0 || end < start ? null : doc.slice(start, end + SECOND_END.length);
}

// The held-out rows for the cost classifier (tests/local/fixtures/classifier-heldout.json): turning
// them into statement rows, running the app's own pipeline over them with no model or with a file
// of recorded model answers, and the CSV a person corrects the labels in. Nothing here reads a
// file or calls a model, so a test, a script and a page can all use it.
import { classifyDetailed, modelRow, toFacts } from "./classify";
import type { ModelRow } from "./cloud";
import { kindFor, readRows } from "./csv";
import { forgetSessions, type LmApi, type LmSession } from "./deviceai";
import { fnv64 } from "./hash";
import { classifyDeterministic, contentKey, MODEL_LABELS, type TxnFacts } from "./rules";
import { NO_COST, score, SCORE_LABELS, type Score, type ScoredRow } from "./score";
import type { ClassifyContext, ClassifyReport, LocalTxn } from "./types";

export interface HeldOutRow {
  id: string;
  date: string;
  amount_cents: number; // money out is positive
  merchant: string;
  category: string;
  description: string;
  expect: string; // a cost label, or "unknown" for no cost
  source: string; // how the row was written
  note?: string;
}

export interface HeldOutSet {
  notice?: string;
  label_policy?: string[];
  context: ClassifyContext;
  rows: HeldOutRow[];
}

// Statement rows as a bank file gives them: the kind comes from the words, as the CSV reader does it.
export function heldOutTxns(rows: HeldOutRow[]): LocalTxn[] {
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount_cents: r.amount_cents,
    description: r.description,
    merchant: r.merchant,
    category: r.category,
    origin: "csv",
    kind: kindFor(r.description, r.amount_cents),
  }));
}

// Changes when any row's text, date or amount changes, so answers made from other rows are noticed.
export function setHash(set: HeldOutSet): string {
  return fnv64(
    JSON.stringify(set.rows.map((r) => [r.id, r.date, r.amount_cents, r.merchant, r.category, r.description])),
  );
}

export function checkSet(set: HeldOutSet): void {
  const seen = new Set<string>();
  for (const r of set.rows) {
    if (seen.has(r.id)) throw new Error(`row id ${r.id} is listed twice`);
    seen.add(r.id);
    if (!SCORE_LABELS.includes(r.expect)) throw new Error(`row ${r.id}: "${r.expect}" is not a label`);
  }
}

// The words a model would be shown for a row, keyed the way the pipeline keeps one of each.
function sentKey(f: TxnFacts): string {
  const m = modelRow("", f);
  return rowKey(m);
}
function rowKey(m: ModelRow): string {
  return contentKey({
    ref: "",
    kind: m.kind as TxnFacts["kind"],
    merchant_name: m.merchant,
    merchant_category: m.category,
    description: m.description,
    date: "",
  });
}

// ---- the review file ----

export const REVIEW_COLUMNS = [
  "id",
  "date",
  "money_out",
  "description",
  "merchant",
  "category",
  "proposed",
  "reviewed",
  "source",
  "note",
] as const;

const cell = (text: string) => (/[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text);
const dollars = (cents: number) => `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2)}`;

// One line a row, with an empty "reviewed" column for a person to fill in.
export function reviewCsv(set: HeldOutSet): string {
  const lines = [REVIEW_COLUMNS.join(",")];
  for (const r of set.rows)
    lines.push(
      [
        r.id,
        r.date,
        dollars(r.amount_cents),
        r.description,
        r.merchant,
        r.category,
        r.expect,
        "",
        r.source,
        r.note ?? "",
      ]
        .map(cell)
        .join(","),
    );
  return `${lines.join("\n")}\n`;
}

export interface Review {
  labels: Map<string, string>; // rows a person looked at, with the label they settled on
  skipped: Set<string>; // rows a person asked to leave out
  changed: { id: string; from: string; to: string }[];
  blank: number; // rows with nothing in the reviewed column
}

const AGREE = new Set(["ok", "yes", "y", "agree", "same"]);

// Reads a person's copy of the review file. In the reviewed column: "ok" keeps the proposed
// label, a label replaces it ("none" also means no cost), "skip" leaves the row out, and an
// empty cell means nobody has looked yet. Only the id and reviewed columns are read, so the file
// can be sorted or carry extra columns.
export function readReview(text: string, set: HeldOutSet): Review {
  const rows = readRows(text.replace(/^\uFEFF/, ""), ",");
  const header = (rows[0]?.cells ?? []).map((c) => c.trim().toLowerCase());
  const idAt = header.indexOf("id");
  const reviewedAt = header.indexOf("reviewed");
  if (idAt < 0 || reviewedAt < 0) throw new Error('the review file needs "id" and "reviewed" columns');
  const proposed = new Map(set.rows.map((r) => [r.id, r.expect]));
  const review: Review = { labels: new Map(), skipped: new Set(), changed: [], blank: 0 };
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const id = (row.cells[idAt] ?? "").trim();
    const from = proposed.get(id);
    if (from === undefined) throw new Error(`line ${row.line}: "${id}" is not a row id in the set`);
    if (seen.has(id)) throw new Error(`line ${row.line}: row ${id} is listed twice`);
    seen.add(id);
    const said = (row.cells[reviewedAt] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (said === "") review.blank++;
    else if (said === "skip") review.skipped.add(id);
    else {
      const to = AGREE.has(said) ? from : said === "none" ? NO_COST : said;
      if (!SCORE_LABELS.includes(to))
        throw new Error(
          `line ${row.line}: "${said}" is not a label. Use ok, skip, none or one of: ${SCORE_LABELS.join(", ")}`,
        );
      review.labels.set(id, to);
      if (to !== from) review.changed.push({ id, from, to });
    }
  }
  review.blank += set.rows.length - seen.size; // rows missing from the file were not looked at
  return review;
}

// Who stands behind the labels, in words a report can print.
export function labelStatus(set: HeldOutSet, review: Review | null): string {
  const looked = review ? review.labels.size + review.skipped.size : 0;
  if (!review || looked === 0) return "proposed by the rows' writer, not reviewed by a person";
  const detail = `${review.changed.length} corrected, ${review.skipped.size} left out`;
  return looked === set.rows.length
    ? `reviewed by a person, all ${set.rows.length} rows (${detail})`
    : `partly reviewed by a person, ${looked} of ${set.rows.length} rows (${detail}); the rest are proposed`;
}

// ---- recorded model answers ----

export interface AnswerRun {
  answers: Record<string, string>; // row id -> the label the app took from the model
  [extra: string]: unknown;
}

export interface AnswerFile {
  runs: AnswerRun[];
  [extra: string]: unknown;
}

// Accepts the file the Chrome page saves ({ runs: [{ answers }] }), one run ({ answers }), or a
// plain map of row id to a label or to { expense }.
export function parseAnswers(json: unknown): AnswerFile {
  const plain = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("answers must be a map of row id to label");
    const out: Record<string, string> = {};
    for (const [id, a] of Object.entries(v as Record<string, unknown>)) {
      const label = typeof a === "string" ? a : (a as { expense?: unknown } | null)?.expense;
      if (typeof label !== "string") throw new Error(`answer for ${id} has no label`);
      out[id] = label;
    }
    return out;
  };
  const file = json as { runs?: unknown; answers?: unknown } | null;
  if (file && Array.isArray(file.runs))
    return {
      ...file,
      runs: file.runs.map((r) => ({ ...(r as object), answers: plain((r as { answers?: unknown }).answers) })),
    };
  if (file && typeof file === "object" && "answers" in file)
    return { runs: [{ ...file, answers: plain(file.answers) }] };
  return { runs: [{ answers: plain(json) }] };
}

// A stand-in for Chrome's LanguageModel that gives back recorded answers, so a model pass can be
// scored through the real pipeline (its batches, the two barred labels, ride links) with no model.
function replayModel(byKey: Map<string, string>): LmApi {
  const session: LmSession = {
    async prompt(input) {
      const text = String(input);
      const rows = JSON.parse(text.slice(text.indexOf("\n") + 1)) as ModelRow[];
      const results = rows.flatMap((r) => {
        const expense = byKey.get(rowKey(r));
        return expense === undefined ? [] : [{ ref: r.ref, expense, reason: "" }];
      });
      return JSON.stringify({ results });
    },
    clone: async () => session,
    destroy: () => undefined,
  };
  return { availability: async () => "available", create: async () => session };
}

// ---- running the set ----

export interface HeldOutRun {
  rows: ScoredRow[];
  report: ClassifyReport;
  // Lost-pay lines the pay step adds for paychecks that never came. They are not rows, so they are not scored.
  added_lines: string[];
  // Only for a run with recorded answers.
  model?: { asked: number; answered: number; unused: string[]; missing: string[] };
}

export interface HeldOutOptions {
  answers?: Record<string, string>; // recorded model answers by row id; leave out for rules only
  review?: Review | null;
}

// Runs every row through classifyDetailed as the app would with no cloud consent, then lines the
// result up with the labels. Rows a reviewer skipped still run (a ride needs its care row), but are not scored.
export async function runHeldOut(set: HeldOutSet, opts: HeldOutOptions = {}): Promise<HeldOutRun> {
  checkSet(set);
  const txns = heldOutTxns(set.rows);
  const facts = txns.map(toFacts);
  const sent = new Set(facts.filter((f) => !classifyDeterministic(f)).map((f) => f.ref));
  const keys = new Map(facts.map((f) => [f.ref, sentKey(f)]));

  let report: ClassifyReport;
  let model: HeldOutRun["model"];
  if (!opts.answers) report = await classifyDetailed(txns, set.context, { deviceAi: false });
  else {
    const byKey = new Map<string, string>();
    const from = new Map<string, string>();
    for (const [id, label] of Object.entries(opts.answers)) {
      const key = keys.get(id);
      if (key === undefined) throw new Error(`answers name row ${id}, which is not in the set`);
      if (!MODEL_LABELS.includes(label)) throw new Error(`answer for ${id}: "${label}" is not a label`);
      if (byKey.has(key) && byKey.get(key) !== label)
        throw new Error(`rows ${from.get(key)} and ${id} read the same but have different answers`);
      byKey.set(key, label);
      from.set(key, id);
    }
    const holder = globalThis as { LanguageModel?: unknown };
    const before = holder.LanguageModel;
    forgetSessions();
    holder.LanguageModel = replayModel(byKey);
    try {
      report = await classifyDetailed(txns, set.context, {});
    } finally {
      forgetSessions();
      if (before === undefined) delete holder.LanguageModel;
      else holder.LanguageModel = before;
    }
    if (report.device.errors.length) throw new Error(`replay failed: ${report.device.errors.join("; ")}`);
    const asked = [...sent];
    model = {
      asked: asked.length,
      answered: asked.filter((id) => byKey.has(keys.get(id)!)).length,
      unused: Object.keys(opts.answers).filter((id) => !sent.has(id)),
      missing: asked.filter((id) => !byKey.has(keys.get(id)!)),
    };
  }

  const ids = new Set(set.rows.map((r) => r.id));
  const skipped = opts.review?.skipped ?? new Set<string>();
  const rows: ScoredRow[] = [];
  set.rows.forEach((r, i) => {
    if (skipped.has(r.id)) return;
    const c = report.all[i];
    if (c.ref !== r.id) throw new Error(`the pipeline returned row ${c.ref} where ${r.id} was expected`);
    rows.push({
      id: r.id,
      expect: opts.review?.labels.get(r.id) ?? r.expect,
      // What the person is offered: a label on a row that is not offered adds nothing to a claim.
      got: c.candidate && c.expense !== NO_COST ? c.expense : NO_COST,
      method: c.method,
      sent: sent.has(r.id),
      key: keys.get(r.id)!,
      confirmed: c.confirmed,
      before: r.date < set.context.incident_date,
      unsure: (r.note ?? "").startsWith("unsure"),
      group: r.source,
    });
  });
  const added_lines = report.items
    .filter((item) => !ids.has(item.item_id))
    .map((item) => `${item.date} ${item.expense}`);
  return { rows, report, added_lines, model };
}

// The answers of a model that never erred: every row no rule matched, answered with its label.
// Rows that read the same get one answer, as the pipeline asks about them once. When some of them
// are rides it is transportation, because a ride is only offered on a day with a care charge and
// the answer costs nothing on other days. Otherwise it is the label most of them carry. This is no
// model's result. Scored like one, it shows the most a model could add through this pipeline,
// after the barred labels and the ride rule take their share. A test checks that no other answer
// for any such group scores higher.
export function ceilingAnswers(set: HeldOutSet, review: Review | null = null): Record<string, string> {
  const facts = heldOutTxns(set.rows).map(toFacts);
  const votes = new Map<string, Map<string, number>>();
  const sent: [string, string][] = [];
  set.rows.forEach((r, i) => {
    if (classifyDeterministic(facts[i])) return;
    const key = sentKey(facts[i]);
    const label = review?.labels.get(r.id) ?? r.expect;
    const tally = votes.get(key) ?? new Map<string, number>();
    tally.set(label, (tally.get(label) ?? 0) + 1);
    votes.set(key, tally);
    sent.push([r.id, key]);
  });
  const best = (tally: Map<string, number>) =>
    tally.has("transportation") ? "transportation" : [...tally].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return Object.fromEntries(sent.map(([id, key]) => [id, best(votes.get(key)!)]));
}

// ---- the committed result ----

export const HELDOUT_FILES = {
  set: "classifier-heldout.json",
  review: "classifier-heldout.review.csv", // written from the set; a person copies it
  reviewed: "classifier-heldout.reviewed.csv", // the person's copy, read when it exists
  rules: "classifier-heldout.rules.result.json",
} as const;

export interface HeldOutResult {
  set: string;
  set_hash: string;
  run: string; // "rules only", or the model whose recorded answers were scored
  measured: string; // the day the numbers were made
  rows_are: string;
  labels: string;
  score: Score;
  added_lines: string[];
  model?: HeldOutRun["model"];
}

// Rates to four places, so the file does not change with the last digit of a division.
const rounded = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_, v: unknown) =>
      typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(4)) : v,
    ),
  ) as T;

export function resultRecord(
  set: HeldOutSet,
  run: HeldOutRun,
  about: { run: string; measured: string; review?: Review | null },
): HeldOutResult {
  return rounded({
    set: HELDOUT_FILES.set,
    set_hash: setHash(set),
    run: about.run,
    measured: about.measured,
    rows_are: "fictional, written for this set; the mix is chosen by label and is not a sample of real statements",
    labels: labelStatus(set, about.review ?? null),
    score: score(run.rows),
    added_lines: run.added_lines,
    ...(run.model ? { model: run.model } : {}),
  });
}

// Whether two results hold the same numbers. The day they were made is not a number.
export function sameResult(a: HeldOutResult, b: HeldOutResult): boolean {
  const bare = (r: HeldOutResult) => JSON.stringify({ ...r, measured: "" });
  return bare(a) === bare(b);
}

// The cited summary PDF: every line with its amount, transaction, rule pinpoint, verbatim quote,
// and link; held lines with the exam billing law; the totals; what is still needed; where to
// file; and the protections that keep the survivor's address and file private.
import type { ChecklistItem, FilingRoute, Letter } from "../contracts";
import { formatDay, isIsoDay } from "../dates";
import { expenseLabel, expenseRank } from "../expenses";
import { formatCents } from "../money";
import type { EngineInput, EngineItem, EngineLine, EngineOutput, LineStatus, Rule } from "../types";
import { METHOD_LABEL, privacyNotes } from "./filing";
import { param, type LawBook } from "./law";
import { CONTENT_W, MARGIN, Pdf, type ColorKey, type Run } from "./pdf";
import { isDemo, TOTAL_LINE, type FormSpec } from "./specs";

export interface SummaryInput {
  law: LawBook;
  input: EngineInput;
  output: EngineOutput;
  stillNeeded: ChecklistItem[];
  filing: FilingRoute[];
  letters: Letter[];
  form: FormSpec | null;
}

const ORDER: LineStatus[] = ["eligible", "held", "needs_confirmation", "excluded", "unknown_rule", "out_of_window"];

const STATUS_TITLE: Record<LineStatus, string> = {
  eligible: "Counted",
  held: "Held. Do not pay this.",
  needs_confirmation: "Waiting for your yes",
  excluded: "Not covered",
  unknown_rule: "Not named in the rules",
  out_of_window: "Outside the dates",
};

const STATUS_COLOR: Partial<Record<LineStatus, ColorKey>> = { eligible: "green", held: "clay" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

class Writer {
  constructor(
    readonly pdf: Pdf,
    readonly law: LawBook,
  ) {}

  h2(text: string) {
    this.pdf.ensure(64);
    this.pdf.space(14);
    this.pdf.text(text, { font: "serifBold", size: 15, leading: 19 });
    this.pdf.space(4);
  }

  h3(runs: Run[]) {
    this.pdf.ensure(48);
    this.pdf.space(8);
    this.pdf.runs(runs, { font: "bold", size: 10.5, leading: 14 });
    this.pdf.space(2);
  }

  p(text: string | Run[], color: ColorKey = "ink", size = 9.5) {
    this.pdf.runs(typeof text === "string" ? [{ text }] : text, { size, color });
    this.pdf.space(3);
  }

  small(text: string | Run[], color: ColorKey = "ink3") {
    this.p(text, color, 8);
  }

  // A rule as proof: pinpoint and id, the verbatim quote, and the official page.
  quote(rule: Rule, bar: ColorKey = "line") {
    const { pdf } = this;
    const x = MARGIN + 10;
    const w = CONTENT_W - 10;
    pdf.ensure(40);
    const page = pdf.page;
    const top = pdf.y;
    pdf.runs(
      [
        { text: rule.pinpoint, font: "bold" },
        { text: `   ${rule.id}`, font: "mono", color: "ink3" },
      ],
      { size: 8.5, leading: 11.5 },
      x,
      w,
    );
    pdf.runs([{ text: `"${rule.quote.trim()}"` }], { size: 8.5, leading: 11.5, font: "italic" }, x, w);
    const printed = this.law.printedLink(rule);
    if (printed)
      pdf.runs([{ text: printed, color: "green", link: this.law.link(rule) }], { size: 7.5, leading: 10 }, x, w);
    // A bar beside the quote, when it stayed on one page.
    if (pdf.page === page) pdf.rect(MARGIN + 1, pdf.y + 2, 1.5, top - pdf.y - 3, bar);
    pdf.space(5);
  }
}

function checksSection(w: Writer, input: EngineInput, output: EngineOutput) {
  const { law, pdf } = w;
  const { deadline, reporting, minimum_loss } = output.checks;
  w.h2("Checks");
  const cites = (ids: string[]) =>
    ids
      .map((id) => law.rule(id))
      .filter((r): r is Rule => !!r)
      .map((r) => r.pinpoint)
      .filter((p, i, all) => all.indexOf(p) === i)
      .join("; ");

  const deadlineText =
    deadline.status === "ok" && deadline.deadline_date
      ? `On time. File by ${formatDay(deadline.deadline_date)}.`
      : deadline.status === "late" && deadline.deadline_date
        ? `The usual deadline was ${formatDay(deadline.deadline_date)}. Ask the program whether a late claim can still be filed.`
        : deadline.rule_ids.length
          ? "Tend could not turn this deadline into a date. Read the rule or ask the program."
          : "Tend found no filing deadline in the verified rules. Ask the program.";
  const reportingText =
    reporting.status === "satisfied"
      ? !reporting.rule_ids.length
        ? "Tend found no police report rule for this state."
        : input.context.police_report === "yes"
          ? "You said it was reported, which meets this rule."
          : "Your forensic exam counts in place of a police report here."
      : reporting.status === "required"
        ? "This program asks for a police report or another proof it accepts."
        : reporting.status === "not_required"
          ? reporting.rule_ids.length
            ? "This program does not require a police report."
            : "Tend found no police report rule for this state. Ask the program."
          : "This depends on whether it was reported. You do not have to say.";
  const minimumText: Record<string, string> = {
    met: "Met.",
    not_met: "Not met yet.",
    waived: "Waived for survivors of sexual assault.",
    may_be_waived: "Below the minimum, but the program can waive it for survivors of sexual assault.",
    unknown: "Depends on how many days of work you missed.",
  };
  const rows: [string, string, string][] = [
    ["Filing deadline", deadlineText, cites(deadline.rule_ids)],
    ["Police report", reportingText, cites(reporting.rule_ids)],
    [
      "Minimum loss",
      // With no rule the engine reports met; the summary does not claim a minimum it never found.
      !minimum_loss.rule_ids.length && minimum_loss.status === "met"
        ? "Tend found no minimum loss rule for this state."
        : (minimumText[minimum_loss.status] ?? "Ask the program how its minimum applies."),
      minimum_loss.rule_ids.length ? cites(minimum_loss.rule_ids) : "",
    ],
  ];
  for (const [label, text, cite] of rows) {
    pdf.ensure(52);
    const top = pdf.y;
    pdf.runs([{ text: label, font: "bold" }], { size: 9.5 }, MARGIN, 110);
    const after = pdf.y;
    pdf.y = top;
    pdf.runs([{ text }], { size: 9.5 }, MARGIN + 116, CONTENT_W - 116);
    if (cite) pdf.runs([{ text: cite, color: "ink3" }], { size: 8 }, MARGIN + 116, CONTENT_W - 116);
    pdf.y = Math.min(pdf.y, after) - 4;
    pdf.rule("line", 0.4);
    pdf.space(6);
  }
  const fromReport = (output.checks.deadline as { flags?: string[] }).flags?.includes("deadline_from_report");
  if (fromReport) {
    w.small(
      "The deadline is measured from the date it happened. The law counts from your report, so you may have longer.",
    );
  }
}

interface Group {
  status: LineStatus;
  expense: string;
  lines: EngineLine[];
}

function groupsOf(output: EngineOutput): Group[] {
  const map = new Map<string, Group>();
  for (const line of output.lines) {
    const key = `${line.status}|${line.expense}`;
    const g = map.get(key) ?? { status: line.status, expense: line.expense, lines: [] };
    g.lines.push(line);
    map.set(key, g);
  }
  return [...map.values()].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || expenseRank(a.expense) - expenseRank(b.expense),
  );
}

function groupRules(law: LawBook, lines: EngineLine[]): Rule[] {
  const ids: string[] = [];
  for (const l of lines) {
    const alt = (l as EngineLine & { alt_cap_rule_ids?: string[] }).alt_cap_rule_ids ?? [];
    for (const id of [...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : []), ...alt]) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids.map((id) => law.rule(id)).filter((r): r is Rule => !!r);
}

function lineNotes(law: LawBook, line: EngineLine, item: EngineItem | undefined): string[] {
  const notes: string[] = [];
  const pin = (id: string) => law.rule(id)?.pinpoint ?? id;
  // The engine subtracts insurance (step 6) only under a collateral source rule, and never below
  // zero, so the note shows what was taken off, not what the insurer paid in total.
  const collateral = line.rule_ids.some((id) => law.rule(id)?.category === "collateral_source");
  const insurance = Math.min(item?.insurance_paid_cents ?? 0, line.requested_cents);
  if (line.status === "eligible" && collateral && insurance > 0) {
    notes.push(`Less ${formatCents(insurance)} that insurance paid.`);
  }
  if (line.cap_rule_id) {
    notes.push(
      line.allowed_cents === 0
        ? `The limit in ${pin(line.cap_rule_id)} was already reached.`
        : `Cut to the limit in ${pin(line.cap_rule_id)}.`,
    );
  }
  for (const flag of line.flags) {
    const [kind, id] = flag.split(":");
    if (kind === "rate_unverified" && id) {
      const unit = String(param(law.rule(id), "per") ?? "unit");
      notes.push(
        `Not checked against the per-${unit} limit in ${pin(id)}, because the number of ${unit === "unit" ? "units" : `${unit}s`} is not known.`,
      );
    } else if (kind === "deadline_from_report") {
      notes.push("The deadline is measured from the date it happened; the law counts from the report.");
    } else {
      notes.push(flag);
    }
  }
  return notes;
}

function linesSection(w: Writer, input: EngineInput, output: EngineOutput) {
  const { law, pdf } = w;
  const items = new Map(input.items.map((i) => [i.item_id, i]));
  w.h2("Every cost and the law behind it");
  w.small(
    "Costs are grouped by kind and status. Each group quotes the law word for word, with a link to the official page. Each cost shows the record it came from.",
  );

  for (const g of groupsOf(output)) {
    const asked = g.lines.reduce((s, l) => s + l.requested_cents, 0);
    const counted = g.lines.reduce((s, l) => s + l.allowed_cents, 0);
    w.h3([
      { text: `${expenseLabel(g.expense)}: ` },
      { text: STATUS_TITLE[g.status], color: STATUS_COLOR[g.status] ?? "ink" },
    ]);
    const summary =
      g.status === "eligible"
        ? `${plural(g.lines.length, "cost")}, ${formatCents(asked)}. Counted: ${formatCents(counted)}.`
        : `${plural(g.lines.length, "cost")}, ${formatCents(asked)}.`;
    w.small(summary, "ink2");

    const rules = groupRules(law, g.lines);
    if (g.status === "held") {
      const noBill = rules.filter((r) => r.category === "exam_no_bill");
      const payers = rules.filter((r) => r.category === "exam_payment");
      w.p(
        noBill.length
          ? "The law says you should not be billed for this exam. It is left out of the amount, and Tend wrote a letter for the billing office."
          : "The law says how this exam is paid for, so it is left out of the amount. Tend wrote a letter for the billing office.",
        "clay",
      );
      for (const r of noBill) w.quote(r, "clay");
      if (payers.length) {
        w.small(noBill.length ? "Who pays for the exam instead:" : "How the exam is paid for:", "ink2");
        for (const r of payers) w.quote(r, noBill.length ? "line" : "clay");
      }
    } else if (g.status === "unknown_rule") {
      w.p(
        `None of ${law.name}'s verified rules name this kind of cost, so it is left out. An advocate or the program can tell you if it is covered.`,
        "ink2",
      );
    } else if (g.status === "out_of_window") {
      w.p(
        `These are dated before ${formatDay(input.context.incident_date)} or after ${formatDay(input.context.as_of_date)}, so they are not counted.`,
        "ink2",
      );
    } else {
      if (g.status === "needs_confirmation") w.p("Tend found these but does not count them until you say yes.", "ink2");
      if (g.status === "excluded") w.p("The law says the program does not pay for this kind of cost.", "ink2");
      for (const r of rules) w.quote(r);
    }

    // Lines: date, what and its record, amount, counted.
    const shared = g.lines.every((l) => l.rule_ids.join() === g.lines[0].rule_ids.join());
    const cols = { date: 58, amount: 64, counted: 64 };
    const descW = CONTENT_W - cols.date - cols.amount - cols.counted - 12;
    const xDesc = MARGIN + cols.date;
    const xAmount = xDesc + descW + 6;
    const xCounted = xAmount + cols.amount + 6;
    const right = (text: string, x: number, width: number) =>
      pdf.runs([{ text, font: "bold" }], { size: 7.5 }, x + width - pdf.width(text, "bold", 7.5), width, false);
    const header = () => {
      pdf.ensure(16);
      const top = pdf.y;
      pdf.runs([{ text: "Date", font: "bold" }], { size: 7.5 }, MARGIN, cols.date, false);
      pdf.y = top;
      pdf.runs([{ text: "Cost and the record it came from", font: "bold" }], { size: 7.5 }, xDesc, descW, false);
      pdf.y = top;
      right("Amount", xAmount, cols.amount);
      pdf.y = top;
      right("Counted", xCounted, cols.counted);
      pdf.space(1);
      pdf.rule("ink", 0.6);
      pdf.space(3);
    };
    pdf.space(2);
    header();
    for (const line of g.lines) {
      const item = items.get(line.item_id);
      const notes = lineNotes(law, line, item);
      if (!shared && line.rule_ids.length) {
        notes.unshift(`Rules: ${line.rule_ids.map((id) => law.rule(id)?.pinpoint ?? id).join("; ")}`);
      }
      const desc: Run[] = [{ text: item?.description?.trim() || expenseLabel(line.expense) }];
      const record: Run[] = [{ text: `Record ${line.item_id}`, font: "mono", color: "ink3" }];
      const height =
        pdf.measure(desc, { size: 8.5, leading: 11 }, descW) +
        pdf.measure(record, { size: 7, leading: 9.5 }, descW) +
        notes.reduce((h, n) => h + pdf.measure([{ text: n }], { size: 7.5, leading: 10 }, descW), 0) +
        6;
      if (pdf.y - height < pdf.bottom) {
        pdf.newPage();
        header();
      }
      const top = pdf.y;
      pdf.runs(
        [{ text: item?.date ? formatDay(item.date, "numeric") : "" }],
        { size: 8.5, leading: 11 },
        MARGIN,
        cols.date,
        false,
      );
      pdf.y = top;
      pdf.runs(desc, { size: 8.5, leading: 11 }, xDesc, descW);
      pdf.runs(record, { size: 7, leading: 9.5 }, xDesc, descW, false);
      for (const n of notes) pdf.runs([{ text: n, color: "ink2" }], { size: 7.5, leading: 10 }, xDesc, descW);
      const end = pdf.y;
      pdf.y = top;
      const amount = formatCents(line.requested_cents);
      pdf.runs(
        [{ text: amount }],
        { size: 8.5, leading: 11 },
        xAmount + cols.amount - pdf.width(amount, "sans", 8.5),
        cols.amount,
        false,
      );
      pdf.y = top;
      const countedText =
        line.status === "eligible"
          ? formatCents(line.allowed_cents)
          : line.status === "held"
            ? "Held"
            : line.status === "needs_confirmation"
              ? "Not yet"
              : "No";
      const color: ColorKey = line.status === "held" ? "clay" : line.status === "eligible" ? "ink" : "ink3";
      pdf.runs(
        [{ text: countedText, color, font: line.status === "eligible" ? "bold" : "sans" }],
        { size: 8.5, leading: 11 },
        xCounted + cols.counted - pdf.width(countedText, line.status === "eligible" ? "bold" : "sans", 8.5),
        cols.counted,
        false,
      );
      pdf.transcript.push(`${line.item_id} ${amount} ${countedText}`);
      pdf.y = end - 3;
      pdf.rule("line", 0.4);
      pdf.space(4);
    }
    pdf.space(4);
  }

  pdf.ensure(40);
  pdf.space(6);
  pdf.rule("ink", 1.2);
  pdf.space(8);
  pdf.runs(
    [
      { text: "Amount you can ask for: ", font: "bold" },
      { text: formatCents(output.totals.allowed_cents), font: "bold", color: "green" },
      { text: ". The program decides.", font: "bold" },
    ],
    { size: 11, leading: 15 },
  );
}

function neededSection(w: Writer, output: EngineOutput, items: ChecklistItem[], form: FormSpec | null) {
  const { law, pdf } = w;
  w.h2("Still needed");
  if (items.length) {
    w.small(
      `${law.name}'s program asks for these with the kinds of costs in this claim. Each comes from the program's own list.`,
    );
    for (const it of items) {
      const rule = law.rule(it.rule_id);
      pdf.ensure(34);
      const top = pdf.y;
      pdf.checkbox(MARGIN, top - 1.5, 8, it.have_it);
      pdf.runs(
        [{ text: it.document }, ...(it.have_it ? [{ text: "  You have this.", color: "green" as ColorKey }] : [])],
        { size: 9.5 },
        MARGIN + 16,
        CONTENT_W - 16,
      );
      pdf.runs(
        [
          { text: `${rule?.pinpoint ?? it.rule_id}: `, color: "ink3" },
          { text: `"${it.quote.trim()}"`, font: "italic", color: "ink3" },
        ],
        { size: 7.5, leading: 10 },
        MARGIN + 16,
        CONTENT_W - 16,
      );
      pdf.space(5);
    }
  } else {
    w.p(`Tend found no document list for ${law.name}. Ask the program what to send with the application.`, "ink2");
  }

  w.h3([{ text: "Before you send it" }]);
  const before = [
    "Sign and date the application yourself. Tend never signs or sends anything for you.",
    "Only you fill in your Social Security number, what happened, where, and anything about the person who did it.",
  ];
  if (output.lines.some((l) => l.status === "held")) {
    before.push("Do not pay the held exam charge. Send the billing letter instead.");
  }
  for (const b of before) w.p([{ text: "-  " }, { text: b }]);
  if (form) {
    w.small(`On the ${form.title}, these stay blank for you to fill in:`, "ink2");
    for (const o of form.onlyYou) w.small([{ text: "-  " }, { text: o }], "ink2");
  }
}

function filingSection(w: Writer, routes: FilingRoute[]) {
  const { law } = w;
  const program = law.law.program;
  w.h2("Where to send it");
  if (routes.length) {
    for (const r of routes) {
      const rule = law.rule(r.rule_id);
      w.pdf.ensure(28);
      w.p([
        { text: `${METHOD_LABEL[r.method]}: `, font: "bold" },
        { text: r.target, link: r.method === "online" && /^https?:\/\//.test(r.target) ? r.target : null },
      ]);
      if (rule) w.small(`${rule.pinpoint}: "${rule.quote.trim()}"`);
    }
  } else {
    w.p(`Tend found no filing address for ${law.name}. Call the program or check its website.`, "ink2");
  }
  const contact: Run[] = [];
  if (program.phone) contact.push({ text: "Questions: ", font: "bold" }, { text: `call ${program.phone}. ` });
  if (program.website)
    contact.push({ text: "Website: ", font: "bold" }, { text: program.website, color: "green", link: program.website });
  if (contact.length) w.p(contact);
}

function privacySection(w: Writer) {
  const { law } = w;
  const notes = privacyNotes(law);
  w.h2("Keeping your information private");
  w.h3([{ text: "A substitute address" }]);
  if (notes.address.length) {
    for (const a of notes.address) {
      const who = a.agency ? `${a.agency} runs` : `${law.name} has`;
      w.p(
        `${who} ${a.program_name ? `the ${a.program_name}` : "an address confidentiality program"}. It gives you a substitute address to use on government records and forms, like this application.${
          a.covers_sexual_assault === true ? " It covers survivors of sexual assault." : ""
        }`,
      );
      if (a.enroll) w.p([{ text: "How to sign up: ", font: "bold" }, { text: a.enroll }]);
      w.quote(a.rule);
    }
  } else {
    w.p(
      `Tend has not verified an address confidentiality program for ${law.name}. An advocate can tell you whether one exists.`,
      "ink2",
    );
  }
  w.h3([{ text: "Your claim file" }]);
  if (notes.records.length) {
    w.p(`${law.name} law limits who can see a compensation claim file. The exact words:`);
    for (const r of notes.records) w.quote(r);
  } else {
    w.p(
      `Tend has not verified a law about keeping claim files private in ${law.name}. Ask the program how it protects your file.`,
      "ink2",
    );
  }
}

function lettersSection(w: Writer, letters: Letter[]) {
  if (!letters.length) return;
  w.h2("Letters Tend wrote for you");
  w.small(
    "Each letter quotes the law and leaves [blanks] for names, dates, and account numbers. Tend never fills those in.",
  );
  for (const l of letters) w.p([{ text: "-  " }, { text: l.title }]);
}

function sourcesSection(w: Writer, output: EngineOutput, cited: Set<string>) {
  const { law, pdf } = w;
  const sources = law.sourcesFor(cited);
  if (!sources.length) return;
  w.h2("Sources");
  w.small(
    "Each quote above is copied word for word from one of these saved copies. The SHA-256 fingerprint identifies the exact copy Tend checked.",
  );
  for (const s of sources) {
    pdf.ensure(30);
    pdf.runs(
      [
        { text: `${s.id}  `, font: "mono", color: "ink3" },
        { text: s.title, font: "bold" },
      ],
      { size: 8.5, leading: 11 },
    );
    pdf.runs([{ text: s.url, color: "green", link: s.url }], { size: 7.5, leading: 10 });
    const day = (s.retrieved_at ?? "").slice(0, 10);
    pdf.runs(
      [{ text: `${isIsoDay(day) ? `Saved ${formatDay(day)}. ` : ""}SHA-256 ${s.sha256}`, font: "mono", color: "ink3" }],
      { size: 6.5, leading: 9 },
    );
    pdf.space(4);
  }
  w.small(`Claim math by the law engine. Law image SHA-256 ${output.law_image_sha256}.`);
}

export async function renderSummary(s: SummaryInput): Promise<{ bytes: Uint8Array; transcript: string[] }> {
  const { law, input, output } = s;
  const program = law.law.program;
  const pdf = await Pdf.create(`Claim summary, ${law.name}`);
  const w = new Writer(pdf, law);

  // Title block
  pdf.text("Claim summary prepared with Tend", { size: 8.5, color: "ink3" });
  pdf.space(2);
  pdf.text(`${program.program_name}, ${law.name}`, { font: "serifBold", size: 21, leading: 25 });
  if (program.agency) pdf.text(program.agency, { size: 9, color: "ink2" });
  pdf.space(4);
  w.p(
    `Prepared ${formatDay(input.context.as_of_date)} under ${law.name} law. Costs counted from ${formatDay(input.context.incident_date)} to ${formatDay(input.context.as_of_date)}.`,
    "ink2",
  );
  pdf.space(4);
  w.p([
    { text: "Name: ", font: "bold" },
    { text: "______________________________    " },
    { text: "Claim number, if you have one: ", font: "bold" },
    { text: "______________" },
  ]);
  w.small("Tend never saves your name. Write it here and on the application yourself.");
  if (isDemo(input)) {
    pdf.space(2);
    w.p(
      "Demo packet. The person and every record in it are made up. Bank records come from Capital One's Nessie, a mock bank, so no real money exists here.",
      "clay",
      8.5,
    );
  }

  // Totals
  pdf.space(10);
  pdf.rule("ink", 1.2);
  pdf.space(10);
  pdf.text(TOTAL_LINE, { font: "bold", size: 10.5, leading: 14 });
  pdf.text(formatCents(output.totals.allowed_cents), { font: "serifBold", size: 30, leading: 34, color: "green" });
  const counted = output.lines.filter((l) => l.status === "eligible" && l.allowed_cents > 0).length;
  const waiting = output.lines.filter((l) => l.status === "needs_confirmation").length;
  const notCovered = output.lines.filter((l) => l.status === "excluded" || l.status === "unknown_rule").length;
  const parts = [`From ${plural(counted, "counted cost")}.`];
  if (waiting) parts.push(`${plural(waiting, "cost")} ${waiting === 1 ? "is" : "are"} waiting for your yes.`);
  if (output.totals.held_cents > 0) {
    parts.push(`${formatCents(output.totals.held_cents)} is held: a bill the law says you should not have been sent.`);
  }
  if (notCovered)
    parts.push(
      `${plural(notCovered, "cost")} ${notCovered === 1 ? "is" : "are"} not covered or not named in the rules.`,
    );
  w.p(parts.join(" "), "ink2");

  checksSection(w, input, output);
  linesSection(w, input, output);
  neededSection(w, output, s.stillNeeded, s.form);
  filingSection(w, s.filing);
  privacySection(w);
  lettersSection(w, s.letters);

  const cited = new Set<string>([
    ...output.lines.flatMap((l) => [...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : [])]),
    ...output.checks.deadline.rule_ids,
    ...output.checks.reporting.rule_ids,
    ...output.checks.minimum_loss.rule_ids,
    ...s.stillNeeded.map((i) => i.rule_id),
    ...s.filing.map((f) => f.rule_id),
    ...law.byCategory("address_confidentiality").map((r) => r.id),
    ...law.byCategory("record_confidentiality").map((r) => r.id),
  ]);
  sourcesSection(w, output, cited);

  pdf.finish({
    footer: "Prepared with Tend from verified rules. Not legal advice. The program decides every claim.",
    header: `Claim summary, ${law.name}`,
  });
  return { bytes: await pdf.save(), transcript: pdf.transcript };
}

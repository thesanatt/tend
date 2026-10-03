# Tend law images (.tlaw) and the law VM

This is the normative description of the engine: the image layout, the instruction set and its
verifier, the assembly syntax `tdis` prints, the exact semantics the compiler emits (section 4),
and the input and output documents (section 5). Sections 4 and 5 settle every choice docs/SPEC.md
v1.2 leaves open; the Python reference (refengine/) follows them and must produce the same output
document, byte for byte, for the same law IR and claim.

```
rules/verified/ST.json --normalize.py--> rules/ir/ST.json --tendc--> ST.tlaw --libtend VM--> claim result
   (quotes, pinpoints)                     (semantics, IR v2)          (native or WASM)
```

`tendc` reads the IR for semantics and the verified file for quotes, pinpoints, and sources. The
IR's `source_sha256` must equal the sha256 of the verified file, or `tendc` refuses ("stale IR").
Same inputs always give the same image bytes.

## 1. Image layout (format 1.2)

All integers are little-endian. Strings are UTF-8 and referenced by index into the string pool.
`NONE` is `0xFFFFFFFF`.

### Header (64 bytes)

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `TLAW` |
| 4 | 2 | format major = 1 |
| 6 | 2 | format minor = 2 |
| 8 | 4 | header size = 64 |
| 12 | 4 | total image size in bytes, trailer included |
| 16 | 8 | jurisdiction code, `[A-Z0-9]{1,8}`, NUL padded |
| 24 | 32 | sha256 of the verified JSON (equals the IR's `source_sha256`) |
| 56 | 4 | section count (1 to 16) |
| 60 | 4 | flags, must be 0 |

The loader reads only format 1.2. Each minor version changed what the compiler emits (1.1: the
law IR; 1.2: typed units, notes, SPEC v1.2), so an older image is refused, never misread.

The section table follows: one 12-byte entry per section, `{u32 tag, u32 offset, u32 size}`.
Sections start on 8-byte boundaries, lie between the table and the trailer, and never overlap.
The last 32 bytes of the file are the trailer: sha256 of every byte before it.
`law_image_sha256` in the engine output is the sha256 of the whole file, so anyone can check it
with `shasum -a 256 ST.tlaw`.

### Sections

| tag | required | contents |
|---|---|---|
| `STRS` | yes | `u32 count, u32 blob_size, {u32 offset, u32 length}[count], blob` |
| `INTS` | yes | `u32 count, u32 0, i64[count]`; money constants in cents |
| `SRCS` | yes | `u32 count`, then 44-byte records `{u32 id, u32 url, u32 title, u8 sha256[32]}` |
| `RULE` | yes | `u32 count`, then 36-byte rule records (below) |
| `PROF` | yes | proof lists: `u32 lists, u32 refs, u32 start[lists+1], u16 rule[refs]`; list 0 is empty |
| `ITEM` | yes | per-item bytecode |
| `AGGR` | yes | aggregate bytecode |
| `TAGS` | no | `u32 count (<= 31), u32 string[count]`; item tag i sets bit i |
| `ANNO` | no | `u32 count`, 12-byte records `{u8 program, u8 0, u8 0, u8 0, u32 pc, u32 rule}` for listings |
| `META` | no | `u32 count, {u32 key, u32 value}[count]`: `name`, `compiler`, `ir_sha256` |

Rule record (36 bytes):

| offset | field |
|---|---|
| 0 | u8 kind: exam_no_bill, exam_payment, total_cap, expense_cap, covered, excluded, deadline, reporting, minimum_loss, collateral, info, skipped (0..11) |
| 1 | u8 expense (0..17 in rules/SCHEMA.md order) or 0xFF |
| 2 | u8 per: 0 none, 1 claim, 2 unit |
| 3 | u8 reserved, 0 |
| 4 | u32 id |
| 8 | u32 pinpoint |
| 12 | u32 quote |
| 16 | u32 summary or NONE |
| 20 | u32 fragment_url or NONE |
| 24 | u32 source index or NONE |
| 28 | u32 verified category or NONE |
| 32 | u32 aux: the unit of a per-unit cap, what a deadline counts from, or why a skipped rule was set aside; else NONE |

The rule table holds the IR rules in IR order, then the IR's `skipped` rules (kind `skipped`), so
alternate caps and set-aside rules keep their quotes. Rule order is proof order everywhere.
`aux` is for listings and `tend_inspect_json` only; the bytecode carries the semantics.

### What the loader checks

Nothing in an image is trusted. `load_law` rejects, with a reason, any image where: the size is
outside 96 bytes to 64 MB; the magic, version, header size, total size, jurisdiction, or flags are
wrong; the trailer sha256 does not match; a section is unknown, duplicated, missing, misaligned,
out of bounds, or overlapping; a section's size disagrees with its counts; a string is out of
bounds or not UTF-8; a rule has an unknown kind, expense, or per, reserved bits, a bad string or
source reference, an empty or duplicate id; a proof list is out of order or names a missing rule;
a tag is empty or repeated; an annotation points inside an instruction or at a missing rule; or
either program fails the bytecode verifier below. The fuzzer (fuzz/fuzz.cpp) hammers all of this
under ASan and UBSan.

## 2. The VM

Each program runs on an int64 operand stack (at most 16 deep) with 8 int64 registers `r0..r7`,
zeroed at program start. Arithmetic saturates at the int64 limits. Comparisons push 1 or 0.

- The **item program** runs once per item, in processing order, with that item as the current
  line. It must make exactly one decision (`decide`) on every path.
- The **aggregate program** runs once after all items. It reaches lines only through `each`/`next`
  loops over eligible lines.

Item fields (`ldi`): `date` (days since 1970-01-01), `amount_cents`, `expense` (0..18, 18 =
unknown), `confirmed`, `insurance_paid_cents`, `is_bill`, `units`, `tags` (bitmask), `unit`
(0 none, 1 session, 2 week, 3 hour, 4 mile, 5 day, 6 month, 7 item).
Context fields (`ldx`): `incident_date`, `as_of_date`, `police_report` (0 no, 1 yes, 2 unknown),
`forensic_exam` (0/1).

### Instruction set

| op | mnemonic | operands | stack | where | effect |
|---|---|---|---|---|---|
| 01 | `push` | i32 | 0 -> 1 | both | push immediate |
| 02 | `ldk` | u16 k | 0 -> 1 | both | push INTS[k] |
| 03 | `pop` | | 1 -> 0 | both | |
| 04 | `dup` | | 1 -> 2 | both | |
| 05 | `swap` | | 2 -> 2 | both | |
| 08 | `ldx` | u8 field | 0 -> 1 | both | push a context field |
| 09 | `ldi` | u8 field | 0 -> 1 | item; aggregate loop | push a field of the current line's item |
| 0A | `lda` | | 0 -> 1 | item; aggregate loop | push the current line's allowed cents |
| 0B | `ldr` | u8 r | 0 -> 1 | both | push register |
| 0C | `str` | u8 r | 1 -> 0 | both | pop into register |
| 10..14 | `adds subs muls min max` | | 2 -> 1 | both | saturating arithmetic |
| 16, 17 | `and or` | | 2 -> 1 | both | bitwise |
| 18..1D | `eq ne lt le gt ge` | | 2 -> 1 | both | compare |
| 20 | `jmp` | u32 target | | both | forward jump |
| 21, 22 | `jz jnz` | u32 target | 1 -> 0 | both | forward conditional jump |
| 23 | `switch` | u8 n, u32 default, u32 case[n] | 1 -> 0 | both | jump to case[v] if 0 <= v < n, else default |
| 24 | `ret` | | | both | end of program (stack must be empty) |
| 30 | `decide` | u8 status, u16 proof | 1 -> 0 | item | set status and proof; allowed = popped value |
| 31 | `setexp` | u8 expense | | item | change the line's expense (exam treated as medical) |
| 32 | `seta` | u8 op, u16 rule | 1 -> 0 | item | allowed = popped value; trace if it changed (op = collateral) |
| 33 | `alts` | u16 proof | | item | the line's alternate cap rules |
| 40 | `each` | u8 expense or FF, u32 end | | aggregate | start a loop over eligible lines (of one expense, or all) |
| 41 | `next` | u32 head | | aggregate | advance; jump back to head while lines remain |
| 42 | `cap` | u8 op, u16 rule | 1 -> 0 | aggregate loop | allowed = popped value, cap_rule = rule, trace |
| 43 | `flag` | u16 rule | | aggregate loop | add `rate_unverified:<rule>`, trace |
| 44 | `check` | u8 kind, u16 proof | 1 -> 0 | aggregate | set a check's status (popped) and rules, trace |
| 45 | `setdate` | | 1 -> 0 | aggregate | set the deadline date (days) |
| 46 | `info` | u16 proof | | aggregate | set `info_rule_ids` |
| 47 | `note` | u8 note | | aggregate | attach a note to its check: 0 `deadline_from_report` (deadline) |

Jump targets are byte offsets inside the program. Statuses: `decide` 0 out_of_window, 1 held,
2 excluded, 3 unknown_rule, 4 needs_confirmation, 5 eligible. `check` kinds: 0 deadline
(ok, late, unknown), 1 minimum_loss (met, waived, unknown, may_be_waived, not_met: numbered by
severity, so `max` combines rules), 2 reporting (satisfied, required, not_required, unknown).

### Verifier

The loader decodes each program and proves, before anything runs:

- every opcode is known and allowed in that program, every operand is in range (pool indices,
  registers, fields, statuses, rule and proof ids, trace ops, notes), and every jump target is the
  start of an instruction;
- every jump goes forward, except `next`; each `each` at index i is closed by the `next` at
  index end-1, that `next` jumps to i+1, loops do not nest, and nothing jumps into a loop body
  from outside it;
- `ldi`, `lda`, `cap`, and `flag` in the aggregate program sit inside a loop body;
- abstract interpretation in index order gives every reachable instruction one stack depth (and,
  in the item program, one "decided" state): no underflow, no depth above 16, the same state
  wherever paths merge or a loop repeats, an empty stack at `ret`, exactly one `decide` on every
  item path, `setexp` only before and `seta` only after the decision, and no path running off
  the end.

So the interpreter does no bounds checks at all, and every run terminates: each `each` executes
at most once (nothing jumps backward past it), so a program of n instructions runs at most
n x (items + 1) steps. The only runtime check left is that a `check` status is in range; a bad
one ends the evaluation with a `vm_trap` error document.

## 3. Assembly syntax

`tdis ST.tlaw` prints a header comment, the tables, then both programs. A per-session cap with a
count limit (from the ZZ test fixture):

```
.rules
    R6    ZZ-COUNSEL-CAP-1      expense_cap   counseling            per session             Program Guide, Counseling
    R21   ZZ-DEADLINE-4         deadline      -                     from report             ZC 4-130(4)
.tags   phone=bit0, purse=bit1, pain_suffering=bit2
.aggregate
              ; ZZ-COUNSEL-CAP-1  Program Guide, Counseling  "Counseling shall be paid at no more than $90 per session, for no..."
  0000        push     3
  0005        str      r3
  0007        each     counseling, L4
  000d  L0:   ldi      unit
  000f        push     1                            ; session
  0014        eq
  0015        jz       L2
  001a        ldi      units
  001c        push     0
  0021        gt
  0022        jz       L2
  ...
  0035        ldk      K0                           ; $90.00
  0038        ldr      r4
  003a        muls
  ...
  0043        cap      unit_cap, R6                 ; ZZ-COUNSEL-CAP-1
  ...
  0052  L2:   flag     R6                           ; rate_unverified ZZ-COUNSEL-CAP-1
  0055  L3:   next     L0
  ...
  0355  L49:  note     deadline_from_report
  0357        check    deadline, P29                ; ZZ-DEADLINE-1, ZZ-DEADLINE-2, ZZ-DEADLINE-4
```

Columns: byte offset (hex), label, mnemonic, operands, comment. Operands use `R<n>` for rules,
`P<n>` for proof lists, `K<n>` for constants (money; counts and days are `push` immediates),
`r<n>` for registers, field, expense, and note names, and `L<n>` labels numbered in address order.
Every rule block starts with one comment line per rule: id, pinpoint, and the start of its quote.
`switch` cases print on their own lines.

## 4. Semantics as compiled (SPEC v1.2, law IR version 2)

This section is normative for both engines. Items are processed in order of (date, item_id),
comparing item_id by bytes (UTF-8 byte order is code point order; ids are unique, so the order is
total). `lines` come out in that order. Every line reports `requested_cents` = its amount; only
eligible lines carry a nonzero `allowed_cents`. All sums and products saturate at the int64
limits, in both engines.

### Per-item program

One `switch` on the item's expense picks a block; blocks are shared between expenses with
identical rules. The first matching step decides the line.

1. `out_of_window` if date < incident_date or date > as_of_date. No rules. The line keeps the
   expense it came with (an exam stays `forensic_exam`).
2. A forensic exam is `held` only when the law has an `exam_no_bill` rule; proof = every
   exam_no_bill rule, then every exam_payment rule, each in rule order. Otherwise the line's
   expense becomes `medical` (in the output too) and it continues as medical. A held exam is held
   whether or not it is confirmed or tagged.
3. `excluded` when an `excluded` rule matches: its expense is absent or equal to the line's, and
   it has no tags or the item carries one of them. Proof = every matching exclusion in rule
   order. Tag-only exclusions apply to every expense, including unknown.
4. `unknown_rule` when no `covered` or `expense_cap` rule names the expense (`unknown` never has
   one).
5. `needs_confirmation` when `confirmed` is false; proof = the covered and expense_cap rules for
   the expense in rule order. Not counted.
6. `eligible`: allowed = amount; proof = the same rules plus every `collateral` rule. With a
   collateral rule, allowed = max(0, allowed - insurance_paid_cents), traced as `collateral` only
   when it changes the amount.
   Lines of steps 5 and 6 get `alt_cap_rule_ids`: the `alt_rule_ids` of every expense_cap for the
   expense, in rule order, each list in its own order.

### Aggregate program

7. a. Per-unit caps in rule order. For each eligible line of the cap's expense, in processing
   order: when the item's `unit` equals the cap's unit and `units` > 0, the cap applies:
   allowed = min(allowed, cap x counted), recording `cap_rule_id` and a `unit_cap` trace entry
   only when this lowers allowed. Otherwise (no unit, another unit, or no units) the cap is not
   applied: the line gets the flag `rate_unverified:<rule id>` and a `rate_unverified` trace
   entry, and keeps its amount. With `count_limit` N, counted = min(units, units still left), and
   only lines the cap applies to use up the count; once N units are used, later lines it applies
   to are capped to 0.
   b. Per-claim caps in rule order: walk the eligible lines of the expense keeping the running
   allowed total. The first line that would push it over the cap is cut to cap - total and
   records the cap; every later line is set to 0 and records the cap, even if it was already 0.
   A line keeps the last cap that changed it.
8. Total cap: the same walk over all eligible lines with the smallest `total_cap` (the first one
   on ties).
9. Minimum loss over the total allowed after step 8. Lost-wage days = 5 x (sum of `units` of
   eligible lost_wages lines whose unit is `week`) + (sum of `units` of those whose unit is
   `day`); other units do not count. A rule is `met` when it has `cap_cents` and the total is at
   least that, or it has `days_lost` and the lost-wage days are at least that. A rule that is not
   met is `waived` when `waiver` is `automatic` and `waiver_for_sexual_assault` is true,
   `may_be_waived` when `waiver` is `discretionary` and `waiver_for_sexual_assault` is true, and
   `not_met` otherwise, if it has `cap_cents`; a rule with only `days_lost` is `unknown` (the
   claim does not show the days, but they may exist). The check takes the most severe status:
   not_met over may_be_waived over unknown over waived over met. No rule gives `met`.
   `forensic_exam` plays no part. rule_ids = every minimum_loss rule.
10. Deadline: incident_date + days for each `deadline` rule, whatever it counts from (a
    report-anchored period is dated from the incident, the earliest the report can be); the
    latest date wins; `ok` when as_of_date <= that date, else `late`; `unknown` with a null date
    when there is no rule. The date prints clamped to 0001-01-01..9999-12-31; the comparison uses
    the unclamped day. `flags` is `["deadline_from_report"]` when any deadline rule counts from
    the report (the true deadline may be later than the date shown, and a `late` may not be),
    else `[]`. rule_ids = every deadline rule.
11. Reporting: `satisfied` when police_report is yes, or forensic_exam is true and any reporting
    rule lists `forensic_exam`; otherwise, when some rule has required = true (missing means
    true), `required` if police_report is no and `unknown` if it is unknown; `not_required` when
    no rule is required, including when there are no rules. Other alternatives (advocate,
    protective order, ...) are listed in the rules but never decide the status.
12. `info_rule_ids`: every `info` and `collateral` rule, and every `exam_payment` rule when the
    law has no `exam_no_bill` rule (otherwise those are in the hold's proof), in rule order.

### Choices made where the SPEC is silent

- Unit caps run before claim caps (a per-session limit is applied before the per-claim walk).
- Rules written as `{"kind": "info", "category": "collateral_source"}` act as `collateral`, and
  `"category": "exam_payment"` as `exam_payment`, so both IR spellings agree.
- `count_limit` on a per-claim cap is ignored (there are no units to count); tendc says so.
- `waived` is kept for automatic waivers next to `may_be_waived` for discretionary ones.
- A deadline rule without `from` counts from the crime. `from` must be crime, incident,
  discovery, injury, offense, or report; birthdays are info in IR v2, so tendc refuses them.
- A minimum loss rule needs `cap_cents` or `days_lost`; tendc refuses one with neither.
- A tag the law never mentions is dropped at input; at most 31 distinct tags per law, and at most
  6 tagged exclusions may apply to one expense.

### Law IR checks

`tendc` refuses an IR file (and the reference refuses the same file, with the same message) when:
`ir_version` is not the integer 2; `jurisdiction` is not 1 to 8 bytes of `[A-Z0-9]`; `rules` or
`skipped` is not a list; a rule is not an object or has no id; `kind` is unknown; a required
number is missing, not an integer, or out of range (cap_cents and money 0 to 10^15, days and
days_lost 0 to 4,000,000, count_limit 0 to 1,000,000); an expense is unknown or `unknown`; `per`
is not claim or unit; a per-unit cap has no unit or an unknown one; tags are not non-empty strings;
`from`, `waiver`, `required`, `waiver_for_sexual_assault`, or `alternatives` has the wrong type or
value; an id repeats; an alt rule id is not in the IR; or a code generation limit above is passed.
With a verified file: its sha256 must equal `source_sha256`, its jurisdiction must match, and
every IR rule must be in it.

## 5. Input and output documents

### Input

The claim is one JSON object (RFC 8259, UTF-8, at most 64 nested arrays and objects; the C ABI
reads a C string, so a NUL byte ends it). The engine reads it in document order and reports the
first problem. Keys it does not know are skipped, never echoed; known keys are:

| where | key | value | when null or missing |
|---|---|---|---|
| top | `jurisdiction` | string; must equal the law's code | not checked |
| top | `context` | object (required) | `context is required` |
| top | `items` | array of objects | no items |
| context | `incident_date`, `as_of_date` | `YYYY-MM-DD`, a real day in years 0001..9999 (required) | `... is required` / bad date |
| context | `police_report` | `yes`, `no`, `unknown` | unknown |
| context | `forensic_exam` | true or false | false |
| item | `item_id` | non-empty string, unique in the claim (required) | required |
| item | `date` | `YYYY-MM-DD` (required) | required |
| item | `amount_cents` | integer, 0 to 2^53 - 1 (required) | required |
| item | `expense` | one of the 18 SCHEMA.md expenses, or `unknown` | unknown |
| item | `confirmed`, `is_bill` | true or false | false |
| item | `insurance_paid_cents`, `units` | integer, 0 to 2^53 - 1 | 0 |
| item | `unit` | session, week, hour, mile, day, month, item | no unit |
| item | `tags` | list of strings | no tags |

Errors are `{"error":{"code":...,"message":...}}`. Codes: `bad_image`, `bad_input`,
`jurisdiction_mismatch`, `vm_trap`. For any well-formed JSON document, the message is exactly one
of these, for the first problem in document order (`<path>` is like `items[3].amount_cents`):

| message | when |
|---|---|
| `input: expected an object` | the document is not an object |
| `<path>: appears twice` | a known key repeats in the same object |
| `jurisdiction: expected a string` | |
| `context: expected an object` | |
| `items: expected an array` | |
| `items[i]: expected an object` | |
| `<path>: expected a date as YYYY-MM-DD` | not a string, wrong shape, or not a real day |
| `context.police_report: expected yes, no, or unknown` | |
| `<path>: expected true or false` | |
| `<path>: expected an integer` | not a number, or a number with a fraction or exponent |
| `<path>: integer out of range` | outside -(2^53 - 1)..2^53 - 1 |
| `<path>: must not be negative` | amount, insurance, or units below 0 |
| `<path>: expected a string` | item_id, expense, or unit of another type |
| `items[i].item_id: must not be empty` | |
| `items[i].expense: not a known expense` | any string outside the 18 expenses and `unknown` |
| `items[i].unit: not a known unit` | any string outside the 7 units |
| `items[i].tags: expected a list of strings` | |
| `context.incident_date is required`, `context.as_of_date is required` | checked when the context object ends |
| `items[i].item_id is required`, `... date ...`, `... amount_cents ...` | checked, in that order, when the item ends |
| `context is required` | after the whole document |
| `items[j].item_id: duplicate of items[i]` | after the whole document, first repeat |
| `input is for XX but the law image is YY` | code `jurisdiction_mismatch`, last |

Text that is not well-formed JSON (syntax, invalid UTF-8, an unpaired surrogate escape, NaN or
Infinity, nesting deeper than 64) is `bad_input` with a message starting `invalid JSON`; the C++
engine adds the byte offset, and because it reads in one pass it may name an earlier field problem
instead. Only the code is normative there.

### Output

```json
{"jurisdiction":"ZZ","law_image_sha256":"...",
 "lines":[{"item_id":"...","expense":"counseling","status":"eligible","requested_cents":15000,
           "allowed_cents":9000,"rule_ids":["..."],"cap_rule_id":"ZZ-COUNSEL-CAP-1",
           "alt_cap_rule_ids":["ZZ-COUNSEL-CAP-3"],"flags":[]}],
 "totals":{"requested_cents":0,"allowed_cents":0,"held_cents":0,"by_expense":{"counseling":0}},
 "checks":{"deadline":{"status":"ok","deadline_date":"2029-06-13","rule_ids":[],"flags":["deadline_from_report"]},
           "minimum_loss":{"status":"met","rule_ids":[]},
           "reporting":{"status":"satisfied","rule_ids":[]}},
 "info_rule_ids":[],
 "trace":[{"op":"eligible","item_id":"...","rule_id":"...","delta_cents":15000}]}
```

Keys appear in this order and the JSON is compact (no spaces, UTF-8 kept, only `"`, `\`, and
control characters escaped, as `\b \f \n \r \t` or lowercase `\u00xx`). `totals.requested_cents`
and `allowed_cents` sum eligible lines; `held_cents` sums held lines; `by_expense` sums allowed
per expense over eligible lines, keys in alphabetical order, zeros kept. A line's `flags` are in
the order raised (rule order).

`trace` is the VM's log in execution order: one entry per item decision (op = the status, rule =
the first proof rule or null, delta = the allowed amount it set), a `collateral` entry when the
insurance subtraction changed allowed, then `unit_cap`, `rate_unverified`, `expense_cap`, and
`total_cap` entries as the aggregate program runs (rule by rule, lines in order), then
`minimum_loss`, `deadline`, `reporting` (item_id null, rule = the check's first rule or null,
delta 0). Notes are not traced. Unless amounts saturate, one item's deltas sum to its
`allowed_cents` and all deltas sum to `totals.allowed_cents`, which the tests check.

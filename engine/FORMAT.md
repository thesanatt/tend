# Tend law images (.tlaw) and the law VM

This is the normative description of the engine: the image layout, the instruction set and its
verifier, the assembly syntax `tdis` prints, and the exact semantics the compiler emits. The
Python reference (refengine/) must produce the same output document, trace included, for the same
law IR and claim.

```
rules/verified/ST.json --normalize.py--> rules/ir/ST.json --tendc--> ST.tlaw --libtend VM--> claim result
   (quotes, pinpoints)                     (semantics)                (native or WASM)
```

`tendc` reads the IR for semantics and the verified file for quotes, pinpoints, and sources. The
IR's `source_sha256` must equal the sha256 of the verified file, or `tendc` refuses ("stale IR").
Same inputs always give the same image bytes.

## 1. Image layout (format 1.1)

All integers are little-endian. Strings are UTF-8 and referenced by index into the string pool.
`NONE` is `0xFFFFFFFF`.

### Header (64 bytes)

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `TLAW` |
| 4 | 2 | format major = 1 |
| 6 | 2 | format minor = 1 |
| 8 | 4 | header size = 64 |
| 12 | 4 | total image size in bytes, trailer included |
| 16 | 8 | jurisdiction code, `[A-Z0-9]{1,8}`, NUL padded |
| 24 | 32 | sha256 of the verified JSON (equals the IR's `source_sha256`) |
| 56 | 4 | section count (1 to 16) |
| 60 | 4 | flags, must be 0 |

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
| 32 | u32 aux: the unit of a per-unit cap, or why a skipped rule was set aside, or NONE |

The rule table holds the IR rules in IR order, then the IR's `skipped` rules (kind `skipped`), so
alternate caps and set-aside rules keep their quotes. Rule order is proof order everywhere.

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
unknown), `confirmed`, `insurance_paid_cents`, `is_bill`, `units`, `tags` (bitmask).
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

Jump targets are byte offsets inside the program. Statuses: `decide` 0 out_of_window, 1 held,
2 excluded, 3 unknown_rule, 4 needs_confirmation, 5 eligible. `check` kinds: 0 deadline
(ok, late, unknown), 1 minimum_loss (met, waived, may_be_waived, not_met, unknown), 2 reporting
(satisfied, required, not_required, unknown).

### Verifier

The loader decodes each program and proves, before anything runs:

- every opcode is known and allowed in that program, every operand is in range (pool indices,
  registers, fields, statuses, rule and proof ids, trace ops), and every jump target is the start
  of an instruction;
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

`tdis ST.tlaw` prints a header comment, the tables, then both programs:

```
.rules
    R11   ZZ-RELOC-CAP-1        expense_cap   relocation            per claim               ZC 4-121(3)
.tags   phone=bit0, purse=bit1, pain_suffering=bit2
.proofs
    P1    (ZZ-EXAM-1, ZZ-EXAM-2)
.ints
    K4    200000        ; $2,000.00
.aggregate
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
  00fd  L19:  push     0
  0102        str      r0
  ...
  010b        each     relocation, L24
  0111  L20:  ldr      r1
  0113        jnz      L22
  0118        ldr      r0
  011a        lda
  011b        adds
  011c        ldk      K4                           ; $2,000.00
  011f        gt
  0120        jz       L21
  ...
  012b        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
```

Columns: byte offset (hex), label, mnemonic, operands, comment. Operands use `R<n>` for rules,
`P<n>` for proof lists, `K<n>` for constants, `r<n>` for registers, field and expense names, and
`L<n>` labels numbered in address order. Every rule block starts with one comment line per rule:
id, pinpoint, and the start of its quote. `switch` cases print on their own lines.

## 4. Semantics as compiled (SPEC v1.1)

Items are processed in order of (date, item_id), byte order on item_id, stable for exact ties;
`lines` come out in that order. Every line reports `requested_cents` = its amount; only eligible
lines carry a nonzero `allowed_cents`.

**Per-item program** (one `switch` on the item's expense picks a block; blocks are shared between
expenses with identical rules):

1. `out_of_window` if date < incident_date or date > as_of_date. No rules.
2. A forensic exam is `held` when any `exam_no_bill` or `exam_payment` rule exists; proof = all
   exam_no_bill rules, then all exam_payment rules. Otherwise the line's expense becomes `medical`
   and it continues as medical.
3. `excluded` when an `excluded` rule matches: its expense is absent or equal to the item's, and
   it has no tags or the item carries one of them. Proof = every matching exclusion in rule
   order. Tag-only exclusions apply to every expense, including unknown.
4. `unknown_rule` when no `covered` or `expense_cap` rule names the expense.
5. `needs_confirmation` when `confirmed` is false; proof = the covered and expense_cap rules for
   the expense in rule order. Not counted.
6. `eligible`: allowed = amount; proof = the same rules plus every `collateral` rule. With a
   collateral rule, allowed = max(0, allowed - insurance_paid_cents).
   Lines of steps 5 and 6 get `alt_cap_rule_ids`: the `alt_rule_ids` of every expense_cap for the
   expense, in rule order.

**Aggregate program:**

7. a. Per-unit caps in rule order: for each eligible line of the expense, in processing order,
   if units > 0 then allowed = min(allowed, cap x units), recording `cap_rule_id` and a trace
   entry only when this lowers allowed; with units = 0 the line gets the flag
   `rate_unverified:<rule id>` and keeps its amount. With `count_limit` N, the units counted are
   min(units, units still left) and the remainder shrinks as lines use it, so once N units are
   used later lines are capped to 0.
   b. Per-claim caps in rule order: walk the eligible lines of the expense keeping the running
   allowed total. The first line that would push it over the cap is cut to cap - total and
   records the cap; every later line is set to 0 and records the cap, even if it was already 0.
8. Total cap: the same walk over all eligible lines with the smallest `total_cap` (the first one
   on ties).
9. Minimum loss over the total allowed after step 8: no rules gives `met` with no rule ids; rules
   without `cap_cents` only (days_lost) give `unknown`. Otherwise each rule with cap_cents is met
   when total >= cap; below it, the rule is `waived` (waiver `automatic`) or `may_be_waived` (any
   other waiver) when `waiver_for_sexual_assault` is true and `forensic_exam` is true, and
   `not_met` otherwise. The check takes the worst: not_met over may_be_waived over waived over
   met. rule_ids = all minimum_loss rules.
10. Deadline: incident_date + days for each `deadline` rule; the latest date wins; `ok` when
    as_of_date <= that date, else `late`; `unknown` with a null date when there is no rule.
    rule_ids = all deadline rules. (`from` is not used; the IR converts years to
    365 x years + years / 4 days.)
11. Reporting: `satisfied` when police_report is yes, or forensic_exam is true and any reporting
    rule lists `forensic_exam`; otherwise `required` when some rule has required = true (missing
    means true) and police_report is no, `unknown` when such a rule exists but police_report is
    unknown, and `not_required` when no rule is required, including when there are no rules.
12. `info_rule_ids`: every `info` and `collateral` rule in rule order.

Choices made where the spec is silent, which the reference must copy:

- Unit caps run before claim caps (a per-session limit is applied before the per-claim walk).
- Rules written as `{"kind": "info", "category": "collateral_source"}` act as `collateral`, and
  `"category": "exam_payment"` as `exam_payment`, so both IR spellings in SPEC v1.1 agree.
- `count_limit` on a per-claim cap is ignored (there are no units to count); tendc says so.
- `waived` is kept for automatic waivers; SPEC v1.1 lists only met, not_met, may_be_waived,
  unknown, and says discretionary waivers are never `waived`.
- A tag the law never mentions is dropped at input; at most 31 distinct tags per law, and at most
  6 tagged exclusions may apply to one expense.

## 5. Output document

```json
{"jurisdiction":"ZZ","law_image_sha256":"...",
 "lines":[{"item_id":"...","expense":"counseling","status":"eligible","requested_cents":15000,
           "allowed_cents":9000,"rule_ids":["..."],"cap_rule_id":"ZZ-COUNSEL-CAP-1",
           "alt_cap_rule_ids":["ZZ-COUNSEL-CAP-3"],"flags":[]}],
 "totals":{"requested_cents":0,"allowed_cents":0,"held_cents":0,"by_expense":{"counseling":0}},
 "checks":{"deadline":{"status":"ok","deadline_date":"2029-06-13","rule_ids":[]},
           "minimum_loss":{"status":"met","rule_ids":[]},
           "reporting":{"status":"satisfied","rule_ids":[]}},
 "info_rule_ids":[],
 "trace":[{"op":"eligible","item_id":"...","rule_id":"...","delta_cents":15000}]}
```

Keys appear in this order and the JSON is compact. `totals.requested_cents` and `allowed_cents`
sum eligible lines; `held_cents` sums held lines; `by_expense` sums allowed per expense over
eligible lines, keys in alphabetical order. Sums saturate.

`trace` is the VM's log in execution order: one entry per item decision (op = the status, rule =
the first proof rule or null, delta = the allowed amount it set), a `collateral` entry when the
insurance subtraction changed allowed, then `unit_cap`, `rate_unverified`, `expense_cap`, and
`total_cap` entries as the aggregate program runs, then `minimum_loss`, `deadline`, `reporting`
(item_id null, rule = the check's first rule). Unless amounts saturate, the deltas sum to
`totals.allowed_cents`, which the tests check.

Errors come back as `{"error":{"code":...,"message":...}}` with code `bad_image`, `bad_input`
(the message names the field, for example `items[3].amount_cents: must not be negative`),
`jurisdiction_mismatch`, or `vm_trap`.

Input notes: dates are strict `YYYY-MM-DD`; amounts, insurance, and units are integers >= 0;
`confirmed`, `is_bill`, `forensic_exam` default to false; `police_report` defaults to unknown;
`expense` outside the enum becomes `unknown`; `tags` is a list of strings; `description` and any
other field are ignored and never echoed.

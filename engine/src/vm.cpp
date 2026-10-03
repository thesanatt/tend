#include "vm.h"

#include <algorithm>
#include <utility>

#include "civil.h"

namespace tend {

void sort_items(std::vector<Item>& items) {
  auto less = [](const Item& a, const Item& b) {
    if (a.field[IF_DATE] != b.field[IF_DATE]) return a.field[IF_DATE] < b.field[IF_DATE];
    return a.id < b.id;  // byte order == code point order for UTF-8
  };
  if (std::is_sorted(items.begin(), items.end(), less)) return;
  std::stable_sort(items.begin(), items.end(), less);
}

namespace {

struct Machine {
  Machine(const Law& l, const Context& c, const std::vector<Item>& it, Evaluation& e, bool t)
      : law(l), ctx(c), items(it), ev(e), trace(t) {}

  const Law& law;
  const Context& ctx;
  const std::vector<Item>& items;
  Evaluation& ev;
  bool trace;
  std::vector<uint32_t> eligible;          // eligible lines in order
  std::vector<uint32_t> by_expense;        // eligible lines grouped by expense
  uint32_t expense_begin[EXP_COUNT + 1] = {};

  void emit(uint8_t op, uint32_t line, int32_t rule, int64_t delta) {
    if (trace) ev.trace.push_back(TraceEntry{delta, line, rule, op});
  }

  void index_eligible() {
    uint32_t counts[EXP_COUNT] = {};
    for (uint32_t i = 0; i < ev.lines.size(); i++) {
      if (ev.lines[i].status == ST_ELIGIBLE) {
        eligible.push_back(i);
        counts[ev.lines[i].expense]++;
      }
    }
    for (uint32_t e = 0; e < EXP_COUNT; e++) expense_begin[e + 1] = expense_begin[e] + counts[e];
    by_expense.resize(eligible.size());
    uint32_t fill[EXP_COUNT];
    std::copy(expense_begin, expense_begin + EXP_COUNT, fill);
    for (uint32_t i : eligible) by_expense[fill[ev.lines[i].expense]++] = i;
  }
};

// Executes one program. The verifier has already proven stack bounds, jump
// targets, loop structure, and decision discipline, so nothing here is
// re-checked except values that depend on runtime data.
template <bool kItem>
bool exec(Machine& m, const Program& prog, uint32_t start_line, std::string& err) {
  int64_t stack[kMaxStack];
  int64_t reg[kNumRegs] = {};
  int64_t* sp = stack;
  const Insn* code = prog.code.data();
  const uint32_t* table = prog.table.data();
  const int64_t* ints = m.law.ints.data();
  const uint32_t* list = nullptr;
  uint32_t list_n = 0, cursor = 0;
  uint32_t li = start_line;
  uint32_t pc = 0;
  uint64_t steps = 0;
  for (;;) {
    const Insn in = code[pc++];
    steps++;
    switch (in.op) {
      case OP_PUSH: *sp++ = in.c; break;
      case OP_LDK: *sp++ = ints[in.b]; break;
      case OP_POP: --sp; break;
      case OP_DUP:
        *sp = sp[-1];
        sp++;
        break;
      case OP_SWAP: std::swap(sp[-1], sp[-2]); break;
      case OP_LDX: *sp++ = m.ctx.field[in.a]; break;
      case OP_LDI: *sp++ = m.items[li].field[in.a]; break;
      case OP_LDA: *sp++ = m.ev.lines[li].allowed; break;
      case OP_LDR: *sp++ = reg[in.a]; break;
      case OP_STR: reg[in.a] = *--sp; break;
      case OP_ADDS:
        --sp;
        sp[-1] = sat_add(sp[-1], sp[0]);
        break;
      case OP_SUBS:
        --sp;
        sp[-1] = sat_sub(sp[-1], sp[0]);
        break;
      case OP_MULS:
        --sp;
        sp[-1] = sat_mul(sp[-1], sp[0]);
        break;
      case OP_MIN:
        --sp;
        sp[-1] = std::min(sp[-1], sp[0]);
        break;
      case OP_MAX:
        --sp;
        sp[-1] = std::max(sp[-1], sp[0]);
        break;
      case OP_ADDY:
        --sp;
        sp[-1] = add_years(sp[-1], sp[0]);
        break;
      case OP_EQ:
        --sp;
        sp[-1] = sp[-1] == sp[0];
        break;
      case OP_NE:
        --sp;
        sp[-1] = sp[-1] != sp[0];
        break;
      case OP_LT:
        --sp;
        sp[-1] = sp[-1] < sp[0];
        break;
      case OP_LE:
        --sp;
        sp[-1] = sp[-1] <= sp[0];
        break;
      case OP_GT:
        --sp;
        sp[-1] = sp[-1] > sp[0];
        break;
      case OP_GE:
        --sp;
        sp[-1] = sp[-1] >= sp[0];
        break;
      case OP_JMP: pc = uint32_t(in.c); break;
      case OP_JZ:
        if (*--sp == 0) pc = uint32_t(in.c);
        break;
      case OP_JNZ:
        if (*--sp != 0) pc = uint32_t(in.c);
        break;
      case OP_SWITCH: {
        int64_t v = *--sp;
        pc = (v >= 0 && v < in.a) ? table[uint32_t(in.c) + 1 + uint32_t(v)] : table[uint32_t(in.c)];
        break;
      }
      case OP_RET: m.ev.steps += steps; return true;
      case OP_DECIDE: {
        Line& line = m.ev.lines[li];
        int64_t v = *--sp;
        int64_t delta = sat_sub(v, line.allowed);
        line.status = in.a;
        line.proof = in.b;
        line.allowed = v;
        m.emit(in.a, li, m.law.proof_first[in.b], delta);
        break;
      }
      case OP_SETEXP: m.ev.lines[li].expense = in.a; break;
      case OP_SETA: {
        Line& line = m.ev.lines[li];
        int64_t v = *--sp;
        if (v != line.allowed) {
          m.emit(in.a, li, in.b, sat_sub(v, line.allowed));
          line.allowed = v;
        }
        break;
      }
      case OP_EACH:
        if (in.a == kSelectAll) {
          list = m.eligible.data();
          list_n = uint32_t(m.eligible.size());
        } else {
          list = m.by_expense.data() + m.expense_begin[in.a];
          list_n = m.expense_begin[in.a + 1] - m.expense_begin[in.a];
        }
        if (list_n == 0) {
          pc = uint32_t(in.c);
        } else {
          cursor = 0;
          li = list[0];
        }
        break;
      case OP_NEXT:
        if (++cursor < list_n) {
          li = list[cursor];
          pc = uint32_t(in.c);
        }
        break;
      case OP_CAP: {
        Line& line = m.ev.lines[li];
        int64_t v = *--sp;
        m.emit(in.a, li, in.b, sat_sub(v, line.allowed));
        line.allowed = v;
        line.cap_rule = in.b;
        break;
      }
      case OP_FLAG:
        m.ev.flags.emplace_back(li, in.b);
        m.emit(TR_RATE_UNVERIFIED, li, in.b, 0);
        break;
      case OP_CHECK: {
        int64_t v = *--sp;
        if (v < 0 || v >= check_status_count(in.a)) {
          err = "vm trap: check status out of range";
          return false;
        }
        m.ev.checks[in.a].status = uint8_t(v);
        m.ev.checks[in.a].proof = in.b;
        m.emit(uint8_t(TR_DEADLINE + in.a), kNone, m.law.proof_first[in.b], 0);
        break;
      }
      case OP_SETDATE:
        m.ev.checks[CK_DEADLINE].has_date = true;
        m.ev.checks[CK_DEADLINE].date = *--sp;
        break;
      case OP_INFO:
        m.ev.has_info = true;
        m.ev.info_proof = in.b;
        break;
      default:
        err = "vm trap: unexpected opcode";
        return false;
    }
  }
}

}  // namespace

bool run_vm(const Law& law, const Context& ctx, const std::vector<Item>& items, Evaluation& ev,
            std::string& err, bool trace) {
  ev = Evaluation();
  if (items.size() >= kNone) {
    err = "too many items";
    return false;
  }
  ev.lines.resize(items.size());
  for (size_t i = 0; i < items.size(); i++) {
    ev.lines[i].requested = items[i].field[IF_AMOUNT];
    int64_t e = items[i].field[IF_EXPENSE];
    ev.lines[i].expense = uint8_t(e >= 0 && e < EXP_COUNT ? e : EXP_UNKNOWN);
  }
  ev.checks[CK_DEADLINE].status = DL_UNKNOWN;
  ev.checks[CK_MINIMUM_LOSS].status = ML_UNKNOWN;
  ev.checks[CK_REPORTING].status = RP_UNKNOWN;
  if (trace) ev.trace.reserve(items.size() * 2 + 16);

  Machine m{law, ctx, items, ev, trace};
  for (uint32_t i = 0; i < items.size(); i++) {
    if (!exec<true>(m, law.item, i, err)) return false;
  }
  m.index_eligible();
  return exec<false>(m, law.aggr, 0, err);
}

}  // namespace tend

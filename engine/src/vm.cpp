#include "vm.h"

#include <algorithm>
#include <utility>

// Threaded dispatch (one indirect jump per instruction, through a table of
// label addresses) where the compiler supports it; a plain switch elsewhere,
// including WebAssembly, where indirect gotos lower to a switch anyway.
#if defined(__GNUC__) && !defined(__EMSCRIPTEN__) && !defined(TEND_NO_THREADED_DISPATCH)
#define TEND_THREADED 1
#else
#define TEND_THREADED 0
#endif

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
      if (ev.lines[i].status == ST_ELIGIBLE) counts[ev.lines[i].expense]++;
    }
    for (uint32_t e = 0; e < EXP_COUNT; e++) expense_begin[e + 1] = expense_begin[e] + counts[e];
    eligible.reserve(expense_begin[EXP_COUNT]);
    by_expense.resize(expense_begin[EXP_COUNT]);
    uint32_t fill[EXP_COUNT];
    std::copy(expense_begin, expense_begin + EXP_COUNT, fill);
    for (uint32_t i = 0; i < ev.lines.size(); i++) {
      if (ev.lines[i].status != ST_ELIGIBLE) continue;
      eligible.push_back(i);
      by_expense[fill[ev.lines[i].expense]++] = i;
    }
  }
};

#if TEND_THREADED
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"  // labels as values are a GNU extension
#define OP(name) L_##name:
#define DISPATCH()        \
  do {                    \
    in = code[pc++];      \
    steps++;              \
    goto* kJump[in.op];   \
  } while (0)
#define NEXT_INSN DISPATCH()
#else
#define OP(name) case name:
#define NEXT_INSN break
#endif

// Executes a program: the item program once per line in [start_line,
// end_line), the aggregate program once. The verifier has already proven
// stack bounds, jump targets, loop structure, and decision discipline, so
// nothing here is re-checked except values that depend on runtime data.
template <bool kItem>
bool exec(Machine& m, const Program& prog, uint32_t start_line, uint32_t end_line, std::string& err) {
  int64_t stack[kMaxStack];
  int64_t reg[kNumRegs] = {};
  int64_t* sp = stack;
  // Locals, so stores through Line& cannot force reloads of these pointers.
  const Insn* code = prog.code.data();
  const uint32_t* table = prog.table.data();
  const int64_t* ints = m.law.ints.data();
  const int32_t* proof_first = m.law.proof_first.data();
  const int64_t* ctx = m.ctx.field;
  const Item* items = m.items.data();
  Line* lines = m.ev.lines.data();
  const uint32_t* list = nullptr;
  uint32_t list_n = 0, cursor = 0;
  uint32_t li = start_line;
  uint32_t pc = 0;
  uint64_t steps = 0;
  Insn in;

#if TEND_THREADED
  // Indexed by opcode; the verifier admits only the opcodes named here.
  static void* const kJump[OP_NOTE + 1] = {
      &&L_bad,     &&L_OP_PUSH,   &&L_OP_LDK,  &&L_OP_POP,    &&L_OP_DUP,    &&L_OP_SWAP,    &&L_bad,     &&L_bad,
      &&L_OP_LDX,  &&L_OP_LDI,    &&L_OP_LDA,  &&L_OP_LDR,    &&L_OP_STR,    &&L_bad,        &&L_bad,     &&L_bad,
      &&L_OP_ADDS, &&L_OP_SUBS,   &&L_OP_MULS, &&L_OP_MIN,    &&L_OP_MAX,    &&L_bad,        &&L_OP_AND,  &&L_OP_OR,
      &&L_OP_EQ,   &&L_OP_NE,     &&L_OP_LT,   &&L_OP_LE,     &&L_OP_GT,     &&L_OP_GE,      &&L_bad,     &&L_bad,
      &&L_OP_JMP,  &&L_OP_JZ,     &&L_OP_JNZ,  &&L_OP_SWITCH, &&L_OP_RET,    &&L_bad,        &&L_bad,     &&L_bad,
      &&L_bad,     &&L_bad,       &&L_bad,     &&L_bad,       &&L_bad,       &&L_bad,        &&L_bad,     &&L_bad,
      &&L_OP_DECIDE, &&L_OP_SETEXP, &&L_OP_SETA, &&L_OP_ALTS, &&L_bad,       &&L_bad,        &&L_bad,     &&L_bad,
      &&L_bad,     &&L_bad,       &&L_bad,     &&L_bad,       &&L_bad,       &&L_bad,        &&L_bad,     &&L_bad,
      &&L_OP_EACH, &&L_OP_NEXT,   &&L_OP_CAP,  &&L_OP_FLAG,   &&L_OP_CHECK,  &&L_OP_SETDATE, &&L_OP_INFO, &&L_OP_NOTE};
  DISPATCH();
#else
  for (;;) {
    in = code[pc++];
    steps++;
    switch (in.op) {
#endif
  OP(OP_PUSH) *sp++ = in.c;
  NEXT_INSN;
  OP(OP_LDK) *sp++ = ints[in.b];
  NEXT_INSN;
  OP(OP_POP) { --sp; }
  NEXT_INSN;
  OP(OP_DUP) {
    *sp = sp[-1];
    sp++;
  }
  NEXT_INSN;
  OP(OP_SWAP) std::swap(sp[-1], sp[-2]);
  NEXT_INSN;
  OP(OP_LDX) *sp++ = ctx[in.a];
  NEXT_INSN;
  OP(OP_LDI) *sp++ = items[li].field[in.a];
  NEXT_INSN;
  OP(OP_LDA) *sp++ = lines[li].allowed;
  NEXT_INSN;
  OP(OP_LDR) *sp++ = reg[in.a];
  NEXT_INSN;
  OP(OP_STR) reg[in.a] = *--sp;
  NEXT_INSN;
  OP(OP_ADDS) {
    --sp;
    sp[-1] = sat_add(sp[-1], sp[0]);
  }
  NEXT_INSN;
  OP(OP_SUBS) {
    --sp;
    sp[-1] = sat_sub(sp[-1], sp[0]);
  }
  NEXT_INSN;
  OP(OP_MULS) {
    --sp;
    sp[-1] = sat_mul(sp[-1], sp[0]);
  }
  NEXT_INSN;
  OP(OP_MIN) {
    --sp;
    sp[-1] = std::min(sp[-1], sp[0]);
  }
  NEXT_INSN;
  OP(OP_MAX) {
    --sp;
    sp[-1] = std::max(sp[-1], sp[0]);
  }
  NEXT_INSN;
  OP(OP_AND) {
    --sp;
    sp[-1] = sp[-1] & sp[0];
  }
  NEXT_INSN;
  OP(OP_OR) {
    --sp;
    sp[-1] = sp[-1] | sp[0];
  }
  NEXT_INSN;
  OP(OP_EQ) {
    --sp;
    sp[-1] = sp[-1] == sp[0];
  }
  NEXT_INSN;
  OP(OP_NE) {
    --sp;
    sp[-1] = sp[-1] != sp[0];
  }
  NEXT_INSN;
  OP(OP_LT) {
    --sp;
    sp[-1] = sp[-1] < sp[0];
  }
  NEXT_INSN;
  OP(OP_LE) {
    --sp;
    sp[-1] = sp[-1] <= sp[0];
  }
  NEXT_INSN;
  OP(OP_GT) {
    --sp;
    sp[-1] = sp[-1] > sp[0];
  }
  NEXT_INSN;
  OP(OP_GE) {
    --sp;
    sp[-1] = sp[-1] >= sp[0];
  }
  NEXT_INSN;
  OP(OP_JMP) pc = uint32_t(in.c);
  NEXT_INSN;
  OP(OP_JZ) {
    if (*--sp == 0) pc = uint32_t(in.c);
  }
  NEXT_INSN;
  OP(OP_JNZ) {
    if (*--sp != 0) pc = uint32_t(in.c);
  }
  NEXT_INSN;
  OP(OP_SWITCH) {
    int64_t v = *--sp;
    pc = (v >= 0 && v < in.a) ? table[uint32_t(in.c) + 1 + uint32_t(v)] : table[uint32_t(in.c)];
  }
  NEXT_INSN;
  OP(OP_RET) {
    if constexpr (kItem) {
      if (++li < end_line) {
        pc = 0;  // the stack is already empty at ret
        for (uint32_t r = 0; r < kNumRegs; r++) reg[r] = 0;
        NEXT_INSN;
      }
    }
    m.ev.steps += steps;
    return true;
  }
  OP(OP_DECIDE) {
    Line& line = lines[li];
    int64_t v = *--sp;
    int64_t delta = sat_sub(v, line.allowed);
    line.status = in.a;
    line.proof = in.b;
    line.allowed = v;
    m.emit(in.a, li, proof_first[in.b], delta);
  }
  NEXT_INSN;
  OP(OP_SETEXP) lines[li].expense = in.a;
  NEXT_INSN;
  OP(OP_ALTS) lines[li].alt_proof = in.b;
  NEXT_INSN;
  OP(OP_SETA) {
    Line& line = lines[li];
    int64_t v = *--sp;
    if (v != line.allowed) {
      m.emit(in.a, li, in.b, sat_sub(v, line.allowed));
      line.allowed = v;
    }
  }
  NEXT_INSN;
  OP(OP_EACH) {
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
  }
  NEXT_INSN;
  OP(OP_NEXT) {
    if (++cursor < list_n) {
      li = list[cursor];
      pc = uint32_t(in.c);
    }
  }
  NEXT_INSN;
  OP(OP_CAP) {
    Line& line = lines[li];
    int64_t v = *--sp;
    m.emit(in.a, li, in.b, sat_sub(v, line.allowed));
    line.allowed = v;
    line.cap_rule = in.b;
  }
  NEXT_INSN;
  OP(OP_FLAG) {
    m.ev.flags.emplace_back(li, in.b);
    m.emit(TR_RATE_UNVERIFIED, li, in.b, 0);
  }
  NEXT_INSN;
  OP(OP_CHECK) {
    int64_t v = *--sp;
    if (v < 0 || v >= check_status_count(in.a)) {
      err = "vm trap: check status out of range";
      return false;
    }
    m.ev.checks[in.a].status = uint8_t(v);
    m.ev.checks[in.a].proof = in.b;
    m.emit(uint8_t(TR_DEADLINE + in.a), kNone, proof_first[in.b], 0);
  }
  NEXT_INSN;
  OP(OP_SETDATE) {
    m.ev.checks[CK_DEADLINE].has_date = true;
    m.ev.checks[CK_DEADLINE].date = *--sp;
  }
  NEXT_INSN;
  OP(OP_INFO) {
    m.ev.has_info = true;
    m.ev.info_proof = in.b;
  }
  NEXT_INSN;
  OP(OP_NOTE) m.ev.notes |= uint32_t(1) << in.a;
  NEXT_INSN;
#if TEND_THREADED
L_bad:
  err = "vm trap: unexpected opcode";
  return false;
#else
      default:
        err = "vm trap: unexpected opcode";
        return false;
    }
  }
#endif
}

#undef OP
#undef NEXT_INSN
#undef DISPATCH
#if TEND_THREADED
#pragma GCC diagnostic pop
#endif

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
  if (!items.empty() && !exec<true>(m, law.item, 0, uint32_t(items.size()), err)) return false;
  m.index_eligible();
  return exec<false>(m, law.aggr, 0, 0, err);
}

}  // namespace tend

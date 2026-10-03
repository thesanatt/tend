#include "disasm.h"

#include <algorithm>
#include <cstdio>
#include <map>

#include "sha256.h"

namespace tend {
namespace {

std::string pad(std::string s, size_t w) {
  if (s.size() < w) s.append(w - s.size(), ' ');
  return s;
}

// First ~64 bytes of a quote, cut at a word boundary, never inside a UTF-8 sequence.
std::string quote_start(std::string_view q) {
  constexpr size_t kMax = 64;
  if (q.size() <= kMax) return "\"" + std::string(q) + "\"";
  size_t cut = kMax;
  while (cut > 0 && (static_cast<unsigned char>(q[cut]) & 0xC0) == 0x80) cut--;
  size_t space = q.rfind(' ', cut);
  if (space != std::string_view::npos && space > kMax / 2) cut = space;
  std::string s(q.substr(0, cut));
  while (!s.empty() && (s.back() == ' ' || s.back() == ',' || s.back() == ';')) s.pop_back();
  return "\"" + s + "...\"";
}

std::string proof_text(const Law& law, uint32_t p) {
  std::string s;
  for (uint32_t i = 0; i < law.proof_len(p); i++) {
    if (i) s += ", ";
    s += law.str(law.rules[law.proof_rules(p)[i]].id);
  }
  return s.empty() ? "(none)" : s;
}

class Lister {
 public:
  explicit Lister(const Law& law) : law_(law) {}

  std::string run() {
    header();
    tables();
    program(0, law_.item, ".item");
    program(1, law_.aggr, ".aggregate");
    return std::move(out_);
  }

 private:
  void line(const std::string& s) {
    size_t end = s.find_last_not_of(' ');
    out_.append(s, 0, end == std::string::npos ? 0 : end + 1);
    out_ += '\n';
  }

  void header() {
    std::string_view name = law_.meta_value("name");
    std::string_view compiler = law_.meta_value("compiler");
    line("; tend law image " + std::string(law_.jurisdiction) + (name.empty() ? "" : ", " + std::string(name)));
    line("; format " + std::to_string(law_.major) + "." + std::to_string(law_.minor) +
         (compiler.empty() ? "" : ", compiled by " + std::string(compiler)));
    line("; source sha256 " + to_hex(law_.source_sha256, 32));
    line("; image sha256  " + to_hex(law_.image_sha256, 32));
    line("; " + std::to_string(law_.rules.size()) + " rules, " + std::to_string(law_.sources.size()) +
         " sources, " + std::to_string(law_.proof_count()) + " proofs, " +
         std::to_string(law_.ints.size()) + " ints, " + std::to_string(law_.strings.size()) + " strings");
    auto prog = [&](const char* what, const Program& p) {
      line("; " + std::string(what) + ": " + std::to_string(p.code.size()) + " instructions, " +
           std::to_string(p.byte_size) + " bytes, max stack " + std::to_string(p.max_depth) +
           (p.loops ? ", " + std::to_string(p.loops) + " loops" : ""));
    };
    prog("item program", law_.item);
    prog("aggregate program", law_.aggr);
    line("");
  }

  void tables() {
    line(".rules");
    for (size_t i = 0; i < law_.rules.size(); i++) {
      const Rule& r = law_.rules[i];
      std::string detail;
      if (r.per == PER_CLAIM) detail = "per claim";
      else if (r.per == PER_UNIT) detail = "per " + std::string(law_.str(r.aux));
      else if (r.kind == K_INFO || r.kind == K_SKIPPED) detail = std::string(law_.str(r.category));
      std::string text = "    " + pad("R" + std::to_string(i), 6) + pad(std::string(law_.str(r.id)), 22) +
                         pad(std::string(kind_name(r.kind)), 14) +
                         pad(r.expense == kNoExpense ? "-" : std::string(expense_name(r.expense)), 22) +
                         pad(detail, 24) + std::string(law_.str(r.pinpoint));
      if (r.kind == K_SKIPPED && r.aux != kNone) text += "  ; " + std::string(law_.str(r.aux));
      line(text);
    }
    line("");
    if (!law_.tags.empty()) {
      std::string t = ".tags   ";
      for (size_t i = 0; i < law_.tags.size(); i++) {
        t += (i ? ", " : "") + std::string(law_.tags[i]) + "=bit" + std::to_string(i);
      }
      line(t);
      line("");
    }
    line(".sources");
    for (size_t i = 0; i < law_.sources.size(); i++) {
      const Source& s = law_.sources[i];
      line("    " + pad("S" + std::to_string(i), 6) + pad(std::string(law_.str(s.id)), 12) + "sha256 " +
           to_hex(s.sha256, 32).substr(0, 16) + "  " + std::string(law_.str(s.url)));
    }
    line("");
    line(".proofs");
    for (uint32_t p = 0; p < law_.proof_count(); p++) {
      line("    " + pad("P" + std::to_string(p), 6) + "(" + (law_.proof_len(p) ? proof_text(law_, p) : "") + ")");
    }
    line("");
    line(".ints");
    for (size_t i = 0; i < law_.ints.size(); i++) {
      line("    " + pad("K" + std::to_string(i), 6) + pad(std::to_string(law_.ints[i]), 14) + "; " +
           format_cents(law_.ints[i]));
    }
    line("");
  }

  std::string label(const std::map<uint32_t, uint32_t>& labels, uint32_t index) {
    auto it = labels.find(index);
    return it == labels.end() ? "?" : "L" + std::to_string(it->second);
  }

  void program(uint8_t which, const Program& p, const char* title) {
    line(title);
    std::map<uint32_t, uint32_t> labels;  // instruction index -> label number
    for (const Insn& in : p.code) {
      switch (in.op) {
        case OP_JMP:
        case OP_JZ:
        case OP_JNZ:
        case OP_EACH:
        case OP_NEXT: labels[uint32_t(in.c)] = 0; break;
        case OP_SWITCH:
          for (uint32_t k = 0; k <= in.a; k++) labels[p.table[uint32_t(in.c) + k]] = 0;
          break;
        default: break;
      }
    }
    uint32_t next_label = 0;
    for (auto& [idx, num] : labels) num = next_label++;

    std::multimap<uint32_t, uint32_t> annos;  // pc -> rule
    for (const Anno& a : law_.annos) {
      if (a.program == which) annos.emplace(a.pc, a.rule);
    }

    for (uint32_t i = 0; i < p.code.size(); i++) {
      const Insn& in = p.code[i];
      uint32_t pc = p.offsets[i];
      auto range = annos.equal_range(pc);
      for (auto it = range.first; it != range.second; ++it) {
        const Rule& r = law_.rules[it->second];
        line("              ; " + std::string(law_.str(r.id)) + "  " + std::string(law_.str(r.pinpoint)) +
             "  " + quote_start(law_.str(r.quote)));
      }
      char addr[16];
      std::snprintf(addr, sizeof addr, "%04x", pc);
      auto lit = labels.find(i);
      std::string lab = lit == labels.end() ? "" : "L" + std::to_string(lit->second) + ":";
      std::string operands, comment;
      describe(p, labels, i, operands, comment);
      std::string text = "  " + std::string(addr) + "  " + pad(lab, 6) + pad(op_info(in.op).name, 9) + operands;
      if (!comment.empty()) text = pad(text, 52) + "; " + comment;
      line(text);
      if (in.op == OP_SWITCH) {
        bool on_expense = i > 0 && p.code[i - 1].op == OP_LDI && p.code[i - 1].a == IF_EXPENSE;
        for (uint32_t k = 0; k < in.a; k++) {
          std::string name = on_expense && k < EXP_COUNT ? std::string(expense_name(uint8_t(k))) : std::to_string(k);
          line("                        case " + pad(name, 22) + "-> " +
               label(labels, p.table[uint32_t(in.c) + 1 + k]));
        }
      }
    }
    line("");
  }

  void describe(const Program& p, const std::map<uint32_t, uint32_t>& labels, uint32_t i,
                std::string& operands, std::string& comment) {
    const Insn& in = p.code[i];
    auto rule_id = [&](uint32_t r) { return std::string(law_.str(law_.rules[r].id)); };
    switch (in.op) {
      case OP_PUSH: {
        operands = std::to_string(in.c);
        const Insn* next = i + 1 < p.code.size() ? &p.code[i + 1] : nullptr;
        const Insn* prev = i > 0 ? &p.code[i - 1] : nullptr;
        if (next && next->op == OP_CHECK && in.c >= 0 && in.c < check_status_count(next->a)) {
          comment = std::string(check_status_name(next->a, uint8_t(in.c)));
        } else if (prev && prev->op == OP_LDX && prev->a == CX_POLICE_REPORT && in.c >= 0 && in.c <= 2) {
          static const char* kPolice[] = {"no", "yes", "unknown"};
          comment = kPolice[in.c];
        }
        break;
      }
      case OP_LDK:
        operands = "K" + std::to_string(in.b);
        comment = format_cents(law_.ints[in.b]);
        break;
      case OP_LDX: operands = std::string(ctx_field_name(in.a)); break;
      case OP_LDI: operands = std::string(item_field_name(in.a)); break;
      case OP_LDR:
      case OP_STR: operands = "r" + std::to_string(in.a); break;
      case OP_JMP:
      case OP_JZ:
      case OP_JNZ:
      case OP_NEXT: operands = label(labels, uint32_t(in.c)); break;
      case OP_SWITCH:
        operands = std::to_string(in.a) + ", default " + label(labels, p.table[uint32_t(in.c)]);
        break;
      case OP_DECIDE:
        operands = std::string(status_name(in.a)) + ", P" + std::to_string(in.b);
        comment = proof_text(law_, in.b);
        break;
      case OP_SETEXP: operands = std::string(expense_name(in.a)); break;
      case OP_SETA:
      case OP_CAP:
        operands = std::string(trace_op_name(in.a)) + ", R" + std::to_string(in.b);
        comment = rule_id(in.b);
        break;
      case OP_EACH:
        operands = (in.a == kSelectAll ? std::string("all") : std::string(expense_name(in.a))) + ", " +
                   label(labels, uint32_t(in.c));
        break;
      case OP_FLAG:
        operands = "R" + std::to_string(in.b);
        comment = "rate_unverified " + rule_id(in.b);
        break;
      case OP_CHECK:
        operands = std::string(check_kind_name(in.a)) + ", P" + std::to_string(in.b);
        comment = proof_text(law_, in.b);
        break;
      case OP_INFO:
      case OP_ALTS:
        operands = "P" + std::to_string(in.b);
        comment = proof_text(law_, in.b);
        break;
      default: break;
    }
  }

  const Law& law_;
  std::string out_;
};

}  // namespace

std::string format_cents(int64_t cents) {
  bool neg = cents < 0;
  uint64_t v = neg ? uint64_t(0) - uint64_t(cents) : uint64_t(cents);
  std::string whole = std::to_string(v / 100);
  std::string grouped;
  for (size_t i = 0; i < whole.size(); i++) {
    if (i && (whole.size() - i) % 3 == 0) grouped += ',';
    grouped += whole[i];
  }
  char frac[4];
  std::snprintf(frac, sizeof frac, "%02u", unsigned(v % 100));
  return std::string(neg ? "-$" : "$") + grouped + "." + frac;
}

std::string disassemble(const Law& law) { return Lister(law).run(); }

void inspect_json(const Law& law, OutBuf& out) {
  auto str_or_null = [&](uint32_t i) {
    if (i == kNone) out.put("null");
    else out.put_json_string(law.str(i));
  };
  out.put("{\"jurisdiction\":");
  out.put_json_string(law.jurisdiction);
  out.put(",\"format\":\"");
  out.put(std::to_string(law.major) + "." + std::to_string(law.minor));
  out.put("\",\"source_sha256\":\"");
  out.put(to_hex(law.source_sha256, 32));
  out.put("\",\"law_image_sha256\":\"");
  out.put(to_hex(law.image_sha256, 32));
  out.put("\",\"meta\":{");
  for (size_t i = 0; i < law.meta.size(); i++) {
    if (i) out.put(',');
    out.put_json_string(law.str(law.meta[i].first));
    out.put(':');
    out.put_json_string(law.str(law.meta[i].second));
  }
  out.put("},\"rules\":[");
  for (size_t i = 0; i < law.rules.size(); i++) {
    const Rule& r = law.rules[i];
    if (i) out.put(',');
    out.put("{\"id\":");
    out.put_json_string(law.str(r.id));
    out.put(",\"kind\":");
    out.put_json_string(kind_name(r.kind));
    out.put(",\"category\":");
    str_or_null(r.category);
    out.put(",\"expense\":");
    if (r.expense == kNoExpense) out.put("null");
    else out.put_json_string(expense_name(r.expense));
    out.put(",\"per\":");
    if (r.per == PER_NONE) out.put("null");
    else out.put_json_string(per_name(r.per));
    out.put(",\"unit\":");
    if (r.per == PER_UNIT) str_or_null(r.aux);
    else out.put("null");
    out.put(",\"skip_reason\":");
    if (r.kind == K_SKIPPED) str_or_null(r.aux);
    else out.put("null");
    out.put(",\"pinpoint\":");
    out.put_json_string(law.str(r.pinpoint));
    out.put(",\"quote\":");
    out.put_json_string(law.str(r.quote));
    out.put(",\"summary\":");
    str_or_null(r.summary);
    out.put(",\"fragment_url\":");
    str_or_null(r.fragment);
    out.put(",\"source_id\":");
    if (r.source == kNone) out.put("null");
    else out.put_json_string(law.str(law.sources[r.source].id));
    out.put('}');
  }
  out.put("],\"sources\":[");
  for (size_t i = 0; i < law.sources.size(); i++) {
    const Source& s = law.sources[i];
    if (i) out.put(',');
    out.put("{\"id\":");
    out.put_json_string(law.str(s.id));
    out.put(",\"url\":");
    str_or_null(s.url);
    out.put(",\"title\":");
    str_or_null(s.title);
    out.put(",\"sha256\":\"");
    out.put(to_hex(s.sha256, 32));
    out.put("\"}");
  }
  auto prog = [&](const Program& p) {
    out.put("{\"instructions\":");
    out.put_i64(int64_t(p.code.size()));
    out.put(",\"bytes\":");
    out.put_i64(p.byte_size);
    out.put(",\"max_stack\":");
    out.put_i64(p.max_depth);
    out.put(",\"loops\":");
    out.put_i64(p.loops);
    out.put('}');
  };
  out.put("],\"tags\":[");
  for (size_t i = 0; i < law.tags.size(); i++) {
    if (i) out.put(',');
    out.put_json_string(law.tags[i]);
  }
  out.put("],\"programs\":{\"item\":");
  prog(law.item);
  out.put(",\"aggregate\":");
  prog(law.aggr);
  out.put("}}");
}

}  // namespace tend

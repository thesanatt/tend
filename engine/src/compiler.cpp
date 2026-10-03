#include "compiler.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <optional>
#include <tuple>

#include "builder.h"
#include "format.h"
#include "nlohmann/json.hpp"
#include "sha256.h"
#include "version.h"

namespace tend {
namespace {

using nlohmann::json;
using Label = Assembler::Label;

constexpr int64_t kMaxCents = 1000000000000000;  // $10 trillion
constexpr int64_t kMaxDays = 4000000;
constexpr int64_t kMaxCount = 1000000;
constexpr size_t kMaxTagExclusions = 6;  // per expense; the switch has 2^n cases

struct IRule {
  uint16_t index = 0;
  std::string id;
  uint8_t kind = 0;
  uint8_t expense = kNoExpense;
  uint8_t per = PER_NONE;
  uint8_t unit_code = UNIT_NONE;  // per-unit caps
  uint8_t anchor = FROM_CRIME;    // deadlines
  std::string unit, category, skip_reason;
  std::optional<int64_t> cap;  // cap_cents of caps and minimum loss
  std::optional<int64_t> count_limit;
  std::optional<int64_t> days_lost;  // minimum loss
  std::vector<std::string> alt_ids;
  uint32_t tag_mask = 0;
  int64_t days = 0;
  bool required = true;
  bool alt_exam = false;
  bool waiver_sa = false;
  bool waiver_automatic = false;
  bool waiver_discretionary = false;
};

struct VerifiedRule {
  std::string category, pinpoint, quote, summary, fragment, source_id;
};

class CompileError {};

class Compiler {
 public:
  bool run(const std::string& ir_bytes, const std::string& verified_bytes, CompileResult& out, std::string& err);

 private:
  [[noreturn]] void fail(const std::string& msg) {
    err_ = msg;
    throw CompileError();
  }
  void note(const std::string& msg) { notes_.push_back(msg); }

  void load_verified(const json& doc);
  void parse(const json& ir);
  IRule parse_rule(const json& r, size_t index);
  uint8_t expense_of(const json& r, const std::string& where, bool required);
  std::optional<int64_t> integer(const json& r, const char* key, int64_t max, const std::string& where);
  void add_to_table(const IRule& r);

  std::vector<uint16_t> of_kind(uint8_t kind) const {
    std::vector<uint16_t> out;
    for (size_t i = 0; i < ir_count_; i++) {
      if (rules_[i].kind == kind) out.push_back(rules_[i].index);
    }
    return out;
  }
  void anno(uint8_t program, const Assembler& a, const std::vector<uint16_t>& rules) {
    for (uint16_t r : rules) b_.anno(program, a.pc(), r);
  }

  struct Block {
    std::vector<uint16_t> uncond, tagged, cov, alts;
    bool operator<(const Block& o) const {
      return std::tie(uncond, tagged, cov, alts) < std::tie(o.uncond, o.tagged, o.cov, o.alts);
    }
  };
  Block block_for(uint8_t expense) const;
  void emit_block(Assembler& a, const Block& k, Label start);
  void item_program(Assembler& a);
  void aggregate_program(Assembler& a);
  void unit_cap(Assembler& a, const IRule& r);
  void walk_cap(Assembler& a, const IRule& r, uint8_t selector, uint8_t op);
  void minimum_loss(Assembler& a);
  void deadline(Assembler& a);
  void reporting(Assembler& a);

  std::string err_;
  std::vector<std::string> notes_;
  std::vector<IRule> rules_;  // IR rules, then the ones the front end skipped
  size_t ir_count_ = 0;
  std::map<std::string, uint16_t> index_of_;
  std::map<std::string, VerifiedRule> verified_;
  std::map<std::string, uint32_t> source_index_;
  bool have_verified_ = false;
  std::vector<uint16_t> collateral_;
  ImageBuilder b_;
};

std::string str_field(const json& obj, const char* key) {
  auto it = obj.find(key);
  return it != obj.end() && it->is_string() ? it->get<std::string>() : std::string();
}

std::optional<int64_t> Compiler::integer(const json& r, const char* key, int64_t max, const std::string& where) {
  auto it = r.find(key);
  if (it == r.end() || it->is_null()) return std::nullopt;
  if (!it->is_number_integer() || (it->is_number_unsigned() && it->get<uint64_t>() > uint64_t(INT64_MAX)))
    fail(where + ": " + key + " must be an integer");
  int64_t v = it->get<int64_t>();
  if (v < 0 || v > max) fail(where + ": " + key + " is out of range");
  return v;
}

uint8_t Compiler::expense_of(const json& r, const std::string& where, bool required) {
  auto it = r.find("expense");
  if (it == r.end() || it->is_null()) {
    if (required) fail(where + ": expense is required");
    return kNoExpense;
  }
  uint8_t e;
  if (!it->is_string() || !parse_expense(it->get<std::string>(), e) || e >= kRuleExpenseCount)
    fail(where + ": unknown expense " + it->dump());
  return e;
}

IRule Compiler::parse_rule(const json& r, size_t index) {
  std::string where = "rules[" + std::to_string(index) + "]";
  if (!r.is_object()) fail(where + " is not an object");
  IRule c;
  c.index = uint16_t(index);
  c.id = str_field(r, "id");
  if (c.id.empty()) fail(where + ": missing id");
  where = c.id;
  std::string kind = str_field(r, "kind");
  if (!parse_kind(kind, c.kind)) fail(where + ": unknown kind '" + kind + "'");
  c.category = str_field(r, "category");
  // SPEC v1.1 writes these as info rules; normalize.py gives them their own
  // kinds. Both spellings mean the same thing.
  if (c.kind == K_INFO && c.category == "collateral_source") c.kind = K_COLLATERAL;
  if (c.kind == K_INFO && c.category == "exam_payment") c.kind = K_EXAM_PAYMENT;

  switch (c.kind) {
    case K_TOTAL_CAP:
      c.cap = integer(r, "cap_cents", kMaxCents, where);
      if (!c.cap) fail(where + ": cap_cents is required");
      break;
    case K_EXPENSE_CAP: {
      c.expense = expense_of(r, where, true);
      c.cap = integer(r, "cap_cents", kMaxCents, where);
      if (!c.cap) fail(where + ": cap_cents is required");
      std::string per = str_field(r, "per");
      if (per == "claim") {
        c.per = PER_CLAIM;
      } else if (per == "unit") {
        c.per = PER_UNIT;
        c.unit = str_field(r, "unit");
        if (c.unit.empty()) fail(where + ": a per-unit cap needs a unit");
        if (!parse_unit(c.unit, c.unit_code)) fail(where + ": unknown unit '" + c.unit + "'");
      } else {
        fail(where + ": per must be claim or unit");
      }
      c.count_limit = integer(r, "count_limit", kMaxCount, where);
      if (c.count_limit && c.per == PER_CLAIM) {
        note(where + ": count_limit on a per-claim cap has no units to count and is ignored");
        c.count_limit.reset();
      }
      if (auto a = r.find("alt_rule_ids"); a != r.end() && !a->is_null()) {
        if (!a->is_array()) fail(where + ": alt_rule_ids must be a list");
        for (const json& x : *a) {
          if (!x.is_string() || x.get<std::string>().empty()) fail(where + ": alt_rule_ids must hold rule ids");
          c.alt_ids.push_back(x.get<std::string>());
        }
      }
      break;
    }
    case K_COVERED: c.expense = expense_of(r, where, true); break;
    case K_EXCLUDED: {
      c.expense = expense_of(r, where, false);
      if (auto t = r.find("tags"); t != r.end() && !t->is_null()) {
        if (!t->is_array()) fail(where + ": tags must be a list");
        for (const json& x : *t) {
          if (!x.is_string() || x.get<std::string>().empty()) fail(where + ": tags must be non-empty strings");
          uint8_t bit = b_.tag(x.get<std::string>());
          if (bit >= kMaxTags) fail("more than 31 distinct tags");
          c.tag_mask |= uint32_t(1) << bit;
        }
      }
      if (c.expense == kNoExpense && !c.tag_mask) fail(where + ": an exclusion needs an expense or tags");
      break;
    }
    case K_DEADLINE: {
      auto d = integer(r, "days", kMaxDays, where);
      if (!d) fail(where + ": days is required");
      c.days = *d;
      auto from = r.find("from");
      if (from != r.end() && !from->is_null() &&
          (!from->is_string() || !parse_anchor(from->get<std::string>(), c.anchor)))
        fail(where + ": from must be crime, incident, discovery, injury, offense, or report");
      break;
    }
    case K_REPORTING: {
      auto req = r.find("required");
      if (req != r.end() && !req->is_null()) {
        if (!req->is_boolean()) fail(where + ": required must be true or false");
        c.required = req->get<bool>();
      }
      auto alt = r.find("alternatives");
      if (alt != r.end() && !alt->is_null()) {
        if (!alt->is_array()) fail(where + ": alternatives must be a list");
        for (const json& x : *alt) c.alt_exam = c.alt_exam || (x.is_string() && x.get<std::string>() == "forensic_exam");
      }
      break;
    }
    case K_MINIMUM_LOSS: {
      c.cap = integer(r, "cap_cents", kMaxCents, where);
      c.days_lost = integer(r, "days_lost", kMaxDays, where);
      std::string w = str_field(r, "waiver");
      if (!w.empty() && w != "none" && w != "other" && w != "discretionary" && w != "automatic")
        fail(where + ": unknown waiver '" + w + "'");
      c.waiver_automatic = w == "automatic";
      c.waiver_discretionary = w == "discretionary";
      auto sa = r.find("waiver_for_sexual_assault");
      if (sa != r.end() && !sa->is_null()) {
        if (!sa->is_boolean()) fail(where + ": waiver_for_sexual_assault must be true or false");
        c.waiver_sa = sa->get<bool>();
      }
      if (!c.cap && !c.days_lost) fail(where + ": a minimum loss rule needs cap_cents or days_lost");
      break;
    }
    default: break;
  }
  return c;
}

void Compiler::load_verified(const json& doc) {
  if (!doc.is_object()) fail("verified file: top level is not an object");
  if (auto s = doc.find("sources"); s != doc.end() && s->is_array()) {
    for (const json& src : *s) {
      std::string id = str_field(src, "id");
      if (id.empty() || source_index_.count(id)) fail("verified file: missing or duplicate source id");
      SourceRecord rec;
      rec.id = b_.str(id);
      rec.url = b_.opt_str(str_field(src, "url"));
      rec.title = b_.opt_str(str_field(src, "title"));
      std::string sha = str_field(src, "sha256");
      if (!sha.empty() && (sha.size() != 64 || !from_hex(sha.data(), sha.size(), rec.sha256)))
        fail("verified file: source " + id + " has a bad sha256");
      source_index_[id] = b_.source(rec);
    }
  }
  auto rs = doc.find("rules");
  if (rs == doc.end() || !rs->is_array()) fail("verified file: rules must be a list");
  for (const json& r : *rs) {
    std::string id = str_field(r, "id");
    if (id.empty()) continue;
    VerifiedRule v{str_field(r, "category"), str_field(r, "pinpoint"), str_field(r, "quote"),
                   str_field(r, "summary"),  str_field(r, "fragment_url"), str_field(r, "source_id")};
    if (!v.source_id.empty() && !source_index_.count(v.source_id))
      fail("verified file: " + id + " cites unknown source " + v.source_id);
    verified_[id] = v;
  }
}

void Compiler::add_to_table(const IRule& r) {
  RuleRecord rec;
  rec.kind = r.kind;
  rec.expense = r.expense;
  rec.per = r.per;
  rec.id = b_.str(r.id);
  std::string category = r.category;
  if (have_verified_) {
    auto it = verified_.find(r.id);
    if (it == verified_.end()) fail(r.id + " is in the IR but not in the verified file");
    const VerifiedRule& v = it->second;
    rec.pinpoint = b_.str(v.pinpoint);
    rec.quote = b_.str(v.quote);
    rec.summary = b_.opt_str(v.summary);
    rec.fragment = b_.opt_str(v.fragment);
    rec.source = v.source_id.empty() ? kNone : source_index_[v.source_id];
    if (!v.category.empty()) category = v.category;
  } else {
    rec.pinpoint = b_.str("");
    rec.quote = b_.str("");
  }
  rec.category = b_.opt_str(category);
  if (r.kind == K_SKIPPED) rec.aux = b_.opt_str(r.skip_reason);
  else if (r.per == PER_UNIT) rec.aux = b_.str(r.unit);
  else if (r.kind == K_DEADLINE) rec.aux = b_.str(anchor_name(r.anchor));
  b_.rule(rec);
}

void Compiler::parse(const json& ir) {
  if (!ir.is_object()) fail("IR: top level is not an object");
  auto v = ir.find("ir_version");
  if (v == ir.end() || !v->is_number_integer() || v->get<int64_t>() != 2) fail("IR: ir_version must be 2");
  std::string j = str_field(ir, "jurisdiction");
  if (j.empty() || j.size() > 8) fail("IR: jurisdiction must be a 1 to 8 character code");
  for (char ch : j) {
    if (!((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))) fail("IR: jurisdiction must be uppercase letters or digits");
  }
  b_.set_jurisdiction(j);

  auto rs = ir.find("rules");
  if (rs == ir.end() || !rs->is_array()) fail("IR: rules must be a list");
  for (size_t i = 0; i < rs->size(); i++) rules_.push_back(parse_rule((*rs)[i], i));
  ir_count_ = rules_.size();
  if (auto sk = ir.find("skipped"); sk != ir.end() && !sk->is_null()) {
    if (!sk->is_array()) fail("IR: skipped must be a list");
    for (const json& s : *sk) {
      IRule c;
      c.index = uint16_t(rules_.size());
      c.kind = K_SKIPPED;
      c.id = str_field(s, "id");
      c.category = str_field(s, "category");
      c.skip_reason = str_field(s, "reason");
      if (c.id.empty()) fail("IR: a skipped entry has no id");
      rules_.push_back(c);
    }
  }
  if (rules_.size() > 65535) fail("IR: too many rules");
  for (const IRule& r : rules_) {
    if (!index_of_.emplace(r.id, r.index).second) fail("IR: duplicate rule id " + r.id);
  }
  for (const IRule& r : rules_) {
    for (const std::string& alt : r.alt_ids) {
      if (!index_of_.count(alt)) fail(r.id + ": alt rule " + alt + " is not in the IR");
    }
  }
  for (const IRule& r : rules_) add_to_table(r);
  collateral_ = of_kind(K_COLLATERAL);

  std::string name = str_field(ir, "name");
  if (!name.empty()) b_.meta("name", name);
  b_.meta("compiler", TENDC_ID);
  if (ir_count_ < rules_.size())
    note(std::to_string(rules_.size() - ir_count_) + " rules set aside by the front end are listed but never applied");
}

// Everything that decides an item of this expense once it is in the window.
Compiler::Block Compiler::block_for(uint8_t e) const {
  Block k;
  for (size_t i = 0; i < ir_count_; i++) {
    const IRule& r = rules_[i];
    if (r.kind == K_EXCLUDED && (r.expense == e || r.expense == kNoExpense)) {
      if (r.tag_mask) k.tagged.push_back(r.index);
      else k.uncond.push_back(r.index);
    }
    if ((r.kind == K_COVERED || r.kind == K_EXPENSE_CAP) && r.expense == e) {
      k.cov.push_back(r.index);
      for (const std::string& alt : r.alt_ids) k.alts.push_back(index_of_.at(alt));
    }
  }
  return k;
}

void Compiler::emit_block(Assembler& a, const Block& k, Label start) {
  a.bind(start);
  std::vector<uint16_t> shown = k.uncond;
  shown.insert(shown.end(), k.tagged.begin(), k.tagged.end());
  shown.insert(shown.end(), k.cov.begin(), k.cov.end());
  if (!k.cov.empty()) shown.insert(shown.end(), collateral_.begin(), collateral_.end());
  std::sort(shown.begin(), shown.end());
  anno(0, a, shown);

  Label cover = a.label();
  if (!k.tagged.empty()) {
    // Step 3 with tags: r0 collects which tagged exclusions match this item,
    // then a switch picks the decision whose proof lists exactly those rules.
    size_t n = k.tagged.size();
    if (n > kMaxTagExclusions) fail("more than 6 tagged exclusions apply to one expense");
    a.push(0);
    a.u8op(OP_STR, 0);
    for (size_t i = 0; i < n; i++) {
      Label skip = a.label();
      a.u8op(OP_LDI, IF_TAGS);
      a.push(int32_t(rules_[k.tagged[i]].tag_mask));
      a.op(OP_AND);
      a.jump(OP_JZ, skip);
      a.u8op(OP_LDR, 0);
      a.push(int32_t(1) << i);
      a.op(OP_OR);
      a.u8op(OP_STR, 0);
      a.bind(skip);
    }
    a.u8op(OP_LDR, 0);
    Label uncond = a.label();
    std::vector<Label> cases(size_t(1) << n);
    cases[0] = k.uncond.empty() ? cover : uncond;
    for (size_t s = 1; s < cases.size(); s++) cases[s] = a.label();
    a.sw(cases, cases[0]);
    for (size_t s = 1; s < cases.size(); s++) {
      std::vector<uint16_t> proof = k.uncond;
      for (size_t i = 0; i < n; i++) {
        if (s & (size_t(1) << i)) proof.push_back(k.tagged[i]);
      }
      std::sort(proof.begin(), proof.end());
      a.bind(cases[s]);
      a.push(0);
      a.u8u16(OP_DECIDE, ST_EXCLUDED, b_.proof(proof));
      a.op(OP_RET);
    }
    if (!k.uncond.empty()) a.bind(uncond);
  }
  if (!k.uncond.empty()) {
    a.push(0);
    a.u8u16(OP_DECIDE, ST_EXCLUDED, b_.proof(k.uncond));
    a.op(OP_RET);
    return;
  }
  a.bind(cover);
  if (k.cov.empty()) {
    // Step 4: no rule names this expense.
    a.push(0);
    a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
    a.op(OP_RET);
    return;
  }
  // Steps 5 and 6.
  if (!k.alts.empty()) a.u16op(OP_ALTS, b_.proof(k.alts));
  std::vector<uint16_t> with_collateral = k.cov;
  with_collateral.insert(with_collateral.end(), collateral_.begin(), collateral_.end());
  Label confirmed = a.label();
  a.u8op(OP_LDI, IF_CONFIRMED);
  a.jump(OP_JNZ, confirmed);
  a.push(0);
  a.u8u16(OP_DECIDE, ST_NEEDS_CONFIRMATION, b_.proof(k.cov));
  a.op(OP_RET);
  a.bind(confirmed);
  a.u8op(OP_LDI, IF_AMOUNT);
  a.u8u16(OP_DECIDE, ST_ELIGIBLE, b_.proof(with_collateral));
  if (!collateral_.empty()) {
    a.op(OP_LDA);
    a.u8op(OP_LDI, IF_INSURANCE_PAID);
    a.op(OP_SUBS);
    a.push(0);
    a.op(OP_MAX);
    a.u8u16(OP_SETA, TR_COLLATERAL, collateral_[0]);
  }
  a.op(OP_RET);
}

// Per-item program: SPEC steps 1-6. One switch on the item's expense picks a
// block whose outcome depends only on this jurisdiction's rules and the
// item's tags and confirmation.
void Compiler::item_program(Assembler& a) {
  // SPEC v1.2: an exam is held only when a rule says the survivor may not be
  // billed; the payment rules then join the proof.
  std::vector<uint16_t> exam = of_kind(K_EXAM_NO_BILL);
  if (!exam.empty()) {
    for (uint16_t r : of_kind(K_EXAM_PAYMENT)) exam.push_back(r);
  }

  std::map<Block, Label> labels;
  std::vector<std::pair<Block, Label>> order;
  std::vector<Label> by_expense(EXP_COUNT);
  for (uint8_t e = 0; e < EXP_COUNT; e++) {
    if (e == EXP_FORENSIC_EXAM) continue;
    Block k = block_for(e);
    auto it = labels.find(k);
    if (it == labels.end()) {
      it = labels.emplace(k, a.label()).first;
      order.emplace_back(k, it->second);
    }
    by_expense[e] = it->second;
  }
  Label oow = a.label(), held = a.label(), as_medical = a.label();
  std::vector<Label> cases = by_expense;
  cases[EXP_FORENSIC_EXAM] = exam.empty() ? as_medical : held;

  // Step 1: outside [incident_date, as_of_date].
  a.u8op(OP_LDI, IF_DATE);
  a.u8op(OP_LDX, CX_INCIDENT_DATE);
  a.op(OP_LT);
  a.jump(OP_JNZ, oow);
  a.u8op(OP_LDI, IF_DATE);
  a.u8op(OP_LDX, CX_AS_OF_DATE);
  a.op(OP_GT);
  a.jump(OP_JNZ, oow);
  a.u8op(OP_LDI, IF_EXPENSE);
  a.sw(cases, by_expense[EXP_UNKNOWN]);

  a.bind(oow);
  a.push(0);
  a.u8u16(OP_DECIDE, ST_OUT_OF_WINDOW, 0);
  a.op(OP_RET);

  if (exam.empty()) {
    // Step 2 fallback: no exam_no_bill rule, so an exam is treated as medical.
    a.bind(as_medical);
    a.u8op(OP_SETEXP, EXP_MEDICAL);
    a.jump(OP_JMP, by_expense[EXP_MEDICAL]);
  } else {
    // Step 2: the survivor should never have been billed for the exam.
    a.bind(held);
    anno(0, a, exam);
    a.push(0);
    a.u8u16(OP_DECIDE, ST_HELD, b_.proof(exam));
    a.op(OP_RET);
  }
  for (const auto& [k, label] : order) emit_block(a, k, label);
}

// SPEC v1.2 typed units: when the item counts the cap's unit and units > 0,
// allowed = min(allowed, cap * units); otherwise the line is flagged
// rate_unverified and keeps its amount. With a count limit, r3 holds the units
// still payable and r4 this item's share of them.
void Compiler::unit_cap(Assembler& a, const IRule& r) {
  Label end = a.label(), head = a.label(), unmeasured = a.label(), keep = a.label(), next = a.label();
  uint16_t k = b_.int_const(*r.cap);
  anno(1, a, {r.index});
  if (r.count_limit) {
    a.push(int32_t(*r.count_limit));  // counts and days fit an immediate; ldk is for money
    a.u8op(OP_STR, 3);
  }
  a.each(r.expense, end);
  a.bind(head);
  a.u8op(OP_LDI, IF_UNIT);
  a.push(r.unit_code);
  a.op(OP_EQ);
  a.jump(OP_JZ, unmeasured);
  a.u8op(OP_LDI, IF_UNITS);
  a.push(0);
  a.op(OP_GT);
  a.jump(OP_JZ, unmeasured);
  if (r.count_limit) {
    a.u8op(OP_LDI, IF_UNITS);
    a.u8op(OP_LDR, 3);
    a.op(OP_MIN);
    a.u8op(OP_STR, 4);
    a.u8op(OP_LDR, 3);
    a.u8op(OP_LDR, 4);
    a.op(OP_SUBS);
    a.u8op(OP_STR, 3);
    a.u16op(OP_LDK, k);
    a.u8op(OP_LDR, 4);
  } else {
    a.u16op(OP_LDK, k);
    a.u8op(OP_LDI, IF_UNITS);
  }
  a.op(OP_MULS);
  a.op(OP_DUP);
  a.op(OP_LDA);
  a.op(OP_LT);
  a.jump(OP_JZ, keep);
  a.u8u16(OP_CAP, TR_UNIT_CAP, r.index);
  a.jump(OP_JMP, next);
  a.bind(keep);
  a.op(OP_POP);
  a.jump(OP_JMP, next);
  a.bind(unmeasured);
  a.u16op(OP_FLAG, r.index);
  a.bind(next);
  a.jump(OP_NEXT, head);
  a.bind(end);
}

// Cumulative walk in processing order: r0 = running allowed, r1 = crossed.
// The crossing item is cut to the remainder; every later item goes to 0.
void Compiler::walk_cap(Assembler& a, const IRule& r, uint8_t selector, uint8_t op) {
  Label end = a.label(), head = a.label(), later = a.label(), fits = a.label(), next = a.label();
  uint16_t k = b_.int_const(*r.cap);
  anno(1, a, {r.index});
  a.push(0);
  a.u8op(OP_STR, 0);
  a.push(0);
  a.u8op(OP_STR, 1);
  a.each(selector, end);
  a.bind(head);
  a.u8op(OP_LDR, 1);
  a.jump(OP_JNZ, later);
  a.u8op(OP_LDR, 0);
  a.op(OP_LDA);
  a.op(OP_ADDS);
  a.u16op(OP_LDK, k);
  a.op(OP_GT);
  a.jump(OP_JZ, fits);
  a.u16op(OP_LDK, k);
  a.u8op(OP_LDR, 0);
  a.op(OP_SUBS);
  a.u8u16(OP_CAP, op, r.index);
  a.push(1);
  a.u8op(OP_STR, 1);
  a.bind(fits);
  a.u8op(OP_LDR, 0);
  a.op(OP_LDA);
  a.op(OP_ADDS);
  a.u8op(OP_STR, 0);
  a.jump(OP_JMP, next);
  a.bind(later);
  a.push(0);
  a.u8u16(OP_CAP, op, r.index);
  a.bind(next);
  a.jump(OP_NEXT, head);
  a.bind(end);
}

// SPEC v1.2 step 9. Each rule is met when the total allowed reaches cap_cents
// or the lost-wage days reach days_lost; otherwise it is waived, may_be_waived,
// or not_met by its waiver (a days-only rule is unknown). The check keeps the
// most severe status. Registers: r0 total allowed, r5 weeks and r6 days of
// eligible lost wages, r1 lost-wage days, r2 the status so far.
void Compiler::minimum_loss(Assembler& a) {
  std::vector<uint16_t> all = of_kind(K_MINIMUM_LOSS);
  anno(1, a, all);
  if (all.empty()) {
    a.push(ML_MET);
    a.u8u16(OP_CHECK, CK_MINIMUM_LOSS, 0);
    return;
  }
  bool any_cap = false, any_days = false;
  for (uint16_t i : all) {
    any_cap = any_cap || rules_[i].cap.has_value();
    any_days = any_days || rules_[i].days_lost.has_value();
  }
  if (any_cap) {
    Label end = a.label(), head = a.label();
    a.push(0);
    a.u8op(OP_STR, 0);
    a.each(kSelectAll, end);
    a.bind(head);
    a.u8op(OP_LDR, 0);
    a.op(OP_LDA);
    a.op(OP_ADDS);
    a.u8op(OP_STR, 0);
    a.jump(OP_NEXT, head);
    a.bind(end);
  }
  if (any_days) {
    Label end = a.label(), head = a.label(), not_week = a.label(), next = a.label();
    a.push(0);
    a.u8op(OP_STR, 5);
    a.push(0);
    a.u8op(OP_STR, 6);
    a.each(EXP_LOST_WAGES, end);
    a.bind(head);
    a.u8op(OP_LDI, IF_UNIT);
    a.push(UNIT_WEEK);
    a.op(OP_EQ);
    a.jump(OP_JZ, not_week);
    a.u8op(OP_LDR, 5);
    a.u8op(OP_LDI, IF_UNITS);
    a.op(OP_ADDS);
    a.u8op(OP_STR, 5);
    a.jump(OP_JMP, next);
    a.bind(not_week);
    a.u8op(OP_LDI, IF_UNIT);
    a.push(UNIT_DAY);
    a.op(OP_EQ);
    a.jump(OP_JZ, next);
    a.u8op(OP_LDR, 6);
    a.u8op(OP_LDI, IF_UNITS);
    a.op(OP_ADDS);
    a.u8op(OP_STR, 6);
    a.bind(next);
    a.jump(OP_NEXT, head);
    a.bind(end);
    // Five working days to a week.
    a.u8op(OP_LDR, 5);
    a.push(5);
    a.op(OP_MULS);
    a.u8op(OP_LDR, 6);
    a.op(OP_ADDS);
    a.u8op(OP_STR, 1);
  }
  a.push(ML_MET);
  a.u8op(OP_STR, 2);
  for (uint16_t i : all) {
    const IRule& r = rules_[i];
    Label met = a.label();
    anno(1, a, {r.index});
    if (r.cap) {
      a.u8op(OP_LDR, 0);
      a.u16op(OP_LDK, b_.int_const(*r.cap));
      a.op(OP_GE);
      a.jump(OP_JNZ, met);
    }
    if (r.days_lost) {
      a.u8op(OP_LDR, 1);
      a.push(int32_t(*r.days_lost));
      a.op(OP_GE);
      a.jump(OP_JNZ, met);
    }
    uint8_t below = ML_UNKNOWN;
    if (r.cap) {
      below = !r.waiver_sa ? ML_NOT_MET : r.waiver_automatic ? ML_WAIVED : r.waiver_discretionary ? ML_MAY_BE_WAIVED : ML_NOT_MET;
    }
    a.push(below);
    a.u8op(OP_LDR, 2);
    a.op(OP_MAX);
    a.u8op(OP_STR, 2);
    a.bind(met);
  }
  a.u8op(OP_LDR, 2);
  a.u8u16(OP_CHECK, CK_MINIMUM_LOSS, b_.proof(all));
}

void Compiler::deadline(Assembler& a) {
  std::vector<uint16_t> all = of_kind(K_DEADLINE);
  if (all.empty()) {
    a.push(DL_UNKNOWN);
    a.u8u16(OP_CHECK, CK_DEADLINE, 0);
    return;
  }
  bool from_report = false;
  for (size_t i = 0; i < all.size(); i++) {
    const IRule& r = rules_[all[i]];
    anno(1, a, {r.index});
    from_report = from_report || r.anchor == FROM_REPORT;
    a.u8op(OP_LDX, CX_INCIDENT_DATE);
    a.push(int32_t(r.days));
    a.op(OP_ADDS);
    if (i) a.op(OP_MAX);  // the longest deadline wins
  }
  Label late = a.label(), done = a.label();
  a.op(OP_DUP);
  a.op(OP_SETDATE);
  a.u8op(OP_LDX, CX_AS_OF_DATE);
  a.op(OP_GE);
  a.jump(OP_JZ, late);
  a.push(DL_OK);
  a.jump(OP_JMP, done);
  a.bind(late);
  a.push(DL_LATE);
  a.bind(done);
  // A deadline counted from the police report is dated from the incident (the
  // earliest the report can be), so the survivor may have longer.
  if (from_report) a.u8op(OP_NOTE, CN_DEADLINE_FROM_REPORT);
  a.u8u16(OP_CHECK, CK_DEADLINE, b_.proof(all));
}

void Compiler::reporting(Assembler& a) {
  std::vector<uint16_t> all = of_kind(K_REPORTING);
  bool alt_exam = false, required = false;
  for (uint16_t i : all) {
    alt_exam = alt_exam || rules_[i].alt_exam;
    required = required || rules_[i].required;
  }
  Label sat = a.label(), req = a.label(), done = a.label();
  anno(1, a, all);
  a.u8op(OP_LDX, CX_POLICE_REPORT);
  a.push(PR_YES);
  a.op(OP_EQ);
  a.jump(OP_JNZ, sat);
  if (alt_exam) {
    a.u8op(OP_LDX, CX_FORENSIC_EXAM);
    a.jump(OP_JNZ, sat);
  }
  if (required) {
    // Required only when the survivor said no; "unknown" stays unknown.
    a.u8op(OP_LDX, CX_POLICE_REPORT);
    a.push(PR_NO);
    a.op(OP_EQ);
    a.jump(OP_JNZ, req);
    a.push(RP_UNKNOWN);
    a.jump(OP_JMP, done);
    a.bind(req);
    a.push(RP_REQUIRED);
  } else {
    a.push(RP_NOT_REQUIRED);
  }
  a.jump(OP_JMP, done);
  a.bind(sat);
  a.push(RP_SATISFIED);
  a.bind(done);
  a.u8u16(OP_CHECK, CK_REPORTING, b_.proof(all));
}

// Aggregate program: SPEC steps 7-12.
void Compiler::aggregate_program(Assembler& a) {
  // Step 7a: per-unit caps, in rule order.
  for (size_t i = 0; i < ir_count_; i++) {
    if (rules_[i].kind == K_EXPENSE_CAP && rules_[i].per == PER_UNIT) unit_cap(a, rules_[i]);
  }
  // Step 7b: per-claim caps, in rule order.
  for (size_t i = 0; i < ir_count_; i++) {
    if (rules_[i].kind == K_EXPENSE_CAP && rules_[i].per == PER_CLAIM)
      walk_cap(a, rules_[i], rules_[i].expense, TR_EXPENSE_CAP);
  }
  // Step 8: the smallest total cap (the first one on ties).
  const IRule* total = nullptr;
  for (size_t i = 0; i < ir_count_; i++) {
    const IRule& r = rules_[i];
    if (r.kind == K_TOTAL_CAP && (!total || *r.cap < *total->cap)) total = &r;
  }
  if (total) walk_cap(a, *total, kSelectAll, TR_TOTAL_CAP);
  minimum_loss(a);  // step 9
  deadline(a);      // step 10
  reporting(a);     // step 11
  // Step 12: rules listed for display only. Exam payment rules are listed
  // here when no exam_no_bill rule puts them in a hold's proof.
  bool holds = !of_kind(K_EXAM_NO_BILL).empty();
  std::vector<uint16_t> info;
  for (size_t i = 0; i < ir_count_; i++) {
    uint8_t k = rules_[i].kind;
    if (k == K_INFO || k == K_COLLATERAL || (k == K_EXAM_PAYMENT && !holds)) info.push_back(rules_[i].index);
  }
  anno(1, a, info);
  a.u16op(OP_INFO, b_.proof(info));
  a.op(OP_RET);
}

bool Compiler::run(const std::string& ir_bytes, const std::string& verified_bytes, CompileResult& out,
                   std::string& err) {
  try {
    json ir;
    try {
      ir = json::parse(ir_bytes);
    } catch (const json::exception& e) {
      fail(std::string("IR: invalid JSON: ") + e.what());
    }
    uint8_t declared[32] = {};
    std::string declared_hex = ir.is_object() ? str_field(ir, "source_sha256") : std::string();
    if (!declared_hex.empty() && (declared_hex.size() != 64 || !from_hex(declared_hex.data(), 64, declared)))
      fail("IR: source_sha256 must be 64 hex characters");
    if (!verified_bytes.empty()) {
      uint8_t actual[32];
      sha256(verified_bytes.data(), verified_bytes.size(), actual);
      if (!declared_hex.empty() && std::memcmp(actual, declared, 32) != 0)
        fail("stale IR: source_sha256 does not match the verified file (rerun rules/tools/normalize.py)");
      json doc;
      try {
        doc = json::parse(verified_bytes);
      } catch (const json::exception& e) {
        fail(std::string("verified file: invalid JSON: ") + e.what());
      }
      if (ir.is_object() && str_field(doc, "jurisdiction") != str_field(ir, "jurisdiction"))
        fail("the IR and the verified file are for different jurisdictions");
      have_verified_ = true;
      load_verified(doc);
      b_.set_source_sha256(actual);
    } else {
      b_.set_source_sha256(declared);
      note("no verified file: the image carries no quotes or pinpoints");
    }
    parse(ir);
    uint8_t ir_sha[32];
    sha256(ir_bytes.data(), ir_bytes.size(), ir_sha);
    b_.meta("ir_sha256", to_hex(ir_sha, 32));
    Assembler item, aggr;
    item_program(item);
    aggregate_program(aggr);
    std::vector<uint8_t> item_code, aggr_code;
    std::string asm_err;
    if (!item.finish(item_code, asm_err) || !aggr.finish(aggr_code, asm_err)) fail("internal: " + asm_err);
    if (b_.proof_count() > 65535 || b_.int_count() > 65535) fail("law too large");
    out.image = b_.build(item_code, aggr_code);
    out.notes = notes_;
    return true;
  } catch (const CompileError&) {
    err = err_;
    return false;
  } catch (const std::exception& e) {
    err = std::string("internal: ") + e.what();
    return false;
  }
}

}  // namespace

bool compile_law(const std::string& ir_bytes, const std::string& verified_bytes, CompileResult& out,
                 std::string& err) {
  Compiler c;
  return c.run(ir_bytes, verified_bytes, out, err);
}

}  // namespace tend

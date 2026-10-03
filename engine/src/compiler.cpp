#include "compiler.h"

#include <map>
#include <optional>
#include <set>

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
constexpr int64_t kMaxYears = 1000;
constexpr int64_t kMaxDays = 1000000;

struct CRule {
  uint16_t index = 0;
  std::string id;
  uint8_t category = 0;
  uint8_t expense = kNoExpense;
  uint8_t per = PER_NONE;
  std::string per_text;
  std::optional<int64_t> amount, years, days;
  bool required = true;
  bool alt_exam = false;   // alternatives include forensic_exam
  bool alt_other = false;  // alternatives include anything the engine cannot check
  bool waivable = false;   // waived_for contains "sexual_assault"
  std::string pinpoint, quote, summary, fragment, source_id;
};

class CompileError {};

class Compiler {
 public:
  bool run(const std::string& bytes, CompileResult& out, std::string& err);

 private:
  [[noreturn]] void fail(const std::string& msg) {
    err_ = msg;
    throw CompileError();
  }
  void warn(const std::string& msg) { warnings_.push_back(msg); }

  void parse(const json& doc);
  CRule parse_rule(const json& r, size_t index, const std::set<std::string>& source_ids);
  std::optional<int64_t> int_param(const json& params, const char* key, int64_t max, const std::string& where);

  std::vector<uint16_t> ids_where(bool (*pred)(const CRule&, uint8_t), uint8_t arg = 0) const;
  uint16_t proof_of(const std::vector<uint16_t>& rules) { return b_.proof(rules); }
  void anno(uint8_t program, const Assembler& a, const std::vector<uint16_t>& rules) {
    for (uint16_t r : rules) b_.anno(program, a.pc(), r);
  }

  void item_program(Assembler& a);
  void aggregate_program(Assembler& a);
  void unit_cap(Assembler& a, const CRule& r);
  void other_cap(Assembler& a, const CRule& r);
  void walk_cap(Assembler& a, const CRule& r, uint8_t selector, uint8_t op);
  void minimum_loss(Assembler& a);
  void deadline(Assembler& a);
  void reporting(Assembler& a);

  std::string err_;
  std::vector<std::string> warnings_;
  std::vector<CRule> rules_;
  ImageBuilder b_;
};

bool is_cat(const CRule& r, uint8_t c) { return r.category == c; }

std::vector<uint16_t> Compiler::ids_where(bool (*pred)(const CRule&, uint8_t), uint8_t arg) const {
  std::vector<uint16_t> out;
  for (const CRule& r : rules_) {
    if (pred(r, arg)) out.push_back(r.index);
  }
  return out;
}

std::optional<int64_t> Compiler::int_param(const json& params, const char* key, int64_t max,
                                           const std::string& where) {
  auto it = params.find(key);
  if (it == params.end() || it->is_null()) return std::nullopt;
  if (!it->is_number_integer() || (it->is_number_unsigned() && it->get<uint64_t>() > uint64_t(INT64_MAX)))
    fail(where + ": params." + key + " must be an integer");
  int64_t v = it->get<int64_t>();
  if (v < 0 || v > max) fail(where + ": params." + key + " is out of range");
  return v;
}

std::string opt_string(const json& obj, const char* key) {
  auto it = obj.find(key);
  return it != obj.end() && it->is_string() ? it->get<std::string>() : std::string();
}

CRule Compiler::parse_rule(const json& r, size_t index, const std::set<std::string>& source_ids) {
  std::string where = "rules[" + std::to_string(index) + "]";
  if (!r.is_object()) fail(where + " is not an object");
  CRule c;
  c.index = uint16_t(index);
  c.id = opt_string(r, "id");
  if (c.id.empty()) fail(where + ": missing id");
  where = c.id;
  std::string cat = opt_string(r, "category");
  if (!parse_category(cat, c.category)) fail(where + ": unknown category '" + cat + "'");
  json params = json::object();
  if (auto it = r.find("params"); it != r.end() && !it->is_null()) {
    if (!it->is_object()) fail(where + ": params must be an object");
    params = *it;
  }
  std::string exp = opt_string(r, "expense");
  if (exp.empty()) exp = opt_string(params, "expense");
  if (!exp.empty()) {
    if (!parse_expense(exp, c.expense) || c.expense >= kRuleExpenseCount)
      fail(where + ": unknown expense '" + exp + "'");
  }
  c.pinpoint = opt_string(r, "pinpoint");
  c.quote = opt_string(r, "quote");
  c.summary = opt_string(r, "summary");
  c.fragment = opt_string(r, "fragment_url");
  c.source_id = opt_string(r, "source_id");
  if (c.pinpoint.empty()) fail(where + ": missing pinpoint");
  if (c.quote.empty()) fail(where + ": missing quote");
  if (!c.source_id.empty() && !source_ids.count(c.source_id))
    fail(where + ": source " + c.source_id + " is not listed in sources");

  switch (c.category) {
    case CAT_TOTAL_CAP:
      c.amount = int_param(params, "amount_cents", kMaxCents, where);
      if (!c.amount) warn(where + ": total_cap without amount_cents is listed only");
      break;
    case CAT_EXPENSE_CAP: {
      c.amount = int_param(params, "amount_cents", kMaxCents, where);
      auto per = params.find("per");
      if (per == params.end() || per->is_null()) {
        c.per = PER_CLAIM;
        warn(where + ": expense_cap without per is treated as per claim");
      } else {
        if (!per->is_string() || !parse_per(per->get<std::string>(), c.per))
          fail(where + ": params.per must be a non-empty string");
        if (c.per == PER_OTHER) c.per_text = per->get<std::string>();
      }
      if (c.expense == kNoExpense) warn(where + ": expense_cap names no expense and is listed only");
      else if (!c.amount) warn(where + ": expense_cap without amount_cents counts as coverage only");
      else if (c.per == PER_OTHER)
        warn(where + ": per " + c.per_text + " cannot be computed; matching items get rate_unverified");
      if (params.contains("applies_to")) warn(where + ": applies_to is ignored; the cap applies to every item");
      break;
    }
    case CAT_COVERED_EXPENSE:
    case CAT_EXCLUDED_EXPENSE:
      if (c.expense == kNoExpense) warn(where + ": names no expense type and is listed only");
      break;
    case CAT_FILING_DEADLINE:
      c.years = int_param(params, "years", kMaxYears, where);
      c.days = int_param(params, "days", kMaxDays, where);
      if (!c.years && !c.days) warn(where + ": filing_deadline without years or days is listed only");
      break;
    case CAT_MINIMUM_LOSS: {
      c.amount = int_param(params, "amount_cents", kMaxCents, where);
      auto w = params.find("waived_for");
      if (w != params.end()) {
        if (w->is_string()) {
          c.waivable = w->get<std::string>().find("sexual_assault") != std::string::npos;
        } else if (w->is_array()) {
          for (const json& x : *w) c.waivable = c.waivable || (x.is_string() && x.get<std::string>() == "sexual_assault");
        } else if (!w->is_null()) {
          fail(where + ": params.waived_for must be a string or a list");
        }
      }
      break;
    }
    case CAT_REPORTING_REQUIREMENT: {
      auto req = params.find("required");
      if (req != params.end() && !req->is_null()) {
        if (!req->is_boolean()) fail(where + ": params.required must be true or false");
        c.required = req->get<bool>();
      }
      auto alt = params.find("alternatives");
      if (alt != params.end()) {
        if (alt->is_string()) {
          std::string s = alt->get<std::string>();
          c.alt_exam = s.find("forensic_exam") != std::string::npos;
          c.alt_other = !s.empty() && s != "forensic_exam";
        } else if (alt->is_array()) {
          for (const json& x : *alt) {
            bool exam = x.is_string() && x.get<std::string>() == "forensic_exam";
            c.alt_exam = c.alt_exam || exam;
            c.alt_other = c.alt_other || !exam;
          }
        } else if (!alt->is_null()) {
          fail(where + ": params.alternatives must be a list");
        }
      }
      break;
    }
    default: break;
  }
  return c;
}

void Compiler::parse(const json& doc) {
  if (!doc.is_object()) fail("top level is not an object");
  std::string j = opt_string(doc, "jurisdiction");
  if (j.empty() || j.size() > 8) fail("jurisdiction must be a 1 to 8 character code");
  for (char ch : j) {
    if (!((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))) fail("jurisdiction must be uppercase letters or digits");
  }
  b_.set_jurisdiction(j);

  std::set<std::string> source_ids;
  std::map<std::string, uint32_t> source_index;
  if (auto s = doc.find("sources"); s != doc.end() && !s->is_null()) {
    if (!s->is_array()) fail("sources must be a list");
    for (const json& src : *s) {
      if (!src.is_object()) fail("sources contains a non-object");
      std::string id = opt_string(src, "id");
      if (id.empty()) fail("a source has no id");
      if (!source_ids.insert(id).second) fail("duplicate source id " + id);
      SourceRecord rec;
      rec.id = b_.str(id);
      rec.url = b_.opt_str(opt_string(src, "url"));
      rec.title = b_.opt_str(opt_string(src, "title"));
      std::string sha = opt_string(src, "sha256");
      if (sha.size() != 64 || !from_hex(sha.data(), sha.size(), rec.sha256)) {
        if (!sha.empty()) fail("source " + id + ": sha256 must be 64 hex characters");
        warn("source " + id + " has no sha256");
      }
      source_index[id] = b_.source(rec);
    }
  }

  auto rs = doc.find("rules");
  if (rs == doc.end() || !rs->is_array()) fail("rules must be a list");
  if (rs->size() > 65535) fail("too many rules");
  std::set<std::string> ids;
  for (size_t i = 0; i < rs->size(); i++) {
    CRule c = parse_rule((*rs)[i], i, source_ids);
    if (!ids.insert(c.id).second) fail("duplicate rule id " + c.id);
    RuleRecord rec;
    rec.category = c.category;
    rec.expense = c.expense;
    rec.per = c.per;
    rec.id = b_.str(c.id);
    rec.pinpoint = b_.str(c.pinpoint);
    rec.quote = b_.str(c.quote);
    rec.summary = b_.opt_str(c.summary);
    rec.fragment = b_.opt_str(c.fragment);
    rec.source = c.source_id.empty() ? kNone : source_index[c.source_id];
    rec.per_text = b_.opt_str(c.per_text);
    b_.rule(rec);
    rules_.push_back(std::move(c));
  }

  std::string name = opt_string(doc, "name");
  if (!name.empty()) b_.meta("name", name);
  b_.meta("compiler", TENDC_ID);
}

// Per-item program: SPEC steps 1-6. One switch on the item's expense picks a
// straight-line block whose outcome is fixed by this jurisdiction's rules.
void Compiler::item_program(Assembler& a) {
  auto cat = [&](uint8_t c) { return ids_where(is_cat, c); };
  std::vector<uint16_t> exam = cat(CAT_EXAM_NO_BILL);
  for (uint16_t r : cat(CAT_EXAM_PAYMENT)) exam.push_back(r);
  std::vector<uint16_t> collateral = cat(CAT_COLLATERAL_SOURCE);

  std::vector<std::vector<uint16_t>> excl(kRuleExpenseCount), cov(kRuleExpenseCount);
  for (const CRule& r : rules_) {
    if (r.expense == kNoExpense) continue;
    if (r.category == CAT_EXCLUDED_EXPENSE) excl[r.expense].push_back(r.index);
    if (r.category == CAT_COVERED_EXPENSE || r.category == CAT_EXPENSE_CAP) cov[r.expense].push_back(r.index);
  }

  Label oow = a.label(), unknown = a.label(), held = a.label(), as_medical = a.label();
  std::vector<Label> block(kRuleExpenseCount);
  for (uint8_t e = 0; e < kRuleExpenseCount; e++) block[e] = (excl[e].empty() && cov[e].empty()) ? unknown : a.label();
  std::vector<Label> cases(EXP_COUNT, unknown);
  for (uint8_t e = 0; e < kRuleExpenseCount; e++) cases[e] = block[e];
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
  a.sw(cases, unknown);

  a.bind(oow);
  a.push(0);
  a.u8u16(OP_DECIDE, ST_OUT_OF_WINDOW, 0);
  a.op(OP_RET);

  // Step 2 fallback: no exam rules, so an exam is treated as medical.
  if (exam.empty()) {
    a.bind(as_medical);
    a.u8op(OP_SETEXP, EXP_MEDICAL);
    a.jump(OP_JMP, block[EXP_MEDICAL]);
  }

  // Step 4: no rule names this expense.
  a.bind(unknown);
  a.push(0);
  a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
  a.op(OP_RET);

  // Step 2: the survivor should never have been billed for the exam.
  if (!exam.empty()) {
    a.bind(held);
    anno(0, a, exam);
    a.push(0);
    a.u8u16(OP_DECIDE, ST_HELD, proof_of(exam));
    a.op(OP_RET);
  }

  for (uint8_t e = 0; e < kRuleExpenseCount; e++) {
    if (e == EXP_FORENSIC_EXAM) continue;  // always held or treated as medical
    if (!excl[e].empty()) {
      // Step 3.
      a.bind(block[e]);
      anno(0, a, excl[e]);
      a.push(0);
      a.u8u16(OP_DECIDE, ST_EXCLUDED, proof_of(excl[e]));
      a.op(OP_RET);
    } else if (!cov[e].empty()) {
      // Steps 5 and 6.
      std::vector<uint16_t> with_collateral = cov[e];
      with_collateral.insert(with_collateral.end(), collateral.begin(), collateral.end());
      Label confirmed = a.label();
      a.bind(block[e]);
      anno(0, a, with_collateral);
      a.u8op(OP_LDI, IF_CONFIRMED);
      a.jump(OP_JNZ, confirmed);
      a.push(0);
      a.u8u16(OP_DECIDE, ST_NEEDS_CONFIRMATION, proof_of(cov[e]));
      a.op(OP_RET);
      a.bind(confirmed);
      a.u8op(OP_LDI, IF_AMOUNT);
      a.u8u16(OP_DECIDE, ST_ELIGIBLE, proof_of(with_collateral));
      if (!collateral.empty()) {
        a.op(OP_LDA);
        a.u8op(OP_LDI, IF_INSURANCE_PAID);
        a.op(OP_SUBS);
        a.push(0);
        a.op(OP_MAX);
        a.u8u16(OP_SETA, TR_COLLATERAL, collateral[0]);
      }
      a.op(OP_RET);
    }
  }
}

bool is_unit_per(uint8_t per) { return per >= PER_WEEK && per <= PER_DAY; }

// allowed = min(allowed, cap * units) when units > 0, else flag rate_unverified.
void Compiler::unit_cap(Assembler& a, const CRule& r) {
  Label end = a.label(), head = a.label(), no_units = a.label(), keep = a.label(), next = a.label();
  anno(1, a, {r.index});
  a.each(r.expense, end);
  a.bind(head);
  a.u8op(OP_LDI, IF_UNITS);
  a.jump(OP_JZ, no_units);
  a.u16op(OP_LDK, b_.int_const(*r.amount));
  a.u8op(OP_LDI, IF_UNITS);
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
  a.bind(no_units);
  a.u16op(OP_FLAG, r.index);
  a.bind(next);
  a.jump(OP_NEXT, head);
  a.bind(end);
}

// A cap per residence, crime scene, month, item, ...: the engine has no unit to
// measure it with, so every eligible item of the expense is flagged.
void Compiler::other_cap(Assembler& a, const CRule& r) {
  Label end = a.label(), head = a.label();
  anno(1, a, {r.index});
  a.each(r.expense, end);
  a.bind(head);
  a.u16op(OP_FLAG, r.index);
  a.jump(OP_NEXT, head);
  a.bind(end);
}

// Cumulative walk in processing order: r0 = running allowed, r1 = crossed.
// The crossing item is cut to the remainder; every later item goes to 0.
void Compiler::walk_cap(Assembler& a, const CRule& r, uint8_t selector, uint8_t op) {
  Label end = a.label(), head = a.label(), later = a.label(), fits = a.label(), next = a.label();
  uint16_t k = b_.int_const(*r.amount);
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

void Compiler::minimum_loss(Assembler& a) {
  std::vector<uint16_t> all = ids_where(is_cat, CAT_MINIMUM_LOSS);
  if (all.empty()) {
    a.push(ML_MET);
    a.u8u16(OP_CHECK, CK_MINIMUM_LOSS, 0);
    return;
  }
  std::vector<const CRule*> with_amount;
  for (uint16_t i : all) {
    if (rules_[i].amount) with_amount.push_back(&rules_[i]);
  }
  if (with_amount.empty()) {
    anno(1, a, all);
    a.push(ML_UNKNOWN);
    a.u8u16(OP_CHECK, CK_MINIMUM_LOSS, proof_of(all));
    return;
  }
  // r0 = total allowed after caps; r2 = worst status so far (met < waived < not_met).
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
  a.push(ML_MET);
  a.u8op(OP_STR, 2);
  for (uint16_t i : all) {
    const CRule& r = rules_[i];
    if (!r.amount) {
      anno(1, a, {r.index});
      continue;
    }
    Label skip = a.label(), combine = a.label();
    anno(1, a, {r.index});
    a.u8op(OP_LDR, 0);
    a.u16op(OP_LDK, b_.int_const(*r.amount));
    a.op(OP_LT);
    a.jump(OP_JZ, skip);
    if (r.waivable) {
      Label not_met = a.label();
      a.u8op(OP_LDX, CX_FORENSIC_EXAM);
      a.jump(OP_JZ, not_met);
      a.push(ML_WAIVED);
      a.jump(OP_JMP, combine);
      a.bind(not_met);
    }
    a.push(ML_NOT_MET);
    a.bind(combine);
    a.u8op(OP_LDR, 2);
    a.op(OP_MAX);
    a.u8op(OP_STR, 2);
    a.bind(skip);
  }
  a.u8op(OP_LDR, 2);
  a.u8u16(OP_CHECK, CK_MINIMUM_LOSS, proof_of(all));
}

void Compiler::deadline(Assembler& a) {
  std::vector<uint16_t> all = ids_where(is_cat, CAT_FILING_DEADLINE);
  bool any_date = false;
  for (uint16_t i : all) {
    const CRule& r = rules_[i];
    if (!r.years && !r.days) {
      anno(1, a, {r.index});
      continue;
    }
    anno(1, a, {r.index});
    a.u8op(OP_LDX, CX_INCIDENT_DATE);
    if (r.years) {
      a.push(int32_t(*r.years));
      a.op(OP_ADDY);
    } else {
      a.push(int32_t(*r.days));
      a.op(OP_ADDS);
    }
    if (any_date) a.op(OP_MAX);  // the longest deadline wins
    any_date = true;
  }
  uint16_t proof = proof_of(all);
  if (!any_date) {
    a.push(DL_UNKNOWN);
    a.u8u16(OP_CHECK, CK_DEADLINE, proof);
    return;
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
  a.u8u16(OP_CHECK, CK_DEADLINE, proof);
}

void Compiler::reporting(Assembler& a) {
  std::vector<uint16_t> all = ids_where(is_cat, CAT_REPORTING_REQUIREMENT);
  if (all.empty()) {
    a.push(RP_SATISFIED);
    a.u8u16(OP_CHECK, CK_REPORTING, 0);
    return;
  }
  bool alt_exam = false, alt_other = false, required = false;
  for (uint16_t i : all) {
    alt_exam = alt_exam || rules_[i].alt_exam;
    alt_other = alt_other || rules_[i].alt_other;
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
  // "required" only when the law demands a report and lists no alternative
  // the engine cannot check (protective order, advocate, ...).
  bool can_require = required && !alt_other;
  if (can_require) {
    a.u8op(OP_LDX, CX_POLICE_REPORT);
    a.push(PR_NO);
    a.op(OP_EQ);
    a.jump(OP_JNZ, req);
  }
  a.push(RP_UNKNOWN);
  a.jump(OP_JMP, done);
  if (can_require) {
    a.bind(req);
    a.push(RP_REQUIRED);
    a.jump(OP_JMP, done);
  }
  a.bind(sat);
  a.push(RP_SATISFIED);
  a.bind(done);
  a.u8u16(OP_CHECK, CK_REPORTING, proof_of(all));
}

// Aggregate program: SPEC steps 7-12.
void Compiler::aggregate_program(Assembler& a) {
  // Step 7a: per-unit caps (and caps per something the engine cannot measure).
  for (const CRule& r : rules_) {
    if (r.category != CAT_EXPENSE_CAP || r.expense == kNoExpense || !r.amount) continue;
    if (is_unit_per(r.per)) unit_cap(a, r);
    else if (r.per == PER_OTHER) other_cap(a, r);
  }
  // Step 7b: per-claim caps, in rule order.
  for (const CRule& r : rules_) {
    if (r.category != CAT_EXPENSE_CAP || r.expense == kNoExpense || !r.amount) continue;
    if (r.per == PER_CLAIM) walk_cap(a, r, r.expense, TR_EXPENSE_CAP);
  }
  // Step 8: the smallest total cap (first in rule order on ties).
  const CRule* total = nullptr;
  for (const CRule& r : rules_) {
    if (r.category == CAT_TOTAL_CAP && r.amount && (!total || *r.amount < *total->amount)) total = &r;
  }
  if (total) walk_cap(a, *total, kSelectAll, TR_TOTAL_CAP);
  minimum_loss(a);  // step 9
  deadline(a);      // step 10
  reporting(a);     // step 11
  // Step 12: rules listed for display only.
  std::vector<uint16_t> info;
  for (const CRule& r : rules_) {
    switch (r.category) {
      case CAT_COLLATERAL_SOURCE:
      case CAT_CONDUCT_REDUCTION:
      case CAT_EMERGENCY_AWARD:
      case CAT_ELIGIBLE_CRIME:
      case CAT_RESIDENCY: info.push_back(r.index); break;
      default: break;
    }
  }
  anno(1, a, info);
  a.u16op(OP_INFO, proof_of(info));
  a.op(OP_RET);
}

bool Compiler::run(const std::string& bytes, CompileResult& out, std::string& err) {
  try {
    json doc;
    try {
      doc = json::parse(bytes);
    } catch (const json::exception& e) {
      fail(std::string("invalid JSON: ") + e.what());
    }
    uint8_t sha[32];
    sha256(bytes.data(), bytes.size(), sha);
    b_.set_source_sha256(sha);
    parse(doc);
    Assembler item, aggr;
    item_program(item);
    aggregate_program(aggr);
    std::vector<uint8_t> item_code, aggr_code;
    std::string asm_err;
    if (!item.finish(item_code, asm_err) || !aggr.finish(aggr_code, asm_err)) fail("internal: " + asm_err);
    if (b_.proof_count() > 65535 || b_.int_count() > 65535) fail("law too large");
    out.image = b_.build(item_code, aggr_code);
    out.warnings = warnings_;
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

bool compile_law(const std::string& json_bytes, CompileResult& out, std::string& err) {
  Compiler c;
  return c.run(json_bytes, out, err);
}

}  // namespace tend

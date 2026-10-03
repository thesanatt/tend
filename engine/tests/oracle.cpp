#include "oracle.h"

#include <algorithm>
#include <chrono>
#include <climits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace oracle {
namespace {

using json = nlohmann::json;
namespace chr = std::chrono;

const std::set<std::string> kRuleExpenses = {
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation",
    "temporary_housing", "security", "crime_scene_cleanup", "childcare", "property_replacement",
    "clothing_bedding", "prescription", "dental", "funeral", "legal", "tuition", "other"};
const std::set<std::string> kUnitPers = {"week", "session", "hour", "mile", "day"};

int64_t sadd(int64_t a, int64_t b) {
  __int128 r = __int128(a) + b;
  return r > INT64_MAX ? INT64_MAX : r < INT64_MIN ? INT64_MIN : int64_t(r);
}
int64_t ssub(int64_t a, int64_t b) {
  __int128 r = __int128(a) - b;
  return r > INT64_MAX ? INT64_MAX : r < INT64_MIN ? INT64_MIN : int64_t(r);
}
int64_t smul(int64_t a, int64_t b) {
  __int128 r = __int128(a) * b;
  return r > INT64_MAX ? INT64_MAX : r < INT64_MIN ? INT64_MIN : int64_t(r);
}

int64_t day_of(const std::string& s) {
  int y = std::stoi(s.substr(0, 4));
  unsigned m = unsigned(std::stoi(s.substr(5, 2))), d = unsigned(std::stoi(s.substr(8, 2)));
  chr::year_month_day ymd{chr::year(y), chr::month(m), chr::day(d)};
  return chr::sys_days(ymd).time_since_epoch().count();
}

std::string date_str(int64_t n) {
  chr::year_month_day ymd{chr::sys_days(chr::days(n))};
  char buf[16];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02u", int(ymd.year()), unsigned(ymd.month()), unsigned(ymd.day()));
  return buf;
}

int64_t plus_years(int64_t n, int64_t years) {
  chr::year_month_day ymd{chr::sys_days(chr::days(n))};
  chr::year_month_day out{ymd.year() + chr::years(years), ymd.month(), ymd.day()};
  if (!out.ok()) out = chr::year_month_day{chr::year_month_day_last{out.year(), chr::month_day_last{out.month()}}};
  return chr::sys_days(out).time_since_epoch().count();
}

struct Rule {
  std::string id, category, expense;
  json params;
  std::optional<int64_t> num(const char* k) const {
    auto it = params.find(k);
    if (it == params.end() || !it->is_number_integer()) return std::nullopt;
    return it->get<int64_t>();
  }
  std::string per() const {
    auto it = params.find("per");
    return it == params.end() || it->is_null() ? "claim" : it->get<std::string>();
  }
};

struct Line {
  std::string id, expense, status = "unknown_rule";
  int64_t date = 0, amount = 0, insurance = 0, units = 0, allowed = 0;
  bool confirmed = false;
  std::vector<std::string> rule_ids, flags;
  std::optional<std::string> cap;
};

bool contains(const json& v, const std::string& needle, bool substring_for_strings) {
  if (v.is_array()) {
    for (const auto& x : v) {
      if (x.is_string() && x.get<std::string>() == needle) return true;
    }
    return false;
  }
  if (v.is_string()) {
    std::string s = v.get<std::string>();
    return substring_for_strings ? s.find(needle) != std::string::npos : s == needle;
  }
  return false;
}

}  // namespace

json evaluate(const json& law, const json& input) {
  std::vector<Rule> rules;
  for (const auto& r : law["rules"]) {
    Rule x;
    x.id = r["id"];
    x.category = r["category"];
    x.params = r.contains("params") && r["params"].is_object() ? r["params"] : json::object();
    if (r.contains("expense") && r["expense"].is_string() && !r["expense"].get<std::string>().empty())
      x.expense = r["expense"];
    else if (x.params.contains("expense") && x.params["expense"].is_string())
      x.expense = x.params["expense"];
    rules.push_back(x);
  }
  auto ids_of = [&](auto pred) {
    std::vector<std::string> out;
    for (const auto& r : rules) {
      if (pred(r)) out.push_back(r.id);
    }
    return out;
  };

  const json& ctx = input["context"];
  int64_t incident = day_of(ctx["incident_date"]), as_of = day_of(ctx["as_of_date"]);
  std::string police = ctx.contains("police_report") && ctx["police_report"].is_string() ? ctx["police_report"].get<std::string>() : "unknown";
  bool exam_ctx = ctx.contains("forensic_exam") && ctx["forensic_exam"].is_boolean() && ctx["forensic_exam"].get<bool>();

  std::vector<Line> lines;
  if (input.contains("items") && input["items"].is_array()) {
    for (const auto& it : input["items"]) {
      Line l;
      l.id = it["item_id"];
      l.date = day_of(it["date"]);
      l.amount = it["amount_cents"];
      std::string e = it.contains("expense") && it["expense"].is_string() ? it["expense"].get<std::string>() : "unknown";
      l.expense = kRuleExpenses.count(e) ? e : "unknown";
      l.confirmed = it.contains("confirmed") && it["confirmed"].is_boolean() && it["confirmed"].get<bool>();
      l.insurance = it.contains("insurance_paid_cents") && it["insurance_paid_cents"].is_number_integer() ? it["insurance_paid_cents"].get<int64_t>() : 0;
      l.units = it.contains("units") && it["units"].is_number_integer() ? it["units"].get<int64_t>() : 0;
      lines.push_back(l);
    }
  }
  std::stable_sort(lines.begin(), lines.end(), [](const Line& a, const Line& b) {
    return a.date != b.date ? a.date < b.date : a.id < b.id;
  });

  json trace = json::array();
  auto tr = [&](const std::string& op, const json& item, const json& rule, int64_t delta) {
    trace.push_back({{"op", op}, {"item_id", item}, {"rule_id", rule}, {"delta_cents", delta}});
  };
  auto first = [](const std::vector<std::string>& v) -> json { return v.empty() ? json(nullptr) : json(v[0]); };

  std::vector<std::string> exam = ids_of([](const Rule& r) { return r.category == "exam_no_bill"; });
  for (auto& id : ids_of([](const Rule& r) { return r.category == "exam_payment"; })) exam.push_back(id);
  std::vector<std::string> collateral = ids_of([](const Rule& r) { return r.category == "collateral_source"; });

  // Steps 1-6.
  for (Line& l : lines) {
    if (l.date < incident || l.date > as_of) {
      l.status = "out_of_window";
      tr(l.status, l.id, nullptr, 0);
      continue;
    }
    if (l.expense == "forensic_exam") {
      if (!exam.empty()) {
        l.status = "held";
        l.rule_ids = exam;
        tr(l.status, l.id, first(exam), 0);
        continue;
      }
      l.expense = "medical";
    }
    const std::string e = l.expense;
    auto excl = ids_of([&](const Rule& r) { return r.category == "excluded_expense" && r.expense == e; });
    if (!excl.empty()) {
      l.status = "excluded";
      l.rule_ids = excl;
      tr(l.status, l.id, first(excl), 0);
      continue;
    }
    auto cov = ids_of([&](const Rule& r) {
      return (r.category == "covered_expense" || r.category == "expense_cap") && r.expense == e && e != "unknown";
    });
    if (cov.empty()) {
      l.status = "unknown_rule";
      tr(l.status, l.id, nullptr, 0);
      continue;
    }
    if (!l.confirmed) {
      l.status = "needs_confirmation";
      l.rule_ids = cov;
      tr(l.status, l.id, first(cov), 0);
      continue;
    }
    l.status = "eligible";
    l.rule_ids = cov;
    l.allowed = l.amount;
    tr(l.status, l.id, first(cov), l.amount);
    if (!collateral.empty()) {
      for (auto& c : collateral) l.rule_ids.push_back(c);
      int64_t v = std::max<int64_t>(0, ssub(l.allowed, l.insurance));
      if (v != l.allowed) tr("collateral", l.id, collateral[0], ssub(v, l.allowed));
      l.allowed = v;
    }
  }

  auto eligible = [&](const std::string& e) {
    std::vector<Line*> out;
    for (Line& l : lines) {
      if (l.status == "eligible" && (e.empty() || l.expense == e)) out.push_back(&l);
    }
    return out;
  };
  auto walk = [&](std::vector<Line*> ls, int64_t cap, const std::string& rid, const std::string& op) {
    int64_t cum = 0;
    bool crossed = false;
    for (Line* l : ls) {
      if (crossed) {
        tr(op, l->id, rid, ssub(0, l->allowed));
        l->allowed = 0;
        l->cap = rid;
        continue;
      }
      if (sadd(cum, l->allowed) > cap) {
        int64_t v = ssub(cap, cum);
        tr(op, l->id, rid, ssub(v, l->allowed));
        l->allowed = v;
        l->cap = rid;
        crossed = true;
      }
      cum = sadd(cum, l->allowed);
    }
  };

  // Step 7a: per-unit caps and caps per something unmeasurable, in rule order.
  for (const Rule& r : rules) {
    if (r.category != "expense_cap" || r.expense.empty() || !r.num("amount_cents")) continue;
    int64_t cap = *r.num("amount_cents");
    std::string per = r.per();
    if (kUnitPers.count(per)) {
      for (Line* l : eligible(r.expense)) {
        if (l->units > 0) {
          int64_t v = smul(cap, l->units);
          if (v < l->allowed) {
            tr("unit_cap", l->id, r.id, ssub(v, l->allowed));
            l->allowed = v;
            l->cap = r.id;
          }
        } else {
          l->flags.push_back("rate_unverified:" + r.id);
          tr("rate_unverified", l->id, r.id, 0);
        }
      }
    } else if (per != "claim") {
      for (Line* l : eligible(r.expense)) {
        l->flags.push_back("rate_unverified:" + r.id);
        tr("rate_unverified", l->id, r.id, 0);
      }
    }
  }
  // Step 7b: per-claim caps.
  for (const Rule& r : rules) {
    if (r.category != "expense_cap" || r.expense.empty() || !r.num("amount_cents") || r.per() != "claim") continue;
    walk(eligible(r.expense), *r.num("amount_cents"), r.id, "expense_cap");
  }
  // Step 8.
  const Rule* total = nullptr;
  for (const Rule& r : rules) {
    if (r.category == "total_cap" && r.num("amount_cents") && (!total || *r.num("amount_cents") < *total->num("amount_cents")))
      total = &r;
  }
  if (total) walk(eligible(""), *total->num("amount_cents"), total->id, "total_cap");

  int64_t allowed_total = 0;
  for (Line* l : eligible("")) allowed_total = sadd(allowed_total, l->allowed);

  // Step 9.
  json checks = json::object();
  {
    auto all = ids_of([](const Rule& r) { return r.category == "minimum_loss"; });
    std::string status = "met";
    bool any_amount = false;
    int worst = 0;  // 0 met, 1 waived, 2 not_met
    for (const Rule& r : rules) {
      if (r.category != "minimum_loss" || !r.num("amount_cents")) continue;
      any_amount = true;
      if (allowed_total < *r.num("amount_cents")) {
        bool waived = exam_ctx && r.params.contains("waived_for") && contains(r.params["waived_for"], "sexual_assault", true);
        worst = std::max(worst, waived ? 1 : 2);
      }
    }
    if (!all.empty()) status = !any_amount ? "unknown" : worst == 0 ? "met" : worst == 1 ? "waived" : "not_met";
    tr("minimum_loss", nullptr, first(all), 0);
    checks["minimum_loss"] = {{"status", status}, {"rule_ids", all}};
  }
  // Step 10.
  {
    auto all = ids_of([](const Rule& r) { return r.category == "filing_deadline"; });
    std::optional<int64_t> best;
    for (const Rule& r : rules) {
      if (r.category != "filing_deadline") continue;
      std::optional<int64_t> d;
      if (r.num("years")) d = plus_years(incident, *r.num("years"));
      else if (r.num("days")) d = incident + *r.num("days");
      if (d && (!best || *d > *best)) best = d;
    }
    tr("deadline", nullptr, first(all), 0);
    checks["deadline"] = {{"status", !best ? "unknown" : as_of <= *best ? "ok" : "late"},
                          {"deadline_date", best ? json(date_str(*best)) : json(nullptr)},
                          {"rule_ids", all}};
  }
  // Step 11.
  {
    auto all = ids_of([](const Rule& r) { return r.category == "reporting_requirement"; });
    std::string status = "satisfied";
    if (!all.empty()) {
      bool alt_exam = false, alt_other = false, required = false;
      for (const Rule& r : rules) {
        if (r.category != "reporting_requirement") continue;
        bool req = !r.params.contains("required") || r.params["required"].is_null() || r.params["required"].get<bool>();
        required = required || req;
        if (r.params.contains("alternatives")) {
          const json& a = r.params["alternatives"];
          alt_exam = alt_exam || contains(a, "forensic_exam", true);
          if (a.is_array()) {
            for (const auto& x : a) alt_other = alt_other || !(x.is_string() && x.get<std::string>() == "forensic_exam");
          } else if (a.is_string()) {
            alt_other = alt_other || (!a.get<std::string>().empty() && a.get<std::string>() != "forensic_exam");
          }
        }
      }
      if (police == "yes" || (exam_ctx && alt_exam)) status = "satisfied";
      else if (police == "no" && required && !alt_other) status = "required";
      else status = "unknown";
    }
    tr("reporting", nullptr, first(all), 0);
    checks["reporting"] = {{"status", status}, {"rule_ids", all}};
  }
  // Step 12.
  auto info = ids_of([](const Rule& r) {
    return r.category == "collateral_source" || r.category == "conduct_reduction" || r.category == "emergency_award" ||
           r.category == "eligible_crime" || r.category == "residency";
  });

  json out_lines = json::array();
  int64_t req_total = 0, held = 0;
  std::map<std::string, int64_t> by_expense;
  for (const Line& l : lines) {
    out_lines.push_back({{"item_id", l.id},
                         {"expense", l.expense},
                         {"status", l.status},
                         {"requested_cents", l.amount},
                         {"allowed_cents", l.allowed},
                         {"rule_ids", l.rule_ids},
                         {"cap_rule_id", l.cap ? json(*l.cap) : json(nullptr)},
                         {"flags", l.flags}});
    if (l.status == "eligible") {
      req_total = sadd(req_total, l.amount);
      by_expense[l.expense] = sadd(by_expense[l.expense], l.allowed);
    } else if (l.status == "held") {
      held = sadd(held, l.amount);
    }
  }
  return {{"jurisdiction", law["jurisdiction"]},
          {"lines", out_lines},
          {"totals", {{"requested_cents", req_total}, {"allowed_cents", allowed_total}, {"held_cents", held}, {"by_expense", by_expense}}},
          {"checks", checks},
          {"info_rule_ids", info},
          {"trace", trace}};
}

}  // namespace oracle

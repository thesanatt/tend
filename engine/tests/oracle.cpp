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
  return chr::sys_days(chr::year_month_day{chr::year(y), chr::month(m), chr::day(d)}).time_since_epoch().count();
}

std::string date_str(int64_t n) {
  chr::year_month_day ymd{chr::sys_days(chr::days(n))};
  char buf[16];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02u", int(ymd.year()), unsigned(ymd.month()), unsigned(ymd.day()));
  return buf;
}

struct Rule {
  std::string id, kind, expense;
  json r;
  std::optional<int64_t> num(const char* k) const {
    auto it = r.find(k);
    if (it == r.end() || !it->is_number_integer()) return std::nullopt;
    return it->get<int64_t>();
  }
  std::vector<std::string> list(const char* k) const {
    std::vector<std::string> out;
    auto it = r.find(k);
    if (it != r.end() && it->is_array()) {
      for (const auto& x : *it) out.push_back(x.get<std::string>());
    }
    return out;
  }
  bool flag(const char* k, bool fallback) const {
    auto it = r.find(k);
    return it == r.end() || it->is_null() ? fallback : it->get<bool>();
  }
};

struct Line {
  std::string id, expense, unit, status = "unknown_rule";
  int64_t date = 0, amount = 0, insurance = 0, units = 0, allowed = 0;
  bool confirmed = false;
  std::set<std::string> tags;
  std::vector<std::string> rule_ids, alts, flags;
  std::optional<std::string> cap;
};

}  // namespace

json evaluate(const json& law, const json& input) {
  std::vector<Rule> rules;
  for (const auto& r : law["rules"]) {
    Rule x;
    x.id = r["id"];
    x.kind = r["kind"];
    std::string category = r.contains("category") && r["category"].is_string() ? r["category"].get<std::string>() : "";
    if (x.kind == "info" && category == "collateral_source") x.kind = "collateral";
    if (x.kind == "info" && category == "exam_payment") x.kind = "exam_payment";
    x.expense = r.contains("expense") && r["expense"].is_string() ? r["expense"].get<std::string>() : "";
    x.r = r;
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
      l.unit = it.contains("unit") && it["unit"].is_string() ? it["unit"].get<std::string>() : "";
      if (it.contains("tags") && it["tags"].is_array()) {
        for (const auto& t : it["tags"]) l.tags.insert(t.get<std::string>());
      }
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

  // SPEC v1.2: held only with an exam_no_bill rule; payment rules join that proof.
  std::vector<std::string> exam = ids_of([](const Rule& r) { return r.kind == "exam_no_bill"; });
  const bool holds = !exam.empty();
  if (holds) {
    for (auto& id : ids_of([](const Rule& r) { return r.kind == "exam_payment"; })) exam.push_back(id);
  }
  std::vector<std::string> collateral = ids_of([](const Rule& r) { return r.kind == "collateral"; });

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
    auto excl = ids_of([&](const Rule& r) {
      if (r.kind != "excluded" || (!r.expense.empty() && r.expense != e)) return false;
      std::vector<std::string> tags = r.list("tags");
      if (tags.empty()) return true;
      for (const auto& t : tags) {
        if (l.tags.count(t)) return true;
      }
      return false;
    });
    if (!excl.empty()) {
      l.status = "excluded";
      l.rule_ids = excl;
      tr(l.status, l.id, first(excl), 0);
      continue;
    }
    auto cov = ids_of([&](const Rule& r) { return (r.kind == "covered" || r.kind == "expense_cap") && r.expense == e; });
    if (cov.empty()) {
      l.status = "unknown_rule";
      tr(l.status, l.id, nullptr, 0);
      continue;
    }
    for (const Rule& r : rules) {
      if (r.kind == "expense_cap" && r.expense == e) {
        for (const auto& a : r.list("alt_rule_ids")) l.alts.push_back(a);
      }
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

  // Step 7a: per-unit caps with optional count limits.
  for (const Rule& r : rules) {
    if (r.kind != "expense_cap" || r.r["per"] != "unit") continue;
    int64_t cap = *r.num("cap_cents");
    std::optional<int64_t> remaining = r.num("count_limit");
    const std::string unit = r.r["unit"];
    for (Line* l : eligible(r.expense)) {
      if (l->unit == unit && l->units > 0) {
        int64_t counted = l->units;
        if (remaining) {
          counted = std::min(l->units, *remaining);
          *remaining = ssub(*remaining, counted);
        }
        int64_t v = smul(cap, counted);
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
  }
  // Step 7b: per-claim caps.
  for (const Rule& r : rules) {
    if (r.kind == "expense_cap" && r.r["per"] == "claim") walk(eligible(r.expense), *r.num("cap_cents"), r.id, "expense_cap");
  }
  // Step 8.
  const Rule* total = nullptr;
  for (const Rule& r : rules) {
    if (r.kind == "total_cap" && (!total || *r.num("cap_cents") < *total->num("cap_cents"))) total = &r;
  }
  if (total) walk(eligible(""), *total->num("cap_cents"), total->id, "total_cap");

  int64_t allowed_total = 0;
  for (Line* l : eligible("")) allowed_total = sadd(allowed_total, l->allowed);

  json checks = json::object();
  // Step 9 (SPEC v1.2): a rule is met by the total or by lost-wage days; below
  // it, the waiver decides; a days-only rule is unknown. Worst status wins.
  {
    auto all = ids_of([](const Rule& r) { return r.kind == "minimum_loss"; });
    int64_t weeks = 0, days = 0;
    for (Line* l : eligible("lost_wages")) {
      if (l->unit == "week") weeks = sadd(weeks, l->units);
      else if (l->unit == "day") days = sadd(days, l->units);
    }
    int64_t lost_days = sadd(smul(weeks, 5), days);
    const char* names[] = {"met", "waived", "unknown", "may_be_waived", "not_met"};
    int worst = 0;
    for (const Rule& r : rules) {
      if (r.kind != "minimum_loss") continue;
      auto cap = r.num("cap_cents");
      auto need = r.num("days_lost");
      if ((cap && allowed_total >= *cap) || (need && lost_days >= *need)) continue;
      int s = 2;
      if (cap) {
        std::string waiver = r.r.value("waiver", "");
        bool sa = r.flag("waiver_for_sexual_assault", false);
        s = sa && waiver == "automatic" ? 1 : sa && waiver == "discretionary" ? 3 : 4;
      }
      worst = std::max(worst, s);
    }
    tr("minimum_loss", nullptr, first(all), 0);
    checks["minimum_loss"] = {{"status", names[worst]}, {"rule_ids", all}};
  }
  // Step 10.
  {
    auto all = ids_of([](const Rule& r) { return r.kind == "deadline"; });
    std::optional<int64_t> best;
    for (const Rule& r : rules) {
      if (r.kind != "deadline") continue;
      int64_t d = incident + *r.num("days");
      if (!best || d > *best) best = d;
    }
    bool from_report = false;
    for (const Rule& r : rules) {
      if (r.kind == "deadline" && r.r.value("from", "crime") == "report") from_report = true;
    }
    tr("deadline", nullptr, first(all), 0);
    json flags = json::array();
    if (from_report) flags.push_back("deadline_from_report");
    checks["deadline"] = {{"status", !best ? "unknown" : as_of <= *best ? "ok" : "late"},
                          {"deadline_date", best ? json(date_str(*best)) : json(nullptr)},
                          {"rule_ids", all},
                          {"flags", flags}};
  }
  // Step 11.
  {
    auto all = ids_of([](const Rule& r) { return r.kind == "reporting"; });
    bool alt_exam = false, required = false;
    for (const Rule& r : rules) {
      if (r.kind != "reporting") continue;
      required = required || r.flag("required", true);
      for (const auto& a : r.list("alternatives")) alt_exam = alt_exam || a == "forensic_exam";
    }
    std::string status;
    if (police == "yes" || (exam_ctx && alt_exam)) status = "satisfied";
    else if (required) status = police == "no" ? "required" : "unknown";
    else status = "not_required";
    tr("reporting", nullptr, first(all), 0);
    checks["reporting"] = {{"status", status}, {"rule_ids", all}};
  }
  // Step 12.
  auto info = ids_of([&](const Rule& r) {
    return r.kind == "info" || r.kind == "collateral" || (r.kind == "exam_payment" && !holds);
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
                         {"alt_cap_rule_ids", l.alts},
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

// Random jurisdictions and claims: compiler + VM must agree with the oracle on
// every field of every output, including the trace.
#include <climits>
#include <cstdio>
#include <string>
#include <vector>

#include "civil.h"
#include "helpers.h"
#include "oracle.h"

using th::json;

namespace {

struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
  uint64_t next() {
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    return s;
  }
  int64_t range(int64_t lo, int64_t hi) { return lo + int64_t(next() % uint64_t(hi - lo + 1)); }
  bool chance(int pct) { return int(next() % 100) < pct; }
  template <class T>
  const T& pick(const std::vector<T>& v) {
    return v[next() % v.size()];
  }
};

const std::vector<std::string> kCategories = {
    "exam_no_bill", "exam_payment",    "total_cap",       "expense_cap",       "covered_expense",
    "excluded_expense", "filing_deadline", "reporting_requirement", "minimum_loss", "collateral_source",
    "conduct_reduction", "emergency_award", "eligible_crime", "residency"};
// A small set so rules and items collide often.
const std::vector<std::string> kExpenses = {"medical", "forensic_exam", "counseling", "lost_wages", "transportation",
                                            "relocation", "security", "property_replacement", "dental", "other"};
const std::vector<std::string> kPers = {"claim", "claim", "week", "session", "hour", "mile", "day", "residence", "month", "item"};
const std::vector<std::string> kAlternatives = {"forensic_exam", "protective_order", "advocate", "medical_provider", "other"};

std::string date_of(int64_t day) {
  char b[10];
  tend::format_date(day, b);
  return std::string(b, 10);
}

int64_t money(Rng& r) {
  switch (r.next() % 6) {
    case 0: return 0;
    case 1: return r.range(1, 100);
    case 2: return r.range(100, 50000);
    case 3: return r.range(50000, 5000000);
    case 4: return r.pick(std::vector<int64_t>{100000, 150000, 250000, 2500000});
    default: return r.range(0, 1000000000);
  }
}

json random_law(Rng& r) {
  json rules = json::array();
  int n = int(r.range(0, 32));
  for (int i = 0; i < n; i++) {
    std::string cat = r.pick(kCategories);
    json rule = {{"id", "R-" + std::to_string(i)}, {"category", cat}, {"quote", "q"}, {"pinpoint", "p"}, {"source_id", "T-S1"}};
    json p = json::object();
    if (r.chance(70)) {
      std::string e = r.pick(kExpenses);
      if (r.chance(50)) rule["expense"] = e;
      else p["expense"] = e;
    }
    if (cat == "total_cap" || cat == "emergency_award") {
      if (r.chance(85)) p["amount_cents"] = money(r);
    } else if (cat == "expense_cap") {
      if (r.chance(80)) p["amount_cents"] = money(r);
      if (r.chance(85)) p["per"] = r.pick(kPers);
      else if (r.chance(30)) p["per"] = nullptr;
      if (r.chance(10)) p["count_limit"] = r.range(1, 40);
    } else if (cat == "filing_deadline") {
      if (r.chance(55)) p["years"] = r.range(0, 12);
      if (r.chance(35)) p["days"] = r.range(0, 1200);
      p["from"] = r.pick(std::vector<std::string>{"crime", "discovery", "report", "age_18"});
    } else if (cat == "minimum_loss") {
      if (r.chance(70)) p["amount_cents"] = r.range(0, 30000);
      if (r.chance(30)) p["days_lost"] = r.range(1, 14);
      switch (r.next() % 5) {
        case 0: p["waived_for"] = {"sexual_assault"}; break;
        case 1: p["waived_for"] = "victims of sexual_assault"; break;
        case 2: p["waived_for"] = {"forensic_exam", "dire hardship"}; break;
        case 3: p["waived_for"] = nullptr; break;
        default: break;
      }
    } else if (cat == "reporting_requirement") {
      switch (r.next() % 4) {
        case 0: p["required"] = true; break;
        case 1: p["required"] = false; break;
        case 2: p["required"] = nullptr; break;
        default: break;
      }
      if (r.chance(15)) {
        p["alternatives"] = r.chance(50) ? "forensic_exam" : "an advocate letter";
      } else if (r.chance(75)) {
        json alts = json::array();
        for (const auto& a : kAlternatives) {
          if (r.chance(30)) alts.push_back(a);
        }
        p["alternatives"] = alts;
      }
      if (r.chance(30)) p["within_days"] = r.range(1, 30);
    }
    rule["params"] = p;
    rules.push_back(rule);
  }
  return th::law(rules);
}

json random_claim(Rng& r) {
  int64_t base;
  tend::parse_date("2026-06-14", base);
  int64_t incident = base + r.range(-800, 400);
  int64_t as_of = incident + r.range(-30, 2500);
  json ctx = {{"incident_date", date_of(incident)}, {"as_of_date", date_of(as_of)}};
  switch (r.next() % 4) {
    case 0: ctx["police_report"] = "yes"; break;
    case 1: ctx["police_report"] = "no"; break;
    case 2: ctx["police_report"] = "unknown"; break;
    default: break;
  }
  if (r.chance(85)) ctx["forensic_exam"] = r.chance(50);
  json items = json::array();
  int n = int(r.range(0, 40));
  for (int i = 0; i < n; i++) {
    int64_t amount = r.chance(2) ? INT64_MAX - r.range(0, 5) : money(r);
    json it = {{"item_id", "i" + std::to_string(r.range(0, n))},
               {"date", date_of(incident + r.range(-15, std::max<int64_t>(as_of - incident, 0) + 15))},
               {"amount_cents", amount}};
    if (r.chance(95)) {
      it["expense"] = r.chance(85) ? r.pick(kExpenses) : r.pick(std::vector<std::string>{"unknown", "groceries", "tuition"});
    }
    if (r.chance(90)) it["confirmed"] = r.chance(85);
    if (r.chance(30)) it["insurance_paid_cents"] = r.chance(5) ? INT64_MAX : r.range(0, amount < 2000000 ? amount + amount / 5 : 2000000);
    if (r.chance(50)) it["units"] = r.chance(3) ? INT64_MAX / 3 : r.range(0, 12);
    if (r.chance(50)) it["is_bill"] = r.chance(50);
    items.push_back(it);
  }
  return {{"jurisdiction", "ZZ"}, {"context", ctx}, {"items", items}};
}

}  // namespace

TEST_CASE("differential: VM agrees with the oracle on random laws and claims") {
  int laws = std::stoi(th::env_or("TEND_DIFF_LAWS", "1500"));
  int failures = 0;
  long evaluations = 0;
  for (int seed = 1; seed <= laws && failures < 3; seed++) {
    Rng r{uint64_t(seed)};
    json law = random_law(r);
    std::vector<uint8_t> img = th::compile(law);
    char* dis = tend_disasm(img.data(), img.size());
    REQUIRE(dis != nullptr);
    CHECK(std::string(dis).rfind("error", 0) != 0);
    tend_free(dis);
    for (int c = 0; c < 4; c++) {
      json input = random_claim(r);
      json got = th::strip_sha(th::eval(img, input));
      json want = oracle::evaluate(law, input);
      evaluations++;
      if (got != want) {
        failures++;
        json patch = json::diff(want, got);
        MESSAGE("seed " << seed << " claim " << c << "\nlaw: " << law.dump() << "\ninput: " << input.dump()
                        << "\nfirst differences (oracle -> vm): " << json(patch.begin(), patch.begin() + std::min<size_t>(6, patch.size())).dump());
      }
    }
  }
  CHECK(failures == 0);
  MESSAGE(evaluations << " random evaluations compared");
}

TEST_CASE("differential: compilation is deterministic") {
  for (int seed = 1; seed <= 200; seed++) {
    Rng r{uint64_t(seed) + 100000};
    json law = random_law(r);
    CHECK(th::compile(law) == th::compile(law));
  }
}

TEST_CASE("differential: the trace accounts for every allowed cent") {
  for (int seed = 1; seed <= 300; seed++) {
    Rng r{uint64_t(seed) + 200000};
    json law = random_law(r);
    std::vector<uint8_t> img = th::compile(law);
    json input = random_claim(r);
    bool huge = false;
    for (auto& it : input["items"]) {
      huge = huge || it["amount_cents"].get<int64_t>() > 1000000000000LL || (it.contains("units") && it["units"].get<int64_t>() > 1000000);
    }
    if (huge) continue;
    json out = th::eval(img, input);
    int64_t sum = 0;
    for (const auto& t : out["trace"]) sum += t["delta_cents"].get<int64_t>();
    CHECK(sum == out["totals"]["allowed_cents"].get<int64_t>());
    for (const auto& l : out["lines"]) {
      if (l["status"] != "eligible") CHECK(l["allowed_cents"] == 0);
      else CHECK(l["allowed_cents"].get<int64_t>() <= l["requested_cents"].get<int64_t>());
    }
  }
}

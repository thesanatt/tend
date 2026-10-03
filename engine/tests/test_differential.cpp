// Random law IR and claims: compiler + VM must agree with the oracle on every
// field of every output, including the trace.
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

const std::vector<std::string> kKinds = {"exam_no_bill", "exam_payment", "total_cap", "expense_cap", "expense_cap",
                                         "covered",      "covered",      "excluded",  "excluded",    "deadline",
                                         "reporting",    "minimum_loss", "collateral", "info"};
// A small set so rules and items collide often.
const std::vector<std::string> kExpenses = {"medical", "forensic_exam", "counseling", "lost_wages", "transportation",
                                            "relocation", "security", "property_replacement", "dental", "other"};
const std::vector<std::string> kUnits = {"session", "week", "hour", "mile", "day", "month", "item"};
const std::vector<std::string> kTags = {"phone", "purse", "cash", "pain_suffering"};
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

json tag_list(Rng& r, int pct) {
  json t = json::array();
  for (const auto& tag : kTags) {
    if (r.chance(pct)) t.push_back(tag);
  }
  return t;
}

json random_law(Rng& r) {
  json rules = json::array(), skipped = json::array();
  int n = int(r.range(0, 32));
  int tagged = 0;  // the compiler allows at most 6 tagged exclusions per expense
  for (int i = 0; i < n; i++) {
    std::string kind = r.pick(kKinds);
    std::string id = "R-" + std::to_string(i);
    json rule = {{"id", id}, {"kind", kind}};
    if (kind == "total_cap") {
      rule["cap_cents"] = money(r);
    } else if (kind == "expense_cap") {
      rule["expense"] = r.pick(kExpenses);
      rule["cap_cents"] = money(r);
      if (r.chance(35)) {
        rule["per"] = "unit";
        rule["unit"] = r.pick(kUnits);
        if (r.chance(40)) rule["count_limit"] = r.range(0, 12);
      } else {
        rule["per"] = "claim";
      }
      if (r.chance(20)) {
        json alts = json::array();
        int k = int(r.range(1, 2));
        for (int j = 0; j < k; j++) {
          std::string alt = id + "-ALT" + std::to_string(j);
          alts.push_back(alt);
          skipped.push_back({{"id", alt}, {"category", "expense_cap"}, {"reason", "less generous duplicate of " + id}});
        }
        rule["alt_rule_ids"] = alts;
      }
    } else if (kind == "covered") {
      rule["expense"] = r.pick(kExpenses);
    } else if (kind == "excluded") {
      bool with_expense = r.chance(70) || tagged >= 6;
      if (with_expense) rule["expense"] = r.pick(kExpenses);
      json tags = tag_list(r, 30);
      if (!with_expense && tags.empty()) tags.push_back(r.pick(kTags));
      if (!tags.empty() && tagged < 6 && r.chance(with_expense ? 50 : 100)) {
        rule["tags"] = tags;
        tagged++;
      }
    } else if (kind == "deadline") {
      rule["days"] = r.range(0, 4000);
      rule["from"] = r.pick(std::vector<std::string>{"crime", "discovery", "report", "age_18"});
    } else if (kind == "reporting") {
      if (r.chance(85)) rule["required"] = r.chance(60);
      json alts = json::array();
      for (const auto& a : kAlternatives) {
        if (r.chance(25)) alts.push_back(a);
      }
      rule["alternatives"] = alts;
      if (r.chance(30)) rule["within_days"] = r.range(1, 30);
    } else if (kind == "minimum_loss") {
      if (r.chance(80)) rule["cap_cents"] = r.range(0, 30000);
      if (r.chance(30)) rule["days_lost"] = r.range(1, 14);
      rule["waiver"] = r.pick(std::vector<std::string>{"none", "other", "discretionary", "automatic"});
      rule["waiver_for_sexual_assault"] = r.chance(50);
    } else if (kind == "info") {
      rule["category"] = r.pick(std::vector<std::string>{"residency", "conduct_reduction", "submission", "excluded_expense"});
    }
    rules.push_back(rule);
  }
  if (r.chance(30)) skipped.push_back({{"id", "R-SKIP"}, {"category", "expense_cap"}, {"reason", "applies_to family"}});
  return th::law(rules, "ZZ", skipped);
}

json random_claim(Rng& r) {
  int64_t base;
  tend::parse_date("2026-06-14", base);
  int64_t incident = base + r.range(-800, 400);
  int64_t as_of = incident + r.range(-30, 4500);
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
    if (r.chance(40)) {
      json tags = tag_list(r, 30);
      if (r.chance(20)) tags.push_back("unheard-of");
      it["tags"] = tags;
    }
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

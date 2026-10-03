// One group per step of the SPEC decision procedure, with hand-computed answers.
#include <algorithm>
#include <climits>
#include <string>
#include <vector>

#include "helpers.h"

using th::claim;
using th::item;
using th::json;
using th::law;
using th::line;
using th::rule;
using th::run;

namespace {

const json kMed = rule("T-MED", "covered_expense", "medical");
const json kCounsel = rule("T-COUNSEL", "covered_expense", "counseling");

json ids(std::initializer_list<const char*> v) {
  json a = json::array();
  for (auto s : v) a.push_back(s);
  return a;
}

int64_t trace_sum(const json& out) {
  int64_t s = 0;
  for (const auto& t : out["trace"]) s += t["delta_cents"].get<int64_t>();
  return s;
}

}  // namespace

TEST_CASE("step 1: items outside [incident_date, as_of_date] are out of window") {
  json out = run(law({kMed}), claim({item("before", "2026-06-13", 100, "medical"), item("first", "2026-06-14", 200, "medical"),
                                     item("last", "2026-10-03", 300, "medical"), item("after", "2026-10-04", 400, "medical"),
                                     item("exam-late", "2026-12-01", 500, "forensic_exam")}));
  CHECK(line(out, "before")["status"] == "out_of_window");
  CHECK(line(out, "after")["status"] == "out_of_window");
  CHECK(line(out, "exam-late")["status"] == "out_of_window");
  CHECK(line(out, "exam-late")["expense"] == "forensic_exam");
  CHECK(line(out, "first")["status"] == "eligible");
  CHECK(line(out, "last")["status"] == "eligible");
  CHECK(line(out, "before")["rule_ids"] == json::array());
  CHECK(line(out, "before")["requested_cents"] == 100);
  CHECK(line(out, "before")["allowed_cents"] == 0);
  CHECK(out["totals"]["allowed_cents"] == 500);
  CHECK(out["totals"]["requested_cents"] == 500);
}

TEST_CASE("step 2: forensic exams are held when exam rules exist") {
  json nobill = rule("T-EXAM-1", "exam_no_bill", "forensic_exam");
  json pay = rule("T-EXAM-2", "exam_payment", "forensic_exam");
  json exam = item("exam", "2026-06-14", 32500, "forensic_exam", {{"confirmed", false}, {"is_bill", true}});

  json out = run(law({nobill, kMed, pay}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "held");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-EXAM-1", "T-EXAM-2"}));
  CHECK(line(out, "exam")["allowed_cents"] == 0);
  CHECK(out["totals"]["held_cents"] == 32500);
  CHECK(out["totals"]["allowed_cents"] == 0);
  CHECK(out["totals"]["requested_cents"] == 0);

  CHECK(line(run(law({nobill}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-1"}));
  CHECK(line(run(law({pay}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-2"}));
  // Payment rules listed first in the file still follow the no-bill rule in the proof.
  CHECK(line(run(law({pay, nobill}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-1", "T-EXAM-2"}));
}

TEST_CASE("step 2: without exam rules an exam is treated as medical") {
  json exam = item("exam", "2026-06-14", 32500, "forensic_exam");
  json out = run(law({kMed, rule("T-COLL", "collateral_source")}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "eligible");
  CHECK(line(out, "exam")["expense"] == "medical");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-MED", "T-COLL"}));
  CHECK(out["totals"]["by_expense"] == json({{"medical", 32500}}));

  out = run(law({kCounsel}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "unknown_rule");
  CHECK(line(out, "exam")["expense"] == "medical");

  out = run(law({rule("T-NOMED", "excluded_expense", "medical")}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "excluded");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-NOMED"}));

  // Coverage written for forensic_exam itself does not apply: the exam is medical now.
  out = run(law({rule("T-FX", "covered_expense", "forensic_exam")}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "unknown_rule");
}

TEST_CASE("step 3: an exclusion wins over coverage") {
  json r = law({rule("T-PROP-CAP", "expense_cap", "property_replacement", {{"amount_cents", 50000}, {"per", "claim"}}),
                rule("T-PROP-X", "excluded_expense", "property_replacement"),
                rule("T-PROP-X2", "excluded_expense", "", {{"expense", "property_replacement"}}),
                rule("T-PAIN", "excluded_expense", "", {{"item", "pain and suffering"}}), kMed});
  json out = run(r, claim({item("phone", "2026-06-20", 89900, "property_replacement"), item("er", "2026-06-20", 1000, "medical")}));
  CHECK(line(out, "phone")["status"] == "excluded");
  CHECK(line(out, "phone")["rule_ids"] == ids({"T-PROP-X", "T-PROP-X2"}));
  CHECK(line(out, "phone")["cap_rule_id"].is_null());
  CHECK(line(out, "er")["status"] == "eligible");
}

TEST_CASE("step 4: expenses no rule names are unknown_rule") {
  json r = law({kMed, rule("T-RELO-CAP", "expense_cap", "relocation", {{"amount_cents", 100}, {"per", "claim"}})});
  json out = run(r, claim({item("u", "2026-06-20", 100, "unknown"), item("g", "2026-06-20", 200, "groceries"),
                           item("t", "2026-06-20", 300, "tuition"), item("r", "2026-06-20", 50, "relocation"),
                           json{{"item_id", "noexp"}, {"date", "2026-06-20"}, {"amount_cents", 7}, {"confirmed", true}}}));
  CHECK(line(out, "u")["status"] == "unknown_rule");
  CHECK(line(out, "g")["status"] == "unknown_rule");
  CHECK(line(out, "g")["expense"] == "unknown");
  CHECK(line(out, "t")["status"] == "unknown_rule");
  CHECK(line(out, "t")["expense"] == "tuition");
  CHECK(line(out, "noexp")["status"] == "unknown_rule");
  // A cap alone makes the expense covered.
  CHECK(line(out, "r")["status"] == "eligible");
  CHECK(line(out, "r")["rule_ids"] == ids({"T-RELO-CAP"}));
}

TEST_CASE("step 5: unconfirmed lines are shown with their rule but not counted") {
  json r = law({kCounsel, rule("T-COUNSEL-CAP", "expense_cap", "counseling", {{"amount_cents", 100}, {"per", "claim"}}),
                rule("T-COLL", "collateral_source")});
  json unconfirmed = item("c1", "2026-06-20", 15000, "counseling", {{"confirmed", false}});
  json missing = {{"item_id", "c2"}, {"date", "2026-06-21"}, {"amount_cents", 9000}, {"expense", "counseling"}};
  json out = run(r, claim({unconfirmed, missing}));
  CHECK(line(out, "c1")["status"] == "needs_confirmation");
  CHECK(line(out, "c1")["rule_ids"] == ids({"T-COUNSEL", "T-COUNSEL-CAP"}));
  CHECK(line(out, "c1")["allowed_cents"] == 0);
  CHECK(line(out, "c2")["status"] == "needs_confirmation");
  CHECK(out["totals"]["allowed_cents"] == 0);
  CHECK(out["totals"]["by_expense"] == json::object());
}

TEST_CASE("step 6: eligible lines and collateral sources") {
  json no_coll = law({kMed});
  json out = run(no_coll, claim({item("er", "2026-06-20", 185000, "medical", {{"insurance_paid_cents", 120000}})}));
  CHECK(line(out, "er")["allowed_cents"] == 185000);
  CHECK(line(out, "er")["rule_ids"] == ids({"T-MED"}));

  json with_coll = law({rule("T-COLL-1", "collateral_source"), kMed, rule("T-COLL-2", "collateral_source")});
  out = run(with_coll, claim({item("er", "2026-06-20", 185000, "medical", {{"insurance_paid_cents", 120000}}),
                              item("all-paid", "2026-06-21", 5000, "medical", {{"insurance_paid_cents", 9000}}),
                              item("none-paid", "2026-06-22", 4000, "medical")}));
  CHECK(line(out, "er")["allowed_cents"] == 65000);
  CHECK(line(out, "er")["requested_cents"] == 185000);
  CHECK(line(out, "er")["rule_ids"] == ids({"T-MED", "T-COLL-1", "T-COLL-2"}));
  CHECK(line(out, "all-paid")["allowed_cents"] == 0);
  CHECK(line(out, "all-paid")["status"] == "eligible");
  CHECK(line(out, "none-paid")["allowed_cents"] == 4000);
  CHECK(out["totals"]["requested_cents"] == 194000);
  CHECK(out["totals"]["allowed_cents"] == 69000);
  CHECK(trace_sum(out) == 69000);
  int collateral_entries = 0;
  for (const auto& t : out["trace"]) {
    if (t["op"] == "collateral") {
      collateral_entries++;
      CHECK(t["rule_id"] == "T-COLL-1");
    }
  }
  CHECK(collateral_entries == 2);  // none-paid changed nothing, so no entry
}

TEST_CASE("step 7: a per-claim cap cuts the crossing item and zeroes later ones") {
  json r = law({rule("T-RELO", "expense_cap", "relocation", {{"amount_cents", 100000}, {"per", "claim"}}), kMed});
  json out = run(r, claim({item("a", "2026-06-20", 40000, "relocation"), item("b", "2026-06-21", 50000, "relocation"),
                           item("c", "2026-06-22", 30000, "relocation"), item("d", "2026-06-23", 20000, "relocation"),
                           item("m", "2026-06-22", 999, "medical")}));
  CHECK(line(out, "a")["allowed_cents"] == 40000);
  CHECK(line(out, "a")["cap_rule_id"].is_null());
  CHECK(line(out, "b")["allowed_cents"] == 50000);
  CHECK(line(out, "c")["allowed_cents"] == 10000);
  CHECK(line(out, "c")["cap_rule_id"] == "T-RELO");
  CHECK(line(out, "d")["allowed_cents"] == 0);
  CHECK(line(out, "d")["cap_rule_id"] == "T-RELO");
  CHECK(line(out, "m")["allowed_cents"] == 999);
  CHECK(out["totals"]["by_expense"]["relocation"] == 100000);
  CHECK(trace_sum(out) == out["totals"]["allowed_cents"].get<int64_t>());
}

TEST_CASE("step 7: exact fill, zero-allowed items, and a zero cap") {
  json r = law({rule("T-RELO", "expense_cap", "relocation", {{"amount_cents", 100}, {"per", "claim"}}),
                rule("T-COLL", "collateral_source")});
  // zero0 is fully insured before the crossing: untouched. a fills the cap exactly;
  // b crosses (cut to 0); zero1 comes after the crossing, so it records the cap.
  json out = run(r, claim({item("zero0", "2026-06-20", 50, "relocation", {{"insurance_paid_cents", 50}}),
                           item("a", "2026-06-21", 100, "relocation"), item("b", "2026-06-22", 30, "relocation"),
                           item("zero1", "2026-06-23", 10, "relocation", {{"insurance_paid_cents", 10}})}));
  CHECK(line(out, "zero0")["cap_rule_id"].is_null());
  CHECK(line(out, "a")["allowed_cents"] == 100);
  CHECK(line(out, "a")["cap_rule_id"].is_null());
  CHECK(line(out, "b")["allowed_cents"] == 0);
  CHECK(line(out, "b")["cap_rule_id"] == "T-RELO");
  CHECK(line(out, "zero1")["allowed_cents"] == 0);
  CHECK(line(out, "zero1")["cap_rule_id"] == "T-RELO");

  json zero = law({rule("T-ZERO", "expense_cap", "relocation", {{"amount_cents", 0}, {"per", "claim"}})});
  out = run(zero, claim({item("a", "2026-06-21", 100, "relocation")}));
  CHECK(line(out, "a")["allowed_cents"] == 0);
  CHECK(line(out, "a")["cap_rule_id"] == "T-ZERO");
}

TEST_CASE("step 7: several claim caps on one expense compose in rule order") {
  json r = law({rule("T-R1", "expense_cap", "relocation", {{"amount_cents", 200000}, {"per", "claim"}}),
                rule("T-R2", "expense_cap", "relocation", {{"amount_cents", 150000}, {"per", "claim"}})});
  json out = run(r, claim({item("r1", "2026-07-15", 120000, "relocation"), item("r2", "2026-07-20", 90000, "relocation")}));
  CHECK(line(out, "r1")["allowed_cents"] == 120000);
  CHECK(line(out, "r2")["allowed_cents"] == 30000);
  CHECK(line(out, "r2")["cap_rule_id"] == "T-R2");
  std::vector<std::string> cuts;
  for (const auto& t : out["trace"]) {
    if (t["op"] == "expense_cap") cuts.push_back(t["rule_id"].get<std::string>() + ":" + std::to_string(t["delta_cents"].get<int64_t>()));
  }
  CHECK(cuts == std::vector<std::string>{"T-R1:-10000", "T-R2:-50000"});
}

TEST_CASE("step 7: per-unit caps need units, otherwise rate_unverified") {
  json r = law({kCounsel, rule("T-SESSION", "expense_cap", "counseling", {{"amount_cents", 9000}, {"per", "session"}}),
                rule("T-WEEK", "expense_cap", "lost_wages", {{"amount_cents", 60000}, {"per", "week"}}),
                rule("T-MILE", "expense_cap", "transportation", {{"amount_cents", 50}, {"per", "mile"}}),
                rule("T-HOUR", "expense_cap", "childcare", {{"amount_cents", 1500}, {"per", "hour"}}),
                rule("T-DAY", "expense_cap", "temporary_housing", {{"amount_cents", 10000}, {"per", "day"}})});
  json out = run(r, claim({item("s1", "2026-06-20", 15000, "counseling", {{"units", 1}}),
                           item("s2", "2026-06-21", 15000, "counseling", {{"units", 2}}),
                           item("s0", "2026-06-22", 15000, "counseling"),
                           item("w", "2026-06-23", 140000, "lost_wages", {{"units", 2}}),
                           item("mi", "2026-06-24", 4000, "transportation", {{"units", 60}}),
                           item("h", "2026-06-25", 5000, "childcare", {{"units", 3}}),
                           item("d", "2026-06-26", 25000, "temporary_housing", {{"units", 2}})}));
  CHECK(line(out, "s1")["allowed_cents"] == 9000);
  CHECK(line(out, "s1")["cap_rule_id"] == "T-SESSION");
  CHECK(line(out, "s2")["allowed_cents"] == 15000);  // 2 x $90 = $180 is not binding
  CHECK(line(out, "s2")["cap_rule_id"].is_null());
  CHECK(line(out, "s0")["allowed_cents"] == 15000);
  CHECK(line(out, "s0")["flags"] == ids({"rate_unverified:T-SESSION"}));
  CHECK(line(out, "s0")["cap_rule_id"].is_null());
  CHECK(line(out, "w")["allowed_cents"] == 120000);
  CHECK(line(out, "mi")["allowed_cents"] == 3000);
  CHECK(line(out, "h")["allowed_cents"] == 4500);
  CHECK(line(out, "d")["allowed_cents"] == 20000);
}

TEST_CASE("step 7: unit caps run before claim caps") {
  // Claim cap first would cut b to $20 and leave the claim under its cap.
  json r = law({rule("T-CLAIM", "expense_cap", "counseling", {{"amount_cents", 10000}, {"per", "claim"}}),
                rule("T-SESSION", "expense_cap", "counseling", {{"amount_cents", 5000}, {"per", "session"}})});
  json out = run(r, claim({item("a", "2026-06-20", 8000, "counseling", {{"units", 1}}),
                           item("b", "2026-06-21", 8000, "counseling", {{"units", 1}}),
                           item("c", "2026-06-22", 8000, "counseling", {{"units", 1}})}));
  CHECK(line(out, "a")["allowed_cents"] == 5000);
  CHECK(line(out, "b")["allowed_cents"] == 5000);
  CHECK(line(out, "c")["allowed_cents"] == 0);
  CHECK(line(out, "c")["cap_rule_id"] == "T-CLAIM");
  CHECK(out["totals"]["allowed_cents"] == 10000);
}

TEST_CASE("step 7: caps the engine cannot measure flag every matching line") {
  json r = law({rule("T-SEC", "expense_cap", "security", {{"amount_cents", 100000}, {"per", "residence"}}),
                rule("T-WAGE-MONTH", "expense_cap", "lost_wages", {{"amount_cents", 240000}, {"per", "month"}}),
                rule("T-DENTAL", "expense_cap", "dental", {{"count_limit", 10}, {"per", "claim"}}),
                rule("T-NOPER", "expense_cap", "funeral", {{"amount_cents", 500}})});
  json out = run(r, claim({item("sec", "2026-06-20", 450000, "security", {{"units", 3}}),
                           item("wage", "2026-06-21", 500000, "lost_wages", {{"units", 4}}),
                           item("den", "2026-06-22", 30000, "dental"), item("fun", "2026-06-23", 900, "funeral")}));
  CHECK(line(out, "sec")["allowed_cents"] == 450000);
  CHECK(line(out, "sec")["flags"] == ids({"rate_unverified:T-SEC"}));
  CHECK(line(out, "wage")["flags"] == ids({"rate_unverified:T-WAGE-MONTH"}));
  CHECK(line(out, "den")["status"] == "eligible");
  CHECK(line(out, "den")["allowed_cents"] == 30000);
  CHECK(line(out, "den")["flags"] == json::array());
  CHECK(line(out, "fun")["allowed_cents"] == 500);  // no per means per claim
}

TEST_CASE("step 7: caps only see eligible lines") {
  json r = law({rule("T-RELO", "expense_cap", "relocation", {{"amount_cents", 100}, {"per", "claim"}})});
  json out = run(r, claim({item("pending", "2026-06-20", 90, "relocation", {{"confirmed", false}}),
                           item("old", "2026-01-01", 90, "relocation"), item("ok", "2026-06-21", 90, "relocation")}));
  CHECK(line(out, "ok")["allowed_cents"] == 90);
  CHECK(line(out, "ok")["cap_rule_id"].is_null());
}

TEST_CASE("step 8: the smallest total cap walks every eligible line") {
  json r = law({rule("T-TOTAL-BIG", "total_cap", "", {{"amount_cents", 5000000}}), kMed, kCounsel,
                rule("T-TOTAL", "total_cap", "", {{"amount_cents", 2500000}}),
                rule("T-TOTAL-TIE", "total_cap", "", {{"amount_cents", 2500000}}),
                rule("T-TOTAL-NONE", "total_cap", "", json::object()),
                rule("T-COUNSEL-CAP", "expense_cap", "counseling", {{"amount_cents", 2000000}, {"per", "claim"}})});
  json out = run(r, claim({item("m1", "2026-06-20", 1500000, "medical"), item("c1", "2026-06-21", 800000, "counseling"),
                           item("m2", "2026-06-22", 900000, "medical"), item("c2", "2026-06-23", 2500000, "counseling")}));
  CHECK(line(out, "m1")["allowed_cents"] == 1500000);
  CHECK(line(out, "c1")["allowed_cents"] == 800000);
  CHECK(line(out, "m2")["allowed_cents"] == 200000);
  CHECK(line(out, "m2")["cap_rule_id"] == "T-TOTAL");
  CHECK(line(out, "c2")["allowed_cents"] == 0);
  CHECK(line(out, "c2")["cap_rule_id"] == "T-TOTAL");  // the total cap overwrites the expense cap
  CHECK(out["totals"]["allowed_cents"] == 2500000);
  CHECK(out["totals"]["requested_cents"] == 5700000);
  CHECK(trace_sum(out) == 2500000);
}

TEST_CASE("step 9: minimum loss") {
  json items = json::array({item("m", "2026-06-20", 5000, "medical")});
  auto status = [&](const std::vector<json>& rules, json ctx = json::object()) {
    return run(law(rules), claim(items, ctx))["checks"]["minimum_loss"];
  };
  CHECK(status({kMed})["status"] == "met");
  CHECK(status({kMed})["rule_ids"] == json::array());
  CHECK(status({kMed, rule("T-MIN", "minimum_loss", "", {{"amount_cents", 5000}})})["status"] == "met");
  CHECK(status({kMed, rule("T-MIN", "minimum_loss", "", {{"amount_cents", 5001}})})["status"] == "not_met");
  json waivable = rule("T-MIN", "minimum_loss", "", {{"amount_cents", 10000}, {"waived_for", {"sexual_assault"}}});
  CHECK(status({kMed, waivable})["status"] == "waived");
  CHECK(status({kMed, waivable}, {{"forensic_exam", false}})["status"] == "not_met");
  json waivable_str = rule("T-MIN", "minimum_loss", "", {{"amount_cents", 10000}, {"waived_for", "victims of sexual_assault"}});
  CHECK(status({kMed, waivable_str})["status"] == "waived");
  json other_waiver = rule("T-MIN", "minimum_loss", "", {{"amount_cents", 10000}, {"waived_for", {"forensic_exam"}}});
  CHECK(status({kMed, other_waiver})["status"] == "not_met");
  json days_only = rule("T-DAYS", "minimum_loss", "", {{"days_lost", 7}});
  CHECK(status({kMed, days_only})["status"] == "unknown");
  CHECK(status({kMed, days_only})["rule_ids"] == ids({"T-DAYS"}));
  // With any amount rule, the amount rules decide; the worst of them wins.
  json met = rule("T-MIN-A", "minimum_loss", "", {{"amount_cents", 100}});
  CHECK(status({kMed, days_only, met})["status"] == "met");
  CHECK(status({kMed, met, waivable})["status"] == "waived");
  CHECK(status({kMed, waivable, rule("T-MIN-B", "minimum_loss", "", {{"amount_cents", 9000}})})["status"] == "not_met");
  CHECK(status({kMed, days_only, met, waivable})["rule_ids"] == ids({"T-DAYS", "T-MIN-A", "T-MIN"}));
}

TEST_CASE("step 9: minimum loss uses the total after caps") {
  json r = law({kMed, rule("T-TOTAL", "total_cap", "", {{"amount_cents", 4000}}),
                rule("T-MIN", "minimum_loss", "", {{"amount_cents", 5000}})});
  CHECK(run(r, claim({item("m", "2026-06-20", 6000, "medical")}))["checks"]["minimum_loss"]["status"] == "not_met");
}

TEST_CASE("step 10: filing deadline") {
  auto deadline = [](const std::vector<json>& rules, json ctx = json::object()) {
    return run(law(rules), claim({}, ctx))["checks"]["deadline"];
  };
  json three = rule("T-D3", "filing_deadline", "", {{"years", 3}, {"from", "crime"}});
  json days = rule("T-D400", "filing_deadline", "", {{"days", 400}, {"from", "discovery"}});
  json undated = rule("T-DX", "filing_deadline", "", {{"from", "report"}});

  json d = deadline({three});
  CHECK(d["status"] == "ok");
  CHECK(d["deadline_date"] == "2029-06-14");
  CHECK(d["rule_ids"] == ids({"T-D3"}));
  CHECK(deadline({days})["deadline_date"] == "2027-07-19");
  d = deadline({days, three, undated});
  CHECK(d["deadline_date"] == "2029-06-14");
  CHECK(d["rule_ids"] == ids({"T-D400", "T-D3", "T-DX"}));
  CHECK(deadline({three}, {{"as_of_date", "2029-06-14"}})["status"] == "ok");
  CHECK(deadline({three}, {{"as_of_date", "2029-06-15"}})["status"] == "late");
  d = deadline({undated});
  CHECK(d["status"] == "unknown");
  CHECK(d["deadline_date"].is_null());
  CHECK(d["rule_ids"] == ids({"T-DX"}));
  d = deadline({});
  CHECK(d["status"] == "unknown");
  CHECK(d["rule_ids"] == json::array());
  CHECK(deadline({rule("T-D1", "filing_deadline", "", {{"years", 1}})}, {{"incident_date", "2024-02-29"}, {"as_of_date", "2025-02-28"}})["deadline_date"] == "2025-02-28");
  CHECK(deadline({rule("T-D1", "filing_deadline", "", {{"years", 1}})}, {{"incident_date", "2024-02-29"}, {"as_of_date", "2025-03-01"}})["status"] == "late");
  // Years win when a rule states both.
  CHECK(deadline({rule("T-BOTH", "filing_deadline", "", {{"years", 1}, {"days", 900}})})["deadline_date"] == "2027-06-14");
}

TEST_CASE("step 11: reporting") {
  auto report = [](const std::vector<json>& rules, json ctx) { return run(law(rules), claim({}, ctx))["checks"]["reporting"]; };
  json strict = rule("T-REP", "reporting_requirement", "", {{"required", true}, {"within_days", 5}, {"alternatives", json::array()}});
  json exam_alt = rule("T-REP-EXAM", "reporting_requirement", "", {{"required", true}, {"alternatives", {"forensic_exam"}}});
  json not_required = rule("T-REP-NO", "reporting_requirement", "", {{"required", false}});
  json other_alt = rule("T-REP-ADV", "reporting_requirement", "", {{"required", true}, {"alternatives", {"advocate", "forensic_exam"}}});

  json r = report({}, {{"police_report", "no"}});
  CHECK(r["status"] == "satisfied");
  CHECK(r["rule_ids"] == json::array());
  CHECK(report({strict}, {{"police_report", "yes"}})["status"] == "satisfied");
  CHECK(report({strict}, {{"police_report", "no"}})["status"] == "required");
  CHECK(report({strict}, {{"police_report", "unknown"}})["status"] == "unknown");
  CHECK(report({strict}, {{"police_report", nullptr}})["status"] == "unknown");
  CHECK(report({exam_alt}, {{"police_report", "no"}, {"forensic_exam", true}})["status"] == "satisfied");
  CHECK(report({exam_alt}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "required");
  CHECK(report({not_required}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "unknown");
  CHECK(report({strict, not_required}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "required");
  CHECK(report({other_alt}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "unknown");
  CHECK(report({other_alt}, {{"police_report", "no"}, {"forensic_exam", true}})["status"] == "satisfied");
  json missing_required = rule("T-REP-M", "reporting_requirement", "", json::object());
  CHECK(report({missing_required}, {{"police_report", "no"}})["status"] == "required");
  json string_alt = rule("T-REP-S", "reporting_requirement", "", {{"alternatives", "forensic_exam"}});
  CHECK(report({string_alt}, {{"police_report", "no"}, {"forensic_exam", true}})["status"] == "satisfied");
  CHECK(report({string_alt}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "required");
  CHECK(report({strict, exam_alt}, {{"police_report", "no"}})["rule_ids"] == ids({"T-REP", "T-REP-EXAM"}));
}

TEST_CASE("step 12: info rules are listed in rule order") {
  json r = law({rule("T-RES", "residency", "", {{"rule", "anyone"}}), kMed, rule("T-CONDUCT", "conduct_reduction"),
                rule("T-COLL", "collateral_source"), rule("T-EMERG", "emergency_award", "", {{"amount_cents", 50000}}),
                rule("T-CRIME", "eligible_crime")});
  CHECK(run(r, claim({}))["info_rule_ids"] == ids({"T-RES", "T-CONDUCT", "T-COLL", "T-EMERG", "T-CRIME"}));
  CHECK(run(law({kMed}), claim({}))["info_rule_ids"] == json::array());
}

TEST_CASE("lines come out in (date, item_id) order whatever the input order") {
  std::vector<json> items = {item("b", "2026-06-20", 1, "medical"), item("a", "2026-06-20", 2, "medical"),
                             item("c", "2026-06-15", 3, "medical"), item("dup", "2026-06-16", 4, "medical"),
                             item("dup", "2026-06-16", 5, "medical"), item("\xC3\xA9", "2026-06-20", 6, "medical"),
                             item("Z", "2026-06-20", 7, "medical")};
  json out = run(law({kMed}), claim(items));
  std::vector<std::string> order;
  for (const auto& l : out["lines"]) order.push_back(l["item_id"]);
  CHECK(order == std::vector<std::string>{"c", "dup", "dup", "Z", "a", "b", "\xC3\xA9"});
  CHECK(out["lines"][1]["requested_cents"] == 4);  // stable for exact ties
  CHECK(out["lines"][2]["requested_cents"] == 5);

  std::vector<json> rev(items.rbegin(), items.rend());
  std::swap(rev[2], rev[3]);  // keep the two "dup" lines in their original relative order
  std::vector<json> reordered = {items[6], items[5], items[3], items[4], items[2], items[1], items[0]};
  CHECK(th::strip_sha(run(law({kMed}), claim(reordered))) == th::strip_sha(out));
}

TEST_CASE("output shape matches the spec") {
  json out = run(law({kMed, rule("T-D", "filing_deadline", "", {{"years", 5}})}),
                 claim({item("m", "2026-06-20", 100, "medical")}, json::object(), "ZZ"));
  CHECK(out["jurisdiction"] == "ZZ");
  CHECK(out["law_image_sha256"].get<std::string>().size() == 64);
  for (const char* k : {"lines", "totals", "checks", "info_rule_ids", "trace"}) CHECK(out.contains(k));
  const json& l = out["lines"][0];
  for (const char* k : {"item_id", "expense", "status", "requested_cents", "allowed_cents", "rule_ids", "cap_rule_id", "flags"})
    CHECK(l.contains(k));
  for (const char* k : {"requested_cents", "allowed_cents", "held_cents", "by_expense"}) CHECK(out["totals"].contains(k));
  for (const char* k : {"deadline", "minimum_loss", "reporting"}) CHECK(out["checks"][k].contains("status"));
  CHECK(out["checks"]["deadline"].contains("deadline_date"));
  for (const auto& t : out["trace"]) {
    for (const char* k : {"op", "item_id", "rule_id", "delta_cents"}) CHECK(t.contains(k));
  }
}

TEST_CASE("saturating arithmetic never wraps") {
  const int64_t cap = 1000000000000000;  // the compiler's largest allowed amount
  json r = law({kMed, rule("T-SESSION", "expense_cap", "medical", {{"amount_cents", cap}, {"per", "session"}})});
  json out = run(r, claim({item("a", "2026-06-20", INT64_MAX, "medical", {{"units", 100000}}),
                           item("b", "2026-06-21", INT64_MAX, "medical", {{"units", 1}})}));
  CHECK(line(out, "a")["allowed_cents"] == INT64_MAX);  // cap * units saturates, so it does not bind
  CHECK(line(out, "b")["allowed_cents"] == cap);
  CHECK(out["totals"]["allowed_cents"] == INT64_MAX);
  CHECK(out["totals"]["requested_cents"] == INT64_MAX);
  std::vector<std::string> warnings;
  tend::CompileResult res;
  std::string err;
  CHECK_FALSE(tend::compile_law(law({rule("T-BIG", "total_cap", "", {{"amount_cents", cap + 1}})}).dump(), res, err));
  CHECK(err == "T-BIG: params.amount_cents is out of range");
}

TEST_CASE("input validation") {
  std::vector<uint8_t> img = th::compile(law({kMed}));
  auto err = [&](const std::string& input) {
    json out = json::parse(th::eval_raw(img, input));
    return out.contains("error") ? out["error"]["code"].get<std::string>() + ": " + out["error"]["message"].get<std::string>()
                                 : std::string("ok");
  };
  const std::string ctx = R"("context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03"})";
  CHECK(err("{" + ctx + "}") == "ok");
  CHECK(err("{" + ctx + R"(,"items":null})") == "ok");
  CHECK(err(R"({"items":[]})") == "bad_input: context is required");
  CHECK(err(R"({"context":{"as_of_date":"2026-10-03"}})") == "bad_input: context.incident_date is required");
  CHECK(err(R"({"context":{"incident_date":"2026-6-14","as_of_date":"2026-10-03"}})").find("YYYY-MM-DD") != std::string::npos);
  CHECK(err("{" + ctx + R"(,"jurisdiction":"MI"})") == "jurisdiction_mismatch: input is for MI but the law image is ZZ");
  CHECK(err("{" + ctx + R"(,"jurisdiction":null})") == "ok");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":-1}]})") ==
        "bad_input: items[0].amount_cents: must not be negative");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1.5}]})") ==
        "bad_input: items[0].amount_cents: expected an integer");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01"}]})") == "bad_input: items[0].amount_cents is required");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"","date":"2026-07-01","amount_cents":1}]})") ==
        "bad_input: items[0].item_id: must not be empty");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1,"units":-2}]})") ==
        "bad_input: items[0].units: must not be negative");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1,"confirmed":"yes"}]})") ==
        "bad_input: items[0].confirmed: expected true or false");
  CHECK(err(R"({"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","police_report":"maybe"}})") ==
        "bad_input: context.police_report: expected yes, no, or unknown");
  CHECK(err("{" + ctx + "} trailing").find("trailing characters") != std::string::npos);
  CHECK(err("[]").find("expected an object") != std::string::npos);
  CHECK(err("").find("invalid JSON") != std::string::npos);
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"\ud800","date":"2026-07-01","amount_cents":1}]})").find("surrogate") !=
        std::string::npos);
  CHECK(err("{" + ctx + ",\"extra\":" + std::string(70, '[') + std::string(70, ']') + "}").find("too deep") != std::string::npos);
  // Unknown fields, including the free-text description, are ignored and never echoed.
  json out = th::eval(img, claim({item("a", "2026-07-01", 1, "medical", {{"description", "SECRET-TEXT"}, {"note", {1, 2}}})}));
  CHECK(out.dump().find("SECRET-TEXT") == std::string::npos);
}

TEST_CASE("escaped item ids survive the round trip") {
  std::vector<uint8_t> img = th::compile(law({kMed}));
  std::string input = R"({"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03"},"items":[)"
                      R"({"item_id":"q\"uote\\backé😀\n","date":"2026-07-01","amount_cents":5,"expense":"medical","confirmed":true}]})";
  json out = json::parse(th::eval_raw(img, input));
  CHECK(out["lines"][0]["item_id"] == "q\"uote\\back\xC3\xA9\xF0\x9F\x98\x80\n");
  CHECK(out["trace"][0]["item_id"] == out["lines"][0]["item_id"]);
}

// One group per step of the SPEC decision procedure (v1.1 law IR), with
// hand-computed answers.
#include <algorithm>
#include <climits>
#include <string>
#include <vector>

#include "helpers.h"
#include "sha256.h"

using th::claim;
using th::ir;
using th::item;
using th::json;
using th::law;
using th::line;
using th::run;

namespace {

const json kMed = ir("T-MED", "covered", {{"expense", "medical"}});
const json kCounsel = ir("T-COUNSEL", "covered", {{"expense", "counseling"}});

json cap(const std::string& id, const std::string& expense, int64_t cents, const std::string& unit = "",
         json extra = json::object()) {
  json f = {{"expense", expense}, {"cap_cents", cents}, {"per", unit.empty() ? "claim" : "unit"}};
  if (!unit.empty()) f["unit"] = unit;
  for (auto& [k, v] : extra.items()) f[k] = v;
  return ir(id, "expense_cap", f);
}

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

std::string compile_error(const json& doc, const std::string& verified = "") {
  tend::CompileResult res;
  std::string err;
  return tend::compile_law(doc.dump(), verified, res, err) ? std::string() : err;
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
  json nobill = ir("T-EXAM-1", "exam_no_bill");
  json pay = ir("T-EXAM-2", "exam_payment");
  json exam = item("exam", "2026-06-14", 32500, "forensic_exam", {{"confirmed", false}, {"is_bill", true}, {"tags", {"phone"}}});

  json out = run(law({nobill, kMed, pay, ir("T-X", "excluded", {{"tags", {"phone"}}})}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "held");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-EXAM-1", "T-EXAM-2"}));
  CHECK(line(out, "exam")["allowed_cents"] == 0);
  CHECK(out["totals"]["held_cents"] == 32500);
  CHECK(out["totals"]["allowed_cents"] == 0);
  CHECK(out["totals"]["requested_cents"] == 0);

  CHECK(line(run(law({nobill}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-1"}));
  CHECK(line(run(law({pay}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-2"}));
  CHECK(line(run(law({pay, nobill}), claim({exam})), "exam")["rule_ids"] == ids({"T-EXAM-1", "T-EXAM-2"}));
}

TEST_CASE("step 2: without exam rules an exam is treated as medical") {
  json exam = item("exam", "2026-06-14", 32500, "forensic_exam");
  json out = run(law({kMed, ir("T-COLL", "collateral")}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "eligible");
  CHECK(line(out, "exam")["expense"] == "medical");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-MED", "T-COLL"}));
  CHECK(out["totals"]["by_expense"] == json({{"medical", 32500}}));

  out = run(law({kCounsel}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "unknown_rule");
  CHECK(line(out, "exam")["expense"] == "medical");

  out = run(law({ir("T-NOMED", "excluded", {{"expense", "medical"}})}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "excluded");
  CHECK(line(out, "exam")["rule_ids"] == ids({"T-NOMED"}));

  out = run(law({ir("T-FX", "covered", {{"expense", "forensic_exam"}})}), claim({exam}));
  CHECK(line(out, "exam")["status"] == "unknown_rule");
}

TEST_CASE("step 3: exclusions by expense and by tag") {
  json r = law({cap("T-PROP-CAP", "property_replacement", 50000),
                ir("T-PROP-PHONE", "excluded", {{"expense", "property_replacement"}, {"tags", {"phone", "purse"}}}),
                ir("T-PAIN", "excluded", {{"tags", {"pain_suffering"}}}), kMed,
                ir("T-TUITION", "excluded", {{"expense", "tuition"}}),
                ir("T-CASH", "excluded", {{"expense", "property_replacement"}, {"tags", {"cash"}}})});
  json out = run(r, claim({item("phone", "2026-06-20", 89900, "property_replacement", {{"tags", {"phone"}}}),
                           item("wallet", "2026-06-20", 3000, "property_replacement", {{"tags", {"purse", "cash"}}}),
                           item("shirt", "2026-06-20", 60000, "property_replacement", {{"tags", json::array()}}),
                           item("pain-med", "2026-06-21", 1000, "medical", {{"tags", {"pain_suffering"}}}),
                           item("pain-unknown", "2026-06-21", 1000, "groceries", {{"tags", {"pain_suffering"}}}),
                           item("phone-med", "2026-06-21", 500, "medical", {{"tags", {"phone", "unheard-of"}}}),
                           item("school", "2026-06-22", 900, "tuition", {{"tags", {"pain_suffering"}}})}));
  CHECK(line(out, "phone")["status"] == "excluded");
  CHECK(line(out, "phone")["rule_ids"] == ids({"T-PROP-PHONE"}));
  CHECK(line(out, "wallet")["rule_ids"] == ids({"T-PROP-PHONE", "T-CASH"}));
  CHECK(line(out, "shirt")["status"] == "eligible");  // tagged exclusions need a matching tag
  CHECK(line(out, "shirt")["allowed_cents"] == 50000);
  CHECK(line(out, "pain-med")["status"] == "excluded");
  CHECK(line(out, "pain-med")["rule_ids"] == ids({"T-PAIN"}));
  CHECK(line(out, "pain-unknown")["status"] == "excluded");
  CHECK(line(out, "pain-unknown")["expense"] == "unknown");
  CHECK(line(out, "phone-med")["status"] == "eligible");  // the phone tag is only excluded for property
  CHECK(line(out, "school")["rule_ids"] == ids({"T-PAIN", "T-TUITION"}));
}

TEST_CASE("step 4: expenses no rule names are unknown_rule") {
  json r = law({kMed, cap("T-RELO-CAP", "relocation", 100)});
  json out = run(r, claim({item("u", "2026-06-20", 100, "unknown"), item("g", "2026-06-20", 200, "groceries"),
                           item("t", "2026-06-20", 300, "tuition"), item("r", "2026-06-20", 50, "relocation"),
                           json{{"item_id", "noexp"}, {"date", "2026-06-20"}, {"amount_cents", 7}, {"confirmed", true}}}));
  CHECK(line(out, "u")["status"] == "unknown_rule");
  CHECK(line(out, "g")["status"] == "unknown_rule");
  CHECK(line(out, "g")["expense"] == "unknown");
  CHECK(line(out, "t")["status"] == "unknown_rule");
  CHECK(line(out, "t")["expense"] == "tuition");
  CHECK(line(out, "noexp")["status"] == "unknown_rule");
  CHECK(line(out, "r")["status"] == "eligible");
  CHECK(line(out, "r")["rule_ids"] == ids({"T-RELO-CAP"}));
}

TEST_CASE("step 5: unconfirmed lines are shown with their rule but not counted") {
  json r = law({kCounsel, cap("T-COUNSEL-CAP", "counseling", 100, "", {{"alt_rule_ids", {"T-ALT"}}}), ir("T-COLL", "collateral")},
               "ZZ", json::array({{{"id", "T-ALT"}, {"category", "expense_cap"}, {"reason", "less generous duplicate"}}}));
  json unconfirmed = item("c1", "2026-06-20", 15000, "counseling", {{"confirmed", false}});
  json missing = {{"item_id", "c2"}, {"date", "2026-06-21"}, {"amount_cents", 9000}, {"expense", "counseling"}};
  json out = run(r, claim({unconfirmed, missing}));
  CHECK(line(out, "c1")["status"] == "needs_confirmation");
  CHECK(line(out, "c1")["rule_ids"] == ids({"T-COUNSEL", "T-COUNSEL-CAP"}));
  CHECK(line(out, "c1")["alt_cap_rule_ids"] == ids({"T-ALT"}));
  CHECK(line(out, "c1")["allowed_cents"] == 0);
  CHECK(line(out, "c2")["status"] == "needs_confirmation");
  CHECK(out["totals"]["allowed_cents"] == 0);
  CHECK(out["totals"]["by_expense"] == json::object());
}

TEST_CASE("step 6: eligible lines and collateral sources") {
  json out = run(law({kMed}), claim({item("er", "2026-06-20", 185000, "medical", {{"insurance_paid_cents", 120000}})}));
  CHECK(line(out, "er")["allowed_cents"] == 185000);
  CHECK(line(out, "er")["rule_ids"] == ids({"T-MED"}));

  json with_coll = law({ir("T-COLL-1", "collateral"), kMed, ir("T-COLL-2", "collateral")});
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
  json r = law({cap("T-RELO", "relocation", 100000), kMed});
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
  json r = law({cap("T-RELO", "relocation", 100), ir("T-COLL", "collateral")});
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

  out = run(law({cap("T-ZERO", "relocation", 0)}), claim({item("a", "2026-06-21", 100, "relocation")}));
  CHECK(line(out, "a")["allowed_cents"] == 0);
  CHECK(line(out, "a")["cap_rule_id"] == "T-ZERO");
}

TEST_CASE("step 7: several claim caps on one expense compose in rule order") {
  json r = law({cap("T-R1", "relocation", 200000), cap("T-R2", "relocation", 150000)});
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
  json r = law({kCounsel, cap("T-SESSION", "counseling", 9000, "session"), cap("T-WEEK", "lost_wages", 60000, "week"),
                cap("T-MILE", "transportation", 50, "mile"), cap("T-HOUR", "childcare", 1500, "hour"),
                cap("T-MONTH", "temporary_housing", 10000, "month")});
  json out = run(r, claim({item("s1", "2026-06-20", 15000, "counseling", {{"units", 1}}),
                           item("s2", "2026-06-21", 15000, "counseling", {{"units", 2}}),
                           item("s0", "2026-06-22", 15000, "counseling"),
                           item("w", "2026-06-23", 140000, "lost_wages", {{"units", 2}}),
                           item("mi", "2026-06-24", 4000, "transportation", {{"units", 60}}),
                           item("h", "2026-06-25", 5000, "childcare", {{"units", 3}}),
                           item("mo", "2026-06-26", 25000, "temporary_housing", {{"units", 2}})}));
  CHECK(line(out, "s1")["allowed_cents"] == 9000);
  CHECK(line(out, "s1")["cap_rule_id"] == "T-SESSION");
  CHECK(line(out, "s2")["allowed_cents"] == 15000);
  CHECK(line(out, "s2")["cap_rule_id"].is_null());
  CHECK(line(out, "s0")["allowed_cents"] == 15000);
  CHECK(line(out, "s0")["flags"] == ids({"rate_unverified:T-SESSION"}));
  CHECK(line(out, "w")["allowed_cents"] == 120000);
  CHECK(line(out, "mi")["allowed_cents"] == 3000);
  CHECK(line(out, "h")["allowed_cents"] == 4500);
  CHECK(line(out, "mo")["allowed_cents"] == 20000);
}

TEST_CASE("step 7: a count limit pays units only until the count runs out") {
  json r = law({cap("T-SESSION", "counseling", 9000, "session", {{"count_limit", 3}})});
  json out = run(r, claim({item("a", "2026-06-20", 15000, "counseling", {{"units", 1}}),
                           item("none", "2026-06-21", 15000, "counseling"),
                           item("b", "2026-06-22", 30000, "counseling", {{"units", 4}}),
                           item("c", "2026-06-23", 9000, "counseling", {{"units", 1}})}));
  CHECK(line(out, "a")["allowed_cents"] == 9000);
  CHECK(line(out, "none")["flags"] == ids({"rate_unverified:T-SESSION"}));
  CHECK(line(out, "b")["allowed_cents"] == 18000);  // only 2 of its 4 sessions are left
  CHECK(line(out, "c")["allowed_cents"] == 0);
  CHECK(line(out, "c")["cap_rule_id"] == "T-SESSION");
}

TEST_CASE("step 7: unit caps run before claim caps") {
  json r = law({cap("T-CLAIM", "counseling", 10000), cap("T-SESSION", "counseling", 5000, "session")});
  json out = run(r, claim({item("a", "2026-06-20", 8000, "counseling", {{"units", 1}}),
                           item("b", "2026-06-21", 8000, "counseling", {{"units", 1}}),
                           item("c", "2026-06-22", 8000, "counseling", {{"units", 1}})}));
  CHECK(line(out, "a")["allowed_cents"] == 5000);
  CHECK(line(out, "b")["allowed_cents"] == 5000);
  CHECK(line(out, "c")["allowed_cents"] == 0);
  CHECK(line(out, "c")["cap_rule_id"] == "T-CLAIM");
  CHECK(out["totals"]["allowed_cents"] == 10000);
}

TEST_CASE("step 7: alternate caps are listed on every line of their expense") {
  json r = law({kCounsel, cap("T-S1", "counseling", 12500, "session", {{"alt_rule_ids", {"T-S0", "T-S2"}}}),
                cap("T-C1", "counseling", 500000, "", {{"alt_rule_ids", {"T-C0"}}}), kMed},
               "ZZ",
               json::array({{{"id", "T-S0"}, {"category", "expense_cap"}, {"reason", "less generous duplicate of T-S1"}},
                            {{"id", "T-S2"}, {"category", "expense_cap"}, {"reason", "less generous duplicate of T-S1"}},
                            {{"id", "T-C0"}, {"category", "expense_cap"}, {"reason", "less generous duplicate of T-C1"}}}));
  json out = run(r, claim({item("c", "2026-06-20", 100, "counseling"), item("m", "2026-06-20", 100, "medical")}));
  CHECK(line(out, "c")["alt_cap_rule_ids"] == ids({"T-S0", "T-S2", "T-C0"}));
  CHECK(line(out, "m")["alt_cap_rule_ids"] == json::array());
  for (const auto& l : out["lines"]) {
    for (const auto& rid : l["rule_ids"]) CHECK(rid != "T-S0");
  }
}

TEST_CASE("step 7: caps only see eligible lines") {
  json r = law({cap("T-RELO", "relocation", 100)});
  json out = run(r, claim({item("pending", "2026-06-20", 90, "relocation", {{"confirmed", false}}),
                           item("old", "2026-01-01", 90, "relocation"), item("ok", "2026-06-21", 90, "relocation")}));
  CHECK(line(out, "ok")["allowed_cents"] == 90);
  CHECK(line(out, "ok")["cap_rule_id"].is_null());
}

TEST_CASE("step 8: the smallest total cap walks every eligible line") {
  json r = law({ir("T-TOTAL-BIG", "total_cap", {{"cap_cents", 5000000}}), kMed, kCounsel,
                ir("T-TOTAL", "total_cap", {{"cap_cents", 2500000}}), ir("T-TOTAL-TIE", "total_cap", {{"cap_cents", 2500000}}),
                cap("T-COUNSEL-CAP", "counseling", 2000000)});
  json out = run(r, claim({item("m1", "2026-06-20", 1500000, "medical"), item("c1", "2026-06-21", 800000, "counseling"),
                           item("m2", "2026-06-22", 900000, "medical"), item("c2", "2026-06-23", 2500000, "counseling")}));
  CHECK(line(out, "m1")["allowed_cents"] == 1500000);
  CHECK(line(out, "c1")["allowed_cents"] == 800000);
  CHECK(line(out, "m2")["allowed_cents"] == 200000);
  CHECK(line(out, "m2")["cap_rule_id"] == "T-TOTAL");
  CHECK(line(out, "c2")["allowed_cents"] == 0);
  CHECK(line(out, "c2")["cap_rule_id"] == "T-TOTAL");
  CHECK(out["totals"]["allowed_cents"] == 2500000);
  CHECK(out["totals"]["requested_cents"] == 5700000);
  CHECK(trace_sum(out) == 2500000);
}

TEST_CASE("step 9: minimum loss") {
  json items = json::array({item("m", "2026-06-20", 5000, "medical")});
  auto status = [&](const std::vector<json>& rules, json ctx = json::object()) {
    return run(law(rules), claim(items, ctx))["checks"]["minimum_loss"];
  };
  auto min_rule = [](const std::string& id, int64_t cents, const std::string& waiver = "none", bool sa = false) {
    return ir(id, "minimum_loss", {{"cap_cents", cents}, {"waiver", waiver}, {"waiver_for_sexual_assault", sa}});
  };
  CHECK(status({kMed})["status"] == "met");
  CHECK(status({kMed})["rule_ids"] == json::array());
  CHECK(status({kMed, min_rule("T-MIN", 5000)})["status"] == "met");
  CHECK(status({kMed, min_rule("T-MIN", 5001)})["status"] == "not_met");
  CHECK(status({kMed, min_rule("T-MIN", 10000, "discretionary", true)})["status"] == "may_be_waived");
  CHECK(status({kMed, min_rule("T-MIN", 10000, "automatic", true)})["status"] == "waived");
  CHECK(status({kMed, min_rule("T-MIN", 10000, "automatic", true)}, {{"forensic_exam", false}})["status"] == "not_met");
  CHECK(status({kMed, min_rule("T-MIN", 10000, "other", false)})["status"] == "not_met");
  json days_only = ir("T-DAYS", "minimum_loss", {{"days_lost", 7}, {"waiver", "none"}, {"waiver_for_sexual_assault", false}});
  CHECK(status({kMed, days_only})["status"] == "unknown");
  CHECK(status({kMed, days_only})["rule_ids"] == ids({"T-DAYS"}));
  CHECK(status({kMed, days_only, min_rule("T-A", 100)})["status"] == "met");
  CHECK(status({kMed, min_rule("T-A", 100), min_rule("T-B", 10000, "automatic", true)})["status"] == "waived");
  CHECK(status({kMed, min_rule("T-B", 10000, "automatic", true), min_rule("T-C", 10000, "discretionary", true)})["status"] ==
        "may_be_waived");
  CHECK(status({kMed, min_rule("T-C", 10000, "discretionary", true), min_rule("T-D", 9000)})["status"] == "not_met");
  CHECK(status({kMed, days_only, min_rule("T-A", 100)})["rule_ids"] == ids({"T-DAYS", "T-A"}));
}

TEST_CASE("step 9: minimum loss uses the total after caps") {
  json r = law({kMed, ir("T-TOTAL", "total_cap", {{"cap_cents", 4000}}), ir("T-MIN", "minimum_loss", {{"cap_cents", 5000}})});
  CHECK(run(r, claim({item("m", "2026-06-20", 6000, "medical")}))["checks"]["minimum_loss"]["status"] == "not_met");
}

TEST_CASE("step 10: filing deadline in days, the longest wins") {
  auto deadline = [](const std::vector<json>& rules, json ctx = json::object()) {
    return run(law(rules), claim({}, ctx))["checks"]["deadline"];
  };
  json three = ir("T-D3", "deadline", {{"days", 1095}, {"from", "crime"}});
  json short_one = ir("T-D400", "deadline", {{"days", 400}, {"from", "discovery"}});
  json d = deadline({three});
  CHECK(d["status"] == "ok");
  CHECK(d["deadline_date"] == "2029-06-13");
  CHECK(d["rule_ids"] == ids({"T-D3"}));
  CHECK(deadline({short_one})["deadline_date"] == "2027-07-19");
  d = deadline({short_one, three, ir("T-DX", "info", {{"category", "filing_deadline"}})});
  CHECK(d["deadline_date"] == "2029-06-13");
  CHECK(d["rule_ids"] == ids({"T-D400", "T-D3"}));
  CHECK(deadline({three}, {{"as_of_date", "2029-06-13"}})["status"] == "ok");
  CHECK(deadline({three}, {{"as_of_date", "2029-06-14"}})["status"] == "late");
  d = deadline({});
  CHECK(d["status"] == "unknown");
  CHECK(d["deadline_date"].is_null());
  CHECK(d["rule_ids"] == json::array());
  CHECK(deadline({ir("T-D0", "deadline", {{"days", 0}})}, {{"as_of_date", "2026-06-14"}})["status"] == "ok");
}

TEST_CASE("step 11: reporting") {
  auto report = [](const std::vector<json>& rules, json ctx) { return run(law(rules), claim({}, ctx))["checks"]["reporting"]; };
  json strict = ir("T-REP", "reporting", {{"required", true}, {"alternatives", json::array()}, {"within_days", 5}});
  json exam_alt = ir("T-REP-EXAM", "reporting", {{"required", true}, {"alternatives", {"forensic_exam"}}});
  json not_required = ir("T-REP-NO", "reporting", {{"required", false}, {"alternatives", {"advocate"}}});

  json r = report({}, {{"police_report", "no"}});
  CHECK(r["status"] == "not_required");
  CHECK(r["rule_ids"] == json::array());
  CHECK(report({}, {{"police_report", "yes"}})["status"] == "satisfied");
  CHECK(report({strict}, {{"police_report", "yes"}})["status"] == "satisfied");
  CHECK(report({strict}, {{"police_report", "no"}})["status"] == "required");
  CHECK(report({strict}, {{"police_report", "unknown"}})["status"] == "unknown");
  CHECK(report({strict}, {{"police_report", nullptr}})["status"] == "unknown");
  CHECK(report({exam_alt}, {{"police_report", "no"}, {"forensic_exam", true}})["status"] == "satisfied");
  CHECK(report({exam_alt}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "required");
  CHECK(report({not_required}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "not_required");
  CHECK(report({not_required}, {{"police_report", "unknown"}})["status"] == "not_required");
  CHECK(report({strict, not_required}, {{"police_report", "no"}, {"forensic_exam", false}})["status"] == "required");
  CHECK(report({not_required, exam_alt}, {{"police_report", "no"}, {"forensic_exam", true}})["status"] == "satisfied");
  CHECK(report({ir("T-REP-M", "reporting")}, {{"police_report", "no"}})["status"] == "required");
  CHECK(report({strict, exam_alt}, {{"police_report", "no"}})["rule_ids"] == ids({"T-REP", "T-REP-EXAM"}));
}

TEST_CASE("step 12: info and collateral rules are listed in rule order") {
  json r = law({ir("T-RES", "info", {{"category", "residency"}}), kMed, ir("T-CONDUCT", "info", {{"category", "conduct_reduction"}}),
                ir("T-COLL", "collateral"), ir("T-SUBMIT", "info", {{"category", "submission"}}),
                ir("T-PAY", "exam_payment")});
  CHECK(run(r, claim({}))["info_rule_ids"] == ids({"T-RES", "T-CONDUCT", "T-COLL", "T-SUBMIT"}));
  CHECK(run(law({kMed}), claim({}))["info_rule_ids"] == json::array());
}

TEST_CASE("collateral and exam payment written as info rules behave like their own kinds") {
  json exam = item("exam", "2026-06-14", 32500, "forensic_exam");
  json er = item("er", "2026-06-15", 1000, "medical", {{"insurance_paid_cents", 400}});
  json as_info = law({kMed, ir("T-COLL", "info", {{"category", "collateral_source"}}),
                      ir("T-PAY", "info", {{"category", "exam_payment"}})});
  json as_kinds = law({kMed, ir("T-COLL", "collateral"), ir("T-PAY", "exam_payment")});
  json a = th::strip_sha(run(as_info, claim({exam, er})));
  CHECK(a == th::strip_sha(run(as_kinds, claim({exam, er}))));
  CHECK(line(a, "exam")["status"] == "held");
  CHECK(line(a, "er")["allowed_cents"] == 600);
  CHECK(a["info_rule_ids"] == ids({"T-COLL"}));
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
  std::vector<json> reordered = {items[6], items[5], items[3], items[4], items[2], items[1], items[0]};
  CHECK(th::strip_sha(run(law({kMed}), claim(reordered))) == th::strip_sha(out));
}

TEST_CASE("output shape matches the spec") {
  json out = run(law({kMed, ir("T-D", "deadline", {{"days", 1826}})}), claim({item("m", "2026-06-20", 100, "medical")}));
  CHECK(out["jurisdiction"] == "ZZ");
  CHECK(out["law_image_sha256"].get<std::string>().size() == 64);
  for (const char* k : {"lines", "totals", "checks", "info_rule_ids", "trace"}) CHECK(out.contains(k));
  const json& l = out["lines"][0];
  for (const char* k : {"item_id", "expense", "status", "requested_cents", "allowed_cents", "rule_ids", "cap_rule_id",
                        "alt_cap_rule_ids", "flags"})
    CHECK(l.contains(k));
  for (const char* k : {"requested_cents", "allowed_cents", "held_cents", "by_expense"}) CHECK(out["totals"].contains(k));
  for (const char* k : {"deadline", "minimum_loss", "reporting"}) CHECK(out["checks"][k].contains("status"));
  CHECK(out["checks"]["deadline"].contains("deadline_date"));
  for (const auto& t : out["trace"]) {
    for (const char* k : {"op", "item_id", "rule_id", "delta_cents"}) CHECK(t.contains(k));
  }
}

TEST_CASE("saturating arithmetic never wraps") {
  const int64_t big = 1000000000000000;  // the compiler's largest allowed amount
  json r = law({kMed, cap("T-SESSION", "medical", big, "session")});
  json out = run(r, claim({item("a", "2026-06-20", INT64_MAX, "medical", {{"units", 100000}}),
                           item("b", "2026-06-21", INT64_MAX, "medical", {{"units", 1}})}));
  CHECK(line(out, "a")["allowed_cents"] == INT64_MAX);  // cap * units saturates, so it does not bind
  CHECK(line(out, "b")["allowed_cents"] == big);
  CHECK(out["totals"]["allowed_cents"] == INT64_MAX);
  CHECK(out["totals"]["requested_cents"] == INT64_MAX);
  CHECK(compile_error(law({ir("T-BIG", "total_cap", {{"cap_cents", big + 1}})})) == "T-BIG: cap_cents is out of range");
}

TEST_CASE("the compiler rejects IR it cannot honor") {
  CHECK(compile_error(json::object()) == "IR: ir_version must be 1");
  CHECK(compile_error({{"ir_version", 2}, {"jurisdiction", "ZZ"}, {"rules", json::array()}}) == "IR: ir_version must be 1");
  CHECK(compile_error({{"ir_version", 1}, {"jurisdiction", "zz"}, {"rules", json::array()}}).find("uppercase") != std::string::npos);
  CHECK(compile_error(law({ir("T-1", "mystery")})) == "T-1: unknown kind 'mystery'");
  CHECK(compile_error(law({ir("T-1", "total_cap")})) == "T-1: cap_cents is required");
  CHECK(compile_error(law({ir("T-1", "expense_cap", {{"expense", "medical"}, {"cap_cents", 5}, {"per", "fortnight"}})})) ==
        "T-1: per must be claim or unit");
  CHECK(compile_error(law({ir("T-1", "expense_cap", {{"expense", "medical"}, {"cap_cents", 5}, {"per", "unit"}})})) ==
        "T-1: a per-unit cap needs a unit");
  CHECK(compile_error(law({ir("T-1", "covered", {{"expense", "groceries"}})})) == "T-1: unknown expense \"groceries\"");
  CHECK(compile_error(law({ir("T-1", "covered", {{"expense", "unknown"}})})) == "T-1: unknown expense \"unknown\"");
  CHECK(compile_error(law({ir("T-1", "covered")})) == "T-1: expense is required");
  CHECK(compile_error(law({ir("T-1", "excluded")})) == "T-1: an exclusion needs an expense or tags");
  CHECK(compile_error(law({ir("T-1", "deadline")})) == "T-1: days is required");
  CHECK(compile_error(law({ir("T-1", "deadline", {{"days", 1.5}})})) == "T-1: days must be an integer");
  CHECK(compile_error(law({ir("T-1", "reporting", {{"required", "yes"}})})) == "T-1: required must be true or false");
  CHECK(compile_error(law({ir("T-1", "minimum_loss", {{"waiver", "sometimes"}})})) == "T-1: unknown waiver 'sometimes'");
  CHECK(compile_error(law({kMed, kMed})) == "IR: duplicate rule id T-MED");
  CHECK(compile_error(law({cap("T-1", "medical", 5, "", {{"alt_rule_ids", {"T-404"}}})})) == "T-1: alt rule T-404 is not in the IR");
  std::vector<json> many;
  for (int i = 0; i < 7; i++) many.push_back(ir("T-X" + std::to_string(i), "excluded", {{"tags", {"tag" + std::to_string(i)}}}));
  CHECK(compile_error(law(many)) == "more than 6 tagged exclusions apply to one expense");
  // A count limit on a per-claim cap has nothing to count.
  std::vector<std::string> notes;
  th::compile(law({cap("T-1", "medical", 5, "", {{"count_limit", 3}})}), &notes);
  CHECK(std::find(notes.begin(), notes.end(), "T-1: count_limit on a per-claim cap has no units to count and is ignored") !=
        notes.end());
}

TEST_CASE("the compiler binds the IR to its verified file") {
  std::string verified = th::read_text(th::kFixtureVerified);
  json doc = json::parse(th::read_text(th::kFixtureIr));
  CHECK(compile_error(doc, verified).empty());
  CHECK(compile_error(doc, verified + " ") == "stale IR: source_sha256 does not match the verified file (rerun rules/tools/normalize.py)");
  json other = doc;
  other["rules"].push_back(ir("ZZ-NOT-VERIFIED", "covered", {{"expense", "legal"}}));
  CHECK(compile_error(other, verified) == "ZZ-NOT-VERIFIED is in the IR but not in the verified file");
  json wrong = doc;
  wrong["jurisdiction"] = "ZY";
  CHECK(compile_error(wrong, verified) == "the IR and the verified file are for different jurisdictions");
}

TEST_CASE("input validation") {
  std::vector<uint8_t> img = th::compile(law({kMed, ir("T-X", "excluded", {{"tags", {"phone"}}})}));
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
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1,"tags":"phone"}]})") ==
        "bad_input: items[0].tags: expected an array");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1,"tags":[1]}]})") ==
        "bad_input: items[0].tags: expected a string");
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1,"tags":null}]})") == "ok");
  CHECK(err(R"({"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","police_report":"maybe"}})") ==
        "bad_input: context.police_report: expected yes, no, or unknown");
  CHECK(err("{" + ctx + "} trailing").find("trailing characters") != std::string::npos);
  CHECK(err("[]").find("expected an object") != std::string::npos);
  CHECK(err("").find("invalid JSON") != std::string::npos);
  CHECK(err("{" + ctx + R"(,"items":[{"item_id":"\ud800","date":"2026-07-01","amount_cents":1}]})").find("surrogate") !=
        std::string::npos);
  CHECK(err("{" + ctx + ",\"extra\":" + std::string(70, '[') + std::string(70, ']') + "}").find("too deep") != std::string::npos);
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

// Real jurisdictions from rules/verified: compile, verify, list, and check every
// scenario against the oracle. Skips quietly when the corpus is absent.
#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

#include "helpers.h"
#include "image.h"
#include "oracle.h"

using th::json;
namespace fs = std::filesystem;

namespace {

std::vector<std::string> corpus_files() {
  std::vector<std::string> out;
  fs::path dir = th::env_or("TEND_RULES_DIR", "../rules/verified");
  std::error_code ec;
  if (!fs::is_directory(dir, ec)) return out;
  for (const auto& e : fs::directory_iterator(dir, ec)) {
    if (e.path().extension() == ".json") out.push_back(e.path().string());
  }
  std::sort(out.begin(), out.end());
  return out;
}

const std::vector<std::string> kAllExpenses = {
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation", "temporary_housing",
    "security", "crime_scene_cleanup", "childcare", "property_replacement", "clothing_bedding", "prescription",
    "dental", "funeral", "legal", "tuition", "other", "unknown"};

json scenario_items() {
  json items = json::array();
  int day = 15;
  for (const auto& e : kAllExpenses) {
    std::string d = "2026-06-" + std::to_string(day);
    items.push_back(th::item("n:" + e + ":1", d, 50000, e, {{"units", 2}, {"insurance_paid_cents", 10000}}));
    items.push_back(th::item("n:" + e + ":2", d, 3000000, e));
    items.push_back(th::item("n:" + e + ":3", "2026-07-0" + std::to_string(1 + day % 9), 12500, e, {{"units", 1}}));
    day = day < 29 ? day + 1 : 15;
  }
  items.push_back(th::item("n:early", "2026-01-02", 4000, "medical"));
  items.push_back(th::item("n:pending", "2026-06-20", 7000, "counseling", {{"confirmed", false}}));
  return items;
}

}  // namespace

TEST_CASE("corpus: verified jurisdictions compile, verify, and match the oracle") {
  std::vector<std::string> files = corpus_files();
  if (files.empty()) {
    MESSAGE("no verified jurisdictions found; set TEND_RULES_DIR to run the corpus test");
    return;
  }
  json items = scenario_items();
  int states = 0, evaluations = 0;
  for (const std::string& path : files) {
    CAPTURE(path);
    std::string bytes = th::read_text(path);
    tend::CompileResult res, again;
    std::string err;
    bool ok = tend::compile_law(bytes, res, err);
    INFO("compile error: " << err);
    REQUIRE(ok);
    REQUIRE(tend::compile_law(bytes, again, err));
    CHECK(res.image == again.image);

    tend::Law law;
    REQUIRE(tend::load_law(res.image.data(), res.image.size(), law, err));
    json doc = json::parse(bytes);
    std::string st = doc["jurisdiction"];
    CHECK(std::string(law.jurisdiction) == st);
    CHECK(law.rules.size() == doc["rules"].size());

    char* listing = tend_disasm(res.image.data(), res.image.size());
    REQUIRE(listing != nullptr);
    CHECK(std::string(listing).rfind("; tend law image " + st, 0) == 0);
    tend_free(listing);
    char* inspect = tend_inspect_json(res.image.data(), res.image.size());
    REQUIRE(inspect != nullptr);
    json info = json::parse(inspect);
    tend_free(inspect);
    CHECK(info["rules"].size() == doc["rules"].size());
    CHECK(info["rules"][0]["quote"] == doc["rules"][0]["quote"]);

    for (const char* as_of : {"2026-10-03", "2045-01-01"}) {
      for (const char* police : {"yes", "no", "unknown"}) {
        for (bool exam : {true, false}) {
          json input = th::claim(items, {{"as_of_date", as_of}, {"police_report", police}, {"forensic_exam", exam}}, st);
          json got = th::strip_sha(th::eval(res.image, input));
          json want = oracle::evaluate(doc, input);
          evaluations++;
          if (got != want) {
            json patch = json::diff(want, got);
            FAIL_CHECK(st << " as_of " << as_of << " police " << police << " exam " << exam << ": "
                          << json(patch.begin(), patch.begin() + std::min<size_t>(6, patch.size())).dump());
          }
        }
      }
    }
    states++;
  }
  MESSAGE(states << " jurisdictions, " << evaluations << " scenario evaluations");
}

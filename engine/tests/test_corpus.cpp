// Real jurisdictions: each rules/ir/ST.json with its rules/verified/ST.json is
// compiled, verified, listed, and checked against the oracle on a spread of
// scenarios. Skips quietly when the corpus is absent; stale IR (its
// source_sha256 no longer matches the verified file) is reported, not tested.
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

const std::vector<std::string> kAllExpenses = {
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation", "temporary_housing",
    "security", "crime_scene_cleanup", "childcare", "property_replacement", "clothing_bedding", "prescription",
    "dental", "funeral", "legal", "tuition", "other", "unknown"};

json scenario_items() {
  json items = json::array();
  int day = 15;
  json tag_sets = json::array({json::array(), json::array({"phone"}), json::array({"pain_suffering", "cash"}),
                               json::array({"purse", "vehicle", "jewelry"})});
  size_t t = 0;
  for (const auto& e : kAllExpenses) {
    std::string d = "2026-06-" + std::to_string(day);
    items.push_back(th::item("n:" + e + ":1", d, 50000, e, {{"units", 2}, {"insurance_paid_cents", 10000}}));
    items.push_back(th::item("n:" + e + ":2", d, 3000000, e, {{"tags", tag_sets[t++ % 4]}}));
    items.push_back(th::item("n:" + e + ":3", "2026-07-0" + std::to_string(1 + day % 9), 12500, e,
                             {{"units", 1}, {"tags", tag_sets[t++ % 4]}}));
    items.push_back(th::item("n:" + e + ":4", "2026-07-1" + std::to_string(day % 9), 9000, e, {{"units", 40}}));
    day = day < 29 ? day + 1 : 15;
  }
  items.push_back(th::item("n:early", "2026-01-02", 4000, "medical"));
  items.push_back(th::item("n:pending", "2026-06-20", 7000, "counseling", {{"confirmed", false}}));
  return items;
}

}  // namespace

TEST_CASE("corpus: real jurisdictions compile, verify, and match the oracle") {
  fs::path ir_dir = th::env_or("TEND_IR_DIR", "../rules/ir");
  fs::path verified_dir = th::env_or("TEND_RULES_DIR", "../rules/verified");
  std::error_code ec;
  std::vector<fs::path> files;
  if (fs::is_directory(ir_dir, ec)) {
    for (const auto& e : fs::directory_iterator(ir_dir, ec)) {
      if (e.path().extension() == ".json") files.push_back(e.path());
    }
  }
  std::sort(files.begin(), files.end());
  if (files.empty()) {
    MESSAGE("no law IR found in " << ir_dir.string() << "; set TEND_IR_DIR and TEND_RULES_DIR to run the corpus test");
    return;
  }
  json items = scenario_items();
  int states = 0, evaluations = 0;
  std::vector<std::string> stale, unpaired;
  for (const fs::path& path : files) {
    CAPTURE(path.string());
    std::string ir_bytes = th::read_text(path.string());
    std::string verified = th::read_text((verified_dir / path.filename()).string());
    if (verified.empty()) {
      unpaired.push_back(path.stem().string());
      continue;
    }
    tend::CompileResult res, again;
    std::string err;
    if (!tend::compile_law(ir_bytes, verified, res, err)) {
      if (err.rfind("stale IR", 0) == 0) {
        stale.push_back(path.stem().string());
        continue;
      }
      FAIL_CHECK("compile error: " << err);
      continue;
    }
    REQUIRE(tend::compile_law(ir_bytes, verified, again, err));
    CHECK(res.image == again.image);

    tend::Law law;
    REQUIRE(tend::load_law(res.image.data(), res.image.size(), law, err));
    json doc = json::parse(ir_bytes);
    std::string st = doc["jurisdiction"];
    CHECK(std::string(law.jurisdiction) == st);
    CHECK(law.rules.size() == doc["rules"].size() + doc["skipped"].size());

    char* listing = tend_disasm(res.image.data(), res.image.size());
    REQUIRE(listing != nullptr);
    CHECK(std::string(listing).rfind("; tend law image " + st, 0) == 0);
    tend_free(listing);
    char* inspect = tend_inspect_json(res.image.data(), res.image.size());
    REQUIRE(inspect != nullptr);
    json info = json::parse(inspect);
    tend_free(inspect);
    json vdoc = json::parse(verified);
    for (const auto& r : info["rules"]) {
      if (r["quote"].get<std::string>().empty()) FAIL_CHECK(st << " " << r["id"] << " has no quote in the image");
    }
    CHECK(info["rules"][0]["quote"] == [&] {
      for (const auto& v : vdoc["rules"]) {
        if (v["id"] == info["rules"][0]["id"]) return v["quote"];
      }
      return json(nullptr);
    }());

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
  std::string stale_list;
  for (const auto& s : stale) stale_list += " " + s;
  MESSAGE(states << " jurisdictions, " << evaluations << " scenario evaluations; " << stale.size()
                 << " stale IR files skipped:" << stale_list << "; " << unpaired.size() << " without a verified file");
}

// Real jurisdictions: each rules/ir/ST.json with its rules/verified/ST.json is
// compiled, verified, listed, and checked against the oracle on a spread of
// scenarios. Skips quietly when the corpus is absent; stale IR (its
// source_sha256 no longer matches the verified file) is reported, not tested.
#include <algorithm>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "helpers.h"
#include "image.h"
#include "oracle.h"
#include "sha256.h"

using th::json;
namespace fs = std::filesystem;

namespace {

const std::vector<std::string> kAllExpenses = {
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation", "temporary_housing",
    "security", "crime_scene_cleanup", "childcare", "property_replacement", "clothing_bedding", "prescription",
    "dental", "funeral", "legal", "tuition", "other", "unknown"};

// Every expense, with units of every kind, so each unit cap meets lines it
// measures and lines it cannot.
json scenario_items() {
  const std::vector<std::string> units = {"session", "week", "hour", "mile", "day", "month", "item"};
  json items = json::array();
  int day = 15;
  size_t u = 0;
  json tag_sets = json::array({json::array(), json::array({"phone"}), json::array({"pain_suffering", "cash"}),
                               json::array({"purse", "vehicle", "jewelry"})});
  size_t t = 0;
  for (const auto& e : kAllExpenses) {
    std::string d = "2026-06-" + std::to_string(day);
    items.push_back(th::item("n:" + e + ":1", d, 50000, e,
                             {{"units", 2}, {"unit", units[u++ % units.size()]}, {"insurance_paid_cents", 10000}}));
    items.push_back(th::item("n:" + e + ":2", d, 3000000, e, {{"tags", tag_sets[t++ % 4]}}));
    items.push_back(th::item("n:" + e + ":3", "2026-07-0" + std::to_string(1 + day % 9), 12500, e,
                             {{"units", 1}, {"unit", units[u++ % units.size()]}, {"tags", tag_sets[t++ % 4]}}));
    items.push_back(th::item("n:" + e + ":4", "2026-07-1" + std::to_string(day % 9), 9000, e,
                             {{"units", 40}, {"unit", units[u++ % units.size()]}}));
    items.push_back(th::item("n:" + e + ":5", "2026-08-0" + std::to_string(1 + day % 9), 70000, e, {{"units", 3}}));
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
    std::string text(listing);
    tend_free(listing);
    CHECK(text.rfind("; tend law image " + st, 0) == 0);
    // Real quotes carry line breaks (mailing addresses); none may break a listing line.
    size_t bad_lines = 0;
    for (size_t at = 0; at < text.size();) {
      size_t nl = text.find('\n', at);
      if (nl == std::string::npos) nl = text.size();
      if (nl > at && text[at] != ' ' && text[at] != '.' && text[at] != ';') bad_lines++;
      at = nl + 1;
    }
    CHECK_MESSAGE(bad_lines == 0, st << " listing has " << bad_lines << " stray lines");
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

// The browser evaluates claims with the images in web/public/engine/laws, so
// they must be exactly what tendc builds from the rules now. A rules change
// (even a new source hash) without `make wasm` fails here instead of shipping
// an image that no longer matches its verified file. `make test` sets
// TEND_SHIPPED_DIR only for the default corpus.
TEST_CASE("corpus: the law images shipped to the browser are the ones tendc builds now") {
  fs::path shipped = th::env_or("TEND_SHIPPED_DIR", "");
  if (shipped.empty()) {
    MESSAGE("TEND_SHIPPED_DIR is not set; shipped law images not checked");
    return;
  }
  fs::path laws_dir = shipped / "laws";
  fs::path ir_dir = th::env_or("TEND_IR_DIR", "../rules/ir");
  fs::path verified_dir = th::env_or("TEND_RULES_DIR", "../rules/verified");
  std::error_code ec;
  REQUIRE_MESSAGE(fs::is_directory(laws_dir, ec), laws_dir.string() << " is missing; run make wasm");

  std::string index_text = th::read_text((laws_dir / "index.json").string());
  REQUIRE_MESSAGE(!index_text.empty(), "laws/index.json is missing; run make wasm");
  json index = json::parse(index_text);
  CHECK(index["engine"] == tend_version());
  std::map<std::string, json> listed;
  for (const auto& e : index["laws"]) listed[e["file"].get<std::string>()] = e;

  std::set<std::string> on_disk;
  for (const auto& e : fs::directory_iterator(laws_dir, ec)) {
    if (e.path().extension() == ".tlaw") on_disk.insert(e.path().filename().string());
  }
  CHECK(listed.size() == on_disk.size());

  int current = 0;
  std::vector<std::string> stale;
  for (const auto& e : fs::directory_iterator(ir_dir, ec)) {
    if (e.path().extension() != ".json") continue;
    std::string st = e.path().stem().string();
    CAPTURE(st);
    std::string verified = th::read_text((verified_dir / e.path().filename()).string());
    if (verified.empty()) continue;
    tend::CompileResult res;
    std::string err;
    if (!tend::compile_law(th::read_text(e.path().string()), verified, res, err)) {
      if (err.rfind("stale IR", 0) == 0) stale.push_back(st);
      else FAIL_CHECK("compile error: " << err);
      continue;
    }
    std::string file = st + ".tlaw";
    std::string image = th::read_text((laws_dir / file).string());
    std::vector<uint8_t> bytes(image.begin(), image.end());
    CHECK_MESSAGE(bytes == res.image, "web/public/engine/laws/" << file
                                           << " is not what tendc builds from the rules now; run make wasm");
    auto it = listed.find(file);
    if (it == listed.end()) {
      FAIL_CHECK("laws/index.json does not list " << file << "; run make wasm");
      continue;
    }
    const json& entry = it->second;
    tend::Law law;
    REQUIRE(tend::load_law(res.image.data(), res.image.size(), law, err));
    CHECK(entry["jurisdiction"] == st);
    CHECK(entry["bytes"] == res.image.size());
    CHECK(entry["rules"] == law.rules.size());
    CHECK(entry["law_image_sha256"] == tend::to_hex(law.image_sha256, 32));
    CHECK(entry["source_sha256"] == tend::to_hex(law.source_sha256, 32));
    on_disk.erase(file);
    current++;
  }
  std::string extra;
  for (const auto& f : on_disk) extra += " " + f;
  CHECK_MESSAGE(on_disk.empty(), "shipped images with no current IR (missing or stale; rerun rules/tools/normalize.py "
                                 "and make wasm):"
                                     << extra);
  std::string stale_list;
  for (const auto& s : stale) stale_list += " " + s;
  MESSAGE(current << " shipped law images match a fresh compile; stale IR not checked:" << stale_list);
}

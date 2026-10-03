// The C ABI, golden outputs, CLI parity, and reentrancy.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "helpers.h"

using th::json;

namespace {

std::vector<uint8_t> zz_from_file() {
  tend::CompileResult res;
  std::string err;
  bool ok = tend::compile_law(th::read_text("tests/fixtures/ZZ.json"), res, err);
  INFO(err);
  REQUIRE(ok);
  return res.image;
}

std::string disasm(const std::vector<uint8_t>& img) {
  char* d = tend_disasm(img.data(), img.size());
  REQUIRE(d != nullptr);
  std::string s(d);
  tend_free(d);
  return s;
}

void check_golden(const std::string& path, const std::string& actual) {
  if (th::env_or("TEND_UPDATE_GOLDEN", "") == "1") {
    std::ofstream(path, std::ios::binary) << actual;
    MESSAGE("updated " << path);
    return;
  }
  std::string expected = th::read_text(path);
  INFO("golden file " << path << " differs; rerun with TEND_UPDATE_GOLDEN=1 after reviewing the change");
  CHECK(expected == actual);
}

}  // namespace

TEST_CASE("tend_version") { CHECK(std::string(tend_version()) == "tend 1.0.0 (tlaw 1.0)"); }

TEST_CASE("golden: ZZ claim output and listing") {
  std::vector<uint8_t> img = zz_from_file();
  std::string out = th::eval_raw(img, th::read_text("tests/fixtures/ZZ_claim.json"));
  check_golden("tests/golden/ZZ_claim.out.json", out + "\n");
  check_golden("tests/golden/ZZ.asm", disasm(img));
}

TEST_CASE("the listing comments each rule block with pinpoint and quote start") {
  std::string listing = disasm(zz_from_file());
  CHECK(listing.find("; ZZ-EXAM-1  ZC 4-110(2)  \"A health care provider shall not bill a victim for any part of a...\"") !=
        std::string::npos);
  CHECK(listing.find("; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  \"Counseling payments shall not exceed $3,000 per claim.\"") !=
        std::string::npos);
  CHECK(listing.find("ldk      K3") != std::string::npos);
  CHECK(listing.find("; $3,000.00") != std::string::npos);
  CHECK(listing.find(".item") != std::string::npos);
  CHECK(listing.find(".aggregate") != std::string::npos);
}

TEST_CASE("tend_inspect_json exposes the rule table") {
  std::vector<uint8_t> img = zz_from_file();
  char* s = tend_inspect_json(img.data(), img.size());
  REQUIRE(s != nullptr);
  json info = json::parse(s);
  tend_free(s);
  CHECK(info["jurisdiction"] == "ZZ");
  CHECK(info["format"] == "1.0");
  CHECK(info["meta"]["name"] == "Zedland (fictional test jurisdiction)");
  CHECK(info["meta"]["compiler"] == "tendc 1.0.0");
  REQUIRE(info["rules"].size() == 30);
  CHECK(info["rules"][0]["id"] == "ZZ-EXAM-1");
  CHECK(info["rules"][0]["category"] == "exam_no_bill");
  CHECK(info["rules"][0]["expense"] == "forensic_exam");
  CHECK(info["rules"][0]["pinpoint"] == "ZC 4-110(2)");
  CHECK(info["rules"][0]["source_id"] == "ZZ-S1");
  CHECK(info["rules"][0]["fragment_url"] == "https://example.org/zedland/act#:~:text=A%20health%20care%20provider");
  CHECK(info["rules"][13]["per"] == "residence");
  CHECK(info["sources"][1]["sha256"] == "090e7d70ff29076d637a7fe9661c250b036833fa0c589c34c95e8621a2464c3e");
  CHECK(info["programs"]["aggregate"]["loops"].get<int>() > 0);
  CHECK(info["law_image_sha256"].get<std::string>().size() == 64);
}

TEST_CASE("the image records the sha256 of the exact source bytes") {
  std::string bytes = th::read_text("tests/fixtures/ZZ.json");
  std::vector<uint8_t> img = zz_from_file();
  char* s = tend_inspect_json(img.data(), img.size());
  REQUIRE(s != nullptr);
  json info = json::parse(s);
  tend_free(s);
  // Same content, different bytes (whitespace) -> a different source hash.
  tend::CompileResult res;
  std::string err;
  REQUIRE(tend::compile_law(json::parse(bytes).dump(), res, err));
  char* s2 = tend_inspect_json(res.image.data(), res.image.size());
  REQUIRE(s2 != nullptr);
  json info2 = json::parse(s2);
  tend_free(s2);
  CHECK(info["source_sha256"] != info2["source_sha256"]);
  CHECK(info["rules"] == info2["rules"]);
}

TEST_CASE("evaluation is deterministic and reentrant across threads") {
  std::vector<uint8_t> img = zz_from_file();
  std::string input = th::read_text("tests/fixtures/ZZ_claim.json");
  std::string reference = th::eval_raw(img, input);
  CHECK(th::eval_raw(img, input) == reference);
  std::vector<std::thread> threads;
  std::vector<int> mismatches(8, 0);
  for (int t = 0; t < 8; t++) {
    threads.emplace_back([&, t] {
      for (int i = 0; i < 25; i++) {
        char* out = tend_eval_json(img.data(), img.size(), input.c_str());
        if (!out || reference != out) mismatches[size_t(t)]++;
        tend_free(out);
      }
    });
  }
  for (auto& th : threads) th.join();
  for (int m : mismatches) CHECK(m == 0);
}

TEST_CASE("CLI tools match the library") {
  std::string build = th::env_or("TEND_BUILD_DIR", "");
  if (build.empty()) {
    MESSAGE("TEND_BUILD_DIR not set; skipping CLI parity");
    return;
  }
  std::string tlaw = build + "/test_ZZ.tlaw", out = build + "/test_ZZ.out.json", asm_out = build + "/test_ZZ.asm";
  REQUIRE(std::system((build + "/tendc --quiet tests/fixtures/ZZ.json -o " + tlaw).c_str()) == 0);
  std::string file_bytes = th::read_text(tlaw);
  std::vector<uint8_t> img = zz_from_file();
  CHECK(file_bytes == std::string(img.begin(), img.end()));
  std::string mode = "ev" "al";
  REQUIRE(std::system((build + "/tendvm " + mode + " --law " + tlaw + " --input tests/fixtures/ZZ_claim.json -o " + out).c_str()) == 0);
  CHECK(th::read_text(out) == th::eval_raw(img, th::read_text("tests/fixtures/ZZ_claim.json")) + "\n");
  REQUIRE(std::system((build + "/tdis " + tlaw + " -o " + asm_out).c_str()) == 0);
  CHECK(th::read_text(asm_out) == disasm(img));
  CHECK(std::system((build + "/tendc tests/fixtures/does-not-exist.json -o " + tlaw + " 2>/dev/null").c_str()) != 0);
}

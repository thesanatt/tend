// The C ABI, golden outputs, CLI parity, and reentrancy.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "helpers.h"
#include "sha256.h"

using th::json;

namespace {

std::string disasm(const std::vector<uint8_t>& img) {
  char* d = tend_disasm(img.data(), img.size());
  REQUIRE(d != nullptr);
  std::string s(d);
  tend_free(d);
  return s;
}

json inspect(const std::vector<uint8_t>& img) {
  char* s = tend_inspect_json(img.data(), img.size());
  REQUIRE(s != nullptr);
  json info = json::parse(s);
  tend_free(s);
  return info;
}

std::string sha_hex(const std::string& bytes) {
  uint8_t d[32];
  tend::sha256(bytes.data(), bytes.size(), d);
  return tend::to_hex(d, 32);
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

TEST_CASE("tend_version") { CHECK(std::string(tend_version()) == "tend 1.3.0 (tlaw 1.3)"); }

TEST_CASE("golden: ZZ claim output and listing") {
  std::vector<uint8_t> img = th::compile_fixture();
  std::string out = th::eval_raw(img, th::read_text(th::kFixtureClaim));
  check_golden("tests/golden/ZZ_claim.out.json", out + "\n");
  check_golden("tests/golden/ZZ.asm", disasm(img));
}

TEST_CASE("the listing comments each rule block with pinpoint and quote start") {
  std::string listing = disasm(th::compile_fixture());
  CHECK(listing.find("; ZZ-EXAM-1  ZC 4-110(2)  \"A health care provider shall not bill a victim for any part of a...\"") !=
        std::string::npos);
  CHECK(listing.find("; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  \"Counseling payments shall not exceed $3,000 per claim.\"") !=
        std::string::npos);
  CHECK(listing.find("; $3,000.00") != std::string::npos);
  CHECK(listing.find(".tags   phone=bit0, purse=bit1, pain_suffering=bit2") != std::string::npos);
  CHECK(listing.find("less generous duplicate of ZZ-COUNSEL-CAP-1") != std::string::npos);
  CHECK(listing.find(".item") != std::string::npos);
  CHECK(listing.find(".aggregate") != std::string::npos);
}

TEST_CASE("line breaks inside a quote or pinpoint stay on the rule's comment line") {
  // Mailing addresses on application forms are quoted with their line breaks.
  json verified = json::parse(th::read_text(th::kFixtureVerified));
  for (json& r : verified["rules"]) {
    if (r["id"] == "ZZ-EXAM-1") {
      r["quote"] = "Mail to:\n\nZZ Program\r\nP.O. Box 1\tCapital City";
      r["pinpoint"] = "Form 1,\npage 2";
    }
  }
  std::string verified_text = verified.dump(1);
  uint8_t sha[32];
  tend::sha256(verified_text.data(), verified_text.size(), sha);
  json doc = json::parse(th::read_text(th::kFixtureIr));
  doc["source_sha256"] = tend::to_hex(sha, 32);
  tend::CompileResult res;
  std::string err;
  REQUIRE_MESSAGE(tend::compile_law(doc.dump(), verified_text, res, err), err);
  std::string listing = disasm(res.image);
  CHECK(listing.find("; ZZ-EXAM-1  Form 1, page 2  \"Mail to: ZZ Program P.O. Box 1 Capital City\"") != std::string::npos);
  std::istringstream lines(listing);
  for (std::string l; std::getline(lines, l);) {
    INFO(l);
    CHECK((l.empty() || l[0] == ' ' || l[0] == '.' || l[0] == ';'));
    CHECK(l.find('\t') == std::string::npos);
    CHECK(l.find('\r') == std::string::npos);
  }
  // inspect keeps the quote verbatim; only the listing flattens it.
  json info = inspect(res.image);
  for (const json& r : info["rules"]) {
    if (r["id"] == "ZZ-EXAM-1") CHECK(r["quote"] == "Mail to:\n\nZZ Program\r\nP.O. Box 1\tCapital City");
  }
}

TEST_CASE("tend_inspect_json exposes the rule table") {
  json info = inspect(th::compile_fixture());
  json ir = json::parse(th::read_text(th::kFixtureIr));
  CHECK(info["jurisdiction"] == "ZZ");
  CHECK(info["format"] == "1.3");
  CHECK(info["meta"]["name"] == "Zedland (fictional test jurisdiction)");
  CHECK(info["meta"]["compiler"] == "tendc 1.3.0");
  REQUIRE(info["rules"].size() == ir["rules"].size() + ir["skipped"].size());
  const json& exam = info["rules"][0];
  CHECK(exam["id"] == "ZZ-EXAM-1");
  CHECK(exam["kind"] == "exam_no_bill");
  CHECK(exam["category"] == "exam_no_bill");
  CHECK(exam["pinpoint"] == "ZC 4-110(2)");
  CHECK(exam["quote"] == "A health care provider shall not bill a victim for any part of a sexual assault forensic examination.");
  CHECK(exam["source_id"] == "ZZ-S1");
  CHECK(exam["fragment_url"] == "https://example.org/zedland/act#:~:text=A%20health%20care%20provider");
  json by_id = json::object();
  for (const auto& r : info["rules"]) by_id[r["id"].get<std::string>()] = r;
  CHECK(by_id["ZZ-COUNSEL-CAP-1"]["per"] == "unit");
  CHECK(by_id["ZZ-COUNSEL-CAP-1"]["unit"] == "session");
  CHECK(by_id["ZZ-COUNSEL-CAP-1"]["expense"] == "counseling");
  CHECK(by_id["ZZ-SECURITY-CAP-1"]["per"] == "claim");
  CHECK(by_id["ZZ-SUBMIT-1"]["kind"] == "info");
  CHECK(by_id["ZZ-SUBMIT-1"]["category"] == "submission");
  CHECK(by_id["ZZ-COUNSEL-FAMILY-1"]["kind"] == "skipped");
  CHECK(by_id["ZZ-COUNSEL-FAMILY-1"]["skip_reason"] == "applies_to \"family members of the victim\"");
  CHECK(info["tags"] == json({"phone", "purse", "pain_suffering"}));
  CHECK(info["sources"][1]["sha256"] == "090e7d70ff29076d637a7fe9661c250b036833fa0c589c34c95e8621a2464c3e");
  CHECK(info["programs"]["aggregate"]["loops"].get<int>() > 0);
  CHECK(info["law_image_sha256"].get<std::string>().size() == 64);
}

TEST_CASE("the image records which verified file and IR it came from") {
  json info = inspect(th::compile_fixture());
  CHECK(info["source_sha256"] == sha_hex(th::read_text(th::kFixtureVerified)));
  CHECK(info["meta"]["ir_sha256"] == sha_hex(th::read_text(th::kFixtureIr)));
  CHECK(info["source_sha256"] == json::parse(th::read_text(th::kFixtureIr))["source_sha256"]);
  // Without the verified file the image still runs, with the IR's declared hash and no quotes.
  tend::CompileResult res;
  std::string err;
  REQUIRE(tend::compile_law(th::read_text(th::kFixtureIr), "", res, err));
  json bare = inspect(res.image);
  CHECK(bare["source_sha256"] == info["source_sha256"]);
  CHECK(bare["rules"][0]["quote"] == "");
  json a = th::strip_sha(th::eval(res.image, json::parse(th::read_text(th::kFixtureClaim))));
  json b = th::strip_sha(th::eval(th::compile_fixture(), json::parse(th::read_text(th::kFixtureClaim))));
  CHECK(a == b);
}

TEST_CASE("evaluation is deterministic and reentrant across threads") {
  std::vector<uint8_t> img = th::compile_fixture();
  std::string input = th::read_text(th::kFixtureClaim);
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
  REQUIRE(std::system((build + "/tendc --quiet " + th::kFixtureIr + " -o " + tlaw).c_str()) == 0);
  std::string file_bytes = th::read_text(tlaw);
  std::vector<uint8_t> img = th::compile_fixture();
  CHECK(file_bytes == std::string(img.begin(), img.end()));
  std::string mode = "ev" "al";
  REQUIRE(std::system((build + "/tendvm " + mode + " --law " + tlaw + " --input " + th::kFixtureClaim + " -o " + out).c_str()) == 0);
  CHECK(th::read_text(out) == th::eval_raw(img, th::read_text(th::kFixtureClaim)) + "\n");
  REQUIRE(std::system((build + "/tdis " + tlaw + " -o " + asm_out).c_str()) == 0);
  CHECK(th::read_text(asm_out) == disasm(img));
  CHECK(std::system((build + "/tendc tests/fixtures/does-not-exist.json -o " + tlaw + " 2>/dev/null").c_str()) != 0);
  CHECK(std::system((build + "/tendc " + th::kFixtureIr + " --verified " + th::kFixtureClaim + " -o " + tlaw + " 2>/dev/null").c_str()) != 0);
}

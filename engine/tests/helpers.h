#pragma once

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "compiler.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"
#include "tend/tend.h"

namespace th {

using json = nlohmann::json;

inline std::string read_text(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}

inline std::string env_or(const char* name, const std::string& fallback) {
  const char* v = std::getenv(name);
  return v && *v ? v : fallback;
}

inline std::vector<uint8_t> compile(const json& law, std::vector<std::string>* warnings = nullptr) {
  tend::CompileResult res;
  std::string err;
  bool ok = tend::compile_law(law.dump(), res, err);
  INFO("compile error: " << err);
  REQUIRE(ok);
  if (warnings) *warnings = res.warnings;
  return res.image;
}

inline std::string eval_raw(const std::vector<uint8_t>& img, const std::string& input) {
  char* out = tend_eval_json(img.data(), img.size(), input.c_str());
  REQUIRE(out != nullptr);
  std::string s(out);
  tend_free(out);
  return s;
}

inline json eval(const std::vector<uint8_t>& img, const json& input) {
  return json::parse(eval_raw(img, input.dump()));
}

inline json run(const json& law, const json& input) { return eval(compile(law), input); }

// Builders for small hand-written jurisdictions and claims.
inline json rule(const std::string& id, const std::string& category, const std::string& expense = "",
                 json params = json::object()) {
  json r = {{"id", id},
            {"category", category},
            {"params", params},
            {"summary", "test rule"},
            {"quote", "Quote for " + id + "."},
            {"source_id", "T-S1"},
            {"pinpoint", "Test Code " + id}};
  if (!expense.empty()) r["expense"] = expense;
  return r;
}

inline json law(const std::vector<json>& rules, const std::string& st = "ZZ") {
  return {{"jurisdiction", st},
          {"name", "Test"},
          {"sources", json::array({{{"id", "T-S1"},
                                    {"url", "https://example.org/t"},
                                    {"title", "Test source"},
                                    {"sha256", std::string(64, 'a')}}})},
          {"rules", rules}};
}

inline json item(const std::string& id, const std::string& date, int64_t amount, const std::string& expense,
                 json extra = json::object()) {
  json it = {{"item_id", id}, {"date", date}, {"amount_cents", amount}, {"expense", expense}, {"confirmed", true}};
  for (auto& [k, v] : extra.items()) it[k] = v;
  return it;
}

inline json claim(const std::vector<json>& items, json ctx = json::object(), const std::string& st = "ZZ") {
  json c = {{"incident_date", "2026-06-14"}, {"as_of_date", "2026-10-03"}, {"police_report", "no"}, {"forensic_exam", true}};
  for (auto& [k, v] : ctx.items()) c[k] = v;
  return {{"jurisdiction", st}, {"context", c}, {"items", items}};
}

inline const json& line(const json& out, const std::string& id) {
  for (const auto& l : out["lines"]) {
    if (l["item_id"] == id) return l;
  }
  FAIL("no line " << id);
  static json none;
  return none;
}

inline json strip_sha(json out) {
  out.erase("law_image_sha256");
  return out;
}

}  // namespace th

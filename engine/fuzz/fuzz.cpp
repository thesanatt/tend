// Coverage-guided mutation fuzzer for the loader, the VM, the input parser,
// and the compiler. Apple clang ships no libFuzzer runtime, so this driver
// implements the SanitizerCoverage trace-pc-guard callbacks itself and keeps
// any input that reaches new code. Build and run with `make fuzz`.
//
// Targets:
//   image     raw image bytes -> load, list, inspect, evaluate
//   resealed  same, with the checksum recomputed so mutations reach the verifier
//   input     claim JSON against a valid law image
//   compile   law JSON -> tendc; anything that compiles must load and evaluate
//             without a VM trap
// Every output document must be valid JSON. Crashes, sanitizer reports, and
// property violations write the input to <corpus>/crash-*.bin.
#include <sanitizer/common_interface_defs.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include "builder.h"
#include "compiler.h"
#include "disasm.h"
#include "image.h"
#include "json.h"
#include "nlohmann/json.hpp"
#include "sha256.h"
#include "tend/tend.h"

namespace fs = std::filesystem;
using Bytes = std::vector<uint8_t>;

// ---- coverage ---------------------------------------------------------------

static uint32_t g_guards = 0;
static uint8_t* g_seen = nullptr;
static uint64_t g_new_edges = 0;
static uint64_t g_edges = 0;

extern "C" void __sanitizer_cov_trace_pc_guard_init(uint32_t* start, uint32_t* stop) {
  if (start == stop || *start) return;
  uint32_t first = g_guards + 1;
  for (uint32_t* x = start; x < stop; x++) *x = ++g_guards;
  g_seen = static_cast<uint8_t*>(std::realloc(g_seen, g_guards + 1));
  std::memset(g_seen + first, 0, g_guards + 1 - first);
  g_seen[0] = 0;
}

extern "C" void __sanitizer_cov_trace_pc_guard(uint32_t* guard) {
  uint32_t g = *guard;
  if (g && !g_seen[g]) {
    g_seen[g] = 1;
    g_new_edges++;
    g_edges++;
  }
}

// ---- crash capture ----------------------------------------------------------

static const Bytes* g_current = nullptr;
static const char* g_current_target = "";
static std::string g_out_dir = "build/fuzz/corpus";

static void dump_current() {
  if (!g_current) return;
  char path[1024];
  std::snprintf(path, sizeof path, "%s/crash-%s-%08x.bin", g_out_dir.c_str(), g_current_target,
                unsigned(std::chrono::steady_clock::now().time_since_epoch().count()));
  if (std::FILE* f = std::fopen(path, "wb")) {
    std::fwrite(g_current->data(), 1, g_current->size(), f);
    std::fclose(f);
    std::fprintf(stderr, "fuzz: input written to %s\n", path);
  }
}

[[noreturn]] static void property_failure(const std::string& what) {
  std::fprintf(stderr, "fuzz: PROPERTY VIOLATION in %s: %s\n", g_current_target, what.c_str());
  dump_current();
  std::abort();
}

// ---- randomness and mutation ------------------------------------------------

struct Rng {
  uint64_t s;
  uint64_t next() {
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    return s;
  }
  size_t below(size_t n) { return n ? size_t(next() % n) : 0; }
  bool chance(int pct) { return int(next() % 100) < pct; }
};

static const uint32_t kInteresting32[] = {0, 1, 2, 7, 8, 0x7F, 0x80, 0xFF, 0x100, 0x7FFF, 0x8000, 0xFFFF,
                                          0x10000, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFE, 0xFFFFFFFF};

static void mutate_bytes(Bytes& b, Rng& r, const Bytes& other, size_t lo, size_t hi, size_t max_len) {
  if (hi > b.size()) hi = b.size();
  if (lo >= hi) {
    lo = 0;
    hi = b.size();
  }
  // Earlier operations may have shrunk the buffer, so clamp on every use.
  auto pos = [&]() {
    size_t h = std::min(hi, b.size()), l = std::min(lo, h);
    return h > l ? l + r.below(h - l) : 0;
  };
  int ops = 1 + int(r.below(4));
  for (int k = 0; k < ops; k++) {
    switch (r.below(10)) {
      case 0:
        if (!b.empty()) b[pos()] ^= uint8_t(1u << r.below(8));
        break;
      case 1:
        if (!b.empty()) b[pos()] = uint8_t(r.next());
        break;
      case 2:
        if (b.size() >= 4) {
          size_t p = std::min(pos(), b.size() - 4);
          uint32_t v = kInteresting32[r.below(sizeof kInteresting32 / 4)];
          for (int i = 0; i < 4; i++) b[p + size_t(i)] = uint8_t(v >> (8 * i));
        }
        break;
      case 3:
        if (b.size() >= 2) {
          size_t p = std::min(pos(), b.size() - 2);
          uint16_t v = uint16_t(kInteresting32[r.below(sizeof kInteresting32 / 4)]);
          b[p] = uint8_t(v);
          b[p + 1] = uint8_t(v >> 8);
        }
        break;
      case 4:
        if (!b.empty()) {
          size_t p = pos();
          uint32_t v = uint32_t(b[p]) + uint32_t(r.below(9)) - 4;
          b[p] = uint8_t(v);
        }
        break;
      case 5:
        if (b.size() < max_len) b.insert(b.begin() + long(pos()), uint8_t(r.next()));
        break;
      case 6:
        if (!b.empty()) {
          size_t p = pos(), n = 1 + r.below(std::min<size_t>(16, b.size() - p));
          b.erase(b.begin() + long(p), b.begin() + long(p + n));
        }
        break;
      case 7:
        if (!b.empty() && b.size() < max_len) {
          size_t from = r.below(b.size()), n = 1 + r.below(std::min<size_t>(32, b.size() - from));
          Bytes chunk(b.begin() + long(from), b.begin() + long(from + n));
          b.insert(b.begin() + long(pos()), chunk.begin(), chunk.end());
        }
        break;
      case 8:
        if (!other.empty() && !b.empty()) {
          size_t from = r.below(other.size()), n = 1 + r.below(std::min<size_t>(64, other.size() - from));
          size_t p = pos();
          for (size_t i = 0; i < n && p + i < b.size(); i++) b[p + i] = other[from + i];
        }
        break;
      default:
        if (b.size() > 8 && r.chance(30)) b.resize(r.below(b.size()));
        break;
    }
  }
  if (b.size() > max_len) b.resize(max_len);
}

// Picks a node anywhere in the document and replaces, deletes, or duplicates it.
static void mutate_json(nlohmann::json& doc, Rng& r) {
  using nlohmann::json;
  static const std::vector<json> kPalette = {
      0, 1, -1, 2, 7, 100, 10000, 2500000, INT64_MAX, INT64_MIN, 1000000000000000LL, 1000000000000001LL, 0.5, 1e300,
      "", "claim", "week", "session", "residence", "month", "forensic_exam", "medical", "counseling", "unknown",
      "sexual_assault", "exam_no_bill", "expense_cap", "total_cap", "minimum_loss", "filing_deadline",
      "reporting_requirement", "covered_expense", "excluded_expense", "collateral_source", "2026-02-29", "2024-02-29",
      "9999-12-31", "0001-01-01", "2026-06-14", "yes", "no", true, false, nullptr, json::array(), json::object(),
      json::array({"forensic_exam", "advocate"}), json::array({"sexual_assault"}), "\xC3\xA9\\u0000\"",
      std::string(300, 'x')};
  std::vector<json::json_pointer> paths;
  std::vector<json::json_pointer> stack = {json::json_pointer()};
  while (!stack.empty() && paths.size() < 4000) {
    json::json_pointer p = stack.back();
    stack.pop_back();
    paths.push_back(p);
    const json& v = doc.at(p);
    if (v.is_object()) {
      for (auto& [k, _] : v.items()) stack.push_back(p / k);
    } else if (v.is_array()) {
      for (size_t i = 0; i < v.size(); i++) stack.push_back(p / i);
    }
  }
  if (paths.size() <= 1) return;
  json::json_pointer target = paths[1 + r.below(paths.size() - 1)];
  json::json_pointer parent = target.parent_pointer();
  json& par = doc.at(parent);
  switch (r.below(5)) {
    case 0:
    case 1: doc.at(target) = kPalette[r.below(kPalette.size())]; break;
    case 2:
      if (par.is_object()) par.erase(target.back());
      else if (par.is_array()) par.erase(par.begin() + long(std::stoul(target.back())));
      break;
    case 3:
      if (par.is_array() && par.size() < 200) par.push_back(doc.at(target));
      break;
    default: doc.at(target) = doc.at(paths[r.below(paths.size())]); break;
  }
}

// ---- targets ----------------------------------------------------------------

static Bytes g_law;           // a valid image for the input target
static std::string g_claim;   // a valid claim for image and compile targets
static std::map<std::string, uint64_t> g_rejections;

static std::string normalize(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c >= '0' && c <= '9') {
      if (out.empty() || out.back() != '#') out += '#';
    } else {
      out += c;
    }
  }
  return out;
}

static void check_json(const char* s, const char* what) {
  if (!s) property_failure(std::string(what) + " returned NULL");
  tend::JsonReader r(s, std::strlen(s));
  if (!r.skip() || !r.finish()) property_failure(std::string(what) + " produced invalid JSON: " + r.error());
}

static void run_image(const Bytes& img, bool reseal) {
  Bytes b = img;
  if (reseal && b.size() >= tend::kHeaderSize + tend::kTrailerSize) {
    uint32_t n = uint32_t(b.size());
    for (int i = 0; i < 4; i++) b[12 + size_t(i)] = uint8_t(n >> (8 * i));
    tend::reseal_image(b);
  }
  tend::Law law;
  std::string err;
  if (!tend::load_law(b.data(), b.size(), law, err)) {
    g_rejections[normalize(err)]++;
    char* e = tend_eval_json(b.data(), b.size(), g_claim.c_str());
    check_json(e, "eval of a rejected image");
    tend_free(e);
    return;
  }
  std::string listing = tend::disassemble(law);
  (void)listing;
  tend::OutBuf info;
  tend::inspect_json(law, info);
  check_json(std::string(info.view()).c_str(), "inspect");
  char* out = tend_eval_json(b.data(), b.size(), g_claim.c_str());
  check_json(out, "eval");
  tend_free(out);
}

static void run_input(const Bytes& in) {
  std::string s(in.begin(), in.end());
  char* out = tend_eval_json(g_law.data(), g_law.size(), s.c_str());
  check_json(out, "eval");
  if (std::strstr(out, "\"vm_trap\"")) property_failure("valid image trapped");
  tend_free(out);
}

static void run_compile(const Bytes& in) {
  std::string s(in.begin(), in.end());
  tend::CompileResult res;
  std::string err;
  if (!tend::compile_law(s, res, err)) return;
  tend::Law law;
  if (!tend::load_law(res.image.data(), res.image.size(), law, err))
    property_failure("compiled image failed verification: " + err);
  std::string claim = g_claim;
  std::string st = law.jurisdiction;
  size_t at = claim.find("\"ZZ\"");
  if (at != std::string::npos) claim.replace(at, 4, "\"" + st + "\"");
  char* out = tend_eval_json(res.image.data(), res.image.size(), claim.c_str());
  check_json(out, "eval of compiled law");
  if (std::strstr(out, "\"vm_trap\"")) property_failure("compiled law trapped");
  tend_free(out);
}

struct Target {
  const char* name;
  std::vector<Bytes> corpus;
  uint64_t execs = 0, kept = 0;
};

static bool read_file(const std::string& path, Bytes& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return true;
}

static void load_saved(Target& t) {
  fs::path dir = fs::path(g_out_dir) / t.name;
  std::error_code ec;
  if (!fs::is_directory(dir, ec)) return;
  std::vector<std::string> files;
  for (const auto& e : fs::directory_iterator(dir, ec)) files.push_back(e.path().string());
  std::sort(files.begin(), files.end());
  for (const auto& f : files) {
    Bytes b;
    if (read_file(f, b)) t.corpus.push_back(b);
  }
}

static void save_corpus(const Target& t) {
  fs::path dir = fs::path(g_out_dir) / t.name;
  std::error_code ec;
  fs::create_directories(dir, ec);
  for (const Bytes& b : t.corpus) {
    uint8_t h[32];
    tend::sha256(b.data(), b.size(), h);
    std::ofstream(dir / (tend::to_hex(h, 8) + ".bin"), std::ios::binary).write(reinterpret_cast<const char*>(b.data()), long(b.size()));
  }
}

int main(int argc, char** argv) {
  double seconds = 60;
  uint64_t seed = 1;
  std::vector<std::string> seed_json, seed_input, seed_dirs;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--seconds") seconds = std::atof(next().c_str());
    else if (a == "--seed") seed = std::strtoull(next().c_str(), nullptr, 10);
    else if (a == "--corpus") g_out_dir = next();
    else if (a == "--seed-json") seed_json.push_back(next());
    else if (a == "--seed-input") seed_input.push_back(next());
    else if (a == "--seed-json-dir") seed_dirs.push_back(next());
    else {
      std::fprintf(stderr, "usage: tend_fuzz [--seconds N] [--seed N] [--corpus DIR] --seed-json LAW.json --seed-input CLAIM.json [--seed-json-dir DIR]\n");
      return 2;
    }
  }
  if (seed_json.empty() || seed_input.empty()) {
    std::fprintf(stderr, "tend_fuzz: need --seed-json and --seed-input\n");
    return 2;
  }
  std::error_code ec;
  fs::create_directories(g_out_dir, ec);
  __sanitizer_set_death_callback(dump_current);

  for (const auto& d : seed_dirs) {
    for (const auto& e : fs::directory_iterator(d, ec)) {
      if (e.path().extension() == ".json") seed_json.push_back(e.path().string());
    }
  }
  std::sort(seed_json.begin() + 1, seed_json.end());

  Target image{"image", {}}, resealed{"resealed", {}}, input{"input", {}}, compile{"compile", {}};
  for (const auto& path : seed_json) {
    Bytes text;
    if (!read_file(path, text)) continue;
    compile.corpus.push_back(text);
    tend::CompileResult res;
    std::string err;
    if (tend::compile_law(std::string(text.begin(), text.end()), res, err)) {
      if (g_law.empty()) g_law = res.image;
      image.corpus.push_back(res.image);
      resealed.corpus.push_back(res.image);
    }
  }
  for (const auto& path : seed_input) {
    Bytes text;
    if (!read_file(path, text)) continue;
    if (g_claim.empty()) g_claim.assign(text.begin(), text.end());
    input.corpus.push_back(text);
  }
  if (g_law.empty() || g_claim.empty()) {
    std::fprintf(stderr, "tend_fuzz: seeds did not produce a law image and a claim\n");
    return 2;
  }
  Target* targets[] = {&image, &resealed, &input, &compile};
  for (Target* t : targets) load_saved(*t);

  Rng rng{seed * 0x9E3779B97F4A7C15ULL + 7};
  auto start = std::chrono::steady_clock::now();
  auto last_report = start;
  uint64_t total = 0;
  std::printf("tend_fuzz: %u coverage guards, %.0f s budget\n", g_guards, seconds);
  for (;;) {
    double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    if (elapsed >= seconds) break;
    for (Target* t : targets) {
      const Bytes& parent = t->corpus[rng.below(t->corpus.size())];
      const Bytes& other = t->corpus[rng.below(t->corpus.size())];
      Bytes child = parent;
      bool is_json = t == &input || t == &compile;
      if (is_json && rng.chance(60)) {
        nlohmann::json doc = nlohmann::json::parse(child.begin(), child.end(), nullptr, false);
        if (!doc.is_discarded()) {
          int n = 1 + int(rng.below(3));
          for (int k = 0; k < n; k++) mutate_json(doc, rng);
          std::string s = doc.dump();
          if (s.size() <= (1u << 18)) child.assign(s.begin(), s.end());
        } else {
          mutate_bytes(child, rng, other, 0, child.size(), 1 << 16);
        }
      } else if (!is_json && rng.chance(70)) {
        // Aim at one section, most often the bytecode.
        static const uint32_t kTags[] = {tend::kTagItem, tend::kTagAggr, tend::kTagItem, tend::kTagAggr, tend::kTagRule,
                                         tend::kTagProf, tend::kTagStrs, tend::kTagAnno, tend::kTagInts, tend::kTagSrcs};
        uint32_t off = 0, size = 0;
        if (tend::find_section(child, kTags[rng.below(10)], off, size)) {
          mutate_bytes(child, rng, other, off, size_t(off) + size, 1 << 18);
        } else {
          mutate_bytes(child, rng, other, 0, child.size(), 1 << 18);
        }
      } else {
        mutate_bytes(child, rng, other, 0, child.size(), is_json ? (1 << 16) : (1 << 18));
      }
      g_current = &child;
      g_current_target = t->name;
      g_new_edges = 0;
      if (t == &image) run_image(child, false);
      else if (t == &resealed) run_image(child, true);
      else if (t == &input) run_input(child);
      else run_compile(child);
      g_current = nullptr;
      t->execs++;
      total++;
      if (g_new_edges > 0 && t->corpus.size() < 20000) {
        t->corpus.push_back(std::move(child));
        t->kept++;
      }
    }
    auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration<double>(now - last_report).count() >= 10) {
      last_report = now;
      double el = std::chrono::duration<double>(now - start).count();
      std::printf("  %6.0fs  %10llu execs  %8.0f/s  edges %llu/%u  corpus image %zu resealed %zu input %zu compile %zu\n", el,
                  (unsigned long long)total, double(total) / el, (unsigned long long)g_edges, g_guards, image.corpus.size(),
                  resealed.corpus.size(), input.corpus.size(), compile.corpus.size());
      std::fflush(stdout);
    }
  }
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  std::printf("tend_fuzz: %llu execs in %.0f s (%.0f/s), %llu of %u edges covered, no crashes\n", (unsigned long long)total, el,
              double(total) / el, (unsigned long long)g_edges, g_guards);
  for (Target* t : targets) {
    std::printf("  %-9s %10llu execs, %6llu new inputs kept, corpus %zu\n", t->name, (unsigned long long)t->execs,
                (unsigned long long)t->kept, t->corpus.size());
    save_corpus(*t);
  }
  std::vector<std::pair<uint64_t, std::string>> top;
  for (auto& [k, v] : g_rejections) top.emplace_back(v, k);
  std::sort(top.rbegin(), top.rend());
  std::printf("  loader rejections by reason (top 25 of %zu):\n", top.size());
  for (size_t i = 0; i < top.size() && i < 25; i++) std::printf("    %10llu  %s\n", (unsigned long long)top[i].first, top[i].second.c_str());
  return 0;
}

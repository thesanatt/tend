// tendvm: evaluate claims, list images, and benchmark the VM.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "civil.h"
#include "cli_util.h"
#include "eval.h"
#include "nlohmann/json.hpp"
#include "tend/tend.h"

namespace {

int usage() {
  std::fprintf(stderr,
               "usage:\n"
               "  tendvm eval --law ST.tlaw --input claim.json [--pretty] [-o out.json]\n"
               "  tendvm disasm ST.tlaw\n"
               "  tendvm inspect ST.tlaw [--pretty]\n"
               "  tendvm bench --law ST.tlaw [--items N] [--runs R] [--seed S]\n"
               "  tendvm version\n");
  return 2;
}

struct Args {
  std::string law, input, out = "-";
  bool pretty = false;
  size_t items = 1000000;
  int runs = 5;
  uint64_t seed = 1;
  std::vector<std::string> positional;
};

bool parse_args(int argc, char** argv, Args& a) {
  for (int i = 2; i < argc; i++) {
    auto val = [&](const char* flag) { return !std::strcmp(argv[i], flag) && i + 1 < argc; };
    if (val("--law")) a.law = argv[++i];
    else if (val("--input")) a.input = argv[++i];
    else if (val("-o")) a.out = argv[++i];
    else if (val("--items")) a.items = std::strtoull(argv[++i], nullptr, 10);
    else if (val("--runs")) a.runs = std::atoi(argv[++i]);
    else if (val("--seed")) a.seed = std::strtoull(argv[++i], nullptr, 10);
    else if (!std::strcmp(argv[i], "--pretty")) a.pretty = true;
    else if (argv[i][0] == '-' && argv[i][1]) return false;
    else a.positional.push_back(argv[i]);
  }
  return true;
}

bool load_file(const std::string& path, std::string& out, const char* what) {
  if (path.empty() || !tend::cli::read_file(path, out)) {
    std::fprintf(stderr, "tendvm: cannot read %s %s\n", what, path.c_str());
    return false;
  }
  return true;
}

int emit(char* text, const Args& a) {
  if (!text) {
    std::fprintf(stderr, "tendvm: out of memory\n");
    return 1;
  }
  std::string s(text);
  tend_free(text);
  bool is_error = s.rfind("{\"error\"", 0) == 0;
  if (a.pretty) s = nlohmann::ordered_json::parse(s).dump(2);
  s += '\n';
  if (!tend::cli::write_file(a.out, s.data(), s.size())) {
    std::fprintf(stderr, "tendvm: cannot write %s\n", a.out.c_str());
    return 1;
  }
  return is_error ? 1 : 0;
}

int cmd_eval(const Args& a) {
  std::string img, input;
  if (!load_file(a.law, img, "law image") || !load_file(a.input, input, "input")) return 1;
  return emit(tend_eval_json(reinterpret_cast<const uint8_t*>(img.data()), img.size(), input.c_str()), a);
}

int cmd_disasm(const Args& a) {
  std::string path = a.law.empty() && !a.positional.empty() ? a.positional[0] : a.law;
  std::string img;
  if (!load_file(path, img, "law image")) return 1;
  char* text = tend_disasm(reinterpret_cast<const uint8_t*>(img.data()), img.size());
  if (!text) return 1;
  bool failed = std::strncmp(text, "error: ", 7) == 0;
  std::fputs(text, failed ? stderr : stdout);
  tend_free(text);
  return failed ? 1 : 0;
}

int cmd_inspect(const Args& a) {
  std::string path = a.law.empty() && !a.positional.empty() ? a.positional[0] : a.law;
  std::string img;
  if (!load_file(path, img, "law image")) return 1;
  return emit(tend_inspect_json(reinterpret_cast<const uint8_t*>(img.data()), img.size()), a);
}

// Deterministic synthetic claim: a bank-export-like history in date order.
struct Synthetic {
  std::string ids;
  std::vector<tend::Item> items;
  tend::Context ctx;
};

void synthesize(size_t n, uint64_t seed, Synthetic& s) {
  using namespace tend;
  int64_t incident = 0, as_of = 0;
  parse_date("2026-06-14", incident);
  parse_date("2026-10-03", as_of);
  s.ctx.field[CX_INCIDENT_DATE] = incident;
  s.ctx.field[CX_AS_OF_DATE] = as_of;
  s.ctx.field[CX_POLICE_REPORT] = PR_NO;
  s.ctx.field[CX_FORENSIC_EXAM] = 1;
  static const uint8_t kMix[20] = {EXP_MEDICAL,        EXP_MEDICAL,        EXP_MEDICAL,      EXP_MEDICAL,
                                   EXP_COUNSELING,     EXP_COUNSELING,     EXP_COUNSELING,   EXP_COUNSELING,
                                   EXP_LOST_WAGES,     EXP_LOST_WAGES,     EXP_TRANSPORTATION, EXP_TRANSPORTATION,
                                   EXP_RELOCATION,     EXP_FORENSIC_EXAM,  EXP_PROPERTY_REPLACEMENT, EXP_PRESCRIPTION,
                                   EXP_SECURITY,       EXP_OTHER,          EXP_DENTAL,       EXP_UNKNOWN};
  constexpr size_t kIdLen = 14;  // "bench:" + 8 digits
  s.ids.resize(n * kIdLen);
  s.items.resize(n);
  uint64_t x = seed * 6364136223846793005ULL + 1442695040888963407ULL;
  auto rnd = [&] {
    x = x * 6364136223846793005ULL + 1442695040888963407ULL;
    return uint32_t(x >> 33);
  };
  int64_t span = as_of - incident + 6;
  for (size_t i = 0; i < n; i++) {
    char* id = s.ids.data() + i * kIdLen;
    char tmp[32];
    std::snprintf(tmp, sizeof tmp, "bench:%08zu", i % 100000000);
    std::memcpy(id, tmp, kIdLen);
    Item& it = s.items[i];
    it.id = std::string_view(id, kIdLen);
    it.field[IF_DATE] = incident - 3 + int64_t(uint64_t(i) * uint64_t(span) / (n ? n : 1));
    it.field[IF_EXPENSE] = kMix[rnd() % 20];
    it.field[IF_AMOUNT] = 1000 + rnd() % 400000;
    it.field[IF_CONFIRMED] = rnd() % 10 != 0;
    it.field[IF_INSURANCE_PAID] = rnd() % 5 == 0 ? it.field[IF_AMOUNT] / 4 : 0;
    it.field[IF_IS_BILL] = rnd() % 3 == 0;
    it.field[IF_UNITS] = rnd() % 4 == 0 ? 0 : 1 + rnd() % 8;
    // Most counted lines say what they count (SPEC v1.2 typed units).
    uint8_t e = uint8_t(it.field[IF_EXPENSE]);
    uint8_t unit = e == EXP_COUNSELING ? UNIT_SESSION : e == EXP_LOST_WAGES ? UNIT_WEEK
                 : e == EXP_TRANSPORTATION ? UNIT_MILE : UNIT_NONE;
    it.field[IF_UNIT] = it.field[IF_UNITS] && rnd() % 10 != 0 ? unit : UNIT_NONE;
  }
}

std::string synth_json(const Synthetic& s, const char* jurisdiction) {
  using namespace tend;
  std::string out;
  out.reserve(s.items.size() * 190 + 256);
  auto date = [&](int64_t d) {
    char b[10];
    format_date(d, b);
    out += '"';
    out.append(b, 10);
    out += '"';
  };
  out += "{\"jurisdiction\":\"";
  out += jurisdiction;
  out += "\",\"context\":{\"incident_date\":";
  date(s.ctx.field[CX_INCIDENT_DATE]);
  out += ",\"as_of_date\":";
  date(s.ctx.field[CX_AS_OF_DATE]);
  out += ",\"police_report\":\"no\",\"forensic_exam\":true},\"items\":[";
  for (size_t i = 0; i < s.items.size(); i++) {
    const Item& it = s.items[i];
    if (i) out += ',';
    out += "{\"item_id\":\"";
    out += it.id;
    out += "\",\"date\":";
    date(it.field[IF_DATE]);
    out += ",\"amount_cents\":" + std::to_string(it.field[IF_AMOUNT]);
    out += ",\"expense\":\"";
    out += expense_name(uint8_t(it.field[IF_EXPENSE]));
    out += "\",\"confirmed\":";
    out += it.field[IF_CONFIRMED] ? "true" : "false";
    out += ",\"insurance_paid_cents\":" + std::to_string(it.field[IF_INSURANCE_PAID]);
    out += ",\"is_bill\":";
    out += it.field[IF_IS_BILL] ? "true" : "false";
    out += ",\"units\":" + std::to_string(it.field[IF_UNITS]);
    if (it.field[IF_UNIT] != UNIT_NONE) {
      out += ",\"unit\":\"";
      out += unit_name(uint8_t(it.field[IF_UNIT]));
      out += '"';
    }
    out += ",\"description\":\"synthetic benchmark line\"}";
  }
  out += "]}";
  return out;
}

template <class F>
std::vector<double> time_runs(int runs, F&& f) {
  std::vector<double> t;
  for (int r = 0; r < runs; r++) {
    auto t0 = std::chrono::steady_clock::now();
    f();
    auto t1 = std::chrono::steady_clock::now();
    t.push_back(std::chrono::duration<double>(t1 - t0).count());
  }
  std::sort(t.begin(), t.end());
  return t;
}

void report(const char* what, const std::vector<double>& t, size_t n, const std::string& extra = "") {
  double best = t.front(), median = t[t.size() / 2];
  std::printf("  %-26s best %8.4f s  %8.2f M items/s   median %8.4f s  %8.2f M items/s%s\n", what, best,
              double(n) / best / 1e6, median, double(n) / median / 1e6, extra.c_str());
}

int cmd_bench(const Args& a) {
  std::string img;
  if (!load_file(a.law, img, "law image")) return 1;
  tend::Law law;
  std::string err;
  if (!tend::load_law(reinterpret_cast<const uint8_t*>(img.data()), img.size(), law, err)) {
    std::fprintf(stderr, "tendvm: %s\n", err.c_str());
    return 1;
  }
  int runs = std::max(1, a.runs);
  Synthetic s;
  synthesize(a.items, a.seed, s);
  std::printf("tend bench: law %s, %zu items, %d runs, single thread\n", law.jurisdiction, a.items, runs);

  tend::Evaluation ev;
  bool ok = true;
  auto vm_trace = time_runs(runs, [&] { ok = ok && tend::run_vm(law, s.ctx, s.items, ev, err, true); });
  size_t trace_len = ev.trace.size();
  uint64_t steps = ev.steps;
  auto vm_plain = time_runs(runs, [&] { ok = ok && tend::run_vm(law, s.ctx, s.items, ev, err, false); });
  if (!ok) {
    std::fprintf(stderr, "tendvm: %s\n", err.c_str());
    return 1;
  }
  report("vm, trace on", vm_trace, a.items,
         "   (" + std::to_string(steps) + " instructions, " + std::to_string(trace_len) + " trace entries)");
  report("vm, trace off", vm_plain, a.items);

  std::string input = synth_json(s, law.jurisdiction);
  size_t out_bytes = 0;
  auto e2e = time_runs(runs, [&] {
    tend::OutBuf out;
    ok = ok && tend::evaluate_to_json(reinterpret_cast<const uint8_t*>(img.data()), img.size(), input.data(),
                                      input.size(), out);
    out_bytes = out.size();
  });
  if (!ok) {
    std::fprintf(stderr, "tendvm: end-to-end run failed\n");
    return 1;
  }
  char extra[96];
  std::snprintf(extra, sizeof extra, "   (in %.1f MB, out %.1f MB)", double(input.size()) / 1e6, double(out_bytes) / 1e6);
  report("json in -> json out", e2e, a.items, extra);

  // Where the end-to-end time goes.
  auto parse = time_runs(runs, [&] {
    tend::Input in;
    ok = ok && tend::parse_input(input.data(), input.size(), law, in, err);
  });
  ok = ok && tend::run_vm(law, s.ctx, s.items, ev, err, true);  // render a traced evaluation
  auto render = time_runs(runs, [&] {
    tend::OutBuf out;
    tend::render_output(law, s.items, ev, out);
  });
  if (!ok) {
    std::fprintf(stderr, "tendvm: %s\n", err.c_str());
    return 1;
  }
  std::printf("  breakdown (best): parse %.4f s, vm %.4f s, render %.4f s\n", parse.front(), vm_trace.front(),
              render.front());
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  Args a;
  if (!parse_args(argc, argv, a)) return usage();
  std::string cmd = argv[1];
  if (cmd == "eval") return a.law.empty() || a.input.empty() ? usage() : cmd_eval(a);
  if (cmd == "disasm") return cmd_disasm(a);
  if (cmd == "inspect") return cmd_inspect(a);
  if (cmd == "bench") return a.law.empty() ? usage() : cmd_bench(a);
  if (cmd == "version") {
    std::printf("%s\n", tend_version());
    return 0;
  }
  return usage();
}

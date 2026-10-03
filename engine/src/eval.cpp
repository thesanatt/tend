#include "eval.h"

#include <algorithm>
#include <cstring>

#include "civil.h"
#include "sha256.h"

namespace tend {
namespace {

class InputParser {
 public:
  InputParser(const char* json, size_t len, Input& in, std::string& err)
      : r_(json, len), in_(in), err_(err) {}

  bool run() {
    if (!r_.begin_object()) return json_error();
    bool have_context = false;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      if (key == "jurisdiction") {
        if (r_.peek() == JsonReader::kNull) {
          if (!r_.skip()) return json_error();
          continue;
        }
        std::string_view s;
        if (!r_.read_string(s)) return field_error("jurisdiction", "expected a string");
        in_.jurisdiction.assign(s);
        in_.has_jurisdiction = true;
      } else if (key == "context") {
        if (!context()) return false;
        have_context = true;
      } else if (key == "items") {
        if (!items()) return false;
      } else if (!r_.skip()) {
        return json_error();
      }
    }
    if (k < 0 || !r_.finish()) return json_error();
    if (!have_context) return semantic("context is required");
    return true;
  }

 private:
  bool json_error() {
    if (err_.empty()) err_ = "invalid JSON at byte " + std::to_string(r_.offset()) + ": " + r_.error();
    return false;
  }
  bool field_error(const std::string& path, const char* what) {
    if (err_.empty()) err_ = path + ": " + what;
    return false;
  }
  bool semantic(const std::string& msg) {
    if (err_.empty()) err_ = msg;
    return false;
  }
  bool is_null() { return r_.peek() == JsonReader::kNull; }

  bool date_field(const std::string& path, int64_t& day) {
    std::string_view s;
    if (!r_.read_string(s)) return field_error(path, "expected a date string");
    if (!parse_date(s, day)) return field_error(path, "expected a date as YYYY-MM-DD");
    return true;
  }
  bool bool_field(const std::string& path, int64_t& v) {
    if (is_null()) {
      v = 0;
      return r_.skip();
    }
    bool b;
    if (!r_.read_bool(b)) return field_error(path, "expected true or false");
    v = b;
    return true;
  }
  bool cents_field(const std::string& path, int64_t& v) {
    if (!r_.read_int64(v)) return field_error(path, "expected an integer");
    if (v < 0) return field_error(path, "must not be negative");
    return true;
  }

  bool context() {
    if (!r_.begin_object()) return field_error("context", "expected an object");
    bool incident = false, as_of = false;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      if (key == "incident_date") {
        if (!date_field("context.incident_date", in_.ctx.field[CX_INCIDENT_DATE])) return false;
        incident = true;
      } else if (key == "as_of_date") {
        if (!date_field("context.as_of_date", in_.ctx.field[CX_AS_OF_DATE])) return false;
        as_of = true;
      } else if (key == "police_report") {
        if (is_null()) {
          in_.ctx.field[CX_POLICE_REPORT] = PR_UNKNOWN;
          if (!r_.skip()) return json_error();
          continue;
        }
        std::string_view s;
        if (!r_.read_string(s)) return field_error("context.police_report", "expected a string");
        if (s == "yes") in_.ctx.field[CX_POLICE_REPORT] = PR_YES;
        else if (s == "no") in_.ctx.field[CX_POLICE_REPORT] = PR_NO;
        else if (s == "unknown") in_.ctx.field[CX_POLICE_REPORT] = PR_UNKNOWN;
        else return field_error("context.police_report", "expected yes, no, or unknown");
      } else if (key == "forensic_exam") {
        if (!bool_field("context.forensic_exam", in_.ctx.field[CX_FORENSIC_EXAM])) return false;
      } else if (!r_.skip()) {
        return json_error();
      }
    }
    if (k < 0) return json_error();
    if (!incident) return semantic("context.incident_date is required");
    if (!as_of) return semantic("context.as_of_date is required");
    return true;
  }

  bool items() {
    if (is_null()) return r_.skip() || json_error();
    if (!r_.begin_array()) return field_error("items", "expected an array");
    int k;
    while ((k = r_.next_element()) == 1) {
      if (in_.items.size() >= (1u << 31)) return semantic("too many items");
      if (!item(in_.items.size())) return false;
    }
    if (k < 0) return json_error();
    return true;
  }

  bool item(size_t index) {
    std::string base = "items[" + std::to_string(index) + "]";
    if (!r_.begin_object()) return field_error(base, "expected an object");
    Item it;
    bool have_id = false, have_date = false, have_amount = false;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      if (key == "item_id") {
        std::string_view s;
        bool scratch = false;
        if (!r_.read_string(s, &scratch)) return field_error(base + ".item_id", "expected a string");
        if (s.empty()) return field_error(base + ".item_id", "must not be empty");
        if (scratch) {
          in_.arena.emplace_back(new char[s.size()]);
          std::memcpy(in_.arena.back().get(), s.data(), s.size());
          s = std::string_view(in_.arena.back().get(), s.size());
        }
        it.id = s;
        have_id = true;
      } else if (key == "date") {
        if (!date_field(base + ".date", it.field[IF_DATE])) return false;
        have_date = true;
      } else if (key == "amount_cents") {
        if (!cents_field(base + ".amount_cents", it.field[IF_AMOUNT])) return false;
        have_amount = true;
      } else if (key == "expense") {
        if (is_null()) {
          it.field[IF_EXPENSE] = EXP_UNKNOWN;
          if (!r_.skip()) return json_error();
          continue;
        }
        std::string_view s;
        if (!r_.read_string(s)) return field_error(base + ".expense", "expected a string");
        uint8_t e;
        it.field[IF_EXPENSE] = parse_expense(s, e) ? e : EXP_UNKNOWN;
      } else if (key == "confirmed") {
        if (!bool_field(base + ".confirmed", it.field[IF_CONFIRMED])) return false;
      } else if (key == "is_bill") {
        if (!bool_field(base + ".is_bill", it.field[IF_IS_BILL])) return false;
      } else if (key == "insurance_paid_cents") {
        if (is_null()) {
          if (!r_.skip()) return json_error();
          continue;
        }
        if (!cents_field(base + ".insurance_paid_cents", it.field[IF_INSURANCE_PAID])) return false;
      } else if (key == "units") {
        if (is_null()) {
          if (!r_.skip()) return json_error();
          continue;
        }
        if (!cents_field(base + ".units", it.field[IF_UNITS])) return false;
      } else if (!r_.skip()) {
        return json_error();
      }
    }
    if (k < 0) return json_error();
    if (!have_id) return semantic(base + ".item_id is required");
    if (!have_date) return semantic(base + ".date is required");
    if (!have_amount) return semantic(base + ".amount_cents is required");
    in_.items.push_back(it);
    return true;
  }

  JsonReader r_;
  Input& in_;
  std::string& err_;
};

// Precomputed JSON fragments so the per-line loop only copies bytes.
struct Fragments {
  std::vector<std::string> rule_id;      // quoted id
  std::vector<std::string> rule_flag;    // quoted "rate_unverified:<id>"
  std::vector<std::string> proof_array;  // ["A","B"]
  std::string status[ST_COUNT];
  std::string expense[EXP_COUNT];
  std::string trace_op[TR_COUNT];

  explicit Fragments(const Law& law) {
    rule_id.reserve(law.rules.size());
    for (const Rule& r : law.rules) {
      rule_id.push_back(json_quote(law.str(r.id)));
      rule_flag.push_back(json_quote("rate_unverified:" + std::string(law.str(r.id))));
    }
    for (uint32_t p = 0; p < law.proof_count(); p++) {
      std::string s = "[";
      for (uint32_t i = 0; i < law.proof_len(p); i++) {
        if (i) s += ',';
        s += rule_id[law.proof_rules(p)[i]];
      }
      s += ']';
      proof_array.push_back(std::move(s));
    }
    for (uint8_t i = 0; i < ST_COUNT; i++) status[i] = json_quote(status_name(i));
    for (uint8_t i = 0; i < EXP_COUNT; i++) expense[i] = json_quote(expense_name(i));
    for (uint8_t i = 0; i < TR_COUNT; i++) trace_op[i] = json_quote(trace_op_name(i));
  }
};

const std::string& checked(const std::vector<std::string>& v, size_t i) {
  static const std::string kNull = "null";
  return i < v.size() ? v[i] : kNull;
}

}  // namespace

bool parse_input(const char* json, size_t len, Input& in, std::string& err) {
  InputParser p(json, len, in, err);
  return p.run();
}

void render_error(std::string_view code, std::string_view message, OutBuf& out) {
  out.put("{\"error\":{\"code\":");
  out.put_json_string(code);
  out.put(",\"message\":");
  out.put_json_string(message);
  out.put("}}");
}

void render_output(const Law& law, const std::vector<Item>& items, const Evaluation& ev, OutBuf& out) {
  Fragments f(law);
  const size_t n = ev.lines.size();
  out.reserve(256 + n * (ev.trace.empty() ? 200 : 320));

  out.put("{\"jurisdiction\":");
  out.put_json_string(law.jurisdiction);
  out.put(",\"law_image_sha256\":\"");
  out.put(to_hex(law.image_sha256, 32));
  out.put("\",\"lines\":[");

  // Flags grouped per line, keeping the order they were raised.
  std::vector<uint32_t> flag_start(n + 1, 0);
  for (const auto& fl : ev.flags) flag_start[fl.first + 1]++;
  for (size_t i = 0; i < n; i++) flag_start[i + 1] += flag_start[i];
  std::vector<uint16_t> flag_rule(ev.flags.size());
  {
    std::vector<uint32_t> fill(flag_start.begin(), flag_start.end() - 1);
    for (const auto& fl : ev.flags) flag_rule[fill[fl.first]++] = fl.second;
  }

  int64_t requested = 0, allowed = 0, held = 0;
  int64_t by_expense[EXP_COUNT] = {};
  bool has_expense[EXP_COUNT] = {};
  for (size_t i = 0; i < n; i++) {
    const Line& l = ev.lines[i];
    if (i) out.put(',');
    out.put("{\"item_id\":");
    out.put_json_string(items[i].id);
    out.put(",\"expense\":");
    out.put(f.expense[l.expense < EXP_COUNT ? l.expense : EXP_UNKNOWN]);
    out.put(",\"status\":");
    out.put(f.status[l.status < ST_COUNT ? l.status : ST_UNKNOWN_RULE]);
    out.put(",\"requested_cents\":");
    out.put_i64(l.requested);
    out.put(",\"allowed_cents\":");
    out.put_i64(l.allowed);
    out.put(",\"rule_ids\":");
    out.put(f.proof_array[l.proof]);
    out.put(",\"cap_rule_id\":");
    out.put(l.cap_rule < 0 ? std::string_view("null") : std::string_view(f.rule_id[size_t(l.cap_rule)]));
    out.put(",\"flags\":[");
    for (uint32_t k = flag_start[i]; k < flag_start[i + 1]; k++) {
      if (k != flag_start[i]) out.put(',');
      out.put(f.rule_flag[flag_rule[k]]);
    }
    out.put("]}");
    if (l.status == ST_ELIGIBLE) {
      requested = sat_add(requested, l.requested);
      allowed = sat_add(allowed, l.allowed);
      by_expense[l.expense] = sat_add(by_expense[l.expense], l.allowed);
      has_expense[l.expense] = true;
    } else if (l.status == ST_HELD) {
      held = sat_add(held, l.requested);
    }
  }

  out.put("],\"totals\":{\"requested_cents\":");
  out.put_i64(requested);
  out.put(",\"allowed_cents\":");
  out.put_i64(allowed);
  out.put(",\"held_cents\":");
  out.put_i64(held);
  out.put(",\"by_expense\":{");
  uint8_t order[EXP_COUNT];
  for (uint8_t i = 0; i < EXP_COUNT; i++) order[i] = i;
  std::sort(order, order + EXP_COUNT, [](uint8_t a, uint8_t b) { return expense_name(a) < expense_name(b); });
  bool first = true;
  for (uint8_t e : order) {
    if (!has_expense[e]) continue;
    if (!first) out.put(',');
    first = false;
    out.put(f.expense[e]);
    out.put(':');
    out.put_i64(by_expense[e]);
  }
  out.put("}},\"checks\":{");
  for (uint8_t k = 0; k < CK_COUNT; k++) {
    const CheckResult& c = ev.checks[k];
    if (k) out.put(',');
    out.put('"');
    out.put(check_kind_name(k));
    out.put("\":{\"status\":\"");
    out.put(check_status_name(k, c.status));
    out.put('"');
    if (k == CK_DEADLINE) {
      out.put(",\"deadline_date\":");
      if (c.has_date) {
        char d[10];
        format_date(c.date, d);
        out.put('"');
        out.put(std::string_view(d, 10));
        out.put('"');
      } else {
        out.put("null");
      }
    }
    out.put(",\"rule_ids\":");
    out.put(f.proof_array[c.proof]);
    out.put('}');
  }
  out.put("},\"info_rule_ids\":");
  out.put(ev.has_info ? std::string_view(f.proof_array[ev.info_proof]) : std::string_view("[]"));
  out.put(",\"trace\":[");
  for (size_t i = 0; i < ev.trace.size(); i++) {
    const TraceEntry& t = ev.trace[i];
    if (i) out.put(',');
    out.put("{\"op\":");
    out.put(f.trace_op[t.op < TR_COUNT ? t.op : 0]);
    out.put(",\"item_id\":");
    if (t.line == kNone) out.put("null");
    else out.put_json_string(items[t.line].id);
    out.put(",\"rule_id\":");
    out.put(t.rule < 0 ? std::string_view("null") : std::string_view(checked(f.rule_id, size_t(t.rule))));
    out.put(",\"delta_cents\":");
    out.put_i64(t.delta);
    out.put('}');
  }
  out.put("]}");
}

bool evaluate_to_json(const uint8_t* img, size_t img_len, const char* json, size_t json_len, OutBuf& out) {
  Law law;
  std::string err;
  if (!load_law(img, img_len, law, err)) {
    render_error("bad_image", err, out);
    return false;
  }
  Input in;
  if (!json || !parse_input(json, json_len, in, err)) {
    render_error("bad_input", json ? err : "no input", out);
    return false;
  }
  if (in.has_jurisdiction && in.jurisdiction != law.jurisdiction) {
    render_error("jurisdiction_mismatch",
                 "input is for " + in.jurisdiction + " but the law image is " + law.jurisdiction, out);
    return false;
  }
  sort_items(in.items);
  Evaluation ev;
  if (!run_vm(law, in.ctx, in.items, ev, err)) {
    render_error("vm_trap", err, out);
    return false;
  }
  render_output(law, in.items, ev, out);
  return true;
}

}  // namespace tend

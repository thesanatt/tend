#include "eval.h"

#include <algorithm>
#include <cstring>

#include "civil.h"
#include "sha256.h"

namespace tend {
namespace {

// Integers must survive a round trip through JavaScript (the WASM build).
constexpr int64_t kMaxSafeInteger = (int64_t(1) << 53) - 1;

// Where a value sits in the input. Rendered only when reporting an error, so
// the happy path never builds strings like "items[123].amount_cents".
struct Path {
  const char* scope;  // "", "input", "context", or "items"
  int64_t index;      // item index, or -1
  const char* field;  // nullptr for the scope itself

  std::string str() const {
    std::string s = scope;
    if (index >= 0) s += "[" + std::to_string(index) + "]";
    if (field) {
      if (!s.empty()) s += '.';
      s += field;
    }
    return s;
  }
};

enum ItemKey {
  KEY_ID,
  KEY_DATE,
  KEY_AMOUNT,
  KEY_EXPENSE,
  KEY_CONFIRMED,
  KEY_INSURANCE,
  KEY_IS_BILL,
  KEY_UNITS,
  KEY_UNIT,
  KEY_TAGS,
  KEY_COUNT
};
constexpr const char* kItemKeys[KEY_COUNT] = {"item_id", "date",    "amount_cents", "expense", "confirmed",
                                              "insurance_paid_cents", "is_bill", "units", "unit",    "tags"};
constexpr const char* kContextKeys[4] = {"incident_date", "as_of_date", "police_report", "forensic_exam"};
constexpr const char* kTopKeys[3] = {"jurisdiction", "context", "items"};

template <size_t N>
int key_index(std::string_view key, const char* const (&names)[N]) {
  for (size_t i = 0; i < N; i++) {
    if (key == names[i]) return int(i);
  }
  return -1;
}

// Reads the claim document in one pass, in document order, and stops at the
// first problem (FORMAT.md section 5 lists every message). Problems with the
// JSON text itself (syntax, encoding, nesting) are reported as invalid JSON;
// a well-formed value of the wrong type or range names its field.
class InputParser {
 public:
  InputParser(const char* json, size_t len, const Law& law, Input& in, std::string& err)
      : r_(json, len), law_(law), in_(in), err_(err) {
    in_.items.reserve(len / 256);
  }

  bool run() {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind != JsonReader::kObject) return semantic({"input", -1, nullptr}, "expected an object");
    if (!r_.begin_object()) return json_error();
    unsigned seen = 0;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      int which = key_index(key, kTopKeys);
      if (which < 0) {
        if (!r_.skip()) return json_error();
        continue;
      }
      if (seen & (1u << which)) return semantic({"", -1, kTopKeys[which]}, "appears twice");
      seen |= 1u << which;
      bool ok = which == 0 ? jurisdiction() : which == 1 ? context() : items();
      if (!ok) return false;
    }
    if (k < 0 || !r_.finish()) return json_error();
    if (!(seen & 2u)) return message("context is required");
    return unique_ids();
  }

 private:
  bool json_error() {
    if (err_.empty()) err_ = "invalid JSON at byte " + std::to_string(r_.offset()) + ": " + r_.error();
    return false;
  }
  bool semantic(const Path& p, const char* what) {
    if (err_.empty()) err_ = p.str() + ": " + what;
    return false;
  }
  bool missing(const Path& p) {
    if (err_.empty()) err_ = p.str() + " is required";
    return false;
  }
  bool message(const char* msg) {
    if (err_.empty()) err_ = msg;
    return false;
  }
  // The kind of the next value; a character that cannot start one is a
  // syntax error.
  bool value_kind(JsonReader::Kind& kind) {
    kind = r_.peek();
    if (kind != JsonReader::kInvalid) return true;
    r_.fail("expected a value");
    return json_error();
  }
  bool skip_value() { return r_.skip() || json_error(); }
  bool string_value(std::string_view& s, bool* scratch = nullptr) {
    return r_.read_string(s, scratch) || json_error();
  }

  // Every line and trace entry is keyed by item_id, so two items with one id
  // would make the proof ambiguous and the output depend on input order.
  bool unique_ids() {
    const auto& items = in_.items;
    size_t cap = 16;
    while (cap < items.size() * 2) cap <<= 1;
    std::vector<uint32_t> slots(cap, 0);  // open addressing; item index + 1, 0 = empty
    for (size_t i = 0; i < items.size(); i++) {
      std::string_view id = items[i].id;
      uint64_t h = 1469598103934665603ULL;  // FNV-1a
      for (char c : id) h = (h ^ uint8_t(c)) * 1099511628211ULL;
      size_t s = size_t(h ^ (h >> 29)) & (cap - 1);
      for (; slots[s]; s = (s + 1) & (cap - 1)) {
        size_t first = slots[s] - 1;
        if (items[first].id == id) {
          err_ = Path{"items", int64_t(i), "item_id"}.str() + ": duplicate of items[" + std::to_string(first) + "]";
          return false;
        }
      }
      slots[s] = uint32_t(i + 1);
    }
    return true;
  }

  bool jurisdiction() {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull) return skip_value();
    if (kind != JsonReader::kString) return semantic({"", -1, "jurisdiction"}, "expected a string");
    std::string_view s;
    if (!string_value(s)) return false;
    in_.jurisdiction.assign(s);
    in_.has_jurisdiction = true;
    return true;
  }

  bool date_field(const Path& p, int64_t& day) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind != JsonReader::kString) return semantic(p, "expected a date as YYYY-MM-DD");
    std::string_view s;
    if (!string_value(s)) return false;
    if (!parse_date(s, day)) return semantic(p, "expected a date as YYYY-MM-DD");
    return true;
  }
  // true, false, or null (false).
  bool bool_field(const Path& p, int64_t& v) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull) {
      v = 0;
      return skip_value();
    }
    if (kind != JsonReader::kTrue && kind != JsonReader::kFalse) return semantic(p, "expected true or false");
    bool b;
    if (!r_.read_bool(b)) return json_error();
    v = b;
    return true;
  }
  // An integer in [0, 2^53 - 1]. With null_ok, null leaves v at its default.
  bool count_field(const Path& p, int64_t& v, bool null_ok) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull && null_ok) return skip_value();
    if (kind != JsonReader::kNumber) return semantic(p, "expected an integer");
    JsonReader::NumberKind nk;
    int64_t x = 0;
    if (!r_.read_number(x, nk)) return json_error();
    if (nk == JsonReader::kNotInt) return semantic(p, "expected an integer");
    if (nk == JsonReader::kIntOutOfRange || x > kMaxSafeInteger || x < -kMaxSafeInteger)
      return semantic(p, "integer out of range");
    if (x < 0) return semantic(p, "must not be negative");
    v = x;
    return true;
  }
  // A string from a fixed list, or null (leaves `out` alone).
  bool enum_field(const Path& p, int64_t& out, bool (*parse)(std::string_view, uint8_t&), const char* unknown) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull) return skip_value();
    if (kind != JsonReader::kString) return semantic(p, "expected a string");
    std::string_view s;
    if (!string_value(s)) return false;
    uint8_t v;
    if (!parse(s, v)) return semantic(p, unknown);
    out = v;
    return true;
  }

  bool context() {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind != JsonReader::kObject) return semantic({"context", -1, nullptr}, "expected an object");
    if (!r_.begin_object()) return json_error();
    unsigned seen = 0;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      int which = key_index(key, kContextKeys);
      if (which < 0) {
        if (!r_.skip()) return json_error();
        continue;
      }
      Path p{"context", -1, kContextKeys[which]};
      if (seen & (1u << which)) return semantic(p, "appears twice");
      seen |= 1u << which;
      bool ok = true;
      switch (which) {
        case 0: ok = date_field(p, in_.ctx.field[CX_INCIDENT_DATE]); break;
        case 1: ok = date_field(p, in_.ctx.field[CX_AS_OF_DATE]); break;
        case 2: ok = police_report(p); break;
        default: ok = bool_field(p, in_.ctx.field[CX_FORENSIC_EXAM]);
      }
      if (!ok) return false;
    }
    if (k < 0) return json_error();
    if (!(seen & 1u)) return missing({"context", -1, "incident_date"});
    if (!(seen & 2u)) return missing({"context", -1, "as_of_date"});
    return true;
  }

  bool police_report(const Path& p) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    int64_t& v = in_.ctx.field[CX_POLICE_REPORT];
    if (kind == JsonReader::kNull) {
      v = PR_UNKNOWN;
      return skip_value();
    }
    if (kind != JsonReader::kString) return semantic(p, "expected yes, no, or unknown");
    std::string_view s;
    if (!string_value(s)) return false;
    if (s == "yes") v = PR_YES;
    else if (s == "no") v = PR_NO;
    else if (s == "unknown") v = PR_UNKNOWN;
    else return semantic(p, "expected yes, no, or unknown");
    return true;
  }

  bool items() {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull) return skip_value();
    if (kind != JsonReader::kArray) return semantic({"items", -1, nullptr}, "expected an array");
    if (!r_.begin_array()) return json_error();
    int k;
    while ((k = r_.next_element()) == 1) {
      if (in_.items.size() >= (1u << 31)) return message("too many items");
      if (!item(int64_t(in_.items.size()))) return false;
    }
    if (k < 0) return json_error();
    return true;
  }

  bool item(int64_t i) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind != JsonReader::kObject) return semantic({"items", i, nullptr}, "expected an object");
    if (!r_.begin_object()) return json_error();
    Item it;
    unsigned seen = 0;
    std::string_view key;
    int k;
    while ((k = r_.next_key(key)) == 1) {
      int which = key_index(key, kItemKeys);
      if (which < 0) {
        if (!r_.skip()) return json_error();
        continue;
      }
      Path p{"items", i, kItemKeys[which]};
      if (seen & (1u << which)) return semantic(p, "appears twice");
      seen |= 1u << which;
      bool ok = true;
      switch (which) {
        case KEY_ID: ok = item_id(p, it); break;
        case KEY_DATE: ok = date_field(p, it.field[IF_DATE]); break;
        case KEY_AMOUNT: ok = count_field(p, it.field[IF_AMOUNT], false); break;
        case KEY_EXPENSE: ok = enum_field(p, it.field[IF_EXPENSE], parse_expense, "not a known expense"); break;
        case KEY_CONFIRMED: ok = bool_field(p, it.field[IF_CONFIRMED]); break;
        case KEY_INSURANCE: ok = count_field(p, it.field[IF_INSURANCE_PAID], true); break;
        case KEY_IS_BILL: ok = bool_field(p, it.field[IF_IS_BILL]); break;
        case KEY_UNITS: ok = count_field(p, it.field[IF_UNITS], true); break;
        case KEY_UNIT: ok = enum_field(p, it.field[IF_UNIT], parse_unit, "not a known unit"); break;
        default: ok = tags_field(p, it.field[IF_TAGS]);
      }
      if (!ok) return false;
    }
    if (k < 0) return json_error();
    if (!(seen & (1u << KEY_ID))) return missing({"items", i, "item_id"});
    if (!(seen & (1u << KEY_DATE))) return missing({"items", i, "date"});
    if (!(seen & (1u << KEY_AMOUNT))) return missing({"items", i, "amount_cents"});
    in_.items.push_back(it);
    return true;
  }

  bool item_id(const Path& p, Item& it) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind != JsonReader::kString) return semantic(p, "expected a string");
    std::string_view s;
    bool scratch = false;
    if (!string_value(s, &scratch)) return false;
    if (s.empty()) return semantic(p, "must not be empty");
    if (scratch) {
      in_.arena.emplace_back(new char[s.size()]);
      std::memcpy(in_.arena.back().get(), s.data(), s.size());
      s = std::string_view(in_.arena.back().get(), s.size());
    }
    it.id = s;
    return true;
  }

  // A list of strings, or null. Tags the law never mentions cannot change an
  // outcome, so only the law's own tags become bits.
  bool tags_field(const Path& p, int64_t& mask) {
    JsonReader::Kind kind;
    if (!value_kind(kind)) return false;
    if (kind == JsonReader::kNull) return skip_value();
    if (kind != JsonReader::kArray) return semantic(p, "expected a list of strings");
    if (!r_.begin_array()) return json_error();
    int k;
    while ((k = r_.next_element()) == 1) {
      if (!value_kind(kind)) return false;
      if (kind != JsonReader::kString) return semantic(p, "expected a list of strings");
      std::string_view s;
      if (!string_value(s)) return false;
      for (size_t i = 0; i < law_.tags.size(); i++) {
        if (law_.tags[i] == s) mask |= int64_t(1) << i;
      }
    }
    return k == 0 || json_error();
  }

  JsonReader r_;
  const Law& law_;
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

bool parse_input(const char* json, size_t len, const Law& law, Input& in, std::string& err) {
  InputParser p(json, len, law, in, err);
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
    out.put(",\"alt_cap_rule_ids\":");
    out.put(f.proof_array[l.alt_proof]);
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
    if (k == CK_DEADLINE) {
      // Notes the program attached to this check, in note order.
      out.put(",\"flags\":[");
      bool first_note = true;
      for (uint8_t note = 0; note < CN_COUNT; note++) {
        if (note_check(note) != k || !(ev.notes & (uint32_t(1) << note))) continue;
        if (!first_note) out.put(',');
        first_note = false;
        out.put('"');
        out.put(note_name(note));
        out.put('"');
      }
      out.put(']');
    }
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
  if (!json || !parse_input(json, json_len, law, in, err)) {
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

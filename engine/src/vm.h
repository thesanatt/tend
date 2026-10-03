// The law VM: runs the per-item program once per item, then the aggregate
// program once. Only verified images (load_law) may be executed.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "image.h"

namespace tend {

struct Context {
  int64_t field[CX_COUNT] = {0, 0, PR_UNKNOWN, 0};
};

struct Item {
  int64_t field[IF_COUNT] = {0, 0, EXP_UNKNOWN, 0, 0, 0, 0, 0, UNIT_NONE};
  std::string_view id;
};

struct Line {
  int64_t requested = 0;
  int64_t allowed = 0;
  uint32_t proof = 0;
  uint32_t alt_proof = 0;  // alternate cap rules for this line's expense
  int32_t cap_rule = -1;
  uint8_t status = ST_UNKNOWN_RULE;
  uint8_t expense = EXP_UNKNOWN;
};

struct TraceEntry {
  int64_t delta;
  uint32_t line;  // kNone for checks
  int32_t rule;   // -1 for none
  uint8_t op;
};

struct CheckResult {
  uint8_t status = 0;
  uint32_t proof = 0;
  bool has_date = false;
  int64_t date = 0;
};

struct Evaluation {
  std::vector<Line> lines;  // lines[i] belongs to items[i]
  std::vector<TraceEntry> trace;
  std::vector<std::pair<uint32_t, uint16_t>> flags;  // (line, rule) in the order raised
  CheckResult checks[CK_COUNT];
  bool has_info = false;
  uint32_t info_proof = 0;
  uint32_t notes = 0;  // bit n set when the program attached CheckNote n
  uint64_t steps = 0;
};

// Processing order: (date, item_id), stable for exact ties.
void sort_items(std::vector<Item>& items);

// `items` must already be in processing order.
bool run_vm(const Law& law, const Context& ctx, const std::vector<Item>& items, Evaluation& ev,
            std::string& err, bool trace = true);

inline int64_t sat_add(int64_t a, int64_t b) {
  int64_t r;
  if (__builtin_add_overflow(a, b, &r)) return b > 0 ? INT64_MAX : INT64_MIN;
  return r;
}
inline int64_t sat_sub(int64_t a, int64_t b) {
  int64_t r;
  if (__builtin_sub_overflow(a, b, &r)) return b < 0 ? INT64_MAX : INT64_MIN;
  return r;
}
inline int64_t sat_mul(int64_t a, int64_t b) {
  int64_t r;
  if (__builtin_mul_overflow(a, b, &r)) return (a < 0) != (b < 0) ? INT64_MIN : INT64_MAX;
  return r;
}

}  // namespace tend

#include "civil.h"

namespace tend {

bool parse_date(std::string_view s, int64_t& day) {
  if (s.size() != 10 || s[4] != '-' || s[7] != '-') return false;
  auto digits = [&](size_t at, size_t n, unsigned& v) {
    v = 0;
    for (size_t i = at; i < at + n; i++) {
      if (s[i] < '0' || s[i] > '9') return false;
      v = v * 10 + unsigned(s[i] - '0');
    }
    return true;
  };
  unsigned y, m, d;
  if (!digits(0, 4, y) || !digits(5, 2, m) || !digits(8, 2, d)) return false;
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days_in_month(y, m)) return false;
  day = days_from_civil(y, m, d);
  return true;
}

void format_date(int64_t day, char out[10]) {
  if (day < kMinDay) day = kMinDay;
  if (day > kMaxDay) day = kMaxDay;
  int64_t y;
  unsigned m, d;
  civil_from_days(day, y, m, d);
  out[0] = char('0' + y / 1000);
  out[1] = char('0' + y / 100 % 10);
  out[2] = char('0' + y / 10 % 10);
  out[3] = char('0' + y % 10);
  out[4] = '-';
  out[5] = char('0' + m / 10);
  out[6] = char('0' + m % 10);
  out[7] = '-';
  out[8] = char('0' + d / 10);
  out[9] = char('0' + d % 10);
}

int64_t add_years(int64_t day, int64_t years) {
  if (day < kMinDay) day = kMinDay;
  if (day > kMaxDay) day = kMaxDay;
  if (years > 10000) return kMaxDay;
  if (years < -10000) return kMinDay;
  int64_t y;
  unsigned m, d;
  civil_from_days(day, y, m, d);
  y += years;
  if (y > 9999) return kMaxDay;
  if (y < 1) return kMinDay;
  if (m == 2 && d == 29 && !is_leap(y)) d = 28;
  return days_from_civil(y, m, d);
}

}  // namespace tend

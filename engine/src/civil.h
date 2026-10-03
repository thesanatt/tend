// Proleptic Gregorian dates as day numbers (days since 1970-01-01), after
// Howard Hinnant's public-domain civil calendar algorithms.
#pragma once

#include <cstdint>
#include <string_view>

namespace tend {

constexpr int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = unsigned(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + int64_t(doe) - 719468;
}

constexpr void civil_from_days(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = unsigned(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y = int64_t(yoe) + era * 400 + (m <= 2);
}

constexpr bool is_leap(int64_t y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

constexpr unsigned days_in_month(int64_t y, unsigned m) {
  constexpr unsigned kDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return m == 2 && is_leap(y) ? 29 : kDays[m - 1];
}

constexpr int64_t kMinDay = days_from_civil(1, 1, 1);
constexpr int64_t kMaxDay = days_from_civil(9999, 12, 31);

// Strict YYYY-MM-DD with a real calendar day in years 0001..9999.
bool parse_date(std::string_view s, int64_t& day);

// Writes exactly 10 chars; days outside 0001-01-01..9999-12-31 are clamped.
void format_date(int64_t day, char out[10]);

}  // namespace tend

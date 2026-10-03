// SHA-256, calendar math, and the runtime JSON reader/writer.
#include <climits>
#include <string>

#include "civil.h"
#include "disasm.h"
#include "doctest/doctest.h"
#include "json.h"
#include "sha256.h"

using namespace tend;

static std::string sha_hex(const std::string& s) {
  uint8_t d[32];
  sha256(s.data(), s.size(), d);
  return to_hex(d, 32);
}

TEST_CASE("sha256 matches FIPS 180-4 test vectors") {
  CHECK(sha_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(sha_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK(sha_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  CHECK(sha_hex(std::string(1000000, 'a')) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST_CASE("sha256 incremental updates equal one-shot at every split") {
  std::string msg;
  for (int i = 0; i < 200; i++) msg += char('a' + i % 26);
  for (size_t len : {0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 200}) {
    std::string m = msg.substr(0, len);
    std::string whole = sha_hex(m);
    for (size_t split = 0; split <= len; split += 7) {
      Sha256 h;
      h.update(m.data(), split);
      h.update(m.data() + split, len - split);
      uint8_t d[32];
      h.digest(d);
      CHECK(to_hex(d, 32) == whole);
    }
  }
}

TEST_CASE("hex round trip") {
  uint8_t b[4];
  CHECK(from_hex("00ff7Aa1", 8, b));
  CHECK(to_hex(b, 4) == "00ff7aa1");
  CHECK_FALSE(from_hex("0g", 2, b));
  CHECK_FALSE(from_hex("abc", 3, b));
}

TEST_CASE("dates parse strictly") {
  int64_t d = -1;
  CHECK(parse_date("1970-01-01", d));
  CHECK(d == 0);
  CHECK(parse_date("2024-02-29", d));
  CHECK(parse_date("0001-01-01", d));
  CHECK(d == kMinDay);
  CHECK(parse_date("9999-12-31", d));
  CHECK(d == kMaxDay);
  for (const char* bad : {"2026-02-29", "2026-13-01", "2026-00-10", "2026-06-31", "2026-1-01", "20260614",
                          "2026-06-14T00:00", "0000-01-01", "2026/06/14", "", "2026-06-1x", "1900-02-29"}) {
    CAPTURE(bad);
    CHECK_FALSE(parse_date(bad, d));
  }
}

TEST_CASE("day numbers round trip through formatting") {
  for (int64_t day = -800000; day <= 2900000; day += 997) {
    if (day < kMinDay || day > kMaxDay) continue;
    char buf[10];
    format_date(day, buf);
    int64_t back;
    REQUIRE(parse_date(std::string_view(buf, 10), back));
    CHECK(back == day);
  }
  char buf[10];
  format_date(INT64_MIN, buf);
  CHECK(std::string(buf, 10) == "0001-01-01");
  format_date(INT64_MAX, buf);
  CHECK(std::string(buf, 10) == "9999-12-31");
}

TEST_CASE("day arithmetic matches the calendar") {
  int64_t a, b;
  REQUIRE(parse_date("2026-06-14", a));
  REQUIRE(parse_date("2031-06-14", b));
  CHECK(b - a == 1826);  // five years with one leap day, as the IR counts them
  REQUIRE(parse_date("2028-03-01", b));
  REQUIRE(parse_date("2028-02-28", a));
  CHECK(b - a == 2);
}

TEST_CASE("money formatting") {
  CHECK(format_cents(0) == "$0.00");
  CHECK(format_cents(5) == "$0.05");
  CHECK(format_cents(380000) == "$3,800.00");
  CHECK(format_cents(123456789) == "$1,234,567.89");
  CHECK(format_cents(-150) == "-$1.50");
  CHECK(format_cents(INT64_MIN) == "-$92,233,720,368,547,758.08");
}

TEST_CASE("json reader walks objects, arrays, and scalars") {
  std::string doc = R"( {"a": [1, -2, 0, true, false, null, "x\n\u00e9\ud83d\ude00"], "b": {"c": 9223372036854775807},
                        "d": -9223372036854775808, "e": 1.5e3} )";
  JsonReader r(doc.data(), doc.size());
  REQUIRE(r.begin_object());
  std::string_view k;
  REQUIRE(r.next_key(k) == 1);
  CHECK(k == "a");
  REQUIRE(r.begin_array());
  int64_t v;
  REQUIRE(r.next_element() == 1);
  REQUIRE(r.read_int64(v));
  CHECK(v == 1);
  REQUIRE(r.next_element() == 1);
  REQUIRE(r.read_int64(v));
  CHECK(v == -2);
  REQUIRE(r.next_element() == 1);
  REQUIRE(r.read_int64(v));
  CHECK(v == 0);
  bool b;
  REQUIRE(r.next_element() == 1);
  REQUIRE(r.read_bool(b));
  CHECK(b);
  REQUIRE(r.next_element() == 1);
  REQUIRE(r.read_bool(b));
  CHECK_FALSE(b);
  REQUIRE(r.next_element() == 1);
  CHECK(r.peek() == JsonReader::kNull);
  REQUIRE(r.skip());
  REQUIRE(r.next_element() == 1);
  std::string_view s;
  bool scratch = false;
  REQUIRE(r.read_string(s, &scratch));
  CHECK(scratch);
  CHECK(s == "x\n\xC3\xA9\xF0\x9F\x98\x80");
  CHECK(r.next_element() == 0);
  REQUIRE(r.next_key(k) == 1);
  CHECK(k == "b");
  REQUIRE(r.begin_object());
  REQUIRE(r.next_key(k) == 1);
  REQUIRE(r.read_int64(v));
  CHECK(v == INT64_MAX);
  CHECK(r.next_key(k) == 0);
  REQUIRE(r.next_key(k) == 1);
  REQUIRE(r.read_int64(v));
  CHECK(v == INT64_MIN);
  REQUIRE(r.next_key(k) == 1);
  CHECK(k == "e");
  REQUIRE(r.skip());
  CHECK(r.next_key(k) == 0);
  CHECK(r.finish());
}

static bool skips(const std::string& doc) {
  JsonReader r(doc.data(), doc.size());
  return r.skip() && r.finish();
}

TEST_CASE("json reader rejects malformed documents") {
  CHECK(skips(R"({"a":[1,2,{"b":null}],"c":"\u0041"})"));
  CHECK(skips("  0  "));
  CHECK(skips("-0.0e-0"));
  for (const char* bad : {"", "{", "{\"a\"}", "{\"a\":}", "{\"a\":1,}", "[1,]", "[1 2]", "{\"a\" 1}", "\"abc",
                          "\"a\x01\"", "\"\\x\"", "\"\\u12\"", "\"\\ud800\"", "\"\\udc00\"", "\"\\ud800\\u0041\"", "01",
                          "1.", "1e", "-", "tru", "nul", "{} x", "[]]", "\"\xC3\x28\"", "\"\xED\xA0\x80\"",
                          "\"\xF8\x88\x80\x80\x80\"", "\"\xC0\xAF\""}) {
    CAPTURE(bad);
    CHECK_FALSE(skips(bad));
  }
  std::string deep(65, '[');
  deep += std::string(65, ']');
  CHECK_FALSE(skips(deep));
  std::string ok_deep(64, '[');
  ok_deep += std::string(64, ']');
  CHECK(skips(ok_deep));
}

TEST_CASE("json integers are strict") {
  for (const char* bad : {"1.0", "1e2", "9223372036854775808", "-9223372036854775809", "18446744073709551616", "+1",
                          "01", "\"1\""}) {
    CAPTURE(bad);
    std::string d = bad;
    JsonReader r(d.data(), d.size());
    int64_t v;
    CHECK_FALSE(r.read_int64(v));
  }
}

TEST_CASE("json writer escapes") {
  OutBuf b;
  b.put_json_string(std::string("a\"b\\c\n\t\x01\x1f") + "\xC3\xA9");
  CHECK(b.view() == "\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\xC3\xA9\"");
  b.put_i64(INT64_MIN);
  CHECK(b.view().substr(b.size() - 20) == "-9223372036854775808");
  char* s = b.release();
  REQUIRE(s != nullptr);
  CHECK(s[0] == '"');
  std::free(s);
  OutBuf empty;
  char* e = empty.release();
  REQUIRE(e != nullptr);
  CHECK(std::string(e).empty());
  std::free(e);
}

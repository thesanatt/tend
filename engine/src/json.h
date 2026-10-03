// Minimal strict JSON (RFC 8259) pull reader and a malloc-backed writer.
// No exceptions and no DOM, so the same code runs natively and in WASM.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>

namespace tend {

bool valid_utf8(const unsigned char* s, size_t n);

class JsonReader {
 public:
  static constexpr int kMaxDepth = 64;
  enum Kind { kNull, kFalse, kTrue, kNumber, kString, kArray, kObject, kInvalid };

  JsonReader(const char* data, size_t len) : begin_(data), p_(data), end_(data + len) {}

  Kind peek();
  bool begin_object();
  // 1: key read and ':' consumed; 0: object closed; -1: error.
  int next_key(std::string_view& key);
  bool begin_array();
  // 1: an element follows; 0: array closed; -1: error.
  int next_element();
  // The view points into the input unless *scratch is set, in which case it is
  // only valid until the next string read.
  bool read_string(std::string_view& out, bool* scratch = nullptr);
  bool read_int64(int64_t& v);
  bool read_bool(bool& v);
  bool skip();
  bool finish();

  bool fail(const char* msg);
  const char* error() const { return err_ ? err_ : "ok"; }
  size_t offset() const { return size_t(p_ - begin_); }

 private:
  void ws();
  bool parse_string(std::string_view& out, std::string& scratch, bool& used_scratch);
  bool skip_number();
  bool literal(const char* word, size_t n);

  const char* begin_;
  const char* p_;
  const char* end_;
  std::string scratch_;
  std::string key_scratch_;
  bool first_[kMaxDepth] = {};
  int depth_ = 0;
  const char* err_ = nullptr;
};

// Growable byte buffer whose storage can be handed to C callers (free()).
class OutBuf {
 public:
  OutBuf() = default;
  OutBuf(const OutBuf&) = delete;
  OutBuf& operator=(const OutBuf&) = delete;
  ~OutBuf() { std::free(p_); }

  void reserve(size_t n) {
    if (n > cap_) grow(n - n_);
  }
  void put(char c) {
    if (n_ + 1 > cap_ && !grow(1)) return;
    p_[n_++] = c;
  }
  void put(std::string_view s) {
    if (n_ + s.size() > cap_ && !grow(s.size())) return;
    if (!s.empty()) std::memcpy(p_ + n_, s.data(), s.size());
    n_ += s.size();
  }
  void put_i64(int64_t v);
  void put_json_string(std::string_view s);

  bool failed() const { return oom_; }
  std::string_view view() const { return std::string_view(p_ ? p_ : "", n_); }
  size_t size() const { return n_; }
  // NUL-terminated malloc'd string, or nullptr if an allocation failed.
  char* release();

 private:
  bool grow(size_t extra);
  char* p_ = nullptr;
  size_t n_ = 0;
  size_t cap_ = 0;
  bool oom_ = false;
};

// Quoted, escaped JSON string literal.
std::string json_quote(std::string_view s);

}  // namespace tend

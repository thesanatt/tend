#include "json.h"

#include <charconv>
#include <climits>

namespace tend {

bool valid_utf8(const unsigned char* s, size_t n) {
  size_t i = 0;
  while (i < n) {
    unsigned char c = s[i];
    if (c < 0x80) {
      i++;
      continue;
    }
    size_t len;
    uint32_t cp;
    if (c >= 0xC2 && c <= 0xDF) {
      len = 2;
      cp = c & 0x1F;
    } else if ((c & 0xF0) == 0xE0) {
      len = 3;
      cp = c & 0x0F;
    } else if (c >= 0xF0 && c <= 0xF4) {
      len = 4;
      cp = c & 0x07;
    } else {
      return false;
    }
    if (n - i < len) return false;
    for (size_t k = 1; k < len; k++) {
      unsigned char cc = s[i + k];
      if ((cc & 0xC0) != 0x80) return false;
      cp = cp << 6 | (cc & 0x3F);
    }
    if (len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) return false;
    if (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) return false;
    i += len;
  }
  return true;
}

bool JsonReader::fail(const char* msg) {
  if (!err_) err_ = msg;
  return false;
}

void JsonReader::ws() {
  while (p_ < end_ && (*p_ == ' ' || *p_ == '\n' || *p_ == '\r' || *p_ == '\t')) p_++;
}

JsonReader::Kind JsonReader::peek() {
  ws();
  if (p_ >= end_) return kInvalid;
  switch (*p_) {
    case '{': return kObject;
    case '[': return kArray;
    case '"': return kString;
    case 't': return kTrue;
    case 'f': return kFalse;
    case 'n': return kNull;
    default:
      if (*p_ == '-' || (*p_ >= '0' && *p_ <= '9')) return kNumber;
      return kInvalid;
  }
}

bool JsonReader::begin_object() {
  ws();
  if (p_ >= end_ || *p_ != '{') return fail("expected an object");
  if (depth_ >= kMaxDepth) return fail("nesting too deep");
  p_++;
  first_[depth_++] = true;
  return true;
}

bool JsonReader::begin_array() {
  ws();
  if (p_ >= end_ || *p_ != '[') return fail("expected an array");
  if (depth_ >= kMaxDepth) return fail("nesting too deep");
  p_++;
  first_[depth_++] = true;
  return true;
}

int JsonReader::next_key(std::string_view& key) {
  if (err_ || depth_ <= 0) return -1;
  ws();
  if (p_ >= end_) return fail("unterminated object"), -1;
  if (*p_ == '}') {
    p_++;
    depth_--;
    return 0;
  }
  if (first_[depth_ - 1]) {
    first_[depth_ - 1] = false;
  } else {
    if (*p_ != ',') return fail("expected ',' or '}'"), -1;
    p_++;
    ws();
  }
  if (p_ >= end_ || *p_ != '"') return fail("expected a key string"), -1;
  bool scratch;
  if (!parse_string(key, key_scratch_, scratch)) return -1;
  ws();
  if (p_ >= end_ || *p_ != ':') return fail("expected ':'"), -1;
  p_++;
  return 1;
}

int JsonReader::next_element() {
  if (err_ || depth_ <= 0) return -1;
  ws();
  if (p_ >= end_) return fail("unterminated array"), -1;
  if (*p_ == ']') {
    p_++;
    depth_--;
    return 0;
  }
  if (first_[depth_ - 1]) {
    first_[depth_ - 1] = false;
  } else {
    if (*p_ != ',') return fail("expected ',' or ']'"), -1;
    p_++;
  }
  return 1;
}

static void put_utf8(std::string& s, uint32_t cp) {
  if (cp < 0x80) {
    s.push_back(char(cp));
  } else if (cp < 0x800) {
    s.push_back(char(0xC0 | cp >> 6));
    s.push_back(char(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    s.push_back(char(0xE0 | cp >> 12));
    s.push_back(char(0x80 | (cp >> 6 & 0x3F)));
    s.push_back(char(0x80 | (cp & 0x3F)));
  } else {
    s.push_back(char(0xF0 | cp >> 18));
    s.push_back(char(0x80 | (cp >> 12 & 0x3F)));
    s.push_back(char(0x80 | (cp >> 6 & 0x3F)));
    s.push_back(char(0x80 | (cp & 0x3F)));
  }
}

static int hex4(const char* p, const char* end, uint32_t& v) {
  if (end - p < 4) return 0;
  v = 0;
  for (int i = 0; i < 4; i++) {
    char c = p[i];
    int d;
    if (c >= '0' && c <= '9') d = c - '0';
    else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
    else return 0;
    v = v << 4 | uint32_t(d);
  }
  return 1;
}

bool JsonReader::parse_string(std::string_view& out, std::string& scratch, bool& used_scratch) {
  const char* s = ++p_;  // past the opening quote
  const char* q = s;
  while (q < end_) {
    unsigned char c = static_cast<unsigned char>(*q);
    if (c == '"') {
      if (!valid_utf8(reinterpret_cast<const unsigned char*>(s), size_t(q - s)))
        return fail("invalid UTF-8 in string");
      out = std::string_view(s, size_t(q - s));
      used_scratch = false;
      p_ = q + 1;
      return true;
    }
    if (c == '\\') break;
    if (c < 0x20) return fail("control character in string");
    q++;
  }
  if (q >= end_) return fail("unterminated string");
  scratch.assign(s, size_t(q - s));
  while (q < end_) {
    unsigned char c = static_cast<unsigned char>(*q);
    if (c == '"') {
      if (!valid_utf8(reinterpret_cast<const unsigned char*>(scratch.data()), scratch.size()))
        return fail("invalid UTF-8 in string");
      out = scratch;
      used_scratch = true;
      p_ = q + 1;
      return true;
    }
    if (c < 0x20) return fail("control character in string");
    if (c != '\\') {
      scratch.push_back(char(c));
      q++;
      continue;
    }
    if (++q >= end_) return fail("unterminated escape");
    switch (*q) {
      case '"': scratch.push_back('"'); break;
      case '\\': scratch.push_back('\\'); break;
      case '/': scratch.push_back('/'); break;
      case 'b': scratch.push_back('\b'); break;
      case 'f': scratch.push_back('\f'); break;
      case 'n': scratch.push_back('\n'); break;
      case 'r': scratch.push_back('\r'); break;
      case 't': scratch.push_back('\t'); break;
      case 'u': {
        uint32_t cp;
        if (!hex4(q + 1, end_, cp)) return fail("bad \\u escape");
        q += 4;
        if (cp >= 0xDC00 && cp <= 0xDFFF) return fail("unpaired surrogate");
        if (cp >= 0xD800 && cp <= 0xDBFF) {
          uint32_t lo;
          if (end_ - q < 7 || q[1] != '\\' || q[2] != 'u' || !hex4(q + 3, end_, lo) || lo < 0xDC00 ||
              lo > 0xDFFF)
            return fail("unpaired surrogate");
          q += 6;
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        }
        put_utf8(scratch, cp);
        break;
      }
      default: return fail("bad escape");
    }
    q++;
  }
  return fail("unterminated string");
}

bool JsonReader::read_string(std::string_view& out, bool* scratch) {
  ws();
  if (p_ >= end_ || *p_ != '"') return fail("expected a string");
  bool used;
  if (!parse_string(out, scratch_, used)) return false;
  if (scratch) *scratch = used;
  return true;
}

bool JsonReader::read_int64(int64_t& v) {
  ws();
  bool neg = false;
  if (p_ < end_ && *p_ == '-') {
    neg = true;
    p_++;
  }
  if (p_ >= end_ || *p_ < '0' || *p_ > '9') return fail("expected an integer");
  if (*p_ == '0' && p_ + 1 < end_ && p_[1] >= '0' && p_[1] <= '9') return fail("leading zero");
  uint64_t acc = 0;
  while (p_ < end_ && *p_ >= '0' && *p_ <= '9') {
    uint64_t d = uint64_t(*p_ - '0');
    if (acc > (UINT64_MAX - d) / 10) return fail("integer out of range");
    acc = acc * 10 + d;
    p_++;
  }
  if (p_ < end_ && (*p_ == '.' || *p_ == 'e' || *p_ == 'E')) return fail("expected an integer");
  if (neg) {
    if (acc > uint64_t(INT64_MAX) + 1) return fail("integer out of range");
    v = acc == uint64_t(INT64_MAX) + 1 ? INT64_MIN : -int64_t(acc);
  } else {
    if (acc > uint64_t(INT64_MAX)) return fail("integer out of range");
    v = int64_t(acc);
  }
  return true;
}

bool JsonReader::literal(const char* word, size_t n) {
  if (size_t(end_ - p_) < n || std::memcmp(p_, word, n) != 0) return fail("bad literal");
  p_ += n;
  return true;
}

bool JsonReader::read_bool(bool& v) {
  switch (peek()) {
    case kTrue: v = true; return literal("true", 4);
    case kFalse: v = false; return literal("false", 5);
    default: return fail("expected true or false");
  }
}

bool JsonReader::skip_number() {
  auto digit = [&] { return p_ < end_ && *p_ >= '0' && *p_ <= '9'; };
  if (p_ < end_ && *p_ == '-') p_++;
  if (!digit()) return fail("bad number");
  if (*p_ == '0') {
    p_++;
  } else {
    while (digit()) p_++;
  }
  if (p_ < end_ && *p_ == '.') {
    p_++;
    if (!digit()) return fail("bad number");
    while (digit()) p_++;
  }
  if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
    p_++;
    if (p_ < end_ && (*p_ == '+' || *p_ == '-')) p_++;
    if (!digit()) return fail("bad number");
    while (digit()) p_++;
  }
  return true;
}

bool JsonReader::skip() {
  switch (peek()) {
    case kObject: {
      if (!begin_object()) return false;
      std::string_view k;
      int r;
      while ((r = next_key(k)) == 1) {
        if (!skip()) return false;
      }
      return r == 0;
    }
    case kArray: {
      if (!begin_array()) return false;
      int r;
      while ((r = next_element()) == 1) {
        if (!skip()) return false;
      }
      return r == 0;
    }
    case kString: {
      std::string_view s;
      return read_string(s);
    }
    case kNumber: return skip_number();
    case kTrue: return literal("true", 4);
    case kFalse: return literal("false", 5);
    case kNull: return literal("null", 4);
    default: return fail("expected a value");
  }
}

bool JsonReader::finish() {
  ws();
  if (err_) return false;
  if (p_ != end_) return fail("trailing characters after JSON value");
  return true;
}

bool OutBuf::grow(size_t extra) {
  if (oom_) return false;
  size_t need = n_ + extra;
  if (need < n_) {
    oom_ = true;
    return false;
  }
  size_t cap = cap_ ? cap_ : 256;
  while (cap < need + 1) {
    if (cap > SIZE_MAX / 2) {
      cap = need + 1;
      break;
    }
    cap *= 2;
  }
  char* np = static_cast<char*>(std::realloc(p_, cap));
  if (!np) {
    oom_ = true;
    return false;
  }
  p_ = np;
  cap_ = cap;
  return true;
}

void OutBuf::put_i64(int64_t v) {
  char tmp[24];
  auto r = std::to_chars(tmp, tmp + sizeof tmp, v);
  put(std::string_view(tmp, size_t(r.ptr - tmp)));
}

void OutBuf::put_json_string(std::string_view s) {
  static const char kHex[] = "0123456789abcdef";
  put('"');
  size_t run = 0;
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c >= 0x20 && c != '"' && c != '\\') continue;
    put(s.substr(run, i - run));
    run = i + 1;
    switch (c) {
      case '"': put("\\\""); break;
      case '\\': put("\\\\"); break;
      case '\n': put("\\n"); break;
      case '\r': put("\\r"); break;
      case '\t': put("\\t"); break;
      case '\b': put("\\b"); break;
      case '\f': put("\\f"); break;
      default: {
        char esc[6] = {'\\', 'u', '0', '0', kHex[c >> 4], kHex[c & 15]};
        put(std::string_view(esc, 6));
      }
    }
  }
  put(s.substr(run));
  put('"');
}

char* OutBuf::release() {
  if (oom_) return nullptr;
  if ((!p_ || n_ + 1 > cap_) && !grow(1)) return nullptr;
  p_[n_] = '\0';
  char* r = p_;
  p_ = nullptr;
  n_ = cap_ = 0;
  return r;
}

std::string json_quote(std::string_view s) {
  OutBuf b;
  b.put_json_string(s);
  return std::string(b.view());
}

}  // namespace tend

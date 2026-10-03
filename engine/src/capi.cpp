#include <cstdlib>
#include <cstring>
#include <new>

#include "disasm.h"
#include "eval.h"
#include "tend/tend.h"
#include "version.h"

namespace {

char* dup_string(const std::string& s) {
  char* p = static_cast<char*>(std::malloc(s.size() + 1));
  if (!p) return nullptr;
  std::memcpy(p, s.data(), s.size());
  p[s.size()] = '\0';
  return p;
}

// Nothing in the engine throws on purpose; this only turns allocation
// failure into a NULL return instead of unwinding across the C boundary.
template <class F>
char* guarded(F&& f) {
#if defined(__cpp_exceptions)
  try {
    return f();
  } catch (...) {
    return nullptr;
  }
#else
  return f();
#endif
}

}  // namespace

extern "C" {

TEND_API const char* tend_version(void) { return TEND_VERSION_STRING; }

TEND_API char* tend_eval_json(const uint8_t* img, size_t img_len, const char* input_json) {
  return guarded([&]() -> char* {
    tend::OutBuf out;
    tend::evaluate_to_json(img, img_len, input_json, input_json ? std::strlen(input_json) : 0, out);
    return out.release();
  });
}

TEND_API char* tend_disasm(const uint8_t* img, size_t img_len) {
  return guarded([&]() -> char* {
    tend::Law law;
    std::string err;
    if (!tend::load_law(img, img_len, law, err)) return dup_string("error: " + err + "\n");
    return dup_string(tend::disassemble(law));
  });
}

TEND_API char* tend_inspect_json(const uint8_t* img, size_t img_len) {
  return guarded([&]() -> char* {
    tend::OutBuf out;
    tend::Law law;
    std::string err;
    if (!tend::load_law(img, img_len, law, err)) tend::render_error("bad_image", err, out);
    else tend::inspect_json(law, out);
    return out.release();
  });
}

TEND_API void tend_free(void* p) { std::free(p); }

}  // extern "C"

/* Tend law engine C ABI. The same symbols are exported by libtend (native)
 * and by the WebAssembly build (tend.js / tend.wasm).
 *
 * Every function that returns char* returns a NUL-terminated UTF-8 string
 * allocated by the engine; release it with tend_free. They return NULL only
 * when memory runs out. All functions are reentrant: no global state. */
#ifndef TEND_TEND_H
#define TEND_TEND_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define TEND_API __declspec(dllexport)
#else
#define TEND_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* "tend 1.0.0 (tlaw 1.0)". Static string; do not free. */
TEND_API const char* tend_version(void);

/* Evaluates a claim (engine input JSON, docs/SPEC.md) against a law image.
 * Returns the output JSON, or {"error":{"code":...,"message":...}} where code
 * is bad_image, bad_input, jurisdiction_mismatch, or vm_trap. */
TEND_API char* tend_eval_json(const uint8_t* img, size_t img_len, const char* input_json);

/* Assembly listing of a law image, or a single line starting with "error: ". */
TEND_API char* tend_disasm(const uint8_t* img, size_t img_len);

/* Image header, rule table (ids, categories, pinpoints, quotes, sources) and
 * program stats as JSON, or an error document as in tend_eval_json. */
TEND_API char* tend_inspect_json(const uint8_t* img, size_t img_len);

TEND_API void tend_free(void* p);

#ifdef __cplusplus
}
#endif

#endif /* TEND_TEND_H */

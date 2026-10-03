/* Stand-in for libtend with the same C ABI, so the API's ctypes binding is tested for real. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *copy(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

const char *tend_version(void) { return "fake-1.0"; }

char *tend_eval_json(const uint8_t *img, size_t img_len, const char *input_json) {
    if (img_len < 4 || memcmp(img, "TLAW", 4) != 0) return copy("{\"error\":\"bad law image magic\"}");
    if (strstr(input_json, "\"items\":[]") == NULL) return copy("{\"error\":\"fake engine only evaluates empty claims\"}");
    char out[512];
    snprintf(out, sizeof out,
             "{\"jurisdiction\":\"MI\",\"law_image_sha256\":\"fake\",\"lines\":[],"
             "\"totals\":{\"requested_cents\":0,\"allowed_cents\":0,\"held_cents\":0,\"by_expense\":{}},"
             "\"checks\":{},\"info_rule_ids\":[],\"trace\":[{\"op\":\"image_bytes\",\"item_id\":null,\"rule_id\":null,\"delta_cents\":%zu}]}",
             img_len);
    return copy(out);
}

char *tend_disasm(const uint8_t *img, size_t img_len) {
    char out[128];
    snprintf(out, sizeof out, "; fake listing for %zu bytes\nHALT\n", img_len);
    return copy(out);
}

void tend_free(void *p) { free(p); }

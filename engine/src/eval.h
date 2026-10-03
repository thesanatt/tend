// Engine input (claim JSON) -> VM -> engine output JSON, per docs/SPEC.md.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "image.h"
#include "json.h"
#include "vm.h"

namespace tend {

struct Input {
  std::string jurisdiction;
  bool has_jurisdiction = false;
  Context ctx;
  std::vector<Item> items;
  std::vector<std::unique_ptr<char[]>> arena;  // decoded item ids that had escapes
};

// Item tags are mapped to bits through the law's tag table; tags the law
// never mentions cannot change an outcome and are dropped.
bool parse_input(const char* json, size_t len, const Law& law, Input& in, std::string& err);

// Renders the output document. `items` and `ev.lines` are in processing order.
void render_output(const Law& law, const std::vector<Item>& items, const Evaluation& ev, OutBuf& out);

void render_error(std::string_view code, std::string_view message, OutBuf& out);

// Whole pipeline; always writes either an output document or an error document.
// Returns false when the result is an error document.
bool evaluate_to_json(const uint8_t* img, size_t img_len, const char* json, size_t json_len,
                      OutBuf& out);

}  // namespace tend

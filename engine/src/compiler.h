// tendc: law IR (docs/SPEC.md v1.1, rules/ir/ST.json) -> .tlaw image.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace tend {

struct CompileResult {
  std::vector<uint8_t> image;
  std::vector<std::string> notes;  // what the compiler set aside or could not attach
};

// `ir_bytes` decides the semantics. `verified_bytes` (rules/verified/ST.json)
// supplies quotes, pinpoints, and sources for the constant pool; its sha256
// must equal the IR's source_sha256, which goes in the image header. With no
// verified file the image still runs but carries no quotes.
// Output is deterministic: the same inputs always give the same bytes.
bool compile_law(const std::string& ir_bytes, const std::string& verified_bytes, CompileResult& out,
                 std::string& err);

}  // namespace tend

// tendc: verified jurisdiction JSON (rules/SCHEMA.md) -> .tlaw image.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace tend {

struct CompileResult {
  std::vector<uint8_t> image;
  std::vector<std::string> warnings;  // rules the engine lists but cannot compute
};

// `json_bytes` is the verified file exactly as stored; its sha256 goes in the
// image header. Output is deterministic: same bytes in, same image out.
bool compile_law(const std::string& json_bytes, CompileResult& out, std::string& err);

}  // namespace tend

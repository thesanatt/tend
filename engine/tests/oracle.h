// A second, deliberately plain implementation of the engine semantics
// (FORMAT.md, "Semantics"). It shares no code with the compiler or VM, so the
// differential tests catch codegen and interpreter bugs.
#pragma once

#include "nlohmann/json.hpp"

namespace oracle {

// Same document as tend_eval_json, minus law_image_sha256.
nlohmann::json evaluate(const nlohmann::json& law, const nlohmann::json& input);

}  // namespace oracle

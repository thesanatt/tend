#pragma once

#include <string>

#include "image.h"
#include "json.h"

namespace tend {

// Readable assembly listing of a verified image (syntax in FORMAT.md).
std::string disassemble(const Law& law);

// Header, rule table, and sources as JSON, so callers can show proofs
// straight from the image.
void inspect_json(const Law& law, OutBuf& out);

// "$3,800.00" for 380000.
std::string format_cents(int64_t cents);

}  // namespace tend

// In-memory form of a verified .tlaw image. load_law() is the only way to get
// one: it checks every byte before the VM is allowed to run anything.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "format.h"

namespace tend {

// Pre-decoded instruction. Jump targets are instruction indices.
struct Insn {
  uint8_t op;
  uint8_t a;   // u8 operand: field, register, status, kind, selector, trace op, n cases
  uint16_t b;  // u16 operand: proof, rule, int-pool index
  int32_t c;   // PUSH immediate, jump target, or SWITCH table offset
};

struct Program {
  std::vector<Insn> code;
  std::vector<uint32_t> offsets;  // byte offset of each instruction
  std::vector<uint32_t> table;    // SWITCH tables: default, then cases
  uint32_t byte_size = 0;
  uint32_t max_depth = 0;
  uint32_t loops = 0;

  // Instruction index for a byte offset, or -1 if it is not an instruction start.
  int64_t index_of(uint32_t byte_offset) const;
};

struct Rule {
  uint8_t category;
  uint8_t expense;  // kNoExpense if the rule names none
  uint8_t per;
  uint32_t id, pinpoint, quote, summary, fragment, source, per_text;  // kNone when absent
};

struct Source {
  uint32_t id, url, title;
  uint8_t sha256[32];
};

struct Anno {
  uint8_t program;  // 0 item, 1 aggregate
  uint32_t pc;      // byte offset
  uint32_t rule;
};

struct Law {
  char jurisdiction[9] = {};
  uint16_t major = 0, minor = 0;
  uint8_t source_sha256[32] = {};
  uint8_t image_sha256[32] = {};  // sha256 of the whole file
  std::vector<std::string_view> strings;  // views into the caller's image buffer
  std::vector<int64_t> ints;
  std::vector<Source> sources;
  std::vector<Rule> rules;
  std::vector<uint32_t> proof_start;  // proof p is refs[start[p], start[p+1])
  std::vector<uint16_t> proof_refs;
  std::vector<int32_t> proof_first;  // first rule of each proof, or -1
  Program item, aggr;
  std::vector<Anno> annos;
  std::vector<std::pair<uint32_t, uint32_t>> meta;

  std::string_view str(uint32_t i) const {
    return i < strings.size() ? strings[i] : std::string_view();
  }
  uint32_t proof_count() const { return uint32_t(proof_start.empty() ? 0 : proof_start.size() - 1); }
  uint32_t proof_len(uint32_t p) const { return proof_start[p + 1] - proof_start[p]; }
  const uint16_t* proof_rules(uint32_t p) const { return proof_refs.data() + proof_start[p]; }
  std::string_view meta_value(std::string_view key) const;
};

enum LoadFlags : uint32_t { LOAD_DEFAULT = 0, LOAD_SKIP_CHECKSUM = 1 };

// The Law keeps views into `data`; the buffer must outlive it.
bool load_law(const uint8_t* data, size_t len, Law& law, std::string& err,
              uint32_t flags = LOAD_DEFAULT);

}  // namespace tend

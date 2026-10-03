// Writes .tlaw images. Used by tendc and by tests that need hand-made images.
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "format.h"

namespace tend {

class Assembler {
 public:
  using Label = uint32_t;

  Label label();
  void bind(Label l);
  uint32_t pc() const { return uint32_t(code_.size()); }

  void op(uint8_t opcode);
  void push(int32_t v);
  void u8op(uint8_t opcode, uint8_t a);
  void u16op(uint8_t opcode, uint16_t b);
  void u8u16(uint8_t opcode, uint8_t a, uint16_t b);
  void jump(uint8_t opcode, Label target);  // JMP, JZ, JNZ, NEXT
  void each(uint8_t selector, Label end);
  void sw(const std::vector<Label>& cases, Label fallback);
  void raw(const std::vector<uint8_t>& bytes);

  // Resolves label fixups; fails if a used label was never bound.
  bool finish(std::vector<uint8_t>& out, std::string& err) const;

 private:
  void u32_fixup(Label l);
  std::vector<uint8_t> code_;
  std::vector<int64_t> labels_;
  struct Fixup {
    uint32_t at;
    Label label;
  };
  std::vector<Fixup> fixups_;
};

struct RuleRecord {
  uint8_t category = 0;
  uint8_t expense = kNoExpense;
  uint8_t per = PER_NONE;
  uint32_t id = kNone, pinpoint = kNone, quote = kNone, summary = kNone, fragment = kNone,
           source = kNone, per_text = kNone;
};

struct SourceRecord {
  uint32_t id = kNone, url = kNone, title = kNone;
  uint8_t sha256[32] = {};
};

class ImageBuilder {
 public:
  ImageBuilder();

  uint32_t str(std::string_view s);
  uint32_t opt_str(std::string_view s) { return s.empty() ? kNone : str(s); }
  uint16_t int_const(int64_t v);
  uint32_t source(const SourceRecord& s);
  uint32_t rule(const RuleRecord& r);
  uint16_t proof(const std::vector<uint16_t>& rules);  // proof 0 is always the empty list
  void anno(uint8_t program, uint32_t pc, uint32_t rule);
  void meta(std::string_view key, std::string_view value);
  void set_jurisdiction(std::string_view code) { jurisdiction_ = std::string(code); }
  void set_source_sha256(const uint8_t sha[32]);

  size_t rule_count() const { return rules_.size(); }
  size_t proof_count() const { return proofs_.size(); }
  size_t int_count() const { return ints_.size(); }

  std::vector<uint8_t> build(const std::vector<uint8_t>& item, const std::vector<uint8_t>& aggr) const;

 private:
  std::string jurisdiction_;
  uint8_t source_sha_[32] = {};
  std::vector<std::string> strings_;
  std::map<std::string, uint32_t, std::less<>> string_index_;
  std::vector<int64_t> ints_;
  std::map<int64_t, uint16_t> int_index_;
  std::vector<SourceRecord> sources_;
  std::vector<RuleRecord> rules_;
  std::vector<std::vector<uint16_t>> proofs_;
  std::map<std::vector<uint16_t>, uint16_t> proof_index_;
  struct AnnoRec {
    uint8_t program;
    uint32_t pc, rule;
  };
  std::vector<AnnoRec> annos_;
  std::vector<std::pair<uint32_t, uint32_t>> meta_;
};

// Recomputes the trailer checksum after a test or fuzzer edits image bytes.
void reseal_image(std::vector<uint8_t>& image);
void reseal_image(uint8_t* image, size_t len);

// Locates a section in a built image; returns false if absent.
bool find_section(const std::vector<uint8_t>& image, uint32_t tag, uint32_t& offset, uint32_t& size);

}  // namespace tend

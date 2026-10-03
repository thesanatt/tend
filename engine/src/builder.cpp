#include "builder.h"

#include <algorithm>
#include <cstring>

#include "sha256.h"

namespace tend {
namespace {

void put16(std::vector<uint8_t>& v, uint16_t x) {
  v.push_back(uint8_t(x));
  v.push_back(uint8_t(x >> 8));
}
void put32(std::vector<uint8_t>& v, uint32_t x) {
  for (int i = 0; i < 4; i++) v.push_back(uint8_t(x >> (8 * i)));
}
void put64(std::vector<uint8_t>& v, int64_t x) {
  for (int i = 0; i < 8; i++) v.push_back(uint8_t(uint64_t(x) >> (8 * i)));
}
void set32(std::vector<uint8_t>& v, size_t at, uint32_t x) {
  for (int i = 0; i < 4; i++) v[at + size_t(i)] = uint8_t(x >> (8 * i));
}
uint32_t get32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

}  // namespace

Assembler::Label Assembler::label() {
  labels_.push_back(-1);
  return Label(labels_.size() - 1);
}

void Assembler::bind(Label l) { labels_[l] = int64_t(code_.size()); }

void Assembler::op(uint8_t opcode) { code_.push_back(opcode); }

void Assembler::push(int32_t v) {
  code_.push_back(OP_PUSH);
  put32(code_, uint32_t(v));
}

void Assembler::u8op(uint8_t opcode, uint8_t a) {
  code_.push_back(opcode);
  code_.push_back(a);
}

void Assembler::u16op(uint8_t opcode, uint16_t b) {
  code_.push_back(opcode);
  put16(code_, b);
}

void Assembler::u8u16(uint8_t opcode, uint8_t a, uint16_t b) {
  code_.push_back(opcode);
  code_.push_back(a);
  put16(code_, b);
}

void Assembler::u32_fixup(Label l) {
  fixups_.push_back({uint32_t(code_.size()), l});
  put32(code_, 0);
}

void Assembler::jump(uint8_t opcode, Label target) {
  code_.push_back(opcode);
  u32_fixup(target);
}

void Assembler::each(uint8_t selector, Label end) {
  code_.push_back(OP_EACH);
  code_.push_back(selector);
  u32_fixup(end);
}

void Assembler::sw(const std::vector<Label>& cases, Label fallback) {
  code_.push_back(OP_SWITCH);
  code_.push_back(uint8_t(cases.size()));
  u32_fixup(fallback);
  for (Label l : cases) u32_fixup(l);
}

void Assembler::raw(const std::vector<uint8_t>& bytes) {
  code_.insert(code_.end(), bytes.begin(), bytes.end());
}

bool Assembler::finish(std::vector<uint8_t>& out, std::string& err) const {
  out = code_;
  for (const Fixup& f : fixups_) {
    if (f.label >= labels_.size() || labels_[f.label] < 0) {
      err = "unbound label";
      return false;
    }
    set32(out, f.at, uint32_t(labels_[f.label]));
  }
  return true;
}

ImageBuilder::ImageBuilder() { proof({}); }

uint32_t ImageBuilder::str(std::string_view s) {
  auto it = string_index_.find(s);
  if (it != string_index_.end()) return it->second;
  uint32_t id = uint32_t(strings_.size());
  strings_.emplace_back(s);
  string_index_.emplace(std::string(s), id);
  return id;
}

uint16_t ImageBuilder::int_const(int64_t v) {
  auto it = int_index_.find(v);
  if (it != int_index_.end()) return it->second;
  uint16_t id = uint16_t(ints_.size());
  ints_.push_back(v);
  int_index_.emplace(v, id);
  return id;
}

uint32_t ImageBuilder::source(const SourceRecord& s) {
  sources_.push_back(s);
  return uint32_t(sources_.size() - 1);
}

uint32_t ImageBuilder::rule(const RuleRecord& r) {
  rules_.push_back(r);
  return uint32_t(rules_.size() - 1);
}

uint16_t ImageBuilder::proof(const std::vector<uint16_t>& rules) {
  auto it = proof_index_.find(rules);
  if (it != proof_index_.end()) return it->second;
  uint16_t id = uint16_t(proofs_.size());
  proofs_.push_back(rules);
  proof_index_.emplace(rules, id);
  return id;
}

void ImageBuilder::anno(uint8_t program, uint32_t pc, uint32_t rule) {
  annos_.push_back({program, pc, rule});
}

void ImageBuilder::meta(std::string_view key, std::string_view value) {
  uint32_t k = str(key);
  uint32_t v = str(value);
  meta_.emplace_back(k, v);
}

void ImageBuilder::set_source_sha256(const uint8_t sha[32]) { std::memcpy(source_sha_, sha, 32); }

uint8_t ImageBuilder::tag(std::string_view name) {
  uint32_t s = str(name);
  for (size_t i = 0; i < tags_.size(); i++) {
    if (tags_[i] == s) return uint8_t(i);
  }
  tags_.push_back(s);
  return uint8_t(tags_.size() - 1);
}

std::vector<uint8_t> ImageBuilder::build(const std::vector<uint8_t>& item,
                                         const std::vector<uint8_t>& aggr) const {
  struct Section {
    uint32_t tag;
    std::vector<uint8_t> data;
  };
  std::vector<Section> secs;

  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(strings_.size()));
    uint32_t blob = 0;
    for (const auto& s : strings_) blob += uint32_t(s.size());
    put32(d, blob);
    uint32_t off = 0;
    for (const auto& s : strings_) {
      put32(d, off);
      put32(d, uint32_t(s.size()));
      off += uint32_t(s.size());
    }
    for (const auto& s : strings_) d.insert(d.end(), s.begin(), s.end());
    secs.push_back({kTagStrs, std::move(d)});
  }
  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(ints_.size()));
    put32(d, 0);
    for (int64_t v : ints_) put64(d, v);
    secs.push_back({kTagInts, std::move(d)});
  }
  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(sources_.size()));
    for (const auto& s : sources_) {
      put32(d, s.id);
      put32(d, s.url);
      put32(d, s.title);
      d.insert(d.end(), s.sha256, s.sha256 + 32);
    }
    secs.push_back({kTagSrcs, std::move(d)});
  }
  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(rules_.size()));
    for (const auto& r : rules_) {
      d.push_back(r.kind);
      d.push_back(r.expense);
      d.push_back(r.per);
      d.push_back(0);
      put32(d, r.id);
      put32(d, r.pinpoint);
      put32(d, r.quote);
      put32(d, r.summary);
      put32(d, r.fragment);
      put32(d, r.source);
      put32(d, r.category);
      put32(d, r.aux);
    }
    secs.push_back({kTagRule, std::move(d)});
  }
  {
    std::vector<uint8_t> d;
    uint32_t refs = 0;
    for (const auto& p : proofs_) refs += uint32_t(p.size());
    put32(d, uint32_t(proofs_.size()));
    put32(d, refs);
    uint32_t at = 0;
    put32(d, 0);
    for (const auto& p : proofs_) {
      at += uint32_t(p.size());
      put32(d, at);
    }
    for (const auto& p : proofs_) {
      for (uint16_t r : p) put16(d, r);
    }
    secs.push_back({kTagProf, std::move(d)});
  }
  secs.push_back({kTagItem, item});
  secs.push_back({kTagAggr, aggr});
  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(tags_.size()));
    for (uint32_t t : tags_) put32(d, t);
    secs.push_back({kTagTags, std::move(d)});
  }
  {
    std::vector<AnnoRec> sorted = annos_;
    std::stable_sort(sorted.begin(), sorted.end(), [](const AnnoRec& a, const AnnoRec& b) {
      return a.program != b.program ? a.program < b.program : a.pc < b.pc;
    });
    std::vector<uint8_t> d;
    put32(d, uint32_t(sorted.size()));
    for (const auto& a : sorted) {
      d.push_back(a.program);
      d.push_back(0);
      d.push_back(0);
      d.push_back(0);
      put32(d, a.pc);
      put32(d, a.rule);
    }
    secs.push_back({kTagAnno, std::move(d)});
  }
  {
    std::vector<uint8_t> d;
    put32(d, uint32_t(meta_.size()));
    for (const auto& [k, v] : meta_) {
      put32(d, k);
      put32(d, v);
    }
    secs.push_back({kTagMeta, std::move(d)});
  }

  std::vector<uint8_t> img(kHeaderSize, 0);
  std::memcpy(img.data(), kMagic, 4);
  img[4] = uint8_t(kFormatMajor);
  img[5] = uint8_t(kFormatMajor >> 8);
  img[6] = uint8_t(kFormatMinor);
  img[7] = uint8_t(kFormatMinor >> 8);
  set32(img, 8, kHeaderSize);
  for (size_t i = 0; i < jurisdiction_.size() && i < 8; i++) img[16 + i] = uint8_t(jurisdiction_[i]);
  std::memcpy(img.data() + 24, source_sha_, 32);
  set32(img, 56, uint32_t(secs.size()));
  size_t table = img.size();
  img.resize(table + secs.size() * kSectionEntrySize, 0);
  for (size_t i = 0; i < secs.size(); i++) {
    while (img.size() % 8) img.push_back(0);
    size_t e = table + i * kSectionEntrySize;
    set32(img, e, secs[i].tag);
    set32(img, e + 4, uint32_t(img.size()));
    set32(img, e + 8, uint32_t(secs[i].data.size()));
    img.insert(img.end(), secs[i].data.begin(), secs[i].data.end());
  }
  set32(img, 12, uint32_t(img.size() + kTrailerSize));
  img.resize(img.size() + kTrailerSize, 0);
  reseal_image(img);
  return img;
}

void reseal_image(uint8_t* image, size_t len) {
  if (len < kTrailerSize) return;
  sha256(image, len - kTrailerSize, image + len - kTrailerSize);
}

void reseal_image(std::vector<uint8_t>& image) { reseal_image(image.data(), image.size()); }

bool find_section(const std::vector<uint8_t>& image, uint32_t tag, uint32_t& offset, uint32_t& size) {
  if (image.size() < kHeaderSize) return false;
  uint32_t count = get32(image.data() + 56);
  for (uint32_t i = 0; i < count; i++) {
    size_t e = kHeaderSize + size_t(i) * kSectionEntrySize;
    if (e + kSectionEntrySize > image.size()) return false;
    if (get32(image.data() + e) == tag) {
      offset = get32(image.data() + e + 4);
      size = get32(image.data() + e + 8);
      return true;
    }
  }
  return false;
}

}  // namespace tend

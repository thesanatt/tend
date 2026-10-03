#include "image.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <unordered_set>

#include "json.h"
#include "sha256.h"

namespace tend {
namespace {

inline uint16_t rd16(const uint8_t* p) { return uint16_t(p[0] | p[1] << 8); }
inline uint32_t rd32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
inline int64_t rd64(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = v << 8 | p[i];
  return int64_t(v);
}

struct Span {
  const uint8_t* p = nullptr;
  uint32_t n = 0;
  bool present = false;
};

std::string hex8(uint32_t v) {
  char buf[16];
  std::snprintf(buf, sizeof buf, "0x%02x", v);
  return buf;
}

class Loader {
 public:
  Loader(const uint8_t* d, size_t len, Law& law, std::string& err)
      : d_(d), len_(len), law_(law), err_(err) {}

  bool run(uint32_t flags);

 private:
  bool fail(std::string msg) {
    err_ = std::move(msg);
    return false;
  }
  bool header(uint32_t flags);
  bool sections();
  bool strings(Span s);
  bool ints(Span s);
  bool sources(Span s);
  bool rules(Span s);
  bool proofs(Span s);
  bool program(Span s, int which, Program& prog);
  bool verify(int which, Program& prog);
  bool annos(Span s);
  bool meta(Span s);
  bool str_ok(uint32_t i, bool optional) const {
    return (optional && i == kNone) || i < law_.strings.size();
  }

  const uint8_t* d_;
  size_t len_;
  Law& law_;
  std::string& err_;
  uint32_t section_count_ = 0;
  Span strs_, ints_, srcs_, rule_, prof_, item_, aggr_, anno_, meta_;
};

bool Loader::run(uint32_t flags) {
  return header(flags) && sections() && strings(strs_) && ints(ints_) && sources(srcs_) &&
         rules(rule_) && proofs(prof_) && program(item_, 0, law_.item) &&
         program(aggr_, 1, law_.aggr) && annos(anno_) && meta(meta_);
}

bool Loader::header(uint32_t flags) {
  if (len_ < kHeaderSize + kTrailerSize) return fail("image too small");
  if (len_ > kMaxImageSize) return fail("image too large");
  if (std::memcmp(d_, kMagic, 4) != 0) return fail("bad magic (not a .tlaw image)");
  law_.major = rd16(d_ + 4);
  law_.minor = rd16(d_ + 6);
  if (law_.major != kFormatMajor || law_.minor > kFormatMinor)
    return fail("unsupported format version " + std::to_string(law_.major) + "." +
                std::to_string(law_.minor));
  if (rd32(d_ + 8) != kHeaderSize) return fail("bad header size");
  if (rd32(d_ + 12) != len_) return fail("total size field does not match image length");
  const uint8_t* j = d_ + 16;
  size_t jn = 0;
  while (jn < 8 && j[jn]) jn++;
  if (jn == 0) return fail("empty jurisdiction");
  for (size_t i = 0; i < 8; i++) {
    bool ok = i < jn ? ((j[i] >= 'A' && j[i] <= 'Z') || (j[i] >= '0' && j[i] <= '9')) : j[i] == 0;
    if (!ok) return fail("bad jurisdiction code");
  }
  std::memcpy(law_.jurisdiction, j, jn);
  law_.jurisdiction[jn] = 0;
  std::memcpy(law_.source_sha256, d_ + 24, 32);
  section_count_ = rd32(d_ + 56);
  if (rd32(d_ + 60) != 0) return fail("unknown header flags");

  Sha256 h;
  h.update(d_, len_ - kTrailerSize);
  uint8_t body[32];
  h.digest(body);
  if (!(flags & LOAD_SKIP_CHECKSUM) && std::memcmp(body, d_ + len_ - kTrailerSize, 32) != 0)
    return fail("checksum mismatch (image is corrupt or was modified)");
  h.update(d_ + len_ - kTrailerSize, kTrailerSize);
  h.digest(law_.image_sha256);
  return true;
}

bool Loader::sections() {
  if (section_count_ == 0 || section_count_ > kMaxSections) return fail("bad section count");
  uint64_t table_end = kHeaderSize + uint64_t(section_count_) * kSectionEntrySize;
  uint64_t body_end = len_ - kTrailerSize;
  if (table_end > body_end) return fail("section table out of bounds");
  struct Ent {
    uint32_t tag, off, size;
  };
  std::vector<Ent> ents;
  for (uint32_t i = 0; i < section_count_; i++) {
    const uint8_t* e = d_ + kHeaderSize + i * kSectionEntrySize;
    Ent s{rd32(e), rd32(e + 4), rd32(e + 8)};
    if (s.off % 8 != 0) return fail("misaligned section");
    if (s.off < table_end || uint64_t(s.off) + s.size > body_end) return fail("section out of bounds");
    Span* slot = nullptr;
    switch (s.tag) {
      case kTagStrs: slot = &strs_; break;
      case kTagInts: slot = &ints_; break;
      case kTagSrcs: slot = &srcs_; break;
      case kTagRule: slot = &rule_; break;
      case kTagProf: slot = &prof_; break;
      case kTagItem: slot = &item_; break;
      case kTagAggr: slot = &aggr_; break;
      case kTagAnno: slot = &anno_; break;
      case kTagMeta: slot = &meta_; break;
      default: return fail("unknown section tag");
    }
    if (slot->present) return fail("duplicate section");
    *slot = Span{d_ + s.off, s.size, true};
    ents.push_back(s);
  }
  std::sort(ents.begin(), ents.end(), [](const Ent& a, const Ent& b) { return a.off < b.off; });
  for (size_t i = 1; i < ents.size(); i++) {
    if (uint64_t(ents[i - 1].off) + ents[i - 1].size > ents[i].off) return fail("overlapping sections");
  }
  if (!strs_.present || !ints_.present || !srcs_.present || !rule_.present || !prof_.present ||
      !item_.present || !aggr_.present)
    return fail("missing required section");
  return true;
}

bool Loader::strings(Span s) {
  if (s.n < 8) return fail("STRS too small");
  uint32_t count = rd32(s.p), blob = rd32(s.p + 4);
  if (count > (1u << 22)) return fail("STRS: too many strings");
  if (uint64_t(8) + uint64_t(count) * 8 + blob != s.n) return fail("STRS: size mismatch");
  const uint8_t* base = s.p + 8 + size_t(count) * 8;
  law_.strings.resize(count);
  for (uint32_t i = 0; i < count; i++) {
    uint32_t off = rd32(s.p + 8 + i * 8), n = rd32(s.p + 12 + i * 8);
    if (uint64_t(off) + n > blob) return fail("STRS: string " + std::to_string(i) + " out of bounds");
    if (!valid_utf8(base + off, n)) return fail("STRS: string " + std::to_string(i) + " is not UTF-8");
    law_.strings[i] = std::string_view(reinterpret_cast<const char*>(base + off), n);
  }
  return true;
}

bool Loader::ints(Span s) {
  if (s.n < 8) return fail("INTS too small");
  uint32_t count = rd32(s.p);
  if (rd32(s.p + 4) != 0) return fail("INTS: reserved field set");
  if (count > 65536 || uint64_t(8) + uint64_t(count) * 8 != s.n) return fail("INTS: size mismatch");
  law_.ints.resize(count);
  for (uint32_t i = 0; i < count; i++) law_.ints[i] = rd64(s.p + 8 + i * 8);
  return true;
}

bool Loader::sources(Span s) {
  if (s.n < 4) return fail("SRCS too small");
  uint32_t count = rd32(s.p);
  if (count > 65535 || uint64_t(4) + uint64_t(count) * kSourceRecordSize != s.n)
    return fail("SRCS: size mismatch");
  law_.sources.resize(count);
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t* r = s.p + 4 + size_t(i) * kSourceRecordSize;
    Source& src = law_.sources[i];
    src.id = rd32(r);
    src.url = rd32(r + 4);
    src.title = rd32(r + 8);
    std::memcpy(src.sha256, r + 12, 32);
    if (!str_ok(src.id, false) || !str_ok(src.url, true) || !str_ok(src.title, true))
      return fail("SRCS: source " + std::to_string(i) + " has a bad string reference");
  }
  return true;
}

bool Loader::rules(Span s) {
  if (s.n < 4) return fail("RULE too small");
  uint32_t count = rd32(s.p);
  if (count > 65535 || uint64_t(4) + uint64_t(count) * kRuleRecordSize != s.n)
    return fail("RULE: size mismatch");
  law_.rules.resize(count);
  std::unordered_set<std::string_view> ids;
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t* r = s.p + 4 + size_t(i) * kRuleRecordSize;
    Rule& rule = law_.rules[i];
    rule.category = r[0];
    rule.expense = r[1];
    rule.per = r[2];
    rule.id = rd32(r + 4);
    rule.pinpoint = rd32(r + 8);
    rule.quote = rd32(r + 12);
    rule.summary = rd32(r + 16);
    rule.fragment = rd32(r + 20);
    rule.source = rd32(r + 24);
    rule.per_text = rd32(r + 28);
    std::string where = "RULE: rule " + std::to_string(i);
    if (rule.category >= CAT_COUNT) return fail(where + " has an unknown category");
    if (rule.expense != kNoExpense && rule.expense >= kRuleExpenseCount)
      return fail(where + " has an unknown expense");
    if (rule.per >= PER_COUNT) return fail(where + " has an unknown per");
    if (r[3] != 0) return fail(where + " has reserved bits set");
    if (!str_ok(rule.id, false) || !str_ok(rule.pinpoint, false) || !str_ok(rule.quote, false) ||
        !str_ok(rule.summary, true) || !str_ok(rule.fragment, true) || !str_ok(rule.per_text, true))
      return fail(where + " has a bad string reference");
    if (rule.source != kNone && rule.source >= law_.sources.size())
      return fail(where + " references a missing source");
    std::string_view id = law_.strings[rule.id];
    if (id.empty()) return fail(where + " has an empty id");
    if (!ids.insert(id).second) return fail(where + " duplicates rule id " + std::string(id));
  }
  return true;
}

bool Loader::proofs(Span s) {
  if (s.n < 8) return fail("PROF too small");
  uint32_t lists = rd32(s.p), refs = rd32(s.p + 4);
  if (lists == 0 || lists > 65535 || refs > (1u << 22)) return fail("PROF: bad counts");
  if (uint64_t(8) + (uint64_t(lists) + 1) * 4 + uint64_t(refs) * 2 != s.n)
    return fail("PROF: size mismatch");
  law_.proof_start.resize(lists + 1);
  for (uint32_t i = 0; i <= lists; i++) law_.proof_start[i] = rd32(s.p + 8 + i * 4);
  if (law_.proof_start[0] != 0 || law_.proof_start[lists] != refs) return fail("PROF: bad bounds");
  for (uint32_t i = 0; i < lists; i++) {
    if (law_.proof_start[i] > law_.proof_start[i + 1]) return fail("PROF: bounds not monotonic");
  }
  const uint8_t* rp = s.p + 8 + (size_t(lists) + 1) * 4;
  law_.proof_refs.resize(refs);
  for (uint32_t i = 0; i < refs; i++) {
    law_.proof_refs[i] = rd16(rp + i * 2);
    if (law_.proof_refs[i] >= law_.rules.size()) return fail("PROF: reference to a missing rule");
  }
  law_.proof_first.resize(lists);
  for (uint32_t i = 0; i < lists; i++) {
    law_.proof_first[i] = law_.proof_len(i) ? law_.proof_rules(i)[0] : -1;
  }
  return true;
}

bool Loader::program(Span s, int which, Program& prog) {
  const char* name = which == 0 ? "ITEM" : "AGGR";
  if (s.n == 0) return fail(std::string(name) + ": empty program");
  if (s.n > kMaxProgramSize) return fail(std::string(name) + ": program too large");
  prog.byte_size = s.n;
  const uint8_t where = which == 0 ? IN_ITEM : IN_AGGR;
  uint32_t pc = 0;
  auto at = [&](uint32_t p) { return std::string(name) + " @" + std::to_string(p) + ": "; };
  while (pc < s.n) {
    uint8_t op = s.p[pc];
    const OpInfo& info = op_info(op);
    if (!info.name) return fail(at(pc) + "unknown opcode " + hex8(op));
    if (!(info.where & where)) return fail(at(pc) + info.name + " is not allowed in this program");
    uint32_t size = 1;
    switch (info.operands) {
      case OPD_NONE: size = 1; break;
      case OPD_U8: size = 2; break;
      case OPD_U16: size = 3; break;
      case OPD_U8_U16: size = 4; break;
      case OPD_I32:
      case OPD_U32: size = 5; break;
      case OPD_U8_U32: size = 6; break;
      case OPD_SWITCH:
        if (s.n - pc < 2) return fail(at(pc) + "truncated instruction");
        size = 6 + 4 * uint32_t(s.p[pc + 1]);
        break;
    }
    if (s.n - pc < size) return fail(at(pc) + "truncated instruction");
    const uint8_t* o = s.p + pc + 1;
    Insn in{op, 0, 0, 0};
    switch (info.operands) {
      case OPD_I32: in.c = int32_t(rd32(o)); break;
      case OPD_U8: in.a = o[0]; break;
      case OPD_U16: in.b = rd16(o); break;
      case OPD_U32: in.c = int32_t(rd32(o)); break;
      case OPD_U8_U16:
        in.a = o[0];
        in.b = rd16(o + 1);
        break;
      case OPD_U8_U32:
        in.a = o[0];
        in.c = int32_t(rd32(o + 1));
        break;
      case OPD_SWITCH:
        in.a = o[0];
        in.c = int32_t(prog.table.size());
        for (uint32_t k = 0; k <= in.a; k++) prog.table.push_back(rd32(o + 1 + 4 * k));
        break;
      default: break;
    }
    const uint32_t nrules = uint32_t(law_.rules.size());
    const uint32_t nproofs = law_.proof_count();
    bool ok = true;
    switch (op) {
      case OP_LDK: ok = in.b < law_.ints.size(); break;
      case OP_LDX: ok = in.a < CX_COUNT; break;
      case OP_LDI: ok = in.a < IF_COUNT; break;
      case OP_LDR:
      case OP_STR: ok = in.a < kNumRegs; break;
      case OP_DECIDE: ok = in.a < ST_COUNT && in.b < nproofs; break;
      case OP_SETEXP: ok = in.a < EXP_COUNT; break;
      case OP_SETA: ok = in.a == TR_COLLATERAL && in.b < nrules; break;
      case OP_EACH: ok = in.a < EXP_COUNT || in.a == kSelectAll; break;
      case OP_CAP:
        ok = (in.a == TR_UNIT_CAP || in.a == TR_EXPENSE_CAP || in.a == TR_TOTAL_CAP) && in.b < nrules;
        break;
      case OP_FLAG: ok = in.b < nrules; break;
      case OP_CHECK: ok = in.a < CK_COUNT && in.b < nproofs; break;
      case OP_INFO: ok = in.b < nproofs; break;
      default: break;
    }
    if (!ok) return fail(at(pc) + info.name + " has an operand out of range");
    prog.code.push_back(in);
    prog.offsets.push_back(pc);
    pc += size;
  }
  // Byte targets -> instruction indices.
  auto resolve = [&](uint32_t from, uint32_t target, int32_t& out) {
    int64_t idx = prog.index_of(target);
    if (idx < 0) return fail(at(prog.offsets[from]) + "jump target is not an instruction start");
    out = int32_t(idx);
    return true;
  };
  for (uint32_t i = 0; i < prog.code.size(); i++) {
    Insn& in = prog.code[i];
    switch (in.op) {
      case OP_JMP:
      case OP_JZ:
      case OP_JNZ:
      case OP_EACH:
      case OP_NEXT:
        if (!resolve(i, uint32_t(in.c), in.c)) return false;
        break;
      case OP_SWITCH:
        for (uint32_t k = 0; k <= in.a; k++) {
          int32_t t;
          if (!resolve(i, prog.table[size_t(in.c) + k], t)) return false;
          prog.table[size_t(in.c) + k] = uint32_t(t);
        }
        break;
      default: break;
    }
  }
  return verify(which, prog);
}


// Structural rules and abstract interpretation. After this passes, the VM may
// run the program without bounds checks: the stack never under- or overflows,
// every item path makes exactly one decision, and execution always terminates
// (all jumps go forward except NEXT, and loops cannot nest or be re-entered).
bool Loader::verify(int which, Program& prog) {
  const char* name = which == 0 ? "ITEM" : "AGGR";
  const uint32_t n = uint32_t(prog.code.size());
  auto at = [&](uint32_t i) { return std::string(name) + " @" + std::to_string(prog.offsets[i]) + ": "; };

  // Loop structure: EACH i ... NEXT (end-1) with NEXT jumping back to i+1.
  std::vector<int32_t> loop_of(n, -1);  // index of the EACH whose body contains the instruction
  for (uint32_t i = 0; i < n; i++) {
    const Insn& in = prog.code[i];
    if (in.op == OP_EACH) {
      uint32_t end = uint32_t(in.c);
      if (end < i + 2) return fail(at(i) + "each must enclose at least a next");
      const Insn& nx = prog.code[end - 1];
      if (nx.op != OP_NEXT || uint32_t(nx.c) != i + 1) return fail(at(i) + "each is not closed by a matching next");
      for (uint32_t k = i + 1; k < end; k++) {
        if (loop_of[k] != -1 || prog.code[k].op == OP_EACH) return fail(at(i) + "loops may not nest");
        loop_of[k] = int32_t(i);
      }
      prog.loops++;
    }
  }
  for (uint32_t i = 0; i < n; i++) {
    const Insn& in = prog.code[i];
    const OpInfo& info = op_info(in.op);
    if (in.op == OP_NEXT) {
      int32_t l = loop_of[i];
      if (l < 0 || uint32_t(prog.code[size_t(l)].c) != i + 1) return fail(at(i) + "next without a matching each");
    }
    if (which == 1 && (info.where & AGGR_LOOP_ONLY) && loop_of[i] < 0)
      return fail(at(i) + info.name + " is only allowed inside an each loop");
    auto check_jump = [&](uint32_t target) {
      if (target <= i) return fail(at(i) + "backward jump");
      if (target < n && loop_of[target] >= 0 && loop_of[target] != loop_of[i])
        return fail(at(i) + "jump into a loop body");
      return true;
    };
    switch (in.op) {
      case OP_JMP:
      case OP_JZ:
      case OP_JNZ:
        if (!check_jump(uint32_t(in.c))) return false;
        break;
      case OP_SWITCH:
        for (uint32_t k = 0; k <= in.a; k++) {
          if (!check_jump(prog.table[size_t(in.c) + k])) return false;
        }
        break;
      case OP_EACH:
        if (uint32_t(in.c) <= i) return fail(at(i) + "backward jump");
        break;
      default: break;
    }
    bool falls_through = in.op != OP_JMP && in.op != OP_RET && in.op != OP_SWITCH;
    if (falls_through && i + 1 >= n) return fail(at(i) + "execution can run off the end");
  }

  // Abstract interpretation in index order; every edge except NEXT's back edge
  // goes forward, so predecessors are always visited first.
  struct State {
    bool reached = false;
    uint8_t depth = 0;
    bool decided = false;
  };
  std::vector<State> st(n);
  st[0].reached = true;
  uint32_t max_depth = 0;
  for (uint32_t i = 0; i < n; i++) {
    if (!st[i].reached) continue;
    const Insn& in = prog.code[i];
    const OpInfo& info = op_info(in.op);
    uint32_t depth = st[i].depth;
    bool decided = st[i].decided;
    if (depth < info.pops) return fail(at(i) + "stack underflow");
    depth = depth - info.pops + info.pushes;
    if (depth > kMaxStack) return fail(at(i) + "stack overflow");
    max_depth = std::max(max_depth, depth);
    if (which == 0) {
      if (in.op == OP_DECIDE) {
        if (decided) return fail(at(i) + "item decided twice on one path");
        decided = true;
      } else if (in.op == OP_SETEXP && decided) {
        return fail(at(i) + "setexp after decide");
      } else if (in.op == OP_SETA && !decided) {
        return fail(at(i) + "seta before decide");
      }
    }
    if (in.op == OP_RET) {
      if (depth != 0) return fail(at(i) + "stack not empty at ret");
      if (which == 0 && !decided) return fail(at(i) + "an item path ends without a decision");
      continue;
    }
    auto flow = [&](uint32_t to) {
      State& s = st[to];
      if (!s.reached) {
        s.reached = true;
        s.depth = uint8_t(depth);
        s.decided = decided;
        return true;
      }
      if (s.depth != depth || s.decided != decided) return fail(at(i) + "inconsistent state where paths merge");
      return true;
    };
    switch (in.op) {
      case OP_JMP:
        if (!flow(uint32_t(in.c))) return false;
        break;
      case OP_JZ:
      case OP_JNZ:
      case OP_EACH:
        if (!flow(i + 1) || !flow(uint32_t(in.c))) return false;
        break;
      case OP_SWITCH:
        for (uint32_t k = 0; k <= in.a; k++) {
          if (!flow(prog.table[size_t(in.c) + k])) return false;
        }
        break;
      case OP_NEXT: {
        const State& head = st[uint32_t(in.c)];
        if (!head.reached || head.depth != depth || head.decided != decided)
          return fail(at(i) + "loop body changes the stack depth");
        if (!flow(i + 1)) return false;
        break;
      }
      default:
        if (!flow(i + 1)) return false;
    }
  }
  prog.max_depth = max_depth;
  return true;
}

bool Loader::annos(Span s) {
  if (!s.present) return true;
  if (s.n < 4) return fail("ANNO too small");
  uint32_t count = rd32(s.p);
  if (count > (1u << 20) || uint64_t(4) + uint64_t(count) * kAnnoRecordSize != s.n)
    return fail("ANNO: size mismatch");
  law_.annos.resize(count);
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t* r = s.p + 4 + size_t(i) * kAnnoRecordSize;
    Anno& a = law_.annos[i];
    a.program = r[0];
    a.pc = rd32(r + 4);
    a.rule = rd32(r + 8);
    if (a.program > 1 || r[1] != 0 || r[2] != 0 || r[3] != 0) return fail("ANNO: bad record");
    const Program& p = a.program == 0 ? law_.item : law_.aggr;
    if (p.index_of(a.pc) < 0) return fail("ANNO: pc is not an instruction start");
    if (a.rule >= law_.rules.size()) return fail("ANNO: reference to a missing rule");
  }
  return true;
}

bool Loader::meta(Span s) {
  if (!s.present) return true;
  if (s.n < 4) return fail("META too small");
  uint32_t count = rd32(s.p);
  if (count > 256 || uint64_t(4) + uint64_t(count) * 8 != s.n) return fail("META: size mismatch");
  for (uint32_t i = 0; i < count; i++) {
    uint32_t k = rd32(s.p + 4 + i * 8), v = rd32(s.p + 8 + i * 8);
    if (!str_ok(k, false) || !str_ok(v, false)) return fail("META: bad string reference");
    law_.meta.emplace_back(k, v);
  }
  return true;
}

}  // namespace

int64_t Program::index_of(uint32_t byte_offset) const {
  auto it = std::lower_bound(offsets.begin(), offsets.end(), byte_offset);
  if (it == offsets.end() || *it != byte_offset) return -1;
  return it - offsets.begin();
}

std::string_view Law::meta_value(std::string_view key) const {
  for (const auto& [k, v] : meta) {
    if (str(k) == key) return str(v);
  }
  return {};
}

bool load_law(const uint8_t* data, size_t len, Law& law, std::string& err, uint32_t flags) {
  law = Law();
  if (!data) {
    err = "no image";
    return false;
  }
  Loader l(data, len, law, err);
  if (!l.run(flags)) {
    law = Law();
    return false;
  }
  return true;
}

}  // namespace tend

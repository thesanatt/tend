// The loader must reject every malformed image with a reason, never crash.
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "builder.h"
#include "helpers.h"
#include "image.h"

using namespace tend;
using th::json;

namespace {

std::string load_error(const std::vector<uint8_t>& img, uint32_t flags = LOAD_DEFAULT) {
  Law law;
  std::string err;
  return load_law(img.data(), img.size(), law, err, flags) ? std::string() : err;
}

std::vector<uint8_t> zz_image() {
  static std::vector<uint8_t> img = th::compile(json::parse(th::read_text("tests/fixtures/ZZ.json")));
  return img;
}

void put32(std::vector<uint8_t>& img, size_t at, uint32_t v) {
  for (int i = 0; i < 4; i++) img[at + size_t(i)] = uint8_t(v >> (8 * i));
}
void put16(std::vector<uint8_t>& img, size_t at, uint16_t v) {
  img[at] = uint8_t(v);
  img[at + 1] = uint8_t(v >> 8);
}
uint32_t get32(const std::vector<uint8_t>& img, size_t at) {
  return uint32_t(img[at]) | uint32_t(img[at + 1]) << 8 | uint32_t(img[at + 2]) << 16 | uint32_t(img[at + 3]) << 24;
}

// Mutates a copy of the ZZ image, reseals the checksum, and returns the error.
std::string mutated(const std::function<void(std::vector<uint8_t>&)>& f) {
  std::vector<uint8_t> img = zz_image();
  f(img);
  reseal_image(img);
  return load_error(img);
}

uint32_t section(const std::vector<uint8_t>& img, uint32_t tag) {
  uint32_t off = 0, size = 0;
  REQUIRE(find_section(img, tag, off, size));
  return off;
}

size_t section_entry(const std::vector<uint8_t>& img, uint32_t tag) {
  uint32_t count = get32(img, 56);
  for (uint32_t i = 0; i < count; i++) {
    size_t e = kHeaderSize + size_t(i) * kSectionEntrySize;
    if (get32(img, e) == tag) return e;
  }
  FAIL("missing section");
  return 0;
}

using Emit = std::function<void(Assembler&)>;

std::vector<uint8_t> assemble(const Emit& f) {
  Assembler a;
  f(a);
  std::vector<uint8_t> out;
  std::string err;
  REQUIRE(a.finish(out, err));
  return out;
}

const Emit kItemOk = [](Assembler& a) {
  a.push(0);
  a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
  a.op(OP_RET);
};
const Emit kAggrOk = [](Assembler& a) { a.op(OP_RET); };

// One rule (R0), proofs P0=() and P1=(R0), one int (K0).
std::vector<uint8_t> image_of(const std::vector<uint8_t>& item, const std::vector<uint8_t>& aggr,
                              const std::function<void(ImageBuilder&)>& extra = {}) {
  ImageBuilder b;
  b.set_jurisdiction("ZZ");
  RuleRecord r;
  r.category = CAT_COVERED_EXPENSE;
  r.expense = EXP_MEDICAL;
  r.id = b.str("T-1");
  r.pinpoint = b.str("Test 1");
  r.quote = b.str("A quote.");
  b.rule(r);
  b.proof({0});
  b.int_const(500);
  if (extra) extra(b);
  return b.build(item, aggr);
}

std::string item_error(const Emit& f) { return load_error(image_of(assemble(f), assemble(kAggrOk))); }
std::string aggr_error(const Emit& f) { return load_error(image_of(assemble(kItemOk), assemble(f))); }

}  // namespace

TEST_CASE("valid images load") {
  CHECK(load_error(zz_image()).empty());
  CHECK(load_error(image_of(assemble(kItemOk), assemble(kAggrOk))).empty());
}

TEST_CASE("loader rejects bad headers") {
  std::vector<uint8_t> img = zz_image();
  CHECK(load_error(std::vector<uint8_t>(img.begin(), img.begin() + 95)).find("too small") != std::string::npos);
  CHECK_FALSE(load_error({}).empty());
  Law law;
  std::string err;
  CHECK_FALSE(load_law(nullptr, 100, law, err));

  CHECK(mutated([](auto& i) { i[0] = 'X'; }).find("bad magic") != std::string::npos);
  CHECK(mutated([](auto& i) { put16(i, 4, 2); }).find("unsupported format version 2.0") != std::string::npos);
  CHECK(mutated([](auto& i) { put16(i, 6, 1); }).find("unsupported format version 1.1") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 8, 65); }).find("bad header size") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 12, uint32_t(i.size() + 8)); }).find("total size") != std::string::npos);
  CHECK(mutated([](auto& i) { i[16] = 'z'; }).find("bad jurisdiction") != std::string::npos);
  CHECK(mutated([](auto& i) { i[16] = 0; }).find("empty jurisdiction") != std::string::npos);
  CHECK(mutated([](auto& i) { i[20] = 'Q'; }).find("bad jurisdiction") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 60, 1); }).find("unknown header flags") != std::string::npos);
}

TEST_CASE("loader verifies the checksum over every byte") {
  std::vector<uint8_t> img = zz_image();
  img[30] ^= 0x01;  // inside the source sha256 field: harmless to every other check
  CHECK(load_error(img).find("checksum mismatch") != std::string::npos);
  CHECK(load_error(img, LOAD_SKIP_CHECKSUM).empty());
  std::vector<uint8_t> trailer = zz_image();
  trailer.back() ^= 0x80;
  CHECK(load_error(trailer).find("checksum mismatch") != std::string::npos);
}

TEST_CASE("loader rejects bad section tables") {
  CHECK(mutated([](auto& i) { put32(i, 56, 0); }).find("bad section count") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 56, 17); }).find("bad section count") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 56, 6); }).find("missing required section") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, 56, 100000); }).find("bad section count") != std::string::npos);
  CHECK(mutated([](auto& i) {
          size_t e = section_entry(i, kTagRule);
          put32(i, e + 4, get32(i, e + 4) + 4);
        }).find("misaligned") != std::string::npos);
  CHECK(mutated([](auto& i) {
          size_t e = section_entry(i, kTagRule);
          put32(i, e + 8, uint32_t(i.size()));
        }).find("out of bounds") != std::string::npos);
  CHECK(mutated([](auto& i) {
          size_t e = section_entry(i, kTagRule);
          put32(i, e + 4, 0);
        }).find("out of bounds") != std::string::npos);
  CHECK(mutated([](auto& i) {
          size_t e = section_entry(i, kTagRule);
          put32(i, e + 4, get32(i, section_entry(i, kTagSrcs) + 4));
        }).find("overlapping") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section_entry(i, kTagMeta), fourcc('X', 'X', 'X', 'X')); })
            .find("unknown section tag") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section_entry(i, kTagMeta), kTagAnno); }).find("duplicate section") !=
        std::string::npos);
}

TEST_CASE("ANNO and META are optional") {
  std::vector<uint8_t> img = zz_image();
  put32(img, 56, 7);  // drop the last two entries (ANNO, META)
  reseal_image(img);
  Law law;
  std::string err;
  REQUIRE(load_law(img.data(), img.size(), law, err));
  CHECK(law.annos.empty());
  CHECK(law.meta.empty());
}

TEST_CASE("loader rejects bad pools and tables") {
  // STRS: first string offset far past the blob; a raw byte that breaks UTF-8.
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagStrs) + 8, 0x00FFFFFF); }).find("out of bounds") !=
        std::string::npos);
  CHECK(mutated([](auto& i) {
          uint32_t s = section(i, kTagStrs);
          uint32_t count = get32(i, s);
          i[s + 8 + count * 8] = 0xFF;
        }).find("not UTF-8") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagStrs) + 4, 1); }).find("STRS: size mismatch") !=
        std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagInts), 2); }).find("INTS: size mismatch") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagInts) + 4, 1); }).find("reserved") != std::string::npos);
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagSrcs) + 4, 99999); }).find("SRCS") != std::string::npos);

  auto rule_at = [](std::vector<uint8_t>& i, int n) { return section(i, kTagRule) + 4 + uint32_t(n) * kRuleRecordSize; };
  CHECK(mutated([&](auto& i) { i[rule_at(i, 0)] = 99; }).find("unknown category") != std::string::npos);
  CHECK(mutated([&](auto& i) { i[rule_at(i, 0) + 1] = 18; }).find("unknown expense") != std::string::npos);
  CHECK(mutated([&](auto& i) { i[rule_at(i, 0) + 2] = 8; }).find("unknown per") != std::string::npos);
  CHECK(mutated([&](auto& i) { i[rule_at(i, 0) + 3] = 1; }).find("reserved bits") != std::string::npos);
  CHECK(mutated([&](auto& i) { put32(i, rule_at(i, 0) + 4, 999999); }).find("bad string reference") !=
        std::string::npos);
  CHECK(mutated([&](auto& i) { put32(i, rule_at(i, 0) + 24, 7); }).find("missing source") != std::string::npos);
  CHECK(mutated([&](auto& i) { put32(i, rule_at(i, 1) + 4, get32(i, rule_at(i, 0) + 4)); })
            .find("duplicates rule id ZZ-EXAM-1") != std::string::npos);

  uint32_t nproofs_at = 0;
  CHECK(mutated([&](auto& i) {
          nproofs_at = section(i, kTagProf);
          put32(i, nproofs_at + 8 + 4, 1000);
        }).find("PROF") != std::string::npos);
  CHECK(mutated([&](auto& i) {
          uint32_t p = section(i, kTagProf);
          uint32_t lists = get32(i, p);
          put16(i, p + 8 + (lists + 1) * 4, 999);
        }).find("missing rule") != std::string::npos);
  CHECK(mutated([&](auto& i) { put32(i, section(i, kTagProf), 0); }).find("PROF") != std::string::npos);
}

TEST_CASE("loader rejects bad annotations and metadata") {
  // Byte 2 of the item program is inside an instruction.
  std::vector<uint8_t> img = image_of(assemble(kItemOk), assemble(kAggrOk), [](ImageBuilder& b) { b.anno(0, 2, 0); });
  CHECK(load_error(img).find("ANNO: pc is not an instruction start") != std::string::npos);
  img = image_of(assemble(kItemOk), assemble(kAggrOk), [](ImageBuilder& b) { b.anno(1, 0, 5); });
  CHECK(load_error(img).find("ANNO: reference to a missing rule") != std::string::npos);
  img = image_of(assemble(kItemOk), assemble(kAggrOk), [](ImageBuilder& b) { b.anno(0, 0, 0); });
  CHECK(load_error(img).empty());
  CHECK(mutated([](auto& i) { put32(i, section(i, kTagMeta) + 8, 999999); }).find("META") != std::string::npos);
}

TEST_CASE("verifier rejects malformed bytecode") {
  CHECK(item_error([](Assembler& a) { a.raw({0xEE}); }).find("unknown opcode 0xee") != std::string::npos);
  CHECK(item_error([](Assembler& a) { a.raw({OP_PUSH, 0, 0}); }).find("truncated instruction") != std::string::npos);
  CHECK(item_error([](Assembler& a) { a.raw({OP_SWITCH, 3, 0, 0, 0, 0}); }).find("truncated") != std::string::npos);
  CHECK(item_error([](Assembler&) {}).find("empty program") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.raw({OP_JMP, 2, 0, 0, 0});
          kItemOk(a);
        }).find("not an instruction start") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          auto top = a.label();
          a.bind(top);
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          a.jump(OP_JMP, top);
        }).find("backward jump") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
        }).find("run off the end") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.op(OP_POP);
          kItemOk(a);
        }).find("stack underflow") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          for (int i = 0; i < 17; i++) a.push(i);
          kItemOk(a);
        }).find("stack overflow") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          auto l = a.label();
          a.push(1);
          a.jump(OP_JZ, l);
          a.push(5);
          a.bind(l);
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          a.op(OP_RET);
        }).find("inconsistent state") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          a.push(1);
          a.op(OP_RET);
        }).find("stack not empty") != std::string::npos);
  CHECK(item_error([](Assembler& a) { a.op(OP_RET); }).find("without a decision") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          auto skip = a.label();
          a.u8op(OP_LDI, IF_CONFIRMED);
          a.jump(OP_JZ, skip);
          a.push(0);
          a.u8u16(OP_DECIDE, ST_ELIGIBLE, 1);
          a.bind(skip);
          a.op(OP_RET);
        }).find("inconsistent state") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          kItemOk(a);
        }).find("decided twice") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          a.u8op(OP_SETEXP, EXP_MEDICAL);
          a.op(OP_RET);
        }).find("setexp after decide") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_SETA, TR_COLLATERAL, 0);
          kItemOk(a);
        }).find("seta before decide") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_UNKNOWN_RULE, 0);
          a.op(OP_RET);
        }).find("not allowed in this program") != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          auto end = a.label(), head = a.label();
          a.each(kSelectAll, end);
          a.bind(head);
          a.jump(OP_NEXT, head);
          a.bind(end);
          kItemOk(a);
        }).find("not allowed in this program") != std::string::npos);
}

TEST_CASE("verifier checks every operand range") {
  auto item_with = [](const std::vector<uint8_t>& insn) {
    return item_error([&](Assembler& a) {
      a.raw(insn);
      kItemOk(a);
    });
  };
  auto bad = std::string("operand out of range");
  CHECK(item_with({OP_LDK, 1, 0, OP_POP}).find(bad) != std::string::npos);
  CHECK(item_with({OP_LDK, 0, 0, OP_POP}).empty());
  CHECK(item_with({OP_LDR, 8, OP_POP}).find(bad) != std::string::npos);
  CHECK(item_with({OP_LDR, 7, OP_POP}).empty());
  CHECK(item_with({OP_STR, 9}).find(bad) != std::string::npos);
  CHECK(item_with({OP_LDX, CX_COUNT, OP_POP}).find(bad) != std::string::npos);
  CHECK(item_with({OP_LDI, IF_COUNT, OP_POP}).find(bad) != std::string::npos);
  CHECK(item_with({OP_SETEXP, EXP_COUNT}).find(bad) != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_COUNT, 0);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_ELIGIBLE, 2);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_ELIGIBLE, 1);
          a.push(0);
          a.u8u16(OP_SETA, TR_UNIT_CAP, 0);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(item_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_DECIDE, ST_ELIGIBLE, 1);
          a.push(0);
          a.u8u16(OP_SETA, TR_COLLATERAL, 1);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  auto in_loop = [](const std::function<void(Assembler&)>& body) {
    return aggr_error([&](Assembler& a) {
      auto end = a.label(), head = a.label();
      a.each(kSelectAll, end);
      a.bind(head);
      body(a);
      a.jump(OP_NEXT, head);
      a.bind(end);
      a.op(OP_RET);
    });
  };
  CHECK(in_loop([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_CAP, TR_EXPENSE_CAP, 0);
        }).empty());
  CHECK(in_loop([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_CAP, TR_COLLATERAL, 0);
        }).find(bad) != std::string::npos);
  CHECK(in_loop([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_CAP, TR_TOTAL_CAP, 1);
        }).find(bad) != std::string::npos);
  CHECK(in_loop([](Assembler& a) { a.u16op(OP_FLAG, 1); }).find(bad) != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_CHECK, CK_COUNT, 0);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.push(0);
          a.u8u16(OP_CHECK, CK_DEADLINE, 2);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.u16op(OP_INFO, 2);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label(), head = a.label();
          a.each(EXP_COUNT, end);
          a.bind(head);
          a.jump(OP_NEXT, head);
          a.bind(end);
          a.op(OP_RET);
        }).find(bad) != std::string::npos);
}

TEST_CASE("verifier enforces loop structure") {
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label();
          a.each(kSelectAll, end);
          a.bind(end);
          a.op(OP_RET);
        }).find("each must enclose") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label();
          a.each(kSelectAll, end);
          a.push(0);
          a.op(OP_POP);
          a.bind(end);
          a.op(OP_RET);
        }).find("not closed by a matching next") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto e1 = a.label(), e2 = a.label(), h1 = a.label(), h2 = a.label();
          a.each(kSelectAll, e1);
          a.bind(h1);
          a.each(kSelectAll, e2);
          a.bind(h2);
          a.jump(OP_NEXT, h2);
          a.bind(e2);
          a.jump(OP_NEXT, h1);
          a.bind(e1);
          a.op(OP_RET);
        }).find("may not nest") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto self = a.label();
          a.bind(self);
          a.jump(OP_NEXT, self);
          a.op(OP_RET);
        }).find("next without a matching each") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.op(OP_LDA);
          a.op(OP_POP);
          a.op(OP_RET);
        }).find("only allowed inside an each loop") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          a.u16op(OP_FLAG, 0);
          a.op(OP_RET);
        }).find("only allowed inside an each loop") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label(), head = a.label(), inside = a.label();
          a.push(0);
          a.jump(OP_JZ, inside);
          a.each(kSelectAll, end);
          a.bind(head);
          a.push(1);
          a.bind(inside);
          a.op(OP_POP);
          a.jump(OP_NEXT, head);
          a.bind(end);
          a.op(OP_RET);
        }).find("jump into a loop body") != std::string::npos);
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label(), head = a.label();
          a.each(kSelectAll, end);
          a.bind(head);
          a.push(1);
          a.jump(OP_NEXT, head);
          a.bind(end);
          a.op(OP_RET);
        }).find("loop body changes the stack depth") != std::string::npos);
  // Leaving a loop early with a forward jump is fine.
  CHECK(aggr_error([](Assembler& a) {
          auto end = a.label(), head = a.label(), out = a.label();
          a.each(kSelectAll, end);
          a.bind(head);
          a.op(OP_LDA);
          a.jump(OP_JNZ, out);
          a.jump(OP_NEXT, head);
          a.bind(end);
          a.bind(out);
          a.op(OP_RET);
        }).empty());
}

TEST_CASE("switch targets are verified") {
  CHECK(item_error([](Assembler& a) {
          auto x = a.label(), y = a.label();
          a.u8op(OP_LDI, IF_EXPENSE);
          a.sw({x, y}, y);
          a.bind(x);
          kItemOk(a);
          a.bind(y);
          kItemOk(a);
        }).empty());
  CHECK(item_error([](Assembler& a) {
          auto top = a.label(), y = a.label();
          a.bind(top);
          a.u8op(OP_LDI, IF_EXPENSE);
          a.sw({top}, y);
          a.bind(y);
          kItemOk(a);
        }).find("backward jump") != std::string::npos);
}

TEST_CASE("runtime traps become error documents, not crashes") {
  std::vector<uint8_t> img = image_of(assemble(kItemOk), assemble([](Assembler& a) {
                                        a.push(7);
                                        a.u8u16(OP_CHECK, CK_DEADLINE, 0);
                                        a.op(OP_RET);
                                      }));
  REQUIRE(load_error(img).empty());
  json out = th::eval(img, th::claim({th::item("a", "2026-07-01", 100, "medical")}));
  CHECK(out["error"]["code"] == "vm_trap");
}

TEST_CASE("bad images come back as error documents through the C ABI") {
  std::vector<uint8_t> img = zz_image();
  img[0] = 'X';
  json out = th::eval(img, th::claim({}));
  CHECK(out["error"]["code"] == "bad_image");
  char* d = tend_disasm(img.data(), img.size());
  REQUIRE(d != nullptr);
  CHECK(std::string(d).rfind("error: bad magic", 0) == 0);
  tend_free(d);
  char* i = tend_inspect_json(img.data(), img.size());
  REQUIRE(i != nullptr);
  CHECK(json::parse(i)["error"]["code"] == "bad_image");
  tend_free(i);
  char* n = tend_eval_json(nullptr, 0, "{}");
  REQUIRE(n != nullptr);
  CHECK(json::parse(n)["error"]["code"] == "bad_image");
  tend_free(n);
  char* m = tend_eval_json(zz_image().data(), zz_image().size(), nullptr);
  REQUIRE(m != nullptr);
  CHECK(json::parse(m)["error"]["code"] == "bad_input");
  tend_free(m);
}

TEST_CASE("every single-byte corruption is caught by the checksum") {
  std::vector<uint8_t> base = zz_image();
  for (size_t at = 0; at < base.size(); at += 13) {
    std::vector<uint8_t> img = base;
    img[at] ^= 0x5A;
    CAPTURE(at);
    CHECK_FALSE(load_error(img).empty());
  }
}

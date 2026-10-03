// Shared constants for the .tlaw image format and the VM instruction set.
// FORMAT.md is the normative description; keep the two in sync.
#pragma once

#include <cstdint>
#include <string_view>

namespace tend {

constexpr char kMagic[4] = {'T', 'L', 'A', 'W'};
constexpr uint16_t kFormatMajor = 1;
constexpr uint16_t kFormatMinor = 0;
constexpr uint32_t kHeaderSize = 64;
constexpr uint32_t kSectionEntrySize = 12;
constexpr uint32_t kTrailerSize = 32;
constexpr uint32_t kNone = 0xFFFFFFFFu;
constexpr uint8_t kNoExpense = 0xFF;
constexpr uint8_t kSelectAll = 0xFF;

constexpr uint32_t kMaxImageSize = 64u << 20;
constexpr uint32_t kMaxProgramSize = 4u << 20;
constexpr uint32_t kMaxSections = 16;
constexpr uint32_t kMaxStack = 16;
constexpr uint32_t kNumRegs = 8;

constexpr uint32_t fourcc(char a, char b, char c, char d) {
  return uint32_t(uint8_t(a)) | uint32_t(uint8_t(b)) << 8 | uint32_t(uint8_t(c)) << 16 |
         uint32_t(uint8_t(d)) << 24;
}
constexpr uint32_t kTagStrs = fourcc('S', 'T', 'R', 'S');
constexpr uint32_t kTagInts = fourcc('I', 'N', 'T', 'S');
constexpr uint32_t kTagSrcs = fourcc('S', 'R', 'C', 'S');
constexpr uint32_t kTagRule = fourcc('R', 'U', 'L', 'E');
constexpr uint32_t kTagProf = fourcc('P', 'R', 'O', 'F');
constexpr uint32_t kTagItem = fourcc('I', 'T', 'E', 'M');
constexpr uint32_t kTagAggr = fourcc('A', 'G', 'G', 'R');
constexpr uint32_t kTagAnno = fourcc('A', 'N', 'N', 'O');
constexpr uint32_t kTagMeta = fourcc('M', 'E', 'T', 'A');

constexpr uint32_t kRuleRecordSize = 32;
constexpr uint32_t kSourceRecordSize = 44;
constexpr uint32_t kAnnoRecordSize = 12;

enum Category : uint8_t {
  CAT_EXAM_NO_BILL,
  CAT_EXAM_PAYMENT,
  CAT_TOTAL_CAP,
  CAT_EXPENSE_CAP,
  CAT_COVERED_EXPENSE,
  CAT_EXCLUDED_EXPENSE,
  CAT_FILING_DEADLINE,
  CAT_REPORTING_REQUIREMENT,
  CAT_MINIMUM_LOSS,
  CAT_COLLATERAL_SOURCE,
  CAT_CONDUCT_REDUCTION,
  CAT_EMERGENCY_AWARD,
  CAT_ELIGIBLE_CRIME,
  CAT_RESIDENCY,
  CAT_COUNT
};

// Order matches rules/SCHEMA.md; EXP_UNKNOWN is only ever an item expense.
enum Expense : uint8_t {
  EXP_MEDICAL,
  EXP_FORENSIC_EXAM,
  EXP_COUNSELING,
  EXP_LOST_WAGES,
  EXP_TRANSPORTATION,
  EXP_RELOCATION,
  EXP_TEMPORARY_HOUSING,
  EXP_SECURITY,
  EXP_CRIME_SCENE_CLEANUP,
  EXP_CHILDCARE,
  EXP_PROPERTY_REPLACEMENT,
  EXP_CLOTHING_BEDDING,
  EXP_PRESCRIPTION,
  EXP_DENTAL,
  EXP_FUNERAL,
  EXP_LEGAL,
  EXP_TUITION,
  EXP_OTHER,
  EXP_UNKNOWN,
  EXP_COUNT
};
constexpr uint8_t kRuleExpenseCount = EXP_UNKNOWN;  // expenses a rule may name

enum Per : uint8_t { PER_NONE, PER_CLAIM, PER_WEEK, PER_SESSION, PER_HOUR, PER_MILE, PER_DAY, PER_OTHER, PER_COUNT };

enum LineStatus : uint8_t {
  ST_OUT_OF_WINDOW,
  ST_HELD,
  ST_EXCLUDED,
  ST_UNKNOWN_RULE,
  ST_NEEDS_CONFIRMATION,
  ST_ELIGIBLE,
  ST_COUNT
};

// Trace ops 0..5 are the line statuses (DECIDE emits its status).
enum TraceOp : uint8_t {
  TR_COLLATERAL = ST_COUNT,
  TR_UNIT_CAP,
  TR_RATE_UNVERIFIED,
  TR_EXPENSE_CAP,
  TR_TOTAL_CAP,
  TR_DEADLINE,
  TR_MINIMUM_LOSS,
  TR_REPORTING,
  TR_COUNT
};

enum CheckKind : uint8_t { CK_DEADLINE, CK_MINIMUM_LOSS, CK_REPORTING, CK_COUNT };
enum DeadlineStatus : uint8_t { DL_OK, DL_LATE, DL_UNKNOWN, DL_COUNT };
enum MinLossStatus : uint8_t { ML_MET, ML_WAIVED, ML_NOT_MET, ML_UNKNOWN, ML_COUNT };
enum ReportStatus : uint8_t { RP_SATISFIED, RP_REQUIRED, RP_UNKNOWN, RP_COUNT };

enum CtxField : uint8_t { CX_INCIDENT_DATE, CX_AS_OF_DATE, CX_POLICE_REPORT, CX_FORENSIC_EXAM, CX_COUNT };
enum PoliceReport : uint8_t { PR_NO, PR_YES, PR_UNKNOWN };
enum ItemField : uint8_t {
  IF_DATE,
  IF_AMOUNT,
  IF_EXPENSE,
  IF_CONFIRMED,
  IF_INSURANCE_PAID,
  IF_IS_BILL,
  IF_UNITS,
  IF_COUNT
};

enum Opcode : uint8_t {
  OP_PUSH = 0x01,  // i32 imm
  OP_LDK = 0x02,   // u16 int-pool index
  OP_POP = 0x03,
  OP_DUP = 0x04,
  OP_SWAP = 0x05,
  OP_LDX = 0x08,  // u8 context field
  OP_LDI = 0x09,  // u8 item field
  OP_LDA = 0x0A,
  OP_LDR = 0x0B,  // u8 register
  OP_STR = 0x0C,  // u8 register
  OP_ADDS = 0x10,
  OP_SUBS = 0x11,
  OP_MULS = 0x12,
  OP_MIN = 0x13,
  OP_MAX = 0x14,
  OP_ADDY = 0x15,
  OP_EQ = 0x18,
  OP_NE = 0x19,
  OP_LT = 0x1A,
  OP_LE = 0x1B,
  OP_GT = 0x1C,
  OP_GE = 0x1D,
  OP_JMP = 0x20,     // u32 target
  OP_JZ = 0x21,      // u32 target
  OP_JNZ = 0x22,     // u32 target
  OP_SWITCH = 0x23,  // u8 n, u32 default, u32 x n
  OP_RET = 0x24,
  OP_DECIDE = 0x30,  // u8 status, u16 proof
  OP_SETEXP = 0x31,  // u8 expense
  OP_SETA = 0x32,    // u8 trace op, u16 rule
  OP_EACH = 0x40,    // u8 selector, u32 end
  OP_NEXT = 0x41,    // u32 head
  OP_CAP = 0x42,     // u8 trace op, u16 rule
  OP_FLAG = 0x43,    // u16 rule
  OP_CHECK = 0x44,   // u8 kind, u16 proof
  OP_SETDATE = 0x45,
  OP_INFO = 0x46,  // u16 proof
};

enum Operands : uint8_t {
  OPD_NONE,
  OPD_I32,
  OPD_U8,
  OPD_U16,
  OPD_U32,
  OPD_U8_U16,
  OPD_U8_U32,
  OPD_SWITCH,
};

// Where an instruction may appear.
constexpr uint8_t IN_ITEM = 1;
constexpr uint8_t IN_AGGR = 2;
constexpr uint8_t IN_BOTH = 3;
constexpr uint8_t AGGR_LOOP_ONLY = 4;

struct OpInfo {
  const char* name;  // nullptr for unassigned opcodes
  uint8_t operands;
  uint8_t pops;
  uint8_t pushes;
  uint8_t where;
};

const OpInfo& op_info(uint8_t op);

std::string_view category_name(uint8_t c);
std::string_view expense_name(uint8_t e);
std::string_view per_name(uint8_t p);
std::string_view status_name(uint8_t s);
std::string_view trace_op_name(uint8_t t);
std::string_view check_kind_name(uint8_t k);
std::string_view check_status_name(uint8_t kind, uint8_t status);
uint8_t check_status_count(uint8_t kind);
std::string_view ctx_field_name(uint8_t f);
std::string_view item_field_name(uint8_t f);

bool parse_category(std::string_view s, uint8_t& out);
bool parse_expense(std::string_view s, uint8_t& out);  // any of the 19 item expenses
bool parse_per(std::string_view s, uint8_t& out);      // unknown strings map to PER_OTHER

}  // namespace tend

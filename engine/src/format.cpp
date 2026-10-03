#include "format.h"

#include <array>

namespace tend {
namespace {

constexpr std::array<OpInfo, 256> make_op_table() {
  std::array<OpInfo, 256> t{};
  t[OP_PUSH] = {"push", OPD_I32, 0, 1, IN_BOTH};
  t[OP_LDK] = {"ldk", OPD_U16, 0, 1, IN_BOTH};
  t[OP_POP] = {"pop", OPD_NONE, 1, 0, IN_BOTH};
  t[OP_DUP] = {"dup", OPD_NONE, 1, 2, IN_BOTH};
  t[OP_SWAP] = {"swap", OPD_NONE, 2, 2, IN_BOTH};
  t[OP_LDX] = {"ldx", OPD_U8, 0, 1, IN_BOTH};
  t[OP_LDI] = {"ldi", OPD_U8, 0, 1, IN_BOTH | AGGR_LOOP_ONLY};
  t[OP_LDA] = {"lda", OPD_NONE, 0, 1, IN_BOTH | AGGR_LOOP_ONLY};
  t[OP_LDR] = {"ldr", OPD_U8, 0, 1, IN_BOTH};
  t[OP_STR] = {"str", OPD_U8, 1, 0, IN_BOTH};
  t[OP_ADDS] = {"adds", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_SUBS] = {"subs", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_MULS] = {"muls", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_MIN] = {"min", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_MAX] = {"max", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_AND] = {"and", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_OR] = {"or", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_EQ] = {"eq", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_NE] = {"ne", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_LT] = {"lt", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_LE] = {"le", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_GT] = {"gt", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_GE] = {"ge", OPD_NONE, 2, 1, IN_BOTH};
  t[OP_JMP] = {"jmp", OPD_U32, 0, 0, IN_BOTH};
  t[OP_JZ] = {"jz", OPD_U32, 1, 0, IN_BOTH};
  t[OP_JNZ] = {"jnz", OPD_U32, 1, 0, IN_BOTH};
  t[OP_SWITCH] = {"switch", OPD_SWITCH, 1, 0, IN_BOTH};
  t[OP_RET] = {"ret", OPD_NONE, 0, 0, IN_BOTH};
  t[OP_DECIDE] = {"decide", OPD_U8_U16, 1, 0, IN_ITEM};
  t[OP_SETEXP] = {"setexp", OPD_U8, 0, 0, IN_ITEM};
  t[OP_SETA] = {"seta", OPD_U8_U16, 1, 0, IN_ITEM};
  t[OP_ALTS] = {"alts", OPD_U16, 0, 0, IN_ITEM};
  t[OP_EACH] = {"each", OPD_U8_U32, 0, 0, IN_AGGR};
  t[OP_NEXT] = {"next", OPD_U32, 0, 0, IN_AGGR};
  t[OP_CAP] = {"cap", OPD_U8_U16, 1, 0, IN_AGGR | AGGR_LOOP_ONLY};
  t[OP_FLAG] = {"flag", OPD_U16, 0, 0, IN_AGGR | AGGR_LOOP_ONLY};
  t[OP_CHECK] = {"check", OPD_U8_U16, 1, 0, IN_AGGR};
  t[OP_SETDATE] = {"setdate", OPD_NONE, 1, 0, IN_AGGR};
  t[OP_INFO] = {"info", OPD_U16, 0, 0, IN_AGGR};
  return t;
}

constexpr std::array<OpInfo, 256> kOps = make_op_table();

constexpr std::string_view kKinds[K_COUNT] = {"exam_no_bill", "exam_payment", "total_cap",    "expense_cap",
                                              "covered",      "excluded",     "deadline",     "reporting",
                                              "minimum_loss", "collateral",   "info",         "skipped"};

constexpr std::string_view kExpenses[EXP_COUNT] = {
    "medical",  "forensic_exam",       "counseling",   "lost_wages",       "transportation",
    "relocation", "temporary_housing", "security",     "crime_scene_cleanup", "childcare",
    "property_replacement", "clothing_bedding", "prescription", "dental", "funeral",
    "legal",    "tuition",             "other",        "unknown"};

constexpr std::string_view kPers[PER_COUNT] = {"none", "claim", "unit"};

constexpr std::string_view kStatuses[ST_COUNT] = {"out_of_window", "held",
                                                  "excluded",      "unknown_rule",
                                                  "needs_confirmation", "eligible"};

constexpr std::string_view kTraceOps[TR_COUNT] = {
    "out_of_window", "held",        "excluded",      "unknown_rule", "needs_confirmation",
    "eligible",      "collateral",  "unit_cap",      "rate_unverified", "expense_cap",
    "total_cap",     "deadline",    "minimum_loss",  "reporting"};

constexpr std::string_view kCheckKinds[CK_COUNT] = {"deadline", "minimum_loss", "reporting"};
constexpr std::string_view kDeadline[DL_COUNT] = {"ok", "late", "unknown"};
constexpr std::string_view kMinLoss[ML_COUNT] = {"met", "waived", "may_be_waived", "not_met", "unknown"};
constexpr std::string_view kReport[RP_COUNT] = {"satisfied", "required", "not_required", "unknown"};
constexpr std::string_view kCtx[CX_COUNT] = {"incident_date", "as_of_date", "police_report",
                                             "forensic_exam"};
constexpr std::string_view kItemFields[IF_COUNT] = {"date",      "amount_cents",         "expense", "confirmed",
                                                    "insurance_paid_cents", "is_bill", "units",   "tags"};

std::string_view pick(const std::string_view* table, size_t n, size_t i) {
  return i < n ? table[i] : std::string_view("?");
}

}  // namespace

const OpInfo& op_info(uint8_t op) { return kOps[op]; }

std::string_view kind_name(uint8_t k) { return pick(kKinds, K_COUNT, k); }
std::string_view expense_name(uint8_t e) { return pick(kExpenses, EXP_COUNT, e); }
std::string_view per_name(uint8_t p) { return pick(kPers, PER_COUNT, p); }
std::string_view status_name(uint8_t s) { return pick(kStatuses, ST_COUNT, s); }
std::string_view trace_op_name(uint8_t t) { return pick(kTraceOps, TR_COUNT, t); }
std::string_view check_kind_name(uint8_t k) { return pick(kCheckKinds, CK_COUNT, k); }
std::string_view ctx_field_name(uint8_t f) { return pick(kCtx, CX_COUNT, f); }
std::string_view item_field_name(uint8_t f) { return pick(kItemFields, IF_COUNT, f); }

uint8_t check_status_count(uint8_t kind) {
  switch (kind) {
    case CK_DEADLINE: return DL_COUNT;
    case CK_MINIMUM_LOSS: return ML_COUNT;
    case CK_REPORTING: return RP_COUNT;
    default: return 0;
  }
}

std::string_view check_status_name(uint8_t kind, uint8_t status) {
  switch (kind) {
    case CK_DEADLINE: return pick(kDeadline, DL_COUNT, status);
    case CK_MINIMUM_LOSS: return pick(kMinLoss, ML_COUNT, status);
    case CK_REPORTING: return pick(kReport, RP_COUNT, status);
    default: return "?";
  }
}

bool parse_kind(std::string_view s, uint8_t& out) {
  for (uint8_t i = 0; i < K_SKIPPED; i++) {
    if (kKinds[i] == s) {
      out = i;
      return true;
    }
  }
  return false;
}

bool parse_expense(std::string_view s, uint8_t& out) {
  for (uint8_t i = 0; i < EXP_COUNT; i++) {
    if (kExpenses[i] == s) {
      out = i;
      return true;
    }
  }
  return false;
}

}  // namespace tend

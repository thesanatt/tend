; tend law image ZZ, Zedland (fictional test jurisdiction)
; format 1.1, compiled by tendc 1.1.0
; source sha256 2aaf3744efd7e7a79d3bfae2d80f1e0ae706277bd5dff3a847daa7fd1cbe3800
; image sha256  2e27f0b2b28830584f0b7dd68601911f86946a18704feddba289f8b8179e5004
; 34 rules, 2 sources, 32 proofs, 9 ints, 172 strings
; item program: 357 instructions, 1250 bytes, max stack 2
; aggregate program: 251 instructions, 768 bytes, max stack 3, 9 loops

.rules
    R0    ZZ-EXAM-1             exam_no_bill  -                                             ZC 4-110(2)
    R1    ZZ-EXAM-2             exam_payment  -                                             ZC 4-110(3)
    R2    ZZ-TOTAL-1            total_cap     -                                             ZC 4-120(1)
    R3    ZZ-TOTAL-2            total_cap     -                                             ZC 4-120(2)
    R4    ZZ-MED-1              covered       medical                                       ZC 4-115(1)(a)
    R5    ZZ-COUNSEL-1          covered       counseling                                    ZC 4-115(1)(b)
    R6    ZZ-COUNSEL-CAP-1      expense_cap   counseling            per session             Program Guide, Counseling
    R7    ZZ-COUNSEL-CAP-2      expense_cap   counseling            per claim               ZC 4-121(1)
    R8    ZZ-WAGES-1            covered       lost_wages                                    ZC 4-115(1)(c)
    R9    ZZ-WAGES-CAP-1        expense_cap   lost_wages            per week                ZC 4-121(2)
    R10   ZZ-TRANSPORT-CAP-1    expense_cap   transportation        per mile                Program Guide, Travel
    R11   ZZ-RELOC-CAP-1        expense_cap   relocation            per claim               ZC 4-121(3)
    R12   ZZ-SECURITY-CAP-1     expense_cap   security              per claim               ZC 4-121(4)
    R13   ZZ-DENTAL-1           covered       dental                                        ZC 4-115(1)(e)
    R14   ZZ-PROPERTY-1         excluded      property_replacement                          ZC 4-116(1)
    R15   ZZ-PROPERTY-CAP-1     expense_cap   property_replacement  per claim               Program Guide, Evidence
    R16   ZZ-PAIN-1             excluded      -                                             ZC 4-116(2)
    R17   ZZ-TUITION-1          excluded      tuition                                       ZC 4-116(3)
    R18   ZZ-DEADLINE-1         deadline      -                                             ZC 4-130(1)
    R19   ZZ-DEADLINE-2         deadline      -                                             ZC 4-130(2)
    R20   ZZ-DEADLINE-3         info          -                     filing_deadline         ZC 4-130(3)
    R21   ZZ-REPORT-1           reporting     -                                             ZC 4-131
    R22   ZZ-MINLOSS-1          minimum_loss  -                                             ZC 4-132
    R23   ZZ-COLLATERAL-1       collateral    -                                             ZC 4-133
    R24   ZZ-CONDUCT-1          info          -                     conduct_reduction       ZC 4-134
    R25   ZZ-EMERGENCY-1        info          -                     emergency_award         ZC 4-135
    R26   ZZ-CRIME-1            info          -                     eligible_crime          ZC 4-102(5)
    R27   ZZ-RESIDENCY-1        info          -                     residency               ZC 4-103
    R28   ZZ-SUBMIT-1           info          -                     submission              Program Guide, How to apply
    R29   ZZ-RX-1               covered       prescription                                  ZC 4-115(1)(d)
    R30   ZZ-CHILDCARE-1        covered       childcare                                     Program Guide, Child care
    R31   ZZ-COUNSEL-FAMILY-1   skipped       -                     expense_cap             ZC 4-121(5)  ; applies_to "family members of the victim"
    R32   ZZ-DENTAL-CAP-1       skipped       -                     expense_cap             Program Guide, Dental  ; expense_cap without amount or expense
    R33   ZZ-COUNSEL-CAP-3      skipped       -                     expense_cap             Program Guide, Counseling rates  ; less generous duplicate of ZZ-COUNSEL-CAP-1

.tags   phone=bit0, purse=bit1, pain_suffering=bit2

.sources
    S0    ZZ-S1       sha256 c74225eb26f0252b  https://example.org/zedland/act
    S1    ZZ-S2       sha256 090e7d70ff29076d  https://example.org/zedland/guide

.proofs
    P0    ()
    P1    (ZZ-EXAM-1, ZZ-EXAM-2)
    P2    (ZZ-PAIN-1)
    P3    (ZZ-MED-1)
    P4    (ZZ-MED-1, ZZ-COLLATERAL-1)
    P5    (ZZ-COUNSEL-CAP-3)
    P6    (ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2)
    P7    (ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2, ZZ-COLLATERAL-1)
    P8    (ZZ-WAGES-1, ZZ-WAGES-CAP-1)
    P9    (ZZ-WAGES-1, ZZ-WAGES-CAP-1, ZZ-COLLATERAL-1)
    P10   (ZZ-TRANSPORT-CAP-1)
    P11   (ZZ-TRANSPORT-CAP-1, ZZ-COLLATERAL-1)
    P12   (ZZ-RELOC-CAP-1)
    P13   (ZZ-RELOC-CAP-1, ZZ-COLLATERAL-1)
    P14   (ZZ-SECURITY-CAP-1)
    P15   (ZZ-SECURITY-CAP-1, ZZ-COLLATERAL-1)
    P16   (ZZ-CHILDCARE-1)
    P17   (ZZ-CHILDCARE-1, ZZ-COLLATERAL-1)
    P18   (ZZ-PROPERTY-1)
    P19   (ZZ-PROPERTY-1, ZZ-PAIN-1)
    P20   (ZZ-PROPERTY-CAP-1)
    P21   (ZZ-PROPERTY-CAP-1, ZZ-COLLATERAL-1)
    P22   (ZZ-RX-1)
    P23   (ZZ-RX-1, ZZ-COLLATERAL-1)
    P24   (ZZ-DENTAL-1)
    P25   (ZZ-DENTAL-1, ZZ-COLLATERAL-1)
    P26   (ZZ-PAIN-1, ZZ-TUITION-1)
    P27   (ZZ-TUITION-1)
    P28   (ZZ-MINLOSS-1)
    P29   (ZZ-DEADLINE-1, ZZ-DEADLINE-2)
    P30   (ZZ-REPORT-1)
    P31   (ZZ-DEADLINE-3, ZZ-COLLATERAL-1, ZZ-CONDUCT-1, ZZ-EMERGENCY-1, ZZ-CRIME-1, ZZ-RESIDENCY-1, ZZ-SUBMIT-1)

.ints
    K0    9000          ; $90.00
    K1    60000         ; $600.00
    K2    50            ; $0.50
    K3    300000        ; $3,000.00
    K4    200000        ; $2,000.00
    K5    40000         ; $400.00
    K6    50000         ; $500.00
    K7    2500000       ; $25,000.00
    K8    10000         ; $100.00

.item
  0000        ldi      date
  0002        ldx      incident_date
  0004        lt
  0005        jnz      L0
  000a        ldi      date
  000c        ldx      as_of_date
  000e        gt
  000f        jnz      L0
  0014        ldi      expense
  0016        switch   19, default L27
                        case medical               -> L2
                        case forensic_exam         -> L1
                        case counseling            -> L7
                        case lost_wages            -> L12
                        case transportation        -> L17
                        case relocation            -> L22
                        case temporary_housing     -> L27
                        case security              -> L31
                        case crime_scene_cleanup   -> L27
                        case childcare             -> L36
                        case property_replacement  -> L41
                        case clothing_bedding      -> L27
                        case prescription          -> L49
                        case dental                -> L54
                        case funeral               -> L27
                        case legal                 -> L27
                        case tuition               -> L59
                        case other                 -> L27
                        case unknown               -> L27
  0068  L0:   push     0
  006d        decide   out_of_window, P0            ; (none)
  0071        ret
              ; ZZ-EXAM-1  ZC 4-110(2)  "A health care provider shall not bill a victim for any part of a..."
              ; ZZ-EXAM-2  ZC 4-110(3)  "The Forensic Exam Fund shall pay the provider directly for the..."
  0072  L1:   push     0
  0077        decide   held, P1                     ; ZZ-EXAM-1, ZZ-EXAM-2
  007b        ret
              ; ZZ-MED-1  ZC 4-115(1)(a)  "Reasonable medical and hospital expenses are compensable."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  007c  L2:   push     0
  0081        str      r0
  0083        ldi      tags
  0085        push     4
  008a        and
  008b        jz       L3
  0090        ldr      r0
  0092        push     1
  0097        or
  0098        str      r0
  009a  L3:   ldr      r0
  009c        switch   2, default L5
                        case 0                     -> L5
                        case 1                     -> L4
  00aa  L4:   push     0
  00af        decide   excluded, P2                 ; ZZ-PAIN-1
  00b3        ret
  00b4  L5:   ldi      confirmed
  00b6        jnz      L6
  00bb        push     0
  00c0        decide   needs_confirmation, P3       ; ZZ-MED-1
  00c4        ret
  00c5  L6:   ldi      amount_cents
  00c7        decide   eligible, P4                 ; ZZ-MED-1, ZZ-COLLATERAL-1
  00cb        lda
  00cc        ldi      insurance_paid_cents
  00ce        subs
  00cf        push     0
  00d4        max
  00d5        seta     collateral, R23              ; ZZ-COLLATERAL-1
  00d9        ret
              ; ZZ-COUNSEL-1  ZC 4-115(1)(b)  "Mental health counseling for the victim is compensable."
              ; ZZ-COUNSEL-CAP-1  Program Guide, Counseling  "Counseling shall be paid at no more than $90 per session, for no..."
              ; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  "Counseling payments shall not exceed $3,000 per claim."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  00da  L7:   push     0
  00df        str      r0
  00e1        ldi      tags
  00e3        push     4
  00e8        and
  00e9        jz       L8
  00ee        ldr      r0
  00f0        push     1
  00f5        or
  00f6        str      r0
  00f8  L8:   ldr      r0
  00fa        switch   2, default L10
                        case 0                     -> L10
                        case 1                     -> L9
  0108  L9:   push     0
  010d        decide   excluded, P2                 ; ZZ-PAIN-1
  0111        ret
  0112  L10:  alts     P5                           ; ZZ-COUNSEL-CAP-3
  0115        ldi      confirmed
  0117        jnz      L11
  011c        push     0
  0121        decide   needs_confirmation, P6       ; ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2
  0125        ret
  0126  L11:  ldi      amount_cents
  0128        decide   eligible, P7                 ; ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2, ZZ-COLLATERAL-1
  012c        lda
  012d        ldi      insurance_paid_cents
  012f        subs
  0130        push     0
  0135        max
  0136        seta     collateral, R23              ; ZZ-COLLATERAL-1
  013a        ret
              ; ZZ-WAGES-1  ZC 4-115(1)(c)  "Loss of earnings resulting from the crime is compensable."
              ; ZZ-WAGES-CAP-1  ZC 4-121(2)  "Lost wages shall not exceed $600 per week."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  013b  L12:  push     0
  0140        str      r0
  0142        ldi      tags
  0144        push     4
  0149        and
  014a        jz       L13
  014f        ldr      r0
  0151        push     1
  0156        or
  0157        str      r0
  0159  L13:  ldr      r0
  015b        switch   2, default L15
                        case 0                     -> L15
                        case 1                     -> L14
  0169  L14:  push     0
  016e        decide   excluded, P2                 ; ZZ-PAIN-1
  0172        ret
  0173  L15:  ldi      confirmed
  0175        jnz      L16
  017a        push     0
  017f        decide   needs_confirmation, P8       ; ZZ-WAGES-1, ZZ-WAGES-CAP-1
  0183        ret
  0184  L16:  ldi      amount_cents
  0186        decide   eligible, P9                 ; ZZ-WAGES-1, ZZ-WAGES-CAP-1, ZZ-COLLATERAL-1
  018a        lda
  018b        ldi      insurance_paid_cents
  018d        subs
  018e        push     0
  0193        max
  0194        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0198        ret
              ; ZZ-TRANSPORT-CAP-1  Program Guide, Travel  "Travel to treatment is reimbursed at $0.50 per mile."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0199  L17:  push     0
  019e        str      r0
  01a0        ldi      tags
  01a2        push     4
  01a7        and
  01a8        jz       L18
  01ad        ldr      r0
  01af        push     1
  01b4        or
  01b5        str      r0
  01b7  L18:  ldr      r0
  01b9        switch   2, default L20
                        case 0                     -> L20
                        case 1                     -> L19
  01c7  L19:  push     0
  01cc        decide   excluded, P2                 ; ZZ-PAIN-1
  01d0        ret
  01d1  L20:  ldi      confirmed
  01d3        jnz      L21
  01d8        push     0
  01dd        decide   needs_confirmation, P10      ; ZZ-TRANSPORT-CAP-1
  01e1        ret
  01e2  L21:  ldi      amount_cents
  01e4        decide   eligible, P11                ; ZZ-TRANSPORT-CAP-1, ZZ-COLLATERAL-1
  01e8        lda
  01e9        ldi      insurance_paid_cents
  01eb        subs
  01ec        push     0
  01f1        max
  01f2        seta     collateral, R23              ; ZZ-COLLATERAL-1
  01f6        ret
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  01f7  L22:  push     0
  01fc        str      r0
  01fe        ldi      tags
  0200        push     4
  0205        and
  0206        jz       L23
  020b        ldr      r0
  020d        push     1
  0212        or
  0213        str      r0
  0215  L23:  ldr      r0
  0217        switch   2, default L25
                        case 0                     -> L25
                        case 1                     -> L24
  0225  L24:  push     0
  022a        decide   excluded, P2                 ; ZZ-PAIN-1
  022e        ret
  022f  L25:  ldi      confirmed
  0231        jnz      L26
  0236        push     0
  023b        decide   needs_confirmation, P12      ; ZZ-RELOC-CAP-1
  023f        ret
  0240  L26:  ldi      amount_cents
  0242        decide   eligible, P13                ; ZZ-RELOC-CAP-1, ZZ-COLLATERAL-1
  0246        lda
  0247        ldi      insurance_paid_cents
  0249        subs
  024a        push     0
  024f        max
  0250        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0254        ret
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
  0255  L27:  push     0
  025a        str      r0
  025c        ldi      tags
  025e        push     4
  0263        and
  0264        jz       L28
  0269        ldr      r0
  026b        push     1
  0270        or
  0271        str      r0
  0273  L28:  ldr      r0
  0275        switch   2, default L30
                        case 0                     -> L30
                        case 1                     -> L29
  0283  L29:  push     0
  0288        decide   excluded, P2                 ; ZZ-PAIN-1
  028c        ret
  028d  L30:  push     0
  0292        decide   unknown_rule, P0             ; (none)
  0296        ret
              ; ZZ-SECURITY-CAP-1  ZC 4-121(4)  "Security devices shall not exceed $400 per residence."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0297  L31:  push     0
  029c        str      r0
  029e        ldi      tags
  02a0        push     4
  02a5        and
  02a6        jz       L32
  02ab        ldr      r0
  02ad        push     1
  02b2        or
  02b3        str      r0
  02b5  L32:  ldr      r0
  02b7        switch   2, default L34
                        case 0                     -> L34
                        case 1                     -> L33
  02c5  L33:  push     0
  02ca        decide   excluded, P2                 ; ZZ-PAIN-1
  02ce        ret
  02cf  L34:  ldi      confirmed
  02d1        jnz      L35
  02d6        push     0
  02db        decide   needs_confirmation, P14      ; ZZ-SECURITY-CAP-1
  02df        ret
  02e0  L35:  ldi      amount_cents
  02e2        decide   eligible, P15                ; ZZ-SECURITY-CAP-1, ZZ-COLLATERAL-1
  02e6        lda
  02e7        ldi      insurance_paid_cents
  02e9        subs
  02ea        push     0
  02ef        max
  02f0        seta     collateral, R23              ; ZZ-COLLATERAL-1
  02f4        ret
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
              ; ZZ-CHILDCARE-1  Program Guide, Child care  "Child care needed so the victim can attend treatment is..."
  02f5  L36:  push     0
  02fa        str      r0
  02fc        ldi      tags
  02fe        push     4
  0303        and
  0304        jz       L37
  0309        ldr      r0
  030b        push     1
  0310        or
  0311        str      r0
  0313  L37:  ldr      r0
  0315        switch   2, default L39
                        case 0                     -> L39
                        case 1                     -> L38
  0323  L38:  push     0
  0328        decide   excluded, P2                 ; ZZ-PAIN-1
  032c        ret
  032d  L39:  ldi      confirmed
  032f        jnz      L40
  0334        push     0
  0339        decide   needs_confirmation, P16      ; ZZ-CHILDCARE-1
  033d        ret
  033e  L40:  ldi      amount_cents
  0340        decide   eligible, P17                ; ZZ-CHILDCARE-1, ZZ-COLLATERAL-1
  0344        lda
  0345        ldi      insurance_paid_cents
  0347        subs
  0348        push     0
  034d        max
  034e        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0352        ret
              ; ZZ-PROPERTY-1  ZC 4-116(1)  "Replacement of a lost or stolen cell phone or wallet is not..."
              ; ZZ-PROPERTY-CAP-1  Program Guide, Evidence  "Property held as evidence may be replaced up to $500."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0353  L41:  push     0
  0358        str      r0
  035a        ldi      tags
  035c        push     3
  0361        and
  0362        jz       L42
  0367        ldr      r0
  0369        push     1
  036e        or
  036f        str      r0
  0371  L42:  ldi      tags
  0373        push     4
  0378        and
  0379        jz       L43
  037e        ldr      r0
  0380        push     2
  0385        or
  0386        str      r0
  0388  L43:  ldr      r0
  038a        switch   4, default L47
                        case 0                     -> L47
                        case 1                     -> L44
                        case 2                     -> L45
                        case 3                     -> L46
  03a0  L44:  push     0
  03a5        decide   excluded, P18                ; ZZ-PROPERTY-1
  03a9        ret
  03aa  L45:  push     0
  03af        decide   excluded, P2                 ; ZZ-PAIN-1
  03b3        ret
  03b4  L46:  push     0
  03b9        decide   excluded, P19                ; ZZ-PROPERTY-1, ZZ-PAIN-1
  03bd        ret
  03be  L47:  ldi      confirmed
  03c0        jnz      L48
  03c5        push     0
  03ca        decide   needs_confirmation, P20      ; ZZ-PROPERTY-CAP-1
  03ce        ret
  03cf  L48:  ldi      amount_cents
  03d1        decide   eligible, P21                ; ZZ-PROPERTY-CAP-1, ZZ-COLLATERAL-1
  03d5        lda
  03d6        ldi      insurance_paid_cents
  03d8        subs
  03d9        push     0
  03de        max
  03df        seta     collateral, R23              ; ZZ-COLLATERAL-1
  03e3        ret
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
              ; ZZ-RX-1  ZC 4-115(1)(d)  "Prescription medication is compensable."
  03e4  L49:  push     0
  03e9        str      r0
  03eb        ldi      tags
  03ed        push     4
  03f2        and
  03f3        jz       L50
  03f8        ldr      r0
  03fa        push     1
  03ff        or
  0400        str      r0
  0402  L50:  ldr      r0
  0404        switch   2, default L52
                        case 0                     -> L52
                        case 1                     -> L51
  0412  L51:  push     0
  0417        decide   excluded, P2                 ; ZZ-PAIN-1
  041b        ret
  041c  L52:  ldi      confirmed
  041e        jnz      L53
  0423        push     0
  0428        decide   needs_confirmation, P22      ; ZZ-RX-1
  042c        ret
  042d  L53:  ldi      amount_cents
  042f        decide   eligible, P23                ; ZZ-RX-1, ZZ-COLLATERAL-1
  0433        lda
  0434        ldi      insurance_paid_cents
  0436        subs
  0437        push     0
  043c        max
  043d        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0441        ret
              ; ZZ-DENTAL-1  ZC 4-115(1)(e)  "Dental care needed because of the crime is compensable."
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0442  L54:  push     0
  0447        str      r0
  0449        ldi      tags
  044b        push     4
  0450        and
  0451        jz       L55
  0456        ldr      r0
  0458        push     1
  045d        or
  045e        str      r0
  0460  L55:  ldr      r0
  0462        switch   2, default L57
                        case 0                     -> L57
                        case 1                     -> L56
  0470  L56:  push     0
  0475        decide   excluded, P2                 ; ZZ-PAIN-1
  0479        ret
  047a  L57:  ldi      confirmed
  047c        jnz      L58
  0481        push     0
  0486        decide   needs_confirmation, P24      ; ZZ-DENTAL-1
  048a        ret
  048b  L58:  ldi      amount_cents
  048d        decide   eligible, P25                ; ZZ-DENTAL-1, ZZ-COLLATERAL-1
  0491        lda
  0492        ldi      insurance_paid_cents
  0494        subs
  0495        push     0
  049a        max
  049b        seta     collateral, R23              ; ZZ-COLLATERAL-1
  049f        ret
              ; ZZ-PAIN-1  ZC 4-116(2)  "Pain and suffering is not compensable."
              ; ZZ-TUITION-1  ZC 4-116(3)  "Tuition and school fees are not compensable."
  04a0  L59:  push     0
  04a5        str      r0
  04a7        ldi      tags
  04a9        push     4
  04ae        and
  04af        jz       L60
  04b4        ldr      r0
  04b6        push     1
  04bb        or
  04bc        str      r0
  04be  L60:  ldr      r0
  04c0        switch   2, default L62
                        case 0                     -> L62
                        case 1                     -> L61
  04ce  L61:  push     0
  04d3        decide   excluded, P26                ; ZZ-PAIN-1, ZZ-TUITION-1
  04d7        ret
  04d8  L62:  push     0
  04dd        decide   excluded, P27                ; ZZ-TUITION-1
  04e1        ret

.aggregate
              ; ZZ-COUNSEL-CAP-1  Program Guide, Counseling  "Counseling shall be paid at no more than $90 per session, for no..."
  0000        push     3
  0005        str      r3
  0007        each     counseling, L4
  000d  L0:   ldi      units
  000f        jz       L2
  0014        ldi      units
  0016        ldr      r3
  0018        min
  0019        str      r4
  001b        ldr      r3
  001d        ldr      r4
  001f        subs
  0020        str      r3
  0022        ldk      K0                           ; $90.00
  0025        ldr      r4
  0027        muls
  0028        dup
  0029        lda
  002a        lt
  002b        jz       L1
  0030        cap      unit_cap, R6                 ; ZZ-COUNSEL-CAP-1
  0034        jmp      L3
  0039  L1:   pop
  003a        jmp      L3
  003f  L2:   flag     R6                           ; rate_unverified ZZ-COUNSEL-CAP-1
  0042  L3:   next     L0
              ; ZZ-WAGES-CAP-1  ZC 4-121(2)  "Lost wages shall not exceed $600 per week."
  0047  L4:   each     lost_wages, L9
  004d  L5:   ldi      units
  004f        jz       L7
  0054        ldk      K1                           ; $600.00
  0057        ldi      units
  0059        muls
  005a        dup
  005b        lda
  005c        lt
  005d        jz       L6
  0062        cap      unit_cap, R9                 ; ZZ-WAGES-CAP-1
  0066        jmp      L8
  006b  L6:   pop
  006c        jmp      L8
  0071  L7:   flag     R9                           ; rate_unverified ZZ-WAGES-CAP-1
  0074  L8:   next     L5
              ; ZZ-TRANSPORT-CAP-1  Program Guide, Travel  "Travel to treatment is reimbursed at $0.50 per mile."
  0079  L9:   each     transportation, L14
  007f  L10:  ldi      units
  0081        jz       L12
  0086        ldk      K2                           ; $0.50
  0089        ldi      units
  008b        muls
  008c        dup
  008d        lda
  008e        lt
  008f        jz       L11
  0094        cap      unit_cap, R10                ; ZZ-TRANSPORT-CAP-1
  0098        jmp      L13
  009d  L11:  pop
  009e        jmp      L13
  00a3  L12:  flag     R10                          ; rate_unverified ZZ-TRANSPORT-CAP-1
  00a6  L13:  next     L10
              ; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  "Counseling payments shall not exceed $3,000 per claim."
  00ab  L14:  push     0
  00b0        str      r0
  00b2        push     0
  00b7        str      r1
  00b9        each     counseling, L19
  00bf  L15:  ldr      r1
  00c1        jnz      L17
  00c6        ldr      r0
  00c8        lda
  00c9        adds
  00ca        ldk      K3                           ; $3,000.00
  00cd        gt
  00ce        jz       L16
  00d3        ldk      K3                           ; $3,000.00
  00d6        ldr      r0
  00d8        subs
  00d9        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  00dd        push     1
  00e2        str      r1
  00e4  L16:  ldr      r0
  00e6        lda
  00e7        adds
  00e8        str      r0
  00ea        jmp      L18
  00ef  L17:  push     0
  00f4        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  00f8  L18:  next     L15
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
  00fd  L19:  push     0
  0102        str      r0
  0104        push     0
  0109        str      r1
  010b        each     relocation, L24
  0111  L20:  ldr      r1
  0113        jnz      L22
  0118        ldr      r0
  011a        lda
  011b        adds
  011c        ldk      K4                           ; $2,000.00
  011f        gt
  0120        jz       L21
  0125        ldk      K4                           ; $2,000.00
  0128        ldr      r0
  012a        subs
  012b        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  012f        push     1
  0134        str      r1
  0136  L21:  ldr      r0
  0138        lda
  0139        adds
  013a        str      r0
  013c        jmp      L23
  0141  L22:  push     0
  0146        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  014a  L23:  next     L20
              ; ZZ-SECURITY-CAP-1  ZC 4-121(4)  "Security devices shall not exceed $400 per residence."
  014f  L24:  push     0
  0154        str      r0
  0156        push     0
  015b        str      r1
  015d        each     security, L29
  0163  L25:  ldr      r1
  0165        jnz      L27
  016a        ldr      r0
  016c        lda
  016d        adds
  016e        ldk      K5                           ; $400.00
  0171        gt
  0172        jz       L26
  0177        ldk      K5                           ; $400.00
  017a        ldr      r0
  017c        subs
  017d        cap      expense_cap, R12             ; ZZ-SECURITY-CAP-1
  0181        push     1
  0186        str      r1
  0188  L26:  ldr      r0
  018a        lda
  018b        adds
  018c        str      r0
  018e        jmp      L28
  0193  L27:  push     0
  0198        cap      expense_cap, R12             ; ZZ-SECURITY-CAP-1
  019c  L28:  next     L25
              ; ZZ-PROPERTY-CAP-1  Program Guide, Evidence  "Property held as evidence may be replaced up to $500."
  01a1  L29:  push     0
  01a6        str      r0
  01a8        push     0
  01ad        str      r1
  01af        each     property_replacement, L34
  01b5  L30:  ldr      r1
  01b7        jnz      L32
  01bc        ldr      r0
  01be        lda
  01bf        adds
  01c0        ldk      K6                           ; $500.00
  01c3        gt
  01c4        jz       L31
  01c9        ldk      K6                           ; $500.00
  01cc        ldr      r0
  01ce        subs
  01cf        cap      expense_cap, R15             ; ZZ-PROPERTY-CAP-1
  01d3        push     1
  01d8        str      r1
  01da  L31:  ldr      r0
  01dc        lda
  01dd        adds
  01de        str      r0
  01e0        jmp      L33
  01e5  L32:  push     0
  01ea        cap      expense_cap, R15             ; ZZ-PROPERTY-CAP-1
  01ee  L33:  next     L30
              ; ZZ-TOTAL-1  ZC 4-120(1)  "The total award for a claim shall not exceed $25,000."
  01f3  L34:  push     0
  01f8        str      r0
  01fa        push     0
  01ff        str      r1
  0201        each     all, L39
  0207  L35:  ldr      r1
  0209        jnz      L37
  020e        ldr      r0
  0210        lda
  0211        adds
  0212        ldk      K7                           ; $25,000.00
  0215        gt
  0216        jz       L36
  021b        ldk      K7                           ; $25,000.00
  021e        ldr      r0
  0220        subs
  0221        cap      total_cap, R2                ; ZZ-TOTAL-1
  0225        push     1
  022a        str      r1
  022c  L36:  ldr      r0
  022e        lda
  022f        adds
  0230        str      r0
  0232        jmp      L38
  0237  L37:  push     0
  023c        cap      total_cap, R2                ; ZZ-TOTAL-1
  0240  L38:  next     L35
  0245  L39:  push     0
  024a        str      r0
  024c        each     all, L41
  0252  L40:  ldr      r0
  0254        lda
  0255        adds
  0256        str      r0
  0258        next     L40
  025d  L41:  push     0
  0262        str      r2
              ; ZZ-MINLOSS-1  ZC 4-132  "A claimant shall have a minimum loss of $100; this requirement..."
  0264        ldr      r0
  0266        ldk      K8                           ; $100.00
  0269        lt
  026a        jz       L44
  026f        ldx      forensic_exam
  0271        jz       L42
  0276        push     1
  027b        jmp      L43
  0280  L42:  push     3
  0285  L43:  ldr      r2
  0287        max
  0288        str      r2
  028a  L44:  ldr      r2
  028c        check    minimum_loss, P28            ; ZZ-MINLOSS-1
              ; ZZ-DEADLINE-1  ZC 4-130(1)  "A claim shall be filed within 3 years after the crime."
  0290        ldx      incident_date
  0292        push     1095
  0297        adds
              ; ZZ-DEADLINE-2  ZC 4-130(2)  "A claim may be filed within 400 days after discovery of the..."
  0298        ldx      incident_date
  029a        push     400
  029f        adds
  02a0        max
  02a1        dup
  02a2        setdate
  02a3        ldx      as_of_date
  02a5        ge
  02a6        jz       L45
  02ab        push     0
  02b0        jmp      L46
  02b5  L45:  push     1                            ; late
  02ba  L46:  check    deadline, P29                ; ZZ-DEADLINE-1, ZZ-DEADLINE-2
              ; ZZ-REPORT-1  ZC 4-131  "The crime shall be reported to law enforcement within 5 days..."
  02be        ldx      police_report
  02c0        push     1                            ; yes
  02c5        eq
  02c6        jnz      L48
  02cb        ldx      forensic_exam
  02cd        jnz      L48
  02d2        ldx      police_report
  02d4        push     0                            ; no
  02d9        eq
  02da        jnz      L47
  02df        push     3
  02e4        jmp      L49
  02e9  L47:  push     1
  02ee        jmp      L49
  02f3  L48:  push     0                            ; satisfied
  02f8  L49:  check    reporting, P30               ; ZZ-REPORT-1
              ; ZZ-DEADLINE-3  ZC 4-130(3)  "The board may extend the filing period for good cause."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
              ; ZZ-CONDUCT-1  ZC 4-134  "The board may reduce an award for the victim's contributory..."
              ; ZZ-EMERGENCY-1  ZC 4-135  "The board may grant an emergency award of up to $500."
              ; ZZ-CRIME-1  ZC 4-102(5)  "Sexual assault is a compensable crime."
              ; ZZ-RESIDENCY-1  ZC 4-103  "A victim of a crime committed in Zedland may apply regardless of..."
              ; ZZ-SUBMIT-1  Program Guide, How to apply  "Mail the completed application to the Victim Services Board, 1..."
  02fc        info     P31                          ; ZZ-DEADLINE-3, ZZ-COLLATERAL-1, ZZ-CONDUCT-1, ZZ-EMERGENCY-1, ZZ-CRIME-1, ZZ-RESIDENCY-1, ZZ-SUBMIT-1
  02ff        ret


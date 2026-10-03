; tend law image ZZ, Zedland (fictional test jurisdiction)
; format 1.2, compiled by tendc 1.2.0
; source sha256 9c880106e3fd50a5377314b8335f891191d3e80c5e1b9c8120699ca99dfb5e23
; image sha256  291b758b56b0f50e94d5d7cf9ff32a820564a809e3f2840f9c0bc9b69f86fd6b
; 36 rules, 2 sources, 32 proofs, 9 ints, 183 strings
; item program: 357 instructions, 1250 bytes, max stack 2
; aggregate program: 307 instructions, 925 bytes, max stack 3, 10 loops

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
    R18   ZZ-DEADLINE-1         deadline      -                     from crime              ZC 4-130(1)
    R19   ZZ-DEADLINE-2         deadline      -                     from discovery          ZC 4-130(2)
    R20   ZZ-DEADLINE-3         info          -                     filing_deadline         ZC 4-130(3)
    R21   ZZ-DEADLINE-4         deadline      -                     from report             ZC 4-130(4)
    R22   ZZ-REPORT-1           reporting     -                                             ZC 4-131
    R23   ZZ-MINLOSS-1          minimum_loss  -                                             ZC 4-132
    R24   ZZ-MINLOSS-2          minimum_loss  -                                             ZC 4-132(2)
    R25   ZZ-COLLATERAL-1       collateral    -                                             ZC 4-133
    R26   ZZ-CONDUCT-1          info          -                     conduct_reduction       ZC 4-134
    R27   ZZ-EMERGENCY-1        info          -                     emergency_award         ZC 4-135
    R28   ZZ-CRIME-1            info          -                     eligible_crime          ZC 4-102(5)
    R29   ZZ-RESIDENCY-1        info          -                     residency               ZC 4-103
    R30   ZZ-SUBMIT-1           info          -                     submission              Program Guide, How to apply
    R31   ZZ-RX-1               covered       prescription                                  ZC 4-115(1)(d)
    R32   ZZ-CHILDCARE-1        covered       childcare                                     Program Guide, Child care
    R33   ZZ-COUNSEL-FAMILY-1   skipped       -                     expense_cap             ZC 4-121(5)  ; applies_to "family members of the victim"
    R34   ZZ-DENTAL-CAP-1       skipped       -                     expense_cap             Program Guide, Dental  ; expense_cap without amount or expense
    R35   ZZ-COUNSEL-CAP-3      skipped       -                     expense_cap             Program Guide, Counseling rates  ; less generous duplicate of ZZ-COUNSEL-CAP-1

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
    P28   (ZZ-MINLOSS-1, ZZ-MINLOSS-2)
    P29   (ZZ-DEADLINE-1, ZZ-DEADLINE-2, ZZ-DEADLINE-4)
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
  00d5        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  0136        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  0194        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  01f2        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  0250        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  02f0        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  034e        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  03df        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  043d        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  049b        seta     collateral, R25              ; ZZ-COLLATERAL-1
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
  000d  L0:   ldi      unit
  000f        push     1                            ; session
  0014        eq
  0015        jz       L2
  001a        ldi      units
  001c        push     0
  0021        gt
  0022        jz       L2
  0027        ldi      units
  0029        ldr      r3
  002b        min
  002c        str      r4
  002e        ldr      r3
  0030        ldr      r4
  0032        subs
  0033        str      r3
  0035        ldk      K0                           ; $90.00
  0038        ldr      r4
  003a        muls
  003b        dup
  003c        lda
  003d        lt
  003e        jz       L1
  0043        cap      unit_cap, R6                 ; ZZ-COUNSEL-CAP-1
  0047        jmp      L3
  004c  L1:   pop
  004d        jmp      L3
  0052  L2:   flag     R6                           ; rate_unverified ZZ-COUNSEL-CAP-1
  0055  L3:   next     L0
              ; ZZ-WAGES-CAP-1  ZC 4-121(2)  "Lost wages shall not exceed $600 per week."
  005a  L4:   each     lost_wages, L9
  0060  L5:   ldi      unit
  0062        push     2                            ; week
  0067        eq
  0068        jz       L7
  006d        ldi      units
  006f        push     0
  0074        gt
  0075        jz       L7
  007a        ldk      K1                           ; $600.00
  007d        ldi      units
  007f        muls
  0080        dup
  0081        lda
  0082        lt
  0083        jz       L6
  0088        cap      unit_cap, R9                 ; ZZ-WAGES-CAP-1
  008c        jmp      L8
  0091  L6:   pop
  0092        jmp      L8
  0097  L7:   flag     R9                           ; rate_unverified ZZ-WAGES-CAP-1
  009a  L8:   next     L5
              ; ZZ-TRANSPORT-CAP-1  Program Guide, Travel  "Travel to treatment is reimbursed at $0.50 per mile."
  009f  L9:   each     transportation, L14
  00a5  L10:  ldi      unit
  00a7        push     4                            ; mile
  00ac        eq
  00ad        jz       L12
  00b2        ldi      units
  00b4        push     0
  00b9        gt
  00ba        jz       L12
  00bf        ldk      K2                           ; $0.50
  00c2        ldi      units
  00c4        muls
  00c5        dup
  00c6        lda
  00c7        lt
  00c8        jz       L11
  00cd        cap      unit_cap, R10                ; ZZ-TRANSPORT-CAP-1
  00d1        jmp      L13
  00d6  L11:  pop
  00d7        jmp      L13
  00dc  L12:  flag     R10                          ; rate_unverified ZZ-TRANSPORT-CAP-1
  00df  L13:  next     L10
              ; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  "Counseling payments shall not exceed $3,000 per claim."
  00e4  L14:  push     0
  00e9        str      r0
  00eb        push     0
  00f0        str      r1
  00f2        each     counseling, L19
  00f8  L15:  ldr      r1
  00fa        jnz      L17
  00ff        ldr      r0
  0101        lda
  0102        adds
  0103        ldk      K3                           ; $3,000.00
  0106        gt
  0107        jz       L16
  010c        ldk      K3                           ; $3,000.00
  010f        ldr      r0
  0111        subs
  0112        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  0116        push     1
  011b        str      r1
  011d  L16:  ldr      r0
  011f        lda
  0120        adds
  0121        str      r0
  0123        jmp      L18
  0128  L17:  push     0
  012d        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  0131  L18:  next     L15
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
  0136  L19:  push     0
  013b        str      r0
  013d        push     0
  0142        str      r1
  0144        each     relocation, L24
  014a  L20:  ldr      r1
  014c        jnz      L22
  0151        ldr      r0
  0153        lda
  0154        adds
  0155        ldk      K4                           ; $2,000.00
  0158        gt
  0159        jz       L21
  015e        ldk      K4                           ; $2,000.00
  0161        ldr      r0
  0163        subs
  0164        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  0168        push     1
  016d        str      r1
  016f  L21:  ldr      r0
  0171        lda
  0172        adds
  0173        str      r0
  0175        jmp      L23
  017a  L22:  push     0
  017f        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  0183  L23:  next     L20
              ; ZZ-SECURITY-CAP-1  ZC 4-121(4)  "Security devices shall not exceed $400 per residence."
  0188  L24:  push     0
  018d        str      r0
  018f        push     0
  0194        str      r1
  0196        each     security, L29
  019c  L25:  ldr      r1
  019e        jnz      L27
  01a3        ldr      r0
  01a5        lda
  01a6        adds
  01a7        ldk      K5                           ; $400.00
  01aa        gt
  01ab        jz       L26
  01b0        ldk      K5                           ; $400.00
  01b3        ldr      r0
  01b5        subs
  01b6        cap      expense_cap, R12             ; ZZ-SECURITY-CAP-1
  01ba        push     1
  01bf        str      r1
  01c1  L26:  ldr      r0
  01c3        lda
  01c4        adds
  01c5        str      r0
  01c7        jmp      L28
  01cc  L27:  push     0
  01d1        cap      expense_cap, R12             ; ZZ-SECURITY-CAP-1
  01d5  L28:  next     L25
              ; ZZ-PROPERTY-CAP-1  Program Guide, Evidence  "Property held as evidence may be replaced up to $500."
  01da  L29:  push     0
  01df        str      r0
  01e1        push     0
  01e6        str      r1
  01e8        each     property_replacement, L34
  01ee  L30:  ldr      r1
  01f0        jnz      L32
  01f5        ldr      r0
  01f7        lda
  01f8        adds
  01f9        ldk      K6                           ; $500.00
  01fc        gt
  01fd        jz       L31
  0202        ldk      K6                           ; $500.00
  0205        ldr      r0
  0207        subs
  0208        cap      expense_cap, R15             ; ZZ-PROPERTY-CAP-1
  020c        push     1
  0211        str      r1
  0213  L31:  ldr      r0
  0215        lda
  0216        adds
  0217        str      r0
  0219        jmp      L33
  021e  L32:  push     0
  0223        cap      expense_cap, R15             ; ZZ-PROPERTY-CAP-1
  0227  L33:  next     L30
              ; ZZ-TOTAL-1  ZC 4-120(1)  "The total award for a claim shall not exceed $25,000."
  022c  L34:  push     0
  0231        str      r0
  0233        push     0
  0238        str      r1
  023a        each     all, L39
  0240  L35:  ldr      r1
  0242        jnz      L37
  0247        ldr      r0
  0249        lda
  024a        adds
  024b        ldk      K7                           ; $25,000.00
  024e        gt
  024f        jz       L36
  0254        ldk      K7                           ; $25,000.00
  0257        ldr      r0
  0259        subs
  025a        cap      total_cap, R2                ; ZZ-TOTAL-1
  025e        push     1
  0263        str      r1
  0265  L36:  ldr      r0
  0267        lda
  0268        adds
  0269        str      r0
  026b        jmp      L38
  0270  L37:  push     0
  0275        cap      total_cap, R2                ; ZZ-TOTAL-1
  0279  L38:  next     L35
              ; ZZ-MINLOSS-1  ZC 4-132  "A claimant shall have a minimum loss of $100; this requirement..."
              ; ZZ-MINLOSS-2  ZC 4-132(2)  "Lost wages are paid only when the victim misses at least 5..."
  027e  L39:  push     0
  0283        str      r0
  0285        each     all, L41
  028b  L40:  ldr      r0
  028d        lda
  028e        adds
  028f        str      r0
  0291        next     L40
  0296  L41:  push     0
  029b        str      r5
  029d        push     0
  02a2        str      r6
  02a4        each     lost_wages, L45
  02aa  L42:  ldi      unit
  02ac        push     2                            ; week
  02b1        eq
  02b2        jz       L43
  02b7        ldr      r5
  02b9        ldi      units
  02bb        adds
  02bc        str      r5
  02be        jmp      L44
  02c3  L43:  ldi      unit
  02c5        push     5                            ; day
  02ca        eq
  02cb        jz       L44
  02d0        ldr      r6
  02d2        ldi      units
  02d4        adds
  02d5        str      r6
  02d7  L44:  next     L42
  02dc  L45:  ldr      r5
  02de        push     5
  02e3        muls
  02e4        ldr      r6
  02e6        adds
  02e7        str      r1
  02e9        push     0
  02ee        str      r2
              ; ZZ-MINLOSS-1  ZC 4-132  "A claimant shall have a minimum loss of $100; this requirement..."
  02f0        ldr      r0
  02f2        ldk      K8                           ; $100.00
  02f5        ge
  02f6        jnz      L46
  02fb        push     1
  0300        ldr      r2
  0302        max
  0303        str      r2
              ; ZZ-MINLOSS-2  ZC 4-132(2)  "Lost wages are paid only when the victim misses at least 5..."
  0305  L46:  ldr      r1
  0307        push     5
  030c        ge
  030d        jnz      L47
  0312        push     2
  0317        ldr      r2
  0319        max
  031a        str      r2
  031c  L47:  ldr      r2
  031e        check    minimum_loss, P28            ; ZZ-MINLOSS-1, ZZ-MINLOSS-2
              ; ZZ-DEADLINE-1  ZC 4-130(1)  "A claim shall be filed within 3 years after the crime."
  0322        ldx      incident_date
  0324        push     1095
  0329        adds
              ; ZZ-DEADLINE-2  ZC 4-130(2)  "A claim may be filed within 400 days after discovery of the..."
  032a        ldx      incident_date
  032c        push     400
  0331        adds
  0332        max
              ; ZZ-DEADLINE-4  ZC 4-130(4)  "A claim based on a sexual assault may be filed within 548 days..."
  0333        ldx      incident_date
  0335        push     548
  033a        adds
  033b        max
  033c        dup
  033d        setdate
  033e        ldx      as_of_date
  0340        ge
  0341        jz       L48
  0346        push     0
  034b        jmp      L49
  0350  L48:  push     1
  0355  L49:  note     deadline_from_report
  0357        check    deadline, P29                ; ZZ-DEADLINE-1, ZZ-DEADLINE-2, ZZ-DEADLINE-4
              ; ZZ-REPORT-1  ZC 4-131  "The crime shall be reported to law enforcement within 5 days..."
  035b        ldx      police_report
  035d        push     1                            ; yes
  0362        eq
  0363        jnz      L51
  0368        ldx      forensic_exam
  036a        jnz      L51
  036f        ldx      police_report
  0371        push     0                            ; no
  0376        eq
  0377        jnz      L50
  037c        push     3
  0381        jmp      L52
  0386  L50:  push     1
  038b        jmp      L52
  0390  L51:  push     0                            ; satisfied
  0395  L52:  check    reporting, P30               ; ZZ-REPORT-1
              ; ZZ-DEADLINE-3  ZC 4-130(3)  "The board may extend the filing period for good cause."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
              ; ZZ-CONDUCT-1  ZC 4-134  "The board may reduce an award for the victim's contributory..."
              ; ZZ-EMERGENCY-1  ZC 4-135  "The board may grant an emergency award of up to $500."
              ; ZZ-CRIME-1  ZC 4-102(5)  "Sexual assault is a compensable crime."
              ; ZZ-RESIDENCY-1  ZC 4-103  "A victim of a crime committed in Zedland may apply regardless of..."
              ; ZZ-SUBMIT-1  Program Guide, How to apply  "Mail the completed application to the Victim Services Board, 1..."
  0399        info     P31                          ; ZZ-DEADLINE-3, ZZ-COLLATERAL-1, ZZ-CONDUCT-1, ZZ-EMERGENCY-1, ZZ-CRIME-1, ZZ-RESIDENCY-1, ZZ-SUBMIT-1
  039c        ret


; tend law image ZZ, Zedland (fictional test jurisdiction)
; format 1.0, compiled by tendc 1.0.0
; source sha256 7470f9acb03223394b1aae38d90f622180889112a8271c429f4e22bb760d5e5b
; image sha256  3316864134688342a96f5e5b5c5031aa4138ec3ef765954e06d6db0c99ac5f75
; 30 rules, 2 sources, 25 proofs, 9 ints, 131 strings
; item program: 148 instructions, 486 bytes, max stack 2
; aggregate program: 244 instructions, 761 bytes, max stack 3, 10 loops

.rules
    R0    ZZ-EXAM-1             exam_no_bill           forensic_exam                         ZC 4-110(2)
    R1    ZZ-EXAM-2             exam_payment           forensic_exam                         ZC 4-110(3)
    R2    ZZ-TOTAL-1            total_cap              -                                     ZC 4-120(1)
    R3    ZZ-TOTAL-2            total_cap              -                                     ZC 4-120(2)
    R4    ZZ-MED-1              covered_expense        medical                               ZC 4-115(1)(a)
    R5    ZZ-COUNSEL-1          covered_expense        counseling                            ZC 4-115(1)(b)
    R6    ZZ-COUNSEL-CAP-1      expense_cap            counseling            per session     Program Guide, Counseling
    R7    ZZ-COUNSEL-CAP-2      expense_cap            counseling            per claim       ZC 4-121(1)
    R8    ZZ-WAGES-1            covered_expense        lost_wages                            ZC 4-115(1)(c)
    R9    ZZ-WAGES-CAP-1        expense_cap            lost_wages            per week        ZC 4-121(2)
    R10   ZZ-TRANSPORT-CAP-1    expense_cap            transportation        per mile        Program Guide, Travel
    R11   ZZ-RELOC-CAP-1        expense_cap            relocation            per claim       ZC 4-121(3)
    R12   ZZ-RELOC-CAP-2        expense_cap            relocation            per claim       Program Guide, Moving
    R13   ZZ-SECURITY-CAP-1     expense_cap            security              per residence   ZC 4-121(4)
    R14   ZZ-DENTAL-CAP-1       expense_cap            dental                per claim       Program Guide, Dental
    R15   ZZ-PROPERTY-1         excluded_expense       property_replacement                  ZC 4-116(1)
    R16   ZZ-PROPERTY-CAP-1     expense_cap            property_replacement  per claim       Program Guide, Evidence
    R17   ZZ-PAIN-1             excluded_expense       -                                     ZC 4-116(2)
    R18   ZZ-DEADLINE-1         filing_deadline        -                                     ZC 4-130(1)
    R19   ZZ-DEADLINE-2         filing_deadline        -                                     ZC 4-130(2)
    R20   ZZ-DEADLINE-3         filing_deadline        -                                     ZC 4-130(3)
    R21   ZZ-REPORT-1           reporting_requirement  -                                     ZC 4-131
    R22   ZZ-MINLOSS-1          minimum_loss           -                                     ZC 4-132
    R23   ZZ-COLLATERAL-1       collateral_source      -                                     ZC 4-133
    R24   ZZ-CONDUCT-1          conduct_reduction      -                                     ZC 4-134
    R25   ZZ-EMERGENCY-1        emergency_award        -                                     ZC 4-135
    R26   ZZ-CRIME-1            eligible_crime         -                                     ZC 4-102(5)
    R27   ZZ-RESIDENCY-1        residency              -                                     ZC 4-103
    R28   ZZ-RX-1               covered_expense        prescription                          ZC 4-115(1)(d)
    R29   ZZ-CHILDCARE-1        covered_expense        childcare                             Program Guide, Child care

.sources
    S0    ZZ-S1       sha256 c74225eb26f0252b  https://example.org/zedland/act
    S1    ZZ-S2       sha256 090e7d70ff29076d  https://example.org/zedland/guide

.proofs
    P0    ()
    P1    (ZZ-EXAM-1, ZZ-EXAM-2)
    P2    (ZZ-MED-1)
    P3    (ZZ-MED-1, ZZ-COLLATERAL-1)
    P4    (ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2)
    P5    (ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2, ZZ-COLLATERAL-1)
    P6    (ZZ-WAGES-1, ZZ-WAGES-CAP-1)
    P7    (ZZ-WAGES-1, ZZ-WAGES-CAP-1, ZZ-COLLATERAL-1)
    P8    (ZZ-TRANSPORT-CAP-1)
    P9    (ZZ-TRANSPORT-CAP-1, ZZ-COLLATERAL-1)
    P10   (ZZ-RELOC-CAP-1, ZZ-RELOC-CAP-2)
    P11   (ZZ-RELOC-CAP-1, ZZ-RELOC-CAP-2, ZZ-COLLATERAL-1)
    P12   (ZZ-SECURITY-CAP-1)
    P13   (ZZ-SECURITY-CAP-1, ZZ-COLLATERAL-1)
    P14   (ZZ-CHILDCARE-1)
    P15   (ZZ-CHILDCARE-1, ZZ-COLLATERAL-1)
    P16   (ZZ-PROPERTY-1)
    P17   (ZZ-RX-1)
    P18   (ZZ-RX-1, ZZ-COLLATERAL-1)
    P19   (ZZ-DENTAL-CAP-1)
    P20   (ZZ-DENTAL-CAP-1, ZZ-COLLATERAL-1)
    P21   (ZZ-MINLOSS-1)
    P22   (ZZ-DEADLINE-1, ZZ-DEADLINE-2, ZZ-DEADLINE-3)
    P23   (ZZ-REPORT-1)
    P24   (ZZ-COLLATERAL-1, ZZ-CONDUCT-1, ZZ-EMERGENCY-1, ZZ-CRIME-1, ZZ-RESIDENCY-1)

.ints
    K0    9000          ; $90.00
    K1    60000         ; $600.00
    K2    50            ; $0.50
    K3    300000        ; $3,000.00
    K4    200000        ; $2,000.00
    K5    150000        ; $1,500.00
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
  0016        switch   19, default L1
                        case medical               -> L3
                        case forensic_exam         -> L2
                        case counseling            -> L5
                        case lost_wages            -> L7
                        case transportation        -> L9
                        case relocation            -> L11
                        case temporary_housing     -> L1
                        case security              -> L13
                        case crime_scene_cleanup   -> L1
                        case childcare             -> L15
                        case property_replacement  -> L17
                        case clothing_bedding      -> L1
                        case prescription          -> L18
                        case dental                -> L20
                        case funeral               -> L1
                        case legal                 -> L1
                        case tuition               -> L1
                        case other                 -> L1
                        case unknown               -> L1
  0068  L0:   push     0
  006d        decide   out_of_window, P0            ; (none)
  0071        ret
  0072  L1:   push     0
  0077        decide   unknown_rule, P0             ; (none)
  007b        ret
              ; ZZ-EXAM-1  ZC 4-110(2)  "A health care provider shall not bill a victim for any part of a..."
              ; ZZ-EXAM-2  ZC 4-110(3)  "The Forensic Exam Fund shall pay the provider directly for the..."
  007c  L2:   push     0
  0081        decide   held, P1                     ; ZZ-EXAM-1, ZZ-EXAM-2
  0085        ret
              ; ZZ-MED-1  ZC 4-115(1)(a)  "Reasonable medical and hospital expenses are compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0086  L3:   ldi      confirmed
  0088        jnz      L4
  008d        push     0
  0092        decide   needs_confirmation, P2       ; ZZ-MED-1
  0096        ret
  0097  L4:   ldi      amount_cents
  0099        decide   eligible, P3                 ; ZZ-MED-1, ZZ-COLLATERAL-1
  009d        lda
  009e        ldi      insurance_paid_cents
  00a0        subs
  00a1        push     0
  00a6        max
  00a7        seta     collateral, R23              ; ZZ-COLLATERAL-1
  00ab        ret
              ; ZZ-COUNSEL-1  ZC 4-115(1)(b)  "Mental health counseling for the victim is compensable."
              ; ZZ-COUNSEL-CAP-1  Program Guide, Counseling  "Counseling shall be paid at no more than $90 per session."
              ; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  "Counseling payments shall not exceed $3,000 per claim."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  00ac  L5:   ldi      confirmed
  00ae        jnz      L6
  00b3        push     0
  00b8        decide   needs_confirmation, P4       ; ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2
  00bc        ret
  00bd  L6:   ldi      amount_cents
  00bf        decide   eligible, P5                 ; ZZ-COUNSEL-1, ZZ-COUNSEL-CAP-1, ZZ-COUNSEL-CAP-2, ZZ-COLLATERAL-1
  00c3        lda
  00c4        ldi      insurance_paid_cents
  00c6        subs
  00c7        push     0
  00cc        max
  00cd        seta     collateral, R23              ; ZZ-COLLATERAL-1
  00d1        ret
              ; ZZ-WAGES-1  ZC 4-115(1)(c)  "Loss of earnings resulting from the crime is compensable."
              ; ZZ-WAGES-CAP-1  ZC 4-121(2)  "Lost wages shall not exceed $600 per week."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  00d2  L7:   ldi      confirmed
  00d4        jnz      L8
  00d9        push     0
  00de        decide   needs_confirmation, P6       ; ZZ-WAGES-1, ZZ-WAGES-CAP-1
  00e2        ret
  00e3  L8:   ldi      amount_cents
  00e5        decide   eligible, P7                 ; ZZ-WAGES-1, ZZ-WAGES-CAP-1, ZZ-COLLATERAL-1
  00e9        lda
  00ea        ldi      insurance_paid_cents
  00ec        subs
  00ed        push     0
  00f2        max
  00f3        seta     collateral, R23              ; ZZ-COLLATERAL-1
  00f7        ret
              ; ZZ-TRANSPORT-CAP-1  Program Guide, Travel  "Travel to treatment is reimbursed at $0.50 per mile."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  00f8  L9:   ldi      confirmed
  00fa        jnz      L10
  00ff        push     0
  0104        decide   needs_confirmation, P8       ; ZZ-TRANSPORT-CAP-1
  0108        ret
  0109  L10:  ldi      amount_cents
  010b        decide   eligible, P9                 ; ZZ-TRANSPORT-CAP-1, ZZ-COLLATERAL-1
  010f        lda
  0110        ldi      insurance_paid_cents
  0112        subs
  0113        push     0
  0118        max
  0119        seta     collateral, R23              ; ZZ-COLLATERAL-1
  011d        ret
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
              ; ZZ-RELOC-CAP-2  Program Guide, Moving  "Relocation within the first 30 days shall not exceed $1,500."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  011e  L11:  ldi      confirmed
  0120        jnz      L12
  0125        push     0
  012a        decide   needs_confirmation, P10      ; ZZ-RELOC-CAP-1, ZZ-RELOC-CAP-2
  012e        ret
  012f  L12:  ldi      amount_cents
  0131        decide   eligible, P11                ; ZZ-RELOC-CAP-1, ZZ-RELOC-CAP-2, ZZ-COLLATERAL-1
  0135        lda
  0136        ldi      insurance_paid_cents
  0138        subs
  0139        push     0
  013e        max
  013f        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0143        ret
              ; ZZ-SECURITY-CAP-1  ZC 4-121(4)  "Security devices shall not exceed $1,000 per residence."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  0144  L13:  ldi      confirmed
  0146        jnz      L14
  014b        push     0
  0150        decide   needs_confirmation, P12      ; ZZ-SECURITY-CAP-1
  0154        ret
  0155  L14:  ldi      amount_cents
  0157        decide   eligible, P13                ; ZZ-SECURITY-CAP-1, ZZ-COLLATERAL-1
  015b        lda
  015c        ldi      insurance_paid_cents
  015e        subs
  015f        push     0
  0164        max
  0165        seta     collateral, R23              ; ZZ-COLLATERAL-1
  0169        ret
              ; ZZ-CHILDCARE-1  Program Guide, Child care  "Child care needed so the victim can attend treatment is..."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  016a  L15:  ldi      confirmed
  016c        jnz      L16
  0171        push     0
  0176        decide   needs_confirmation, P14      ; ZZ-CHILDCARE-1
  017a        ret
  017b  L16:  ldi      amount_cents
  017d        decide   eligible, P15                ; ZZ-CHILDCARE-1, ZZ-COLLATERAL-1
  0181        lda
  0182        ldi      insurance_paid_cents
  0184        subs
  0185        push     0
  018a        max
  018b        seta     collateral, R23              ; ZZ-COLLATERAL-1
  018f        ret
              ; ZZ-PROPERTY-1  ZC 4-116(1)  "Loss of or damage to personal property is not compensable."
  0190  L17:  push     0
  0195        decide   excluded, P16                ; ZZ-PROPERTY-1
  0199        ret
              ; ZZ-RX-1  ZC 4-115(1)(d)  "Prescription medication is compensable."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  019a  L18:  ldi      confirmed
  019c        jnz      L19
  01a1        push     0
  01a6        decide   needs_confirmation, P17      ; ZZ-RX-1
  01aa        ret
  01ab  L19:  ldi      amount_cents
  01ad        decide   eligible, P18                ; ZZ-RX-1, ZZ-COLLATERAL-1
  01b1        lda
  01b2        ldi      insurance_paid_cents
  01b4        subs
  01b5        push     0
  01ba        max
  01bb        seta     collateral, R23              ; ZZ-COLLATERAL-1
  01bf        ret
              ; ZZ-DENTAL-CAP-1  Program Guide, Dental  "Dental care is limited to 10 visits."
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
  01c0  L20:  ldi      confirmed
  01c2        jnz      L21
  01c7        push     0
  01cc        decide   needs_confirmation, P19      ; ZZ-DENTAL-CAP-1
  01d0        ret
  01d1  L21:  ldi      amount_cents
  01d3        decide   eligible, P20                ; ZZ-DENTAL-CAP-1, ZZ-COLLATERAL-1
  01d7        lda
  01d8        ldi      insurance_paid_cents
  01da        subs
  01db        push     0
  01e0        max
  01e1        seta     collateral, R23              ; ZZ-COLLATERAL-1
  01e5        ret

.aggregate
              ; ZZ-COUNSEL-CAP-1  Program Guide, Counseling  "Counseling shall be paid at no more than $90 per session."
  0000        each     counseling, L4
  0006  L0:   ldi      units
  0008        jz       L2
  000d        ldk      K0                           ; $90.00
  0010        ldi      units
  0012        muls
  0013        dup
  0014        lda
  0015        lt
  0016        jz       L1
  001b        cap      unit_cap, R6                 ; ZZ-COUNSEL-CAP-1
  001f        jmp      L3
  0024  L1:   pop
  0025        jmp      L3
  002a  L2:   flag     R6                           ; rate_unverified ZZ-COUNSEL-CAP-1
  002d  L3:   next     L0
              ; ZZ-WAGES-CAP-1  ZC 4-121(2)  "Lost wages shall not exceed $600 per week."
  0032  L4:   each     lost_wages, L9
  0038  L5:   ldi      units
  003a        jz       L7
  003f        ldk      K1                           ; $600.00
  0042        ldi      units
  0044        muls
  0045        dup
  0046        lda
  0047        lt
  0048        jz       L6
  004d        cap      unit_cap, R9                 ; ZZ-WAGES-CAP-1
  0051        jmp      L8
  0056  L6:   pop
  0057        jmp      L8
  005c  L7:   flag     R9                           ; rate_unverified ZZ-WAGES-CAP-1
  005f  L8:   next     L5
              ; ZZ-TRANSPORT-CAP-1  Program Guide, Travel  "Travel to treatment is reimbursed at $0.50 per mile."
  0064  L9:   each     transportation, L14
  006a  L10:  ldi      units
  006c        jz       L12
  0071        ldk      K2                           ; $0.50
  0074        ldi      units
  0076        muls
  0077        dup
  0078        lda
  0079        lt
  007a        jz       L11
  007f        cap      unit_cap, R10                ; ZZ-TRANSPORT-CAP-1
  0083        jmp      L13
  0088  L11:  pop
  0089        jmp      L13
  008e  L12:  flag     R10                          ; rate_unverified ZZ-TRANSPORT-CAP-1
  0091  L13:  next     L10
              ; ZZ-SECURITY-CAP-1  ZC 4-121(4)  "Security devices shall not exceed $1,000 per residence."
  0096  L14:  each     security, L16
  009c  L15:  flag     R13                          ; rate_unverified ZZ-SECURITY-CAP-1
  009f        next     L15
              ; ZZ-COUNSEL-CAP-2  ZC 4-121(1)  "Counseling payments shall not exceed $3,000 per claim."
  00a4  L16:  push     0
  00a9        str      r0
  00ab        push     0
  00b0        str      r1
  00b2        each     counseling, L21
  00b8  L17:  ldr      r1
  00ba        jnz      L19
  00bf        ldr      r0
  00c1        lda
  00c2        adds
  00c3        ldk      K3                           ; $3,000.00
  00c6        gt
  00c7        jz       L18
  00cc        ldk      K3                           ; $3,000.00
  00cf        ldr      r0
  00d1        subs
  00d2        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  00d6        push     1
  00db        str      r1
  00dd  L18:  ldr      r0
  00df        lda
  00e0        adds
  00e1        str      r0
  00e3        jmp      L20
  00e8  L19:  push     0
  00ed        cap      expense_cap, R7              ; ZZ-COUNSEL-CAP-2
  00f1  L20:  next     L17
              ; ZZ-RELOC-CAP-1  ZC 4-121(3)  "Relocation expenses shall not exceed $2,000."
  00f6  L21:  push     0
  00fb        str      r0
  00fd        push     0
  0102        str      r1
  0104        each     relocation, L26
  010a  L22:  ldr      r1
  010c        jnz      L24
  0111        ldr      r0
  0113        lda
  0114        adds
  0115        ldk      K4                           ; $2,000.00
  0118        gt
  0119        jz       L23
  011e        ldk      K4                           ; $2,000.00
  0121        ldr      r0
  0123        subs
  0124        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  0128        push     1
  012d        str      r1
  012f  L23:  ldr      r0
  0131        lda
  0132        adds
  0133        str      r0
  0135        jmp      L25
  013a  L24:  push     0
  013f        cap      expense_cap, R11             ; ZZ-RELOC-CAP-1
  0143  L25:  next     L22
              ; ZZ-RELOC-CAP-2  Program Guide, Moving  "Relocation within the first 30 days shall not exceed $1,500."
  0148  L26:  push     0
  014d        str      r0
  014f        push     0
  0154        str      r1
  0156        each     relocation, L31
  015c  L27:  ldr      r1
  015e        jnz      L29
  0163        ldr      r0
  0165        lda
  0166        adds
  0167        ldk      K5                           ; $1,500.00
  016a        gt
  016b        jz       L28
  0170        ldk      K5                           ; $1,500.00
  0173        ldr      r0
  0175        subs
  0176        cap      expense_cap, R12             ; ZZ-RELOC-CAP-2
  017a        push     1
  017f        str      r1
  0181  L28:  ldr      r0
  0183        lda
  0184        adds
  0185        str      r0
  0187        jmp      L30
  018c  L29:  push     0
  0191        cap      expense_cap, R12             ; ZZ-RELOC-CAP-2
  0195  L30:  next     L27
              ; ZZ-PROPERTY-CAP-1  Program Guide, Evidence  "Property held as evidence may be replaced up to $500."
  019a  L31:  push     0
  019f        str      r0
  01a1        push     0
  01a6        str      r1
  01a8        each     property_replacement, L36
  01ae  L32:  ldr      r1
  01b0        jnz      L34
  01b5        ldr      r0
  01b7        lda
  01b8        adds
  01b9        ldk      K6                           ; $500.00
  01bc        gt
  01bd        jz       L33
  01c2        ldk      K6                           ; $500.00
  01c5        ldr      r0
  01c7        subs
  01c8        cap      expense_cap, R16             ; ZZ-PROPERTY-CAP-1
  01cc        push     1
  01d1        str      r1
  01d3  L33:  ldr      r0
  01d5        lda
  01d6        adds
  01d7        str      r0
  01d9        jmp      L35
  01de  L34:  push     0
  01e3        cap      expense_cap, R16             ; ZZ-PROPERTY-CAP-1
  01e7  L35:  next     L32
              ; ZZ-TOTAL-1  ZC 4-120(1)  "The total award for a claim shall not exceed $25,000."
  01ec  L36:  push     0
  01f1        str      r0
  01f3        push     0
  01f8        str      r1
  01fa        each     all, L41
  0200  L37:  ldr      r1
  0202        jnz      L39
  0207        ldr      r0
  0209        lda
  020a        adds
  020b        ldk      K7                           ; $25,000.00
  020e        gt
  020f        jz       L38
  0214        ldk      K7                           ; $25,000.00
  0217        ldr      r0
  0219        subs
  021a        cap      total_cap, R2                ; ZZ-TOTAL-1
  021e        push     1
  0223        str      r1
  0225  L38:  ldr      r0
  0227        lda
  0228        adds
  0229        str      r0
  022b        jmp      L40
  0230  L39:  push     0
  0235        cap      total_cap, R2                ; ZZ-TOTAL-1
  0239  L40:  next     L37
  023e  L41:  push     0
  0243        str      r0
  0245        each     all, L43
  024b  L42:  ldr      r0
  024d        lda
  024e        adds
  024f        str      r0
  0251        next     L42
  0256  L43:  push     0
  025b        str      r2
              ; ZZ-MINLOSS-1  ZC 4-132  "A claimant shall have a minimum loss of $100, except a victim of..."
  025d        ldr      r0
  025f        ldk      K8                           ; $100.00
  0262        lt
  0263        jz       L46
  0268        ldx      forensic_exam
  026a        jz       L44
  026f        push     1
  0274        jmp      L45
  0279  L44:  push     2
  027e  L45:  ldr      r2
  0280        max
  0281        str      r2
  0283  L46:  ldr      r2
  0285        check    minimum_loss, P21            ; ZZ-MINLOSS-1
              ; ZZ-DEADLINE-1  ZC 4-130(1)  "A claim shall be filed within 3 years after the crime."
  0289        ldx      incident_date
  028b        push     3
  0290        addy
              ; ZZ-DEADLINE-2  ZC 4-130(2)  "A claim may be filed within 400 days after discovery of the..."
  0291        ldx      incident_date
  0293        push     400
  0298        adds
  0299        max
              ; ZZ-DEADLINE-3  ZC 4-130(3)  "The board may extend the filing period for good cause."
  029a        dup
  029b        setdate
  029c        ldx      as_of_date
  029e        ge
  029f        jz       L47
  02a4        push     0
  02a9        jmp      L48
  02ae  L47:  push     1                            ; late
  02b3  L48:  check    deadline, P22                ; ZZ-DEADLINE-1, ZZ-DEADLINE-2, ZZ-DEADLINE-3
              ; ZZ-REPORT-1  ZC 4-131  "The crime shall be reported to law enforcement within 5 days..."
  02b7        ldx      police_report
  02b9        push     1                            ; yes
  02be        eq
  02bf        jnz      L50
  02c4        ldx      forensic_exam
  02c6        jnz      L50
  02cb        ldx      police_report
  02cd        push     0                            ; no
  02d2        eq
  02d3        jnz      L49
  02d8        push     2
  02dd        jmp      L51
  02e2  L49:  push     1
  02e7        jmp      L51
  02ec  L50:  push     0                            ; satisfied
  02f1  L51:  check    reporting, P23               ; ZZ-REPORT-1
              ; ZZ-COLLATERAL-1  ZC 4-133  "An award shall be reduced by any amount paid by insurance or..."
              ; ZZ-CONDUCT-1  ZC 4-134  "The board may reduce an award for the victim's contributory..."
              ; ZZ-EMERGENCY-1  ZC 4-135  "The board may grant an emergency award of up to $500."
              ; ZZ-CRIME-1  ZC 4-102(5)  "Sexual assault is a compensable crime."
              ; ZZ-RESIDENCY-1  ZC 4-103  "A victim of a crime committed in Zedland may apply regardless of..."
  02f5        info     P24                          ; ZZ-COLLATERAL-1, ZZ-CONDUCT-1, ZZ-EMERGENCY-1, ZZ-CRIME-1, ZZ-RESIDENCY-1
  02f8        ret


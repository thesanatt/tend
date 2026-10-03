"""SPEC steps 7 and 8: typed per-unit caps, count limits, per-claim caps, and the total cap."""

from claims import cap, item, law, line, rule, run, trace, zz

MAX_SAFE = 2**53 - 1


# 7a. Typed units

def test_a_unit_cap_applies_only_to_its_unit():
    out = run(item("s", "counseling", 30_000, units=3, unit="session"),
              item("h", "counseling", 10_000, units=2, unit="hour", date="2026-07-02"),
              item("n", "counseling", 10_000, date="2026-07-03"))
    s, h, n = line(out, "s"), line(out, "h"), line(out, "n")
    assert (s["allowed_cents"], s["cap_rule_id"], s["flags"]) == (24_000, "ZZ-CAP-3", ["rate_unverified:ZZ-CAP-11"])
    assert (h["allowed_cents"], h["cap_rule_id"], h["flags"]) == (3_000, "ZZ-CAP-11", ["rate_unverified:ZZ-CAP-3"])
    assert (n["allowed_cents"], n["cap_rule_id"]) == (10_000, None)
    assert n["flags"] == ["rate_unverified:ZZ-CAP-3", "rate_unverified:ZZ-CAP-11"]
    assert trace(out, "s") == [("eligible", "ZZ-CAP-3", 30_000), ("unit_cap", "ZZ-CAP-3", -6_000),
                               ("rate_unverified", "ZZ-CAP-11", 0)]


def test_units_without_a_unit_or_a_unit_without_units_are_not_measured():
    out = run(item("a", "lost_wages", 100_000, units=3), item("b", "lost_wages", 100_000, units=0, unit="week"),
              item("c", "lost_wages", 100_000, units=3, unit="week"))
    assert line(out, "a")["flags"] == ["rate_unverified:ZZ-CAP-5"]
    assert line(out, "b")["flags"] == ["rate_unverified:ZZ-CAP-5"]
    assert (line(out, "a")["allowed_cents"], line(out, "b")["allowed_cents"]) == (100_000, 100_000)
    assert (line(out, "c")["allowed_cents"], line(out, "c")["flags"]) == (100_000, [])  # 3 x $400 = $1,200 > $1,000


def test_rate_times_units_only_lowers():
    out = run(item("a", "transportation", 4_000, units=60, unit="mile"),
              item("b", "transportation", 1_000, units=60, unit="mile", date="2026-07-02"))
    assert (line(out, "a")["allowed_cents"], line(out, "a")["cap_rule_id"]) == (3_000, "ZZ-CAP-8")
    assert (line(out, "b")["allowed_cents"], line(out, "b")["cap_rule_id"]) == (1_000, None)
    assert trace(out, "b") == [("eligible", "ZZ-CAP-8", 1_000)]  # the first proof rule, in rule order


def test_a_count_limit_pays_units_only_until_it_runs_out():
    ir = law([cap("T-S", "counseling", 9_000, "session", count_limit=3)])
    out = run(item("a", "counseling", 15_000, units=1, unit="session", date="2026-06-20"),
              item("none", "counseling", 15_000, date="2026-06-21"),
              item("hours", "counseling", 15_000, units=5, unit="hour", date="2026-06-21"),
              item("b", "counseling", 30_000, units=4, unit="session", date="2026-06-22"),
              item("c", "counseling", 9_000, units=1, unit="session", date="2026-06-23"), rules=ir)
    assert line(out, "a")["allowed_cents"] == 9_000
    assert line(out, "none")["flags"] == ["rate_unverified:T-S"]
    assert (line(out, "hours")["allowed_cents"], line(out, "hours")["flags"]) == (15_000, ["rate_unverified:T-S"])
    assert line(out, "b")["allowed_cents"] == 18_000  # 2 of its 4 sessions are left
    assert (line(out, "c")["allowed_cents"], line(out, "c")["cap_rule_id"]) == (0, "T-S")


def test_a_zero_count_limit_pays_nothing_it_can_measure():
    ir = law([cap("T-S", "counseling", 9_000, "session", count_limit=0)])
    out = run(item("a", "counseling", 15_000, units=1, unit="session"), item("b", "counseling", 15_000), rules=ir)
    assert (line(out, "a")["allowed_cents"], line(out, "a")["cap_rule_id"]) == (0, "T-S")
    assert line(out, "b")["allowed_cents"] == 15_000


def test_a_count_limit_on_a_per_claim_cap_is_ignored():
    ir = law([cap("T-R", "relocation", 100_000, count_limit=1)])
    out = run(item("a", "relocation", 60_000), item("b", "relocation", 30_000, date="2026-07-02"), rules=ir)
    assert [line(out, x)["allowed_cents"] for x in "ab"] == [60_000, 30_000]


def test_saturated_rate_times_units_does_not_bind():
    ir = law([cap("T-S", "medical", 10**15, "session")])
    out = run(item("a", amount=MAX_SAFE, units=MAX_SAFE, unit="session"), item("b", amount=MAX_SAFE, units=1, unit="session"),
              rules=ir)
    assert line(out, "a")["allowed_cents"] == MAX_SAFE
    assert line(out, "b")["allowed_cents"] == 10**15


# 7b. Per-claim caps

def test_crossing_line_is_cut_and_later_lines_zeroed():
    out = run(item("a", "relocation", 120_000, date="2026-06-20"), item("b", "relocation", 90_000, date="2026-06-21"),
              item("c", "relocation", 10_000, date="2026-06-22"))
    assert [line(out, x)["allowed_cents"] for x in "abc"] == [120_000, 80_000, 0]
    assert [line(out, x)["cap_rule_id"] for x in "abc"] == [None, "ZZ-CAP-6", "ZZ-CAP-6"]
    assert trace(out, "c")[-1] == ("expense_cap", "ZZ-CAP-6", -10_000)


def test_lines_after_the_crossing_get_the_cap_even_at_zero():
    ir = law([cap("T-R", "relocation", 100), rule("T-C", "collateral")])
    out = run(item("z0", "relocation", 50, insurance=50, date="2026-06-20"), item("a", "relocation", 100, date="2026-06-21"),
              item("b", "relocation", 30, date="2026-06-22"), item("z1", "relocation", 10, insurance=10, date="2026-06-23"),
              rules=ir)
    assert line(out, "z0")["cap_rule_id"] is None
    assert (line(out, "a")["allowed_cents"], line(out, "a")["cap_rule_id"]) == (100, None)  # exact fill
    assert (line(out, "b")["allowed_cents"], line(out, "b")["cap_rule_id"]) == (0, "T-R")
    assert (line(out, "z1")["allowed_cents"], line(out, "z1")["cap_rule_id"]) == (0, "T-R")
    assert trace(out, "z1")[-1] == ("expense_cap", "T-R", 0)


def test_unit_caps_run_before_claim_caps():
    ir = law([cap("T-CLAIM", "counseling", 10_000), cap("T-S", "counseling", 5_000, "session")])
    out = run(*(item(x, "counseling", 8_000, units=1, unit="session", date=f"2026-06-2{i}") for i, x in enumerate("abc")),
              rules=ir)
    assert [line(out, x)["allowed_cents"] for x in "abc"] == [5_000, 5_000, 0]
    assert line(out, "c")["cap_rule_id"] == "T-CLAIM"


def test_caps_only_see_eligible_lines():
    ir = law([cap("T-R", "relocation", 100)])
    out = run(item("pending", "relocation", 90, confirmed=False), item("old", "relocation", 90, date="2026-01-01"),
              item("ok", "relocation", 90, date="2026-06-21"), rules=ir)
    assert (line(out, "ok")["allowed_cents"], line(out, "ok")["cap_rule_id"]) == (90, None)


# 8. Total cap

def test_the_smallest_total_cap_walks_every_eligible_line():
    out = run(item("m1", amount=1_500_000, date="2026-06-20"), item("c1", "counseling", 250_000, date="2026-06-21"),
              item("m2", amount=900_000, date="2026-06-22"), item("m3", amount=5_000, date="2026-06-23"))
    assert [line(out, x)["allowed_cents"] for x in ("m1", "c1", "m2", "m3")] == [1_500_000, 250_000, 750_000, 0]
    assert [line(out, x)["cap_rule_id"] for x in ("m2", "m3")] == ["ZZ-CAP-1", "ZZ-CAP-1"]
    assert out["totals"]["allowed_cents"] == 2_500_000
    assert out["totals"]["requested_cents"] == 2_655_000


def test_total_cap_ties_keep_the_first():
    ir = law([rule("T-MED", "covered", expense="medical"), rule("T-T1", "total_cap", cap_cents=100),
              rule("T-T2", "total_cap", cap_cents=100)])
    assert line(run(item("a", amount=500), rules=ir), "a")["cap_rule_id"] == "T-T1"


def test_trace_deltas_add_up_to_the_total():
    out = run(item("a", "relocation", 150_000, date="2026-06-20"), item("b", "relocation", 90_000, date="2026-06-21"),
              item("c", "counseling", 30_000, units=3, unit="session"), item("d", amount=2_400_000, insurance=100))
    assert sum(t["delta_cents"] for t in out["trace"]) == out["totals"]["allowed_cents"]


def test_by_expense_sums_eligible_lines_in_key_order():
    out = run(item("r", "relocation", 1_000), item("c", "counseling", 500), item("m", amount=0), item("x", "funeral", 9))
    assert out["totals"]["by_expense"] == {"counseling": 500, "medical": 0, "relocation": 1_000}
    assert list(out["totals"]["by_expense"]) == sorted(out["totals"]["by_expense"])


def test_totals_saturate_at_int64_like_the_vm():
    ir = law([rule("T-MED", "covered", expense="medical")])
    items = [item(f"m{i:04d}", amount=MAX_SAFE) for i in range(1100)]
    out = run(*items, rules=ir)
    assert out["totals"]["allowed_cents"] == 2**63 - 1
    assert out["totals"]["by_expense"]["medical"] == 2**63 - 1


def test_zz_fixture_caps_are_what_the_tests_assume():
    caps = {r["id"]: r for r in zz()["rules"] if r["kind"] in ("expense_cap", "total_cap")}
    assert caps["ZZ-CAP-3"]["unit"] == "session" and caps["ZZ-CAP-11"]["unit"] == "hour"
    assert caps["ZZ-CAP-1"]["cap_cents"] == 2_500_000

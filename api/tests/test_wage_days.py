"""Lost pay is estimated in workdays (SPEC v1.2 days_lost), never as the whole pay period.

The device (web/lib/local/paydip.ts) rounds the same way; web/tests/local/fixtures/classify-parity.json
checks both on the seed personas.
"""
import pytest

from tend_api.classify import estimated_days, gap_classification, wage_gaps


@pytest.mark.parametrize("gap, usual, period, days", [
    (176_00, 412_00, 10, 4),  # Rowan: $176 short of a biweekly $412 is about 4 of 10 workdays
    (412_00, 412_00, 10, 10),  # nothing paid: the whole period
    (500_00, 412_00, 10, 10),  # never more than the period
    (20_60, 412_00, 5, 0),  # 0.25 of a day rounds down
    (41_20, 412_00, 5, 1),  # half a day rounds up, the same way in Python and TypeScript
    (123_60, 412_00, 5, 2),  # 1.5 days rounds up
    (0, 412_00, 10, 0),
    (176_00, 0, 10, 0),
])
def test_estimated_days(gap, usual, period, days):
    assert estimated_days(gap, usual, period) == days


def test_a_short_check_counts_days_not_weeks():
    pay = [412_00, 398_00, 419_00, 412_00, 236_00, 404_00]
    days = ["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12", "2026-06-26", "2026-07-10"]
    deposits = [(f"d{i}", d, cents, "Fernway Books payroll") for i, (d, cents) in enumerate(zip(days, pay, strict=True))]
    gaps = wage_gaps(deposits, "2026-06-14")
    assert list(gaps) == ["d4"]
    gap = gaps["d4"]
    assert (gap.gap_cents, gap.usual_cents, gap.period_days, gap.days) == (176_00, 412_00, 10, 4)
    label = gap_classification(gap)
    assert (label.expense, label.unit, label.units, label.confirmed, label.method) == ("lost_wages", "day", 4, False, "inference")
    assert label.reason == "Paycheck was $236, $176 below your usual $412, about 4 workdays. This is an estimate"
    assert len(label.reason.split()) <= 20


def test_weekly_pay_has_five_workdays():
    days = ["2026-05-22", "2026-05-29", "2026-06-05", "2026-06-12", "2026-06-19"]
    pay = [600_00, 600_00, 600_00, 600_00, 360_00]
    deposits = [(f"w{i}", d, cents, "Acme payroll") for i, (d, cents) in enumerate(zip(days, pay, strict=True))]
    gap = wage_gaps(deposits, "2026-06-14")["w4"]
    assert (gap.period_days, gap.days) == (5, 2)  # $240 of $600 is 2 of 5 workdays

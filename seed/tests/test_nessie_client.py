import httpx
import pytest

from fake_nessie import FakeNessie
from tend_api.nessie import (Address, BankSnapshot, NessieClient, NessieError, NessieListCorrupt, NessieNotFound,
                             NessieRejected, NessieUnavailable, cents_to_dollars, computed_balance_cents,
                             number_to_cents)

HOME = Address("1", "Test St", "Ann Arbor", "MI", "48104")


def make_world(client):
    customer = client.create_customer("Test", "Person", HOME)
    checking = client.create_account(customer.id, "Checking", "Checking", 2_400_00)
    savings = client.create_account(customer.id, "Savings", "Cushion", 0)
    merchant = client.create_merchant("Test Market", "groceries", HOME, 42.0, -83.0)
    return customer, checking, savings, merchant


def test_key_goes_in_the_query_string():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, json=[])

    with NessieClient("secret-key", "https://nessie.test", transport=httpx.MockTransport(handler)) as c:
        c.list_customers()
    assert seen[0].params["key"] == "secret-key"
    assert "authorization" not in seen[0].path.lower()


def test_empty_key_is_refused():
    with pytest.raises(ValueError):
        NessieClient("")


def test_create_unwraps_object_created(client, fake):
    customer, checking, _, merchant = make_world(client)
    assert customer.id in fake.customers
    assert checking.opening_balance_cents == 2_400_00
    assert merchant.lat == 42.0
    purchase = client.create_purchase(checking.id, merchant_id=merchant.id, amount_cents=12_00, date="2026-03-05",
                                      description="probe")
    assert purchase.id and purchase.account_id == checking.id and purchase.amount_cents == 12_00


def test_bare_string_create_recovers_the_id_by_listing():
    fake = FakeNessie(bare_string_creates=True)
    with NessieClient("test-key", "https://nessie.test", transport=fake.transport()) as client:
        customer, checking, _, merchant = make_world(client)
        deposit = client.create_deposit(checking.id, amount_cents=412_00, date="2026-04-03", description="payroll")
    assert deposit.id in fake.records["deposit"]
    assert customer.id in fake.customers


def test_single_object_paths_are_the_inconsistent_ones(client, fake):
    _, checking, savings, merchant = make_world(client)
    p = client.create_purchase(checking.id, merchant_id=merchant.id, amount_cents=5_00, date="2026-05-01",
                               description="x")
    d = client.create_deposit(checking.id, amount_cents=5_00, date="2026-05-01", description="x")
    w = client.create_withdrawal(checking.id, amount_cents=5_00, date="2026-05-01", description="x")
    t = client.create_transfer(checking.id, payee_account_id=savings.id, amount_cents=5_00, date="2026-05-01",
                               description="x")
    for kind, txn in (("purchase", p), ("deposit", d), ("withdrawal", w), ("transfer", t)):
        assert client.get_txn(kind, txn.id, checking.id).id == txn.id
    paths = [path for method, path, _ in fake.requests if method == "GET"]
    assert f"/purchase/{p.id}" in paths and f"/deposits/{d.id}" in paths
    assert f"/withdrawal/{w.id}" in paths and f"/transfers/{t.id}" in paths


def test_unknown_route_explains_the_403(client):
    with pytest.raises(NessieError, match="singular vs plural"):
        client._request("GET", "/purchases/abc")


def test_transfer_payee_rides_in_the_description(client, fake):
    _, checking, savings, _ = make_world(client)
    t = client.create_transfer(checking.id, payee_account_id=savings.id, amount_cents=50_00, date="2026-09-01",
                               description="To Cushion")
    sent = [b for m, p, b in fake.requests if m == "POST" and p.endswith("/transfers")][0]
    assert "medium" not in sent and "payee_id" not in sent
    assert sent["description"] == f"To Cushion [payee:{savings.id}]"
    listed = client.list_txns(checking.id, "transfer")[0]  # list rows key the id as "id"
    assert listed.id == t.id and listed.payee_account_id == savings.id
    assert listed.display_description == "To Cushion"


def test_fake_rejects_payee_fields_like_the_real_api(fake):
    resp = fake.handle(httpx.Request("POST", "https://nessie.test/accounts/a/transfers?key=test-key",
                                     json={"medium": "balance", "payee_id": "b", "transaction_date": "2026-09-01",
                                           "status": "completed", "amount": 5, "description": "x"}))
    assert resp.status_code == 400 and "extra fields not permitted" in resp.text


def test_empty_transfer_list_404_reads_as_empty(client):
    _, checking, _, _ = make_world(client)
    assert client.list_txns(checking.id, "transfer") == []


def test_missing_account_is_not_found(client):
    with pytest.raises(NessieNotFound):
        client.get_account("00000000-0000-0000-0000-000000000000")


@pytest.mark.parametrize("cents", [11_20, 0, -5_00, 1])
def test_amounts_that_nessie_would_truncate_are_refused(cents):
    with pytest.raises(ValueError):
        cents_to_dollars(cents)


@pytest.mark.parametrize("value", [11.2, "12", True, None])
def test_amount_types_are_checked(value):
    with pytest.raises((TypeError, ValueError)):
        cents_to_dollars(value)


def test_reading_amounts_into_cents():
    assert number_to_cents(412) == 412_00
    assert number_to_cents(443.0) == 443_00
    assert number_to_cents(44.5) == 44_50
    with pytest.raises(ValueError):
        number_to_cents(0.001)


def test_bills_keep_cents(client):
    _, checking, _, _ = make_world(client)
    bill = client.create_bill(checking.id, payee="Clinic", nickname="visit", amount_cents=44_50,
                              payment_date="2026-10-20", recurring_date=20)
    assert bill.amount_cents == 44_50
    assert bill.upcoming_payment_date == "2026-10-20"


def test_writes_validate_before_sending(client, fake):
    _, checking, _, merchant = make_world(client)
    before = len(fake.requests)
    with pytest.raises(ValueError):
        client.create_purchase(checking.id, merchant_id=merchant.id, amount_cents=5_00, date="not-a-date",
                               description="x")
    with pytest.raises(ValueError):
        client.create_deposit(checking.id, amount_cents=5_00, date="2026-W24-7", description="x")
    with pytest.raises(ValueError):
        client.create_purchase(checking.id, merchant_id="", amount_cents=5_00, date="2026-05-01", description="x")
    with pytest.raises(ValueError):
        client.create_deposit(checking.id, amount_cents=5_00, date="2026-05-01", description="x", status="done")
    with pytest.raises(ValueError):
        client.create_bill(checking.id, payee="x", nickname="y", amount_cents=5_00, payment_date="2026-05-01",
                           recurring_date=0)
    with pytest.raises(ValueError):
        client.update_purchase("abc", status="completed")
    assert len(fake.requests) == before  # nothing reached Nessie


def test_incomplete_record_poisons_the_list(client, fake):
    _, checking, _, merchant = make_world(client)
    fake.records["purchase"]["bad"] = (checking.id, {"_id": "bad", "merchant_id": merchant.id, "amount": 7})
    with pytest.raises(NessieListCorrupt):
        client.list_txns(checking.id, "purchase")
    client.delete_txn("purchase", "bad")
    assert client.list_txns(checking.id, "purchase") == []


def test_validation_errors_are_rejections(client):
    with pytest.raises(NessieRejected):
        client._request("POST", "/accounts/x/purchases", {"amount": 7})


def test_get_retries_once_on_5xx(client, fake):
    fake.fail_next = [502]
    assert client.list_customers() == []
    assert fake.count("GET", r"^/customers$") == 2


def test_get_gives_up_after_one_retry(client, fake):
    fake.fail_next = [502, 503]
    with pytest.raises(NessieUnavailable) as err:
        client.list_customers()
    assert not err.value.maybe_applied


def test_writes_are_never_retried(client, fake):
    _, checking, _, _ = make_world(client)
    fake.fail_next = [502]
    with pytest.raises(NessieUnavailable) as err:
        client.create_withdrawal(checking.id, amount_cents=118_00, date="2026-10-03", description="pay [tend:abc]")
    assert err.value.maybe_applied
    assert fake.count("POST", r"/withdrawals$") == 1


def test_timeouts_retry_reads_and_flag_writes():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1 or request.method == "POST":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json=[])

    with NessieClient("k", "https://nessie.test", transport=httpx.MockTransport(handler)) as c:
        assert c.list_merchants() == []
        with pytest.raises(NessieUnavailable) as err:
            c.create_deposit("a", amount_cents=1_00, date="2026-10-03", description="x")
    assert calls == ["GET", "GET", "POST"]
    assert err.value.maybe_applied


def test_connect_errors_are_not_maybe_applied():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with NessieClient("k", "https://nessie.test", transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(NessieUnavailable) as err:
            c.create_deposit("a", amount_cents=1_00, date="2026-10-03", description="x")
    assert not err.value.maybe_applied


def test_delete_answers_200_even_when_missing(client):
    client.delete_txn("withdrawal", "never-existed")
    client.delete_bill("never-existed")


def test_find_txns_by_marker(client):
    _, checking, _, _ = make_world(client)
    client.create_withdrawal(checking.id, amount_cents=118_00, date="2026-10-03", description="Riverbend [tend:n1]")
    client.create_withdrawal(checking.id, amount_cents=40_00, date="2026-10-03", description="ATM")
    found = client.find_txns(checking.id, "withdrawal", "[tend:n1]")
    assert [t.amount_cents for t in found] == [118_00]
    assert found[0].display_description == "Riverbend"


def test_balance_is_computed_because_nessie_never_moves_it(client):
    customer, checking, savings, merchant = make_world(client)
    client.create_deposit(checking.id, amount_cents=412_00, date="2026-04-03", description="payroll")
    client.create_purchase(checking.id, merchant_id=merchant.id, amount_cents=12_00, date="2026-04-04", description="x")
    client.create_withdrawal(checking.id, amount_cents=40_00, date="2026-04-05", description="ATM")
    client.create_transfer(checking.id, payee_account_id=savings.id, amount_cents=50_00, date="2026-04-06",
                           description="Save")
    client.create_deposit(checking.id, amount_cents=99_00, date="2026-04-07", description="void", status="cancelled")
    assert client.get_account(checking.id).opening_balance_cents == 2_400_00
    snap = client.snapshot(customer.id)
    assert snap.balance_cents(checking.id) == 2_400_00 + 412_00 - 12_00 - 40_00 - 50_00
    assert snap.balance_cents(savings.id) == 50_00
    assert snap.balance_cents(checking.id, as_of="2026-04-04") == 2_400_00 + 412_00 - 12_00
    assert computed_balance_cents(checking, []) == 2_400_00


def test_snapshot_round_trips(client, tmp_path):
    customer, checking, _, merchant = make_world(client)
    client.create_purchase(checking.id, merchant_id=merchant.id, amount_cents=12_00, date="2026-04-04", description="x")
    client.create_bill(checking.id, payee="Clinic", nickname="visit", amount_cents=443_00, payment_date="2026-10-20",
                       recurring_date=20)
    snap = client.snapshot(customer.id, {"fictional": True})
    assert [m.name for m in snap.merchants] == ["Test Market"]
    path = tmp_path / "snap.json"
    snap.save(path)
    loaded = BankSnapshot.load(path)
    assert loaded == snap
    assert loaded.to_dict()["balances"][checking.id]["computed_cents"] == 2_400_00 - 12_00


def test_account_delete_leaves_children(client, fake):
    _, checking, _, _ = make_world(client)
    client.create_deposit(checking.id, amount_cents=5_00, date="2026-05-01", description="x")
    client.delete_account(checking.id)
    assert len(client.list_txns(checking.id, "deposit")) == 1


def test_bill_update_restores_fields(client):
    _, checking, _, _ = make_world(client)
    bill = client.create_bill(checking.id, payee="Clinic", nickname="visit", amount_cents=443_00,
                              payment_date="2026-10-20", recurring_date=20)
    paid = client.update_bill(bill.id, status="completed", amount_cents=325_00)
    assert (paid.status, paid.amount_cents) == ("completed", 325_00)
    back = client.update_bill(bill.id, status="pending", amount_cents=443_00)
    assert (back.status, back.amount_cents) == ("pending", 443_00)
    with pytest.raises(ValueError):
        client.update_bill(bill.id)

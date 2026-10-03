import pytest

from fake_nessie import FakeNessie
from tend_api.nessie import NessieClient


@pytest.fixture
def fake() -> FakeNessie:
    return FakeNessie()


@pytest.fixture
def client(fake: FakeNessie) -> NessieClient:
    with NessieClient("test-key", "https://nessie.test", transport=fake.transport()) as c:
        yield c

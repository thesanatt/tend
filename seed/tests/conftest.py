import httpx
import pytest

from fake_nessie import FakeNessie
from tend_api.nessie import NessieClient


@pytest.fixture(autouse=True)
def offline(request, monkeypatch):
    """Unit tests never reach Nessie or Gemini, even with keys exported in the shell."""
    if request.node.get_closest_marker("live"):
        return
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "NESSIE_API_KEY"):
        monkeypatch.delenv(key, raising=False)

    def refuse(self, req):
        raise AssertionError(f"a unit test tried to reach the network: {req.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)


@pytest.fixture
def fake() -> FakeNessie:
    return FakeNessie()


@pytest.fixture
def client(fake: FakeNessie) -> NessieClient:
    with NessieClient("test-key", "https://nessie.test", transport=fake.transport()) as c:
        yield c

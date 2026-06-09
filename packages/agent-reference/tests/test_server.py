"""tests/test_server.py — Integration tests for the FastAPI POST /run endpoint."""
from __future__ import annotations

from unittest.mock import patch, AsyncMock

import pytest
from httpx import AsyncClient, ASGITransport

from agent_reference.server import app

MOCK_RESPONSE_TEXT = "Mock agent response."

VALID_REQUEST = {
    "sessionKey": "v1:test:key",
    "message": "hello",
    "messageRaw": "hello",
    "isNew": False,
    "wasAutoReset": False,
    "platform": {"name": "test", "chatKind": "dm", "userId": "u1", "userName": "User", "accountId": "acc"},
    "media": [],
    "toolPolicy": {"allowedTools": [], "disabledTools": []},
}


@pytest.fixture()
def mock_run_agent():
    with patch("agent_reference.server.run_agent", AsyncMock(return_value=MOCK_RESPONSE_TEXT)) as m:
        yield m


@pytest.fixture()
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


class TestRunEndpoint:
    async def test_returns_200_with_valid_request(self, client: AsyncClient, mock_run_agent):
        resp = await client.post("/run", json=VALID_REQUEST)
        assert resp.status_code == 200

    async def test_response_contains_text(self, client: AsyncClient, mock_run_agent):
        resp = await client.post("/run", json=VALID_REQUEST)
        body = resp.json()
        assert body["text"] == MOCK_RESPONSE_TEXT
        assert body["interrupted"] is False

    async def test_returns_500_when_agent_raises(self, client: AsyncClient):
        with patch("agent_reference.server.run_agent", AsyncMock(side_effect=RuntimeError("boom"))):
            resp = await client.post("/run", json=VALID_REQUEST)
        assert resp.status_code == 500

    async def test_returns_422_for_missing_required_field(self, client: AsyncClient, mock_run_agent):
        resp = await client.post("/run", json={"message": "hello"})
        assert resp.status_code == 422

    async def test_health_endpoint(self, client: AsyncClient):
        resp = await client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    async def test_run_agent_called_with_correct_args(self, client: AsyncClient, mock_run_agent):
        await client.post("/run", json={
            **VALID_REQUEST,
            "sessionKey": "v1:test:mykey",
            "message": "what time is it",
            "messageRaw": "what time is it",
            "isNew": True,
            "platform": {"name": "slack", "chatKind": "dm", "userId": "u1", "userName": "User", "accountId": "acc"},
        })
        mock_run_agent.assert_called_once_with(
            session_key="v1:test:mykey",
            message="what time is it",
            is_new=True,
            was_auto_reset=False,
        )

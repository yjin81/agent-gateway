"""adapter.py — AgentAdapter ABC and HttpAdapter using httpx."""

from __future__ import annotations

import abc
from typing import Any

import httpx

from .types import AgentRequest, AgentResponse


class AgentAdapter(abc.ABC):
    """Abstract base class for all Agent Gateway adapter implementations."""

    @abc.abstractmethod
    async def run(self, request: AgentRequest) -> AgentResponse:
        """Process one agent turn and return a response."""
        ...

    async def on_session_reset(self, session_key: str) -> None:
        """Called when wasAutoReset=True — clear per-session state."""
        pass


class HttpAdapter(AgentAdapter):
    """
    Forwards AgentRequest to an HTTP endpoint and returns AgentResponse.
    Suitable for wrapping any FastAPI / Flask / ASGI agent server.
    """

    def __init__(
        self,
        endpoint_url: str,
        get_token: Any | None = None,
        timeout: float = 300.0,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._get_token = get_token
        self._timeout = timeout

    async def run(self, request: AgentRequest) -> AgentResponse:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._get_token is not None:
            token = await self._get_token() if callable(self._get_token) else self._get_token
            headers["Authorization"] = f"Bearer {token}"

        body = request.model_dump(by_alias=True)

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(self._endpoint_url, json=body, headers=headers)
            resp.raise_for_status()
            return AgentResponse.model_validate(resp.json())

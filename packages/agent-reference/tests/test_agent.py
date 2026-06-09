"""tests/test_agent.py — Unit tests for run_agent() using a mock LLM."""
from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from langchain_core.messages import AIMessage

# Patch the OpenAI model and agent before importing run_agent
# so no real API key is needed.

MOCK_RESPONSE = "This is a mock agent response."


def make_mock_agent(response_text: str = MOCK_RESPONSE):
    """Return a mock LangGraph agent that returns a fixed AIMessage."""
    mock = AsyncMock()
    mock.ainvoke = AsyncMock(return_value={"messages": [AIMessage(content=response_text)]})
    return mock


@pytest.fixture()
def tmp_db(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path / 'test.db'}"


class TestRunAgent:
    async def test_returns_response_text(self, tmp_db: str):
        with patch("agent_reference.agent._agent", make_mock_agent()):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                result = await run_agent("key1", "hello", is_new=False, was_auto_reset=False)

        assert result == MOCK_RESPONSE

    async def test_clears_history_on_is_new(self, tmp_db: str):
        with patch("agent_reference.agent._agent", make_mock_agent()):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key2", "hello", is_new=True, was_auto_reset=False)

        history.clear.assert_called_once()

    async def test_clears_history_on_was_auto_reset(self, tmp_db: str):
        with patch("agent_reference.agent._agent", make_mock_agent()):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key3", "hello", is_new=False, was_auto_reset=True)

        history.clear.assert_called_once()

    async def test_does_not_clear_history_on_normal_turn(self):
        with patch("agent_reference.agent._agent", make_mock_agent()):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key4", "hello", is_new=False, was_auto_reset=False)

        history.clear.assert_not_called()

    async def test_injects_greeting_context_on_is_new(self):
        """System prompt should contain a greeting instruction when is_new=True."""
        captured_messages = []

        async def capture_invoke(messages_dict):
            captured_messages.extend(messages_dict["messages"])
            return {"messages": [AIMessage(content="Hello!")]}

        mock_agent = MagicMock()
        mock_agent.ainvoke = capture_invoke

        with patch("agent_reference.agent._agent", mock_agent):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key5", "hi", is_new=True, was_auto_reset=False)

        system_msg = captured_messages[0]
        assert "greet" in system_msg.content.lower() or "new conversation" in system_msg.content.lower()

    async def test_injects_reset_context_on_was_auto_reset(self):
        """System prompt should contain reset acknowledgement instruction."""
        captured_messages = []

        async def capture_invoke(messages_dict):
            captured_messages.extend(messages_dict["messages"])
            return {"messages": [AIMessage(content="Welcome back!")]}

        mock_agent = MagicMock()
        mock_agent.ainvoke = capture_invoke

        with patch("agent_reference.agent._agent", mock_agent):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key6", "hi", is_new=False, was_auto_reset=True)

        system_msg = captured_messages[0]
        assert "reset" in system_msg.content.lower() or "inactivity" in system_msg.content.lower()

    async def test_persists_turn_to_history(self):
        with patch("agent_reference.agent._agent", make_mock_agent()):
            with patch("agent_reference.agent.get_history") as mock_get_history:
                history = MagicMock()
                history.messages = []
                history.clear = MagicMock()
                history.add_user_message = MagicMock()
                history.add_ai_message = MagicMock()
                mock_get_history.return_value = history

                from agent_reference.agent import run_agent
                await run_agent("key7", "my message", is_new=False, was_auto_reset=False)

        history.add_user_message.assert_called_once_with("my message")
        history.add_ai_message.assert_called_once_with(MOCK_RESPONSE)

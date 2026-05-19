"""history.py — SQLite-backed conversation history using LangChain."""

from __future__ import annotations

from langchain_community.chat_message_histories import SQLChatMessageHistory
from langchain_core.messages import BaseMessage


def get_history(session_key: str, db_url: str = "sqlite:///./data/agent.db") -> SQLChatMessageHistory:
    """Return a SQLChatMessageHistory for the given session key."""
    return SQLChatMessageHistory(session_id=session_key, connection_string=db_url)

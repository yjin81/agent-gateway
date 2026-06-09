"""history.py — SQLite-backed conversation history using LangChain."""

from __future__ import annotations

from langchain_community.chat_message_histories import SQLChatMessageHistory

from .config import settings


def get_history(session_key: str, db_url: str | None = None) -> SQLChatMessageHistory:
    """Return a SQLChatMessageHistory for the given session key.

    Uses AGENT_DB_PATH (via settings) by default; pass db_url to override
    (used in tests to point at an in-memory or temp database).
    """
    resolved_url = db_url if db_url is not None else f"sqlite:///{settings.agent_db_path}"
    return SQLChatMessageHistory(session_id=session_key, connection_string=resolved_url)

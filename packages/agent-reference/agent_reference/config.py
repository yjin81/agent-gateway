"""config.py — Pydantic BaseSettings for the reference agent.

All configuration is read from environment variables at startup.
Invalid or missing required values raise a ValidationError immediately,
giving a clear error message before the server begins accepting requests.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    """Settings loaded from environment variables.

    AGENT_* vars control agent behaviour; OPENAI_* vars are passed through
    to LangChain so they work with the standard OpenAI SDK conventions.
    """

    model_config = SettingsConfigDict(extra="ignore")

    # OpenAI / compatible endpoint — standard SDK env var names (no prefix)
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    openai_base_url: str = Field(
        default="https://api.openai.com/v1", alias="OPENAI_BASE_URL"
    )

    # Agent behaviour — AGENT_ prefix
    agent_model: str = Field(default="gpt-4o-mini", alias="AGENT_MODEL")
    agent_system_prompt: str = Field(
        default="You are a helpful assistant.", alias="AGENT_SYSTEM_PROMPT"
    )

    # Storage — AGENT_ prefix
    agent_db_path: str = Field(default="./data/agent.db", alias="AGENT_DB_PATH")

    # Server — AGENT_ prefix
    agent_port: int = Field(default=8080, alias="AGENT_PORT")
    agent_bearer_token: str | None = Field(default=None, alias="AGENT_BEARER_TOKEN")


# Module-level singleton — evaluated once on import.
settings = AgentSettings()

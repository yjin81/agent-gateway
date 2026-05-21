"""types.py — AgentRequest, AgentResponse as Pydantic BaseModel.

Wire format is camelCase; Python attributes are snake_case.
Kept in sync with packages/gateway/src/adapter/types.ts (TODO-10).
"""

from __future__ import annotations

from typing import Any, Callable, Awaitable, Literal
from pydantic import BaseModel, ConfigDict, Field


class MediaItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["image", "audio", "video", "document", "sticker"]
    url: str | None = None
    local_path: str | None = Field(default=None, alias="localPath")
    mime_type: str | None = Field(default=None, alias="mimeType")
    file_name: str | None = Field(default=None, alias="fileName")
    duration_ms: int | None = Field(default=None, alias="durationMs")
    is_voice: bool = Field(default=False, alias="isVoice")


class Mention(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    user_id: str = Field(alias="userId")
    name: str
    is_self: bool = Field(alias="isSelf")


class PlatformContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    chat_kind: Literal["dm", "group", "channel", "thread"] = Field(alias="chatKind")
    user_id: str = Field(alias="userId")
    user_name: str = Field(alias="userName")
    account_id: str = Field(alias="accountId")
    mentions: list[Mention] = Field(default_factory=list)


class ToolPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    allowed_tools: list[str] = Field(default_factory=list, alias="allowedTools")
    disabled_tools: list[str] = Field(default_factory=list, alias="disabledTools")


class AgentRequest(BaseModel):
    """Parsed form of the JSON body POSTed to the adapter endpoint by the gateway."""

    model_config = ConfigDict(populate_by_name=True)

    session_key: str = Field(alias="sessionKey")
    message: str
    message_raw: str = Field(alias="messageRaw")
    media: list[MediaItem] = Field(default_factory=list)
    is_new: bool = Field(alias="isNew")
    was_auto_reset: bool = Field(alias="wasAutoReset")
    platform: PlatformContext
    tool_policy: ToolPolicy = Field(alias="toolPolicy")

    # abortSignal, progressCallback, approvalCallback are NOT present in the
    # wire format — they are gateway-side concerns. Adapters implement
    # cooperative cancellation by checking a flag or using asyncio.


class AgentResponse(BaseModel):
    """Response returned by the adapter to the gateway."""

    model_config = ConfigDict(populate_by_name=True)

    text: str
    media: list[MediaItem] = Field(default_factory=list)
    interrupted: bool = False

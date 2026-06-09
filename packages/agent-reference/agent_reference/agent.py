"""agent.py — LangGraph agent wired with tools and SQLite history."""

from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from .config import settings
from .tools import get_current_time, calculator
from .history import get_history


def build_agent() -> Any:
    """Build and return a compiled LangGraph ReAct agent."""
    model = ChatOpenAI(
        model=settings.agent_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )
    return create_react_agent(model, tools=[get_current_time, calculator])


# Module-level singleton — lazily created on first call.
_agent: Any = None


def _get_agent() -> Any:
    global _agent
    if _agent is None:
        _agent = build_agent()
    return _agent


async def run_agent(session_key: str, message: str, is_new: bool, was_auto_reset: bool) -> str:
    """Run one agent turn. Returns the assistant's response text."""
    history = get_history(session_key)

    if is_new or was_auto_reset:
        # Clear history so the agent starts fresh.
        history.clear()

    messages = history.messages

    # Inject a session-context note so the agent can greet or acknowledge reset.
    if is_new:
        session_note = "This is the start of a new conversation. Greet the user warmly."
    elif was_auto_reset:
        session_note = (
            "The previous conversation was reset due to inactivity. "
            "Acknowledge this briefly (e.g. 'Welcome back — starting fresh.') before answering."
        )
    else:
        session_note = None

    system_content = settings.agent_system_prompt
    if session_note:
        system_content = f"{settings.agent_system_prompt}\n\n[Session context: {session_note}]"

    # Build the input message list.
    input_messages = [SystemMessage(content=system_content), *messages, HumanMessage(content=message)]

    result = await _get_agent().ainvoke({"messages": input_messages})

    # Extract last AI message.
    ai_messages = [m for m in result["messages"] if isinstance(m, AIMessage)]
    response_text = ai_messages[-1].content if ai_messages else "I could not generate a response."

    # Persist turn to history.
    history.add_user_message(message)
    history.add_ai_message(response_text)

    return str(response_text)

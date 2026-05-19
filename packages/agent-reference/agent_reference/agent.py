"""agent.py — LangGraph agent wired with tools and SQLite history."""

from __future__ import annotations

import os
from typing import Any

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from .tools import get_current_time, calculator
from .history import get_history


SYSTEM_PROMPT = """You are a helpful assistant. You have access to tools:
- get_current_time: returns the current UTC time
- calculator: evaluates safe math expressions

Be concise and accurate. If you don't know something, say so."""


def build_agent() -> Any:
    """Build and return a compiled LangGraph ReAct agent."""
    model = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )
    return create_react_agent(model, tools=[get_current_time, calculator])


# Module-level singleton — created once on import.
_agent = build_agent()


async def run_agent(session_key: str, message: str, is_new: bool, was_auto_reset: bool) -> str:
    """Run one agent turn. Returns the assistant's response text."""
    history = get_history(session_key)

    if is_new or was_auto_reset:
        # Clear history so the agent starts fresh.
        history.clear()

    messages = history.messages

    # Build the input message list.
    input_messages = [SystemMessage(content=SYSTEM_PROMPT), *messages, HumanMessage(content=message)]

    result = await _agent.ainvoke({"messages": input_messages})

    # Extract last AI message.
    ai_messages = [m for m in result["messages"] if isinstance(m, AIMessage)]
    response_text = ai_messages[-1].content if ai_messages else "I could not generate a response."

    # Persist turn to history.
    history.add_user_message(message)
    history.add_ai_message(response_text)

    return str(response_text)

"""tools.py — Reference agent tools: get_current_time and calculator."""

from __future__ import annotations

import math
import datetime
from langchain_core.tools import tool


@tool
def get_current_time(timezone: str = "UTC") -> str:
    """Return the current date and time.

    Args:
        timezone: IANA timezone name (default: UTC). Only UTC is supported in v0.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime(f"%Y-%m-%d %H:%M:%S UTC")


@tool
def calculator(expression: str) -> str:
    """Evaluate a safe mathematical expression and return the result.

    Args:
        expression: A Python-safe math expression, e.g. "2 + 2" or "sqrt(16)".
    """
    # Restrict evaluation to a safe subset.
    allowed_names = {k: v for k, v in math.__dict__.items() if not k.startswith("_")}
    allowed_names["abs"] = abs
    allowed_names["round"] = round
    try:
        result = eval(expression, {"__builtins__": {}}, allowed_names)  # noqa: S307
        return str(result)
    except Exception as exc:
        return f"Error: {exc}"

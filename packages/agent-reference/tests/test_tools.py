"""tests/test_tools.py — Unit tests for calculator and get_current_time tools."""
from __future__ import annotations

import re
import pytest
from agent_reference.tools import calculator, get_current_time


class TestGetCurrentTime:
    def test_returns_utc_timestamp_string(self):
        result = get_current_time.invoke({"timezone": "UTC"})
        # Expected format: YYYY-MM-DD HH:MM:SS UTC
        assert re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC", result)

    def test_returns_string_type(self):
        result = get_current_time.invoke({"timezone": "UTC"})
        assert isinstance(result, str)


class TestCalculator:
    @pytest.mark.parametrize("expression,expected", [
        ("2 + 2", "4"),
        ("10 - 3", "7"),
        ("3 * 4", "12"),
        ("10 / 4", "2.5"),
        ("2 ** 8", "256"),
        ("sqrt(9)", "3.0"),
        ("abs(-5)", "5"),
        ("round(3.7)", "4"),
    ])
    def test_valid_expressions(self, expression: str, expected: str):
        result = calculator.invoke({"expression": expression})
        assert result == expected

    def test_rejects_import_attempt(self):
        result = calculator.invoke({"expression": "__import__('os').system('id')"})
        assert result.startswith("Error:")

    def test_rejects_builtins_access(self):
        result = calculator.invoke({"expression": "open('/etc/passwd')"})
        assert result.startswith("Error:")

    def test_returns_error_for_division_by_zero(self):
        result = calculator.invoke({"expression": "1 / 0"})
        assert result.startswith("Error:")

    def test_returns_error_for_invalid_expression(self):
        result = calculator.invoke({"expression": "not_a_function()"})
        assert result.startswith("Error:")

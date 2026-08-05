#!/usr/bin/env python3
"""Fail-closed secret, personal-data, and live-account data boundary for Agent Hub."""
from __future__ import annotations

import json
import re
from typing import Iterable


class SensitiveDataError(RuntimeError):
    """Raised without echoing the matched category or source text."""


SAFE_BLOCK_REASON = "privacy_boundary_blocked"

SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"\b(?:github_pat_[0-9A-Za-z_]{20,}|gh[pousr]_[0-9A-Za-z]{20,})\b"),
    re.compile(r"\bsk-[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)\bSUPABASE_(?:SERVICE_ROLE|SECRET)_KEY\s*[:=]\s*['\"]?\S{12,}"),
    re.compile(r"(?i)\b(?:service[_ -]?role|supabase[_ -]?(?:service[_ -]?role|secret))\s*[:=]\s*['\"]?\S{12,}"),
    re.compile(r"(?i)\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pwd)\b\s*[:=]\s*['\"]?[^\s,'\"]{8,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b"),
)

PII_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("EMAIL", re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")),
    ("PHONE", re.compile(r"(?<!\d)(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)")),
    ("RESIDENT_ID", re.compile(r"(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)")),
)

SENSITIVE_KEYS = (
    "account_number", "account_no", "brokerage_account", "live_account", "real_account",
    "balance", "cash_balance", "available_balance", "deposit_balance", "buying_power",
    "available_to_buy", "withdrawable_amount", "holdings", "holding_quantity", "positions",
    "position_qty", "position_size", "average_price", "avg_price", "cost_basis",
    "open_orders", "unfilled_orders", "pending_orders", "order_id", "client_order_id",
    "fills", "executions", "order_request", "order_response", "account_status",
)
SENSITIVE_KOREAN_KEYS = (
    "실계좌", "계좌번호", "잔고", "예수금", "매수가능금액", "출금가능금액", "보유종목",
    "보유수량", "포지션", "평균단가", "평단가", "미체결", "주문번호", "주문 ID",
    "주문ID", "체결내역", "주문내역", "계좌상태", "주문요청", "주문응답",
)
NON_SENSITIVE_VALUES = re.compile(r"(?i)^(?:none|null|false|true|0|unknown|unavailable|not[_ -]?available|\[\]|\{\})$")
STRUCTURED_KEY_PATTERN = re.compile(
    r"(?i)(?:[\"']?)(?P<key>" + "|".join(re.escape(key) for key in SENSITIVE_KEYS) + r")(?:[\"']?)\s*[:=]\s*(?P<value>[^,}\]\n;]+)"
)
KOREAN_VALUE_PATTERN = re.compile(
    r"(?i)(?P<key>" + "|".join(re.escape(key) for key in SENSITIVE_KOREAN_KEYS) + r")\s*[:=]?\s*(?P<value>[^,}\]\n;]{2,})"
)
ORDER_PAYLOAD_PATTERN = re.compile(
    r"(?is)(?:/orders?|place[_ -]?order|submit[_ -]?order|주문(?:요청|응답|실행)|체결(?:내역|응답)).{0,240}(?:\{|\[|symbol|ticker|side|quantity|qty|price|account|order[_ -]?id)"
)


def _has_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def _meaningful_value(value: str) -> bool:
    normalized = value.strip().strip("'\"")
    return bool(normalized) and not NON_SENSITIVE_VALUES.fullmatch(normalized)


def _has_account_or_order_data(text: str) -> bool:
    for match in STRUCTURED_KEY_PATTERN.finditer(text):
        if _meaningful_value(match.group("value")):
            return True
    for match in KOREAN_VALUE_PATTERN.finditer(text):
        if _meaningful_value(match.group("value")):
            return True
    return bool(ORDER_PAYLOAD_PATTERN.search(text))


def assert_safe_for_model(text: str) -> None:
    if _has_secret(text) or _has_account_or_order_data(text):
        raise SensitiveDataError(SAFE_BLOCK_REASON)


def redact_non_account_pii(text: str) -> tuple[str, int]:
    result = text
    count = 0
    for label, pattern in PII_PATTERNS:
        def replace(_: re.Match[str], marker: str = label) -> str:
            nonlocal count
            count += 1
            return f"[REDACTED_{marker}]"
        result = pattern.sub(replace, result)
    return result, count


def sanitize_report_for_model_strict(text: str) -> tuple[str, int]:
    assert_safe_for_model(text)
    redacted, count = redact_non_account_pii(text)
    assert_safe_for_model(redacted)
    return redacted, count


def safe_blocked_comment(*, source_report_comment_id: int | str, schema_version: int | str = 2) -> str:
    identifier = str(source_report_comment_id)
    if not identifier.isdigit():
        identifier = "unknown"
    return "\n".join(
        [
            "[HUB_ERROR]",
            f"schema_version: {schema_version}",
            f"source_report_comment_id: {identifier}",
            "status: blocked",
            "error_code: policy_boundary_blocked",
            "reason: Input was blocked by a deterministic policy boundary.",
            "model_calls: 0",
            "artifact_saved: false",
            "paid_fallback: false",
            f"<!-- agent-hub-error:{identifier} -->",
        ]
    )


def secret_patterns_for_diff() -> tuple[re.Pattern[str], ...]:
    return SECRET_PATTERNS


def self_test() -> int:
    safe, count = sanitize_report_for_model_strict("contact user@example.com or 010-1234-5678")
    assert count == 2 and "user@example.com" not in safe
    fixtures: Iterable[str] = (
        "Authorization : Bearer abcdefghijklmnopqrstuvwxyz.123456",
        "SUPABASE_SERVICE_ROLE_KEY = placeholder_service_role_value_123456",
        '"balance": 1250000',
        "예수금: 500000원",
        '"positions": [{"symbol":"BTC","qty":1}]',
        'POST /api/orders {"symbol":"AAPL","side":"buy","qty":2}',
        "주문 ID: ORDER_FIXTURE_12345",
    )
    for fixture in fixtures:
        try:
            sanitize_report_for_model_strict(fixture)
        except SensitiveDataError as exc:
            assert str(exc) == SAFE_BLOCK_REASON
        else:
            raise AssertionError("sensitive fixture was accepted")
    comment = safe_blocked_comment(source_report_comment_id=123)
    assert "1250000" not in comment and "ORDER_FIXTURE" not in comment and "model_calls: 0" in comment
    print(json.dumps({"security_boundary_v2": "pass", "model_calls_on_sensitive": 0, "paid_fallback": 0}))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())

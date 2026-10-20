"""레버리지 입력 검증과 거래소별 확인된 한도.

허용값은 정수 1~7, 기본 1. UI·CLI·API 어디서 들어오든 이 함수 하나로만 검증한다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Optional

MIN_LEVERAGE = 1
MAX_LEVERAGE = 7
DEFAULT_LEVERAGE = 1
ALLOWED_LEVERAGES = tuple(range(MIN_LEVERAGE, MAX_LEVERAGE + 1))


class LeverageError(ValueError):
    """허용되지 않은 레버리지 입력."""


def parse_leverage(raw: Any, *, default_if_missing: bool = False) -> int:
    """정수 1~7만 통과시킨다.

    거부: None(기본값 허용을 명시하지 않은 경우), bool, 0, 음수, 8 이상, 소수,
    NaN, Infinity, 숫자가 아닌 문자열, "3.0" 같은 소수 표기, 앞뒤 공백 이외 문자.
    """
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        if default_if_missing:
            return DEFAULT_LEVERAGE
        raise LeverageError("레버리지 값이 없습니다")
    if isinstance(raw, bool):
        raise LeverageError("레버리지에 참/거짓 값은 쓸 수 없습니다")
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, float):
        if not math.isfinite(raw):
            raise LeverageError("레버리지에 NaN/Infinity는 쓸 수 없습니다")
        if not raw.is_integer():
            raise LeverageError(f"레버리지는 정수여야 합니다: {raw}")
        # 1.0 같은 float도 거부한다. 입력 경로마다 해석이 달라지는 것을 막기 위함.
        raise LeverageError(f"레버리지는 정수형으로 전달해야 합니다: {raw}")
    elif isinstance(raw, str):
        text = raw.strip()
        if text.lower().endswith("x"):
            text = text[:-1]
        if not text.isdigit() or (len(text) > 1 and text.startswith("0")):
            raise LeverageError(f"레버리지는 1~7 정수여야 합니다: {raw!r}")
        value = int(text)
    else:
        raise LeverageError(f"레버리지 형식을 알 수 없습니다: {type(raw).__name__}")
    if value < MIN_LEVERAGE or value > MAX_LEVERAGE:
        raise LeverageError(f"레버리지는 {MIN_LEVERAGE}~{MAX_LEVERAGE} 사이여야 합니다: {value}")
    return value


@dataclass(frozen=True)
class VenueLeverageLimit:
    venue: str
    instrument: str
    max_leverage: Optional[int]  # None = 확인되지 않음
    source: str
    verified: bool


# 확인된 출처가 없는 한도는 verified=False 로 둔다. 실제 주문 경로가 생기더라도
# verified=False 인 거래소에는 2배 이상 주문을 보내면 안 된다(이 패키지에는 주문 경로가 없음).
VENUE_LIMITS: dict[str, VenueLeverageLimit] = {
    "binance:BTCUSDT-PERP": VenueLeverageLimit(
        "binance", "BTCUSDT-PERP", None,
        "Binance USDT-M 레버리지 구간표는 계정·명목가치별로 달라 공개 API(/fapi/v1/leverageBracket)는 서명 필요. 이 환경에서 미확인",
        False,
    ),
    "hyperliquid:BTC-PERP": VenueLeverageLimit(
        "hyperliquid", "BTC-PERP", None,
        "Hyperliquid info API meta.universe[].maxLeverage 로 확인 가능하나 이 실행에서 수집되지 않음",
        False,
    ),
}


def venue_limit(venue: str, instrument: str) -> VenueLeverageLimit:
    key = f"{venue}:{instrument}"
    return VENUE_LIMITS.get(
        key, VenueLeverageLimit(venue, instrument, None, "등록된 한도 정보 없음", False)
    )


def register_verified_limit(venue: str, instrument: str, max_leverage: int, source: str) -> VenueLeverageLimit:
    """공개 데이터로 확인한 한도를 등록한다(예: Hyperliquid meta 응답)."""
    if isinstance(max_leverage, bool) or not isinstance(max_leverage, int) or max_leverage < 1:
        raise LeverageError(f"거래소 한도 값이 잘못됐습니다: {max_leverage!r}")
    lim = VenueLeverageLimit(venue, instrument, max_leverage, source, True)
    VENUE_LIMITS[f"{venue}:{instrument}"] = lim
    return lim


def check_paper_leverage_against_venue(leverage: int, venue: str, instrument: str) -> dict:
    """PAPER/백테스트 레버리지가 거래소 확인 한도 안인지 표시용 상태를 돌려준다.

    PAPER 계산은 막지 않는다(실주문이 아니므로). 대신 확인되지 않은 한도면 그렇게 표시한다.
    """
    lev = parse_leverage(leverage)
    lim = venue_limit(venue, instrument)
    if lim.max_leverage is None:
        status = "UNVERIFIED_VENUE_LIMIT"
    elif lev <= lim.max_leverage:
        status = "WITHIN_VERIFIED_LIMIT"
    else:
        status = "EXCEEDS_VERIFIED_LIMIT"
    return {
        "leverage": lev,
        "venue": venue,
        "instrument": instrument,
        "venue_max_leverage": lim.max_leverage,
        "venue_limit_source": lim.source,
        "venue_limit_verified": lim.verified,
        "status": status,
        "live_order_allowed": False,
    }

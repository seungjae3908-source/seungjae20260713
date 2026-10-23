"""시장별 레버리지 정책(최종).

| 시장 | 범위 | 비고 |
|---|---|---|
| 비트겟 선물(bitget_futures) | 정수 1~10, 기본 1 | PAPER·백테스트·실거래 코드 모두 같은 범위. 실제 계좌 레버리지는 바꾸지 않는다 |
| 업비트 현물(upbit_spot)     | 1 고정           | 레버리지 입력 자체를 받지 않는다. 1 이외는 어떤 경로(API·설정·요청 본문)로 와도 거부 |
| 국내 주식(kr_stock)         | 1 고정(현금)     | 증권사·계좌 한도 유지, 신용·미수 미사용 |
| 미국 주식(us_stock)         | 1 고정(현금)     | 위와 같음 |

이 모듈은 계산용 정책이며 주문·계정 코드와 연결되지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from .leverage import DEFAULT_LEVERAGE, MAX_LEVERAGE, MIN_LEVERAGE, LeverageError, parse_leverage

BITGET_FUTURES = "bitget_futures"
UPBIT_SPOT = "upbit_spot"
KR_STOCK = "kr_stock"
US_STOCK = "us_stock"


@dataclass(frozen=True)
class MarketLeveragePolicy:
    market: str
    min_leverage: int
    max_leverage: int
    default: int
    accepts_input: bool          # False = 레버리지 입력란·API 필드를 노출하지 않음(1 고정)
    margin_products_allowed: bool  # 주식 신용·미수, 현물 마진 등 금지 여부(False = 금지)
    note: str

    @property
    def fixed(self) -> bool:
        return self.min_leverage == self.max_leverage == 1


MARKET_POLICIES: dict[str, MarketLeveragePolicy] = {
    BITGET_FUTURES: MarketLeveragePolicy(BITGET_FUTURES, MIN_LEVERAGE, MAX_LEVERAGE, DEFAULT_LEVERAGE, True, True,
                                         "PAPER·실거래 코드 모두 1~10 선택, 기본 1. 거래소 계약 한도(minLever~maxLever) 안인지 별도 확인"),
    UPBIT_SPOT: MarketLeveragePolicy(UPBIT_SPOT, 1, 1, 1, False, False,
                                     "현물 1배 고정. 매수·매도는 실제 원화·코인 잔액과 기존 주문 리스크 한도를 따른다"),
    KR_STOCK: MarketLeveragePolicy(KR_STOCK, 1, 1, 1, False, False, "현금 거래 1배. 신용·미수 상품 미사용"),
    US_STOCK: MarketLeveragePolicy(US_STOCK, 1, 1, 1, False, False, "현금 거래 1배. 마진 계좌 기능 미사용"),
}

# 운영 앱 자산군 이름 → 이 정책 키
ASSET_CLASS_ALIASES = {
    "crypto_futures": BITGET_FUTURES, "bitget": BITGET_FUTURES, "bitget_futures": BITGET_FUTURES,
    "crypto_spot": UPBIT_SPOT, "upbit": UPBIT_SPOT, "upbit_spot": UPBIT_SPOT,
    "domestic_stock": KR_STOCK, "kiwoom": KR_STOCK, "kr_stock": KR_STOCK,
    "us_stock": US_STOCK, "toss": US_STOCK,
}


class MarketPolicyError(LeverageError):
    pass


def policy_for(market: str) -> MarketLeveragePolicy:
    key = ASSET_CLASS_ALIASES.get(str(market).strip().lower())
    if key is None:
        raise MarketPolicyError(f"알 수 없는 시장입니다: {market!r}")
    return MARKET_POLICIES[key]


_MISSING = object()


def resolve_leverage(market: str, raw: Any = _MISSING) -> int:
    """시장 정책에 따라 레버리지를 확정한다.

    - 비트겟 선물: 값이 없으면 1, 있으면 정수 1~10 만 허용(parse_leverage 규칙).
    - 1배 고정 시장: 값이 없거나 정확히 1(또는 "1")이면 1. 그 외는 어떤 값이든 거부한다.
      문자열 "1x", 1.0, True 같은 값도 거부한다(고정 시장은 입력란이 없어야 하므로 느슨한 해석을 하지 않음).
    """
    pol = policy_for(market)
    if pol.fixed:
        if raw is _MISSING or raw is None:
            return 1
        if isinstance(raw, bool) or not (raw == 1 and isinstance(raw, int)) and raw != "1":
            raise MarketPolicyError(
                f"{pol.market} 는 1배 고정 시장입니다. 레버리지 {raw!r} 는 허용되지 않습니다(입력 경로 자체가 없어야 함)")
        return 1
    if raw is _MISSING or raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return pol.default
    lev = parse_leverage(raw)
    if not pol.min_leverage <= lev <= pol.max_leverage:
        raise MarketPolicyError(f"{pol.market} 허용 범위 {pol.min_leverage}~{pol.max_leverage} 밖: {lev}")
    return lev


def reject_leverage_field(market: str, payload: Optional[dict]) -> dict:
    """요청 본문·설정 dict 에 레버리지 필드가 있으면 1배 고정 시장에서는 거부한다. 통과하면 그대로 돌려준다."""
    pol = policy_for(market)
    payload = payload or {}
    keys = [k for k in payload if k.lower().replace("_", "") in ("leverage", "bitgetleverage", "lev")]
    if pol.fixed:
        for k in keys:
            resolve_leverage(market, payload[k])  # 1 만 통과, 나머지는 MarketPolicyError
    else:
        for k in keys:
            resolve_leverage(market, payload[k])
    return payload


def policy_table() -> list[dict]:
    return [{"market": p.market, "min": p.min_leverage, "max": p.max_leverage, "default": p.default,
             "accepts_input": p.accepts_input, "margin_products_allowed": p.margin_products_allowed, "note": p.note}
            for p in MARKET_POLICIES.values()]

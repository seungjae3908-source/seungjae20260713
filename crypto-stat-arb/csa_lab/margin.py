"""격리 증거금 선형 무기한 선물의 증거금·청산가 계산 (순수 함수).

자본 M, 레버리지 L, 진입가 E 일 때
  명목가치 N = M * L,  수량 Q = N / E,  개시증거금 = N / L = M
  롱 청산가  P = (Q*E - M) / (Q * (1 - mmr))
  숏 청산가  P = (Q*E + M) / (Q * (1 + mmr))
유지증거금률 mmr 은 거래소·구간별로 다르므로 호출자가 출처와 함께 넘긴다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .leverage import parse_leverage


def _pos(name: str, v: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name} 는 숫자여야 합니다: {v!r}")
    f = float(v)
    if not math.isfinite(f) or f <= 0:
        raise ValueError(f"{name} 는 0보다 큰 유한한 수여야 합니다: {v!r}")
    return f


def _mmr(v: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise ValueError(f"유지증거금률이 잘못됐습니다: {v!r}")
    f = float(v)
    if f < 0 or f >= 0.5:
        raise ValueError(f"유지증거금률은 0 이상 0.5 미만이어야 합니다: {v!r}")
    return f


@dataclass(frozen=True)
class PositionSizing:
    margin: float
    leverage: int
    notional: float
    entry_price: float
    quantity: float
    initial_margin: float


def size_position(margin: float, leverage: int, entry_price: float) -> PositionSizing:
    m = _pos("margin", margin)
    lev = parse_leverage(leverage)
    e = _pos("entry_price", entry_price)
    notional = m * lev
    return PositionSizing(m, lev, notional, e, notional / e, notional / lev)


def liquidation_price(side: int, entry_price: float, leverage: int, mmr: float) -> float:
    """side=+1 롱, -1 숏. 롱 1배는 0(사실상 청산 없음)을 돌려준다."""
    e = _pos("entry_price", entry_price)
    lev = parse_leverage(leverage)
    r = _mmr(mmr)
    if side == 1:
        p = e * (1.0 - 1.0 / lev) / (1.0 - r)
        return max(p, 0.0)
    if side == -1:
        return e * (1.0 + 1.0 / lev) / (1.0 + r)
    raise ValueError(f"side 는 +1 또는 -1 이어야 합니다: {side!r}")


def is_liquidated(side: int, liq_price: float, bar_low: float, bar_high: float) -> bool:
    """봉 안의 최악 가격이 청산가에 닿았는지(봉 내 경로를 모르므로 보수적으로 고가/저가 사용)."""
    if side == 1:
        return bar_low <= liq_price
    if side == -1:
        return bar_high >= liq_price
    raise ValueError("side 는 +1 또는 -1")


def unrealized_pnl(side: int, quantity: float, entry_price: float, mark_price: float) -> float:
    q = _pos("quantity", quantity)
    e = _pos("entry_price", entry_price)
    p = _pos("mark_price", mark_price)
    if side not in (1, -1):
        raise ValueError("side 는 +1 또는 -1")
    return side * q * (p - e)


def roi_on_margin(pnl: float, margin: float) -> float:
    m = _pos("margin", margin)
    if isinstance(pnl, bool) or not isinstance(pnl, (int, float)) or not math.isfinite(float(pnl)):
        raise ValueError(f"pnl 이 잘못됐습니다: {pnl!r}")
    return float(pnl) / m

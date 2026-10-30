"""원화 자금 → 증거금 통화(USDT) 환산과 전략별 자금 할당 장부.

- 환율은 하드코딩하지 않는다. FxQuote 가 없으면 KRW 기준 실행을 중단한다.
- 같은 500,000원을 여러 전략이 동시에 쓰지 못하도록 할당 장부로 추적한다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

DEFAULT_STRATEGY_CAPITAL_KRW = 500_000


class FxMissingError(RuntimeError):
    """환율이 없거나 오래되어 KRW 기준 계산을 할 수 없음."""


class AllocationError(RuntimeError):
    """전략 자금 할당 위반."""


def _finite_positive(name: str, v: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name} 는 숫자여야 합니다: {v!r}")
    f = float(v)
    if not math.isfinite(f) or f <= 0:
        raise ValueError(f"{name} 는 0보다 큰 유한한 수여야 합니다: {v!r}")
    return f


@dataclass(frozen=True)
class FxQuote:
    """1 USDT(또는 USD) 당 KRW."""

    krw_per_unit: float
    unit: str  # "USDT" 또는 "USD"
    source: str
    as_of: datetime

    def __post_init__(self):
        _finite_positive("krw_per_unit", self.krw_per_unit)
        if self.as_of.tzinfo is None:
            raise ValueError("as_of 는 시간대가 있어야 합니다")
        if not self.source:
            raise ValueError("환율 출처가 비어 있습니다")

    def age_seconds(self, now: Optional[datetime] = None) -> float:
        now = now or datetime.now(timezone.utc)
        return (now - self.as_of).total_seconds()


def require_fx(quote: Optional[FxQuote], *, max_age_seconds: Optional[float], now: Optional[datetime] = None) -> FxQuote:
    if quote is None:
        raise FxMissingError("환율 없음: KRW 기준 실행을 중단합니다 (FX_MISSING)")
    if max_age_seconds is not None and quote.age_seconds(now) > max_age_seconds:
        raise FxMissingError(
            f"환율이 오래됨({quote.age_seconds(now):.0f}초 > {max_age_seconds:.0f}초): KRW 기준 실행 중단 (FX_STALE)"
        )
    return quote


def krw_to_margin_units(krw: float, quote: FxQuote) -> float:
    """KRW → 증거금 통화. 0 또는 음수 KRW 는 거부."""
    k = _finite_positive("krw", krw)
    rate = _finite_positive("krw_per_unit", quote.krw_per_unit)
    return k / rate


def margin_units_to_krw(amount: float, quote: FxQuote) -> float:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(float(amount)):
        raise ValueError(f"금액이 잘못됐습니다: {amount!r}")
    return float(amount) * _finite_positive("krw_per_unit", quote.krw_per_unit)


@dataclass
class AllocationLedger:
    """총 자금(KRW) 안에서 전략별로 겹치지 않게 할당한다."""

    total_krw: float
    allocations: dict[str, float] = field(default_factory=dict)

    def __post_init__(self):
        _finite_positive("total_krw", self.total_krw)

    @property
    def allocated_krw(self) -> float:
        return float(sum(self.allocations.values()))

    @property
    def free_krw(self) -> float:
        return self.total_krw - self.allocated_krw

    def allocate(self, strategy_id: str, krw: float) -> float:
        if not strategy_id:
            raise AllocationError("전략 ID 가 비어 있습니다")
        amt = _finite_positive("krw", krw)
        if strategy_id in self.allocations:
            raise AllocationError(f"이미 할당된 전략입니다: {strategy_id}")
        if amt > self.free_krw + 1e-9:
            raise AllocationError(
                f"자금 부족: 요청 {amt:,.0f}원 > 남은 {self.free_krw:,.0f}원 (같은 자금을 중복 사용할 수 없음)"
            )
        self.allocations[strategy_id] = amt
        return amt

    def release(self, strategy_id: str) -> float:
        if strategy_id not in self.allocations:
            raise AllocationError(f"할당되지 않은 전략입니다: {strategy_id}")
        return self.allocations.pop(strategy_id)

    def to_dict(self) -> dict:
        return {
            "total_krw": self.total_krw,
            "allocated_krw": self.allocated_krw,
            "free_krw": self.free_krw,
            "allocations": dict(self.allocations),
        }

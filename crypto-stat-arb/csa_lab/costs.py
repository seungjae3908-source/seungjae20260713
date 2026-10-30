"""비용 항목. 확인되지 않은 비용은 0 이 아니라 UNKNOWN 으로 남긴다."""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Optional

UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class CostRate:
    """비율 비용(명목가치 대비). value=None 이면 UNKNOWN."""

    name: str
    value: Optional[float]
    source: str
    status: str = "CONFIRMED"  # CONFIRMED | ORIGINAL_CONFIG | ASSUMED | UNKNOWN

    def __post_init__(self):
        if self.value is None:
            object.__setattr__(self, "status", UNKNOWN)
        else:
            v = self.value
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)) or v < 0:
                raise ValueError(f"{self.name} 비용 비율이 잘못됐습니다: {v!r}")
            if v > 0.05:
                raise ValueError(f"{self.name} 비용 비율이 비정상적으로 큽니다(>5%): {v!r}")
        if not self.source:
            raise ValueError(f"{self.name} 비용 출처가 비어 있습니다")

    @property
    def known(self) -> bool:
        return self.value is not None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["value"] = UNKNOWN if self.value is None else self.value
        return d


@dataclass(frozen=True)
class CostModel:
    """한 번 체결(편도)마다 적용되는 비용 + 펀딩비 사용 여부."""

    taker_fee: CostRate
    slippage: CostRate
    half_spread: CostRate
    funding_included: bool  # 실제 펀딩비 이력으로 정산하는지
    funding_source: str

    @property
    def per_side_rate(self) -> Optional[float]:
        parts = (self.taker_fee, self.slippage, self.half_spread)
        if any(not p.known for p in parts):
            return None
        return float(sum(p.value for p in parts))  # type: ignore[arg-type]

    @property
    def fully_known(self) -> bool:
        return self.per_side_rate is not None and self.funding_included

    @property
    def all_confirmed(self) -> bool:
        return self.fully_known and all(
            p.status == "CONFIRMED" for p in (self.taker_fee, self.slippage, self.half_spread))

    def unknown_items(self) -> list[str]:
        out = [p.name for p in (self.taker_fee, self.slippage, self.half_spread) if not p.known]
        if not self.funding_included:
            out.append("funding")
        return out

    def to_dict(self) -> dict:
        return {
            "taker_fee": self.taker_fee.to_dict(),
            "slippage": self.slippage.to_dict(),
            "half_spread": self.half_spread.to_dict(),
            "funding_included": self.funding_included,
            "funding_source": self.funding_source,
            "per_side_rate": UNKNOWN if self.per_side_rate is None else self.per_side_rate,
            "unknown_items": self.unknown_items(),
            "net_profitability_verifiable": self.fully_known,
            "all_costs_confirmed": self.all_confirmed,
            "unconfirmed_items": [p.name + ":" + p.status for p in (self.taker_fee, self.slippage, self.half_spread)
                                  if p.status != "CONFIRMED"],
        }

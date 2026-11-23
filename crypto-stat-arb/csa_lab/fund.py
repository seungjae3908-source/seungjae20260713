"""자동매매 자금 관리 원장(PAPER). 실제 계좌와 연결되지 않는다.

규칙
- 초기 기본 자금 1,000,000 KRW 는 참고 기준이며, 손실 뒤 자동으로 보충하지 않는다.
- 최대 진입 증거금 한도(기본 1,000,000 KRW)는 설정으로 바꿀 수 있다. 진입 금액은 레버리지 적용 전 증거금이다.
- 허용 진입 증거금 = min(최대 진입 한도, 기본 자금 잔액, 전략 계획 잔여분, 거래소·리스크 제한 중 더 엄격한 값).
- 실현 순이익(비용 차감 후)은 50% 를 기본 자금에 재투자하고 50% 를 예비금에 적립한다. 손실은 기본 자금에서 뺀다.
- 예비금 → 기본 자금 자동 이체는 없다(그런 메서드를 두지 않았다).
- 전략별 계획 자금(예: 500,000 KRW)은 같은 기본 자금에서 떼어 두는 '계획'이며 별도의 돈이 아니다.
  계획 합계가 기본 자금 잔액을 넘으면 거부한다(같은 돈을 두 전략이 쓰는 계산 금지).
- 결산은 거래 ID 로 한 번만 처리한다. 상태는 원자적으로 저장하고, 다시 읽을 때 일지(journal)로 재계산해 일관성을 확인한다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .storage import atomic_write_json, read_json

DEFAULT_INITIAL_KRW = 1_000_000
DEFAULT_MAX_ENTRY_MARGIN_KRW = 1_000_000
REINVEST_RATIO = 0.5


class FundError(RuntimeError):
    pass


class DuplicateSettlementError(FundError):
    pass


class LedgerInconsistentError(FundError):
    pass


def _money(name: str, v, *, allow_zero: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise FundError(f"{name} 는 숫자여야 합니다: {v!r}")
    f = float(v)
    if not math.isfinite(f) or f < 0 or (f == 0 and not allow_zero):
        raise FundError(f"{name} 가 잘못됐습니다: {v!r}")
    return f


@dataclass
class EntryLimits:
    """거래소·리스크 쪽 제한(확인된 값만 넣는다. None = 제한 정보 없음)."""

    exchange_available_krw: Optional[float] = None   # 거래소 잔액
    exchange_min_order_krw: Optional[float] = None   # 최소 주문 금액
    exchange_max_margin_krw: Optional[float] = None  # 거래소 증거금 상한
    risk_max_margin_krw: Optional[float] = None      # 리스크 규칙 상한


@dataclass
class AutoTradingFund:
    initial_krw: float = DEFAULT_INITIAL_KRW
    max_entry_margin_krw: float = DEFAULT_MAX_ENTRY_MARGIN_KRW
    base_balance_krw: float = field(default=None)  # type: ignore[assignment]
    reserve_krw: float = 0.0
    plans: dict = field(default_factory=dict)       # strategy_id -> 계획 금액(기본 자금에서 떼어 둠)
    settled: dict = field(default_factory=dict)     # trade_id -> 순손익
    journal: list = field(default_factory=list)
    path: Optional[Path] = None

    def __post_init__(self):
        self.initial_krw = _money("initial_krw", self.initial_krw)
        self.max_entry_margin_krw = _money("max_entry_margin_krw", self.max_entry_margin_krw)
        if self.base_balance_krw is None:
            self.base_balance_krw = self.initial_krw
            self._log("init", initial_krw=self.initial_krw, max_entry_margin_krw=self.max_entry_margin_krw)

    # ---------- 설정 ----------
    def set_max_entry_margin(self, krw: float) -> None:
        self.max_entry_margin_krw = _money("max_entry_margin_krw", krw)
        self._log("set_max_entry_margin", max_entry_margin_krw=self.max_entry_margin_krw)
        self._save()

    # ---------- 계획 ----------
    @property
    def planned_krw(self) -> float:
        return float(sum(self.plans.values()))

    def allocate_plan(self, strategy_id: str, krw: float) -> None:
        if not strategy_id:
            raise FundError("전략 ID 가 비어 있습니다")
        if strategy_id in self.plans:
            raise FundError(f"이미 계획이 있는 전략입니다: {strategy_id}")
        amt = _money("plan_krw", krw)
        if self.planned_krw + amt > self.base_balance_krw + 1e-9:
            raise FundError(
                f"계획 합계 {self.planned_krw + amt:,.0f}원이 기본 자금 잔액 {self.base_balance_krw:,.0f}원을 넘습니다 "
                f"(같은 자금을 여러 전략이 중복 사용할 수 없음)")
        self.plans[strategy_id] = amt
        self._log("allocate_plan", strategy_id=strategy_id, plan_krw=amt)
        self._save()

    def release_plan(self, strategy_id: str) -> None:
        if strategy_id not in self.plans:
            raise FundError(f"계획이 없는 전략입니다: {strategy_id}")
        self.plans.pop(strategy_id)
        self._log("release_plan", strategy_id=strategy_id)
        self._save()

    # ---------- 진입 한도 ----------
    def allowed_entry_margin_krw(self, strategy_id: Optional[str] = None,
                                 limits: Optional[EntryLimits] = None) -> dict:
        """허용 진입 증거금과 어떤 제한이 걸렸는지."""
        candidates = {"max_entry_margin": self.max_entry_margin_krw, "base_balance": self.base_balance_krw}
        if strategy_id is not None:
            if strategy_id not in self.plans:
                raise FundError(f"계획이 없는 전략입니다: {strategy_id}")
            candidates["strategy_plan"] = self.plans[strategy_id]
            # 계획이 잔액보다 크면(손실 뒤) 잔액이 지배한다
        lim = limits or EntryLimits()
        for key, val in (("exchange_available", lim.exchange_available_krw),
                         ("exchange_max_margin", lim.exchange_max_margin_krw),
                         ("risk_max_margin", lim.risk_max_margin_krw)):
            if val is not None:
                candidates[key] = _money(key, val, allow_zero=True)
        binding = min(candidates, key=candidates.get)
        allowed = candidates[binding]
        below_min = lim.exchange_min_order_krw is not None and allowed < _money("min_order", lim.exchange_min_order_krw)
        return {"allowed_krw": 0.0 if below_min else allowed, "binding": "exchange_min_order" if below_min else binding,
                "candidates": candidates, "entry_blocked": below_min or allowed <= 0}

    # ---------- 결산 ----------
    def settle(self, trade_id: str, net_pnl_krw: float, *, note: str = "") -> dict:
        """비용 차감 후 순손익을 한 번만 반영한다."""
        if not trade_id:
            raise FundError("거래 ID 가 비어 있습니다")
        if trade_id in self.settled:
            raise DuplicateSettlementError(f"이미 결산된 거래입니다: {trade_id}")
        if isinstance(net_pnl_krw, bool) or not isinstance(net_pnl_krw, (int, float)) or not math.isfinite(float(net_pnl_krw)):
            raise FundError(f"순손익이 잘못됐습니다: {net_pnl_krw!r}")
        pnl = float(net_pnl_krw)
        if pnl > 0:
            to_base = pnl * REINVEST_RATIO
            to_reserve = pnl - to_base
        else:
            to_base = pnl
            to_reserve = 0.0
        self.base_balance_krw += to_base
        self.reserve_krw += to_reserve
        self.settled[trade_id] = pnl
        rec = {"trade_id": trade_id, "net_pnl_krw": pnl, "to_base_krw": to_base, "to_reserve_krw": to_reserve,
               "base_after_krw": self.base_balance_krw, "reserve_after_krw": self.reserve_krw, "note": note}
        self._log("settle", **rec)
        self._save()
        return rec

    # ---------- 일관성 ----------
    def expected_from_journal(self) -> tuple[float, float]:
        base, reserve = None, 0.0
        for e in self.journal:
            if e["event"] == "init":
                base, reserve = e["initial_krw"], 0.0
            elif e["event"] == "settle":
                base += e["to_base_krw"]
                reserve += e["to_reserve_krw"]
        if base is None:
            raise LedgerInconsistentError("일지에 초기화 기록이 없습니다")
        return base, reserve

    def verify(self) -> dict:
        base, reserve = self.expected_from_journal()
        problems = []
        if abs(base - self.base_balance_krw) > 1e-6:
            problems.append(f"기본 자금 불일치: 상태 {self.base_balance_krw} vs 일지 {base}")
        if abs(reserve - self.reserve_krw) > 1e-6:
            problems.append(f"예비금 불일치: 상태 {self.reserve_krw} vs 일지 {reserve}")
        ids = [e["trade_id"] for e in self.journal if e["event"] == "settle"]
        if len(ids) != len(set(ids)):
            problems.append("일지에 중복 결산이 있습니다")
        if set(ids) != set(self.settled):
            problems.append("결산 목록과 일지가 다릅니다")
        if self.reserve_krw < -1e-9:
            problems.append("예비금이 음수입니다")
        profits = sum(p for p in self.settled.values() if p > 0)
        losses = sum(p for p in self.settled.values() if p < 0)
        identity = self.initial_krw + profits * REINVEST_RATIO + losses
        if abs(identity - self.base_balance_krw) > 1e-6:
            problems.append(f"항등식 불일치: 초기+이익×{REINVEST_RATIO}+손실={identity} vs {self.base_balance_krw}")
        if abs(profits * (1 - REINVEST_RATIO) - self.reserve_krw) > 1e-6:
            problems.append("예비금 항등식 불일치")
        if problems:
            raise LedgerInconsistentError("; ".join(problems))
        return {"ok": True, "base_balance_krw": self.base_balance_krw, "reserve_krw": self.reserve_krw,
                "settlements": len(self.settled), "realized_profit_krw": profits, "realized_loss_krw": losses}

    # ---------- 저장 ----------
    def to_dict(self) -> dict:
        return {"initial_krw": self.initial_krw, "max_entry_margin_krw": self.max_entry_margin_krw,
                "base_balance_krw": self.base_balance_krw, "reserve_krw": self.reserve_krw,
                "plans": dict(self.plans), "settled": dict(self.settled), "journal": list(self.journal),
                "reinvest_ratio": REINVEST_RATIO, "auto_reserve_transfer": False, "live_orders": 0}

    def _log(self, event: str, **kw) -> None:
        self.journal.append({"seq": len(self.journal), "event": event, **kw})

    def _save(self) -> None:
        if self.path is not None:
            atomic_write_json(self.path, self.to_dict())

    @classmethod
    def load(cls, path: Path) -> "AutoTradingFund":
        d = read_json(Path(path))
        f = cls(initial_krw=d["initial_krw"], max_entry_margin_krw=d["max_entry_margin_krw"],
                base_balance_krw=d["base_balance_krw"], reserve_krw=d["reserve_krw"], plans=dict(d["plans"]),
                settled=dict(d["settled"]), journal=list(d["journal"]), path=Path(path))
        f.verify()  # 변조·반쪽 저장이면 여기서 실패
        return f

    @classmethod
    def open(cls, path: Path, **kw) -> "AutoTradingFund":
        """있으면 복구, 없으면 새로 만들어 저장."""
        path = Path(path)
        if path.exists():
            return cls.load(path)
        f = cls(path=path, **kw)
        f._save()
        return f

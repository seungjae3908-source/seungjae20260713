"""순손익 기준 성과 지표 (순수 함수)."""
from __future__ import annotations

import math
from typing import Optional, Sequence

import numpy as np

HOURS_PER_YEAR = 24 * 365  # 코인은 24시간·365일 거래


def safe_div(num: float, den: float) -> Optional[float]:
    """0 나누기·비유한 값이면 None."""
    try:
        n, d = float(num), float(den)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or not math.isfinite(d) or d == 0:
        return None
    return n / d


def max_drawdown(equity: Sequence[float]) -> float:
    """0~1 사이 비율. 자본이 0 이하로 가면 1.0(전액 손실)."""
    e = np.asarray(equity, dtype=float)
    if e.size == 0:
        return 0.0
    if not np.isfinite(e).all():
        raise ValueError("자본 곡선에 비유한 값이 있습니다")
    peak = np.maximum.accumulate(e)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peak > 0, (peak - e) / peak, 1.0)
    return float(min(1.0, dd.max()))


def sharpe(period_returns: Sequence[float], periods_per_year: float = HOURS_PER_YEAR) -> Optional[float]:
    r = np.asarray(period_returns, dtype=float)
    if r.size < 2:
        return None
    sd = r.std(ddof=1)
    if not math.isfinite(sd) or sd == 0:
        return None
    return float(r.mean() / sd * math.sqrt(periods_per_year))


def trade_stats(net_pnls: Sequence[float], hold_hours: Sequence[float]) -> dict:
    p = np.asarray(net_pnls, dtype=float)
    n = int(p.size)
    wins = p[p > 0]
    losses = p[p < 0]
    gross_win = float(wins.sum())
    gross_loss = float(-losses.sum())
    pf = safe_div(gross_win, gross_loss)
    return {
        "trades": n,
        "win_rate_net": safe_div(len(wins), n),
        "profit_factor_net": pf,
        "profit_factor_note": "손실 거래 없음(무한대)" if gross_loss == 0 and n > 0 else None,
        "avg_net_pnl": safe_div(float(p.sum()), n),
        "avg_hold_hours": float(np.mean(hold_hours)) if len(hold_hours) else None,
    }

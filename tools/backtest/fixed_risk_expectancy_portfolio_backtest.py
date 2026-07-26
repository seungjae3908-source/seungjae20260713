#!/usr/bin/env python3
"""Stage 7 fixed-risk expectancy portfolio backtest.

Public Bitget USDT-futures market candles only. The test never accesses an
account, API key or order endpoint. It evaluates one portfolio position at a
time across BTC, ETH, SOL, XRP and DOGE, with KRW-equivalent risk sizing.

Key safeguards:
- signal uses a completed bar and enters at the next bar open;
- higher-timeframe features are shifted by one completed higher bar;
- stop is checked before additions or targets inside an ambiguous candle;
- fees and slippage are applied to every simulated fill;
- total planned stop loss including fees is capped near 1,500 KRW;
- no averaging down: additions occur only at +0.5R and +1.0R.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
import requests

BITGET_BASE = "https://api.bitget.com"
HISTORY_ENDPOINT = "/api/v2/mix/market/history-candles"
PRODUCT_TYPE = "USDT-FUTURES"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT")
TIMEFRAMES = {
    "15m": {"granularity": "15m", "minutes": 15, "mid_rule": "1h", "high_rule": "4h"},
    "1H": {"granularity": "1H", "minutes": 60, "mid_rule": "4h", "high_rule": "1d"},
}
DAYS = 540
BAR_LIMIT = 200
REQUEST_PAUSE_SECONDS = 0.065

STARTING_CAPITAL_KRW = 300_000.0
RISK_PER_SETUP_KRW = 1_500.0
LEVERAGE = 5.0
MAX_MARGIN_KRW = 30_000.0
MAX_NOTIONAL_KRW = MAX_MARGIN_KRW * LEVERAGE
MIN_LEG_NOTIONAL_KRW = 3_000.0
ENTRY_SPLITS = (0.30, 0.30, 0.40)
ADD_R_LEVELS = (0.0, 0.5, 1.0)
FEE_BPS = 12.0
SLIPPAGE_BPS = 15.0
DAILY_LOSS_LIMIT_KRW = 6_000.0
TOTAL_LOSS_LIMIT_KRW = 15_000.0
MAX_HOLD_HOURS = 48
COOLDOWN_HOURS = 8

OUT = Path("docs/backtests")
STEM = "BITGET_FIXED_RISK_EXPECTANCY_5SYMBOL_540D_STAGE7"

EXIT_PLANS: dict[str, dict[str, Any]] = {
    "EXPECTANCY_2R_3R_5R": {
        "targets": (2.0, 3.0, 5.0),
        "fractions": (0.30, 0.30, 0.40),
        "trail_after_second_atr": 2.0,
    },
    "BALANCED_1_5R_2_5R_4R": {
        "targets": (1.5, 2.5, 4.0),
        "fractions": (0.30, 0.30, 0.40),
        "trail_after_second_atr": 2.0,
    },
    "FIXED_3R_ALL": {
        "targets": (3.0,),
        "fractions": (1.0,),
        "trail_after_second_atr": None,
    },
}


@dataclass
class Leg:
    stage: int
    quantity: float
    entry_fill: float
    notional_krw: float
    margin_krw: float
    entry_fee_krw: float
    estimated_slippage_krw: float
    remaining_quantity: float
    remaining_notional_krw: float
    remaining_entry_fee_krw: float


@dataclass
class Position:
    symbol: str
    opened_at: pd.Timestamp
    signal_time: pd.Timestamp
    signal_score: float
    initial_entry_fill: float
    initial_stop_price: float
    initial_stop_fill: float
    initial_r_price: float
    initial_atr: float
    add_levels: tuple[float, float]
    target_levels: tuple[float, ...]
    target_fractions: tuple[float, ...]
    legs: list[Leg] = field(default_factory=list)
    next_add_stage: int = 2
    next_target_index: int = 0
    stop_price: float = 0.0
    highest_close: float = 0.0
    gross_pnl_krw: float = 0.0
    exit_fees_krw: float = 0.0
    allocated_entry_fees_krw: float = 0.0
    estimated_exit_slippage_krw: float = 0.0
    closed_quantity: float = 0.0
    exit_events: list[dict[str, Any]] = field(default_factory=list)
    entry_events: list[dict[str, Any]] = field(default_factory=list)
    last_exit_reason: str = ""

    @property
    def quantity(self) -> float:
        return sum(leg.remaining_quantity for leg in self.legs)

    @property
    def remaining_notional_krw(self) -> float:
        return sum(leg.remaining_notional_krw for leg in self.legs)

    @property
    def margin_krw(self) -> float:
        return self.remaining_notional_krw / LEVERAGE

    @property
    def average_entry(self) -> float:
        qty = self.quantity
        if qty <= 0:
            return self.initial_entry_fill
        return sum(leg.entry_fill * leg.remaining_quantity for leg in self.legs) / qty

    @property
    def total_entry_fees(self) -> float:
        return sum(leg.entry_fee_krw for leg in self.legs)

    @property
    def total_entry_slippage(self) -> float:
        return sum(leg.estimated_slippage_krw for leg in self.legs)


class BacktestError(RuntimeError):
    pass


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def request_json(session: requests.Session, path: str, params: dict[str, str]) -> Any:
    last_error: Exception | None = None
    for attempt in range(6):
        try:
            response = session.get(f"{BITGET_BASE}{path}", params=params, timeout=25)
            response.raise_for_status()
            payload = response.json()
            if str(payload.get("code")) != "00000":
                raise BacktestError(f"BITGET_{payload.get('code')}:{payload.get('msg')}")
            return payload.get("data", [])
        except Exception as exc:  # noqa: BLE001 - retry external public endpoint
            last_error = exc
            if attempt < 5:
                time.sleep(min(8.0, 0.7 * (2**attempt)))
    raise BacktestError(str(last_error or "BITGET_REQUEST_FAILED"))


def fetch_history(
    session: requests.Session,
    symbol: str,
    granularity: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame:
    rows: dict[int, list[float]] = {}
    cursor = end_ms
    stagnant = 0
    while cursor > start_ms:
        data = request_json(
            session,
            HISTORY_ENDPOINT,
            {
                "symbol": symbol,
                "productType": PRODUCT_TYPE,
                "granularity": granularity,
                "endTime": str(cursor),
                "limit": str(BAR_LIMIT),
            },
        )
        if not isinstance(data, list) or not data:
            break
        oldest = cursor
        added = 0
        for raw in data:
            if not isinstance(raw, list) or len(raw) < 7:
                continue
            try:
                timestamp = int(raw[0])
                if start_ms <= timestamp < end_ms:
                    rows[timestamp] = [float(value) for value in raw[1:7]]
                    added += 1
                oldest = min(oldest, timestamp)
            except (TypeError, ValueError):
                continue
        if oldest >= cursor:
            stagnant += 1
            if stagnant >= 2:
                break
            cursor -= 1
        else:
            stagnant = 0
            cursor = oldest - 1
        if oldest < start_ms:
            break
        if added == 0 and len(data) < BAR_LIMIT:
            break
        time.sleep(REQUEST_PAUSE_SECONDS)
    if not rows:
        raise BacktestError(f"NO_CANDLES:{symbol}:{granularity}")
    frame = pd.DataFrame.from_dict(
        rows,
        orient="index",
        columns=["open", "high", "low", "close", "volume", "quote_volume"],
    )
    frame.index = pd.to_datetime(frame.index.astype("int64"), unit="ms", utc=True)
    frame = frame.sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    frame = frame[(frame.open > 0) & (frame.high > 0) & (frame.low > 0) & (frame.close > 0)]
    return frame


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False, min_periods=span).mean()


def true_range(frame: pd.DataFrame) -> pd.Series:
    previous_close = frame.close.shift(1)
    return pd.concat(
        [
            frame.high - frame.low,
            (frame.high - previous_close).abs(),
            (frame.low - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)


def atr(frame: pd.DataFrame, period: int = 14) -> pd.Series:
    return true_range(frame).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    result = 100 - (100 / (1 + rs))
    return result.fillna(50.0)


def indicator_core(frame: pd.DataFrame) -> pd.DataFrame:
    x = frame.copy()
    x["ema20"] = ema(x.close, 20)
    x["ema50"] = ema(x.close, 50)
    x["ema20_slope"] = x.ema20.pct_change(3)
    x["atr14"] = atr(x, 14)
    x["rsi14"] = rsi(x.close, 14)
    x["macd"] = ema(x.close, 12) - ema(x.close, 26)
    x["macd_signal"] = ema(x.macd, 9)
    x["macd_hist"] = x.macd - x.macd_signal
    x["volume_ma20"] = x.volume.rolling(20, min_periods=20).mean()
    x["volume_ratio"] = x.volume / x.volume_ma20.replace(0, np.nan)
    return x


def resampled_completed_features(frame: pd.DataFrame, rule: str, prefix: str) -> pd.DataFrame:
    aggregated = frame.resample(rule, label="left", closed="left", origin="epoch").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "quote_volume": "sum",
        }
    ).dropna(subset=["open", "high", "low", "close"])
    features = indicator_core(aggregated)
    selected = features[["ema20", "ema50", "ema20_slope", "rsi14", "macd_hist", "atr14"]]
    # Shift one full higher-timeframe bar to prevent using an incomplete aggregate.
    selected = selected.shift(1)
    aligned = selected.reindex(frame.index, method="ffill")
    return aligned.add_prefix(prefix)


def build_features(frame: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    cfg = TIMEFRAMES[timeframe]
    x = indicator_core(frame)
    prior_high20 = x.high.shift(1).rolling(20, min_periods=20).max()
    breakout = (x.close > prior_high20) & (x.close > x.open)
    x["breakout"] = breakout.astype(int)
    x["breakout_level"] = prior_high20.where(breakout)
    x["recent_breakout"] = breakout.shift(1).rolling(20, min_periods=1).max().fillna(0)
    x["retest_level"] = x.breakout_level.shift(1).ffill(limit=20)
    x["swing_low10"] = x.low.shift(1).rolling(10, min_periods=10).min()
    x["previous_close"] = x.close.shift(1)
    x["previous_low"] = x.low.shift(1)
    x["previous_ema20"] = x.ema20.shift(1)
    x["previous_rsi14"] = x.rsi14.shift(1)
    x["previous_macd_hist"] = x.macd_hist.shift(1)
    x["range_atr"] = (x.high - x.low) / x.atr14.replace(0, np.nan)
    mid = resampled_completed_features(frame, cfg["mid_rule"], "mid_")
    high = resampled_completed_features(frame, cfg["high_rule"], "high_")
    x = x.join(mid).join(high)
    return x.replace([np.inf, -np.inf], np.nan)


def signal_from_row(row: pd.Series) -> dict[str, Any]:
    required = (
        "ema20", "ema50", "ema20_slope", "atr14", "rsi14", "macd_hist",
        "volume_ratio", "recent_breakout", "retest_level", "swing_low10",
        "previous_close", "previous_low", "previous_ema20", "previous_rsi14",
        "previous_macd_hist", "range_atr", "mid_ema20", "mid_ema50",
        "mid_ema20_slope", "high_ema20", "high_ema50", "high_ema20_slope",
    )
    if any(pd.isna(row.get(name)) for name in required):
        return {"eligible": False, "score": 0.0, "reasons": ["INDICATOR_WARMUP"]}
    atr_value = float(row.atr14)
    if atr_value <= 0:
        return {"eligible": False, "score": 0.0, "reasons": ["INVALID_ATR"]}
    support = max(float(row.ema20), float(row.retest_level))
    touched = (
        float(row.previous_low) <= max(float(row.previous_ema20), float(row.retest_level)) + 0.40 * atr_value
        or float(row.low) <= support + 0.30 * atr_value
    )
    reclaimed = (
        float(row.close) > support
        and float(row.close) > float(row.open)
        and float(row.close) > float(row.previous_close)
    )
    distance_atr = (float(row.close) - support) / atr_value
    base_trend = float(row.ema20) > float(row.ema50) and float(row.ema20_slope) > 0
    mid_trend = float(row.mid_ema20) > float(row.mid_ema50) and float(row.mid_ema20_slope) > 0
    high_trend = float(row.high_ema20) > float(row.high_ema50) and float(row.high_ema20_slope) > 0
    momentum = (
        48 <= float(row.rsi14) <= 68
        and float(row.rsi14) >= float(row.previous_rsi14)
        and float(row.macd_hist) > float(row.previous_macd_hist)
    )
    quality = (
        bool(row.recent_breakout)
        and touched
        and reclaimed
        and -0.10 <= distance_atr <= 1.00
        and 0.70 <= float(row.volume_ratio) <= 2.00
        and float(row.range_atr) <= 1.70
    )
    score = 0.0
    score += 15 if base_trend else 0
    score += 15 if mid_trend else 0
    score += 15 if high_trend else 0
    score += 12 if bool(row.recent_breakout) else 0
    score += 8 if touched else 0
    score += 8 if reclaimed else 0
    score += 7 if -0.10 <= distance_atr <= 1.00 else 0
    score += 10 if momentum else 0
    score += 5 if 0.70 <= float(row.volume_ratio) <= 2.00 else 0
    score += 5 if float(row.range_atr) <= 1.70 else 0
    reasons: list[str] = []
    if not base_trend:
        reasons.append("BASE_TREND")
    if not mid_trend:
        reasons.append("MID_TREND")
    if not high_trend:
        reasons.append("HIGH_TREND")
    if not bool(row.recent_breakout):
        reasons.append("NO_RECENT_BREAKOUT")
    if not touched:
        reasons.append("NO_PULLBACK_TOUCH")
    if not reclaimed:
        reasons.append("NO_RECLAIM")
    if not momentum:
        reasons.append("MOMENTUM_NOT_RECOVERED")
    if not (0.70 <= float(row.volume_ratio) <= 2.00):
        reasons.append("VOLUME_FILTER")
    if float(row.range_atr) > 1.70:
        reasons.append("CHASE_CANDLE")
    eligible = base_trend and mid_trend and high_trend and momentum and quality and score >= 80
    return {
        "eligible": bool(eligible),
        "score": float(score),
        "support": support,
        "atr": atr_value,
        "swing_low": float(row.swing_low10),
        "reasons": reasons,
    }


def fill_buy(price: float) -> float:
    return price * (1 + SLIPPAGE_BPS / 10_000)


def fill_sell(price: float) -> float:
    return price * (1 - SLIPPAGE_BPS / 10_000)


def fee(notional_krw: float) -> float:
    return notional_krw * FEE_BPS / 10_000


def make_leg(
    stage: int,
    trigger_price: float,
    stop_price: float,
    risk_budget_krw: float,
    notional_cap_krw: float,
    available_margin_krw: float,
) -> Leg | None:
    entry_fill = fill_buy(trigger_price)
    stop_fill = fill_sell(stop_price)
    if stop_fill >= entry_fill:
        return None
    movement_loss_fraction = (entry_fill - stop_fill) / entry_fill
    fee_loss_fraction = (FEE_BPS / 10_000) * (1 + stop_fill / entry_fill)
    risk_fraction = movement_loss_fraction + fee_loss_fraction
    if risk_fraction <= 0:
        return None
    notional = min(
        risk_budget_krw / risk_fraction,
        notional_cap_krw,
        max(0.0, available_margin_krw) * LEVERAGE,
    )
    if notional < MIN_LEG_NOTIONAL_KRW:
        return None
    quantity = notional / entry_fill
    entry_fee = fee(notional)
    slippage = quantity * max(0.0, entry_fill - trigger_price)
    return Leg(
        stage=stage,
        quantity=quantity,
        entry_fill=entry_fill,
        notional_krw=notional,
        margin_krw=notional / LEVERAGE,
        entry_fee_krw=entry_fee,
        estimated_slippage_krw=slippage,
        remaining_quantity=quantity,
        remaining_notional_krw=notional,
        remaining_entry_fee_krw=entry_fee,
    )


def add_leg(position: Position, leg: Leg, timestamp: pd.Timestamp) -> None:
    position.legs.append(leg)
    position.entry_events.append(
        {
            "stage": leg.stage,
            "time": timestamp.isoformat(),
            "entry_fill": leg.entry_fill,
            "notional_krw": leg.notional_krw,
            "margin_krw": leg.margin_krw,
            "entry_fee_krw": leg.entry_fee_krw,
        }
    )


def consume_position_quantity(position: Position, quantity: float) -> tuple[float, float]:
    remaining = quantity
    allocated_notional = 0.0
    allocated_entry_fee = 0.0
    for leg in position.legs:
        if remaining <= 1e-12:
            break
        take = min(remaining, leg.remaining_quantity)
        if take <= 0:
            continue
        fraction = take / leg.remaining_quantity
        allocated_notional += leg.remaining_notional_krw * fraction
        allocated_entry_fee += leg.remaining_entry_fee_krw * fraction
        leg.remaining_quantity -= take
        leg.remaining_notional_krw *= 1 - fraction
        leg.remaining_entry_fee_krw *= 1 - fraction
        remaining -= take
    return allocated_notional, allocated_entry_fee


def close_quantity(
    position: Position,
    quantity: float,
    trigger_price: float,
    timestamp: pd.Timestamp,
    reason: str,
) -> float:
    quantity = min(quantity, position.quantity)
    if quantity <= 1e-12:
        return 0.0
    average_entry_before = position.average_entry
    exit_fill = fill_sell(trigger_price)
    allocated_notional, allocated_entry_fee = consume_position_quantity(position, quantity)
    exit_notional = quantity * exit_fill
    gross = quantity * (exit_fill - average_entry_before)
    exit_fee = fee(exit_notional)
    exit_slippage = quantity * max(0.0, trigger_price - exit_fill)
    net_for_record = gross - allocated_entry_fee - exit_fee
    position.gross_pnl_krw += gross
    position.exit_fees_krw += exit_fee
    position.allocated_entry_fees_krw += allocated_entry_fee
    position.estimated_exit_slippage_krw += exit_slippage
    position.closed_quantity += quantity
    position.last_exit_reason = reason
    position.exit_events.append(
        {
            "time": timestamp.isoformat(),
            "reason": reason,
            "quantity": quantity,
            "trigger_price": trigger_price,
            "exit_fill": exit_fill,
            "gross_pnl_krw": gross,
            "entry_fee_allocated_krw": allocated_entry_fee,
            "exit_fee_krw": exit_fee,
            "net_pnl_krw": net_for_record,
            "released_notional_krw": allocated_notional,
        }
    )
    return gross - exit_fee


def create_position(
    symbol: str,
    signal_time: pd.Timestamp,
    entry_time: pd.Timestamp,
    entry_open: float,
    signal: dict[str, Any],
    plan: dict[str, Any],
    available_margin_krw: float,
) -> Position | None:
    atr_value = float(signal["atr"])
    raw_stop = min(float(signal["swing_low"]), float(signal["support"])) - 0.20 * atr_value
    distance = entry_open - raw_stop
    minimum_distance = 0.80 * atr_value
    maximum_distance = 2.20 * atr_value
    if distance <= 0:
        return None
    if distance < minimum_distance:
        raw_stop = entry_open - minimum_distance
    elif distance > maximum_distance:
        return None
    initial_entry_fill = fill_buy(entry_open)
    initial_stop_fill = fill_sell(raw_stop)
    initial_r = initial_entry_fill - initial_stop_fill
    if initial_r <= 0:
        return None
    first_leg = make_leg(
        1,
        entry_open,
        raw_stop,
        RISK_PER_SETUP_KRW * ENTRY_SPLITS[0],
        MAX_NOTIONAL_KRW * ENTRY_SPLITS[0],
        available_margin_krw,
    )
    if first_leg is None:
        return None
    position = Position(
        symbol=symbol,
        opened_at=entry_time,
        signal_time=signal_time,
        signal_score=float(signal["score"]),
        initial_entry_fill=initial_entry_fill,
        initial_stop_price=raw_stop,
        initial_stop_fill=initial_stop_fill,
        initial_r_price=initial_r,
        initial_atr=atr_value,
        add_levels=(initial_entry_fill + 0.5 * initial_r, initial_entry_fill + 1.0 * initial_r),
        target_levels=tuple(initial_entry_fill + float(r) * initial_r for r in plan["targets"]),
        target_fractions=tuple(float(value) for value in plan["fractions"]),
        stop_price=raw_stop,
        highest_close=entry_open,
    )
    add_leg(position, first_leg, entry_time)
    return position


def setup_record(position: Position, closed_at: pd.Timestamp, timeframe: str, plan_name: str) -> dict[str, Any]:
    entry_fees = position.total_entry_fees
    total_fees = entry_fees + position.exit_fees_krw
    net = position.gross_pnl_krw - total_fees
    slippage = position.total_entry_slippage + position.estimated_exit_slippage_krw
    planned_r = RISK_PER_SETUP_KRW
    return {
        "timeframe": timeframe,
        "plan": plan_name,
        "symbol": position.symbol,
        "signal_time": position.signal_time.isoformat(),
        "opened_at": position.opened_at.isoformat(),
        "closed_at": closed_at.isoformat(),
        "holding_hours": (closed_at - position.opened_at).total_seconds() / 3600,
        "signal_score": position.signal_score,
        "entry_stages": len(position.legs),
        "initial_entry_fill": position.initial_entry_fill,
        "average_entry_final": (
            sum(leg.entry_fill * leg.quantity for leg in position.legs) /
            max(1e-12, sum(leg.quantity for leg in position.legs))
        ),
        "initial_stop_price": position.initial_stop_price,
        "initial_r_price": position.initial_r_price,
        "exit_reason": position.last_exit_reason,
        "gross_pnl_krw": position.gross_pnl_krw,
        "entry_fees_krw": entry_fees,
        "exit_fees_krw": position.exit_fees_krw,
        "total_fees_krw": total_fees,
        "estimated_slippage_krw": slippage,
        "net_pnl_krw": net,
        "net_r": net / planned_r,
        "entry_events": position.entry_events,
        "exit_events": position.exit_events,
    }


def common_timestamps(frames: dict[str, pd.DataFrame], start: pd.Timestamp, end: pd.Timestamp) -> pd.DatetimeIndex:
    common: pd.DatetimeIndex | None = None
    for frame in frames.values():
        index = frame.index[(frame.index >= start) & (frame.index < end)]
        common = index if common is None else common.intersection(index)
    if common is None:
        return pd.DatetimeIndex([], tz="UTC")
    return common.sort_values()


def simulate_portfolio(
    frames: dict[str, pd.DataFrame],
    timeframe: str,
    plan_name: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    plan = EXIT_PLANS[plan_name]
    timestamps = common_timestamps(frames, start, end)
    if len(timestamps) < 300:
        raise BacktestError(f"INSUFFICIENT_COMMON_BARS:{timeframe}:{start}:{end}")
    minutes = int(TIMEFRAMES[timeframe]["minutes"])
    cooldown_bars = max(1, int(COOLDOWN_HOURS * 60 / minutes))
    max_hold_bars = max(1, int(MAX_HOLD_HOURS * 60 / minutes))
    equity = STARTING_CAPITAL_KRW
    peak_equity = equity
    maximum_drawdown_pct = 0.0
    position: Position | None = None
    completed: list[dict[str, Any]] = []
    daily_realized: dict[str, float] = {}
    cooldown_until_index = -1
    entry_bar_index = -1
    consecutive_losses = 0
    maximum_consecutive_losses = 0
    blocked_days: set[str] = set()
    total_lock_triggered = False

    def current_margin() -> float:
        return position.margin_krw if position is not None else 0.0

    def available_margin() -> float:
        return max(0.0, equity - current_margin())

    def complete_position(timestamp: pd.Timestamp) -> None:
        nonlocal position, cooldown_until_index, consecutive_losses, maximum_consecutive_losses
        assert position is not None
        record = setup_record(position, timestamp, timeframe, plan_name)
        completed.append(record)
        day = timestamp.strftime("%Y-%m-%d")
        daily_realized[day] = daily_realized.get(day, 0.0) + float(record["net_pnl_krw"])
        if record["net_pnl_krw"] < 0:
            consecutive_losses += 1
            maximum_consecutive_losses = max(maximum_consecutive_losses, consecutive_losses)
        else:
            consecutive_losses = 0
        position = None
        cooldown_until_index = current_index + cooldown_bars

    for current_index, timestamp in enumerate(timestamps):
        day_key = timestamp.strftime("%Y-%m-%d")
        if daily_realized.get(day_key, 0.0) <= -DAILY_LOSS_LIMIT_KRW:
            blocked_days.add(day_key)
        if equity - STARTING_CAPITAL_KRW <= -TOTAL_LOSS_LIMIT_KRW:
            total_lock_triggered = True

        if position is not None:
            row = frames[position.symbol].loc[timestamp]
            position.highest_close = max(position.highest_close, float(row.close))
            # Intrabar ambiguity is resolved conservatively: stop before add/target.
            if float(row.low) <= position.stop_price:
                equity += close_quantity(position, position.quantity, position.stop_price, timestamp, "STOP")
                complete_position(timestamp)
            else:
                action_taken = False
                if position.next_add_stage <= 3:
                    add_level = position.add_levels[position.next_add_stage - 2]
                    if float(row.high) >= add_level:
                        split = ENTRY_SPLITS[position.next_add_stage - 1]
                        leg = make_leg(
                            position.next_add_stage,
                            add_level,
                            position.stop_price,
                            RISK_PER_SETUP_KRW * split,
                            MAX_NOTIONAL_KRW * split,
                            available_margin(),
                        )
                        if leg is not None:
                            add_leg(position, leg, timestamp)
                            equity -= leg.entry_fee_krw
                        position.next_add_stage += 1
                        action_taken = True
                if not action_taken and position.next_target_index < len(position.target_levels):
                    target = position.target_levels[position.next_target_index]
                    if float(row.high) >= target:
                        fraction = position.target_fractions[position.next_target_index]
                        quantity = position.quantity if position.next_target_index == len(position.target_levels) - 1 else position.quantity * fraction
                        equity += close_quantity(position, quantity, target, timestamp, f"TP{position.next_target_index + 1}")
                        position.next_target_index += 1
                        if position.next_target_index == 1:
                            position.stop_price = max(position.stop_price, position.average_entry)
                        elif position.next_target_index >= 2:
                            position.stop_price = max(position.stop_price, position.initial_entry_fill + position.initial_r_price)
                        if position.quantity <= 1e-12:
                            complete_position(timestamp)
                if position is not None:
                    if position.next_target_index >= 2 and plan.get("trail_after_second_atr"):
                        trailing = position.highest_close - float(plan["trail_after_second_atr"]) * float(row.atr14)
                        position.stop_price = max(position.stop_price, trailing)
                    if current_index - entry_bar_index >= max_hold_bars:
                        equity += close_quantity(position, position.quantity, float(row.close), timestamp, "MAX_HOLD")
                        complete_position(timestamp)

        mark_equity = equity
        if position is not None:
            row = frames[position.symbol].loc[timestamp]
            mark_equity += position.quantity * (float(row.close) - position.average_entry)
        peak_equity = max(peak_equity, mark_equity)
        if peak_equity > 0:
            maximum_drawdown_pct = min(maximum_drawdown_pct, (mark_equity - peak_equity) / peak_equity * 100)

        if position is not None or current_index == 0 or current_index <= cooldown_until_index:
            continue
        if day_key in blocked_days or total_lock_triggered:
            continue
        previous_timestamp = timestamps[current_index - 1]
        candidates: list[tuple[float, float, str, dict[str, Any]]] = []
        for symbol, frame in frames.items():
            signal = signal_from_row(frame.loc[previous_timestamp])
            if not signal["eligible"]:
                continue
            stop_distance_atr = max(0.0, (float(frame.loc[timestamp].open) - float(signal["swing_low"])) / max(float(signal["atr"]), 1e-12))
            candidates.append((float(signal["score"]), -stop_distance_atr, symbol, signal))
        if not candidates:
            continue
        candidates.sort(reverse=True)
        _, _, symbol, signal = candidates[0]
        row = frames[symbol].loc[timestamp]
        new_position = create_position(
            symbol,
            previous_timestamp,
            timestamp,
            float(row.open),
            signal,
            plan,
            available_margin(),
        )
        if new_position is None:
            continue
        position = new_position
        entry_bar_index = current_index
        equity -= position.legs[0].entry_fee_krw
        # Same-entry-bar stop is allowed; targets and additions wait for the next bar.
        if float(row.low) <= position.stop_price:
            equity += close_quantity(position, position.quantity, position.stop_price, timestamp, "ENTRY_BAR_STOP")
            complete_position(timestamp)

    if position is not None:
        timestamp = timestamps[-1]
        row = frames[position.symbol].loc[timestamp]
        equity += close_quantity(position, position.quantity, float(row.close), timestamp, "PERIOD_END")
        complete_position(timestamp)

    wins = [trade for trade in completed if trade["net_pnl_krw"] > 0]
    losses = [trade for trade in completed if trade["net_pnl_krw"] < 0]
    gross_profit = sum(float(trade["net_pnl_krw"]) for trade in wins)
    gross_loss = abs(sum(float(trade["net_pnl_krw"]) for trade in losses))
    total_fees = sum(float(trade["total_fees_krw"]) for trade in completed)
    total_slippage = sum(float(trade["estimated_slippage_krw"]) for trade in completed)
    symbol_pnl = {
        symbol: sum(float(trade["net_pnl_krw"]) for trade in completed if trade["symbol"] == symbol)
        for symbol in SYMBOLS
    }
    result = {
        "timeframe": timeframe,
        "plan": plan_name,
        "period_start": timestamps[0].isoformat(),
        "period_end": timestamps[-1].isoformat(),
        "bars": len(timestamps),
        "initial_equity_krw": STARTING_CAPITAL_KRW,
        "final_equity_krw": equity,
        "net_pnl_krw": equity - STARTING_CAPITAL_KRW,
        "return_pct": (equity / STARTING_CAPITAL_KRW - 1) * 100,
        "trades": len(completed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": len(wins) / len(completed) * 100 if completed else 0.0,
        "profit_factor": gross_profit / gross_loss if gross_loss > 0 else None,
        "average_win_krw": np.mean([trade["net_pnl_krw"] for trade in wins]) if wins else 0.0,
        "average_loss_krw": np.mean([trade["net_pnl_krw"] for trade in losses]) if losses else 0.0,
        "expectancy_per_trade_krw": np.mean([trade["net_pnl_krw"] for trade in completed]) if completed else 0.0,
        "expectancy_r": np.mean([trade["net_r"] for trade in completed]) if completed else 0.0,
        "maximum_drawdown_pct": maximum_drawdown_pct,
        "maximum_consecutive_losses": maximum_consecutive_losses,
        "total_fees_krw": total_fees,
        "estimated_slippage_krw": total_slippage,
        "approx_pre_cost_pnl_krw": equity - STARTING_CAPITAL_KRW + total_fees + total_slippage,
        "daily_lock_days": sorted(blocked_days),
        "total_loss_lock_triggered": total_lock_triggered,
        "symbol_pnl_krw": symbol_pnl,
    }
    return result, completed


def split_folds(start: pd.Timestamp, end: pd.Timestamp) -> list[tuple[str, pd.Timestamp, pd.Timestamp]]:
    span = (end - start) / 3
    return [
        ("FOLD_A_OLDEST", start, start + span),
        ("FOLD_B_MIDDLE", start + span, start + 2 * span),
        ("FOLD_C_LATEST", start + 2 * span, end),
    ]


def safe_pf(value: Any) -> str:
    return "-" if value is None or not math.isfinite(float(value)) else f"{float(value):.3f}"


def run_backtest() -> None:
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": "seungjae-stage7-fixed-risk-backtest/1.0"})
    end_ms = (utc_now_ms() // (15 * 60 * 1000)) * (15 * 60 * 1000)
    start_ms = end_ms - DAYS * 86_400_000
    raw: dict[str, dict[str, pd.DataFrame]] = {}
    source: dict[str, Any] = {}
    for timeframe, cfg in TIMEFRAMES.items():
        raw[timeframe] = {}
        source[timeframe] = {}
        for symbol in SYMBOLS:
            frame = fetch_history(session, symbol, str(cfg["granularity"]), start_ms, end_ms)
            featured = build_features(frame, timeframe)
            raw[timeframe][symbol] = featured
            source[timeframe][symbol] = {
                "candles": len(frame),
                "start": frame.index[0].isoformat(),
                "end": frame.index[-1].isoformat(),
            }
            print(f"fetched {timeframe} {symbol}: {len(frame):,} candles", flush=True)

    full_runs: list[dict[str, Any]] = []
    fold_runs: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    for timeframe, frames in raw.items():
        common_start = max(frame.index[0] for frame in frames.values())
        common_end = min(frame.index[-1] for frame in frames.values()) + pd.Timedelta(minutes=int(TIMEFRAMES[timeframe]["minutes"]))
        folds = split_folds(common_start, common_end)
        for plan_name in EXIT_PLANS:
            result, generated = simulate_portfolio(frames, timeframe, plan_name, common_start, common_end)
            result["scope"] = "FULL"
            full_runs.append(result)
            for trade in generated:
                trade["scope"] = "FULL"
                trades.append(trade)
            for fold_name, fold_start, fold_end in folds:
                fold_result, _ = simulate_portfolio(frames, timeframe, plan_name, fold_start, fold_end)
                fold_result["scope"] = fold_name
                fold_runs.append(fold_result)

    pass_rows: list[dict[str, Any]] = []
    for result in full_runs:
        related_folds = [
            row for row in fold_runs
            if row["timeframe"] == result["timeframe"] and row["plan"] == result["plan"]
        ]
        positive_folds = sum(row["net_pnl_krw"] > 0 for row in related_folds)
        positive_symbols = sum(value > 0 for value in result["symbol_pnl_krw"].values())
        positive_profit = sum(max(0.0, value) for value in result["symbol_pnl_krw"].values())
        largest_symbol_share = (
            max((max(0.0, value) for value in result["symbol_pnl_krw"].values()), default=0.0) / positive_profit
            if positive_profit > 0 else 1.0
        )
        conditions = {
            "net_positive": result["net_pnl_krw"] > 0,
            "profit_factor_at_least_1_30": (result["profit_factor"] or 0) >= 1.30,
            "expectancy_r_positive": result["expectancy_r"] > 0,
            "maximum_drawdown_within_5pct": result["maximum_drawdown_pct"] >= -5.0,
            "at_least_50_trades": result["trades"] >= 50,
            "at_least_2_positive_folds": positive_folds >= 2,
            "at_least_3_profitable_symbols": positive_symbols >= 3,
            "largest_profit_symbol_below_60pct": largest_symbol_share <= 0.60,
        }
        pass_rows.append(
            {
                "timeframe": result["timeframe"],
                "plan": result["plan"],
                "conditions": conditions,
                "passed": all(conditions.values()),
                "positive_folds": positive_folds,
                "positive_symbols": positive_symbols,
                "largest_profit_symbol_share": largest_symbol_share,
            }
        )

    summary = {
        "status": "STAGE7_FIXED_RISK_EXPECTANCY_BACKTEST",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "exchange": "Bitget",
            "endpoint": HISTORY_ENDPOINT,
            "product_type": PRODUCT_TYPE,
            "public_market_data_only": True,
            "symbols": source,
        },
        "policy": {
            "starting_capital_krw": STARTING_CAPITAL_KRW,
            "risk_per_setup_krw": RISK_PER_SETUP_KRW,
            "leverage": LEVERAGE,
            "maximum_margin_krw": MAX_MARGIN_KRW,
            "maximum_notional_krw": MAX_NOTIONAL_KRW,
            "entry_splits": ENTRY_SPLITS,
            "add_only_at_positive_r": ADD_R_LEVELS,
            "fee_bps_per_fill": FEE_BPS,
            "slippage_bps_per_fill": SLIPPAGE_BPS,
            "daily_loss_limit_krw": DAILY_LOSS_LIMIT_KRW,
            "total_loss_limit_krw": TOTAL_LOSS_LIMIT_KRW,
            "maximum_concurrent_positions": 1,
            "short_entries": False,
            "real_orders": False,
        },
        "exit_plans": EXIT_PLANS,
        "full_runs": full_runs,
        "fold_runs": fold_runs,
        "pass_evaluation": pass_rows,
        "limitations": [
            "Historical OI, long/short ratios, order-book depth and liquidation streams are not fabricated and are excluded.",
            "KRW-equivalent sizing uses percentage returns and does not require a fabricated historical USD/KRW rate.",
            "Intrabar ambiguity uses stop-first ordering and one non-stop action per candle.",
            "This test compares three predefined exit plans; it does not tune parameters until profitable.",
            "Simulated performance cannot justify live orders without forward shadow validation.",
        ],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{STEM}.json").write_text(
        json.dumps({"summary": summary, "trades": trades}, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    pd.DataFrame(full_runs + fold_runs).to_csv(OUT / f"{STEM}_RUNS.csv", index=False, encoding="utf-8-sig")
    flat_trades = [
        {key: value for key, value in trade.items() if key not in {"entry_events", "exit_events"}}
        for trade in trades
    ]
    pd.DataFrame(flat_trades).to_csv(OUT / f"{STEM}_TRADES.csv", index=False, encoding="utf-8-sig")

    full_rows = "\n".join(
        f"| {row['timeframe']} | {row['plan']} | {row['net_pnl_krw']:+,.0f}원 | {row['return_pct']:+.2f}% | "
        f"{row['trades']} | {row['win_rate_pct']:.2f}% | {safe_pf(row['profit_factor'])} | "
        f"{row['expectancy_r']:+.3f}R | {row['maximum_drawdown_pct']:.2f}% |"
        for row in full_runs
    )
    fold_rows_md = "\n".join(
        f"| {row['timeframe']} | {row['scope']} | {row['plan']} | {row['net_pnl_krw']:+,.0f}원 | "
        f"{row['trades']} | {safe_pf(row['profit_factor'])} | {row['maximum_drawdown_pct']:.2f}% |"
        for row in fold_runs
    )
    pass_md = "\n".join(
        f"| {row['timeframe']} | {row['plan']} | {'통과' if row['passed'] else '탈락'} | "
        f"{row['positive_folds']}/3 | {row['positive_symbols']}/5 |"
        for row in pass_rows
    )
    best = max(full_runs, key=lambda row: row["net_pnl_krw"])
    markdown = f"""# Bitget 고정위험 기대값 전략 7차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 선물 캔들만 사용했습니다.

- 생성: {summary['generated_at']}
- 목표 수집기간: 최근 {DAYS}일, 실제 확보 범위는 JSON의 종목별 기간 참조
- 종목: {', '.join(SYMBOLS)}
- 시간봉: 15분, 1시간
- 가상 원금: {STARTING_CAPITAL_KRW:,.0f}원
- 거래당 총 계획위험: 최대 {RISK_PER_SETUP_KRW:,.0f}원
- 레버리지: {LEVERAGE:.0f}배, 최대 증거금 {MAX_MARGIN_KRW:,.0f}원
- 분할진입: 30·30·40, +0.5R와 +1R에서만 추가
- 수수료 {FEE_BPS:.0f}bp, 슬리피지 {SLIPPAGE_BPS:.0f}bp를 매 체결에 반영
- 숏·실주문: 차단

## 전체기간 결과
| 시간봉 | 청산안 | 순손익 | 수익률 | 거래 | 승률 | PF | 거래당 기대값 | MDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
{full_rows}

## 구간별 결과
| 시간봉 | 구간 | 청산안 | 순손익 | 거래 | PF | MDD |
|---|---|---|---:|---:|---:|---:|
{fold_rows_md}

## 통과 판정
| 시간봉 | 청산안 | 판정 | 수익 구간 | 수익 종목 |
|---|---|---|---:|---:|
{pass_md}

- 단순 순손익 최고안: **{best['timeframe']} / {best['plan']}**, {best['net_pnl_krw']:+,.0f}원
- 최고안도 모든 통과조건을 만족하지 않으면 실거래 후보가 아닙니다.

## 통과조건

- 수수료·슬리피지 차감 후 순손익 양수
- Profit Factor 1.30 이상
- 거래당 기대값 양수
- 최대낙폭 -5% 이내
- 완료 거래 50회 이상
- 세 구간 중 두 구간 이상 수익
- 다섯 종목 중 세 종목 이상 수익 기여
- 한 종목이 전체 양의 수익의 60%를 초과하지 않음

## 제한

- 과거 OI·롱숏비율·호가 깊이·청산 데이터는 만들어내지 않고 제외했습니다.
- KRW 환산은 가격 수익률 기반 KRW 상당액 방식이라 가짜 환율을 넣지 않았습니다.
- 동일 봉에서 손절과 목표가 모두 닿으면 손절을 먼저 적용했습니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.
"""
    (OUT / f"{STEM}.md").write_text(markdown, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


def self_test() -> None:
    index = pd.date_range("2025-01-01", periods=400, freq="15min", tz="UTC")
    trend = np.linspace(100, 125, len(index))
    wave = np.sin(np.arange(len(index)) / 5) * 0.5
    close = trend + wave
    frame = pd.DataFrame(
        {
            "open": close - 0.08,
            "high": close + 0.30,
            "low": close - 0.30,
            "close": close,
            "volume": 1000 + (np.arange(len(index)) % 11) * 20,
            "quote_volume": close * 1000,
        },
        index=index,
    )
    featured = build_features(frame, "15m")
    assert len(featured) == len(frame)
    assert "high_ema20" in featured.columns
    assert signal_from_row(featured.iloc[-1])["score"] >= 0
    leg = make_leg(1, 100.0, 98.0, 450.0, 45_000.0, 300_000.0)
    assert leg is not None
    stop_loss_with_fees = leg.notional_krw * ((leg.entry_fill - fill_sell(98.0)) / leg.entry_fill) + leg.entry_fee_krw + fee(leg.quantity * fill_sell(98.0))
    assert stop_loss_with_fees <= 450.01
    assert EXIT_PLANS["EXPECTANCY_2R_3R_5R"]["targets"] == (2.0, 3.0, 5.0)
    print("self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        run_backtest()


if __name__ == "__main__":
    main()

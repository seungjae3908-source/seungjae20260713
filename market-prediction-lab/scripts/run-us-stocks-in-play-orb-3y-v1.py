#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

START = pd.Timestamp("2023-04-01", tz="UTC")
END = pd.Timestamp("2026-03-31 23:59:59", tz="UTC")
WARMUP_MONTH = "2023-03"
REPO = "mito0o852/OHLCV-1m"
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/main/data"

MAX_UNIVERSE = 1000
MAX_POSITIONS = 20
MIN_PRICE = 5.0
MIN_AVG_DAILY_VOLUME = 1_000_000.0
MIN_ATR = 0.50
RVOL_THRESHOLD = 1.0
STOP_ATR_MULTIPLE = 0.10
RISK_BUDGET_TOTAL = 0.01
ROUND_TRIP_COST = 0.0020
MAX_ABS_OVERNIGHT_GAP = 0.30

def month_range(start_ym: str, end_ym: str) -> list[str]:
    start = pd.Period(start_ym, freq="M")
    end = pd.Period(end_ym, freq="M")
    out = []
    cur = start
    while cur <= end:
        out.append(str(cur))
        cur += 1
    return out

MONTHS = month_range(WARMUP_MONTH, "2026-03")

def url(month: str) -> str:
    return f"{BASE}/ohlcv_{month}.parquet"

def month_bounds(month: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    p = pd.Period(month, freq="M")
    start = pd.Timestamp(p.start_time, tz="UTC")
    end = pd.Timestamp(p.end_time, tz="UTC")
    return start, end

def open_duckdb():
    con = duckdb.connect()
    con.execute("INSTALL httpfs")
    con.execute("LOAD httpfs")
    con.execute("INSTALL icu")
    con.execute("LOAD icu")
    con.execute("SET enable_progress_bar=false")
    con.execute("SET threads=4")
    con.execute("SET memory_limit='5GB'")
    return con

def daily_stats(con, month: str) -> pd.DataFrame:
    source = url(month)
    query = f"""
    WITH raw AS (
      SELECT
        upper(ticker) AS ticker,
        timezone('America/New_York', timestamp) AS et,
        open, high, low, close, volume
      FROM read_parquet('{source}')
    ),
    regular AS (
      SELECT *,
        CAST(et AS DATE) AS day,
        hour(et) * 60 + minute(et) AS minute_of_day
      FROM raw
      WHERE hour(et) * 60 + minute(et) BETWEEN 570 AND 959
    )
    SELECT
      ticker,
      day,
      arg_min(open, et) AS day_open,
      max(high) AS day_high,
      min(low) AS day_low,
      arg_max(close, et) AS day_close,
      sum(volume) AS day_volume,
      arg_min(open, et) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_open,
      max(high) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_high,
      min(low) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_low,
      arg_max(close, et) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_close,
      sum(volume) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_volume,
      count(*) FILTER (WHERE minute_of_day BETWEEN 570 AND 574) AS or_count,
      count(*) AS regular_minute_count
    FROM regular
    GROUP BY ticker, day
    """
    df = con.execute(query).fetchdf()
    if df.empty:
        raise RuntimeError(f"NO_DAILY_ROWS:{month}")
    df["day"] = pd.to_datetime(df["day"], utc=True)
    return df

def add_prior_features(history: pd.DataFrame) -> pd.DataFrame:
    frames = []
    for ticker, g in history.groupby("ticker", sort=False):
        g = g.sort_values("day").copy()
        prev_close = g["day_close"].shift(1)
        tr = pd.concat([
            g["day_high"] - g["day_low"],
            (g["day_high"] - prev_close).abs(),
            (g["day_low"] - prev_close).abs(),
        ], axis=1).max(axis=1)
        g["atr14"] = tr.shift(1).rolling(14, min_periods=14).mean()
        g["avg_day_volume14"] = g["day_volume"].shift(1).rolling(14, min_periods=14).mean()
        g["avg_or_volume14"] = g["or_volume"].shift(1).rolling(14, min_periods=14).mean()
        g["avg_dollar_volume14"] = (g["day_close"] * g["day_volume"]).shift(1).rolling(14, min_periods=14).mean()
        g["prior_close"] = prev_close
        g["rvol"] = g["or_volume"] / g["avg_or_volume14"].replace(0, np.nan)
        g["overnight_gap"] = g["day_open"] / prev_close - 1
        frames.append(g)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

def select_candidates(featured: pd.DataFrame, month: str) -> pd.DataFrame:
    p = pd.Period(month, freq="M")
    month_start = pd.Timestamp(p.start_time, tz="UTC")
    month_end = pd.Timestamp(p.end_time, tz="UTC")
    cur = featured[(featured["day"] >= month_start) & (featured["day"] <= month_end)].copy()
    cur = cur[
        (cur["or_count"] >= 5)
        & (cur["regular_minute_count"] >= 300)
        & (cur["day_open"] > MIN_PRICE)
        & (cur["avg_day_volume14"] >= MIN_AVG_DAILY_VOLUME)
        & (cur["atr14"] >= MIN_ATR)
        & (cur["rvol"] > RVOL_THRESHOLD)
        & (cur["overnight_gap"].abs() <= MAX_ABS_OVERNIGHT_GAP)
    ].copy()
    if cur.empty:
        return cur

    selected = []
    for day, g in cur.groupby("day"):
        liquid = g.sort_values(["avg_dollar_volume14", "ticker"], ascending=[False, True]).head(MAX_UNIVERSE)
        in_play = liquid.sort_values(["rvol", "ticker"], ascending=[False, True]).head(MAX_POSITIONS)
        in_play = in_play[in_play["or_close"] != in_play["or_open"]].copy()
        if not in_play.empty:
            in_play["side"] = np.where(in_play["or_close"] > in_play["or_open"], 1, -1)
            selected.append(in_play)
    return pd.concat(selected, ignore_index=True) if selected else pd.DataFrame()

def intraday_rows(con, month: str, tickers: list[str]) -> pd.DataFrame:
    if not tickers:
        return pd.DataFrame()
    escaped = ",".join("'" + t.replace("'", "''") + "'" for t in sorted(set(tickers)))
    source = url(month)
    query = f"""
    WITH raw AS (
      SELECT
        upper(ticker) AS ticker,
        timezone('America/New_York', timestamp) AS et,
        open, high, low, close, volume
      FROM read_parquet('{source}')
      WHERE upper(ticker) IN ({escaped})
    )
    SELECT
      ticker,
      et,
      CAST(et AS DATE) AS day,
      hour(et) * 60 + minute(et) AS minute_of_day,
      open, high, low, close, volume
    FROM raw
    WHERE hour(et) * 60 + minute(et) BETWEEN 575 AND 959
    ORDER BY ticker, et
    """
    df = con.execute(query).fetchdf()
    if df.empty:
        return df
    df["day"] = pd.to_datetime(df["day"], utc=True)
    return df

def simulate_month(candidates: pd.DataFrame, bars: pd.DataFrame) -> pd.DataFrame:
    if candidates.empty or bars.empty:
        return pd.DataFrame()
    by_key = {(t, d): g.sort_values("et") for (t, d), g in bars.groupby(["ticker", "day"], sort=False)}
    trades = []
    for row in candidates.itertuples(index=False):
        key = (row.ticker, row.day)
        g = by_key.get(key)
        if g is None or g.empty:
            continue

        side = int(row.side)
        trigger = float(row.or_high if side > 0 else row.or_low)
        stop = float(trigger - STOP_ATR_MULTIPLE * row.atr14 if side > 0 else trigger + STOP_ATR_MULTIPLE * row.atr14)

        entry_idx = None
        entry_price = None
        for idx, bar in g.iterrows():
            if side > 0 and float(bar.high) >= trigger:
                entry_idx = idx
                entry_price = max(trigger, float(bar.open))
                break
            if side < 0 and float(bar.low) <= trigger:
                entry_idx = idx
                entry_price = min(trigger, float(bar.open))
                break
        if entry_idx is None or entry_price is None or entry_price <= 0:
            continue

        stop_distance = abs(entry_price - stop)
        stop_pct = stop_distance / entry_price
        if not np.isfinite(stop_pct) or stop_pct <= 0:
            continue

        # Original sizing: total stop-risk budget 1%, divided across max positions,
        # capped at equal weight.
        risk_weight = (RISK_BUDGET_TOTAL / MAX_POSITIONS) / stop_pct
        weight = min(1.0 / MAX_POSITIONS, risk_weight)
        if weight <= 0:
            continue

        entered = g.loc[g.index >= entry_idx]
        exit_price = float(entered.iloc[-1].close)
        exit_reason = "CLOSE"
        for _, bar in entered.iterrows():
            if side > 0 and float(bar.low) <= stop:
                exit_price = stop
                exit_reason = "STOP"
                break
            if side < 0 and float(bar.high) >= stop:
                exit_price = stop
                exit_reason = "STOP"
                break

        gross = side * (exit_price / entry_price - 1)
        net_asset_return = gross - ROUND_TRIP_COST
        portfolio_return = weight * net_asset_return
        trades.append({
            "day": row.day,
            "ticker": row.ticker,
            "side": side,
            "rvol": float(row.rvol),
            "atr14": float(row.atr14),
            "entry": float(entry_price),
            "stop": float(stop),
            "exit": float(exit_price),
            "exitReason": exit_reason,
            "weight": float(weight),
            "grossAssetReturn": float(gross),
            "netAssetReturn": float(net_asset_return),
            "portfolioReturn": float(portfolio_return),
        })
    return pd.DataFrame(trades)

def compound(values) -> float:
    a = np.asarray(list(values), dtype=float)
    return float(np.prod(1 + a) - 1) if len(a) else 0.0

def stats(series: pd.Series) -> dict:
    if series.empty:
        return {"average": None, "median": None, "latest": None, "positiveRate": None, "best": None, "worst": None, "samples": 0}
    return {
        "average": float(series.mean()),
        "median": float(series.median()),
        "latest": float(series.iloc[-1]),
        "positiveRate": float((series > 0).mean()),
        "best": float(series.max()),
        "worst": float(series.min()),
        "samples": int(len(series)),
    }

def period_table(daily: pd.Series) -> dict:
    daily = daily.sort_index()
    weekly = daily.groupby(daily.index.to_period("W-FRI")).apply(compound)
    monthly = daily.groupby(daily.index.to_period("M")).apply(compound)
    six = ((1 + daily).rolling(126).apply(np.prod, raw=True) - 1).dropna()
    year = ((1 + daily).rolling(252).apply(np.prod, raw=True) - 1).dropna()
    total = compound(daily)
    return {
        "DAILY": stats(daily),
        "WEEKLY": stats(weekly),
        "MONTHLY": stats(monthly),
        "SIX_MONTH": stats(six),
        "YEARLY": stats(year),
        "THREE_YEAR": {
            "average": total, "median": total, "latest": total,
            "positiveRate": 1.0 if total > 0 else 0.0,
            "best": total, "worst": total, "samples": 1,
        },
    }

def overall_metrics(daily: pd.Series, trades: pd.DataFrame) -> dict:
    wealth = (1 + daily).cumprod()
    total = float(wealth.iloc[-1] - 1)
    years = max((daily.index[-1] - daily.index[0]).days / 365.25, 1 / 365.25)
    cagr = float(wealth.iloc[-1] ** (1 / years) - 1) if wealth.iloc[-1] > 0 else -1.0
    std = daily.std(ddof=1)
    sharpe = float(daily.mean() / std * math.sqrt(252)) if std > 0 else None
    peak = wealth.cummax()
    mdd = float(((peak - wealth) / peak).max())
    positive = daily[daily > 0].sum()
    negative = -daily[daily < 0].sum()
    pf = float(positive / negative) if negative > 0 else (999.0 if positive > 0 else 0.0)
    return {
        "tradeCount": int(len(trades)),
        "tradingDays": int((daily != 0).sum()),
        "totalReturn": total,
        "cagr": cagr,
        "sharpe": sharpe,
        "mdd": mdd,
        "dailyProfitFactor": pf,
        "positiveDayRate": float((daily > 0).mean()),
        "stopRate": float((trades["exitReason"] == "STOP").mean()) if len(trades) else None,
        "longRate": float((trades["side"] > 0).mean()) if len(trades) else None,
        "averageTradeNetAssetReturn": float(trades["netAssetReturn"].mean()) if len(trades) else None,
        "averagePortfolioWeight": float(trades["weight"].mean()) if len(trades) else None,
    }

def self_test():
    assert MAX_UNIVERSE == 1000
    assert MAX_POSITIONS == 20
    assert MIN_PRICE == 5.0
    assert MIN_AVG_DAILY_VOLUME == 1_000_000.0
    assert MIN_ATR == 0.50
    assert RVOL_THRESHOLD == 1.0
    assert STOP_ATR_MULTIPLE == 0.10
    assert ROUND_TRIP_COST == 0.0020
    assert abs((RISK_BUDGET_TOTAL / MAX_POSITIONS) - 0.0005) < 1e-12
    print("SELF_TEST_PASS")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/us-stocks-in-play-orb-3y-v1-result.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    con = open_duckdb()
    started = time.time()
    history = pd.DataFrame()
    all_trades = []
    month_audit = []
    all_days: set[pd.Timestamp] = set()

    for index, month in enumerate(MONTHS):
        month_started = time.time()
        daily = daily_stats(con, month)
        history = pd.concat([history, daily], ignore_index=True)
        history = history.sort_values(["ticker", "day"]).drop_duplicates(["ticker", "day"], keep="last")
        # Only a bounded prior window is needed for 14-session features.
        cutoff = daily["day"].max() - pd.Timedelta(days=55)
        feature_input = history[history["day"] >= cutoff].copy()
        featured = add_prior_features(feature_input)

        if month == WARMUP_MONTH:
            month_audit.append({"month": month, "role": "WARMUP", "dailyRows": int(len(daily)), "seconds": time.time()-month_started})
            continue

        for d in daily["day"].unique():
            if START <= d <= END:
                all_days.add(pd.Timestamp(d))

        candidates = select_candidates(featured, month)
        bars = intraday_rows(con, month, candidates["ticker"].unique().tolist() if not candidates.empty else [])
        trades = simulate_month(candidates, bars)
        if not trades.empty:
            all_trades.append(trades)

        month_audit.append({
            "month": month,
            "dailyRows": int(len(daily)),
            "candidateRows": int(len(candidates)),
            "candidateDays": int(candidates["day"].nunique()) if not candidates.empty else 0,
            "candidateSymbols": int(candidates["ticker"].nunique()) if not candidates.empty else 0,
            "trades": int(len(trades)),
            "seconds": time.time()-month_started,
        })
        print(json.dumps(month_audit[-1]), flush=True)

    trades = pd.concat(all_trades, ignore_index=True) if all_trades else pd.DataFrame()
    index = pd.DatetimeIndex(sorted(d for d in all_days if START <= d <= END))
    if trades.empty:
        daily_returns = pd.Series(0.0, index=index)
    else:
        daily_returns = trades.groupby("day")["portfolioReturn"].sum().reindex(index, fill_value=0.0)

    metrics = overall_metrics(daily_returns, trades) if len(daily_returns) else {}
    periods = period_table(daily_returns) if len(daily_returns) else {}
    result = {
        "schemaVersion": 1,
        "contract": "us-stocks-in-play-orb-3y/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {"start": START.isoformat(), "end": END.isoformat(), "months": 36},
        "source": {
            "dataset": REPO,
            "resolution": "1m",
            "providerClaim": "dataset card states original source Finnhub.io",
            "pointInTimeListingMembershipProven": False,
            "securityTypeFilteringAvailable": False,
            "corporateActionAdjustmentProven": False,
        },
        "strategy": {
            "openingRangeMinutes": 5,
            "liquidUniverseSize": MAX_UNIVERSE,
            "maxPositions": MAX_POSITIONS,
            "priceThreshold": MIN_PRICE,
            "prior14dAverageVolumeThreshold": MIN_AVG_DAILY_VOLUME,
            "atr14Threshold": MIN_ATR,
            "relativeOpeningVolumeThreshold": RVOL_THRESHOLD,
            "relativeVolumeLookbackSessions": 14,
            "stopAtrMultiple": STOP_ATR_MULTIPLE,
            "totalPortfolioStopRiskBudget": RISK_BUDGET_TOTAL,
            "maxWeightPerTrade": 1 / MAX_POSITIONS,
            "roundTripCost": ROUND_TRIP_COST,
            "entry": "stop-market proxy at opening-range high/low after 09:35 ET; gap-through uses minute open",
            "exit": "0.1x ATR stop or regular-session close",
            "sameEntryMinuteStopAssumption": "conservative stop if both entry and stop touched in the entry minute",
        },
        "metrics": metrics,
        "periods": periods,
        "monthAudit": month_audit,
        "profitableSurvivor": bool(metrics and metrics.get("totalReturn", 0) > 0 and metrics.get("dailyProfitFactor", 0) > 1 and metrics.get("tradeCount", 0) >= 100),
        "safety": {
            "researchOnly": True,
            "profitabilityProven": False,
            "promotionEligible": False,
            "executionAuthority": "NONE",
            "liveTrading": False,
            "autoTrading": False,
            "realOrderEnabled": False,
        },
        "durationSeconds": time.time()-started,
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "profitableSurvivor": result["profitableSurvivor"],
        "metrics": metrics,
        "periods": {k: {"average":v["average"],"latest":v["latest"],"positiveRate":v["positiveRate"]} for k,v in periods.items()},
        "durationSeconds": result["durationSeconds"],
        "output": str(out),
    }, indent=2))

if __name__ == "__main__":
    main()

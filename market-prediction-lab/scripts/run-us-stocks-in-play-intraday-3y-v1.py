#!/usr/bin/env python3
from __future__ import annotations

import argparse
import calendar
import json
import math
import os
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import requests

DATASET = "mito0o852/OHLCV-1m"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main/data"
COMMISSION_PER_SHARE_SIDE = 0.0035
SLIPPAGE_STRESS_PER_SIDE = 0.0005
STOP_ATR_FRACTION = 0.10
MAX_LEVERAGE = 4.0
RISK_FRACTION_OF_BUCKET = 0.01
TOP_N_MAX = 20

BASE_VARIANTS = [
    {"id": "ORB5_RVOL1_TOP20", "min_rvol": 1.0, "top_n": 20},
    {"id": "ORB5_RVOL1_TOP10", "min_rvol": 1.0, "top_n": 10},
    {"id": "ORB5_RVOL1_TOP5", "min_rvol": 1.0, "top_n": 5},
    {"id": "ORB5_RVOL2_TOP20", "min_rvol": 2.0, "top_n": 20},
    {"id": "ORB5_RVOL5_TOP20", "min_rvol": 5.0, "top_n": 20},
    {"id": "ORB5_RVOL10_TOP20", "min_rvol": 10.0, "top_n": 20},
    {"id": "ORB5_RVOL30_TOP20", "min_rvol": 30.0, "top_n": 20},
]

VARIANTS = [
    *[
        {**variant, "stop_delay_bars": 0, "execution_model": "SAME_MINUTE_STOP_CONSERVATIVE"}
        for variant in BASE_VARIANTS
    ],
    *[
        {
            **variant,
            "id": variant["id"] + "_NEXT_MIN_STOP",
            "stop_delay_bars": 1,
            "execution_model": "QUANTCONNECT_MINUTE_BACKTEST_NEXT_MINUTE_STOP",
        }
        for variant in BASE_VARIANTS
    ],
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "market-prediction-lab/stocks-in-play-intraday-3y-v1"})


def month_floor(ts: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(ts.year, ts.month, 1, tz="UTC")


def previous_month(ts: pd.Timestamp) -> pd.Timestamp:
    return month_floor(ts) - pd.offsets.MonthBegin(1)


def month_iter(start: pd.Timestamp, end: pd.Timestamp):
    cursor = month_floor(start)
    last = month_floor(end)
    while cursor <= last:
        yield cursor
        cursor = cursor + pd.offsets.MonthBegin(1)


def month_url(month: pd.Timestamp) -> str:
    return f"{BASE_URL}/ohlcv_{month.strftime('%Y-%m')}.parquet"


def download_month(month: pd.Timestamp, path: Path) -> dict:
    url = month_url(month)
    last_error = None
    for attempt in range(4):
        try:
            with SESSION.get(url, stream=True, timeout=120, allow_redirects=True) as response:
                response.raise_for_status()
                size = 0
                with path.open("wb") as out:
                    for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                        if not chunk:
                            continue
                        out.write(chunk)
                        size += len(chunk)
                if size < 50_000_000:
                    raise RuntimeError(f"MONTH_FILE_TOO_SMALL:{month.strftime('%Y-%m')}:{size}")
                return {"month": month.strftime("%Y-%m"), "url": url, "bytes": size}
        except Exception as error:
            last_error = error
            if path.exists():
                path.unlink()
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"MONTH_DOWNLOAD_FAILED:{month.strftime('%Y-%m')}:{last_error}")


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    con.execute("SET threads=4")
    return con


def daily_summary(path: Path) -> pd.DataFrame:
    con = connect()
    q = f"""
    WITH base AS (
      SELECT
        upper(ticker) AS ticker,
        timezone('America/New_York', timestamp) AS local_ts,
        open, high, low, close, volume
      FROM read_parquet('{path.as_posix()}')
    ),
    regular AS (
      SELECT *,
        CAST(local_ts AS DATE) AS trade_date,
        CAST(local_ts AS TIME) AS local_time
      FROM base
      WHERE CAST(local_ts AS TIME) >= TIME '09:30:00'
        AND CAST(local_ts AS TIME) <  TIME '16:00:00'
    )
    SELECT
      ticker,
      trade_date,
      arg_min(open, local_ts) AS day_open,
      max(high) AS day_high,
      min(low) AS day_low,
      arg_max(close, local_ts) AS day_close,
      sum(volume) AS day_volume,
      arg_min(open, local_ts) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS or_open,
      max(high) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS or_high,
      min(low) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS or_low,
      arg_max(close, local_ts) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS or_close,
      sum(volume) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS first5_volume,
      count(*) FILTER (
        WHERE local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00'
      ) AS first5_bars
    FROM regular
    WHERE regexp_matches(ticker, '^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    GROUP BY ticker, trade_date
    """
    df = con.execute(q).fetchdf()
    con.close()
    if df.empty:
        raise RuntimeError(f"EMPTY_DAILY_SUMMARY:{path.name}")
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    return df


def with_rolling_metrics(history: pd.DataFrame) -> pd.DataFrame:
    df = history.sort_values(["ticker", "trade_date"]).copy()
    g = df.groupby("ticker", sort=False, group_keys=False)
    prev_close = g["day_close"].shift(1)
    tr = pd.concat(
        [
            (df["day_high"] - df["day_low"]).abs(),
            (df["day_high"] - prev_close).abs(),
            (df["day_low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    df["true_range"] = tr
    df["avg_volume14"] = g["day_volume"].transform(
        lambda s: s.shift(1).rolling(14, min_periods=14).mean()
    )
    df["avg_first5_volume14"] = g["first5_volume"].transform(
        lambda s: s.shift(1).rolling(14, min_periods=14).mean()
    )
    df["atr14"] = df.groupby("ticker", sort=False)["true_range"].transform(
        lambda s: s.shift(1).rolling(14, min_periods=14).mean()
    )
    df["rvol"] = df["first5_volume"] / df["avg_first5_volume14"].replace(0, np.nan)
    df["direction"] = np.where(
        df["or_close"] > df["or_open"], 1,
        np.where(df["or_close"] < df["or_open"], -1, 0),
    )
    return df


def candidate_rows(history: pd.DataFrame, month: pd.Timestamp, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    df = with_rolling_metrics(history)
    month_start = max(month, start)
    month_end = min(month + pd.offsets.MonthBegin(1) - pd.Timedelta(microseconds=1), end)
    mask = (
        (df["trade_date"] >= month_start.tz_localize(None))
        & (df["trade_date"] <= month_end.tz_localize(None))
        & (df["day_open"] > 5.0)
        & (df["avg_volume14"] >= 1_000_000)
        & (df["atr14"] > 0.50)
        & (df["first5_bars"] >= 5)
        & (df["rvol"] >= 1.0)
        & (df["direction"] != 0)
        & np.isfinite(df["rvol"])
    )
    eligible = df.loc[mask].copy()
    if eligible.empty:
        return eligible
    eligible["rank"] = eligible.groupby("trade_date")["rvol"].rank(
        method="first", ascending=False
    )
    eligible = eligible[eligible["rank"] <= TOP_N_MAX].copy()
    eligible["entry_level"] = np.where(
        eligible["direction"] > 0, eligible["or_high"], eligible["or_low"]
    )
    return eligible[
        [
            "ticker", "trade_date", "direction", "entry_level",
            "atr14", "rvol", "rank", "day_open", "avg_volume14",
            "first5_volume", "avg_first5_volume14",
        ]
    ].sort_values(["trade_date", "rank", "ticker"])


def candidate_bars(path: Path, candidates: pd.DataFrame) -> pd.DataFrame:
    if candidates.empty:
        return pd.DataFrame()
    c = candidates.copy()
    c["trade_date"] = pd.to_datetime(c["trade_date"]).dt.date
    con = connect()
    con.register("candidates", c)
    q = f"""
    WITH bars AS (
      SELECT
        upper(m.ticker) AS ticker,
        timezone('America/New_York', m.timestamp) AS local_ts,
        m.open, m.high, m.low, m.close
      FROM read_parquet('{path.as_posix()}') m
    ),
    regular AS (
      SELECT *,
        CAST(local_ts AS DATE) AS trade_date,
        CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:35:00'
        AND CAST(local_ts AS TIME) <  TIME '16:00:00'
    )
    SELECT
      c.ticker, c.trade_date, c.direction, c.entry_level, c.atr14,
      c.rvol, c.rank,
      r.local_ts, r.open, r.high, r.low, r.close
    FROM regular r
    INNER JOIN candidates c
      ON r.ticker = c.ticker AND r.trade_date = c.trade_date
    ORDER BY c.trade_date, c.rank, c.ticker, r.local_ts
    """
    df = con.execute(q).fetchdf()
    con.close()
    return df


def simulate_one(group: pd.DataFrame, stop_delay_bars: int = 0) -> dict:
    first = group.iloc[0]
    direction = int(first["direction"])
    level = float(first["entry_level"])
    atr = float(first["atr14"])
    stop_distance = STOP_ATR_FRACTION * atr
    if not (level > 0 and atr > 0 and stop_distance > 0):
        return {"triggered": False}

    if direction > 0:
        trigger_mask = group["high"] >= level
    else:
        trigger_mask = group["low"] <= level
    idxs = np.flatnonzero(trigger_mask.to_numpy())
    if len(idxs) == 0:
        return {"triggered": False}

    entry_idx = int(idxs[0])
    entry_bar = group.iloc[entry_idx]
    if direction > 0:
        fill = max(level, float(entry_bar["open"]))
        stop = fill - stop_distance
    else:
        fill = min(level, float(entry_bar["open"]))
        stop = fill + stop_distance
    if fill <= 0 or stop <= 0:
        return {"triggered": False}

    leverage = min(MAX_LEVERAGE, RISK_FRACTION_OF_BUCKET / (stop_distance / fill))
    stop_start = min(entry_idx + max(0, int(stop_delay_bars)), len(group) - 1)
    after = group.iloc[stop_start:]
    stop_hit = False
    exit_price = float(group.iloc[-1]["close"])
    exit_time = group.iloc[-1]["local_ts"]
    for row in after.itertuples(index=False):
        if direction > 0 and float(row.low) <= stop:
            exit_price = min(stop, float(row.open)) if float(row.open) < stop else stop
            exit_time = row.local_ts
            stop_hit = True
            break
        if direction < 0 and float(row.high) >= stop:
            exit_price = max(stop, float(row.open)) if float(row.open) > stop else stop
            exit_time = row.local_ts
            stop_hit = True
            break

    raw = direction * (exit_price / fill - 1.0)
    gross_bucket = leverage * raw
    commission = 2.0 * COMMISSION_PER_SHARE_SIDE * leverage / fill
    stress_slippage = 2.0 * SLIPPAGE_STRESS_PER_SIDE * leverage
    return {
        "triggered": True,
        "direction": direction,
        "fill": fill,
        "exit": exit_price,
        "leverage": leverage,
        "raw_return": raw,
        "bucket_commission_only": gross_bucket - commission,
        "bucket_stress_5bps": gross_bucket - commission - stress_slippage,
        "stop_hit": stop_hit,
        "entry_time": str(entry_bar["local_ts"]),
        "exit_time": str(exit_time),
    }


def variant_members(candidates: pd.DataFrame, variant: dict) -> pd.DataFrame:
    if candidates.empty:
        return candidates.copy()
    x = candidates[
        (candidates["rvol"] >= variant["min_rvol"])
        & (candidates["rank"] <= variant["top_n"])
    ].copy()
    return x


def process_month(
    path: Path,
    history: pd.DataFrame,
    month: pd.Timestamp,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[pd.DataFrame, list[dict], dict]:
    summary = daily_summary(path)
    combined = pd.concat([history, summary], ignore_index=True)
    candidates = candidate_rows(combined, month, start, end)
    bars = candidate_bars(path, candidates)

    sim = {}
    if not bars.empty:
        stop_delays = sorted({int(v.get("stop_delay_bars", 0)) for v in VARIANTS})
        for (trade_date, ticker), group in bars.groupby(["trade_date", "ticker"], sort=False):
            for stop_delay in stop_delays:
                sim[(pd.Timestamp(trade_date), ticker, stop_delay)] = simulate_one(
                    group,
                    stop_delay_bars=stop_delay,
                )

    trading_dates = sorted(
        d for d in summary["trade_date"].drop_duplicates().tolist()
        if start.tz_localize(None) <= d <= end.tz_localize(None)
    )
    daily_rows = []
    trade_rows = []

    for variant in VARIANTS:
        members = variant_members(candidates, variant)
        by_date = {d: g for d, g in members.groupby("trade_date")}
        for d in trading_dates:
            group = by_date.get(d)
            commission_only = 0.0
            stress5 = 0.0
            candidate_count = 0
            triggered_count = 0
            if group is not None:
                candidate_count = len(group)
                # Each selected stock gets one of 20 capital slots; unused slots stay in cash.
                for row in group.itertuples(index=False):
                    result = sim.get(
                        (
                            pd.Timestamp(row.trade_date),
                            row.ticker,
                            int(variant.get("stop_delay_bars", 0)),
                        ),
                        {"triggered": False},
                    )
                    if not result.get("triggered"):
                        continue
                    triggered_count += 1
                    commission_only += float(result["bucket_commission_only"]) / TOP_N_MAX
                    stress5 += float(result["bucket_stress_5bps"]) / TOP_N_MAX
                    trade_rows.append({
                        "variant": variant["id"],
                        "trade_date": str(pd.Timestamp(row.trade_date).date()),
                        "ticker": row.ticker,
                        "rvol": float(row.rvol),
                        "rank": float(row.rank),
                        "execution_model": variant.get("execution_model"),
                        "stop_delay_bars": int(variant.get("stop_delay_bars", 0)),
                        **result,
                    })
            daily_rows.append({
                "variant": variant["id"],
                "trade_date": str(pd.Timestamp(d).date()),
                "commission_only": commission_only,
                "stress_5bps": stress5,
                "candidate_count": candidate_count,
                "triggered_count": triggered_count,
            })

    carry = combined.sort_values(["ticker", "trade_date"]).groupby("ticker", group_keys=False).tail(20)
    audit = {
        "month": month.strftime("%Y-%m"),
        "dailySummaryRows": int(len(summary)),
        "candidateRowsTop20": int(len(candidates)),
        "candidateDates": int(candidates["trade_date"].nunique()) if not candidates.empty else 0,
        "intradayCandidateBars": int(len(bars)),
        "tickersWithDailyBars": int(summary["ticker"].nunique()),
    }
    return carry, daily_rows, trade_rows, audit


def run_chunk(start: pd.Timestamp, end: pd.Timestamp, output: Path) -> None:
    warmup_month = previous_month(start)
    history = pd.DataFrame()
    all_daily = []
    all_trades = []
    audits = []
    downloads = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for month in month_iter(warmup_month, end):
            file = root / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            meta = download_month(month, file)
            downloads.append(meta)
            history, daily_rows, trade_rows, audit = process_month(
                file, history, month, start, end
            )
            all_daily.extend(daily_rows)
            all_trades.extend(trade_rows)
            audits.append(audit)
            print(json.dumps(audit), flush=True)
            file.unlink(missing_ok=True)

    payload = {
        "schemaVersion": 1,
        "contract": "stocks-in-play-intraday-chunk/v1",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "daily": all_daily,
        "trades": all_trades,
        "audits": audits,
        "downloads": downloads,
        "assumptions": {
            "sourceDataset": DATASET,
            "openingRangeMinutes": 5,
            "averageVolumeDays": 14,
            "averageFirst5VolumeDays": 14,
            "atrDays": 14,
            "minimumOpenPrice": 5.0,
            "minimumAverageDailyVolume": 1_000_000,
            "minimumAtr": 0.50,
            "minimumRelativeVolume": 1.0,
            "topStocks": 20,
            "stopAtrFraction": STOP_ATR_FRACTION,
            "riskFractionOfBucket": RISK_FRACTION_OF_BUCKET,
            "maxLeverage": MAX_LEVERAGE,
            "commissionPerSharePerSide": COMMISSION_PER_SHARE_SIDE,
            "slippageStressPerSide": SLIPPAGE_STRESS_PER_SIDE,
            "gapAwareStopOrderFill": True,
            "sameMinuteEntryStopAmbiguity": "CONSERVATIVE_STOP_ASSUMED_IF_BOTH_TOUCHED",
            "shortBorrowAvailabilityModeled": False,
            "shortBorrowCostIncluded": False,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def compound(series: pd.Series) -> float:
    return float(np.prod(1.0 + series.to_numpy()) - 1.0)


def stats(series: pd.Series) -> dict:
    if series.empty:
        return {
            "samples": 0, "average": None, "median": None,
            "latest": None, "positiveRate": None, "best": None, "worst": None,
        }
    return {
        "samples": int(len(series)),
        "average": float(series.mean()),
        "median": float(series.median()),
        "latest": float(series.iloc[-1]),
        "positiveRate": float((series > 0).mean()),
        "best": float(series.max()),
        "worst": float(series.min()),
    }


def portfolio_metrics(daily: pd.Series) -> dict:
    daily = daily.sort_index()
    wealth = (1 + daily).cumprod()
    total = float(wealth.iloc[-1] - 1.0)
    years = max((daily.index[-1] - daily.index[0]).days / 365.25, 1 / 365.25)
    cagr = float(wealth.iloc[-1] ** (1 / years) - 1) if wealth.iloc[-1] > 0 else -1.0
    sd = float(daily.std(ddof=1))
    sharpe = float(daily.mean() / sd * math.sqrt(252)) if sd > 0 else None
    peak = wealth.cummax()
    mdd = float(((peak - wealth) / peak).max())
    pos = float(daily[daily > 0].sum())
    neg = float(-daily[daily < 0].sum())
    return {
        "totalReturn": total,
        "cagr": cagr,
        "sharpe": sharpe,
        "mdd": mdd,
        "dailyProfitFactor": pos / neg if neg > 0 else (999.0 if pos > 0 else 0.0),
        "positiveTradingDayRate": float((daily > 0).mean()),
    }


def period_metrics(daily: pd.Series) -> dict:
    daily = daily.sort_index()
    weekly = daily.groupby(daily.index.to_period("W-FRI")).apply(compound)
    monthly = daily.groupby(daily.index.to_period("M")).apply(compound)
    six = ((1 + daily).rolling(126).apply(np.prod, raw=True) - 1).dropna()
    yearly = ((1 + daily).rolling(252).apply(np.prod, raw=True) - 1).dropna()
    total = compound(daily)
    return {
        "DAILY": stats(daily),
        "WEEKLY": stats(weekly),
        "MONTHLY": stats(monthly),
        "SIX_MONTH": stats(six),
        "YEARLY": stats(yearly),
        "THREE_YEAR": {
            "samples": 1,
            "average": total,
            "median": total,
            "latest": total,
            "positiveRate": 1.0 if total > 0 else 0.0,
            "best": total,
            "worst": total,
        },
    }


def combine(input_dir: Path, output: Path) -> None:
    files = sorted(input_dir.rglob("*.json"))
    chunks = [json.loads(p.read_text()) for p in files if "chunk" in p.name]
    if len(chunks) != 3:
        raise RuntimeError(f"EXPECTED_THREE_CHUNKS:{len(chunks)}:{[str(p) for p in files]}")
    daily = pd.DataFrame([row for chunk in chunks for row in chunk["daily"]])
    trades = [row for chunk in chunks for row in chunk["trades"]]
    daily["trade_date"] = pd.to_datetime(daily["trade_date"])
    if daily.duplicated(["variant", "trade_date"]).any():
        raise RuntimeError("DUPLICATE_VARIANT_DATE")

    results = []
    for variant in VARIANTS:
        vid = variant["id"]
        rows = daily[daily["variant"] == vid].sort_values("trade_date")
        commission = rows.set_index("trade_date")["commission_only"]
        stress = rows.set_index("trade_date")["stress_5bps"]
        trade_count = sum(1 for t in trades if t["variant"] == vid)
        triggered_days = int((rows["triggered_count"] > 0).sum())
        source_metrics = portfolio_metrics(commission)
        stress_metrics = portfolio_metrics(stress)
        periods = period_metrics(stress)
        results.append({
            "variant": vid,
            "settings": variant,
            "tradeCount": trade_count,
            "triggeredDays": triggered_days,
            "commissionOnly": source_metrics,
            "stress5bpsPerSide": stress_metrics,
            "periodsStress5bps": periods,
            "survivor": (
                stress_metrics["totalReturn"] > 0
                and stress_metrics["dailyProfitFactor"] > 1
                and stress_metrics["mdd"] < 0.70
                and trade_count >= 100
            ),
        })

    survivors = sorted(
        [r for r in results if r["survivor"]],
        key=lambda r: (
            r["stress5bpsPerSide"]["totalReturn"],
            r["stress5bpsPerSide"]["sharpe"] or -99,
        ),
        reverse=True,
    )
    report = {
        "schemaVersion": 1,
        "contract": "us-stocks-in-play-intraday-3y/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {
            "start": "2023-04-01",
            "end": "2026-03-31",
            "exactThreeCalendarYears": True,
        },
        "source": {
            "dataset": DATASET,
            "modality": "public 1-minute OHLCV monthly parquet",
            "originalSourceReportedByDataset": "Finnhub.io",
            "historicalBarUniverse": True,
            "pointInTimeListingMembershipProven": False,
            "delistedCoverageProven": False,
        },
        "methodology": {
            "sourceFaithfulSignalRules": True,
            "openingRange": "09:30-09:35 America/New_York",
            "relativeVolume": "first5 volume / prior 14 trading days average first5 volume",
            "direction": "first5 candle sign",
            "entry": "stop at first5 high for bullish or low for bearish",
            "stop": "10% of prior-14-day ATR from executed entry",
            "exit": "stop or end-of-day close",
            "riskSizing": "1% bucket stop-risk with max 4x leverage; 20 fixed capital slots",
            "paperCommission": "$0.0035/share/side",
            "extraStress": "5 bps slippage/side",
            "slippageInOriginalPaper": False,
            "shortBorrowAvailabilityModeled": False,
            "multipleVariantsPredeclared": [v["id"] for v in VARIANTS],
            "executionModelSensitivity": [
                "same-minute stop conservative",
                "next-minute stop activation matching QuantConnect minute-resolution implementation behavior",
            ],
            "untouchedFinalHoldout": False,
        },
        "results": results,
        "profitableSurvivorsOnly": survivors,
        "chunkAudits": [a for chunk in chunks for a in chunk["audits"]],
        "safety": {
            "researchOnly": True,
            "profitabilityProven": False,
            "economicCreditGranted": False,
            "promotionEligible": False,
            "executionAuthority": "NONE",
            "liveTrading": False,
            "autoTrading": False,
            "realOrderEnabled": False,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "survivors": survivors,
        "resultCount": len(results),
        "tradeRows": len(trades),
        "output": str(output),
    }, indent=2))


def self_test() -> None:
    # Position sizing: a stop-out cannot lose more than 1% of one capital bucket
    # before commission/slippage, and leverage cannot exceed 4x.
    fill = 100.0
    stop_distance = 1.0
    leverage = min(MAX_LEVERAGE, RISK_FRACTION_OF_BUCKET / (stop_distance / fill))
    assert abs(leverage - 1.0) < 1e-12
    assert leverage * (stop_distance / fill) <= 0.0100000001
    assert MAX_LEVERAGE == 4.0
    assert STOP_ATR_FRACTION == 0.10
    assert len(VARIANTS) == len(BASE_VARIANTS) * 2
    assert {v["stop_delay_bars"] for v in VARIANTS} == {0, 1}
    print("SELF_TEST_PASS")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["chunk", "combine", "self-test"], required=True)
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--input-dir")
    parser.add_argument("--output", required=False)
    args = parser.parse_args()
    if args.mode == "self-test":
        self_test()
        return
    if args.mode == "chunk":
        if not args.start or not args.end or not args.output:
            raise SystemExit("chunk requires --start --end --output")
        run_chunk(
            pd.Timestamp(args.start, tz="UTC"),
            pd.Timestamp(args.end + " 23:59:59", tz="UTC"),
            Path(args.output),
        )
        return
    if not args.input_dir or not args.output:
        raise SystemExit("combine requires --input-dir --output")
    combine(Path(args.input_dir), Path(args.output))


if __name__ == "__main__":
    main()

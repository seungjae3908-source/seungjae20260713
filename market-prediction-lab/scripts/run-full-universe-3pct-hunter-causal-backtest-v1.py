#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
CENSUS_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-census-v2.py"
SPEC = importlib.util.spec_from_file_location("full_universe_census_v2", CENSUS_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CENSUS_IMPORT_FAILED")
census = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(census)

MARKETS = ("US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES")
COSTS = {
    "US_STOCK": 0.0020,
    "KR_STOCK": 0.0030,
    "CRYPTO_SPOT": 0.0020,
    "CRYPTO_FUTURES": 0.0012,
}
THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]
WINDOWS = {
    "US_STOCK": [("1D",1),("1W",5),("1M",21),("3M",63),("6M",126),("1Y",252),("3Y",None)],
    "KR_STOCK": [("1D",1),("1W",5),("1M",21),("3M",63),("6M",126),("1Y",252),("3Y",None)],
    "CRYPTO_SPOT": [("1D",1),("1W",7),("1M",30),("3M",90),("6M",183),("1Y",365),("3Y",None)],
    "CRYPTO_FUTURES": [("1D",1),("1W",7),("1M",30),("3M",90),("6M",183),("1Y",365),("3Y",None)],
}
ALLOWED_DIRECTIONS = {
    "US_STOCK": {"LONG"},
    "KR_STOCK": {"LONG"},
    "CRYPTO_SPOT": {"LONG"},
    "CRYPTO_FUTURES": {"LONG", "SHORT"},
}
SOURCE_CENSUS_RUN_ID = 37384183815


def load_kr_fast() -> tuple[pl.DataFrame, dict]:
    from pykrx import stock

    dates = pd.date_range(census.START.date(), (census.END_EXCLUSIVE - pd.Timedelta(days=1)).date(), freq="B")

    def fetch_day(dt):
        key = dt.strftime("%Y%m%d")
        last = None
        for attempt in range(4):
            try:
                frame = stock.get_market_ohlcv_by_ticker(key, market="ALL")
                if frame is None or frame.empty:
                    return key, [], None
                frame = frame.reset_index()
                ticker_col = frame.columns[0]
                required = ["시가", "고가", "저가", "종가", "거래량"]
                if not all(col in frame.columns for col in required):
                    return key, [], f"schema:{list(frame.columns)[:12]}"
                rows = []
                for r in frame[[ticker_col, *required]].itertuples(index=False, name=None):
                    sym, o, h, l, close, v = r
                    try:
                        o, h, l, close, v = float(o), float(h), float(l), float(close), float(v)
                    except Exception:
                        continue
                    if min(o, h, l, close) <= 0 or v < 0:
                        continue
                    rows.append((str(sym).zfill(6), dt.date(), o, h, l, close, v))
                return key, rows, None
            except Exception as exc:
                last = exc
                time.sleep(0.8 * (attempt + 1))
        return key, [], str(last)[:180]

    all_rows = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_day, dt): dt for dt in dates}
        for idx, future in enumerate(concurrent.futures.as_completed(futures), 1):
            key, rows, error = future.result()
            if rows:
                all_rows.extend(rows)
            if error:
                failures.append({"date": key, "error": error})
            if idx % 50 == 0:
                print(json.dumps({
                    "krFastDatesComplete": idx,
                    "rows": len(all_rows),
                    "failures": len(failures),
                }), flush=True)

    if len(all_rows) < 300_000:
        print(json.dumps({
            "krFastFallbackAttempted": True,
            "rows": len(all_rows),
            "failures": len(failures),
        }), flush=True)
        return census.load_kr()

    return (
        pl.DataFrame(
            all_rows,
            schema=["symbol","date","open","high","low","close","volume"],
            orient="row",
        ),
        {
            "provider": "pykrx/KRX",
            "coverageMode": "DAILY_ALL_MARKET_KOSPI_KOSDAQ_KONEX_PARALLEL4",
            "failedBusinessDates": len(failures),
            "failurePreview": failures[:10],
        },
    )


def assert_source_coverage(market: str, source_meta: dict) -> None:
    mode = str(source_meta.get("coverageMode") or "")
    if market == "KR_STOCK":
        if "ALL_MARKET" not in mode or "FALLBACK" in mode:
            raise RuntimeError(f"KR_FULL_UNIVERSE_COVERAGE_REQUIRED:{mode}")
    elif market == "US_STOCK":
        if int(source_meta.get("monthCount") or 0) < 34:
            raise RuntimeError(f"US_MONTH_COVERAGE_TOO_LOW:{source_meta.get('monthCount')}")
    else:
        if int(source_meta.get("usableFiles") or 0) <= 0:
            raise RuntimeError(f"{market}_SOURCE_FILES_MISSING")


def assert_direction_policy(trades: pl.DataFrame, market: str) -> dict:
    observed = set(trades.get_column("direction").unique().to_list()) if trades.height else set()
    forbidden = observed - ALLOWED_DIRECTIONS[market]
    if forbidden:
        raise RuntimeError(f"DIRECTION_POLICY_VIOLATION:{market}:{sorted(forbidden)}")
    if market != "CRYPTO_FUTURES" and "SHORT" in observed:
        raise RuntimeError(f"SHORT_FORBIDDEN:{market}")
    return {
        "allowed": sorted(ALLOWED_DIRECTIONS[market]),
        "observed": sorted(observed),
        "verified": True,
    }


def add_preopen_features(df: pl.DataFrame) -> pl.DataFrame:
    x = df.sort(["symbol","date"])
    x = x.with_columns([
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(2).over("symbol").alias("close_2ago"),
        pl.col("low").shift(1).rolling_min(window_size=20, min_samples=5).over("symbol").alias("prior_low20"),
    ])
    x = x.with_columns([
        pl.max_horizontal(
            (pl.col("prev_high") - pl.col("prev_low")).abs(),
            (pl.col("prev_high") - pl.col("close_2ago")).abs(),
            (pl.col("prev_low") - pl.col("close_2ago")).abs(),
        ).alias("prev_true_range"),
        ((pl.col("prev_high") - pl.col("prev_low")) / pl.col("prev_close")).alias("prev_range_pct"),
        (pl.col("prev_close") / pl.col("prior_low20") - 1.0).alias("distance_prior_low20"),
    ])
    x = x.with_columns(
        pl.col("prev_true_range")
        .rolling_mean(window_size=14, min_samples=10)
        .over("symbol")
        .truediv(pl.col("prev_close"))
        .alias("prior_atr_pct")
    )
    return x


def tradable_mask(market: str) -> pl.Expr:
    common = (
        pl.col("prev_close").is_not_null()
        & pl.col("ret5_prev").is_not_null()
        & pl.col("ret20_prev").is_not_null()
        & pl.col("prior_rvol").is_not_null()
        & pl.col("prior_atr_pct").is_not_null()
        & pl.col("prior_dollar_volume20").is_not_null()
    )
    if market == "US_STOCK":
        return (
            common
            & ~pl.col("symbol").str.contains(r"^(ZVZZ|ZWZZ)")
            & (pl.col("prev_close") >= 2.0)
            & (pl.col("prior_dollar_volume20") >= 10_000_000)
        )
    if market == "KR_STOCK":
        return common & (pl.col("prev_close") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 1_000_000_000)
    return common & (pl.col("prior_dollar_volume20") >= 5_000_000)


def add_scores(df: pl.DataFrame, market: str) -> pl.DataFrame:
    # Entry scores are strictly prior-session information. Current-day open/gap is excluded.
    atr_floor = 0.015 if market in ("US_STOCK", "KR_STOCK") else 0.020
    long_score = (
        (pl.col("prior_rvol") >= 1.20).cast(pl.Int8)
        + (pl.col("ret5_prev") >= 0.02).cast(pl.Int8)
        + (pl.col("ret20_prev") >= 0.05).cast(pl.Int8)
        + (pl.col("distance_prior_high20") >= -0.05).cast(pl.Int8)
        + (pl.col("prev_range_pct") <= pl.col("prior_atr_pct") * 0.90).cast(pl.Int8)
        + (pl.col("prior_atr_pct") >= atr_floor).cast(pl.Int8)
    )
    event_long = (
        (pl.col("prior_rvol") >= 2.0)
        & (pl.col("ret5_prev") >= 0.03)
        & (pl.col("distance_prior_high20") >= -0.03)
    )
    x = df.with_columns([
        long_score.alias("long_score"),
        event_long.alias("event_long"),
    ])
    if market == "CRYPTO_FUTURES":
        short_score = (
            (pl.col("prior_rvol") >= 1.20).cast(pl.Int8)
            + (pl.col("ret5_prev") <= -0.02).cast(pl.Int8)
            + (pl.col("ret20_prev") <= -0.05).cast(pl.Int8)
            + (pl.col("distance_prior_low20") <= 0.05).cast(pl.Int8)
            + (pl.col("prev_range_pct") <= pl.col("prior_atr_pct") * 0.90).cast(pl.Int8)
            + (pl.col("prior_atr_pct") >= atr_floor).cast(pl.Int8)
        )
        x = x.with_columns([
            short_score.alias("short_score"),
            (
                (pl.col("prior_rvol") >= 2.0)
                & (pl.col("ret5_prev") <= -0.03)
                & (pl.col("distance_prior_low20") <= 0.03)
            ).alias("event_short"),
        ])
    return x


def variant_rows(df: pl.DataFrame, market: str, variant: str) -> pl.DataFrame:
    if variant == "PRESSURE4":
        long_mask = pl.col("long_score") >= 4
    elif variant == "PRESSURE5":
        long_mask = pl.col("long_score") >= 5
    elif variant == "PRESSURE4_EVENT":
        long_mask = (pl.col("long_score") >= 4) | pl.col("event_long")
    else:
        raise ValueError(variant)

    longs = (
        df.filter(long_mask)
        .with_columns([
            pl.lit("LONG").alias("direction"),
            pl.lit(variant).alias("variant"),
            pl.col("long_score").cast(pl.Int16).alias("score"),
            pl.col("event_long").alias("eventLane"),
            pl.concat_str([
                pl.lit(variant),
                pl.lit("|score="),
                pl.col("long_score").cast(pl.Utf8),
                pl.lit("|event="),
                pl.col("event_long").cast(pl.Utf8),
            ]).alias("entryReason"),
        ])
    )
    if market != "CRYPTO_FUTURES":
        return longs

    if variant == "PRESSURE4":
        short_mask = pl.col("short_score") >= 4
    elif variant == "PRESSURE5":
        short_mask = pl.col("short_score") >= 5
    else:
        short_mask = (pl.col("short_score") >= 4) | pl.col("event_short")

    shorts = (
        df.filter(short_mask)
        .with_columns([
            pl.lit("SHORT").alias("direction"),
            pl.lit(variant).alias("variant"),
            pl.col("short_score").cast(pl.Int16).alias("score"),
            pl.col("event_short").alias("eventLane"),
            pl.concat_str([
                pl.lit(variant),
                pl.lit("|score="),
                pl.col("short_score").cast(pl.Utf8),
                pl.lit("|event="),
                pl.col("event_short").cast(pl.Utf8),
            ]).alias("entryReason"),
        ])
    )
    return pl.concat([longs, shorts], how="vertical")


def simulate(rows: pl.DataFrame, market: str) -> pl.DataFrame:
    if rows.is_empty():
        return rows
    cost = COSTS[market]
    stop_pct = pl.col("prior_atr_pct").mul(0.50).clip(0.01, 0.04)
    if market == "CRYPTO_FUTURES":
        stop_pct = pl.col("prior_atr_pct").mul(0.45).clip(0.01, 0.035)

    long_stop_hit = pl.col("low") <= pl.col("open") * (1.0 - stop_pct)
    short_stop_hit = pl.col("high") >= pl.col("open") * (1.0 + stop_pct)
    stop_hit = pl.when(pl.col("direction") == "LONG").then(long_stop_hit).otherwise(short_stop_hit)

    exit_price = (
        pl.when(pl.col("direction") == "LONG")
        .then(
            pl.when(long_stop_hit)
            .then(pl.col("open") * (1.0 - stop_pct))
            .otherwise(pl.col("close"))
        )
        .otherwise(
            pl.when(short_stop_hit)
            .then(pl.col("open") * (1.0 + stop_pct))
            .otherwise(pl.col("close"))
        )
    )
    gross_return = (
        pl.when(pl.col("direction") == "LONG")
        .then(exit_price / pl.col("open") - 1.0)
        .otherwise(1.0 - exit_price / pl.col("open"))
    )
    mfe = (
        pl.when(pl.col("direction") == "LONG")
        .then(pl.col("high") / pl.col("open") - 1.0)
        .otherwise(1.0 - pl.col("low") / pl.col("open"))
    )
    mae = (
        pl.when(pl.col("direction") == "LONG")
        .then(1.0 - pl.col("low") / pl.col("open"))
        .otherwise(pl.col("high") / pl.col("open") - 1.0)
    )

    return rows.with_columns([
        pl.lit(market).alias("market"),
        pl.col("open").alias("entryPrice"),
        stop_pct.alias("stopPct"),
        stop_hit.alias("stopHit"),
        exit_price.alias("exitPrice"),
        pl.when(stop_hit).then(pl.lit("ATR_STOP")).otherwise(pl.lit("EOD_CLOSE")).alias("exitReason"),
        pl.lit(cost).alias("roundTripCost"),
        gross_return.alias("grossReturn"),
        (gross_return - cost).alias("netReturn"),
        mfe.alias("MFE"),
        mae.alias("MAE"),
        pl.lit("FULL_DAY_OHLC_DIAGNOSTIC").alias("excursionScope"),
    ])


def compound(values: list[float]) -> float:
    wealth = 1.0
    for value in values:
        wealth *= 1.0 + float(value)
    return wealth - 1.0


def longest_negative_streak(values: list[float]) -> int:
    current = 0
    best = 0
    for value in values:
        if float(value) < 0:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def metrics(trades: pl.DataFrame, market: str, all_dates: list | None = None) -> dict:
    if trades.is_empty():
        daily = pd.DataFrame(columns=["date","portfolioReturn","trades"])
    else:
        daily = (
            trades.group_by("date")
            .agg([
                pl.col("netReturn").mean().alias("portfolioReturn"),
                pl.len().alias("trades"),
            ])
            .sort("date")
            .to_pandas()
        )
        daily["date"] = pd.to_datetime(daily["date"])

    if all_dates is not None:
        calendar = pd.DatetimeIndex(pd.to_datetime(sorted(all_dates)))
        if daily.empty:
            daily = pd.DataFrame({"date": calendar, "portfolioReturn": 0.0, "trades": 0})
        else:
            daily = (
                daily.set_index("date")
                .reindex(calendar)
                .rename_axis("date")
                .reset_index()
            )
            daily["portfolioReturn"] = daily["portfolioReturn"].fillna(0.0)
            daily["trades"] = daily["trades"].fillna(0).astype(int)

    if daily.empty:
        windows = {
            label: {"startDate":None,"endDate":None,"marketDays":0,"return":0.0,"tradeCount":0}
            for label, _ in WINDOWS[market]
        }
        base = {
            "tradeCount": 0,
            "activeDays": 0,
            "marketDays": 0,
            "totalReturn": 0.0,
            "mdd": 0.0,
            "winRate": None,
            "profitFactor": None,
            "monthsPositive": 0,
            "monthsNegative": 0,
            "monthsFlat": 0,
            "monthsTotal": 0,
            "positiveMonthRate": None,
            "bestMonth": None,
            "bestMonthReturn": None,
            "worstMonth": None,
            "worstMonthReturn": None,
            "longestLosingMonthStreak": 0,
            "windows": windows,
        }
        for threshold in THRESHOLDS:
            key = int(threshold * 100)
            base[f"days{key}pctPlus"] = 0
            base[f"months{key}pctPlus"] = 0
            base[f"tradeMFE{key}pctPlus"] = 0
            base[f"tradeNet{key}pctPlus"] = 0
        return base

    returns = daily["portfolioReturn"].astype(float).tolist()
    wealth_curve = []
    wealth = 1.0
    peak = 1.0
    mdd = 0.0
    for r in returns:
        wealth *= 1.0 + float(r)
        wealth_curve.append(wealth)
        peak = max(peak, wealth)
        mdd = max(mdd, (peak - wealth) / peak)

    if trades.is_empty():
        tnet = np.array([], dtype=float)
        tmfe = np.array([], dtype=float)
    else:
        tnet = trades.get_column("netReturn").to_numpy()
        tmfe = trades.get_column("MFE").to_numpy()
    pos = float(tnet[tnet > 0].sum()) if np.any(tnet > 0) else 0.0
    neg = float(-tnet[tnet < 0].sum()) if np.any(tnet < 0) else 0.0

    daily["month"] = daily["date"].dt.to_period("M")
    monthly = daily.groupby("month")["portfolioReturn"].apply(
        lambda s: float(np.prod(1.0 + s.to_numpy()) - 1.0)
    )

    dates = [d.date() for d in daily["date"].tolist()]
    windows = {}
    for label, n in WINDOWS[market]:
        selected = dates if n is None else dates[-n:]
        if selected:
            start = pd.Timestamp(selected[0])
            end = pd.Timestamp(selected[-1])
            sub = daily.loc[(daily["date"] >= start) & (daily["date"] <= end)]
        else:
            sub = daily.iloc[0:0]
        w = {
            "startDate": str(selected[0]) if selected else None,
            "endDate": str(selected[-1]) if selected else None,
            "marketDays": len(selected),
            "return": compound(sub["portfolioReturn"].tolist()) if len(sub) else 0.0,
            "tradeCount": int(sub["trades"].sum()) if len(sub) else 0,
            "positiveDays": int((sub["portfolioReturn"] > 0).sum()) if len(sub) else 0,
            "negativeDays": int((sub["portfolioReturn"] < 0).sum()) if len(sub) else 0,
        }
        for threshold in THRESHOLDS:
            key = int(threshold * 100)
            w[f"days{key}pctPlus"] = int((sub["portfolioReturn"] >= threshold).sum()) if len(sub) else 0
        windows[label] = w

    result = {
        "tradeCount": int(trades.height),
        "activeDays": int((daily["trades"] > 0).sum()),
        "marketDays": int(len(daily)),
        "totalReturn": float(wealth_curve[-1] - 1.0),
        "mdd": float(mdd),
        "winRate": float((tnet > 0).mean()) if len(tnet) else None,
        "profitFactor": (pos / neg if neg > 0 else (999.0 if pos > 0 else 0.0)),
        "monthsPositive": int((monthly > 0).sum()),
        "monthsNegative": int((monthly < 0).sum()),
        "monthsFlat": int((monthly == 0).sum()),
        "monthsTotal": int(len(monthly)),
        "positiveMonthRate": float((monthly > 0).mean()) if len(monthly) else None,
        "bestMonth": str(monthly.idxmax()) if len(monthly) else None,
        "bestMonthReturn": float(monthly.max()) if len(monthly) else None,
        "worstMonth": str(monthly.idxmin()) if len(monthly) else None,
        "worstMonthReturn": float(monthly.min()) if len(monthly) else None,
        "longestLosingMonthStreak": longest_negative_streak(monthly.tolist()),
        "windows": windows,
    }
    for threshold in THRESHOLDS:
        key = int(threshold * 100)
        result[f"days{key}pctPlus"] = int((daily["portfolioReturn"] >= threshold).sum())
        result[f"months{key}pctPlus"] = int((monthly >= threshold).sum())
        result[f"tradeMFE{key}pctPlus"] = int((tmfe >= threshold).sum()) if len(tmfe) else 0
        result[f"tradeNet{key}pctPlus"] = int((tnet >= threshold).sum()) if len(tnet) else 0
    return result


def write_portfolio_series(trades: pl.DataFrame, market_dates: list, out: Path) -> None:
    if trades.is_empty():
        daily = pd.DataFrame({
            "date": pd.to_datetime(sorted(market_dates)),
            "portfolioReturn": 0.0,
            "trades": 0,
        })
    else:
        daily = (
            trades.group_by("date")
            .agg([
                pl.col("netReturn").mean().alias("portfolioReturn"),
                pl.len().alias("trades"),
            ])
            .sort("date")
            .to_pandas()
        )
        daily["date"] = pd.to_datetime(daily["date"])
        calendar = pd.DatetimeIndex(pd.to_datetime(sorted(market_dates)))
        daily = daily.set_index("date").reindex(calendar).rename_axis("date").reset_index()
        daily["portfolioReturn"] = daily["portfolioReturn"].fillna(0.0)
        daily["trades"] = daily["trades"].fillna(0).astype(int)

    daily["wealth"] = (1.0 + daily["portfolioReturn"]).cumprod()
    daily.to_csv(out / "daily-portfolio.csv", index=False)

    monthly = (
        daily.assign(month=daily["date"].dt.to_period("M").astype(str))
        .groupby("month", as_index=False)
        .agg(
            return_=("portfolioReturn", lambda s: float(np.prod(1.0 + s.to_numpy()) - 1.0)),
            trades=("trades","sum"),
        )
        .rename(columns={"return_":"return"})
    )
    monthly.to_csv(out / "monthly-portfolio.csv", index=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True, choices=MARKETS)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    market = args.market
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if market == "US_STOCK":
        loaded, source_meta = census.load_us()
    elif market == "KR_STOCK":
        loaded, source_meta = load_kr_fast()
    elif market == "CRYPTO_SPOT":
        loaded, source_meta = census.load_crypto("CRYPTO_SPOT")
    else:
        loaded, source_meta = census.load_crypto("CRYPTO_FUTURES")

    assert_source_coverage(market, source_meta)

    raw = census.add_features(loaded, market)
    raw = add_preopen_features(raw).filter(tradable_mask(market))
    raw = add_scores(raw, market)

    market_dates = raw.select("date").unique().sort("date").get_column("date").to_list()
    if not market_dates:
        raise RuntimeError(f"NO_TRADABLE_MARKET_DATES:{market}")

    variants = {}
    ledgers = {}
    direction_audits = {}
    for variant in ("PRESSURE4","PRESSURE5","PRESSURE4_EVENT"):
        trades = simulate(variant_rows(raw, market, variant), market)
        direction_audits[variant] = assert_direction_policy(trades, market)
        variants[variant] = metrics(trades, market, market_dates)
        ledgers[variant] = trades

    # Freeze the variant using only the first two years, prioritizing monthly consistency.
    boundary = pd.Timestamp("2025-04-01").date()
    pre_dates = [d for d in market_dates if d < boundary]
    test_dates = [d for d in market_dates if d >= boundary]
    selection_audit = []
    ranking_rows = []
    for variant, trades in ledgers.items():
        pre = trades.filter(pl.col("date") < pl.lit(boundary))
        m = metrics(pre, market, pre_dates)
        months_total = max(int(m.get("monthsTotal") or 0), 1)
        positive_month_ratio = float(m.get("monthsPositive") or 0) / months_total
        month3_ratio = float(m.get("months3pctPlus") or 0) / months_total
        row = {
            "variant": variant,
            "positiveMonthRatio": positive_month_ratio,
            "month3pctPlusRatio": month3_ratio,
            "totalReturn": float(m.get("totalReturn") or 0.0),
            "mdd": float(m.get("mdd") or 0.0),
            "tradeCount": int(m.get("tradeCount") or 0),
            "monthsPositive": int(m.get("monthsPositive") or 0),
            "monthsTotal": int(m.get("monthsTotal") or 0),
            "worstMonthReturn": m.get("worstMonthReturn"),
            "longestLosingMonthStreak": int(m.get("longestLosingMonthStreak") or 0),
        }
        selection_audit.append(row)
        ranking_rows.append((
            variant,
            positive_month_ratio,
            month3_ratio,
            float(m.get("totalReturn") or 0.0),
            -float(m.get("mdd") or 0.0),
            int(m.get("tradeCount") or 0),
        ))

    selected = sorted(ranking_rows, key=lambda x: (x[1],x[2],x[3],x[4],x[5],x[0]), reverse=True)[0][0]
    selected_trades = ledgers[selected].sort(["date","symbol","direction"])
    selected_direction_audit = assert_direction_policy(selected_trades, market)

    test_trades = selected_trades.filter(pl.col("date") >= pl.lit(boundary))
    heldout = metrics(test_trades, market, test_dates)

    if market == "CRYPTO_FUTURES":
        selected_direction_breakdown = {
            direction: metrics(
                selected_trades.filter(pl.col("direction") == direction),
                market,
                market_dates,
            )
            for direction in ("LONG","SHORT")
        }
        heldout_direction_breakdown = {
            direction: metrics(
                test_trades.filter(pl.col("direction") == direction),
                market,
                test_dates,
            )
            for direction in ("LONG","SHORT")
        }
    else:
        selected_direction_breakdown = {
            "LONG": metrics(selected_trades, market, market_dates)
        }
        heldout_direction_breakdown = {
            "LONG": heldout
        }

    pd.DataFrame(selection_audit).to_csv(out / "selection-audit-first-two-years.csv", index=False)

    ledger_columns = [
        "market","date","symbol","direction","variant","score","eventLane",
        "entryPrice","exitPrice","grossReturn","roundTripCost","netReturn",
        "MFE","MAE","excursionScope","entryReason","exitReason",
        "open","high","low","close","gap","ret5_prev","ret20_prev","prior_rvol",
        "prior_dollar_volume20","distance_prior_high20","distance_prior_low20",
        "prior_atr_pct","prev_range_pct","stopPct","stopHit",
    ]
    selected_trades.select(ledger_columns).write_csv(out / "selected-ledger.csv")
    selected_trades.select(ledger_columns).write_parquet(out / "selected-ledger.parquet", compression="zstd")
    write_portfolio_series(selected_trades, market_dates, out)

    report = {
        "schemaVersion": 2,
        "contract": "full-universe-3pct-hunter-causal-backtest-v1",
        "market": market,
        "sourceCensusRunId": SOURCE_CENSUS_RUN_ID,
        "directionPolicy": "LONG_SHORT" if market == "CRYPTO_FUTURES" else "LONG_ONLY",
        "directionPolicyAuditByVariant": direction_audits,
        "selectedDirectionPolicyAudit": selected_direction_audit,
        "source": source_meta,
        "period": {
            "start": str(census.START.date()),
            "endExclusive": str(census.END_EXCLUSIVE.date()),
            "effectiveTradableStart": str(market_dates[0]),
            "selectionHistoryEndExclusive": str(boundary),
            "heldoutStart": str(boundary),
        },
        "execution": {
            "entry": "market-on-open proxy using prior-session-only signal; same-day open is used only as fill price",
            "signalUsesSameDayGap": False,
            "gapColumnPurpose": "diagnostic only; excluded from entry score and event lane",
            "stop": "0.5x prior ATR%, clipped 1-4%; futures 0.45x clipped 1-3.5%",
            "ambiguity": "STOP_FIRST_CONSERVATIVE",
            "exit": "same-day close if stop not touched",
            "portfolio": "all qualifying signals, equal-weight gross exposure 100% per market/day; no fixed Top-N",
            "leverage": "NONE; futures results are unlevered underlying-return diagnostics",
            "roundTripCost": COSTS[market],
            "mfeMaeScope": "full-day OHLC diagnostic; intraday ordering is unknown",
        },
        "variants": variants,
        "selectionAuditFirstTwoYears": selection_audit,
        "selectedVariantFromFirstTwoYears": selected,
        "selectedObservedThreeYear": variants[selected],
        "selectedDirectionBreakdownThreeYear": selected_direction_breakdown,
        "heldoutLastYear": heldout,
        "heldoutDirectionBreakdownLastYear": heldout_direction_breakdown,
        "truthBoundary": {
            "lookaheadInEntryFeatures": False,
            "signalUsesSameDayOpenOrGap": False,
            "sameDayOpenUsedOnlyAsFillProxy": True,
            "dailyOHLCOrderKnown": False,
            "stopFirstUsed": True,
            "intradayTMinusSignalsProven": False,
            "independentOos": False,
            "heldoutLastYearExcludedFromVariantSelection": True,
            "sourceCensusRunPinned": True,
            "providerDatasetSnapshotHashProven": False,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": report}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

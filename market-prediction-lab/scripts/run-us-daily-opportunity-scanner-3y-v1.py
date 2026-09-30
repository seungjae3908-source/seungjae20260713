#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import re
import concurrent.futures
from huggingface_hub import snapshot_download
from sklearn.ensemble import HistGradientBoostingRegressor

START = pd.Timestamp("2023-09-26", tz="UTC")
END = pd.Timestamp("2026-09-25 23:59:59", tz="UTC")
WARMUP = pd.Timestamp("2023-07-14", tz="UTC")
STOOQ_URL = "https://static.stooq.com/db/h/d_us_txt.zip"

ROUND_TRIP_COST = 0.0020
MIN_PRICE = 2.0
MIN_AVG_DOLLAR_VOLUME = 1_000_000.0
MIN_GAP = 0.015
MAX_GAP = 0.30
MAX_DAILY_SELECTIONS = 3
THRESHOLDS = [0.002, 0.004, 0.006, 0.008, 0.010, 0.015, 0.020]

BASIC_FEATURES = [
    "gap", "prior_rvol", "prior_log_dollar_volume",
    "ret1_prev", "ret5_prev", "ret20_prev",
    "ema10_ratio_prev", "ema20_ratio_prev", "ema50_ratio_prev",
    "rsi14_prev", "atr_pct_prev", "vol_z20_prev",
    "body_prev", "range_prev", "close_location_prev",
]
RICH_FEATURES = BASIC_FEATURES + [
    "channel_pos20_prev", "bos_up_prev", "bos_down_prev",
    "pullback_from_high_prev", "bounce_from_low_prev",
    "bullish_engulfing_prev", "bearish_engulfing_prev",
    "inside_bar_prev", "bullish_pin_prev", "bearish_pin_prev",
    "bullish_harami_prev", "bearish_harami_prev",
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "market-prediction-lab/us-daily-opportunity-scanner-v1"})


def download_bulk(path: Path) -> None:
    with SESSION.get(STOOQ_URL, stream=True, timeout=120) as response:
        response.raise_for_status()
        ctype = str(response.headers.get("content-type", "")).lower()
        if "html" in ctype:
            raise RuntimeError("STOOQ_BULK_HTML_CHALLENGE")
        size = 0
        with path.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)
                    size += len(chunk)
        if size < 10_000_000:
            raise RuntimeError(f"STOOQ_BULK_TOO_SMALL:{size}")


def catalog_us_stock_symbols() -> list[str]:
    path = Path("api-server/src/data/catalog.ts")
    text = path.read_text(encoding="utf-8")
    stock_section = text.split("// US ETF / leveraged / inverse", 1)[0]
    symbols = re.findall(r'ticker:\s*"([^"]+)"[^\n]+market:\s*"US"', stock_section)
    return sorted({s.strip().upper() for s in symbols if s.strip()})


def yahoo_symbol_history(symbol: str) -> pd.DataFrame:
    hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]
    params = {
        "period1": int(WARMUP.timestamp()),
        "period2": int((END + pd.Timedelta(days=2)).timestamp()),
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    }
    last = None
    for attempt in range(6):
        host = hosts[attempt % len(hosts)]
        try:
            response = SESSION.get(
                f"{host}/v8/finance/chart/{symbol}",
                params=params,
                timeout=20,
            )
            if response.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP_{response.status_code}")
            response.raise_for_status()
            payload = response.json()
            result = payload.get("chart", {}).get("result")
            if not result:
                raise RuntimeError("YAHOO_EMPTY_RESULT")
            row = result[0]
            quote = row.get("indicators", {}).get("quote", [{}])[0]
            timestamps = row.get("timestamp") or []
            frame = pd.DataFrame({
                "symbol": symbol,
                "timestamp": pd.to_datetime(timestamps, unit="s", utc=True),
                "open": quote.get("open", []),
                "high": quote.get("high", []),
                "low": quote.get("low", []),
                "close": quote.get("close", []),
                "volume": quote.get("volume", []),
            })
            frame = frame.dropna(subset=["open", "high", "low", "close", "volume"])
            frame = frame[(frame.timestamp >= WARMUP) & (frame.timestamp <= END)]
            if len(frame) < 80:
                raise RuntimeError("YAHOO_HISTORY_TOO_SHORT")
            return frame.sort_values("timestamp").reset_index(drop=True)
        except Exception as error:
            last = error
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"YAHOO_FAILED:{symbol}:{last}")


def load_stratos_us_universe() -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    url = "https://huggingface.co/datasets/stratos-org/ohlcv-750/resolve/main/data/ohlcv.parquet?download=true"
    response = SESSION.get(url, timeout=120)
    response.raise_for_status()
    if len(response.content) < 5_000_000:
        raise RuntimeError(f"STRATOS_PARQUET_TOO_SMALL:{len(response.content)}")
    frame = pd.read_parquet(io.BytesIO(response.content))
    required = {"ticker", "market", "date", "open", "high", "low", "close", "volume"}
    if not required.issubset(set(frame.columns)):
        raise RuntimeError(f"STRATOS_SCHEMA_MISMATCH:{sorted(frame.columns)}")
    frame = frame[frame["market"].astype(str).str.upper().eq("US")].copy()
    frame["timestamp"] = pd.to_datetime(frame["date"], utc=True, errors="coerce")
    frame["symbol"] = frame["ticker"].astype(str).str.upper()
    frame = frame.dropna(subset=["timestamp", "open", "high", "low", "close", "volume"])
    frame = frame[(frame.timestamp >= WARMUP) & (frame.timestamp <= END)]
    if frame["symbol"].nunique() < 100:
        raise RuntimeError(f"STRATOS_US_SYMBOL_COVERAGE_TOO_LOW:{frame['symbol'].nunique()}")

    candidates = []
    trading_dates: set[pd.Timestamp] = set()
    candidate_symbols = 0
    for symbol, g in frame.groupby("symbol", sort=False):
        g = g[["symbol", "timestamp", "open", "high", "low", "close", "volume"]].sort_values("timestamp").reset_index(drop=True)
        if len(g) < 60:
            continue
        for dt in g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist():
            trading_dates.add(dt)
        cand = candidate_features(g)
        if not cand.empty:
            candidate_symbols += 1
            candidates.append(cand)
    if not candidates:
        raise RuntimeError("NO_STRATOS_DAILY_MOVER_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(trading_dates), {
        "datasetRows": int(len(frame)),
        "usableSymbols": int(frame["symbol"].nunique()),
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
    }


def load_hf_yahoo_universe() -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    local_dir = Path(snapshot_download(
        repo_id="AmirTrader/YahooFinance",
        repo_type="dataset",
        allow_patterns=["data/daily/*.parquet"],
    ))
    files = sorted((local_dir / "data" / "daily").glob("*.parquet"))
    if len(files) < 100:
        raise RuntimeError(f"HF_DAILY_FILE_COUNT_TOO_LOW:{len(files)}")

    candidates = []
    trading_dates: set[pd.Timestamp] = set()
    usable = 0
    candidate_symbols = 0
    failures = []

    for index, file in enumerate(files, 1):
        symbol = file.stem.upper()
        try:
            g = pd.read_parquet(
                file,
                columns=["date", "open", "high", "low", "close", "volume"],
            )
            g = g.rename(columns={"date": "timestamp"})
            g["timestamp"] = pd.to_datetime(g["timestamp"], utc=True, errors="coerce")
            g["symbol"] = symbol
            g = g.dropna(subset=["timestamp", "open", "high", "low", "close", "volume"])
            g = g[(g.timestamp >= WARMUP) & (g.timestamp <= END)]
            if len(g) < 80:
                continue
            g = g[["symbol", "timestamp", "open", "high", "low", "close", "volume"]].sort_values("timestamp").reset_index(drop=True)
            usable += 1
            for dt in g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist():
                trading_dates.add(dt)
            cand = candidate_features(g)
            if not cand.empty:
                candidate_symbols += 1
                candidates.append(cand)
        except Exception as error:
            failures.append({"symbol": symbol, "error": str(error)[:300]})
        if index % 1000 == 0:
            print(json.dumps({"hfFilesParsed": index, "usableSymbols": usable, "candidateSymbols": candidate_symbols}), flush=True)

    if not candidates:
        raise RuntimeError("NO_HF_DAILY_MOVER_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(trading_dates), {
        "requestedFiles": len(files),
        "usableSymbols": usable,
        "failedSymbols": len(failures),
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
        "failurePreview": failures[:10],
    }


def load_catalog_yahoo_universe() -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    symbols = catalog_us_stock_symbols()
    frames = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        future_map = {pool.submit(yahoo_symbol_history, symbol): symbol for symbol in symbols}
        for future in concurrent.futures.as_completed(future_map):
            symbol = future_map[future]
            try:
                frames.append(future.result())
            except Exception as error:
                failures.append({"symbol": symbol, "error": str(error)})
    if len(frames) < 25:
        raise RuntimeError(f"YAHOO_CATALOG_COVERAGE_TOO_LOW:{len(frames)}")

    candidates = []
    trading_dates: set[pd.Timestamp] = set()
    candidate_symbols = 0
    for g in frames:
        for dt in g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist():
            trading_dates.add(dt)
        cand = candidate_features(g)
        if not cand.empty:
            candidate_symbols += 1
            candidates.append(cand)
    if not candidates:
        raise RuntimeError("NO_YAHOO_DAILY_MOVER_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(trading_dates), {
        "requestedSymbols": len(symbols),
        "usableSymbols": len(frames),
        "failedSymbols": len(failures),
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
        "failurePreview": failures[:10],
    }


def ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=span).mean()


def rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    down = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = up / down.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def parse_symbol_file(raw: bytes) -> pd.DataFrame:
    text = raw.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    if len(lines) < 80:
        return pd.DataFrame()
    # 2022-2026 requires fewer than ~1,250 US sessions. Keep a bounded tail.
    tail = lines[-1450:]
    rows = []
    for line in tail:
        if not line or line.startswith("<TICKER>"):
            continue
        parts = line.split(",")
        if len(parts) < 9:
            continue
        try:
            date = pd.to_datetime(parts[2], format="%Y%m%d", utc=True)
            if date < WARMUP or date > END:
                continue
            o, h, l, c = map(float, parts[4:8])
            v = float(parts[8])
        except Exception:
            continue
        if min(o, h, l, c) <= 0 or v < 0 or h < max(o, c) or l > min(o, c):
            continue
        rows.append((str(parts[0]).upper(), date, o, h, l, c, v))
    if len(rows) < 80:
        return pd.DataFrame()
    return pd.DataFrame(rows, columns=["symbol", "timestamp", "open", "high", "low", "close", "volume"]).sort_values("timestamp").reset_index(drop=True)


def candidate_features(g: pd.DataFrame) -> pd.DataFrame:
    g = g.copy().sort_values("timestamp").reset_index(drop=True)
    o, h, l, c, v = g.open, g.high, g.low, g.close, g.volume
    prev_c = c.shift(1)
    prev_o = o.shift(1)
    prev_h = h.shift(1)
    prev_l = l.shift(1)

    dollar_volume = c * v
    g["gap"] = o / prev_c - 1
    g["prior_avg_dollar_volume"] = dollar_volume.shift(1).rolling(20).mean()
    g["prior_log_dollar_volume"] = np.log1p(g["prior_avg_dollar_volume"])
    g["prior_rvol"] = v.shift(1) / v.shift(2).rolling(20).mean().replace(0, np.nan)

    g["ret1_prev"] = c.shift(1) / c.shift(2) - 1
    g["ret5_prev"] = c.shift(1) / c.shift(6) - 1
    g["ret20_prev"] = c.shift(1) / c.shift(21) - 1

    for span in [10, 20, 50]:
        g[f"ema{span}_ratio_prev"] = (c / ema(c, span) - 1).shift(1)
    g["rsi14_prev"] = rsi(c, 14).shift(1)

    tr = pd.concat([(h - l), (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    g["atr_pct_prev"] = (atr / c).shift(1)
    g["vol_z20_prev"] = ((v - v.rolling(20).mean()) / v.rolling(20).std().replace(0, np.nan)).shift(1)

    prior_range = (prev_h - prev_l).replace(0, np.nan)
    g["body_prev"] = prev_c / prev_o - 1
    g["range_prev"] = (prev_h - prev_l) / c.shift(2)
    g["close_location_prev"] = (prev_c - prev_l) / prior_range

    # Objective wave/structure proxy, all known before today's open.
    prior_high20 = h.shift(1).rolling(20).max()
    prior_low20 = l.shift(1).rolling(20).min()
    channel = (prior_high20 - prior_low20).replace(0, np.nan)
    g["channel_pos20_prev"] = (prev_c - prior_low20) / channel
    prior_resistance = h.shift(2).rolling(20).max()
    prior_support = l.shift(2).rolling(20).min()
    g["bos_up_prev"] = (prev_c > prior_resistance).astype(float)
    g["bos_down_prev"] = (prev_c < prior_support).astype(float)
    g["pullback_from_high_prev"] = (prior_high20 - prev_c) / atr.shift(1).replace(0, np.nan)
    g["bounce_from_low_prev"] = (prev_c - prior_low20) / atr.shift(1).replace(0, np.nan)

    po2, pc2, ph2, pl2 = o.shift(2), c.shift(2), h.shift(2), l.shift(2)
    pbull, pbear = prev_c > prev_o, prev_c < prev_o
    p2bull, p2bear = pc2 > po2, pc2 < po2
    g["bullish_engulfing_prev"] = (pbull & p2bear & (prev_o <= pc2) & (prev_c >= po2)).astype(float)
    g["bearish_engulfing_prev"] = (pbear & p2bull & (prev_o >= pc2) & (prev_c <= po2)).astype(float)
    g["inside_bar_prev"] = ((prev_h < ph2) & (prev_l > pl2)).astype(float)
    body = (prev_c - prev_o).abs()
    upper = prev_h - pd.concat([prev_o, prev_c], axis=1).max(axis=1)
    lower = pd.concat([prev_o, prev_c], axis=1).min(axis=1) - prev_l
    g["bullish_pin_prev"] = ((body / prior_range <= .35) & (lower >= body * 2) & (lower >= upper * 1.5)).astype(float)
    g["bearish_pin_prev"] = ((body / prior_range <= .35) & (upper >= body * 2) & (upper >= lower * 1.5)).astype(float)
    g["bullish_harami_prev"] = (p2bear & pbull & (prev_o >= pc2) & (prev_c <= po2)).astype(float)
    g["bearish_harami_prev"] = (p2bull & pbear & (prev_o <= pc2) & (prev_c >= po2)).astype(float)

    # Entry is today's open, exit today's close.
    g["gross_return"] = c / o - 1
    g["prior_close"] = prev_c

    candidate = (
        (g["timestamp"] >= WARMUP)
        & (g["gap"].abs() >= MIN_GAP)
        & (g["gap"].abs() <= MAX_GAP)
        & (g["prior_close"] >= MIN_PRICE)
        & (g["prior_avg_dollar_volume"] >= MIN_AVG_DOLLAR_VOLUME)
        & np.isfinite(g["prior_rvol"])
    )
    keep = ["symbol", "timestamp", "gross_return", "prior_close"] + sorted(set(BASIC_FEATURES + RICH_FEATURES))
    return g.loc[candidate, keep].replace([np.inf, -np.inf], np.nan).dropna().copy()


def load_universe(zip_path: Path) -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    candidates = []
    trading_dates: set[pd.Timestamp] = set()
    stock_files = 0
    usable_symbols = 0
    candidate_symbols = 0

    with zipfile.ZipFile(zip_path) as z:
        names = [
            n for n in z.namelist()
            if n.lower().endswith(".txt")
            and "/us/" in n.lower()
            and " stocks/" in n.lower()
            and "etfs/" not in n.lower()
        ]
        stock_files = len(names)
        for idx, name in enumerate(names, 1):
            try:
                g = parse_symbol_file(z.read(name))
            except Exception:
                continue
            if g.empty:
                continue
            usable_symbols += 1
            for dt in g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist():
                trading_dates.add(dt)
            cand = candidate_features(g)
            if not cand.empty:
                candidate_symbols += 1
                candidates.append(cand)
            if idx % 1000 == 0:
                print(json.dumps({"parsedFiles": idx, "candidateSymbols": candidate_symbols}), flush=True)

    if not candidates:
        raise RuntimeError("NO_DAILY_MOVER_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(trading_dates), {
        "zipStockFiles": stock_files,
        "usableSymbols": usable_symbols,
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
    }


def metrics_from_daily(daily: pd.Series, trade_count: int) -> dict:
    daily = daily.sort_index().astype(float)
    wealth = (1 + daily).cumprod()
    total = float(wealth.iloc[-1] - 1) if len(wealth) else 0.0
    years = max((daily.index[-1] - daily.index[0]).days / 365.25, 1 / 365.25) if len(daily) > 1 else 1 / 365.25
    cagr = float(wealth.iloc[-1] ** (1 / years) - 1) if len(wealth) and wealth.iloc[-1] > 0 else -1.0
    std = daily.std(ddof=1)
    sharpe = float(daily.mean() / std * math.sqrt(252)) if len(daily) > 1 and std > 0 else None
    peak = wealth.cummax()
    mdd = float(((peak - wealth) / peak).max()) if len(wealth) else 0.0
    positive = daily[daily > 0].sum()
    negative = -daily[daily < 0].sum()
    pf = float(positive / negative) if negative > 0 else (999.0 if positive > 0 else 0.0)
    return {
        "tradeCount": int(trade_count),
        "totalReturn": total,
        "cagr": cagr,
        "sharpe": sharpe,
        "mdd": mdd,
        "dailyProfitFactor": pf,
        "positiveTradingDayRate": float((daily > 0).mean()),
    }


def compound_period(group: pd.Series) -> float:
    return float(np.prod(1 + group.to_numpy()) - 1)


def period_table(daily: pd.Series) -> dict:
    daily = daily.sort_index()
    weekly = daily.groupby(daily.index.to_period("W-FRI")).apply(compound_period)
    monthly = daily.groupby(daily.index.to_period("M")).apply(compound_period)

    def rolling_returns(window: int) -> pd.Series:
        return (1 + daily).rolling(window).apply(np.prod, raw=True) - 1

    six = rolling_returns(126).dropna()
    year = rolling_returns(252).dropna()

    def stats(s: pd.Series) -> dict:
        if s.empty:
            return {"average": None, "median": None, "latest": None, "positiveRate": None, "best": None, "worst": None, "samples": 0}
        return {
            "average": float(s.mean()),
            "median": float(s.median()),
            "latest": float(s.iloc[-1]),
            "positiveRate": float((s > 0).mean()),
            "best": float(s.max()),
            "worst": float(s.min()),
            "samples": int(len(s)),
        }

    three = compound_period(daily)
    return {
        "DAILY": stats(daily),
        "WEEKLY": stats(weekly),
        "MONTHLY": stats(monthly),
        "SIX_MONTH": stats(six),
        "YEARLY": stats(year),
        "THREE_YEAR": {
            "average": three, "median": three, "latest": three,
            "positiveRate": 1.0 if three > 0 else 0.0,
            "best": three, "worst": three, "samples": 1,
        },
    }


def portfolio_from_scores(rows: pd.DataFrame, score_col: str, threshold: float | None, trading_dates: list[pd.Timestamp]) -> tuple[pd.Series, int]:
    picks = []
    for dt, g in rows.groupby("timestamp"):
        ranked = g.sort_values([score_col, "symbol"], ascending=[False, True])
        if threshold is not None:
            ranked = ranked[ranked[score_col] >= threshold]
        ranked = ranked.head(MAX_DAILY_SELECTIONS)
        if ranked.empty:
            continue
        daily_return = float((ranked["gross_return"] - ROUND_TRIP_COST).mean())
        picks.append((dt, daily_return, len(ranked)))
    p = pd.DataFrame(picks, columns=["timestamp", "return", "trades"]) if picks else pd.DataFrame(columns=["timestamp", "return", "trades"])
    series = p.set_index("timestamp")["return"] if not p.empty else pd.Series(dtype=float)
    index = pd.DatetimeIndex([d for d in trading_dates if START <= d <= END])
    series = series.reindex(index, fill_value=0.0)
    return series, int(p["trades"].sum()) if not p.empty else 0



def portfolio_from_scores_short(rows: pd.DataFrame, score_col: str, threshold: float | None, trading_dates: list[pd.Timestamp]) -> tuple[pd.Series, int]:
    picks = []
    for dt, g in rows.groupby("timestamp"):
        ranked = g.sort_values([score_col, "symbol"], ascending=[False, True])
        if threshold is not None:
            ranked = ranked[ranked[score_col] >= threshold]
        ranked = ranked.head(MAX_DAILY_SELECTIONS)
        if ranked.empty:
            continue
        daily_return = float((-ranked["gross_return"] - ROUND_TRIP_COST).mean())
        picks.append((dt, daily_return, len(ranked)))
    p = pd.DataFrame(picks, columns=["timestamp", "return", "trades"]) if picks else pd.DataFrame(columns=["timestamp", "return", "trades"])
    series = p.set_index("timestamp")["return"] if not p.empty else pd.Series(dtype=float)
    index = pd.DatetimeIndex([d for d in trading_dates if START <= d <= END])
    series = series.reindex(index, fill_value=0.0)
    return series, int(p["trades"].sum()) if not p.empty else 0


def portfolio_from_directional_predictions(rows: pd.DataFrame, threshold: float, trading_dates: list[pd.Timestamp]) -> tuple[pd.Series, int]:
    picks = []
    for dt, g in rows.groupby("timestamp"):
        eligible = g[g["pred"].abs() >= threshold].copy()
        if eligible.empty:
            continue
        eligible["score"] = eligible["pred"].abs()
        selected = eligible.sort_values(["score", "symbol"], ascending=[False, True]).head(MAX_DAILY_SELECTIONS)
        side = np.where(selected["pred"] >= 0, 1.0, -1.0)
        daily_return = float((side * selected["gross_return"].to_numpy() - ROUND_TRIP_COST).mean())
        picks.append((dt, daily_return, len(selected)))
    p = pd.DataFrame(picks, columns=["timestamp", "return", "trades"]) if picks else pd.DataFrame(columns=["timestamp", "return", "trades"])
    series = p.set_index("timestamp")["return"] if not p.empty else pd.Series(dtype=float)
    index = pd.DatetimeIndex([d for d in trading_dates if START <= d <= END])
    series = series.reindex(index, fill_value=0.0)
    return series, int(p["trades"].sum()) if not p.empty else 0


def rule_candidates(data: pd.DataFrame, trading_dates: list[pd.Timestamp]) -> list[dict]:
    work = data[(data.timestamp >= START) & (data.timestamp <= END)].copy()
    out = []

    positive = work[work["gap"] > 0].copy()
    positive["GAP_SCORE"] = positive["gap"]
    positive["GAP_RVOL_SCORE"] = positive["gap"] * np.clip(positive["prior_rvol"], 0.5, 5.0) * positive["prior_log_dollar_volume"]
    for name, frame, col in [
        ("DAILY_MOVER_GAP_TOP3", positive, "GAP_SCORE"),
        ("DAILY_MOVER_GAP_RVOL_TOP3", positive, "GAP_RVOL_SCORE"),
    ]:
        daily, trades = portfolio_from_scores(frame, col, None, trading_dates)
        out.append({"candidate": name, "daily": daily, "trades": trades, "meta": {"kind": "RULE_CONTINUATION_LONG"}})
    for name, frame, col in [
        ("DAILY_MOVER_GAP_UP_FADE_SHORT_TOP3", positive, "GAP_SCORE"),
        ("DAILY_MOVER_GAP_UP_RVOL_FADE_SHORT_TOP3", positive, "GAP_RVOL_SCORE"),
    ]:
        daily, trades = portfolio_from_scores_short(frame, col, None, trading_dates)
        out.append({"candidate": name, "daily": daily, "trades": trades, "meta": {"kind": "RULE_MEAN_REVERSION_SHORT", "borrowCostIncluded": False}})

    negative = work[work["gap"] < 0].copy()
    negative["GAP_DOWN_SCORE"] = -negative["gap"]
    negative["GAP_DOWN_RVOL_SCORE"] = (-negative["gap"]) * np.clip(negative["prior_rvol"], 0.5, 5.0) * negative["prior_log_dollar_volume"]
    for name, frame, col in [
        ("DAILY_MOVER_GAP_DOWN_REBOUND_TOP3", negative, "GAP_DOWN_SCORE"),
        ("DAILY_MOVER_GAP_DOWN_RVOL_REBOUND_TOP3", negative, "GAP_DOWN_RVOL_SCORE"),
    ]:
        daily, trades = portfolio_from_scores(frame, col, None, trading_dates)
        out.append({"candidate": name, "daily": daily, "trades": trades, "meta": {"kind": "RULE_MEAN_REVERSION_LONG"}})
    for name, frame, col in [
        ("DAILY_MOVER_GAP_DOWN_CONTINUATION_SHORT_TOP3", negative, "GAP_DOWN_SCORE"),
        ("DAILY_MOVER_GAP_DOWN_RVOL_CONTINUATION_SHORT_TOP3", negative, "GAP_DOWN_RVOL_SCORE"),
    ]:
        daily, trades = portfolio_from_scores_short(frame, col, None, trading_dates)
        out.append({"candidate": name, "daily": daily, "trades": trades, "meta": {"kind": "RULE_CONTINUATION_SHORT", "borrowCostIncluded": False}})
    return out

def months() -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    result = []
    cursor = START
    while cursor <= END:
        next_month = (cursor + pd.offsets.MonthBegin(1)).normalize()
        if next_month <= cursor:
            next_month = (cursor + pd.offsets.MonthBegin(2)).normalize()
        end = min(next_month - pd.Timedelta(seconds=1), END)
        result.append((cursor, end))
        cursor = end + pd.Timedelta(seconds=1)
    return result


def validation_score(daily: pd.Series, trades: int) -> float:
    if trades < 20:
        return -1e9
    m = metrics_from_daily(daily, trades)
    if m["totalReturn"] <= 0:
        return -1e6 + m["totalReturn"]
    return (m["sharpe"] or 0.0) + 0.5 * m["totalReturn"] - 0.75 * m["mdd"]


def walk_forward_ai(data: pd.DataFrame, features: list[str], name: str, trading_dates: list[pd.Timestamp]) -> dict:
    rows = data.dropna(subset=features + ["gross_return"]).copy()
    pieces = []
    threshold_history = []
    trade_count = 0

    for test_start, test_end in months():
        train_end = test_start - pd.Timedelta(seconds=1)
        train_start = train_end - pd.DateOffset(months=18) + pd.Timedelta(seconds=1)
        val_start = train_end - pd.DateOffset(months=3) + pd.Timedelta(seconds=1)
        core = rows[(rows.timestamp >= train_start) & (rows.timestamp < val_start)]
        val = rows[(rows.timestamp >= val_start) & (rows.timestamp <= train_end)]
        full = rows[(rows.timestamp >= train_start) & (rows.timestamp <= train_end)]
        test = rows[(rows.timestamp >= test_start) & (rows.timestamp <= test_end)].copy()
        if len(core) < 500 or len(val) < 100 or len(full) < 700 or test.empty:
            continue

        pre = HistGradientBoostingRegressor(
            learning_rate=0.06, max_iter=70, max_leaf_nodes=15,
            min_samples_leaf=25, l2_regularization=1.0, random_state=42,
        )
        pre.fit(core[features], core["gross_return"])
        val = val.copy()
        val["pred"] = pre.predict(val[features])

        local_dates = sorted(val["timestamp"].unique())
        scored = []
        for threshold in THRESHOLDS:
            daily, trades = portfolio_from_scores(val, "pred", threshold, local_dates)
            scored.append((validation_score(daily, trades), threshold))
        _, threshold = max(scored, key=lambda item: (item[0], item[1]))

        model = HistGradientBoostingRegressor(
            learning_rate=0.06, max_iter=90, max_leaf_nodes=15,
            min_samples_leaf=25, l2_regularization=1.0, random_state=42,
        )
        model.fit(full[features], full["gross_return"])
        test["pred"] = model.predict(test[features])
        for dt, g in test.groupby("timestamp"):
            selected = g[g["pred"] >= threshold].sort_values(["pred", "symbol"], ascending=[False, True]).head(MAX_DAILY_SELECTIONS)
            if selected.empty:
                continue
            pieces.append((dt, float((selected["gross_return"] - ROUND_TRIP_COST).mean()), int(len(selected))))
            trade_count += len(selected)
        threshold_history.append({"testStart": test_start.isoformat(), "threshold": threshold})

    p = pd.DataFrame(pieces, columns=["timestamp", "return", "trades"]) if pieces else pd.DataFrame(columns=["timestamp", "return", "trades"])
    series = p.groupby("timestamp")["return"].first() if not p.empty else pd.Series(dtype=float)
    index = pd.DatetimeIndex([d for d in trading_dates if START <= d <= END])
    series = series.reindex(index, fill_value=0.0)
    return {
        "candidate": name,
        "daily": series,
        "trades": int(trade_count),
        "meta": {"kind": "ROLLING_WALK_FORWARD_AI", "features": features, "thresholdHistory": threshold_history},
    }



def walk_forward_ai_directional(data: pd.DataFrame, features: list[str], name: str, trading_dates: list[pd.Timestamp]) -> dict:
    rows = data.dropna(subset=features + ["gross_return"]).copy()
    pieces = []
    threshold_history = []
    trade_count = 0

    for test_start, test_end in months():
        train_end = test_start - pd.Timedelta(seconds=1)
        train_start = train_end - pd.DateOffset(months=18) + pd.Timedelta(seconds=1)
        val_start = train_end - pd.DateOffset(months=3) + pd.Timedelta(seconds=1)
        core = rows[(rows.timestamp >= train_start) & (rows.timestamp < val_start)]
        val = rows[(rows.timestamp >= val_start) & (rows.timestamp <= train_end)].copy()
        full = rows[(rows.timestamp >= train_start) & (rows.timestamp <= train_end)]
        test = rows[(rows.timestamp >= test_start) & (rows.timestamp <= test_end)].copy()
        if len(core) < 500 or len(val) < 100 or len(full) < 700 or test.empty:
            continue

        pre = HistGradientBoostingRegressor(
            learning_rate=0.06, max_iter=70, max_leaf_nodes=15,
            min_samples_leaf=25, l2_regularization=1.0, random_state=42,
        )
        pre.fit(core[features], core["gross_return"])
        val["pred"] = pre.predict(val[features])
        local_dates = sorted(val["timestamp"].unique())
        scored = []
        for threshold in THRESHOLDS:
            daily, trades = portfolio_from_directional_predictions(val, threshold, local_dates)
            scored.append((validation_score(daily, trades), threshold))
        _, threshold = max(scored, key=lambda item: (item[0], item[1]))

        model = HistGradientBoostingRegressor(
            learning_rate=0.06, max_iter=90, max_leaf_nodes=15,
            min_samples_leaf=25, l2_regularization=1.0, random_state=42,
        )
        model.fit(full[features], full["gross_return"])
        test["pred"] = model.predict(test[features])

        for dt, g in test.groupby("timestamp"):
            eligible = g[g["pred"].abs() >= threshold].copy()
            if eligible.empty:
                continue
            eligible["score"] = eligible["pred"].abs()
            selected = eligible.sort_values(["score", "symbol"], ascending=[False, True]).head(MAX_DAILY_SELECTIONS)
            side = np.where(selected["pred"] >= 0, 1.0, -1.0)
            pieces.append((dt, float((side * selected["gross_return"].to_numpy() - ROUND_TRIP_COST).mean()), int(len(selected))))
            trade_count += len(selected)
        threshold_history.append({"testStart": test_start.isoformat(), "threshold": threshold})

    p = pd.DataFrame(pieces, columns=["timestamp", "return", "trades"]) if pieces else pd.DataFrame(columns=["timestamp", "return", "trades"])
    series = p.groupby("timestamp")["return"].first() if not p.empty else pd.Series(dtype=float)
    index = pd.DatetimeIndex([d for d in trading_dates if START <= d <= END])
    series = series.reindex(index, fill_value=0.0)
    return {
        "candidate": name,
        "daily": series,
        "trades": int(trade_count),
        "meta": {
            "kind": "ROLLING_WALK_FORWARD_AI_DIRECTIONAL",
            "features": features,
            "thresholdHistory": threshold_history,
            "borrowCostIncluded": False,
        },
    }


def self_test() -> None:
    # Same-day close/volume may never be a scanner input.
    feature_names = set(BASIC_FEATURES + RICH_FEATURES)
    assert "gross_return" not in feature_names
    assert "close" not in feature_names
    assert "volume" not in feature_names
    assert "gap" in feature_names  # current open vs prior close is known at the open
    assert ROUND_TRIP_COST == 0.0020
    print("SELF_TEST_PASS")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/us-daily-opportunity-scanner-3y-v1-result.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    started = time.time()
    source_meta = None
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "d_us_txt.zip"
        try:
            download_bulk(zip_path)
            data, trading_dates, universe = load_universe(zip_path)
            source_meta = {
                "provider": "Stooq bulk daily US ASCII",
                "url": STOOQ_URL,
                "scope": "NASDAQ/NYSE/NYSE MKT stock files with a bar on each historical date",
                "fallbackUsed": False,
            }
        except Exception as stooq_error:
            print(json.dumps({"stooqBulkUnavailable": str(stooq_error), "fallback": "STRATOS_US_DAILY"}), flush=True)
            try:
                data, trading_dates, universe = load_stratos_us_universe()
                source_meta = {
                    "provider": "Hugging Face stratos-org/ohlcv-750 daily parquet",
                    "url": "https://huggingface.co/datasets/stratos-org/ohlcv-750",
                    "scope": "U.S. S&P500-oriented equity universe from multi-market 750 dataset, dynamically re-ranked each trading day",
                    "fallbackUsed": True,
                    "stooqBulkError": str(stooq_error),
                }
            except Exception as stratos_error:
                print(json.dumps({"stratosUnavailable": str(stratos_error), "fallback": "HF_YAHOO_DAILY"}), flush=True)
                try:
                    data, trading_dates, universe = load_hf_yahoo_universe()
                    source_meta = {
                        "provider": "Hugging Face AmirTrader/YahooFinance daily parquet",
                        "url": "https://huggingface.co/datasets/AmirTrader/YahooFinance",
                        "scope": "large public U.S. equity daily-history collection, dynamically re-ranked each trading day",
                        "fallbackUsed": True,
                        "stooqBulkError": str(stooq_error),
                        "stratosError": str(stratos_error),
                    }
                except Exception as hf_error:
                    print(json.dumps({"hfYahooUnavailable": str(hf_error), "fallback": "APP_CATALOG_YAHOO"}), flush=True)
                    data, trading_dates, universe = load_catalog_yahoo_universe()
                    source_meta = {
                        "provider": "Yahoo Finance daily chart via app US stock catalog",
                        "url": "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
                        "scope": "current app curated U.S. stock catalog, dynamically re-ranked each trading day",
                        "fallbackUsed": True,
                        "stooqBulkError": str(stooq_error),
                        "stratosError": str(stratos_error),
                        "hfYahooError": str(hf_error),
                    }

    candidates = rule_candidates(data, trading_dates)
    candidates.append(walk_forward_ai(data, BASIC_FEATURES, "DAILY_MOVER_AI_BASIC", trading_dates))
    candidates.append(walk_forward_ai(data, RICH_FEATURES, "DAILY_MOVER_AI_WAVE_CANDLE", trading_dates))
    candidates.append(walk_forward_ai_directional(data, BASIC_FEATURES, "DAILY_MOVER_AI_DIRECTIONAL_BASIC", trading_dates))
    candidates.append(walk_forward_ai_directional(data, RICH_FEATURES, "DAILY_MOVER_AI_DIRECTIONAL_WAVE_CANDLE", trading_dates))

    rows = []
    for item in candidates:
        m = metrics_from_daily(item["daily"], item["trades"])
        periods = period_table(item["daily"])
        rows.append({
            "candidate": item["candidate"],
            "metrics": m,
            "periods": periods,
            "meta": item["meta"],
            "survivor": m["totalReturn"] > 0 and m["dailyProfitFactor"] > 1 and m["tradeCount"] >= 100 and m["mdd"] < 0.70,
        })

    survivors = sorted([r for r in rows if r["survivor"]], key=lambda r: (r["metrics"]["totalReturn"], r["metrics"]["sharpe"] or -99), reverse=True)
    report = {
        "schemaVersion": 1,
        "contract": "us-daily-opportunity-scanner-3y/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {"start": START.isoformat(), "end": END.isoformat()},
        "source": {
            **source_meta,
            "pointInTimeMembershipProven": False,
            "delistedCoverageProven": False,
            "researchRole": "dynamic daily-mover proxy, not source-faithful 5m Stocks-in-Play replication",
        },
        "universe": universe,
        "selection": {
            "decisionTime": "same-day open",
            "sameDayHighLowCloseVolumeUsedForSelection": False,
            "minimumAbsoluteGap": MIN_GAP,
            "maximumAbsoluteGap": MAX_GAP,
            "gapDirectionsEvaluated": ["UP", "DOWN"],
            "minimumPriorClose": MIN_PRICE,
            "minimumPrior20dAverageDollarVolume": MIN_AVG_DOLLAR_VOLUME,
            "maxDailySelections": MAX_DAILY_SELECTIONS,
            "roundTripCost": ROUND_TRIP_COST,
            "shortBorrowAvailabilityModeled": False,
            "shortBorrowCostIncluded": False,
        },
        "results": rows,
        "profitableSurvivorsOnly": survivors,
        "safety": {
            "researchOnly": True,
            "profitabilityProven": False,
            "promotionEligible": False,
            "executionAuthority": "NONE",
            "liveTrading": False,
            "autoTrading": False,
            "realOrderEnabled": False,
        },
        "durationSeconds": time.time() - started,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "status": "PASS" if survivors else "NO_PROFITABLE_SURVIVOR",
        "universe": universe,
        "survivors": [
            {
                "candidate": r["candidate"],
                **r["metrics"],
                "periods": {k: {"average": v["average"], "latest": v["latest"], "positiveRate": v["positiveRate"]} for k, v in r["periods"].items()},
            }
            for r in survivors
        ],
        "output": str(out),
        "durationSeconds": report["durationSeconds"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

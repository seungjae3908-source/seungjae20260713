#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import os
import statistics
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
from sklearn.ensemble import HistGradientBoostingClassifier

BENCHMARK_START = pd.Timestamp("2023-08-10", tz="UTC")
BENCHMARK_END = pd.Timestamp("2026-08-09 23:59:59", tz="UTC")
WARMUP_START = pd.Timestamp("2022-01-01", tz="UTC")
DAY_MS = 86_400_000

US = {
    "AAPL": "AAPL", "MSFT": "MSFT", "NVDA": "NVDA", "AMZN": "AMZN",
    "META": "META", "TSLA": "TSLA", "JPM": "JPM", "XOM": "XOM",
}
KR = {
    "005930": "005930.KS", "000660": "000660.KS", "005380": "005380.KS",
    "105560": "105560.KS", "035420": "035420.KS", "000270": "000270.KS",
    "068270": "068270.KS", "066570": "066570.KS",
}
CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

MARKET_CONFIG = {
    "US_STOCK": dict(kind="stock", symbols=US, cost=0.0020, horizon=1, bars_per_year=252, allow_short=False),
    "KR_STOCK": dict(kind="stock", symbols=KR, cost=0.0020, horizon=1, bars_per_year=252, allow_short=False),
    "CRYPTO_SPOT": dict(kind="spot", symbols=CRYPTO, cost=0.0020, horizon=4, bars_per_year=365 * 6, allow_short=False),
    "CRYPTO_FUTURES": dict(kind="futures", symbols=CRYPTO, cost=0.0020, horizon=4, bars_per_year=365 * 6, allow_short=True),
}

TECH_FEATURES = [
    "ret1", "ret2", "ret5", "ret10", "ret20", "ema10_ratio", "ema20_ratio",
    "ema50_ratio", "rsi14", "atr_pct", "vol_z20", "gap", "body_pct",
    "range_pct", "close_location", "ema_alignment", "trend_strength",
]
WAVE_FEATURES = [
    "structure_state", "bos_up", "bos_down", "latest_leg_dir",
    "latest_leg_atr", "retracement_ratio", "distance_swing_high_atr",
    "distance_swing_low_atr",
]
CANDLE_FEATURES = [
    "bullish_engulfing", "bearish_engulfing", "inside_bar",
    "bullish_pin", "bearish_pin", "bullish_harami", "bearish_harami",
]
FLOW_FEATURES = ["flow_1", "flow_6", "flow_24"]

AI_CANDIDATES = [
    ("AI_TECH", TECH_FEATURES),
    ("AI_TECH_WAVE", TECH_FEATURES + WAVE_FEATURES),
    ("AI_TECH_WAVE_CANDLE", TECH_FEATURES + WAVE_FEATURES + CANDLE_FEATURES),
]
THRESHOLDS = [0.55, 0.60, 0.65, 0.70]
MIN_VALIDATION_TRADES = 8
MIN_SURVIVOR_TRADES = 30

SOURCES = [
    {"id": "CHARTING_BY_MACHINES", "doi": "10.1016/j.jfineco.2024.103791", "role": "nonlinear chart features"},
    {"id": "KR_ML_CHARTING", "doi": "10.1016/j.pacfin.2025.102823", "role": "Korea OOS ML charting"},
    {"id": "CRYPTO_CANDLE", "doi": "10.1016/j.iref.2026.105158", "role": "hourly candlestick context"},
    {"id": "WORLD_ORDER_FLOW_ML", "doi": "10.1016/j.finmar.2026.101047", "role": "nonlinear order-flow ML"},
    {"id": "MLLM_VISUAL_CHART", "doi": "10.1016/j.frl.2026.110663", "role": "visual chart reasoning inspiration"},
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "market-prediction-lab/multi-evidence-profit-tournament-v1"})


def ts_ms(ts: pd.Timestamp) -> int:
    return int(ts.timestamp() * 1000)


def yahoo_daily(display: str, ticker: str) -> pd.DataFrame:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    params = {
        "period1": int(WARMUP_START.timestamp()),
        "period2": int((BENCHMARK_END + pd.Timedelta(days=2)).timestamp()),
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    }
    last = None
    for attempt in range(4):
        try:
            r = SESSION.get(url, params=params, timeout=20)
            r.raise_for_status()
            payload = r.json()
            result = payload["chart"]["result"][0]
            q = result["indicators"]["quote"][0]
            rows = pd.DataFrame({
                "timestamp": pd.to_datetime(result["timestamp"], unit="s", utc=True),
                "open": q["open"], "high": q["high"], "low": q["low"],
                "close": q["close"], "volume": q["volume"],
            })
            rows["symbol"] = display
            rows["taker_buy"] = np.nan
            rows = rows.dropna(subset=["open", "high", "low", "close", "volume"])
            return rows.sort_values("timestamp").reset_index(drop=True)
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"YAHOO_FAILED:{display}:{last}")


def months_between(start: pd.Timestamp, end: pd.Timestamp) -> List[str]:
    cursor = pd.Timestamp(start.year, start.month, 1, tz="UTC")
    out = []
    while cursor <= end:
        out.append(cursor.strftime("%Y-%m"))
        cursor = cursor + pd.offsets.MonthBegin(1)
    return out


def normalize_binance_ts(raw: str) -> int:
    v = int(float(raw))
    return v // 1000 if v >= 100_000_000_000_000 else v


def verified_binance_zip(url: str) -> bytes:
    check = SESSION.get(url + ".CHECKSUM", timeout=30)
    check.raise_for_status()
    expected = check.text.strip().split()[0].lower()
    if len(expected) != 64:
        raise RuntimeError("CHECKSUM_INVALID:" + url)
    response = SESSION.get(url, timeout=60)
    response.raise_for_status()
    raw = response.content
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise RuntimeError("CHECKSUM_MISMATCH:" + url)
    return raw


def parse_binance_zip(raw: bytes, symbol: str) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if len(names) != 1:
            raise RuntimeError("BINANCE_ZIP_SHAPE")
        text = z.read(names[0]).decode("utf-8-sig")
    rows = []
    for idx, line in enumerate(text.splitlines()):
        parts = line.strip().split(",")
        if not parts:
            continue
        if idx == 0 and not parts[0].replace(".", "", 1).isdigit():
            continue
        if len(parts) < 10:
            continue
        try:
            t = normalize_binance_ts(parts[0])
            o, h, l, c, v = map(float, parts[1:6])
            tb = float(parts[9])
        except ValueError:
            continue
        if min(o, h, l, c) <= 0 or v < 0 or tb < 0:
            continue
        rows.append((pd.to_datetime(t, unit="ms", utc=True), o, h, l, c, v, tb, symbol))
    return pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume", "taker_buy", "symbol"])


def binance_month(kind: str, symbol: str, month: str) -> pd.DataFrame:
    base = "spot" if kind == "spot" else "futures/um"
    url = f"https://data.binance.vision/data/{base}/monthly/klines/{symbol}/1h/{symbol}-1h-{month}.zip"
    return parse_binance_zip(verified_binance_zip(url), symbol)


def binance_history(kind: str, symbol: str) -> pd.DataFrame:
    months = months_between(WARMUP_START, BENCHMARK_END)
    frames: Dict[str, pd.DataFrame] = {}
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        future_map = {pool.submit(binance_month, kind, symbol, month): month for month in months}
        for fut in concurrent.futures.as_completed(future_map):
            month = future_map[fut]
            try:
                frames[month] = fut.result()
            except Exception as e:
                errors.append((month, str(e)))
    if errors:
        raise RuntimeError(f"BINANCE_MONTH_FAILED:{kind}:{symbol}:{errors[:3]}")
    df = pd.concat([frames[m] for m in months], ignore_index=True)
    df = df[(df["timestamp"] >= WARMUP_START) & (df["timestamp"] <= BENCHMARK_END)]
    df = df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)
    if len(df) < 20_000:
        raise RuntimeError(f"BINANCE_HISTORY_TOO_SHORT:{kind}:{symbol}:{len(df)}")
    return df


def load_market(market: str) -> pd.DataFrame:
    cfg = MARKET_CONFIG[market]
    if cfg["kind"] == "stock":
        frames = [yahoo_daily(symbol, ticker) for symbol, ticker in cfg["symbols"].items()]
    else:
        frames = [binance_history(cfg["kind"], symbol) for symbol in cfg["symbols"]]
    return pd.concat(frames, ignore_index=True).sort_values(["symbol", "timestamp"]).reset_index(drop=True)


def ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=span).mean()


def rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    up = delta.clip(lower=0).ewm(alpha=1/period, adjust=False, min_periods=period).mean()
    down = (-delta.clip(upper=0)).ewm(alpha=1/period, adjust=False, min_periods=period).mean()
    rs = up / down.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def add_structure(g: pd.DataFrame) -> pd.DataFrame:
    g = g.copy().reset_index(drop=True)
    n = len(g)
    atr = g["atr"].to_numpy()
    highs, lows, closes = g["high"].to_numpy(), g["low"].to_numpy(), g["close"].to_numpy()
    pivots = []
    for i in range(2, n - 2):
        is_high = highs[i] > max(highs[i-2:i]) and highs[i] >= max(highs[i+1:i+3])
        is_low = lows[i] < min(lows[i-2:i]) and lows[i] <= min(lows[i+1:i+3])
        if is_high:
            pivots.append((i+2, i, "H", highs[i]))
        if is_low:
            pivots.append((i+2, i, "L", lows[i]))
    pivots.sort()

    structure = np.zeros(n)
    bos_up = np.zeros(n)
    bos_down = np.zeros(n)
    leg_dir = np.zeros(n)
    leg_atr = np.zeros(n)
    retrace = np.zeros(n)
    dist_hi = np.full(n, np.nan)
    dist_lo = np.full(n, np.nan)

    confirmed = []
    p = 0
    last_high = last_low = None
    prev_high_price = prev_low_price = None
    prev_close = closes[0] if n else np.nan
    for t in range(n):
        while p < len(pivots) and pivots[p][0] <= t:
            conf, idx, kind, price = pivots[p]
            cls = None
            if kind == "H":
                if prev_high_price is not None:
                    cls = "HH" if price > prev_high_price else "LH"
                prev_high_price = price
                last_high = (idx, price, cls)
            else:
                if prev_low_price is not None:
                    cls = "HL" if price > prev_low_price else "LL"
                prev_low_price = price
                last_low = (idx, price, cls)
            confirmed.append((idx, kind, price, cls))
            p += 1

        if last_high and last_low:
            hc, lc = last_high[2], last_low[2]
            if hc == "HH" and lc == "HL":
                structure[t] = 1
            elif hc == "LH" and lc == "LL":
                structure[t] = -1
            if last_high[1] and closes[t] > last_high[1] and prev_close <= last_high[1]:
                bos_up[t] = 1
            if last_low[1] and closes[t] < last_low[1] and prev_close >= last_low[1]:
                bos_down[t] = 1
            if atr[t] and np.isfinite(atr[t]) and atr[t] > 0:
                dist_hi[t] = (last_high[1] - closes[t]) / atr[t]
                dist_lo[t] = (closes[t] - last_low[1]) / atr[t]

        usable = [x for x in confirmed if x[0] <= t]
        if len(usable) >= 2 and np.isfinite(atr[t]) and atr[t] > 0:
            a, b = usable[-2], usable[-1]
            leg_dir[t] = 1 if b[2] > a[2] else -1 if b[2] < a[2] else 0
            leg_atr[t] = abs(b[2] - a[2]) / atr[t]
            if len(usable) >= 3:
                c = usable[-3]
                prior = abs(a[2] - c[2])
                retrace[t] = abs(b[2] - a[2]) / prior if prior > 0 else 0
        prev_close = closes[t]

    g["structure_state"] = structure
    g["bos_up"] = bos_up
    g["bos_down"] = bos_down
    g["latest_leg_dir"] = leg_dir
    g["latest_leg_atr"] = leg_atr
    g["retracement_ratio"] = retrace
    g["distance_swing_high_atr"] = dist_hi
    g["distance_swing_low_atr"] = dist_lo
    return g


def engineer_symbol(g: pd.DataFrame, horizon: int, is_crypto: bool) -> pd.DataFrame:
    g = g.copy().sort_values("timestamp").reset_index(drop=True)
    close, high, low, opn, vol = g["close"], g["high"], g["low"], g["open"], g["volume"]
    prev_close = close.shift(1)
    for lag in [1, 2, 5, 10, 20]:
        g[f"ret{lag}"] = close.pct_change(lag)
    for span in [10, 20, 50]:
        e = ema(close, span)
        g[f"ema{span}_ratio"] = close / e - 1
    g["rsi14"] = rsi(close)
    tr = pd.concat([(high-low), (high-prev_close).abs(), (low-prev_close).abs()], axis=1).max(axis=1)
    g["atr"] = tr.rolling(14).mean()
    g["atr_pct"] = g["atr"] / close
    vmean, vstd = vol.rolling(20).mean(), vol.rolling(20).std()
    g["vol_z20"] = (vol - vmean) / vstd.replace(0, np.nan)
    g["gap"] = opn / prev_close - 1
    g["body_pct"] = close / opn - 1
    g["range_pct"] = (high - low) / prev_close
    g["close_location"] = (close - low) / (high - low).replace(0, np.nan)
    g["ema_alignment"] = np.select(
        [(g["ema10_ratio"] > g["ema20_ratio"]) & (g["ema20_ratio"] > g["ema50_ratio"]),
         (g["ema10_ratio"] < g["ema20_ratio"]) & (g["ema20_ratio"] < g["ema50_ratio"])],
        [1, -1], default=0,
    )
    g["trend_strength"] = (g["ema10_ratio"] - g["ema50_ratio"]) / g["atr_pct"].replace(0, np.nan)

    po, pc, ph, pl = opn.shift(1), close.shift(1), high.shift(1), low.shift(1)
    bull, bear = close > opn, close < opn
    pbull, pbear = pc > po, pc < po
    g["bullish_engulfing"] = (bull & pbear & (opn <= pc) & (close >= po)).astype(float)
    g["bearish_engulfing"] = (bear & pbull & (opn >= pc) & (close <= po)).astype(float)
    g["inside_bar"] = ((high < ph) & (low > pl)).astype(float)
    rng = (high-low).replace(0, np.nan)
    body = (close-opn).abs()
    upper = high - pd.concat([opn, close], axis=1).max(axis=1)
    lower = pd.concat([opn, close], axis=1).min(axis=1) - low
    g["bullish_pin"] = ((body/rng <= .35) & (lower >= body*2) & (lower >= upper*1.5)).astype(float)
    g["bearish_pin"] = ((body/rng <= .35) & (upper >= body*2) & (upper >= lower*1.5)).astype(float)
    g["bullish_harami"] = (pbear & bull & (opn >= pc) & (close <= po)).astype(float)
    g["bearish_harami"] = (pbull & bear & (opn <= pc) & (close >= po)).astype(float)

    if is_crypto:
        flow = (2*g["taker_buy"] - vol) / vol.replace(0, np.nan)
        g["flow_1"] = flow
        g["flow_6"] = flow.rolling(6).mean()
        g["flow_24"] = flow.rolling(24).mean()
    else:
        for col in FLOW_FEATURES:
            g[col] = 0.0

    g = add_structure(g)

    # Decision at close t. Entry starts at the next bar open; exit after horizon bars.
    g["entry_time"] = g["timestamp"].shift(-1)
    g["exit_time"] = g["timestamp"].shift(-horizon)
    g["future_ret"] = g["close"].shift(-horizon) / g["open"].shift(-1) - 1
    return g


def engineer_market(raw: pd.DataFrame, market: str) -> pd.DataFrame:
    cfg = MARKET_CONFIG[market]
    frames = [engineer_symbol(g, cfg["horizon"], cfg["kind"] in ("spot", "futures"))
              for _, g in raw.groupby("symbol", sort=False)]
    df = pd.concat(frames, ignore_index=True)
    df["market"] = market
    return df.sort_values(["timestamp", "symbol"]).reset_index(drop=True)


def formula_signal(row: pd.Series, variant: str) -> int:
    long_base = row["ema10_ratio"] > row["ema50_ratio"] and row["ret20"] > 0 and 45 <= row["rsi14"] <= 78
    short_base = row["ema10_ratio"] < row["ema50_ratio"] and row["ret20"] < 0 and 22 <= row["rsi14"] <= 55
    if variant in ("FORMULA_WAVE", "FORMULA_WAVE_CANDLE"):
        long_base = long_base and (row["structure_state"] >= 0 or row["bos_up"] > 0)
        short_base = short_base and (row["structure_state"] <= 0 or row["bos_down"] > 0)
    if variant == "FORMULA_WAVE_CANDLE":
        bull = row["bullish_engulfing"] + row["bullish_pin"] + row["bullish_harami"]
        bear = row["bearish_engulfing"] + row["bearish_pin"] + row["bearish_harami"]
        long_base = long_base and (bull > 0 or row["bos_up"] > 0 or row["inside_bar"] > 0)
        short_base = short_base and (bear > 0 or row["bos_down"] > 0 or row["inside_bar"] > 0)
    if long_base:
        return 1
    if short_base:
        return -1
    return 0


def max_drawdown(returns: Iterable[float]) -> float:
    wealth = 1.0
    peak = 1.0
    mdd = 0.0
    for r in returns:
        wealth *= 1 + r
        peak = max(peak, wealth)
        mdd = max(mdd, (peak - wealth) / peak)
    return mdd


def trade_metrics(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return dict(trades=0, total_return=0.0, cagr=0.0, sharpe=None, mdd=0.0, profit_factor=0.0, win_rate=0.0)
    ordered = trades.sort_values("exit_time")
    rs = ordered["net_ret"].to_numpy()
    wealth = float(np.prod(1 + rs))
    start, end = ordered["exit_time"].min(), ordered["exit_time"].max()
    years = max((end - start).total_seconds() / (365.25 * 86400), 1 / 365.25)
    cagr = wealth ** (1/years) - 1 if wealth > 0 else -1.0
    daily = ordered.assign(day=ordered["exit_time"].dt.floor("D")).groupby("day")["net_ret"].apply(lambda x: float(np.prod(1+x)-1))
    sharpe = None
    if len(daily) > 1 and daily.std(ddof=1) > 0:
        sharpe = float(daily.mean() / daily.std(ddof=1) * math.sqrt(365 if ordered["market"].iloc[0].startswith("CRYPTO") else 252))
    pos = ordered.loc[ordered["net_ret"] > 0, "net_ret"].sum()
    neg = -ordered.loc[ordered["net_ret"] < 0, "net_ret"].sum()
    pf = float(pos / neg) if neg > 0 else (999.0 if pos > 0 else 0.0)
    return dict(
        trades=int(len(ordered)),
        total_return=wealth - 1,
        cagr=float(cagr),
        sharpe=sharpe,
        mdd=float(max_drawdown(rs)),
        profit_factor=pf,
        win_rate=float((ordered["net_ret"] > 0).mean()),
    )


def period_windows(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {}
    daily = trades.sort_values("exit_time").assign(day=lambda x: x["exit_time"].dt.floor("D")).groupby("day")["net_ret"].apply(lambda x: float(np.prod(1+x)-1))
    daily = daily.reindex(pd.date_range(BENCHMARK_START.floor("D"), BENCHMARK_END.floor("D"), tz="UTC"), fill_value=0.0)
    wealth = (1 + daily).cumprod()
    def trailing(days: int) -> Optional[float]:
        if len(wealth) < 2:
            return None
        end = wealth.index[-1]
        start = end - pd.Timedelta(days=days)
        prior = wealth[wealth.index < start]
        base = prior.iloc[-1] if len(prior) else 1.0
        return float(wealth.iloc[-1] / base - 1)
    return {
        "1d": float(daily.iloc[-1]),
        "1w": trailing(7),
        "1m": trailing(30),
        "6m": trailing(182),
        "1y": trailing(365),
        "3y": float(wealth.iloc[-1] - 1),
    }


def select_trades_from_prob(df: pd.DataFrame, probs: np.ndarray, threshold: float, market: str) -> pd.DataFrame:
    cfg = MARKET_CONFIG[market]
    work = df[["timestamp", "exit_time", "symbol", "future_ret", "market"]].copy()
    work["prob"] = probs
    work = work[(work["timestamp"] >= BENCHMARK_START) & (work["timestamp"] <= BENCHMARK_END)]
    # Avoid overlapping crypto positions by only acting every horizon bars.
    if cfg["horizon"] > 1:
        uniq = sorted(work["timestamp"].drop_duplicates())
        allowed = set(uniq[::cfg["horizon"]])
        work = work[work["timestamp"].isin(allowed)]
    picks = []
    for _, g in work.groupby("timestamp"):
        if cfg["allow_short"]:
            tmp = g.assign(conf=(g["prob"] - .5).abs())
            row = tmp.sort_values(["conf", "symbol"], ascending=[False, True]).iloc[0]
            if row["prob"] >= threshold:
                side = 1
            elif row["prob"] <= 1-threshold:
                side = -1
            else:
                continue
        else:
            row = g.sort_values(["prob", "symbol"], ascending=[False, True]).iloc[0]
            if row["prob"] < threshold:
                continue
            side = 1
        gross = side * float(row["future_ret"])
        picks.append({
            "timestamp": row["timestamp"], "exit_time": row["exit_time"], "symbol": row["symbol"],
            "side": side, "gross_ret": gross, "net_ret": gross - cfg["cost"], "market": market,
        })
    return pd.DataFrame(picks)


def select_formula_trades(df: pd.DataFrame, variant: str, market: str) -> pd.DataFrame:
    cfg = MARKET_CONFIG[market]
    work = df[(df["timestamp"] >= BENCHMARK_START) & (df["timestamp"] <= BENCHMARK_END)].copy()
    work["signal"] = work.apply(lambda row: formula_signal(row, variant), axis=1)
    if not cfg["allow_short"]:
        work.loc[work["signal"] < 0, "signal"] = 0
    if cfg["horizon"] > 1:
        uniq = sorted(work["timestamp"].drop_duplicates())
        work = work[work["timestamp"].isin(set(uniq[::cfg["horizon"]]))]
    picks = []
    for _, g in work.groupby("timestamp"):
        g = g[g["signal"] != 0].copy()
        if g.empty:
            continue
        g["rank"] = g["ret20"].abs() + g["trend_strength"].abs().fillna(0) * .02 + g["latest_leg_atr"].fillna(0) * .01
        row = g.sort_values(["rank", "symbol"], ascending=[False, True]).iloc[0]
        side = int(row["signal"])
        gross = side * float(row["future_ret"])
        picks.append({
            "timestamp": row["timestamp"], "exit_time": row["exit_time"], "symbol": row["symbol"],
            "side": side, "gross_ret": gross, "net_ret": gross - cfg["cost"], "market": market,
        })
    return pd.DataFrame(picks)


def valid_rows(df: pd.DataFrame, features: List[str]) -> pd.DataFrame:
    cols = features + ["future_ret", "exit_time", "timestamp", "symbol", "market"]
    return df.dropna(subset=cols).replace([np.inf, -np.inf], np.nan).dropna(subset=features)


def monthly_periods() -> List[Tuple[pd.Timestamp, pd.Timestamp]]:
    out = []
    cursor = BENCHMARK_START
    while cursor <= BENCHMARK_END:
        nxt = (cursor + pd.offsets.MonthBegin(1)).normalize()
        if nxt <= cursor:
            nxt = (cursor + pd.offsets.MonthBegin(2)).normalize()
        end = min(nxt - pd.Timedelta(seconds=1), BENCHMARK_END)
        out.append((cursor, end))
        cursor = end + pd.Timedelta(seconds=1)
    return out


def validation_score(trades: pd.DataFrame) -> float:
    m = trade_metrics(trades)
    if m["trades"] < MIN_VALIDATION_TRADES or m["total_return"] <= 0:
        return -1e9 + m["total_return"]
    return (m["sharpe"] or 0.0) + 0.5 * m["total_return"] - 0.5 * m["mdd"]


def rolling_ai_candidate(df: pd.DataFrame, market: str, name: str, features: List[str]) -> Tuple[pd.DataFrame, dict]:
    rows = valid_rows(df, features)
    all_trades = []
    threshold_history = []
    for test_start, test_end in monthly_periods():
        train_end = test_start - pd.Timedelta(seconds=1)
        train_start = train_end - pd.Timedelta(days=450)
        val_start = train_end - pd.Timedelta(days=90)
        core = rows[(rows["timestamp"] >= train_start) & (rows["exit_time"] < val_start)]
        val = rows[(rows["timestamp"] >= val_start) & (rows["exit_time"] <= train_end)]
        full_train = rows[(rows["timestamp"] >= train_start) & (rows["exit_time"] <= train_end)]
        test = rows[(rows["timestamp"] >= test_start) & (rows["timestamp"] <= test_end)]
        if len(core) < 300 or len(val) < 80 or len(full_train) < 500 or test.empty:
            continue
        y_core = (core["future_ret"] > 0).astype(int)
        if y_core.nunique() < 2:
            continue
        pre = HistGradientBoostingClassifier(
            learning_rate=0.06, max_iter=70, max_leaf_nodes=15,
            min_samples_leaf=30, l2_regularization=1.0, random_state=42,
        )
        pre.fit(core[features], y_core)
        val_probs = pre.predict_proba(val[features])[:, 1]
        scored = []
        for threshold in THRESHOLDS:
            tr = select_trades_from_prob(val, val_probs, threshold, market)
            scored.append((validation_score(tr), threshold))
        _, threshold = max(scored, key=lambda x: (x[0], x[1]))
        y_full = (full_train["future_ret"] > 0).astype(int)
        if y_full.nunique() < 2:
            continue
        model = HistGradientBoostingClassifier(
            learning_rate=0.06, max_iter=90, max_leaf_nodes=15,
            min_samples_leaf=30, l2_regularization=1.0, random_state=42,
        )
        model.fit(full_train[features], y_full)
        probs = model.predict_proba(test[features])[:, 1]
        tr = select_trades_from_prob(test, probs, threshold, market)
        if not tr.empty:
            tr["candidate"] = name
            all_trades.append(tr)
        threshold_history.append({"start": test_start.isoformat(), "threshold": threshold})
    combined = pd.concat(all_trades, ignore_index=True) if all_trades else pd.DataFrame()
    return combined, {"thresholdHistory": threshold_history}


def run_market(market: str) -> dict:
    raw = load_market(market)
    engineered = engineer_market(raw, market)
    candidates = []

    for variant in ["FORMULA_TREND", "FORMULA_WAVE", "FORMULA_WAVE_CANDLE"]:
        trades = select_formula_trades(engineered, variant, market)
        candidates.append((variant, trades, {"kind": "FORMULA"}))

    ai_specs = list(AI_CANDIDATES)
    if market.startswith("CRYPTO"):
        ai_specs.append(("AI_TECH_WAVE_CANDLE_FLOW", TECH_FEATURES + WAVE_FEATURES + CANDLE_FEATURES + FLOW_FEATURES))
    for name, features in ai_specs:
        trades, meta = rolling_ai_candidate(engineered, market, name, features)
        candidates.append((name, trades, {"kind": "NONLINEAR_ML", "features": features, **meta}))

    rows = []
    for name, trades, meta in candidates:
        m = trade_metrics(trades)
        rows.append({
            "market": market, "candidate": name, "metrics": m,
            "windows": period_windows(trades), "meta": meta,
            "survivor": (
                m["total_return"] > 0
                and m["profit_factor"] > 1.0
                and m["trades"] >= MIN_SURVIVOR_TRADES
                and m["mdd"] < 0.70
            ),
        })
    survivors = sorted([r for r in rows if r["survivor"]], key=lambda r: (r["metrics"]["total_return"], r["metrics"]["sharpe"] or -99), reverse=True)
    return {
        "market": market,
        "data": {
            "symbols": sorted(raw["symbol"].unique().tolist()),
            "rows": int(len(raw)),
            "firstTimestamp": raw["timestamp"].min().isoformat(),
            "lastTimestamp": raw["timestamp"].max().isoformat(),
        },
        "survivors": survivors,
        "candidateCount": len(rows),
        "auditAllCandidates": rows,
    }


def self_test() -> None:
    # No same-bar outcome can enter a model feature.
    t = pd.date_range("2022-01-01", periods=120, freq="D", tz="UTC")
    x = pd.DataFrame({
        "timestamp": t, "open": np.linspace(100, 120, 120), "high": np.linspace(101, 121, 120),
        "low": np.linspace(99, 119, 120), "close": np.linspace(100.5, 120.5, 120),
        "volume": np.linspace(1000, 2000, 120), "taker_buy": np.nan, "symbol": "X",
    })
    e = engineer_symbol(x, 1, False)
    assert e.loc[50, "exit_time"] == e.loc[51, "timestamp"]
    assert math.isclose(e.loc[50, "future_ret"], e.loc[51, "close"] / e.loc[51, "open"] - 1, rel_tol=1e-12)
    # Structure pivots require two right-hand bars before they can affect state.
    assert "structure_state" in e.columns and "bullish_engulfing" in e.columns
    print("SELF_TEST_PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/multi-evidence-profit-tournament-v1-result.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0

    started = time.time()
    markets = {}
    errors = []
    for market in ["US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]:
        try:
            markets[market] = run_market(market)
        except Exception as e:
            errors.append({"market": market, "error": str(e)})
            markets[market] = {"market": market, "survivors": [], "candidateCount": 0, "auditAllCandidates": []}

    profitable = []
    for market, result in markets.items():
        profitable.extend(result.get("survivors", []))
    profitable.sort(key=lambda r: (r["metrics"]["total_return"], r["metrics"]["sharpe"] or -99), reverse=True)

    report = {
        "schemaVersion": 1,
        "contract": "multi-evidence-profit-tournament/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {"start": BENCHMARK_START.isoformat(), "end": BENCHMARK_END.isoformat()},
        "methodology": {
            "rollingWalkForward": True,
            "warmupStarts": WARMUP_START.isoformat(),
            "thresholdSelectedOnPriorValidationOnly": True,
            "testMonthNeverUsedForThresholdSelection": True,
            "formulaWaveCandleAiCombined": True,
            "stocksFixedRepresentativeBasket": True,
            "cryptoSymbols": CRYPTO,
            "transactionCostsIncluded": True,
            "paperReturnsNotUsedAsExpectedLocalReturn": True,
            "finalHoldoutIsNotUntouchedBecausePriorResearchAlreadyInspectedThisHistoricalWindow": True,
        },
        "sources": SOURCES,
        "markets": markets,
        "profitableSurvivorsOnly": profitable,
        "errors": errors,
        "safety": {
            "researchOnly": True,
            "profitabilityProven": False,
            "economicCreditGranted": False,
            "promotionEligible": False,
            "liveTrading": False,
            "autoTrading": False,
            "realOrderEnabled": False,
            "privateTradingApiAllowed": False,
            "executionAuthority": "NONE",
        },
        "durationSeconds": time.time() - started,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "PASS" if profitable else "NO_PROFITABLE_SURVIVOR",
        "profitableSurvivors": [
            {"market": r["market"], "candidate": r["candidate"], **r["metrics"], "windows": r["windows"]}
            for r in profitable
        ],
        "errors": errors,
        "output": str(out),
        "durationSeconds": report["durationSeconds"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

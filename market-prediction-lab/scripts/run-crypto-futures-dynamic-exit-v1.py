#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import math
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[2]
V1_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC = importlib.util.spec_from_file_location("hunter_v1", V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)

FIT_END = pd.Timestamp("2024-07-01").date()
CAL_END = pd.Timestamp("2025-04-01").date()
VALID_END = pd.Timestamp("2026-04-01").date()
BENCH_END = pd.Timestamp("2026-10-01").date()

ARM_PROFIT = 0.03
HARD_STOP = 0.015
LOCK_PROFIT = 0.02
MAX_MINUTES = 32 * 15
ROUND_TRIP_COST = 0.0012
LABEL_HORIZON = 15
LABEL_FAVORABLE = 0.008
LABEL_ADVERSE = 0.006
AI_THRESHOLDS = (0.35, 0.45, 0.55, 0.65)
TRAIL_GAPS = (0.008, 0.010)

EXPECTED_SOURCE_CONTRACT = "full-universe-3pct-hunter-futures-funding-v32"
EXPECTED_SOURCE_WINNER = "PREV_POS_MEAN3_GE_0_005PCT"

FEATURES = [
    "profitClose",
    "peakProfit",
    "giveback",
    "ret1Short",
    "ret3Short",
    "ret5Short",
    "takerSell1",
    "takerSell5",
    "takerSell15",
    "sellFlow5",
    "sellFlow15",
    "quoteRvol5vs30",
    "vwapGapShort",
    "range1",
    "minutesSinceEntry",
]


def data_url(symbol: str, day: str) -> str:
    return (
        "https://data.binance.vision/data/futures/um/daily/klines/"
        f"{symbol}/1m/{symbol}-1m-{day}.zip"
    )


def fetch_day(symbol: str, day: str):
    url = data_url(symbol, day)
    last = None
    for attempt in range(4):
        try:
            r = requests.get(
                url,
                timeout=45,
                headers={"User-Agent": "market-prediction-lab/dynamic-exit-v1"},
            )
            if r.status_code == 404:
                return (symbol, day), None, "404"
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if not names:
                    return (symbol, day), None, "NO_CSV"
                raw = pd.read_csv(zf.open(names[0]), header=None)
            if raw.empty:
                return (symbol, day), None, "EMPTY"
            try:
                float(raw.iloc[0, 0])
            except Exception:
                raw = raw.iloc[1:].reset_index(drop=True)
            if raw.shape[1] < 11:
                return (symbol, day), None, f"BAD_COLUMNS:{raw.shape[1]}"
            raw = raw.iloc[:, :12]
            raw.columns = [
                "open_time","open","high","low","close","volume","close_time",
                "quote_volume","trades","taker_buy_volume","taker_buy_quote","ignore",
            ]
            for c in [
                "open_time","open","high","low","close","volume",
                "quote_volume","taker_buy_quote",
            ]:
                raw[c] = pd.to_numeric(raw[c], errors="coerce")
            raw = raw.dropna(
                subset=[
                    "open_time","open","high","low","close","volume",
                    "quote_volume","taker_buy_quote",
                ]
            ).copy()
            if raw.empty:
                return (symbol, day), None, "NO_NUMERIC"
            unit = "us" if float(raw["open_time"].median()) > 1e14 else "ms"
            raw["timestamp"] = pd.to_datetime(
                raw["open_time"].astype("int64"),
                unit=unit,
                utc=True,
                errors="coerce",
            )
            raw = raw.dropna(subset=["timestamp"]).sort_values("timestamp")
            return (
                (symbol, day),
                raw[[
                    "timestamp","open","high","low","close","volume",
                    "quote_volume","taker_buy_quote",
                ]].reset_index(drop=True),
                None,
            )
        except Exception as exc:
            last = exc
            time.sleep(min(2 * (attempt + 1), 8))
    return (symbol, day), None, repr(last)


def load_source(input_root: Path):
    summaries = list(input_root.glob("**/summary.json"))
    ledgers = list(input_root.glob("**/winner-ledger.csv"))
    if not summaries or not ledgers:
        raise RuntimeError("SOURCE_ARTIFACT_INCOMPLETE")

    summary = None
    for p in summaries:
        try:
            x = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if x.get("contract") == EXPECTED_SOURCE_CONTRACT:
            summary = x
            break
    if summary is None:
        raise RuntimeError("SOURCE_CONTRACT_MISMATCH")
    if summary.get("winner") != EXPECTED_SOURCE_WINNER:
        raise RuntimeError(f"UNEXPECTED_SOURCE_WINNER:{summary.get('winner')}")

    df = pd.read_csv(ledgers[0])
    needed = {"timestamp","symbol","entryPrice","date"}
    missing = needed - set(df.columns)
    if missing:
        raise RuntimeError(f"SOURCE_LEDGER_COLUMNS_MISSING:{sorted(missing)}")
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    df["entryPrice"] = pd.to_numeric(df["entryPrice"], errors="coerce")
    df = (
        df.dropna(subset=["timestamp","symbol","entryPrice","date"])
        .sort_values(["timestamp","symbol"])
        .drop_duplicates(["timestamp","symbol"], keep="first")
        .reset_index(drop=True)
    )
    if df.empty:
        raise RuntimeError("SOURCE_LEDGER_EMPTY")
    return summary, df, str(ledgers[0])


def required_files(signals: pd.DataFrame):
    tasks = set()
    for r in signals.itertuples(index=False):
        entry_time = pd.Timestamp(r.timestamp) + pd.Timedelta(minutes=15)
        end_time = entry_time + pd.Timedelta(minutes=MAX_MINUTES - 1)
        tasks.add((str(r.symbol), entry_time.strftime("%Y-%m-%d")))
        if end_time.date() != entry_time.date():
            tasks.add((str(r.symbol), end_time.strftime("%Y-%m-%d")))
    return sorted(tasks)


def download_paths(signals: pd.DataFrame):
    tasks = required_files(signals)
    cache = {}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        futs = {pool.submit(fetch_day, sym, day):(sym,day) for sym,day in tasks}
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            key, data, err = fut.result()
            if data is not None and not data.empty:
                cache[key] = data
            else:
                failures.append({"symbol":key[0],"day":key[1],"error":err})
            if idx % 100 == 0 or idx == len(futs):
                print(json.dumps({
                    "dynamicExit1mFilesComplete":idx,
                    "requested":len(futs),
                    "usable":len(cache),
                    "failed":len(failures),
                }), flush=True)
    return cache, {
        "requestedFiles":len(tasks),
        "usableFiles":len(cache),
        "failedFiles":len(failures),
        "failurePreview":failures[:40],
    }


def build_path(cache: dict, symbol: str, signal_time: pd.Timestamp, source_entry: float):
    entry_time = pd.Timestamp(signal_time) + pd.Timedelta(minutes=15)
    if entry_time.tzinfo is None:
        entry_time = entry_time.tz_localize("UTC")
    else:
        entry_time = entry_time.tz_convert("UTC")
    end_time = entry_time + pd.Timedelta(minutes=MAX_MINUTES - 1)

    frames = []
    for day in sorted({entry_time.strftime("%Y-%m-%d"), end_time.strftime("%Y-%m-%d")}):
        x = cache.get((symbol, day))
        if x is not None:
            frames.append(x)
    if not frames:
        return None, "NO_1M_FILES"

    g = (
        pd.concat(frames, ignore_index=True)
        .drop_duplicates("timestamp")
        .sort_values("timestamp")
    )
    g = g[(g["timestamp"] >= entry_time) & (g["timestamp"] <= end_time)].copy()
    if g.empty:
        return None, "NO_ENTRY_WINDOW"
    if pd.Timestamp(g["timestamp"].iloc[0]) != entry_time:
        return None, f"ENTRY_MINUTE_MISSING:{g['timestamp'].iloc[0]}"

    entry = float(g["open"].iloc[0])
    if entry <= 0:
        return None, "BAD_ENTRY"
    source_diff = abs(entry / float(source_entry) - 1.0)
    if source_diff > 0.002:
        return None, f"ENTRY_MISMATCH:{source_diff:.6f}"

    q = g["quote_volume"].astype(float)
    tq = g["taker_buy_quote"].astype(float)
    close = g["close"].astype(float)
    high = g["high"].astype(float)
    low = g["low"].astype(float)
    volume = g["volume"].astype(float)

    sell_quote = q - tq
    sell_flow = q - 2.0 * tq
    taker_sell = np.where(q > 0, sell_quote / q, np.nan)

    g["profitClose"] = 1.0 - close / entry
    g["peakProfit"] = np.maximum.accumulate(1.0 - low / entry)
    g["giveback"] = g["peakProfit"] - g["profitClose"]
    g["ret1Short"] = -(close.pct_change(1))
    g["ret3Short"] = -(close.pct_change(3))
    g["ret5Short"] = -(close.pct_change(5))
    g["takerSell1"] = taker_sell
    g["takerSell5"] = sell_quote.rolling(5, min_periods=1).sum() / q.rolling(5, min_periods=1).sum().replace(0,np.nan)
    g["takerSell15"] = sell_quote.rolling(15, min_periods=1).sum() / q.rolling(15, min_periods=1).sum().replace(0,np.nan)
    g["sellFlow5"] = sell_flow.rolling(5, min_periods=1).sum() / q.rolling(5, min_periods=1).sum().replace(0,np.nan)
    g["sellFlow15"] = sell_flow.rolling(15, min_periods=1).sum() / q.rolling(15, min_periods=1).sum().replace(0,np.nan)
    prior30 = q.shift(1).rolling(30, min_periods=5).mean()
    g["quoteRvol5vs30"] = q.rolling(5, min_periods=1).mean() / prior30.replace(0,np.nan)
    vwap = q.cumsum() / volume.cumsum().replace(0,np.nan)
    g["vwapGapShort"] = 1.0 - close / vwap
    g["range1"] = (high - low) / close.replace(0,np.nan)
    g["minutesSinceEntry"] = np.arange(len(g), dtype=float)

    for c in FEATURES:
        g[c] = pd.to_numeric(g[c], errors="coerce")
    return g.reset_index(drop=True), None


def continuation_label(g: pd.DataFrame, i: int):
    if i + 1 >= len(g):
        return None
    cur = float(g["close"].iloc[i])
    if cur <= 0:
        return None
    end = min(len(g) - 1, i + LABEL_HORIZON)
    favorable = cur * (1.0 - LABEL_FAVORABLE)
    adverse = cur * (1.0 + LABEL_ADVERSE)
    for j in range(i + 1, end + 1):
        # Conservative intraminute ordering: adverse event wins if both are touched.
        if float(g["high"].iloc[j]) >= adverse:
            return 0
        if float(g["low"].iloc[j]) <= favorable:
            return 1
    end_close = float(g["close"].iloc[end])
    return int(end_close <= cur * (1.0 - 0.003))


def reachable_state_indices(g: pd.DataFrame):
    entry = float(g["open"].iloc[0])
    stop = entry * (1.0 + HARD_STOP)
    armed = False
    rows = []
    for i in range(len(g)):
        hi = float(g["high"].iloc[i])
        lo = float(g["low"].iloc[i])
        if hi >= stop and not armed:
            break
        if lo <= entry * (1.0 - ARM_PROFIT):
            armed = True
        if armed:
            y = continuation_label(g, i)
            if y is not None:
                rows.append((i, y))
    return rows


def make_model_rows(signals: pd.DataFrame, paths: dict):
    rows = []
    labels = []
    meta = []
    for r in signals.itertuples(index=False):
        key = (str(r.symbol), pd.Timestamp(r.timestamp))
        g = paths.get(key)
        if g is None:
            continue
        for i, y in reachable_state_indices(g):
            rows.append([float(g[c].iloc[i]) if pd.notna(g[c].iloc[i]) else np.nan for c in FEATURES])
            labels.append(int(y))
            meta.append({"symbol":str(r.symbol),"timestamp":str(r.timestamp),"minuteIndex":int(i)})
    if not rows:
        raise RuntimeError("NO_DYNAMIC_EXIT_TRAIN_STATES")
    return np.asarray(rows, dtype=float), np.asarray(labels, dtype=int), meta


def fit_model(x: np.ndarray, y: np.ndarray):
    if len(x) < 100:
        raise RuntimeError(f"TOO_FEW_AI_STATES:{len(x)}")
    if len(np.unique(y)) < 2:
        raise RuntimeError("AI_LABEL_SINGLE_CLASS")
    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("model", LogisticRegression(
            C=1.0,
            class_weight="balanced",
            max_iter=1200,
            random_state=7,
        )),
    ])
    model.fit(x, y)
    return model


def predict_proba(model, g: pd.DataFrame):
    x = g[FEATURES].astype(float).to_numpy()
    return model.predict_proba(x)[:, 1]


def policy_defs():
    out = [
        {"name":"FIXED_TP3","kind":"fixed","target":0.03},
        {"name":"FIXED_TP5","kind":"fixed","target":0.05},
    ]
    for gap in TRAIL_GAPS:
        out.append({"name":f"TRAIL3_G{gap*100:.1f}","kind":"trail","gap":gap})
    for t in AI_THRESHOLDS:
        out.append({"name":f"AI3_T{t:.2f}","kind":"ai","threshold":t})
        for gap in TRAIL_GAPS:
            out.append({"name":f"AI_TRAIL3_T{t:.2f}_G{gap*100:.1f}","kind":"hybrid","threshold":t,"gap":gap})
    return out


def simulate(g: pd.DataFrame, proba: np.ndarray, policy: dict):
    entry = float(g["open"].iloc[0])
    hard_stop = entry * (1.0 + HARD_STOP)
    kind = policy["kind"]
    armed = False
    peak_profit = 0.0
    pending_ai_exit = False
    exit_i = len(g) - 1
    exit_price = float(g["close"].iloc[-1])
    reason = "MAX_HOLD"

    for i in range(len(g)):
        op = float(g["open"].iloc[i])
        hi = float(g["high"].iloc[i])
        lo = float(g["low"].iloc[i])

        if pending_ai_exit:
            exit_i = i
            exit_price = op
            reason = "AI_TREND_DIED"
            break

        if hi >= hard_stop and not armed:
            exit_i = i
            exit_price = hard_stop
            reason = "HARD_STOP"
            break

        if kind == "fixed":
            target = entry * (1.0 - float(policy["target"]))
            if hi >= hard_stop:
                exit_i = i
                exit_price = hard_stop
                reason = "HARD_STOP"
                break
            if lo <= target:
                exit_i = i
                exit_price = target
                reason = f"TP{int(policy['target']*100)}"
                break
            continue

        if armed:
            lock = LOCK_PROFIT
            if kind in ("trail","hybrid"):
                lock = max(lock, peak_profit - float(policy["gap"]))
            floor_price = entry * (1.0 - max(0.0, lock))
            if hi >= floor_price:
                exit_i = i
                exit_price = floor_price
                reason = "PROFIT_PROTECT" if kind == "ai" else "TRAIL_PROTECT"
                break

        minute_peak = 1.0 - lo / entry
        peak_profit = max(peak_profit, minute_peak)

        if not armed and minute_peak >= ARM_PROFIT:
            armed = True

        if armed and kind in ("ai","hybrid"):
            p = float(proba[i])
            if p < float(policy["threshold"]):
                pending_ai_exit = True

    used = g.iloc[:exit_i+1]
    gross = 1.0 - exit_price / entry
    net = gross - ROUND_TRIP_COST
    mfe = 1.0 - float(used["low"].min()) / entry
    mae = float(used["high"].max()) / entry - 1.0
    capture = gross / mfe if mfe > 1e-12 else np.nan
    return {
        "entryPrice":entry,
        "exitPrice":exit_price,
        "grossReturn":gross,
        "roundTripCost":ROUND_TRIP_COST,
        "netReturn":net,
        "MFE":mfe,
        "MAE":mae,
        "captureRatio":capture,
        "exitReason":reason,
        "exitTime":str(g["timestamp"].iloc[exit_i]),
        "holdMinutes":int(exit_i + 1),
        "armed3pct":bool(armed),
        "peakProfit":peak_profit,
    }


def replay_policy(signals: pd.DataFrame, paths: dict, probas: dict, policy: dict):
    rows = []
    for r in signals.itertuples(index=False):
        key = (str(r.symbol), pd.Timestamp(r.timestamp))
        g = paths.get(key)
        if g is None:
            continue
        res = simulate(g, probas[key], policy)
        rows.append({
            "market":"CRYPTO_FUTURES",
            "direction":"SHORT",
            "candidate":policy["name"],
            "date":pd.Timestamp(r.timestamp).date(),
            "timestamp":pd.Timestamp(r.timestamp),
            "symbol":str(r.symbol),
            **res,
        })
    return pd.DataFrame(rows)


def to_pl(pdf: pd.DataFrame):
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def period_dates(start: str, end: str):
    return [d.date() for d in pd.date_range(start, pd.Timestamp(end)-pd.Timedelta(days=1), freq="D")]


def calc_metrics(pdf: pd.DataFrame, start: str, end: str):
    return v1.metrics(to_pl(pdf), "CRYPTO_FUTURES", period_dates(start, end))


def gate(m: dict, min_trades: int):
    checks = {
        "positiveReturn":float(m.get("totalReturn") or 0.0) > 0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0.0) > 1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0.0) >= 0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1.0) <= 0.35,
        "minimumTrades":int(m.get("tradeCount") or 0) >= min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def capture_stats(pdf: pd.DataFrame):
    if pdf.empty:
        return {"trades":0}
    x = pd.to_numeric(pdf["captureRatio"], errors="coerce").replace([np.inf,-np.inf],np.nan).dropna()
    return {
        "trades":int(len(pdf)),
        "armed3pctTrades":int(pdf["armed3pct"].sum()),
        "medianCaptureRatio":float(x.median()) if len(x) else None,
        "meanCaptureRatio":float(x.mean()) if len(x) else None,
        "medianHoldMinutes":float(pd.to_numeric(pdf["holdMinutes"],errors="coerce").median()),
        "exitReasons":{str(k):int(v) for k,v in pdf["exitReason"].value_counts().to_dict().items()},
    }


def rank_key(m: dict, name: str):
    return (
        float(m.get("positiveMonthRate") or 0.0),
        float(m.get("totalReturn") or 0.0),
        float(m.get("profitFactor") or 0.0),
        -float(m.get("mdd") or 0.0),
        name,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-root", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out/"run-started.json").write_text(
        json.dumps({
            "contract":"crypto-futures-dynamic-exit-v1",
            "status":"STARTED",
            "executionAuthority":"NONE",
        }, indent=2)+"\n",
        encoding="utf-8",
    )

    source_summary, signals, ledger_path = load_source(Path(args.input_root))
    cache, file_audit = download_paths(signals)

    paths = {}
    path_failures = []
    entry_diffs = []
    for r in signals.itertuples(index=False):
        key = (str(r.symbol), pd.Timestamp(r.timestamp))
        g, err = build_path(cache, str(r.symbol), pd.Timestamp(r.timestamp), float(r.entryPrice))
        if g is None:
            path_failures.append({"symbol":str(r.symbol),"timestamp":str(r.timestamp),"error":err})
            continue
        paths[key] = g
        entry_diffs.append(abs(float(g["open"].iloc[0]) / float(r.entryPrice) - 1.0))

    coverage = len(paths) / max(len(signals),1)
    if coverage < 0.95:
        raise RuntimeError(f"DYNAMIC_EXIT_TRADE_COVERAGE_TOO_LOW:{len(paths)}/{len(signals)}")

    fit_signals = signals[signals["date"] < FIT_END].copy()
    x, y, _ = make_model_rows(fit_signals, paths)
    model = fit_model(x, y)

    probas = {key:predict_proba(model,g) for key,g in paths.items()}

    policies = policy_defs()
    reports = {}
    grid = []

    for policy in policies:
        trades = replay_policy(signals, paths, probas, policy)
        fit = trades[pd.to_datetime(trades["date"]).dt.date < FIT_END].copy()
        cal = trades[
            (pd.to_datetime(trades["date"]).dt.date >= FIT_END)
            & (pd.to_datetime(trades["date"]).dt.date < CAL_END)
        ].copy()
        valid = trades[
            (pd.to_datetime(trades["date"]).dt.date >= CAL_END)
            & (pd.to_datetime(trades["date"]).dt.date < VALID_END)
        ].copy()
        bench = trades[
            (pd.to_datetime(trades["date"]).dt.date >= VALID_END)
            & (pd.to_datetime(trades["date"]).dt.date < BENCH_END)
        ].copy()

        mf = calc_metrics(fit, "2023-05-01", str(FIT_END))
        mc = calc_metrics(cal, str(FIT_END), str(CAL_END))
        mv = calc_metrics(valid, str(CAL_END), str(VALID_END))
        mb = calc_metrics(bench, str(VALID_END), str(BENCH_END))
        gc = gate(mc,30)
        gv = gate(mv,30)
        gb = gate(mb,15)

        reports[policy["name"]] = {
            "policy":policy,
            "trades":trades,
            "fit":mf,
            "calibration":mc,
            "validation":mv,
            "postHocBenchmark":mb,
            "calibrationGate":gc,
            "validationGate":gv,
            "postHocBenchmarkGate":gb,
            "capture":{
                "fit":capture_stats(fit),
                "calibration":capture_stats(cal),
                "validation":capture_stats(valid),
                "postHocBenchmark":capture_stats(bench),
            },
        }
        grid.append({
            "policy":policy["name"],
            "kind":policy["kind"],
            "calibrationPass":gc["pass"],
            "calibrationReturn":mc.get("totalReturn"),
            "calibrationPF":mc.get("profitFactor"),
            "calibrationMDD":mc.get("mdd"),
            "calibrationPosMonthRate":mc.get("positiveMonthRate"),
            "calibrationTrades":mc.get("tradeCount"),
            "validationPass":gv["pass"],
            "validationReturn":mv.get("totalReturn"),
            "validationPF":mv.get("profitFactor"),
            "validationMDD":mv.get("mdd"),
            "validationPosMonthRate":mv.get("positiveMonthRate"),
            "validationTrades":mv.get("tradeCount"),
            "benchmarkReturn":mb.get("totalReturn"),
            "benchmarkPF":mb.get("profitFactor"),
            "benchmarkMDD":mb.get("mdd"),
            "benchmarkPosMonthRate":mb.get("positiveMonthRate"),
            "benchmarkTrades":mb.get("tradeCount"),
        })

    dynamic_names = [
        n for n,d in reports.items()
        if d["policy"]["kind"] in ("ai","hybrid") and d["calibrationGate"]["pass"]
    ]
    winner = (
        sorted(dynamic_names, key=lambda n:rank_key(reports[n]["calibration"],n), reverse=True)[0]
        if dynamic_names else None
    )

    # Coefficients are diagnostic only.
    lr = model.named_steps["model"]
    coef = [
        {"feature":f,"coefficient":float(c)}
        for f,c in sorted(zip(FEATURES,lr.coef_[0]), key=lambda z:abs(z[1]), reverse=True)
    ]

    pd.DataFrame(grid).to_csv(out/"policy-grid.csv",index=False)
    summary = {
        "schemaVersion":1,
        "contract":"crypto-futures-dynamic-exit-v1",
        "sourceContract":source_summary.get("contract"),
        "sourceWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "signalCount":int(len(signals)),
        "replayedSignals":int(len(paths)),
        "replayCoverage":coverage,
        "modelFitStates":int(len(x)),
        "modelFitPositiveRate":float(y.mean()),
        "candidatePolicies":len(policies),
        "dynamicCalibrationPassCount":len(dynamic_names),
        "winner":winner,
        "fileAudit":file_audit,
        "pathAudit":{
            "pathFailures":len(path_failures),
            "failurePreview":path_failures[:40],
            "medianEntryOpenDiff":float(np.median(entry_diffs)) if entry_diffs else None,
            "maxEntryOpenDiff":float(np.max(entry_diffs)) if entry_diffs else None,
        },
        "modelTopCoefficients":coef[:10],
        "truthBoundary":{
            "entrySignalUnchangedFromFundingV32Winner":True,
            "exitReplayResolution":"1m",
            "hardStopAlwaysActiveBeforeProfitArm":True,
            "profitProtectionArmsAt3pct":True,
            "aiDecisionUsesOnlyCompletedOneMinuteBars":True,
            "aiExitExecutesNextMinuteOpen":True,
            "modelFitOnlyBefore2024_07_01":True,
            "policyThresholdSelectedOnlyOn2024_07_to_2025_03Calibration":True,
            "validationNotUsedForDynamicPolicySelection":True,
            "entryStrategyWasPreviouslySelectedUsing2025_04_to_2026_03Validation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }

    # Always emit fixed baselines and best calibration policies for comparison.
    compare_names = ["FIXED_TP3","FIXED_TP5"]
    if winner:
        compare_names.append(winner)
        d=reports[winner]
        summary["winnerResults"]={
            "fit":d["fit"],
            "calibration":d["calibration"],
            "calibrationGate":d["calibrationGate"],
            "validation":d["validation"],
            "validationGate":d["validationGate"],
            "postHocBenchmark":d["postHocBenchmark"],
            "postHocBenchmarkGate":d["postHocBenchmarkGate"],
            "capture":d["capture"],
        }
        d["trades"].to_csv(out/"winner-ledger.csv",index=False)
    summary["baselineResults"]={
        n:{
            "fit":reports[n]["fit"],
            "calibration":reports[n]["calibration"],
            "validation":reports[n]["validation"],
            "postHocBenchmark":reports[n]["postHocBenchmark"],
            "capture":reports[n]["capture"],
        }
        for n in compare_names if n in reports
    }

    (out/"summary.json").write_text(
        json.dumps(summary,ensure_ascii=False,indent=2)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__ == "__main__":
    main()

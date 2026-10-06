#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download
from lightgbm import LGBMClassifier

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


activity = load(
    "flow_v4_activity",
    "market-prediction-lab/scripts/run-crypto-full-universe-flow-v4.py",
)

DATASET = activity.DATASET
SUB = "futures"
RVOL_MIN = float(activity.PRESCREEN_RVOL_MIN)
TARGET = 0.03
STOP = 0.015
HOLD_BARS = 32
ENTRY_SLIPPAGE = 0.0005
ROUND_TRIP_COST = 0.0012
EXTRA_STRESS = 0.0010

TRAIN_END = pd.Timestamp("2024-10-01T00:00:00Z")
CAL_END = pd.Timestamp("2025-04-01T00:00:00Z")
VAL_END = pd.Timestamp("2026-04-01T00:00:00Z")
FRESH_END = pd.Timestamp("2026-10-01T00:00:00Z")

BASE_FEATURES = [
    "activityScore",
    "baseRvol",
    "ret1",
    "ret4",
    "ret12",
    "retAccel",
    "volumeAccel4",
    "volumeTrend4v16",
    "rangePct",
    "bodyRet",
    "closeLoc",
    "breakoutHigh16",
    "breakdownLow16",
    "compression16",
    "ma8Dist",
    "ma32Dist",
    "trend8v32",
    "vol16",
    "vol64",
    "gap15",
    "hourSin",
    "hourCos",
    "dowSin",
    "dowCos",
]
CROSS_FEATURES = [
    "activityRankFrac",
    "rvolRankFrac",
    "downRet4RankFrac",
    "downRet12RankFrac",
    "compressionRankFrac",
]
FEATURES = BASE_FEATURES + CROSS_FEATURES


def process_file(path: Path):
    x = activity.load_hf_15m(path)
    if x is None or x.height < 120:
        return None, None

    symbol = activity.raw_symbol_from_path(path, SUB)
    p = x.select(["date", "open", "high", "low", "close", "volume"]).to_pandas()
    p["date"] = pd.to_datetime(p["date"], utc=True)
    for c in ("open", "high", "low", "close", "volume"):
        p[c] = pd.to_numeric(p[c], errors="coerce")
    p = (
        p.dropna(subset=["date", "open", "high", "low", "close", "volume"])
        .sort_values("date")
        .drop_duplicates("date")
        .reset_index(drop=True)
    )
    if len(p) < 120:
        return None, None

    o = p["open"].astype(float)
    h = p["high"].astype(float)
    l = p["low"].astype(float)
    c = p["close"].astype(float)
    v = p["volume"].astype(float)

    ret1 = c / c.shift(1) - 1.0
    ret4 = c / c.shift(4) - 1.0
    ret12 = c / c.shift(12) - 1.0
    prior_vol96 = v.shift(1).rolling(96, min_periods=48).mean()
    base_rvol = v / prior_vol96.replace(0, np.nan)
    prior_v4 = v.shift(1).rolling(4, min_periods=3).mean()
    prior_v16 = v.shift(1).rolling(16, min_periods=8).mean()
    prior_high16 = h.shift(1).rolling(16, min_periods=8).max()
    prior_low16 = l.shift(1).rolling(16, min_periods=8).min()
    ma8 = c.rolling(8, min_periods=8).mean()
    ma32 = c.rolling(32, min_periods=20).mean()
    vol16 = ret1.rolling(16, min_periods=8).std()
    vol64 = ret1.rolling(64, min_periods=32).std()

    range_raw = (h - l).replace(0, np.nan)
    activity_score = (
        base_rvol.clip(0, 20)
        + ret4.abs().clip(0, 0.20) * 30.0
        + ((c / prior_high16.replace(0, np.nan) - 1.0) >= -0.01).astype(float) * 0.5
        + ((c / prior_low16.replace(0, np.nan) - 1.0) <= 0.01).astype(float) * 0.5
    )

    eligible = (base_rvol >= RVOL_MIN).fillna(False)
    onset = eligible & ~eligible.shift(1, fill_value=False)

    hour = p["date"].dt.hour + p["date"].dt.minute / 60.0
    dow = p["date"].dt.dayofweek.astype(float)

    feat = pd.DataFrame(
        {
            "timestamp": p["date"],
            "symbol": symbol,
            "activityScore": activity_score,
            "baseRvol": base_rvol,
            "ret1": ret1,
            "ret4": ret4,
            "ret12": ret12,
            "retAccel": ret1 - ret4 / 4.0,
            "volumeAccel4": v / prior_v4.replace(0, np.nan),
            "volumeTrend4v16": prior_v4 / prior_v16.replace(0, np.nan) - 1.0,
            "rangePct": range_raw / c.replace(0, np.nan),
            "bodyRet": c / o.replace(0, np.nan) - 1.0,
            "closeLoc": (c - l) / range_raw,
            "breakoutHigh16": c / prior_high16.replace(0, np.nan) - 1.0,
            "breakdownLow16": c / prior_low16.replace(0, np.nan) - 1.0,
            "compression16": (prior_high16 - prior_low16) / c.replace(0, np.nan),
            "ma8Dist": c / ma8.replace(0, np.nan) - 1.0,
            "ma32Dist": c / ma32.replace(0, np.nan) - 1.0,
            "trend8v32": ma8 / ma32.replace(0, np.nan) - 1.0,
            "vol16": vol16,
            "vol64": vol64,
            "gap15": o / c.shift(1).replace(0, np.nan) - 1.0,
            "hourSin": np.sin(2.0 * np.pi * hour / 24.0),
            "hourCos": np.cos(2.0 * np.pi * hour / 24.0),
            "dowSin": np.sin(2.0 * np.pi * dow / 7.0),
            "dowCos": np.cos(2.0 * np.pi * dow / 7.0),
            "eventOnset": onset,
        }
    )

    event_idx = np.flatnonzero(onset.to_numpy(bool))
    if not len(event_idx):
        return None, {"symbol": symbol, "events": 0}

    # Require a complete, continuous 8-hour path after the signal.
    gap = p["date"].diff().gt(pd.Timedelta(minutes=30)).fillna(False).to_numpy(bool)
    segment = np.cumsum(gap)
    valid = event_idx + HOLD_BARS < len(p)
    event_idx = event_idx[valid]
    if not len(event_idx):
        return None, {"symbol": symbol, "events": 0}
    same_segment = segment[event_idx + 1] == segment[event_idx + HOLD_BARS]
    event_idx = event_idx[same_segment]
    if not len(event_idx):
        return None, {"symbol": symbol, "events": 0}

    offsets = np.arange(1, HOLD_BARS + 1, dtype=int)
    path_idx = event_idx[:, None] + offsets[None, :]
    high_w = h.to_numpy(float)[path_idx]
    low_w = l.to_numpy(float)[path_idx]
    close_w = c.to_numpy(float)[path_idx]
    raw_entry = o.to_numpy(float)[event_idx + 1]
    entry = raw_entry * (1.0 - ENTRY_SLIPPAGE)

    good_entry = np.isfinite(entry) & (entry > 0)
    event_idx = event_idx[good_entry]
    high_w = high_w[good_entry]
    low_w = low_w[good_entry]
    close_w = close_w[good_entry]
    raw_entry = raw_entry[good_entry]
    entry = entry[good_entry]
    if not len(event_idx):
        return None, {"symbol": symbol, "events": 0}

    tp = entry * (1.0 - TARGET)
    sl = entry * (1.0 + STOP)
    tp_hit = low_w <= tp[:, None]
    sl_hit = high_w >= sl[:, None]
    sentinel = HOLD_BARS + 1
    first_tp = np.where(tp_hit.any(axis=1), tp_hit.argmax(axis=1), sentinel)
    first_sl = np.where(sl_hit.any(axis=1), sl_hit.argmax(axis=1), sentinel)

    is_target = first_tp < first_sl
    is_stop = (first_sl <= first_tp) & (first_sl < sentinel)
    time_exit = ~(is_target | is_stop)

    exit_px = close_w[:, -1].copy()
    exit_px[is_target] = tp[is_target]
    exit_px[is_stop] = sl[is_stop]
    gross = 1.0 - exit_px / entry
    net = gross - ROUND_TRIP_COST
    mfe = 1.0 - np.nanmin(low_w, axis=1) / entry
    mae = np.nanmax(high_w, axis=1) / entry

    rows = feat.iloc[event_idx].copy()
    rows["entryTime"] = p["date"].iloc[event_idx + 1].to_numpy()
    rows["entryOpenRaw"] = raw_entry
    rows["entryPriceExec"] = entry
    rows["exitPrice"] = exit_px
    rows["exitReason"] = np.where(is_target, "TARGET", np.where(is_stop, "STOP", "TIME"))
    rows["grossReturn"] = gross
    rows["roundTripCost"] = ROUND_TRIP_COST
    rows["netReturn"] = net
    rows["MFE"] = mfe
    rows["MAE"] = mae
    rows["labelTargetFirst3"] = is_target.astype(np.int8)
    rows = rows.drop(columns=["eventOnset"])
    rows = rows.replace([np.inf, -np.inf], np.nan).dropna(subset=BASE_FEATURES + ["netReturn"])

    for f in BASE_FEATURES:
        rows[f] = rows[f].astype("float32")
    for f in ["entryOpenRaw", "entryPriceExec", "exitPrice", "grossReturn", "netReturn", "MFE", "MAE"]:
        rows[f] = pd.to_numeric(rows[f], errors="coerce").astype("float32")

    return rows, {"symbol": symbol, "events": int(len(rows))}


def add_cross_section(events: pl.DataFrame) -> pl.DataFrame:
    n = pl.len().over("timestamp").cast(pl.Float32)
    return events.with_columns(
        [
            (pl.col("activityScore").rank("average", descending=True).over("timestamp") / n)
            .cast(pl.Float32)
            .alias("activityRankFrac"),
            (pl.col("baseRvol").rank("average", descending=True).over("timestamp") / n)
            .cast(pl.Float32)
            .alias("rvolRankFrac"),
            (pl.col("ret4").rank("average", descending=False).over("timestamp") / n)
            .cast(pl.Float32)
            .alias("downRet4RankFrac"),
            (pl.col("ret12").rank("average", descending=False).over("timestamp") / n)
            .cast(pl.Float32)
            .alias("downRet12RankFrac"),
            (pl.col("compression16").rank("average", descending=False).over("timestamp") / n)
            .cast(pl.Float32)
            .alias("compressionRankFrac"),
        ]
    )


def period_for(ts: pd.Series) -> np.ndarray:
    t = pd.to_datetime(ts, utc=True)
    return np.select(
        [t < TRAIN_END, t < CAL_END, t < VAL_END, t < FRESH_END],
        ["train", "calibration", "validation", "fresh_oos"],
        default="outside",
    )


def score_metrics(df: pd.DataFrame, score: np.ndarray, threshold: float, extra_cost: float = 0.0):
    pred = score >= threshold
    selected = int(pred.sum())
    y = df["labelTargetFirst3"].to_numpy(np.int8)
    net = df["netReturn"].to_numpy(float) - float(extra_cost)
    positives = int((y == 1).sum())

    if selected == 0:
        return {
            "threshold": float(threshold),
            "rows": int(len(df)),
            "selected": 0,
            "precision": 0.0,
            "recall": 0.0,
            "selectedShare": 0.0,
            "meanNet": 0.0,
            "profitFactor": 0.0,
            "positiveMonths": 0,
            "negativeMonths": 0,
            "positiveActiveMonthRate": 0.0,
        }

    yy = y[pred]
    nn = net[pred]
    gp = float(np.maximum(nn, 0).sum())
    gl = float(np.maximum(-nn, 0).sum())
    months = pd.to_datetime(df.loc[pred, "timestamp"], utc=True).dt.strftime("%Y-%m")
    ms = pd.DataFrame({"month": months.to_numpy(), "net": nn}).groupby("month")["net"].sum()
    pm = int((ms > 0).sum())
    nm = int((ms < 0).sum())
    return {
        "threshold": float(threshold),
        "rows": int(len(df)),
        "selected": selected,
        "precision": float((yy == 1).sum() / max(selected, 1)),
        "recall": float((yy == 1).sum() / max(positives, 1)),
        "selectedShare": float(selected / max(len(df), 1)),
        "meanNet": float(nn.mean()),
        "profitFactor": float(gp / max(gl, 1e-12)),
        "positiveMonths": pm,
        "negativeMonths": nm,
        "positiveActiveMonthRate": float(pm / max(pm + nm, 1)),
    }


def select_threshold(cal: pd.DataFrame, score: np.ndarray):
    qs = np.unique(
        np.concatenate(
            [
                np.linspace(0.70, 0.95, 26),
                np.array([0.96, 0.97, 0.98, 0.985, 0.99, 0.9925, 0.995, 0.9975]),
            ]
        )
    )
    thresholds = np.unique(np.quantile(score, qs))
    grid = [score_metrics(cal, score, float(t), 0.0) for t in thresholds]
    eligible = [
        r
        for r in grid
        if r["selected"] >= 500
        and r["meanNet"] > 0
        and r["profitFactor"] > 1.05
        and r["precision"] >= 0.35
        and r["recall"] >= 0.02
        and r["selectedShare"] <= 0.10
        and r["positiveActiveMonthRate"] >= 0.50
    ]
    if eligible:
        winner = max(
            eligible,
            key=lambda r: (
                r["meanNet"],
                r["profitFactor"],
                r["recall"],
                r["precision"],
            ),
        )
        mode = "ECONOMIC_GATE"
    else:
        feasible = [r for r in grid if r["selected"] >= 500] or grid
        winner = max(feasible, key=lambda r: (r["meanNet"], r["profitFactor"], r["recall"]))
        mode = "BEST_DIAGNOSTIC_ONLY"
    return mode, winner, grid


def gate(m: dict, min_selected: int):
    checks = {
        "minimumSelectedRows": int(m["selected"]) >= min_selected,
        "positiveEV": float(m["meanNet"]) > 0,
        "profitFactorAbove1": float(m["profitFactor"]) > 1,
        "precisionAtLeast35pct": float(m["precision"]) >= 0.35,
        "recallAtLeast2pct": float(m["recall"]) >= 0.02,
        "positiveActiveMonthRateAtLeast50pct": float(m["positiveActiveMonthRate"]) >= 0.50,
    }
    return {"pass": bool(all(checks.values())), "checks": checks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    folder = (
        Path(
            snapshot_download(
                repo_id=DATASET,
                repo_type="dataset",
                allow_patterns=[f"{SUB}/15m/*.parquet"],
            )
        )
        / SUB
        / "15m"
    )
    files = sorted(folder.glob("*.parquet"))
    frames = []
    audits = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(process_file, p): p for p in files}
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            p = futs[fut]
            try:
                rows, audit = fut.result()
            except Exception as exc:
                rows = None
                audit = {"symbolFile": p.name, "error": repr(exc), "events": 0}
            audits.append(audit)
            if rows is not None and len(rows):
                frames.append(pl.from_pandas(rows))
            if idx % 100 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "filesComplete": idx,
                            "files": len(futs),
                            "usableFrames": len(frames),
                            "eventRows": int(sum(f.height for f in frames)),
                        }
                    ),
                    flush=True,
                )

    if not frames:
        raise RuntimeError("V53_NO_EVENT_ROWS")

    events = pl.concat(frames, how="vertical_relaxed")
    events = add_cross_section(events)
    pdf = events.to_pandas()
    pdf["timestamp"] = pd.to_datetime(pdf["timestamp"], utc=True)
    pdf["entryTime"] = pd.to_datetime(pdf["entryTime"], utc=True)
    pdf["period"] = period_for(pdf["timestamp"])
    pdf = pdf[pdf["period"] != "outside"].copy()
    pdf = pdf.replace([np.inf, -np.inf], np.nan).dropna(
        subset=FEATURES + ["netReturn", "labelTargetFirst3"]
    )

    for f in FEATURES:
        pdf[f] = pd.to_numeric(pdf[f], errors="coerce").astype("float32")

    split = {
        k: pdf[pdf["period"].eq(k)].copy()
        for k in ("train", "calibration", "validation", "fresh_oos")
    }
    if min(len(v) for v in split.values()) < 1000:
        raise RuntimeError(
            "V53_PERIOD_TOO_SMALL:"
            + ":".join(f"{k}={len(v)}" for k, v in split.items())
        )

    model = LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.03,
        num_leaves=31,
        max_depth=10,
        min_child_samples=150,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.75,
        reg_lambda=2.5,
        random_state=530,
        n_jobs=8,
        verbosity=-1,
    )
    model.fit(
        split["train"][FEATURES],
        split["train"]["labelTargetFirst3"].astype(int),
    )

    cal_score = model.predict_proba(split["calibration"][FEATURES])[:, 1]
    mode, winner, grid = select_threshold(split["calibration"], cal_score)
    threshold = float(winner["threshold"])

    val_score = model.predict_proba(split["validation"][FEATURES])[:, 1]
    fresh_score = model.predict_proba(split["fresh_oos"][FEATURES])[:, 1]
    validation = score_metrics(split["validation"], val_score, threshold, 0.0)
    fresh = score_metrics(split["fresh_oos"], fresh_score, threshold, 0.0)
    validation_stress = score_metrics(split["validation"], val_score, threshold, EXTRA_STRESS)
    fresh_stress = score_metrics(split["fresh_oos"], fresh_score, threshold, EXTRA_STRESS)

    vg = gate(validation, 300)
    fg = gate(fresh, 150)
    vsg = gate(validation_stress, 300)
    fsg = gate(fresh_stress, 150)
    promotion = bool(
        mode == "ECONOMIC_GATE"
        and vg["pass"]
        and fg["pass"]
        and vsg["pass"]
        and fsg["pass"]
    )

    # Persist only frozen selected validation/fresh events for any exact-1m follow-up.
    for name, df, score in (
        ("validation", split["validation"], val_score),
        ("fresh-oos", split["fresh_oos"], fresh_score),
    ):
        sel = df.loc[score >= threshold].copy()
        sel["score"] = score[score >= threshold]
        sel.to_parquet(out / f"selected-{name}.parquet", index=False)

    pd.DataFrame(audits).to_json(
        out / "source-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-opportunity-ranker-v53",
        "dataset": DATASET,
        "sourceFiles": len(files),
        "eventRows": int(len(pdf)),
        "rowCounts": {k: int(len(v)) for k, v in split.items()},
        "features": FEATURES,
        "calibrationSelection": {
            "mode": mode,
            "winner": winner,
            "grid": grid,
        },
        "validation": validation,
        "freshOos": fresh,
        "validationPlus10bp": validation_stress,
        "freshOosPlus10bp": fresh_stress,
        "validationGate": vg,
        "freshOosGate": fg,
        "validationStressGate": vsg,
        "freshOosStressGate": fsg,
        "promotionPass": promotion,
        "featureImportance": sorted(
            [
                {"feature": f, "importance": float(v)}
                for f, v in zip(FEATURES, model.feature_importances_)
            ],
            key=lambda z: z["importance"],
            reverse=True,
        ),
        "truthBoundary": {
            "fullCausalEventOnsetUniverseUsedBeforeModelRanking": True,
            "noTop10OrTop50OutcomeDrivenPreselection": True,
            "signalFeaturesUseCompleted15mBarAndPastOnly": True,
            "crossSectionRanksUseSameCompletedTimestampOnly": True,
            "entryUsesNext15mOpen": True,
            "shortEntrySlippageApplied": ENTRY_SLIPPAGE,
            "roundTripCostIncluded": ROUND_TRIP_COST,
            "targetPct": TARGET,
            "stopPct": STOP,
            "maxHoldHours": 8,
            "sameBarTargetStopUsesStopFirst": True,
            "trainOnlyFitsModel": True,
            "calibrationOnlySelectsThreshold": True,
            "validationAndFreshNeverSelectModelOrThreshold": True,
            "plus10bpStressRequiredForPromotion": True,
            "noThresholdRetuningAfterValidation": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }

    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()

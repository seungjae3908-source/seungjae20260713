#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import polars as pl
from huggingface_hub import snapshot_download

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
SUB = "spot"
TOP_PER_TIMESTAMP = 50
RVOL_MIN = activity.PRESCREEN_RVOL_MIN


def causal_onsets(path: Path):
    x = activity.load_hf_15m(path)
    if x is None or x.height < 100:
        return None

    symbol = activity.raw_symbol_from_path(path, SUB)
    x = (
        x.with_columns(
            [
                pl.col("volume")
                .shift(1)
                .rolling_mean(96, min_samples=48)
                .alias("priorVol96"),
                (pl.col("close") / pl.col("close").shift(4) - 1.0).alias("ret60"),
                pl.col("high")
                .shift(1)
                .rolling_max(16, min_samples=8)
                .alias("priorHigh4h"),
                pl.col("low")
                .shift(1)
                .rolling_min(16, min_samples=8)
                .alias("priorLow4h"),
            ]
        )
        .with_columns(
            [
                (pl.col("volume") / pl.col("priorVol96")).alias("baseRvol"),
                (pl.col("close") / pl.col("priorHigh4h") - 1.0).alias("nearHigh4h"),
                (pl.col("close") / pl.col("priorLow4h") - 1.0).alias("nearLow4h"),
            ]
        )
        .with_columns(
            [
                (
                    pl.col("baseRvol").clip(0, 20)
                    + pl.col("ret60").abs().clip(0, 0.20) * 30
                    + (pl.col("nearHigh4h") >= -0.01).cast(pl.Int8) * 0.5
                    + (pl.col("nearLow4h") <= 0.01).cast(pl.Int8) * 0.5
                ).alias("activityScore"),
                (pl.col("baseRvol") >= RVOL_MIN).fill_null(False).alias("eligible"),
            ]
        )
        .with_columns(
            (
                pl.col("eligible")
                & ~pl.col("eligible").shift(1).fill_null(False)
            ).alias("eventOnset")
        )
        .filter(pl.col("eventOnset"))
        .with_columns(
            [
                pl.col("date").dt.strftime("%Y-%m").alias("month"),
                pl.col("date").dt.date().alias("day"),
                pl.lit(symbol).alias("symbol"),
            ]
        )
        .select(
            [
                "date",
                "day",
                "month",
                "symbol",
                "activityScore",
                "baseRvol",
                "ret60",
            ]
        )
    )
    return x if x.height else None


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
    failures = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(causal_onsets, p): p for p in files}
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            p = futs[fut]
            try:
                x = fut.result()
                if x is not None and x.height:
                    frames.append(x)
            except Exception as exc:
                failures.append({"file": p.name, "error": repr(exc)})
            if idx % 100 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "filesComplete": idx,
                            "files": len(futs),
                            "usableFrames": len(frames),
                            "failures": len(failures),
                        }
                    ),
                    flush=True,
                )

    if not frames:
        raise RuntimeError("SPOT_V60_NO_CAUSAL_ONSETS")

    all_onsets = pl.concat(frames, how="vertical_relaxed")
    selected = (
        all_onsets.sort(
            ["date", "activityScore", "symbol"],
            descending=[False, True, False],
        )
        .group_by("date", maintain_order=True)
        .head(TOP_PER_TIMESTAMP)
    )
    tasks = (
        selected.select(["month", "symbol"])
        .unique()
        .sort(["month", "symbol"])
    )

    per_month = (
        selected.group_by("month")
        .agg(
            [
                pl.len().alias("selectedRows"),
                pl.col("symbol").n_unique().alias("symbols"),
                pl.col("date").n_unique().alias("timestamps"),
            ]
        )
        .sort("month")
    )

    selected.write_csv(out / "causal-selected.csv")
    tasks.write_csv(out / "raw-month-tasks.csv")
    per_month.write_csv(out / "monthly-counts.csv")

    result = {
        "schemaVersion": 1,
        "contract": "crypto-spot-causal-prescreen-v60-probe",
        "dataset": DATASET,
        "sourceFiles": len(files),
        "usableSymbolFrames": len(frames),
        "fileFailures": len(failures),
        "rawCausalOnsets": int(all_onsets.height),
        "selectedRows": int(selected.height),
        "selectedSymbols": int(selected["symbol"].n_unique()),
        "selectedTimestamps": int(selected["date"].n_unique()),
        "rawSymbolMonthTasks": int(tasks.height),
        "topPerTimestamp": TOP_PER_TIMESTAMP,
        "rvolMin": float(RVOL_MIN),
        "dateMin": str(selected["date"].min()),
        "dateMax": str(selected["date"].max()),
        "failurePreview": failures[:30],
        "legacyIntegrityFinding": {
            "legacyV43PerSymbolTop2UsesWholeDayRanking": True,
            "legacyV43CrossSectionTop50UsesWholeDayRanking": True,
            "legacyV43ContainsIntradayLookAhead": True,
            "legacyV49PromotionEvidenceMustNotBeUsedAsFinalProfitabilityProof": True,
        },
        "truthBoundary": {
            "eventOnsetUsesCurrentAndPriorCompletedBarsOnly": True,
            "crossSectionalRankingIsPerCompletedTimestampNotPerDay": True,
            "noFutureBarsUsedToChooseAnEvent": True,
            "sameRvolAndActivityFormulaAsLegacyPrescreen": True,
            "probeOnlyNoModelRetuning": True,
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

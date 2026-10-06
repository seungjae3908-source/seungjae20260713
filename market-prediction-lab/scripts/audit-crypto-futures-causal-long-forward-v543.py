#!/usr/bin/env python3
from __future__ import annotations

# Workflow registered; frozen forward audit trigger.

# Trigger registered frozen forward audit.

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


v54 = load(
    "futures_long_v542",
    "market-prediction-lab/scripts/run-crypto-futures-causal-long-opportunity-ranker-v542.py",
)

FORWARD_START = pd.Timestamp("2026-10-01T00:00:00Z")
EXTRA_STRESS = 0.0010


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-summary", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    prior = json.loads(Path(args.source_summary).read_text(encoding="utf-8"))
    if prior.get("contract") != "crypto-futures-causal-long-opportunity-ranker-v542":
        raise RuntimeError("V543_WRONG_SOURCE_CONTRACT")

    frozen = prior.get("calibrationSelection", {})
    frozen_winner = frozen.get("winner") or {}
    frozen_threshold = float(frozen_winner["threshold"])

    snapshot_root = Path(
        snapshot_download(
            repo_id=v54.DATASET,
            repo_type="dataset",
            allow_patterns=[f"{v54.SUB}/15m/*.parquet"],
        )
    )
    current_dataset_revision = snapshot_root.name
    folder = snapshot_root / v54.SUB / "15m"
    files = sorted(folder.glob("*.parquet"))
    frames = []
    audits = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(v54.process_file, p): p for p in files}
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
        raise RuntimeError("V543_NO_EVENT_ROWS")

    events = v54.add_cross_section(pl.concat(frames, how="vertical_relaxed"))
    pdf = events.to_pandas()
    pdf["timestamp"] = pd.to_datetime(pdf["timestamp"], utc=True)
    pdf["entryTime"] = pd.to_datetime(pdf["entryTime"], utc=True)
    pdf["period"] = v54.period_for(pdf["timestamp"])
    pdf = pdf.replace([np.inf, -np.inf], np.nan).dropna(
        subset=v54.FEATURES + ["netReturn", "labelTargetFirst3"]
    )
    for f in v54.FEATURES:
        pdf[f] = pd.to_numeric(pdf[f], errors="coerce").astype("float32")

    pdf = pdf.sort_values(
        ["timestamp", "symbol", "entryTime"],
        ascending=[True, True, True],
        kind="mergesort",
    ).reset_index(drop=True)

    historical = {}
    for p in ("train", "calibration", "validation", "fresh_oos"):
        historical[p] = (
            pdf[pdf["period"].eq(p)]
            .sort_values(["timestamp", "symbol", "entryTime"], kind="mergesort")
            .reset_index(drop=True)
        )

    def frame_fingerprint(df: pd.DataFrame) -> str:
        import hashlib
        cols = ["timestamp", "symbol", "entryTime", *v54.FEATURES, "labelTargetFirst3", "netReturn"]
        h = pd.util.hash_pandas_object(df[cols], index=False).to_numpy(dtype="uint64")
        return hashlib.sha256(h.tobytes()).hexdigest()

    current_fingerprints = {k: frame_fingerprint(v) for k, v in historical.items()}
    expected_fingerprints = prior.get("inputFingerprints") or {}
    for p in ("train", "calibration", "validation", "fresh_oos"):
        if current_fingerprints.get(p) != expected_fingerprints.get(p):
            raise RuntimeError(
                f"V543_INPUT_FINGERPRINT_MISMATCH:{p}:"
                f"{expected_fingerprints.get(p)}:{current_fingerprints.get(p)}"
            )

    train = historical["train"]
    cal = historical["calibration"]
    forward = (
        pdf[pdf["timestamp"] >= FORWARD_START]
        .sort_values(["timestamp", "symbol", "entryTime"], kind="mergesort")
        .reset_index(drop=True)
    )

    if min(len(train), len(cal)) < 1000:
        raise RuntimeError(f"V543_BASE_PERIOD_TOO_SMALL:{len(train)}:{len(cal)}")
    if forward.empty:
        raise RuntimeError("V543_NO_POST_FREEZE_ROWS")

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
        random_state=540,
        deterministic=True,
        force_col_wise=True,
        n_jobs=8,
        verbosity=-1,
    )
    model.fit(train[v54.FEATURES], train["labelTargetFirst3"].astype(int))

    cal_score = model.predict_proba(cal[v54.FEATURES])[:, 1]
    mode, winner, _ = v54.select_threshold(cal, cal_score)
    recomputed_threshold = float(winner["threshold"])
    if abs(recomputed_threshold - frozen_threshold) > 1e-12:
        raise RuntimeError(
            f"V543_FROZEN_THRESHOLD_MISMATCH:{frozen_threshold}:{recomputed_threshold}"
        )

    forward_score = model.predict_proba(forward[v54.FEATURES])[:, 1]
    base = v54.score_metrics(forward, forward_score, frozen_threshold, 0.0)
    stress = v54.score_metrics(forward, forward_score, frozen_threshold, EXTRA_STRESS)

    selected = forward.loc[forward_score >= frozen_threshold].copy()
    selected["score"] = forward_score[forward_score >= frozen_threshold]
    selected.to_parquet(out / "selected-forward-events.parquet", index=False)

    day_rows = []
    if len(selected):
        for day, g in selected.groupby(selected["timestamp"].dt.strftime("%Y-%m-%d")):
            net = pd.to_numeric(g["netReturn"], errors="coerce").dropna()
            day_rows.append(
                {
                    "day": day,
                    "selected": int(len(g)),
                    "meanNet": float(net.mean()) if len(net) else None,
                    "netSum": float(net.sum()) if len(net) else None,
                    "targetFirstRate": float(
                        pd.to_numeric(g["labelTargetFirst3"], errors="coerce")
                        .fillna(0)
                        .mean()
                    ),
                    "symbols": int(g["symbol"].astype(str).nunique()),
                }
            )
    pd.DataFrame(day_rows).to_csv(out / "forward-by-day.csv", index=False)
    pd.DataFrame(audits).to_json(
        out / "source-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-long-forward-v543",
        "sourceRunV542": 37475568221,
        "sourceHeadV542": "0dcfd2c31c71be995bf34f10acd53379759473c0",
        "sourceSelectionMode": prior.get("calibrationSelection", {}).get("mode"),
        "sourceDatasetRevision": prior.get("datasetRevision"),
        "currentDatasetRevision": current_dataset_revision,
        "historicalFingerprintsExpected": expected_fingerprints,
        "historicalFingerprintsCurrent": current_fingerprints,
        "frozenThreshold": frozen_threshold,
        "recomputedThresholdCheck": recomputed_threshold,
        "recomputedSelectionMode": mode,
        "forwardStart": str(FORWARD_START),
        "forwardEnd": str(forward["timestamp"].max()),
        "forwardRows": int(len(forward)),
        "selectedForwardRows": int(len(selected)),
        "selectedForwardSymbols": int(selected["symbol"].astype(str).nunique()) if len(selected) else 0,
        "metrics": base,
        "plus10bp": stress,
        "byDay": day_rows,
        "truthBoundary": {
            "v542ModelSpecificationFrozen": True,
            "v542CalibrationThresholdRecomputedAndMustMatchExactly": True,
            "post2026Oct01RowsExcludedFromV54TrainCalibrationValidationFresh": True,
            "forwardRowsNeverChooseModelOrThreshold": True,
            "historicalInputFingerprintsMustMatchExactly": True,
            "deterministicModelRebuildRequired": True,
            "noThresholdRetuning": True,
            "noCandidateReselection": True,
            "sameCausalFeatureAndLongPathContractAsV542": True,
            "diagnosticForwardEvidenceOnly": True,
            "notEnoughElapsedTimeForPromotionProof": True,
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

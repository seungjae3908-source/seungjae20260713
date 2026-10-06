#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download
from lightgbm import LGBMRegressor

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


base = load(
    "futures_v542",
    "market-prediction-lab/scripts/run-crypto-futures-causal-long-opportunity-ranker-v542.py",
)

CLOCK_FEATURES = {"hourSin", "hourCos", "dowSin", "dowCos"}
FEATURES = [x for x in base.FEATURES if x not in CLOCK_FEATURES]
EXTRA_STRESS = 0.0010
FREEZE_NOT_BEFORE = "2026-10-07T00:00:00Z"


def frame_fingerprint(df: pd.DataFrame) -> str:
    cols = ["timestamp", "symbol", "entryTime", *FEATURES, "labelTargetFirst3", "netReturn"]
    h = pd.util.hash_pandas_object(df[cols], index=False).to_numpy(dtype="uint64")
    return hashlib.sha256(h.tobytes()).hexdigest()


def economic_metrics(df: pd.DataFrame, pred: np.ndarray, threshold: float, extra_cost: float = 0.0):
    chosen = pred >= threshold
    selected = int(chosen.sum())
    if selected == 0:
        return {
            "threshold": float(threshold),
            "rows": int(len(df)),
            "selected": 0,
            "selectedShare": 0.0,
            "meanNet": 0.0,
            "profitFactor": 0.0,
            "targetFirstRate": 0.0,
            "positiveMonths": 0,
            "negativeMonths": 0,
            "positiveActiveMonthRate": 0.0,
        }

    net = pd.to_numeric(df["netReturn"], errors="coerce").to_numpy(float)[chosen] - float(extra_cost)
    y = pd.to_numeric(df["labelTargetFirst3"], errors="coerce").fillna(0).to_numpy(int)[chosen]
    gp = float(np.maximum(net, 0.0).sum())
    gl = float(np.maximum(-net, 0.0).sum())
    months = pd.to_datetime(df.loc[chosen, "timestamp"], utc=True).dt.strftime("%Y-%m")
    ms = pd.DataFrame({"month": months.to_numpy(), "net": net}).groupby("month")["net"].sum()
    pm = int((ms > 0).sum())
    nm = int((ms < 0).sum())
    return {
        "threshold": float(threshold),
        "rows": int(len(df)),
        "selected": selected,
        "selectedShare": float(selected / max(len(df), 1)),
        "meanNet": float(net.mean()),
        "profitFactor": float(gp / max(gl, 1e-12)),
        "targetFirstRate": float((y == 1).mean()),
        "positiveMonths": pm,
        "negativeMonths": nm,
        "positiveActiveMonthRate": float(pm / max(pm + nm, 1)),
    }


def choose_threshold(cal: pd.DataFrame, pred: np.ndarray):
    qs = np.unique(
        np.array(
            [
                0.90,
                0.925,
                0.95,
                0.96,
                0.97,
                0.98,
                0.985,
                0.99,
                0.9925,
                0.995,
                0.9975,
                0.999,
            ],
            dtype=float,
        )
    )
    thresholds = np.unique(np.quantile(pred, qs))
    grid = [economic_metrics(cal, pred, float(t), 0.0) for t in thresholds]
    eligible = [
        r
        for r in grid
        if r["selected"] >= 500
        and r["meanNet"] >= 0.0010
        and r["profitFactor"] >= 1.15
        and r["targetFirstRate"] >= 0.35
        and r["selectedShare"] <= 0.05
        and r["positiveActiveMonthRate"] >= 0.50
    ]
    if eligible:
        winner = max(
            eligible,
            key=lambda r: (
                r["meanNet"],
                r["profitFactor"],
                r["targetFirstRate"],
                r["positiveActiveMonthRate"],
            ),
        )
        mode = "CALIBRATION_ECONOMIC_GATE"
    else:
        feasible = [r for r in grid if r["selected"] >= 500] or grid
        winner = max(feasible, key=lambda r: (r["meanNet"], r["profitFactor"], r["targetFirstRate"]))
        mode = "BEST_DIAGNOSTIC_ONLY"
    return mode, winner, grid


def diagnostic_gate(m: dict, min_rows: int):
    checks = {
        "minimumSelectedRows": int(m["selected"]) >= min_rows,
        "positiveEV": float(m["meanNet"]) > 0,
        "profitFactorAbove1": float(m["profitFactor"]) > 1,
        "targetFirstAtLeast35pct": float(m["targetFirstRate"]) >= 0.35,
        "positiveActiveMonthRateAtLeast50pct": float(m["positiveActiveMonthRate"]) >= 0.50,
    }
    return {"pass": bool(all(checks.values())), "checks": checks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    snapshot_root = Path(
        snapshot_download(
            repo_id=base.DATASET,
            repo_type="dataset",
            allow_patterns=[f"{base.SUB}/15m/*.parquet"],
        )
    )
    dataset_revision = snapshot_root.name
    folder = snapshot_root / base.SUB / "15m"
    files = sorted(folder.glob("*.parquet"))

    frames = []
    audits = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(base.process_file, p): p for p in files}
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
        raise RuntimeError("V55_NO_EVENT_ROWS")

    events = base.add_cross_section(pl.concat(frames, how="vertical_relaxed"))
    pdf = events.to_pandas()
    pdf["timestamp"] = pd.to_datetime(pdf["timestamp"], utc=True)
    pdf["entryTime"] = pd.to_datetime(pdf["entryTime"], utc=True)
    pdf["period"] = base.period_for(pdf["timestamp"])
    pdf = pdf[pdf["period"] != "outside"].copy()
    pdf = pdf.replace([np.inf, -np.inf], np.nan).dropna(
        subset=FEATURES + ["netReturn", "labelTargetFirst3"]
    )

    for f in FEATURES:
        pdf[f] = pd.to_numeric(pdf[f], errors="coerce").astype("float32")

    pdf = pdf.sort_values(
        ["timestamp", "symbol", "entryTime"],
        ascending=[True, True, True],
        kind="mergesort",
    ).reset_index(drop=True)

    split = {
        k: (
            pdf[pdf["period"].eq(k)]
            .sort_values(["timestamp", "symbol", "entryTime"], kind="mergesort")
            .reset_index(drop=True)
        )
        for k in ("train", "calibration", "validation", "fresh_oos")
    }
    if min(len(v) for v in split.values()) < 1000:
        raise RuntimeError(
            "V55_PERIOD_TOO_SMALL:"
            + ":".join(f"{k}={len(v)}" for k, v in split.items())
        )

    fingerprints = {k: frame_fingerprint(v) for k, v in split.items()}

    model = LGBMRegressor(
        objective="regression_l1",
        n_estimators=600,
        learning_rate=0.025,
        num_leaves=31,
        max_depth=10,
        min_child_samples=180,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.75,
        reg_lambda=2.5,
        random_state=550,
        deterministic=True,
        force_col_wise=True,
        n_jobs=8,
        verbosity=-1,
    )
    model.fit(split["train"][FEATURES], split["train"]["netReturn"].astype(float))

    cal_pred = model.predict(split["calibration"][FEATURES])
    mode, winner, grid = choose_threshold(split["calibration"], cal_pred)
    threshold = float(winner["threshold"])

    val_pred = model.predict(split["validation"][FEATURES])
    fresh_pred = model.predict(split["fresh_oos"][FEATURES])

    validation = economic_metrics(split["validation"], val_pred, threshold, 0.0)
    fresh = economic_metrics(split["fresh_oos"], fresh_pred, threshold, 0.0)
    validation_stress = economic_metrics(split["validation"], val_pred, threshold, EXTRA_STRESS)
    fresh_stress = economic_metrics(split["fresh_oos"], fresh_pred, threshold, EXTRA_STRESS)

    vg = diagnostic_gate(validation, 300)
    fg = diagnostic_gate(fresh, 150)
    vsg = diagnostic_gate(validation_stress, 300)
    fsg = diagnostic_gate(fresh_stress, 150)

    for name, df, pred in (
        ("validation", split["validation"], val_pred),
        ("fresh-oos", split["fresh_oos"], fresh_pred),
    ):
        sel = df.loc[pred >= threshold].copy()
        sel["predictedNet"] = pred[pred >= threshold]
        sel.to_parquet(out / f"selected-{name}.parquet", index=False)

    pd.DataFrame(audits).to_json(
        out / "source-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-expected-net-v55",
        "direction": "LONG",
        "dataset": base.DATASET,
        "datasetRevision": dataset_revision,
        "eventRows": int(len(pdf)),
        "rowCounts": {k: int(len(v)) for k, v in split.items()},
        "features": FEATURES,
        "removedClockFeatures": sorted(CLOCK_FEATURES),
        "inputFingerprints": fingerprints,
        "determinism": {
            "rowsSortedByTimestampSymbolEntryTime": True,
            "lightgbmDeterministic": True,
            "lightgbmForceColWise": True,
            "randomState": 550,
        },
        "calibrationSelection": {
            "mode": mode,
            "winner": winner,
            "grid": grid,
        },
        "diagnosticPreviouslyExposed": {
            "validation": validation,
            "freshOos": fresh,
            "validationPlus10bp": validation_stress,
            "freshOosPlus10bp": fresh_stress,
            "validationGate": vg,
            "freshOosGate": fg,
            "validationStressGate": vsg,
            "freshOosStressGate": fsg,
        },
        "freezeNotBefore": FREEZE_NOT_BEFORE,
        "promotionPass": False,
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
            "signalFeaturesUseCompleted15mBarAndPastOnly": True,
            "clockAndWeekdayFeaturesRemoved": True,
            "modelTargetIsCostIncludedNetReturn": True,
            "trainOnlyFitsModel": True,
            "calibrationOnlySelectsThreshold": True,
            "validationAndFreshArePreviouslyExposedDiagnosticOnly": True,
            "historicalDiagnosticCannotPromoteThisFamily": True,
            "requiresPostFreezeForwardAfter2026Oct07": True,
            "plus10bpDiagnosticReported": True,
            "noForwardRetuning": True,
            "datasetRevisionRecorded": True,
            "inputFingerprintsRecorded": True,
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

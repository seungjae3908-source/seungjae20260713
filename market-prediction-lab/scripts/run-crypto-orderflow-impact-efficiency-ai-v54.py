#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

BASE_FEATURES = [
    "activityScore","baseRvol","ret60","flow1","flow4","flowAccel4",
    "cvd12","cvd24","takerRatio","takerAccel","rvol","ret4","ret12",
    "vwapDist","quoteAccel4","rangePct","closeLoc",
]
DERIVED = [
    "alignedFlow1","alignedFlow4","alignedCvd12","alignedCvd24",
    "alignedFlowAccel","alignedTakerAccel","alignedRet4","alignedRet12",
    "flowPersistence","cvdCurve","impactEff4","impactEff12",
    "latentPressure4","latentPressure12","flowShock",
    "liquidityShock","vwapFlowInteraction","closeFlowInteraction",
    "rangeEfficiency","exhaustionGap",
]
FEATURES = BASE_FEATURES + DERIVED
EXTRA_COST = 0.0010

def add_features(df: pd.DataFrame) -> pd.DataFrame:
    x = df.copy()
    side = np.where(x["direction"].astype(str).eq("LONG"), 1.0, -1.0)
    eps = 0.02

    x["alignedFlow1"] = side * x["flow1"].astype(float)
    x["alignedFlow4"] = side * x["flow4"].astype(float)
    x["alignedCvd12"] = side * x["cvd12"].astype(float)
    x["alignedCvd24"] = side * x["cvd24"].astype(float)
    x["alignedFlowAccel"] = side * x["flowAccel4"].astype(float)
    x["alignedTakerAccel"] = side * x["takerAccel"].astype(float)
    x["alignedRet4"] = side * x["ret4"].astype(float)
    x["alignedRet12"] = side * x["ret12"].astype(float)

    stack = np.column_stack([
        x["alignedFlow1"], x["alignedFlow4"],
        x["alignedCvd12"], x["alignedCvd24"],
    ])
    x["flowPersistence"] = (stack > 0).mean(axis=1)
    x["cvdCurve"] = x["alignedCvd12"] - x["alignedCvd24"]
    x["impactEff4"] = x["alignedRet4"] / (x["alignedFlow4"].abs() + eps)
    x["impactEff12"] = x["alignedRet12"] / (x["alignedCvd12"].abs() + eps)
    x["latentPressure4"] = x["alignedFlow4"] - x["alignedRet4"]
    x["latentPressure12"] = x["alignedCvd12"] - x["alignedRet12"]
    x["flowShock"] = x["alignedFlowAccel"] * np.log1p(x["rvol"].clip(lower=0))
    x["liquidityShock"] = (
        np.log1p(x["quoteAccel4"].clip(lower=0))
        * np.log1p(x["rvol"].clip(lower=0))
    )
    x["vwapFlowInteraction"] = (-side * x["vwapDist"].astype(float)) * x["alignedFlow4"]
    x["closeFlowInteraction"] = (x["closeLoc"].astype(float) - 0.5) * x["alignedFlow1"]
    x["rangeEfficiency"] = x["alignedRet4"].abs() / (x["rangePct"].abs() + 1e-5)
    x["exhaustionGap"] = x["alignedRet12"] - x["alignedCvd24"]

    return x.replace([np.inf, -np.inf], np.nan)

def metrics(df: pd.DataFrame, score: np.ndarray, threshold: float, extra_cost: float = 0.0):
    pred = score >= threshold
    y = df["labelTargetFirst3"].astype(int).to_numpy()
    net = df["netReturn"].astype(float).to_numpy() - extra_cost
    selected = int(pred.sum())
    if selected == 0:
        return {
            "threshold": float(threshold), "rows": int(len(df)), "selected": 0,
            "targetFirst3": 0, "targetFirstRate": 0.0, "recall": 0.0,
            "meanNet": 0.0, "profitFactor": 0.0, "positiveMonths": 0,
            "negativeMonths": 0, "positiveActiveMonthRate": 0.0,
        }

    yy = y[pred]
    nn = net[pred]
    target = int((yy == 1).sum())
    positives = int((y == 1).sum())
    gp = float(np.maximum(nn, 0).sum())
    gl = float(np.maximum(-nn, 0).sum())
    pf = gp / max(gl, 1e-12)

    z = pd.DataFrame({
        "month": df.loc[pred, "month"].astype(str).to_numpy(),
        "net": nn,
    })
    by_month = z.groupby("month")["net"].sum()
    pm = int((by_month > 0).sum())
    nm = int((by_month < 0).sum())
    active = pm + nm

    return {
        "threshold": float(threshold),
        "rows": int(len(df)),
        "selected": selected,
        "targetFirst3": target,
        "targetFirstRate": float(target / max(selected, 1)),
        "recall": float(target / max(positives, 1)),
        "selectedShare": float(selected / max(len(df), 1)),
        "meanNet": float(nn.mean()),
        "profitFactor": float(pf),
        "positiveMonths": pm,
        "negativeMonths": nm,
        "positiveActiveMonthRate": float(pm / max(active, 1)),
    }

def calibration_choice(cal: pd.DataFrame, score: np.ndarray):
    qs = np.unique(np.concatenate([
        np.linspace(0.70, 0.95, 26),
        np.array([0.96,0.97,0.98,0.985,0.99,0.9925,0.995,0.9975]),
    ]))
    thresholds = np.unique(np.quantile(score, qs))
    grid = [metrics(cal, score, float(t), 0.0) for t in thresholds]
    eligible = [
        r for r in grid
        if r["selected"] >= 75
        and r["meanNet"] >= 0.0015
        and r["profitFactor"] >= 1.30
        and r["targetFirstRate"] >= 0.40
        and r["positiveActiveMonthRate"] >= 0.67
        and r["selectedShare"] <= 0.20
    ]
    if eligible:
        winner = max(
            eligible,
            key=lambda r: (
                min(r["profitFactor"], 3.0),
                r["meanNet"],
                r["targetFirstRate"],
                r["positiveActiveMonthRate"],
            ),
        )
        mode = "PRECISION_ECONOMIC_GATE"
    else:
        feasible = [r for r in grid if r["selected"] >= 75] or grid
        winner = max(
            feasible,
            key=lambda r: (
                r["meanNet"],
                r["profitFactor"],
                r["targetFirstRate"],
            ),
        )
        mode = "BEST_DIAGNOSTIC_ONLY"
    return mode, winner, grid

def strict_gate(m: dict, min_rows: int):
    checks = {
        "minimumRows": int(m["selected"]) >= min_rows,
        "meanNetAtLeast20bp": float(m["meanNet"]) >= 0.0020,
        "profitFactorAtLeast1p5": float(m["profitFactor"]) >= 1.50,
        "targetFirstRateAtLeast42pct": float(m["targetFirstRate"]) >= 0.42,
        "positiveMonthRateAtLeast67pct": float(m["positiveActiveMonthRate"]) >= 0.67,
    }
    return {"pass": bool(all(checks.values())), "checks": checks}

def fit_direction(data: pd.DataFrame, direction: str):
    d = data[data["direction"].astype(str).eq(direction)].copy()
    split = {k: d[d["period"].astype(str).eq(k)].copy()
             for k in ("train","calibration","validation","fresh_oos")}
    if min(len(split[k]) for k in split) < 100:
        return {"direction": direction, "error": "INSUFFICIENT_PERIOD_ROWS",
                "rowCounts": {k: int(len(v)) for k,v in split.items()}}

    model = LGBMClassifier(
        objective="binary",
        n_estimators=700,
        learning_rate=0.025,
        num_leaves=24,
        max_depth=8,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.80,
        reg_alpha=0.75,
        reg_lambda=2.5,
        random_state=541,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(split["train"][FEATURES], split["train"]["labelTargetFirst3"].astype(int))

    cal_score = model.predict_proba(split["calibration"][FEATURES])[:,1]
    mode, winner, grid = calibration_choice(split["calibration"], cal_score)
    thr = float(winner["threshold"])

    out = {
        "direction": direction,
        "rowCounts": {k: int(len(v)) for k,v in split.items()},
        "selectionMode": mode,
        "calibration": winner,
        "validation": metrics(
            split["validation"],
            model.predict_proba(split["validation"][FEATURES])[:,1],
            thr, 0.0,
        ),
        "freshOos": metrics(
            split["fresh_oos"],
            model.predict_proba(split["fresh_oos"][FEATURES])[:,1],
            thr, 0.0,
        ),
        "validationPlus10bp": metrics(
            split["validation"],
            model.predict_proba(split["validation"][FEATURES])[:,1],
            thr, EXTRA_COST,
        ),
        "freshOosPlus10bp": metrics(
            split["fresh_oos"],
            model.predict_proba(split["fresh_oos"][FEATURES])[:,1],
            thr, EXTRA_COST,
        ),
        "featureImportance": sorted(
            [{"feature": f, "importance": float(v)}
             for f,v in zip(FEATURES, model.feature_importances_)],
            key=lambda z: z["importance"],
            reverse=True,
        )[:15],
        "calibrationGrid": grid,
    }

    out["validationGate"] = strict_gate(out["validation"], 100)
    out["freshOosGate"] = strict_gate(out["freshOos"], 60)
    out["validationStressGate"] = strict_gate(out["validationPlus10bp"], 100)
    out["freshOosStressGate"] = strict_gate(out["freshOosPlus10bp"], 60)
    out["promotionPass"] = bool(
        mode == "PRECISION_ECONOMIC_GATE"
        and out["validationGate"]["pass"]
        and out["freshOosGate"]["pass"]
        and out["validationStressGate"]["pass"]
        and out["freshOosStressGate"]["pass"]
    )
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True, choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--events", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    data = pd.read_parquet(args.events)
    required = set(BASE_FEATURES + [
        "market","direction","period","month","netReturn","labelTargetFirst3"
    ])
    missing = required - set(data.columns)
    if missing:
        raise RuntimeError(f"V54_REQUIRED_COLUMNS_MISSING:{sorted(missing)}")

    data = data[data["market"].astype(str).eq(args.market)].copy()
    data = add_features(data)
    data = data.dropna(subset=FEATURES + ["netReturn","labelTargetFirst3"])
    if len(data) < 1000:
        raise RuntimeError(f"V54_TOO_FEW_ROWS:{len(data)}")

    directions = ["LONG"] if args.market == "CRYPTO_SPOT" else ["LONG","SHORT"]
    results = {d: fit_direction(data, d) for d in directions}
    promotion = any(bool(x.get("promotionPass")) for x in results.values())

    result = {
        "schemaVersion": 1,
        "contract": "crypto-orderflow-impact-efficiency-ai-v54",
        "market": args.market,
        "sourceContract": "crypto-orderflow-targetfirst-ai-v43",
        "sourceRun": 37443253984,
        "rows": int(len(data)),
        "baseFeatures": BASE_FEATURES,
        "derivedFeatures": DERIVED,
        "directions": results,
        "promotionPass": bool(promotion),
        "truthBoundary": {
            "newFamilyUsesFlowPersistenceAndPriceImpactEfficiency": True,
            "frozenV43EventOutcomesReusedWithoutRelabeling": True,
            "trainOnlyFitsModel": True,
            "calibrationOnlySelectsThreshold": True,
            "validationNeverSelectsModelOrThreshold": True,
            "freshOosNeverSelectsModelOrThreshold": True,
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

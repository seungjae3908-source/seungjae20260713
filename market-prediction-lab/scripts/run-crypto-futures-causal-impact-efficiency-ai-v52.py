#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

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
    "impact_v54",
    "market-prediction-lab/scripts/run-crypto-orderflow-impact-efficiency-ai-v54.py",
)

MARKET = "CRYPTO_FUTURES"
DIRECTION = "SHORT"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--v51-summary", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    prior = json.loads(Path(args.v51_summary).read_text(encoding="utf-8"))
    if prior.get("contract") != "crypto-futures-causal-targetfirst-ai-v51":
        raise RuntimeError("V52_WRONG_SOURCE_CONTRACT")

    truth = prior.get("truthBoundary", {})
    required_truth = {
        "legacyV43DailyTop2AndDailyTop50NotUsed": True,
        "eventOnsetUsesCurrentAndPriorCompletedBarsOnly": True,
        "top10PromotionUsesSameCompletedTimestampOnly": True,
        "signalFeaturesUseCompleted15mBarAndPastOnly": True,
        "validationAndFreshExcludedFromFitAndThresholdSelection": True,
        "noThresholdRetuningAfterValidation": True,
    }
    for key, expected in required_truth.items():
        if truth.get(key) is not expected:
            raise RuntimeError(f"V52_CAUSAL_BOUNDARY_MISSING:{key}")

    data = pd.read_parquet(args.events)
    required = set(
        v54.BASE_FEATURES
        + [
            "market",
            "direction",
            "period",
            "month",
            "netReturn",
            "labelTargetFirst3",
            "timestamp",
            "entryTime",
            "exitTime",
            "symbol",
            "rankAtTimestamp",
        ]
    )
    missing = required - set(data.columns)
    if missing:
        raise RuntimeError(f"V52_REQUIRED_COLUMNS_MISSING:{sorted(missing)}")

    data = data[
        data["market"].astype(str).eq(MARKET)
        & data["direction"].astype(str).eq(DIRECTION)
    ].copy()
    data = v54.add_features(data)
    data = data.replace([np.inf, -np.inf], np.nan).dropna(
        subset=v54.FEATURES + ["netReturn", "labelTargetFirst3"]
    )
    if len(data) < 1000:
        raise RuntimeError(f"V52_TOO_FEW_ROWS:{len(data)}")

    result_short = v54.fit_direction(data, DIRECTION)

    compact = data[
        [
            "timestamp",
            "symbol",
            "period",
            "rankAtTimestamp",
            "entryTime",
            "exitTime",
            "netReturn",
            "labelTargetFirst3",
        ]
    ].copy()
    compact.to_parquet(out / "causal-impact-source-ledger.parquet", index=False)

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-impact-efficiency-ai-v52",
        "market": MARKET,
        "direction": DIRECTION,
        "sourceRunV51": 37467915233,
        "sourceV51PromotionPass": bool(prior.get("promotionPass")),
        "rows": int(len(data)),
        "baseFeatures": v54.BASE_FEATURES,
        "derivedFeatures": v54.DERIVED,
        "modelResult": result_short,
        "promotionPass": bool(result_short.get("promotionPass")),
        "truthBoundary": {
            "sourceEventsAreCausalV51Only": True,
            "legacyV43DailyHindsightEventsNotUsed": True,
            "sameTimestampTop10CandidateUniverseFrozenBeforeThisModel": True,
            "allUniverseScannerRemainsSeparateFromExecutionRanking": True,
            "derivedFamilyUsesFlowPersistencePriceImpactAndLatentPressure": True,
            "trainOnlyFitsModel": True,
            "calibrationOnlySelectsThreshold": True,
            "validationNeverSelectsModelOrThreshold": True,
            "freshOosNeverSelectsModelOrThreshold": True,
            "plus10bpStressRequiredForPromotion": True,
            "noThresholdRetuningAfterValidation": True,
            "noCandidateReselectionAfterValidation": True,
            "eventLevelEconomicsNotExact1mYet": True,
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

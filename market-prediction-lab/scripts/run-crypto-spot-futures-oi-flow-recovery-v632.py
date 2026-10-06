#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


oi = load(
    "oi_v4",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-futures-oi-v4.py",
)

EXTRA_STRESS = 0.0010
FREEZE_NOT_BEFORE = "2026-10-07T00:00:00Z"

FIXED_FLOW_RULE = {
    "ret60Max": -0.015,
    "baseRvolMin": 1.5,
    "flow4Min": 0.03,
    "flowAccel4Min": 0.0,
    "takerRatioMin": 0.51,
    "vwapDistMin": -0.005,
}

OI_RULES = {
    "OI1H_DOWN": lambda x: x["oi1h"] <= -0.005,
    "OI4H_DOWN": lambda x: x["oi4h"] <= -0.010,
    "OI1H_DOWN_TAKER_LONG": lambda x: (
        (x["oi1h"] <= -0.005) & (x["sum_taker_long_short_vol_ratio"] >= 1.0)
    ),
    "OI1H_UP_TAKER_LONG": lambda x: (
        (x["oi1h"] >= 0.005) & (x["sum_taker_long_short_vol_ratio"] >= 1.0)
    ),
    "OI1H_DOWN_CROWD_SHORT": lambda x: (
        (x["oi1h"] <= -0.005) & (x["count_long_short_ratio"] <= 1.0)
    ),
}


def flow_mask(x: pd.DataFrame) -> pd.Series:
    return (
        (pd.to_numeric(x["ret60"], errors="coerce") <= FIXED_FLOW_RULE["ret60Max"])
        & (pd.to_numeric(x["baseRvol"], errors="coerce") >= FIXED_FLOW_RULE["baseRvolMin"])
        & (pd.to_numeric(x["flow4"], errors="coerce") >= FIXED_FLOW_RULE["flow4Min"])
        & (pd.to_numeric(x["flowAccel4"], errors="coerce") >= FIXED_FLOW_RULE["flowAccel4Min"])
        & (pd.to_numeric(x["takerRatio"], errors="coerce") >= FIXED_FLOW_RULE["takerRatioMin"])
        & (pd.to_numeric(x["vwapDist"], errors="coerce") >= FIXED_FLOW_RULE["vwapDistMin"])
    ).fillna(False)


def metrics(x: pd.DataFrame, extra_cost: float = 0.0):
    if x.empty:
        return {
            "rows": 0,
            "meanNet": 0.0,
            "profitFactor": 0.0,
            "targetFirstRate": 0.0,
            "positiveMonths": 0,
            "negativeMonths": 0,
            "positiveActiveMonthRate": 0.0,
        }
    net = pd.to_numeric(x["netReturn"], errors="coerce").to_numpy(float) - float(extra_cost)
    y = pd.to_numeric(x["labelTargetFirst3"], errors="coerce").fillna(0).astype(int).to_numpy()
    gp = float(np.maximum(net, 0).sum())
    gl = float(np.maximum(-net, 0).sum())
    months = pd.to_datetime(x["timestamp"], utc=True).dt.strftime("%Y-%m")
    ms = pd.DataFrame({"month": months.to_numpy(), "net": net}).groupby("month")["net"].sum()
    pm = int((ms > 0).sum())
    nm = int((ms < 0).sum())
    return {
        "rows": int(len(x)),
        "meanNet": float(net.mean()),
        "profitFactor": float(gp / max(gl, 1e-12)),
        "targetFirstRate": float((y == 1).mean()),
        "positiveMonths": pm,
        "negativeMonths": nm,
        "positiveActiveMonthRate": float(pm / max(pm + nm, 1)),
    }


def train_gate(m: dict):
    checks = {
        "rowsAtLeast60": m["rows"] >= 60,
        "positiveEV": m["meanNet"] > 0,
        "pfAbove1": m["profitFactor"] > 1,
        "positiveMonthsAtLeast50pct": m["positiveActiveMonthRate"] >= 0.50,
    }
    return {"pass": all(checks.values()), "checks": checks}


def calibration_gate(m: dict):
    checks = {
        "rowsAtLeast40": m["rows"] >= 40,
        "meanNetAtLeast10bp": m["meanNet"] >= 0.0010,
        "pfAtLeast1p15": m["profitFactor"] >= 1.15,
        "targetFirstAtLeast35pct": m["targetFirstRate"] >= 0.35,
        "positiveMonthsAtLeast50pct": m["positiveActiveMonthRate"] >= 0.50,
    }
    return {"pass": all(checks.values()), "checks": checks}


def diagnostic_gate(m: dict, min_rows: int):
    checks = {
        "minimumRows": m["rows"] >= min_rows,
        "positiveEV": m["meanNet"] > 0,
        "pfAbove1": m["profitFactor"] > 1,
        "targetFirstAtLeast35pct": m["targetFirstRate"] >= 0.35,
        "positiveMonthsAtLeast50pct": m["positiveActiveMonthRate"] >= 0.50,
    }
    return {"pass": all(checks.values()), "checks": checks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    cols = [
        "timestamp",
        "symbol",
        "period",
        "month",
        "ret60",
        "baseRvol",
        "flow4",
        "flowAccel4",
        "takerRatio",
        "vwapDist",
        "netReturn",
        "labelTargetFirst3",
        "entryTime",
        "exitTime",
    ]
    x = pd.read_parquet(args.events, columns=cols)
    x["timestamp"] = pd.to_datetime(x["timestamp"], utc=True)
    x["entryTime"] = pd.to_datetime(x["entryTime"], utc=True)
    x["exitTime"] = pd.to_datetime(x["exitTime"], utc=True)
    x["symbol"] = x["symbol"].astype(str)
    x = x.loc[flow_mask(x)].copy()
    if x.empty:
        raise RuntimeError("V632_NO_FLOW_RECOVERY_EVENTS")

    signals = x[["symbol", "timestamp"]].rename(columns={"timestamp": "signalEnd"}).copy()
    signals["signalEnd"] = pd.to_datetime(signals["signalEnd"], utc=True) + pd.Timedelta(minutes=15)

    met, meta = oi.load_metrics_for_signals(signals)
    attached = oi.attach_metrics(pl.from_pandas(x), met)
    if attached.empty:
        raise RuntimeError("V632_NO_OI_ATTACHED_EVENTS")

    attached["timestamp"] = pd.to_datetime(attached["timestamp"], utc=True)
    attached["month"] = attached["timestamp"].dt.strftime("%Y-%m")
    attached.to_parquet(out / "flow-recovery-oi-events.parquet", index=False)

    reports = {}
    for name, fn in OI_RULES.items():
        z = attached.loc[fn(attached).fillna(False)].copy()
        splits = {
            p: z[z["period"].astype(str) == p].copy()
            for p in ("train", "calibration", "validation", "fresh_oos")
        }
        mm = {p: metrics(v, 0.0) for p, v in splits.items()}
        stress = {p: metrics(v, EXTRA_STRESS) for p, v in splits.items()}
        reports[name] = {
            "train": mm["train"],
            "calibration": mm["calibration"],
            "validationDiagnostic": mm["validation"],
            "freshOosDiagnostic": mm["fresh_oos"],
            "validationPlus10bpDiagnostic": stress["validation"],
            "freshOosPlus10bpDiagnostic": stress["fresh_oos"],
            "trainGate": train_gate(mm["train"]),
            "calibrationGate": calibration_gate(mm["calibration"]),
            "validationDiagnosticGate": diagnostic_gate(mm["validation"], 40),
            "freshDiagnosticGate": diagnostic_gate(mm["fresh_oos"], 25),
        }
        reports[name]["eligibleAfterCalibration"] = bool(
            reports[name]["trainGate"]["pass"] and reports[name]["calibrationGate"]["pass"]
        )

    eligible = [k for k, v in reports.items() if v["eligibleAfterCalibration"]]
    selected = (
        max(
            eligible,
            key=lambda k: (
                reports[k]["calibration"]["meanNet"],
                reports[k]["calibration"]["profitFactor"],
                reports[k]["calibration"]["targetFirstRate"],
            ),
        )
        if eligible
        else None
    )

    result = {
        "schemaVersion": 1,
        "contract": "crypto-spot-futures-oi-flow-recovery-v632",
        "sourceRunV61": 37471171237,
        "fixedFlowRule": FIXED_FLOW_RULE,
        "sourceFlowRows": int(len(x)),
        "oiAttachedRows": int(len(attached)),
        "oiSource": meta,
        "oiRulesFrozenBeforeOutcomeInspection": list(OI_RULES),
        "rules": reports,
        "eligibleAfterCalibration": eligible,
        "selectedByCalibration": selected,
        "freezeNotBefore": FREEZE_NOT_BEFORE,
        "promotionPass": False,
        "truthBoundary": {
            "flowRuleFrozenBeforeOutcomeInspection": True,
            "oiRulesFrozenBeforeOutcomeInspection": True,
            "trainAndCalibrationOnlySelectOiRule": True,
            "validationAndFreshArePreviouslyExposedDiagnosticOnly": True,
            "historicalDiagnosticCannotPromoteThisFamily": True,
            "requiresPostFreezeForwardAfter2026Oct07": True,
            "oiUsesMostRecentEffectiveMetricAtOrBeforeSignalEnd": True,
            "plus10bpDiagnosticsReported": True,
            "spotLongOnly": True,
            "noForwardRetuning": True,
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

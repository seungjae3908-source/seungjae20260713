#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
COMMON_PATH = ROOT / "market-prediction-lab" / "scripts" / "always_on_portfolio_replay.py"
SPEC = importlib.util.spec_from_file_location("always_on_common", COMMON_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("ALWAYS_ON_COMMON_IMPORT_FAILED")
common = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(common)


def infer_market(path: Path) -> str:
    u = str(path).upper()
    if "CRYPTO_FUTURES" in u:
        return "CRYPTO_FUTURES"
    if "CRYPTO_SPOT" in u:
        return "CRYPTO_SPOT"
    raise RuntimeError(f"MARKET_NOT_IN_PATH:{path}")


def prepare_ledger(path: Path) -> pd.DataFrame:
    x = pd.read_csv(path)
    market = infer_market(path)
    required = [
        "timestamp", "symbol", "direction", "entryTime", "exitTime",
        "netReturn", "MFE", "MAE", "lagGap",
    ]
    missing = [c for c in required if c not in x.columns]
    if missing:
        raise RuntimeError(f"LEDGER_MISSING:{path}:{','.join(missing)}")

    x["market"] = market
    lag = pd.to_numeric(x["lagGap"], errors="coerce").fillna(0.0)
    liq = pd.to_numeric(x.get("liquidityPct"), errors="coerce")
    if liq is None:
        liq = pd.Series(np.ones(len(x)), index=x.index)
    liq = liq.fillna(1.0).clip(0.0, 1.0)
    # Ranking only; entry/exit/return come unchanged from the frozen V4.2 ledger.
    x["score"] = lag + (1.0 - liq) * 0.001

    cols = [
        "market", "timestamp", "symbol", "direction", "score",
        "entryTime", "exitTime", "netReturn", "MFE", "MAE",
    ]
    return x[cols].copy()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-root", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    root = Path(args.input_root)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    ledgers = sorted(root.glob("**/selected-ledger.csv"))
    if not ledgers:
        raise RuntimeError("NO_V42_SELECTED_LEDGERS")

    frames = []
    source = []
    for p in ledgers:
        try:
            f = prepare_ledger(p)
        except RuntimeError as exc:
            source.append({"path": str(p), "error": str(exc)})
            continue
        frames.append(f)
        source.append(
            {
                "path": str(p),
                "market": str(f["market"].iloc[0]),
                "rows": int(len(f)),
            }
        )

    if not frames:
        raise RuntimeError("NO_USABLE_V42_SELECTED_LEDGERS")

    events = pd.concat(frames, ignore_index=True)
    events = common.normalize_events(events)
    events.to_csv(out / "normalized-events.csv", index=False)

    grid = common.scenario_grid(
        events,
        capacities=(1, 2, 3, 5, 10, 20, None),
        opportunity_target=0.03,
    )
    pd.DataFrame(grid).to_csv(out / "capacity-grid.csv", index=False)

    unlimited = common.replay_always_on(
        events,
        max_positions=None,
        opportunity_target=0.03,
    )
    cap5 = common.replay_always_on(
        events,
        max_positions=5,
        opportunity_target=0.03,
    )

    result = {
        "schemaVersion": 1,
        "contract": "crypto-v42-always-on-replay-v1",
        "sourceRun": 37420018782,
        "sourceLedgers": source,
        "eventRows": int(len(events)),
        "capacityGrid": grid,
        "unlimited": unlimited,
        "max5": cap5,
        "truthBoundary": {
            "usesFrozenV42SelectedLedgers": True,
            "doesNotReselectCandidateUsingValidationOrPostHoc": True,
            "scannerContinuesWhilePositionsOpen": unlimited["truthBoundary"][
                "scannerNeverSuspendedByOpenPosition"
            ],
            "sameSymbolReentryAllowedAfterExit": unlimited["truthBoundary"][
                "sameSymbolReentryAllowedAfterExit"
            ],
            "thisIsPortfolioReplayNotFreshProfitabilityProof": True,
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

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

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


v43 = load(
    "crypto_v43",
    "market-prediction-lab/scripts/run-crypto-orderflow-targetfirst-ai-v43.py",
)

MARKET = "CRYPTO_FUTURES"
DIRECTION = "SHORT"
TOP_PER_TIMESTAMP = 10
SHARD_COUNT_DEFAULT = 8


def shard_for(symbol: str, count: int) -> int:
    h = hashlib.sha256(symbol.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") % count


def load_top10(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {
        "date",
        "month",
        "symbol",
        "activityScore",
        "baseRvol",
        "ret60",
    }
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"V51_SELECTED_COLUMNS_MISSING:{sorted(missing)}")

    df["date"] = pd.to_datetime(df["date"], utc=True)
    df["month"] = df["month"].astype(str)
    df["symbol"] = df["symbol"].astype(str)
    df["activityScore"] = pd.to_numeric(df["activityScore"], errors="coerce")
    df["baseRvol"] = pd.to_numeric(df["baseRvol"], errors="coerce")
    df["ret60"] = pd.to_numeric(df["ret60"], errors="coerce")
    df = df.dropna(
        subset=["date", "activityScore", "baseRvol", "ret60"]
    ).copy()
    df = df.sort_values(
        ["date", "activityScore", "symbol"],
        ascending=[True, False, True],
    )
    df["rankAtTimestamp"] = df.groupby("date").cumcount() + 1
    df = df[df["rankAtTimestamp"] <= TOP_PER_TIMESTAMP].copy()
    df = df.rename(columns={"date": "timestamp"})
    return df.reset_index(drop=True)


def process_symbol_short(symbol: str, candidates: pd.DataFrame):
    months = set(candidates["month"].astype(str))
    frames = []
    failures = []

    for m in v43.add_month_context(months):
        _, _, df, status = v43.flow.fetch_month_symbol(MARKET, symbol, m)
        if df is not None and not df.empty:
            frames.append(df)
        elif status != "404":
            failures.append({"month": m, "status": status})

    if not frames:
        return [], {
            "symbol": symbol,
            "ok": False,
            "error": "NO_RAW_FRAMES",
            "failures": failures[:20],
        }

    raw = (
        pd.concat(frames, ignore_index=True)
        .sort_values("timestamp")
        .drop_duplicates("timestamp")
        .reset_index(drop=True)
    )
    feat = v43.augment_features(raw)
    if feat.empty:
        return [], {
            "symbol": symbol,
            "ok": False,
            "error": "NO_FEATURES",
            "failures": failures[:20],
        }

    feat["timestamp"] = pd.to_datetime(feat["timestamp"], utc=True)
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], utc=True)
    idxmap = {pd.Timestamp(t): i for i, t in enumerate(raw["timestamp"])}
    fidx = feat.set_index("timestamp", drop=False)

    rows = []
    for _, cand in candidates.iterrows():
        t = pd.Timestamp(cand["timestamp"])
        if t.tzinfo is None:
            t = t.tz_localize("UTC")
        else:
            t = t.tz_convert("UTC")

        if t not in fidx.index:
            continue
        fr = fidx.loc[t]
        if isinstance(fr, pd.DataFrame):
            fr = fr.iloc[-1]
        i = idxmap.get(t)
        if i is None:
            continue

        vals = {
            "activityScore": float(cand["activityScore"]),
            "baseRvol": float(cand["baseRvol"]),
            "ret60": float(cand["ret60"]),
            "flow1": fr.get("flow1"),
            "flow4": fr.get("flow4"),
            "flowAccel4": fr.get("flowAccel4"),
            "cvd12": fr.get("cvd12"),
            "cvd24": fr.get("cvd24"),
            "takerRatio": fr.get("takerRatio"),
            "takerAccel": fr.get("takerAccel"),
            "rvol": fr.get("rvol"),
            "ret4": fr.get("ret4"),
            "ret12": fr.get("ret12"),
            "vwapDist": fr.get("vwapDist"),
            "quoteAccel4": fr.get("quoteAccel4"),
            "rangePct": fr.get("rangePct"),
            "closeLoc": fr.get("closeLoc"),
        }
        if any(v is None or pd.isna(v) for v in vals.values()):
            continue
        if any(not np.isfinite(float(v)) for v in vals.values()):
            continue

        oc = v43.path_outcome(
            raw, i, DIRECTION, v43.COSTS[MARKET]
        )
        if oc is None:
            continue

        rows.append(
            {
                "market": MARKET,
                "symbol": symbol,
                "timestamp": t,
                "date": t.date(),
                "month": t.strftime("%Y-%m"),
                "direction": DIRECTION,
                "rankAtTimestamp": int(cand["rankAtTimestamp"]),
                **{k: float(v) for k, v in vals.items()},
                **oc,
            }
        )

    return rows, {
        "symbol": symbol,
        "ok": True,
        "candidateRows": int(len(candidates)),
        "labeledRows": int(len(rows)),
        "rawRows": int(len(raw)),
        "featureRows": int(len(feat)),
        "monthsRequestedWithContext": int(len(v43.add_month_context(months))),
        "failures": failures[:20],
    }


def run_shard(selected_path: Path, shard_index: int, shard_count: int, out: Path):
    data = load_top10(selected_path)
    data["shard"] = [
        shard_for(s, shard_count) for s in data["symbol"].astype(str)
    ]
    part = data[data["shard"] == shard_index].copy()
    if part.empty:
        raise RuntimeError(f"V51_EMPTY_SHARD:{shard_index}")

    by_symbol = {
        str(s): g.drop(columns=["shard"]).copy()
        for s, g in part.groupby("symbol", sort=True)
    }

    rows = []
    audits = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {
            pool.submit(process_symbol_short, symbol, cand): symbol
            for symbol, cand in by_symbol.items()
        }
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            symbol = futs[fut]
            try:
                rr, aa = fut.result()
            except Exception as exc:
                rr = []
                aa = {
                    "symbol": symbol,
                    "ok": False,
                    "error": repr(exc),
                }
            rows.extend(rr)
            audits.append(aa)
            if idx % 10 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "shard": shard_index,
                            "symbolsComplete": idx,
                            "symbols": len(futs),
                            "labeledRows": len(rows),
                        }
                    ),
                    flush=True,
                )

    if not rows:
        raise RuntimeError(f"V51_NO_LABELED_ROWS_SHARD:{shard_index}")

    events = pd.DataFrame(rows)
    events = events.sort_values(
        ["timestamp", "symbol"]
    ).drop_duplicates(["timestamp", "symbol", "direction"])
    events.to_parquet(
        out / f"causal-short-events-shard-{shard_index}.parquet",
        index=False,
    )
    pd.DataFrame(audits).to_json(
        out / f"source-audit-shard-{shard_index}.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    ok = [x for x in audits if x.get("ok")]
    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-targetfirst-ai-v51-shard",
        "shardIndex": shard_index,
        "shardCount": shard_count,
        "topPerTimestamp": TOP_PER_TIMESTAMP,
        "candidateRows": int(len(part)),
        "symbols": int(len(by_symbol)),
        "labeledRows": int(len(events)),
        "symbolsOk": int(len(ok)),
        "symbolsFailed": int(len(audits) - len(ok)),
        "truthBoundary": {
            "candidateUniverseFromCausalV50Top50": True,
            "rerankedTop10AtSameCompletedTimestampOnly": True,
            "noDailyHindsightRanking": True,
            "featuresUseCompletedSignalBarAndPastOnly": True,
            "shortLabelUsesForwardBarsOnlyAsOutcome": True,
            "noOutcomeUsedForCandidateSelection": True,
            "noThresholdSelectionInShard": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / f"summary-shard-{shard_index}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL_SHARD": result}, ensure_ascii=False), flush=True)


def run_merge(input_root: Path, out: Path):
    files = sorted(input_root.glob("**/causal-short-events-shard-*.parquet"))
    if not files:
        raise RuntimeError("V51_NO_SHARD_FILES")

    frames = [pd.read_parquet(p) for p in files]
    data = pd.concat(frames, ignore_index=True)
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True)
    data["entryTime"] = pd.to_datetime(data["entryTime"], utc=True)
    data["exitTime"] = pd.to_datetime(data["exitTime"], utc=True)
    data = data.sort_values(
        ["timestamp", "rankAtTimestamp", "symbol"],
        ascending=[True, True, True],
    ).drop_duplicates(["timestamp", "symbol", "direction"])
    data["period"] = v43.period_for(data["timestamp"])
    data = data[data["period"] != "outside"].copy()
    data = data.replace([np.inf, -np.inf], np.nan).dropna(
        subset=v43.FEATURES + ["netReturn", "labelTargetFirst3"]
    )
    if data.empty:
        raise RuntimeError("V51_MERGED_EVENTS_EMPTY")

    counts = data["period"].value_counts().to_dict()
    for p in ("train", "calibration", "validation", "fresh_oos"):
        if int(counts.get(p, 0)) < 100:
            raise RuntimeError(f"V51_PERIOD_TOO_SMALL:{p}:{counts.get(p, 0)}")

    result_short = v43.train_direction(data, DIRECTION)
    data.to_parquet(out / "causal-short-events.parquet", index=False)

    summary = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-targetfirst-ai-v51",
        "market": MARKET,
        "direction": DIRECTION,
        "sourceCausalPrescreenRun": 37466870802,
        "sourceCapacityRun": 37467349535,
        "topPerTimestamp": TOP_PER_TIMESTAMP,
        "shardFiles": len(files),
        "rowCounts": {
            "all": int(len(data)),
            **{str(k): int(v) for k, v in counts.items()},
        },
        "modelResult": result_short,
        "promotionPass": bool(result_short["promotionPass"]),
        "truthBoundary": {
            "legacyV43DailyTop2AndDailyTop50NotUsed": True,
            "allAvailablePairsScannedByCausalV50BeforePromotion": True,
            "eventOnsetUsesCurrentAndPriorCompletedBarsOnly": True,
            "top10PromotionUsesSameCompletedTimestampOnly": True,
            "rawTakerBuyQuoteUsesBinancePublicMonthlyArchives": True,
            "signalFeaturesUseCompleted15mBarAndPastOnly": True,
            "entryUsesNext15mOpen": True,
            "sameBarTargetStopUsesStopFirst": True,
            "trainFitOnly": True,
            "thresholdSelectedFromCalibrationOnly": True,
            "validationAndFreshExcludedFromFitAndThresholdSelection": True,
            "noThresholdRetuningAfterValidation": True,
            "eventLevelEconomicsNotPortfolioPnl": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": summary}, ensure_ascii=False, default=str), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["shard", "merge"])
    ap.add_argument("--selected")
    ap.add_argument("--shard-index", type=int)
    ap.add_argument("--shard-count", type=int, default=SHARD_COUNT_DEFAULT)
    ap.add_argument("--input-root")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if args.mode == "shard":
        if args.selected is None or args.shard_index is None:
            raise RuntimeError("V51_SHARD_ARGS_MISSING")
        run_shard(
            Path(args.selected),
            int(args.shard_index),
            int(args.shard_count),
            out,
        )
    else:
        if args.input_root is None:
            raise RuntimeError("V51_MERGE_ARGS_MISSING")
        run_merge(Path(args.input_root), out)


if __name__ == "__main__":
    main()

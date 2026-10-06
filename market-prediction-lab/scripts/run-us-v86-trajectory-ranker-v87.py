#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
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


v83 = load(
    "us_v83",
    "market-prediction-lab/scripts/run-us-v82-fullstate-portfolio-v83.py",
)
v8 = load(
    "us_v8",
    "market-prediction-lab/scripts/train-us-all-session-target-first-ai-v8.py",
)
census = load(
    "census_v2",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py",
)

BATCH_ROWS = 250_000
MAX_STATE_GAP = pd.Timedelta(minutes=2)
CONFIRM_DELAY = pd.Timedelta(minutes=2)
MAX_CONFIRM_LAG = pd.Timedelta(minutes=2)
LAGS = (5, 15, 30, 60)
ENTRY_SLIPPAGE = 0.0005
TARGET = 0.03
STOP = 0.015
HOLD_MINUTES = 60
ROUND_TRIP_COST = 0.002

CURRENT_FEATURES = [f"{f}_t0" for f in v8.FEATURES]
LAG_FEATURES = [f"{f}_t{lag}" for lag in LAGS for f in v8.FEATURES]
DELTA_FEATURES = [f"{f}_d{lag}" for lag in LAGS for f in v8.FEATURES]
RANK_FEATURES = (
    CURRENT_FEATURES
    + LAG_FEATURES
    + DELTA_FEATURES
    + ["baseScore", "onsetScore", "scoreDelta"]
    + [f"lagAvailable{lag}" for lag in LAGS]
)


def score_confirmed_with_features(
    raw_path: Path,
    out_path: Path,
    model,
    threshold: float,
) -> dict:
    con = duckdb.connect()
    reader = con.execute(v83.full_state_query(raw_path)).fetch_record_batch(BATCH_ROWS)
    writer = None

    last_score = {}
    last_ts = {}
    pending = {}

    scanned = 0
    onset_count = 0
    confirmed_count = 0
    rejected_score = 0
    expired_no_state = 0

    try:
        for batch in reader:
            df = batch.to_pandas()
            if df.empty:
                continue
            scanned += len(df)
            scores = model.predict_proba(v8.clean_x(df))[:, 1]

            confirmed_rows = []
            for row, score_raw in zip(df.itertuples(index=False), scores):
                sym = str(row.symbol)
                ts = pd.Timestamp(row.timestamp)
                score = float(score_raw)

                p = pending.get(sym)
                if p is not None and ts >= p["confirmAt"]:
                    lag = ts - p["confirmAt"]
                    if lag <= MAX_CONFIRM_LAG:
                        if score >= threshold and score >= p["onsetScore"]:
                            rec = {
                                "confirmedEventId": int(confirmed_count),
                                "symbol": sym,
                                "timestamp": ts,
                                "date": row.date,
                                "sessionPart": str(row.sessionPart),
                                "entryTime": pd.Timestamp(row.entryTime),
                                "entryPrice": float(row.entryPrice),
                                "baseScore": score,
                                "onsetTime": p["onsetTime"],
                                "onsetScore": float(p["onsetScore"]),
                                "scoreDelta": score - float(p["onsetScore"]),
                                "confirmDelayMinutes": float(
                                    (ts - p["onsetTime"]).total_seconds() / 60.0
                                ),
                            }
                            for f in v8.FEATURES:
                                rec[f"{f}_t0"] = float(getattr(row, f))
                            confirmed_rows.append(rec)
                            confirmed_count += 1
                        else:
                            rejected_score += 1
                    else:
                        expired_no_state += 1
                    del pending[sym]

                prev_score = last_score.get(sym, np.nan)
                prev_ts = last_ts.get(sym, pd.NaT)
                gap = ts - pd.Timestamp(prev_ts) if pd.notna(prev_ts) else pd.NaT
                onset = (
                    score >= threshold
                    and (
                        not np.isfinite(prev_score)
                        or prev_score < threshold
                        or (pd.notna(gap) and gap > MAX_STATE_GAP)
                    )
                )
                if onset:
                    onset_count += 1
                    pending[sym] = {
                        "onsetTime": ts,
                        "onsetScore": score,
                        "confirmAt": ts + CONFIRM_DELAY,
                    }

                last_score[sym] = score
                last_ts[sym] = ts

            if confirmed_rows:
                cdf = pd.DataFrame(confirmed_rows)
                table = pa.Table.from_pandas(cdf, preserve_index=False)
                if writer is None:
                    writer = pq.ParquetWriter(
                        out_path, table.schema, compression="zstd"
                    )
                writer.write_table(table)
    finally:
        if writer is not None:
            writer.close()
        con.close()

    if confirmed_count == 0 or not out_path.exists():
        raise RuntimeError("V87_NO_CONFIRMED_EVENTS")

    return {
        "scannerStates": int(scanned),
        "eventOnsets": int(onset_count),
        "confirmedEvents": int(confirmed_count),
        "confirmationRate": float(confirmed_count / max(onset_count, 1)),
        "rejectedByScoreWeakening": int(rejected_score),
        "expiredWithoutTimelyState": int(expired_no_state),
        "pendingAtEnd": int(len(pending)),
    }


def enrich_trajectory(raw_path: Path, confirmed_path: Path, out_path: Path):
    state_sql = v83.full_state_query(raw_path)
    selects = []
    joins = []
    for lag in LAGS:
        alias = f"s{lag}"
        for f in v8.FEATURES:
            selects.append(f'{alias}."{f}" AS "{f}_t{lag}"')
        selects.append(
            f"CASE WHEN {alias}.timestamp IS NULL THEN 0 ELSE 1 END AS lagAvailable{lag}"
        )
        joins.append(
            f"""
            LEFT JOIN state {alias}
              ON {alias}.symbol=upper(e.symbol)
             AND {alias}.timestamp=e.timestamp-INTERVAL '{lag} minutes'
            """
        )

    q = f"""
    COPY (
      WITH state_raw AS (
        {state_sql}
      ),
      state AS (
        SELECT *
        FROM state_raw
        QUALIFY row_number() OVER (
          PARTITION BY symbol,timestamp
          ORDER BY entryTime,entryPrice
        )=1
      ),
      e AS (
        SELECT * FROM read_parquet('{confirmed_path.as_posix()}')
      )
      SELECT
        e.*,
        {", ".join(selects)}
      FROM e
      {" ".join(joins)}
      ORDER BY e.timestamp,e.symbol
    ) TO '{out_path.as_posix()}' (
      FORMAT PARQUET,
      COMPRESSION ZSTD
    )
    """
    con = duckdb.connect()
    con.execute(q)
    row = con.execute(
        f"""
        SELECT
          count(*) AS rows,
          count(DISTINCT confirmedEventId) AS distinctEvents,
          sum(lagAvailable5) AS a5,
          sum(lagAvailable15) AS a15,
          sum(lagAvailable30) AS a30,
          sum(lagAvailable60) AS a60
        FROM read_parquet('{out_path.as_posix()}')
        """
    ).fetchone()
    con.close()
    n = int(row[0] or 0)
    distinct_events = int(row[1] or 0)
    if n == 0:
        raise RuntimeError("V87_TRAJECTORY_EMPTY")
    if distinct_events != n:
        raise RuntimeError(f"V87_TRAJECTORY_DUPLICATED:{n}:{distinct_events}")
    return {
        "rows": n,
        "distinctConfirmedEventIds": distinct_events,
        "duplicateRows": int(n - distinct_events),
        "lagCoverage": {
            "t5": float((row[2] or 0) / n),
            "t15": float((row[3] or 0) / n),
            "t30": float((row[4] or 0) / n),
            "t60": float((row[5] or 0) / n),
        },
    }


def label_exact(
    raw_path: Path,
    trajectory_path: Path,
    out_path: Path,
    period: str,
    month: str,
) -> dict:
    con = duckdb.connect()
    q = f"""
    COPY (
      WITH e AS (
        SELECT
          confirmedEventId AS eventId,
          *,
          CAST(entryPrice AS DOUBLE)*(1.0+{ENTRY_SLIPPAGE}) AS entryPriceExec
        FROM read_parquet('{trajectory_path.as_posix()}')
      ),
      bars AS (
        SELECT
          upper(ticker) AS symbol,
          timezone('America/New_York', timestamp) AS ts,
          CAST(high AS DOUBLE) AS high,
          CAST(low AS DOUBLE) AS low,
          CAST(close AS DOUBLE) AS close
        FROM read_parquet('{raw_path.as_posix()}')
        WHERE high>0 AND low>0 AND close>0
      ),
      f AS (
        SELECT
          e.eventId,
          e.entryPriceExec,
          min(b.ts) FILTER (
            WHERE b.high>=e.entryPriceExec*(1.0+{TARGET})
          ) AS firstTargetTs,
          min(b.ts) FILTER (
            WHERE b.low<=e.entryPriceExec*(1.0-{STOP})
          ) AS firstStopTs,
          arg_max(b.close,b.ts) AS lastClose,
          max(b.ts) AS lastTs,
          max(b.high) AS futureHighExact,
          min(b.low) AS futureLowExact,
          count(b.ts) AS futureBars
        FROM e
        LEFT JOIN bars b
          ON b.symbol=upper(e.symbol)
         AND b.ts>=e.entryTime
         AND b.ts<e.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
        GROUP BY e.eventId,e.entryPriceExec
      )
      SELECT
        e.* EXCLUDE (entryPriceExec),
        '{period}' AS period,
        '{month}' AS month,
        'US_STOCK' AS market,
        'LONG' AS direction,
        CASE
          WHEN f.firstStopTs IS NOT NULL
           AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs)
          THEN f.firstStopTs
          WHEN f.firstTargetTs IS NOT NULL THEN f.firstTargetTs
          ELSE f.lastTs
        END AS exitTime,
        CASE
          WHEN f.firstStopTs IS NOT NULL
           AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs)
          THEN -{STOP}-{ROUND_TRIP_COST}
          WHEN f.firstTargetTs IS NOT NULL
          THEN {TARGET}-{ROUND_TRIP_COST}
          WHEN f.lastClose IS NOT NULL AND f.entryPriceExec>0
          THEN f.lastClose/f.entryPriceExec-1.0-{ROUND_TRIP_COST}
          ELSE NULL
        END AS netReturn,
        f.futureHighExact/f.entryPriceExec-1.0 AS MFE,
        1.0-f.futureLowExact/f.entryPriceExec AS MAE,
        CASE
          WHEN f.firstTargetTs IS NOT NULL
           AND (f.firstStopTs IS NULL OR f.firstTargetTs<f.firstStopTs)
          THEN 1 ELSE 0
        END AS targetFirst3,
        CASE
          WHEN f.firstStopTs IS NOT NULL
           AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs)
          THEN 'STOP'
          WHEN f.firstTargetTs IS NOT NULL THEN 'TARGET'
          ELSE 'TIME'
        END AS exitReason
      FROM e
      JOIN f USING (eventId)
      WHERE f.futureBars>0
        AND f.lastTs IS NOT NULL
      ORDER BY e.timestamp,e.symbol
    ) TO '{out_path.as_posix()}' (
      FORMAT PARQUET,
      COMPRESSION ZSTD
    )
    """
    con.execute(q)
    row = con.execute(
        f"""
        SELECT
          count(*) AS rows,
          count(DISTINCT symbol) AS symbols,
          sum(targetFirst3) AS targetFirst3,
          avg(netReturn) AS meanNet
        FROM read_parquet('{out_path.as_posix()}')
        """
    ).fetchone()
    con.close()
    return {
        "rows": int(row[0] or 0),
        "symbols": int(row[1] or 0),
        "targetFirst3": int(row[2] or 0),
        "targetFirstRate": float((row[2] or 0) / max(row[0] or 0, 1)),
        "meanNet": float(row[3] or 0.0),
    }


def extract_mode(args):
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    v82 = json.loads(Path(args.v82_summary).read_text(encoding="utf-8"))
    if v82.get("contract") != "us-all-session-target-first-ai-v82-recall":
        raise RuntimeError("V87_WRONG_V82_SOURCE")
    if not bool(v82.get("candidatePass")):
        raise RuntimeError("V87_V82_CANDIDATE_NOT_PASS")

    threshold = float(v82["calibrationSelection"]["winner"]["threshold"])
    model, train_rows = v83.frozen_model(Path(args.frozen_events))

    frames = []
    audits = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for month in args.month:
            raw = root / f"ohlcv_{month}.parquet"
            confirmed = root / f"confirmed_{month}.parquet"
            trajectory = root / f"trajectory_{month}.parquet"
            labeled = root / f"labeled_{month}.parquet"

            census._download_us_month(
                pd.Timestamp(month + "-01", tz="UTC"),
                raw,
            )
            ca = score_confirmed_with_features(raw, confirmed, model, threshold)
            ta = enrich_trajectory(raw, confirmed, trajectory)
            if int(ta["rows"]) != int(ca["confirmedEvents"]):
                raise RuntimeError(
                    f"V87_CONFIRMED_TRAJECTORY_COUNT_MISMATCH:{ca['confirmedEvents']}:{ta['rows']}"
                )
            la = label_exact(raw, trajectory, labeled, args.period, month)
            frames.append(pd.read_parquet(labeled))
            audits.append(
                {
                    "month": month,
                    "period": args.period,
                    "confirmation": ca,
                    "trajectory": ta,
                    "labels": la,
                }
            )
            raw.unlink(missing_ok=True)
            print(
                json.dumps({"trajectoryMonthComplete": audits[-1]}, ensure_ascii=False),
                flush=True,
            )

    data = pd.concat(frames, ignore_index=True).sort_values(
        ["timestamp", "symbol"]
    ).reset_index(drop=True)
    data.to_parquet(out / "trajectory-labeled.parquet", index=False)

    result = {
        "schemaVersion": 1,
        "contract": "us-v86-trajectory-ranker-v87-extract",
        "period": args.period,
        "months": list(args.month),
        "fixedBaseThreshold": threshold,
        "frozenBaseTrainRows": train_rows,
        "rows": int(len(data)),
        "symbols": int(data["symbol"].astype(str).nunique()),
        "targetFirst3": int(data["targetFirst3"].sum()),
        "audits": audits,
        "truthBoundary": {
            "baseV8ModelFrozen": True,
            "baseV82ThresholdFrozen": True,
            "confirmationRuleFrozenTwoMinutes": True,
            "trajectoryUsesOnlyTminus60Tminus30Tminus15Tminus5T0": True,
            "noFutureFeatureUsedForRankingInputs": True,
            "futureBarsUsedOnlyForOutcomeLabels": True,
            "preRegularPostAllEligible": True,
            "noOpeningClockRequirement": True,
            "executionAuthority": "NONE",
            "profitabilityProven": False,
        },
    }
    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL_EXTRACT": result}, ensure_ascii=False, default=str), flush=True)


def prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    x = df.copy()
    for lag in LAGS:
        for f in v8.FEATURES:
            a = pd.to_numeric(x[f"{f}_t0"], errors="coerce")
            b = pd.to_numeric(x[f"{f}_t{lag}"], errors="coerce")
            x[f"{f}_d{lag}"] = a - b
    for c in RANK_FEATURES:
        x[c] = pd.to_numeric(x[c], errors="coerce")
    return x


def rank_metrics(df: pd.DataFrame, score: np.ndarray, threshold: float) -> dict:
    if len(df) != len(score):
        raise RuntimeError("V87_SCORE_LENGTH_MISMATCH")
    pred = score >= threshold
    net = pd.to_numeric(df["netReturn"], errors="coerce").to_numpy(float)
    y = pd.to_numeric(df["targetFirst3"], errors="coerce").fillna(0).astype(int).to_numpy()
    valid = np.isfinite(net)
    pred = pred & valid

    pos = float(np.maximum(net[pred], 0.0).sum()) if pred.any() else 0.0
    neg = float(np.maximum(-net[pred], 0.0).sum()) if pred.any() else 0.0
    precision = float(y[pred].mean()) if pred.any() else 0.0
    recall = float(((pred) & (y == 1)).sum() / max((y == 1).sum(), 1))
    selected = int(pred.sum())
    symbols = int(df.loc[pred, "symbol"].astype(str).nunique()) if selected else 0

    pos_months = 0
    neg_months = 0
    if selected:
        z = pd.DataFrame(
            {
                "month": df.loc[pred, "month"].astype(str).to_numpy(),
                "net": net[pred],
            }
        )
        ms = z.groupby("month")["net"].sum()
        pos_months = int((ms > 0).sum())
        neg_months = int((ms < 0).sum())

    return {
        "threshold": float(threshold),
        "rows": int(len(df)),
        "selected": selected,
        "selectedShare": float(selected / max(len(df), 1)),
        "symbols": symbols,
        "targetFirstPrecision": precision,
        "targetFirstRecall": recall,
        "meanNet": float(net[pred].mean()) if selected else 0.0,
        "profitFactor": float(pos / neg) if neg > 0 else (float("inf") if pos > 0 else 0.0),
        "positiveMonths": pos_months,
        "negativeMonths": neg_months,
        "positiveActiveMonthRate": float(pos_months / max(pos_months + neg_months, 1)),
    }


def rank_gate(m: dict) -> dict:
    checks = {
        "selectedAtLeast100": int(m["selected"]) >= 100,
        "symbolsAtLeast50": int(m["symbols"]) >= 50,
        "positiveEV": float(m["meanNet"]) > 0,
        "profitFactorAbove1": float(m["profitFactor"]) > 1,
        "precisionAtLeast30pct": float(m["targetFirstPrecision"]) >= 0.30,
        "recallAtLeast10pct": float(m["targetFirstRecall"]) >= 0.10,
        "positiveActiveMonthRateAtLeast50pct": float(m["positiveActiveMonthRate"]) >= 0.50,
    }
    return {"pass": bool(all(checks.values())), "checks": checks}


def threshold_grid(cal: pd.DataFrame, score: np.ndarray) -> dict:
    qs = np.unique(
        np.concatenate(
            [
                np.linspace(0.50, 0.90, 17),
                np.linspace(0.91, 0.99, 17),
                np.array([0.9925, 0.995, 0.9975]),
            ]
        )
    )
    thresholds = np.unique(np.quantile(score, qs))
    rows = [rank_metrics(cal, score, float(t)) for t in thresholds]
    eligible = [r for r in rows if rank_gate(r)["pass"]]
    if eligible:
        winner = max(
            eligible,
            key=lambda r: (
                r["meanNet"],
                r["profitFactor"],
                r["targetFirstPrecision"],
                r["targetFirstRecall"],
            ),
        )
        mode = "ECONOMIC_PRECISION_GATE"
    else:
        candidates = [r for r in rows if r["selected"] >= 100] or rows
        winner = max(
            candidates,
            key=lambda r: (
                r["meanNet"],
                r["profitFactor"],
                r["targetFirstPrecision"],
                r["targetFirstRecall"],
            ),
        )
        mode = "BEST_EV_DIAGNOSTIC"
    return {"selectionMode": mode, "winner": winner, "grid": rows}


def portfolio_audit(df: pd.DataFrame, rank_score: np.ndarray, threshold: float):
    sel = df.loc[rank_score >= threshold].copy()
    if sel.empty:
        return []
    sel["score"] = rank_score[rank_score >= threshold]
    events = sel[
        [
            "market",
            "timestamp",
            "symbol",
            "direction",
            "score",
            "entryTime",
            "exitTime",
            "netReturn",
            "MFE",
            "MAE",
        ]
    ].dropna()
    rows = []
    for cap in (1, 3, 5, 10, None):
        r = v83.common.replay_always_on(
            events,
            max_positions=cap,
            opportunity_target=TARGET,
        )
        rows.append(
            {
                "maxPositions": "UNLIMITED" if cap is None else int(cap),
                "entries": int(r["positions"]["entries"]),
                "maxConcurrent": int(r["positions"]["maxConcurrent"]),
                "capacityBlocked": int(r["allMissReasons"].get("portfolio_capacity", 0)),
                "executionRecall": (
                    float(r["opportunities"]["executionRecall"])
                    if r["opportunities"]["executionRecall"] is not None
                    else None
                ),
                "bookedNetReturnSum": float(r["positions"]["bookedNetReturnSum"]),
                "positiveEntryRate": r["positions"]["positiveEntryRate"],
            }
        )
    return rows


def train_mode(args):
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = sorted(Path(args.input_root).glob("**/trajectory-labeled.parquet"))
    if not paths:
        raise RuntimeError("V87_NO_EXTRACTED_SHARDS")

    data = pd.concat([pd.read_parquet(p) for p in paths], ignore_index=True)
    data = prepare_features(data)
    data = data.dropna(subset=["period", "netReturn", "targetFirst3"]).copy()

    train = data[data["period"].astype(str) == "train"].copy()
    cal = data[data["period"].astype(str) == "calibration"].copy()
    val = data[data["period"].astype(str) == "validation"].copy()
    fresh = data[data["period"].astype(str) == "fresh_oos"].copy()
    diagnostic = data[data["period"].astype(str) == "diagnostic"].copy()
    if min(len(train), len(cal), len(val), len(fresh), len(diagnostic)) == 0:
        raise RuntimeError(
            f"V87_EMPTY_PERIOD:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}:{len(diagnostic)}"
        )

    y = pd.to_numeric(train["targetFirst3"], errors="coerce").fillna(0).astype(int)
    model = LGBMClassifier(
        objective="binary",
        n_estimators=600,
        learning_rate=0.025,
        num_leaves=31,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.80,
        reg_alpha=0.30,
        reg_lambda=2.50,
        random_state=187,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(train[RANK_FEATURES], y)

    cal_score = model.predict_proba(cal[RANK_FEATURES])[:, 1]
    selection = threshold_grid(cal, cal_score)
    threshold = float(selection["winner"]["threshold"])

    scores = {
        "train": model.predict_proba(train[RANK_FEATURES])[:, 1],
        "calibration": cal_score,
        "validation": model.predict_proba(val[RANK_FEATURES])[:, 1],
        "fresh_oos": model.predict_proba(fresh[RANK_FEATURES])[:, 1],
        "diagnostic": model.predict_proba(diagnostic[RANK_FEATURES])[:, 1],
    }
    frames = {
        "train": train,
        "calibration": cal,
        "validation": val,
        "fresh_oos": fresh,
        "diagnostic": diagnostic,
    }
    metrics = {
        k: rank_metrics(frames[k], scores[k], threshold)
        for k in frames
    }
    gates = {
        "validation": rank_gate(metrics["validation"]),
        "fresh_oos": rank_gate(metrics["fresh_oos"]),
    }

    portfolio = {
        "validation": portfolio_audit(val, scores["validation"], threshold),
        "fresh_oos": portfolio_audit(fresh, scores["fresh_oos"], threshold),
        "diagnostic": portfolio_audit(diagnostic, scores["diagnostic"], threshold),
    }

    importance = sorted(
        [
            {"feature": f, "importance": float(v)}
            for f, v in zip(RANK_FEATURES, model.feature_importances_)
        ],
        key=lambda x: x["importance"],
        reverse=True,
    )

    result = {
        "schemaVersion": 1,
        "contract": "us-v86-trajectory-ranker-v87",
        "split": {
            "train": ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09"],
            "calibration": ["2025-10", "2025-11"],
            "validation": ["2025-12", "2026-01"],
            "freshOos": ["2026-02"],
            "diagnosticAlreadyExposed": ["2026-03"],
        },
        "periodRows": {k: int(len(v)) for k, v in frames.items()},
        "rankFeatures": RANK_FEATURES,
        "calibrationSelection": selection,
        "metrics": metrics,
        "gates": gates,
        "portfolio": portfolio,
        "candidatePass": bool(gates["validation"]["pass"] and gates["fresh_oos"]["pass"]),
        "featureImportanceTop30": importance[:30],
        "truthBoundary": {
            "baseV8SignalModelAndV82ThresholdFrozen": True,
            "rankerFitUsesTrainOnly": True,
            "rankerThresholdSelectionUsesCalibrationOnly": True,
            "validationAndFreshOosUntouched": True,
            "march2026UsedAsDiagnosticOnlyAfterThresholdFreeze": True,
            "trajectoryInputsUseOnlyPastAndCurrentStates": True,
            "lagsAreExactMinuteJoinsAndMissingLagsRemainMissing": True,
            "lagStateJoinDeduplicatedBySymbolTimestamp": True,
            "confirmedEventIdPreservedOneToOne": True,
            "noOpeningClockRequirement": True,
            "preRegularPostAllEligible": True,
            "exactTargetStopPathAndCostsUsedForEconomicLabels": True,
            "sameMinuteTargetStopUsesStopFirst": True,
            "portfolioReplayAlwaysOn": True,
            "notFull35MonthPromotionAudit": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }

    pd.DataFrame(selection["grid"]).to_csv(out / "threshold-grid.csv", index=False)
    for p in ("validation", "fresh_oos", "diagnostic"):
        m = scores[p] >= threshold
        z = frames[p].loc[m].copy()
        z["rankScore"] = scores[p][m]
        z.to_parquet(out / f"{p}-selected.parquet", index=False)

    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False, default=str), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)

    ex = sub.add_parser("extract")
    ex.add_argument("--frozen-events", required=True)
    ex.add_argument("--v82-summary", required=True)
    ex.add_argument("--period", required=True)
    ex.add_argument("--month", action="append", required=True)
    ex.add_argument("--out-dir", required=True)

    tr = sub.add_parser("train")
    tr.add_argument("--input-root", required=True)
    tr.add_argument("--out-dir", required=True)

    args = ap.parse_args()
    if args.mode == "extract":
        extract_mode(args)
    else:
        train_mode(args)


if __name__ == "__main__":
    main()

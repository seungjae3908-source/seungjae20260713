#!/usr/bin/env python3
"""Compare two non-canonical recent microcap diagnostics without overstating improvement.

This guard exists because Yahoo's recent 1m range is rolling. A losing entry can disappear
from the bounded window and make EV/PF look better even when the strategy did not improve.
The output is diagnostic only and always carries zero canonical sample credit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def stable_digest(value) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def strategy_config(result: dict) -> dict:
    return {
        "source": result.get("source"),
        "symbols": result.get("symbols") or [],
        "entryModel": result.get("entryModel"),
        "exitModels": result.get("exitModels") or {},
        "timeStopsMinutes": result.get("timeStopsMinutes") or [],
        "costStressRoundTrip": result.get("costStressRoundTrip") or [],
    }


def entry_identity(row: dict) -> str:
    return "|".join(
        [
            str(row.get("symbol") or "").upper(),
            str(row.get("date") or ""),
            str(row.get("session") or ""),
        ]
    )


def best_100bps(result: dict) -> dict:
    key = result.get("bestRecentBy1PctCost")
    summary = (result.get("summaries") or {}).get(key or "") or {}
    cost = (summary.get("costStress") or {}).get("100bps") or {}
    return {
        "key": key,
        "trades": summary.get("trades"),
        "meanNetReturnPct": cost.get("meanNetReturnPct"),
        "profitFactor": cost.get("profitFactor"),
    }


def finite_num(value):
    try:
        number = float(value)
        return number if number == number and abs(number) != float("inf") else None
    except (TypeError, ValueError):
        return None


def compare(previous: dict, current: dict) -> dict:
    previous_config = strategy_config(previous)
    current_config = strategy_config(current)
    previous_digest = stable_digest(previous_config)
    current_digest = stable_digest(current_config)
    config_match = previous_digest == current_digest

    previous_ids = {entry_identity(row) for row in previous.get("entries") or []}
    current_ids = {entry_identity(row) for row in current.get("entries") or []}
    previous_ids.discard("||")
    current_ids.discard("||")
    dropped = sorted(previous_ids - current_ids)
    added = sorted(current_ids - previous_ids)
    retained = sorted(previous_ids & current_ids)

    previous_best = best_100bps(previous)
    current_best = best_100bps(current)
    prev_ev = finite_num(previous_best.get("meanNetReturnPct"))
    cur_ev = finite_num(current_best.get("meanNetReturnPct"))
    apparent_ev_delta = None if prev_ev is None or cur_ev is None else round(cur_ev - prev_ev, 6)
    apparent_improvement = apparent_ev_delta is not None and apparent_ev_delta > 0

    source_match = previous.get("source") == current.get("source")
    comparable = bool(config_match and source_match)
    attrition_risk = bool(comparable and dropped)
    if not comparable:
        interpretation = "CONFIG_OR_SOURCE_CHANGED"
    elif dropped and added:
        interpretation = "ROLLING_WINDOW_ATTRITION_AND_ADDITION"
    elif dropped:
        interpretation = "ROLLING_WINDOW_ATTRITION"
    elif added:
        interpretation = "ROLLING_WINDOW_NEW_OBSERVATIONS"
    else:
        interpretation = "SAME_ENTRY_SET"

    cross_run_improvement_claim_allowed = bool(
        comparable and not attrition_risk and apparent_improvement and not dropped
    )
    # Even an allowed *comparison* remains non-canonical research evidence.
    return {
        "schemaVersion": 1,
        "status": "ROLLING_WINDOW_COMPARISON_DIAGNOSTIC_ONLY",
        "comparable": comparable,
        "interpretation": interpretation,
        "strategyConfigDigestPrevious": previous_digest,
        "strategyConfigDigestCurrent": current_digest,
        "previousEntries": len(previous_ids),
        "currentEntries": len(current_ids),
        "retainedEntries": len(retained),
        "droppedEntryIds": dropped,
        "addedEntryIds": added,
        "previousBest100bps": previous_best,
        "currentBest100bps": current_best,
        "apparentMeanNetReturnDeltaPct": apparent_ev_delta,
        "apparentImprovement": apparent_improvement,
        "windowAttritionRisk": attrition_risk,
        "crossRunImprovementClaimAllowed": cross_run_improvement_claim_allowed,
        "canonicalEvidenceEligible": False,
        "canonicalSampleDelta": 0,
        "notes": [
            "A bounded rolling Yahoo window can improve EV/PF merely because an older loser aged out.",
            "Dropped entries block an improvement claim even when current EV/PF is numerically higher.",
            "This comparison never grants profitability, promotion, Paper, live, or order authority.",
        ],
    }


def fixture_self_test() -> None:
    config = {
        "source": "Yahoo public chart 1m range=7d includePrePost=true",
        "symbols": ["AAA", "BBB"],
        "entryModel": "same",
        "exitModels": {"TP5_ALL": "same"},
        "timeStopsMinutes": [90],
        "costStressRoundTrip": [0.01],
    }
    previous = {
        **config,
        "entries": [
            {"symbol": "AAA", "date": "2026-08-12", "session": "REG"},
            {"symbol": "BBB", "date": "2026-08-13", "session": "REG"},
        ],
        "bestRecentBy1PctCost": "TP5_ALL_90m",
        "summaries": {"TP5_ALL_90m": {"trades": 2, "costStress": {"100bps": {"meanNetReturnPct": -1.0, "profitFactor": 0.7}}}},
    }
    current = {
        **config,
        "entries": [{"symbol": "BBB", "date": "2026-08-13", "session": "REG"}],
        "bestRecentBy1PctCost": "TP5_ALL_90m",
        "summaries": {"TP5_ALL_90m": {"trades": 1, "costStress": {"100bps": {"meanNetReturnPct": 2.0, "profitFactor": 2.0}}}},
    }
    result = compare(previous, current)
    if result["interpretation"] != "ROLLING_WINDOW_ATTRITION":
        raise AssertionError("fixture must detect rolling-window attrition")
    if not result["apparentImprovement"] or not result["windowAttritionRisk"]:
        raise AssertionError("fixture must detect apparent improvement caused by attrition risk")
    if result["crossRunImprovementClaimAllowed"]:
        raise AssertionError("attrition must block cross-run improvement claim")
    if result["canonicalSampleDelta"] != 0 or result["canonicalEvidenceEligible"] is not False:
        raise AssertionError("rolling comparison must never receive canonical sample credit")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--previous-json")
    parser.add_argument("--current-json")
    parser.add_argument("--output-json", default="rolling-window-comparison-v1.json")
    parser.add_argument("--output-md", default="rolling-window-comparison-v1.md")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    fixture_self_test()
    if args.self_test:
        print("MICROCAP_ROLLING_WINDOW_COMPARISON_SELF_TEST_OK")
        return
    if not args.previous_json or not args.current_json:
        raise SystemExit("--previous-json and --current-json are required")

    previous = json.loads(Path(args.previous_json).read_text(encoding="utf-8"))
    current = json.loads(Path(args.current_json).read_text(encoding="utf-8"))
    result = compare(previous, current)

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap Rolling-Window Comparison V1",
        "",
        "**Diagnostic only — canonical sample delta is always 0.**",
        "",
        f"- Interpretation: **{result['interpretation']}**",
        f"- Comparable strategy/source: **{result['comparable']}**",
        f"- Previous/current entries: **{result['previousEntries']} / {result['currentEntries']}**",
        f"- Dropped entries: **{len(result['droppedEntryIds'])}**",
        f"- Added entries: **{len(result['addedEntryIds'])}**",
        f"- Apparent 1% cost EV delta: **{result['apparentMeanNetReturnDeltaPct']} pct-pt**",
        f"- Window attrition risk: **{result['windowAttritionRisk']}**",
        f"- Cross-run improvement claim allowed: **{result['crossRunImprovementClaimAllowed']}**",
        "",
        "## Dropped entry identities",
        "",
    ]
    lines += [f"- `{row}`" for row in result["droppedEntryIds"]] or ["- none"]
    lines += ["", "## Added entry identities", ""]
    lines += [f"- `{row}`" for row in result["addedEntryIds"]] or ["- none"]
    lines += ["", "## Notes", ""] + [f"- {note}" for note in result["notes"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

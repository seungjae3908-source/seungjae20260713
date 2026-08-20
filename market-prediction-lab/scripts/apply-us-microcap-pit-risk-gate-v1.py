#!/usr/bin/env python3
"""Apply a fail-closed point-in-time risk gate to US microcap intraday entries.

Research-only contract.

The bounded Yahoo intraday diagnostic can discover/measure entry mechanics, but it
must not treat an entry as eligible for filtered research unless the evidence that
was knowable on the entry date is supplied for:
- point-in-time public float,
- dilution / ATM / offering / warrant risk including document-level parsing,
- corporate actions (especially recent reverse splits), and
- archived same-day catalyst evidence.

This tool deliberately makes no network calls. A separate collector may supply an
evidence manifest later. Missing, future-dated, incomplete, or ambiguous evidence
fails closed as DATA_BLOCKED rather than being interpreted as safe.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_REVERSE_SPLIT_LOOKBACK_DAYS = 365


def parse_date(value) -> date:
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def load_json(path: str | None):
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def evidence_rows(manifest) -> list[dict]:
    if not isinstance(manifest, dict):
        return []
    rows = manifest.get("entries")
    return rows if isinstance(rows, list) else []


def select_point_in_time_row(rows: list[dict], symbol: str, entry_date: date) -> dict | None:
    candidates = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("symbol") or "").upper() != symbol.upper():
            continue
        try:
            as_of = parse_date(row.get("asOf"))
        except (TypeError, ValueError):
            continue
        if as_of <= entry_date:
            candidates.append((as_of, row))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[-1][1]


def checked_as_of(component: dict | None, entry_date: date, name: str, blockers: list[str]) -> date | None:
    if not isinstance(component, dict):
        blockers.append(f"{name}_EVIDENCE_MISSING")
        return None
    try:
        as_of = parse_date(component.get("asOf"))
    except (TypeError, ValueError):
        blockers.append(f"{name}_ASOF_INVALID")
        return None
    if as_of > entry_date:
        blockers.append(f"{name}_LOOKAHEAD_BLOCKED")
        return None
    return as_of


def classify_entry(entry: dict, manifest_rows: list[dict], min_float_shares: float | None, reverse_split_lookback_days: int) -> dict:
    symbol = str(entry.get("symbol") or "").upper()
    entry_date = parse_date(entry.get("date"))
    blockers: list[str] = []
    rejects: list[str] = []

    row = select_point_in_time_row(manifest_rows, symbol, entry_date)
    if row is None:
        return {
            "symbol": symbol,
            "date": entry_date.isoformat(),
            "session": entry.get("session"),
            "decision": "DATA_BLOCKED",
            "blockers": ["POINT_IN_TIME_RISK_MANIFEST_MISSING"],
            "rejectReasons": [],
        }

    float_ev = row.get("floatEvidence")
    if checked_as_of(float_ev, entry_date, "FLOAT", blockers) is not None:
        try:
            shares = float(float_ev.get("shares"))
            if not (shares > 0):
                raise ValueError
        except (TypeError, ValueError):
            blockers.append("FLOAT_SHARES_INVALID")
            shares = None
        if shares is not None and min_float_shares is not None and shares < min_float_shares:
            rejects.append("FLOAT_BELOW_RESEARCH_MINIMUM")
    else:
        shares = None

    dilution_ev = row.get("dilutionEvidence")
    if checked_as_of(dilution_ev, entry_date, "DILUTION", blockers) is not None:
        if dilution_ev.get("pointInTime") is not True:
            blockers.append("DILUTION_POINT_IN_TIME_UNPROVEN")
        status = str(dilution_ev.get("status") or "")
        if status == "FORM_LEVEL_DILUTION_RISK_PRESENT" or dilution_ev.get("dilutionRiskPresent") is True:
            rejects.append("DILUTION_OR_OFFERING_RISK_PRESENT")
        # Form metadata alone can detect risk but cannot prove safety. A clean pass
        # requires document parsing to have completed as of the entry date.
        if dilution_ev.get("documentParsingComplete") is not True:
            blockers.append("DILUTION_DOCUMENT_PARSE_INCOMPLETE")
        elif dilution_ev.get("dilutionRiskPresent") not in (True, False):
            blockers.append("DILUTION_DOCUMENT_VERDICT_MISSING")

    corp_ev = row.get("corporateActionEvidence")
    if checked_as_of(corp_ev, entry_date, "CORPORATE_ACTION", blockers) is not None:
        if corp_ev.get("coverageComplete") is not True:
            blockers.append("CORPORATE_ACTION_COVERAGE_INCOMPLETE")
        events = corp_ev.get("events")
        if not isinstance(events, list):
            blockers.append("CORPORATE_ACTION_EVENTS_INVALID")
            events = []
        cutoff = entry_date - timedelta(days=reverse_split_lookback_days)
        for event in events:
            if not isinstance(event, dict):
                continue
            if str(event.get("type") or "").upper() not in {"REVERSE_SPLIT", "SHARE_CONSOLIDATION"}:
                continue
            try:
                effective = parse_date(event.get("effectiveDate"))
            except (TypeError, ValueError):
                blockers.append("REVERSE_SPLIT_DATE_INVALID")
                continue
            if effective > entry_date:
                blockers.append("CORPORATE_ACTION_LOOKAHEAD_BLOCKED")
            elif effective >= cutoff:
                rejects.append("RECENT_REVERSE_SPLIT")

    catalyst_ev = row.get("catalystEvidence")
    if checked_as_of(catalyst_ev, entry_date, "CATALYST", blockers) is not None:
        if catalyst_ev.get("archived") is not True:
            blockers.append("CATALYST_ARCHIVE_UNPROVEN")
        if catalyst_ev.get("verified") not in (True, False):
            blockers.append("CATALYST_VERDICT_MISSING")

    blockers = sorted(set(blockers))
    rejects = sorted(set(rejects))
    if blockers:
        decision = "DATA_BLOCKED"
    elif rejects:
        decision = "REJECT_RISK"
    else:
        decision = "ELIGIBLE_FOR_FILTERED_RESEARCH"

    return {
        "symbol": symbol,
        "date": entry_date.isoformat(),
        "session": entry.get("session"),
        "decision": decision,
        "blockers": blockers,
        "rejectReasons": rejects,
        "floatShares": shares,
        "evidenceAsOf": row.get("asOf"),
    }


def build_gate(ladder: dict, manifest, min_float_shares: float | None, reverse_split_lookback_days: int) -> dict:
    entries = ladder.get("entries") if isinstance(ladder, dict) else None
    entries = entries if isinstance(entries, list) else []
    rows = evidence_rows(manifest)
    decisions = [
        classify_entry(entry, rows, min_float_shares, reverse_split_lookback_days)
        for entry in entries
        if isinstance(entry, dict) and entry.get("symbol") and entry.get("date")
    ]
    counts = {
        "eligible": sum(x["decision"] == "ELIGIBLE_FOR_FILTERED_RESEARCH" for x in decisions),
        "rejected": sum(x["decision"] == "REJECT_RISK" for x in decisions),
        "blocked": sum(x["decision"] == "DATA_BLOCKED" for x in decisions),
    }
    if not decisions:
        status = "NO_INTRADAY_ENTRIES"
    elif counts["blocked"]:
        status = "DATA_BLOCKED_PIT_RISK_EVIDENCE"
    else:
        status = "PIT_RISK_GATE_EVALUATED"

    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "entryCount": len(decisions),
        "counts": counts,
        "minFloatShares": min_float_shares,
        "reverseSplitLookbackDays": reverse_split_lookback_days,
        "decisions": decisions,
        "pointInTimeRiskGate": True,
        "canonicalEvidenceEligible": False,
        "canonicalSampleDelta": 0,
        "profitabilityPromotionAllowed": False,
        "liveTradingAllowed": False,
        "privateApiAllowed": False,
        "limitations": [
            "This gate does not fetch SEC, float, corporate-action or catalyst data itself.",
            "Missing or incomplete point-in-time evidence blocks the entry instead of implying safety.",
            "Passing this gate is only a research eligibility screen and is not profitability evidence.",
            "Historical spread/slippage and long all-session minute history remain separate requirements.",
        ],
    }


def write_outputs(result: dict, output_json: str | None, output_md: str | None) -> None:
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if output_json:
        path = Path(output_json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    if output_md:
        lines = [
            "# US Microcap Point-in-Time Risk Gate V1",
            "",
            f"**Status: {result['status']}**",
            "",
            f"- Entries: {result['entryCount']}",
            f"- Eligible: {result['counts']['eligible']}",
            f"- Rejected risk: {result['counts']['rejected']}",
            f"- Data blocked: {result['counts']['blocked']}",
            "- Canonical sample delta: **0**",
            "",
            "| Symbol | Date | Session | Decision | Blockers | Reject reasons | Float |",
            "|---|---|---|---|---|---|---:|",
        ]
        for row in result["decisions"]:
            lines.append(
                f"| {row['symbol']} | {row['date']} | {row.get('session') or ''} | {row['decision']} | "
                f"{', '.join(row['blockers']) or '-'} | {', '.join(row['rejectReasons']) or '-'} | "
                f"{row.get('floatShares') if row.get('floatShares') is not None else 'N/A'} |"
            )
        lines += ["", "## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
        path = Path(output_md)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def self_test() -> None:
    ladder = {
        "entries": [
            {"symbol": "EHGO", "date": "2026-08-20", "session": "REG"},
            {"symbol": "SAFE", "date": "2026-08-20", "session": "REG"},
        ]
    }
    manifest = {
        "entries": [
            {
                "symbol": "EHGO",
                "asOf": "2026-08-20",
                "floatEvidence": {"asOf": "2026-06-30", "shares": 2_060_000},
                "dilutionEvidence": {
                    "asOf": "2026-07-01",
                    "pointInTime": True,
                    "status": "FORM_LEVEL_DILUTION_RISK_PRESENT",
                    "documentParsingComplete": True,
                    "dilutionRiskPresent": True,
                },
                "corporateActionEvidence": {
                    "asOf": "2026-08-20",
                    "coverageComplete": True,
                    "events": [{"type": "REVERSE_SPLIT", "effectiveDate": "2026-04-20"}],
                },
                "catalystEvidence": {"asOf": "2026-08-20", "archived": True, "verified": True},
            },
            {
                "symbol": "SAFE",
                "asOf": "2026-08-20",
                "floatEvidence": {"asOf": "2026-08-19", "shares": 12_000_000},
                "dilutionEvidence": {
                    "asOf": "2026-08-19",
                    "pointInTime": True,
                    "status": "NO_FORM_LEVEL_DILUTION_SIGNAL",
                    "documentParsingComplete": True,
                    "dilutionRiskPresent": False,
                },
                "corporateActionEvidence": {"asOf": "2026-08-19", "coverageComplete": True, "events": []},
                "catalystEvidence": {"asOf": "2026-08-20", "archived": True, "verified": True},
            },
        ]
    }
    out = build_gate(ladder, manifest, 5_000_000, 365)
    assert out["status"] == "PIT_RISK_GATE_EVALUATED"
    assert out["counts"] == {"eligible": 1, "rejected": 1, "blocked": 0}
    ehgo = next(x for x in out["decisions"] if x["symbol"] == "EHGO")
    assert "DILUTION_OR_OFFERING_RISK_PRESENT" in ehgo["rejectReasons"]
    assert "RECENT_REVERSE_SPLIT" in ehgo["rejectReasons"]
    assert "FLOAT_BELOW_RESEARCH_MINIMUM" in ehgo["rejectReasons"]
    safe = next(x for x in out["decisions"] if x["symbol"] == "SAFE")
    assert safe["decision"] == "ELIGIBLE_FOR_FILTERED_RESEARCH"

    missing = build_gate(ladder, None, None, 365)
    assert missing["status"] == "DATA_BLOCKED_PIT_RISK_EVIDENCE"
    assert missing["counts"]["blocked"] == 2

    future_manifest = {
        "entries": [{
            "symbol": "SAFE",
            "asOf": "2026-08-20",
            "floatEvidence": {"asOf": "2026-08-21", "shares": 12_000_000},
            "dilutionEvidence": {"asOf": "2026-08-19", "pointInTime": True, "status": "NO_FORM_LEVEL_DILUTION_SIGNAL", "documentParsingComplete": True, "dilutionRiskPresent": False},
            "corporateActionEvidence": {"asOf": "2026-08-19", "coverageComplete": True, "events": []},
            "catalystEvidence": {"asOf": "2026-08-19", "archived": True, "verified": True},
        }]
    }
    future = build_gate({"entries": [ladder["entries"][1]]}, future_manifest, None, 365)
    assert future["status"] == "DATA_BLOCKED_PIT_RISK_EVIDENCE"
    assert "FLOAT_LOOKAHEAD_BLOCKED" in future["decisions"][0]["blockers"]
    print("PIT_RISK_GATE_SELF_TEST_OK")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ladder-json")
    ap.add_argument("--evidence-manifest-json")
    ap.add_argument("--min-float-shares", type=float)
    ap.add_argument("--reverse-split-lookback-days", type=int, default=DEFAULT_REVERSE_SPLIT_LOOKBACK_DAYS)
    ap.add_argument("--output-json")
    ap.add_argument("--output-md")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.ladder_json:
        ap.error("--ladder-json is required unless --self-test is used")
    if args.reverse_split_lookback_days <= 0:
        ap.error("--reverse-split-lookback-days must be positive")

    ladder = load_json(args.ladder_json)
    manifest = load_json(args.evidence_manifest_json)
    result = build_gate(ladder, manifest, args.min_float_shares, args.reverse_split_lookback_days)
    write_outputs(result, args.output_json, args.output_md)


if __name__ == "__main__":
    main()

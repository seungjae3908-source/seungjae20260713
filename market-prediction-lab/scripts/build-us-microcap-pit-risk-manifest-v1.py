#!/usr/bin/env python3
"""Compose a fail-closed point-in-time risk manifest for US microcap research.

This is a research-only evidence adapter. It intentionally makes no network
calls. Upstream collectors may download/cache source snapshots, but this tool
only composes evidence that was knowable on or before an explicit as-of date
into the exact manifest shape consumed by ``apply-us-microcap-pit-risk-gate-v1.py``.

The contract deliberately separates *public float shares* from SEC's
``EntityPublicFloat`` XBRL concept. SEC Public Float is expressed in USD and
must never be silently substituted for float share count. A share-count source
must explicitly declare ``measure=PUBLIC_FLOAT_SHARES`` and ``unit=shares``.

Input bundle schema (minimal):

{
  "entries": [
    {
      "symbol": "EXM",
      "asOf": "2026-08-20",
      "floatSnapshot": {
        "asOf": "2026-08-19",
        "shares": 12000000,
        "measure": "PUBLIC_FLOAT_SHARES",
        "unit": "shares",
        "source": "licensed-or-archived-source",
        "provenanceDigest": "sha256:..."
      },
      "dilutionSnapshot": { ... },
      "corporateActionSnapshot": { ... },
      "catalystSnapshot": { ... }
    }
  ]
}

The output never grants profitability/promotion/trading authority. Missing,
future-dated, ambiguous or unit-mismatched evidence remains blocked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def parse_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def stable_digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def validate_provenance(component: dict | None, name: str, blockers: list[str]) -> None:
    if not isinstance(component, dict):
        blockers.append(f"{name}_EVIDENCE_MISSING")
        return
    source = str(component.get("source") or "").strip()
    if not source:
        blockers.append(f"{name}_SOURCE_MISSING")
    digest = str(component.get("provenanceDigest") or "").lower()
    if digest and not SHA256_RE.fullmatch(digest):
        blockers.append(f"{name}_PROVENANCE_DIGEST_INVALID")


def checked_as_of(component: dict | None, entry_as_of: date, name: str, blockers: list[str]) -> date | None:
    if not isinstance(component, dict):
        blockers.append(f"{name}_EVIDENCE_MISSING")
        return None
    try:
        component_as_of = parse_date(component.get("asOf"))
    except (TypeError, ValueError):
        blockers.append(f"{name}_ASOF_INVALID")
        return None
    if component_as_of > entry_as_of:
        blockers.append(f"{name}_LOOKAHEAD_BLOCKED")
        return None
    return component_as_of


def build_float_evidence(snapshot: dict | None, entry_as_of: date, blockers: list[str]) -> dict | None:
    if checked_as_of(snapshot, entry_as_of, "FLOAT", blockers) is None:
        return None
    validate_provenance(snapshot, "FLOAT", blockers)
    measure = str(snapshot.get("measure") or "").upper()
    unit = str(snapshot.get("unit") or "").lower()
    # SEC EntityPublicFloat is a USD concept, not a count of freely tradable shares.
    if measure != "PUBLIC_FLOAT_SHARES" or unit not in {"share", "shares"}:
        blockers.append("FLOAT_MEASURE_NOT_SHARE_COUNT")
        return None
    try:
        shares = float(snapshot.get("shares"))
        if not (shares > 0):
            raise ValueError
    except (TypeError, ValueError):
        blockers.append("FLOAT_SHARES_INVALID")
        return None
    return {
        "asOf": str(snapshot.get("asOf")),
        "shares": shares,
        "measure": "PUBLIC_FLOAT_SHARES",
        "unit": "shares",
        "source": str(snapshot.get("source") or ""),
        "provenanceDigest": str(snapshot.get("provenanceDigest") or stable_digest(snapshot)),
    }


def build_dilution_evidence(snapshot: dict | None, entry_as_of: date, blockers: list[str]) -> dict | None:
    if checked_as_of(snapshot, entry_as_of, "DILUTION", blockers) is None:
        return None
    validate_provenance(snapshot, "DILUTION", blockers)
    point_in_time = snapshot.get("pointInTime") is True
    if not point_in_time:
        blockers.append("DILUTION_POINT_IN_TIME_UNPROVEN")
    status = str(snapshot.get("status") or "")
    document_complete = snapshot.get("documentParsingComplete") is True
    verdict = snapshot.get("dilutionRiskPresent")

    # Form-level registration/prospectus evidence is sufficient to assert risk
    # present, but never sufficient to assert risk absent.
    form_level_risk = status == "FORM_LEVEL_DILUTION_RISK_PRESENT"
    if form_level_risk:
        verdict = True
    elif not document_complete:
        blockers.append("DILUTION_DOCUMENT_PARSE_INCOMPLETE")
    elif verdict not in (True, False):
        blockers.append("DILUTION_DOCUMENT_VERDICT_MISSING")

    return {
        "asOf": str(snapshot.get("asOf")),
        "pointInTime": point_in_time,
        "status": status,
        "documentParsingComplete": document_complete,
        "dilutionRiskPresent": verdict if verdict in (True, False) else None,
        "source": str(snapshot.get("source") or ""),
        "provenanceDigest": str(snapshot.get("provenanceDigest") or stable_digest(snapshot)),
        "formLevelRiskCount": snapshot.get("formLevelRiskCount"),
        "documentParseRequiredCount": snapshot.get("documentParseRequiredCount"),
    }


def build_corporate_action_evidence(snapshot: dict | None, entry_as_of: date, blockers: list[str]) -> dict | None:
    if checked_as_of(snapshot, entry_as_of, "CORPORATE_ACTION", blockers) is None:
        return None
    validate_provenance(snapshot, "CORPORATE_ACTION", blockers)
    coverage_complete = snapshot.get("coverageComplete") is True
    if not coverage_complete:
        blockers.append("CORPORATE_ACTION_COVERAGE_INCOMPLETE")
    events = snapshot.get("events")
    if not isinstance(events, list):
        blockers.append("CORPORATE_ACTION_EVENTS_INVALID")
        events = []
    clean_events = []
    for event in events:
        if not isinstance(event, dict):
            blockers.append("CORPORATE_ACTION_EVENT_INVALID")
            continue
        try:
            effective = parse_date(event.get("effectiveDate"))
        except (TypeError, ValueError):
            blockers.append("CORPORATE_ACTION_EVENT_DATE_INVALID")
            continue
        if effective > entry_as_of:
            blockers.append("CORPORATE_ACTION_LOOKAHEAD_BLOCKED")
            continue
        clean_events.append({
            "type": str(event.get("type") or "").upper(),
            "effectiveDate": effective.isoformat(),
            "source": str(event.get("source") or snapshot.get("source") or ""),
        })
    return {
        "asOf": str(snapshot.get("asOf")),
        "coverageComplete": coverage_complete,
        "events": clean_events,
        "source": str(snapshot.get("source") or ""),
        "provenanceDigest": str(snapshot.get("provenanceDigest") or stable_digest(snapshot)),
    }


def build_catalyst_evidence(snapshot: dict | None, entry_as_of: date, blockers: list[str]) -> dict | None:
    if checked_as_of(snapshot, entry_as_of, "CATALYST", blockers) is None:
        return None
    validate_provenance(snapshot, "CATALYST", blockers)
    archived = snapshot.get("archived") is True
    if not archived:
        blockers.append("CATALYST_ARCHIVE_UNPROVEN")
    verified = snapshot.get("verified")
    if verified not in (True, False):
        blockers.append("CATALYST_VERDICT_MISSING")
    return {
        "asOf": str(snapshot.get("asOf")),
        "archived": archived,
        "verified": verified if verified in (True, False) else None,
        "type": str(snapshot.get("type") or ""),
        "source": str(snapshot.get("source") or ""),
        "provenanceDigest": str(snapshot.get("provenanceDigest") or stable_digest(snapshot)),
    }


def build_row(raw: dict) -> dict:
    symbol = str(raw.get("symbol") or "").upper().strip()
    blockers: list[str] = []
    if not symbol:
        blockers.append("SYMBOL_MISSING")
    try:
        entry_as_of = parse_date(raw.get("asOf"))
    except (TypeError, ValueError):
        entry_as_of = None
        blockers.append("ENTRY_ASOF_INVALID")

    if entry_as_of is None:
        return {
            "symbol": symbol,
            "asOf": raw.get("asOf"),
            "status": "DATA_BLOCKED",
            "blockers": sorted(set(blockers)),
        }

    float_ev = build_float_evidence(raw.get("floatSnapshot"), entry_as_of, blockers)
    dilution_ev = build_dilution_evidence(raw.get("dilutionSnapshot"), entry_as_of, blockers)
    corp_ev = build_corporate_action_evidence(raw.get("corporateActionSnapshot"), entry_as_of, blockers)
    catalyst_ev = build_catalyst_evidence(raw.get("catalystSnapshot"), entry_as_of, blockers)

    blockers = sorted(set(blockers))
    row = {
        "symbol": symbol,
        "asOf": entry_as_of.isoformat(),
        "status": "MANIFEST_READY" if not blockers else "DATA_BLOCKED",
        "blockers": blockers,
        "floatEvidence": float_ev,
        "dilutionEvidence": dilution_ev,
        "corporateActionEvidence": corp_ev,
        "catalystEvidence": catalyst_ev,
    }
    row["rowDigest"] = stable_digest({k: v for k, v in row.items() if k != "rowDigest"})
    return row


def build_manifest(bundle: dict) -> dict:
    rows = bundle.get("entries") if isinstance(bundle, dict) else None
    rows = rows if isinstance(rows, list) else []
    built = [build_row(row) for row in rows if isinstance(row, dict)]
    ready = sum(row.get("status") == "MANIFEST_READY" for row in built)
    blocked = len(built) - ready
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "PIT_MANIFEST_READY" if built and blocked == 0 else "DATA_BLOCKED_PIT_MANIFEST",
        "counts": {"rows": len(built), "ready": ready, "blocked": blocked},
        "entries": built,
        "pointInTime": True,
        "canonicalEvidenceEligible": False,
        "canonicalSampleDelta": 0,
        "profitabilityPromotionAllowed": False,
        "liveTradingAllowed": False,
        "privateApiAllowed": False,
        "sourceContract": (
            "Offline composer only. Public-float share count must come from an explicit archived share-count source; "
            "SEC EntityPublicFloat USD is forbidden as a substitute."
        ),
        "limitations": [
            "This builder does not download SEC filings, float history, corporate actions or archived news.",
            "Form-level SEC evidence can prove dilution risk present but cannot prove risk absent without document parsing.",
            "Passing manifest construction and the downstream PIT gate is research eligibility only, not profitability evidence.",
            "Historical spread/slippage and long all-session minute history remain separate requirements.",
        ],
    }
    result["manifestDigest"] = stable_digest({k: v for k, v in result.items() if k != "manifestDigest"})
    return result


def self_test() -> None:
    def digest(seed: str) -> str:
        return "sha256:" + hashlib.sha256(seed.encode()).hexdigest()

    safe = {
        "symbol": "SAFE",
        "asOf": "2026-08-20",
        "floatSnapshot": {
            "asOf": "2026-08-19", "shares": 12_000_000, "measure": "PUBLIC_FLOAT_SHARES", "unit": "shares",
            "source": "archived-float-provider", "provenanceDigest": digest("float"),
        },
        "dilutionSnapshot": {
            "asOf": "2026-08-19", "pointInTime": True, "status": "NO_FORM_LEVEL_DILUTION_SIGNAL",
            "documentParsingComplete": True, "dilutionRiskPresent": False,
            "source": "SEC submissions + parsed primary documents", "provenanceDigest": digest("dilution"),
        },
        "corporateActionSnapshot": {
            "asOf": "2026-08-19", "coverageComplete": True, "events": [],
            "source": "archived corporate-action feed", "provenanceDigest": digest("corp"),
        },
        "catalystSnapshot": {
            "asOf": "2026-08-20", "archived": True, "verified": True, "type": "EARNINGS",
            "source": "archived news", "provenanceDigest": digest("news"),
        },
    }
    out = build_manifest({"entries": [safe]})
    assert out["status"] == "PIT_MANIFEST_READY"
    assert out["counts"] == {"rows": 1, "ready": 1, "blocked": 0}
    assert out["entries"][0]["floatEvidence"]["shares"] == 12_000_000
    assert out["canonicalSampleDelta"] == 0

    # SEC EntityPublicFloat is USD and must not be mistaken for float shares.
    bad_float = json.loads(json.dumps(safe))
    bad_float["symbol"] = "USD_FLOAT"
    bad_float["floatSnapshot"].update({"measure": "ENTITY_PUBLIC_FLOAT", "unit": "USD", "shares": 50_000_000})
    bad = build_manifest({"entries": [bad_float]})
    assert bad["status"] == "DATA_BLOCKED_PIT_MANIFEST"
    assert "FLOAT_MEASURE_NOT_SHARE_COUNT" in bad["entries"][0]["blockers"]

    future = json.loads(json.dumps(safe))
    future["symbol"] = "LOOKAHEAD"
    future["catalystSnapshot"]["asOf"] = "2026-08-21"
    future_out = build_manifest({"entries": [future]})
    assert "CATALYST_LOOKAHEAD_BLOCKED" in future_out["entries"][0]["blockers"]

    incomplete = json.loads(json.dumps(safe))
    incomplete["symbol"] = "UNPARSED"
    incomplete["dilutionSnapshot"]["documentParsingComplete"] = False
    incomplete["dilutionSnapshot"]["dilutionRiskPresent"] = None
    incomplete_out = build_manifest({"entries": [incomplete]})
    assert "DILUTION_DOCUMENT_PARSE_INCOMPLETE" in incomplete_out["entries"][0]["blockers"]

    risk = json.loads(json.dumps(safe))
    risk["symbol"] = "OFFERING"
    risk["dilutionSnapshot"].update({
        "status": "FORM_LEVEL_DILUTION_RISK_PRESENT",
        "documentParsingComplete": False,
        "dilutionRiskPresent": None,
    })
    risk_out = build_manifest({"entries": [risk]})
    assert risk_out["entries"][0]["dilutionEvidence"]["dilutionRiskPresent"] is True
    print("PIT_RISK_MANIFEST_SELF_TEST_OK")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-bundle-json")
    ap.add_argument("--output-json")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.source_bundle_json:
        ap.error("--source-bundle-json is required unless --self-test is used")
    bundle = json.loads(Path(args.source_bundle_json).read_text(encoding="utf-8"))
    result = build_manifest(bundle)
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output_json:
        path = Path(args.output_json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()

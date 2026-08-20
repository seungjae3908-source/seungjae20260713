#!/usr/bin/env python3
"""Build point-in-time SEC form-level dilution evidence for US microcap research.

This tool is research-only. It consumes a previously downloaded SEC
``data.sec.gov/submissions/CIK##########.json`` snapshot and emits evidence that
was knowable at or before an explicit ``--as-of`` date. It does not make
network calls and it never treats absence of a form-level signal as proof that
an issuer is dilution-safe: ATM/warrant terms may require document-level
parsing of 8-K/10-Q/10-K/prospectus content.
"""

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path

SCHEMA_VERSION = 1

REGISTRATION_FORMS = {
    "S-1", "S-1/A", "S-3", "S-3/A", "F-1", "F-1/A", "F-3", "F-3/A",
    "POS AM", "POSASR", "1-A", "1-A/A",
}
EFFECT_FORMS = {"EFFECT"}
WITHDRAWAL_FORMS = {"RW", "AW"}
CONTEXT_FORMS = {"8-K", "8-K/A", "6-K", "10-Q", "10-Q/A", "10-K", "10-K/A"}


def parse_date(value):
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def classify_form(form):
    form = str(form or "").strip().upper()
    if form.startswith("424B"):
        return "PROSPECTUS"
    if form in REGISTRATION_FORMS:
        return "REGISTRATION"
    if form in EFFECT_FORMS:
        return "EFFECTIVENESS"
    if form in WITHDRAWAL_FORMS:
        return "WITHDRAWAL"
    if form in CONTEXT_FORMS:
        return "DOCUMENT_PARSE_REQUIRED"
    return "OTHER"


def iter_recent_filings(snapshot):
    recent = (((snapshot or {}).get("filings") or {}).get("recent") or {})
    forms = recent.get("form") or []
    filing_dates = recent.get("filingDate") or []
    accessions = recent.get("accessionNumber") or []
    primary_docs = recent.get("primaryDocument") or []
    report_dates = recent.get("reportDate") or []
    n = max(len(forms), len(filing_dates), len(accessions), len(primary_docs), len(report_dates), 0)
    for i in range(n):
        def at(xs, default=""):
            return xs[i] if i < len(xs) else default
        filing_date = at(filing_dates)
        if not filing_date:
            continue
        try:
            parsed = parse_date(filing_date)
        except (TypeError, ValueError):
            continue
        form = str(at(forms)).strip().upper()
        yield {
            "filingDate": parsed,
            "form": form,
            "category": classify_form(form),
            "accessionNumber": str(at(accessions)),
            "primaryDocument": str(at(primary_docs)),
            "reportDate": str(at(report_dates)),
        }


def build_evidence(snapshot, as_of, lookback_days):
    as_of = parse_date(as_of)
    lookback_days = int(lookback_days)
    if lookback_days <= 0:
        raise ValueError("lookback_days must be positive")
    start = as_of - timedelta(days=lookback_days)

    eligible = []
    excluded_future = 0
    excluded_old = 0
    for filing in iter_recent_filings(snapshot):
        if filing["filingDate"] > as_of:
            excluded_future += 1
            continue
        if filing["filingDate"] < start:
            excluded_old += 1
            continue
        eligible.append(filing)

    eligible.sort(key=lambda x: (x["filingDate"], x["accessionNumber"], x["form"]))
    form_level = [
        row for row in eligible
        if row["category"] in {"REGISTRATION", "PROSPECTUS", "EFFECTIVENESS"}
    ]
    withdrawals = [row for row in eligible if row["category"] == "WITHDRAWAL"]
    context = [row for row in eligible if row["category"] == "DOCUMENT_PARSE_REQUIRED"]

    if form_level:
        status = "FORM_LEVEL_DILUTION_RISK_PRESENT"
    else:
        status = "NO_FORM_LEVEL_DILUTION_SIGNAL"

    def serialise(row):
        out = dict(row)
        out["filingDate"] = out["filingDate"].isoformat()
        return out

    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "asOf": as_of.isoformat(),
        "lookbackDays": lookback_days,
        "cik": str((snapshot or {}).get("cik") or ""),
        "name": str((snapshot or {}).get("name") or ""),
        "tickers": list((snapshot or {}).get("tickers") or []),
        "exchanges": list((snapshot or {}).get("exchanges") or []),
        "pointInTime": True,
        "futureFilingsExcluded": excluded_future,
        "oldFilingsExcluded": excluded_old,
        "formLevelRiskCount": len(form_level),
        "withdrawalCount": len(withdrawals),
        "documentParseRequiredCount": len(context),
        "documentParseRequired": True,
        "eligibleForProfitabilityPromotion": False,
        "safeToTradeClaim": False,
        "reason": (
            "FORM_LEVEL_DILUTION_RISK_PRESENT"
            if form_level
            else "FORM_METADATA_ALONE_CANNOT_PROVE_DILUTION_SAFETY"
        ),
        "formLevelRiskEvidence": [serialise(x) for x in form_level],
        "withdrawalEvidence": [serialise(x) for x in withdrawals],
        "contextFilings": [serialise(x) for x in context],
        "sourceContract": "SEC data.sec.gov submissions JSON snapshot; no network call",
        "limitations": [
            "Form metadata is a coarse fail-closed screen, not a complete dilution model.",
            "ATM, warrant, convertible and financing terms can require primary-document parsing.",
            "Absence of a registration/prospectus form must never be interpreted as dilution-safe.",
            "This evidence does not provide point-in-time public float or historical bid-ask spread.",
        ],
    }


def self_test():
    fixture = {
        "cik": "1234567890",
        "name": "Example Corp",
        "tickers": ["EXM"],
        "exchanges": ["Nasdaq"],
        "filings": {
            "recent": {
                "form": ["S-3", "424B5", "8-K", "424B5", "RW"],
                "filingDate": ["2026-01-05", "2026-02-10", "2026-03-01", "2026-04-01", "2026-03-05"],
                "accessionNumber": ["a", "b", "c", "future", "d"],
                "primaryDocument": ["s3.htm", "424b5.htm", "8k.htm", "future.htm", "rw.htm"],
                "reportDate": ["", "", "2026-03-01", "", ""],
            }
        },
    }
    out = build_evidence(fixture, "2026-03-15", 365)
    assert out["status"] == "FORM_LEVEL_DILUTION_RISK_PRESENT"
    assert out["futureFilingsExcluded"] == 1
    assert out["formLevelRiskCount"] == 2
    assert out["withdrawalCount"] == 1
    assert out["documentParseRequiredCount"] == 1
    assert [x["accessionNumber"] for x in out["formLevelRiskEvidence"]] == ["a", "b"]
    assert out["eligibleForProfitabilityPromotion"] is False
    assert out["safeToTradeClaim"] is False

    recent_only = build_evidence(fixture, "2026-03-15", 30)
    assert recent_only["status"] == "NO_FORM_LEVEL_DILUTION_SIGNAL"
    assert recent_only["documentParseRequired"] is True
    assert recent_only["documentParseRequiredCount"] == 1
    assert recent_only["withdrawalCount"] == 1
    assert recent_only["safeToTradeClaim"] is False
    print("self-test: PASS")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--submissions-json")
    p.add_argument("--as-of")
    p.add_argument("--lookback-days", type=int, default=365)
    p.add_argument("--output-json")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.submissions_json or not args.as_of:
        p.error("--submissions-json and --as-of are required unless --self-test is used")

    snapshot = json.loads(Path(args.submissions_json).read_text(encoding="utf-8"))
    result = build_evidence(snapshot, args.as_of, args.lookback_days)
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output_json:
        Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output_json).write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()

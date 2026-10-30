"""백테스트 결과 묶음(summary.json)을 운영 앱 헤지 어댑터 성과 게이트 입력(PerformanceEvidence) 형식으로 내보낸다.

출력 형식은 api-server/src/services/stat-arb-hedge/stat-arb-hedge.types.ts 의 PerformanceEvidence 와 같다:
{researchCodeSha, generatedAtMs, rows: [{window, strategy, cost_profile, leverage, status, data_verdict,
 window_start, window_end_exclusive, net_return, trades, liquidations, pf_net, mdd}]}
게이트 판정(어댑터와 같은 기준)도 함께 기록하지만, 실주문 권한은 이 파일이 아니라 운영 앱 게이트가 정한다.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from csa_lab.storage import atomic_write_json, read_json  # noqa: E402

FIELDS = ("window", "strategy", "cost_profile", "leverage", "status", "data_verdict", "window_start",
          "window_end_exclusive", "net_return", "trades", "liquidations", "pf_net", "mdd")
# 어댑터 DEFAULT_PERFORMANCE_THRESHOLDS 와 같은 값
THRESHOLDS = {"cost_profile": "current_public_assumed", "min_window_days": 180, "min_trades": 30,
              "min_net_return": 0.0, "min_profit_factor": 1.0, "max_liquidations": 0}
EXECUTABLE_STRATEGIES = ("carry_upbit_bitget",)
LIVE_LEVERAGES = range(2, 8)


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _days(r):
    import pandas as pd
    try:
        return (pd.Timestamp(r["window_end_exclusive"]) - pd.Timestamp(r["window_start"])).days
    except Exception:
        return None


def judge(rows: list) -> list:
    out = []
    for lev in LIVE_LEVERAGES:
        for s in EXECUTABLE_STRATEGIES:
            matched = [r for r in rows if r["strategy"] == s and int(r["leverage"]) == lev
                       and r["cost_profile"] == THRESHOLDS["cost_profile"]]
            reasons = []
            if not matched:
                reasons.append("NO_MATCHING_ROW")
            for r in matched:
                tag = r["window"]
                if r.get("status") != "OK":
                    reasons.append(f"STATUS:{tag}:{r.get('status')}")
                if r.get("data_verdict") != "OK":
                    reasons.append(f"DATA_VERDICT:{tag}:{r.get('data_verdict')}")
                d = _days(r)
                if d is None or d < THRESHOLDS["min_window_days"]:
                    reasons.append(f"WINDOW_TOO_SHORT:{tag}:{d}")
                if not ((_num(r.get("trades")) or 0) >= THRESHOLDS["min_trades"]):
                    reasons.append(f"TRADES_TOO_FEW:{tag}:{r.get('trades')}")
                nr = _num(r.get("net_return"))
                if nr is None or not nr > THRESHOLDS["min_net_return"]:
                    reasons.append(f"NET_RETURN_NOT_POSITIVE:{tag}:{nr}")
                pf = _num(r.get("pf_net"))
                if pf is None or not pf > THRESHOLDS["min_profit_factor"]:
                    reasons.append(f"PROFIT_FACTOR_LOW:{tag}:{pf}")
                if (_num(r.get("liquidations")) or 0) > THRESHOLDS["max_liquidations"]:
                    reasons.append(f"LIQUIDATIONS:{tag}:{r.get('liquidations')}")
            out.append({"strategy": s, "leverage": lev, "authority": "NONE" if reasons else "LIVE_ELIGIBLE",
                        "reasons": reasons, "windows": [r["window"] for r in matched]})
    return out


def main(result_dir: str, out_file: str) -> int:
    d = Path(result_dir)
    meta = read_json(d / "meta.json")
    rows = read_json(d / "summary.json")
    sha = meta.get("git_sha") or ""
    ev_rows = []
    for r in rows:
        row = {k: r.get(k) for k in FIELDS}
        for k in ("net_return", "pf_net", "mdd"):
            row[k] = _num(row[k])
        for k in ("trades", "liquidations"):
            row[k] = int(_num(row[k]) or 0)
        ev_rows.append(row)
    evidence = {"researchCodeSha": sha, "generatedAtMs": int(time.time() * 1000), "sourceRunId": meta.get("run_id"),
                "rows": ev_rows, "gate_preview": judge(rows), "thresholds": THRESHOLDS,
                "note": "실주문 권한은 운영 앱 게이트(LIVE_AUTHORITY_RELEASED 등)가 정한다. 이 파일은 근거일 뿐이다.",
                "live_orders": 0}
    atomic_write_json(Path(out_file), evidence)
    for g in evidence["gate_preview"]:
        print(f"GATE {g['strategy']} lev{g['leverage']} {g['authority']} {'; '.join(g['reasons'][:6])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))

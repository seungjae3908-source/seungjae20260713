"""CLI: python -m csa_lab <명령>

  collect   공개 데이터 수집(조회 전용)
  backtest  레버리지 1~10배 백테스트(PAPER, 주문 없음)
  original  원본 저장소 코드를 수정 없이 실행
  soak      장시간 무주문 운영 실행
  soak-summary / verify  결과 요약·무결성 확인
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .leverage import ALLOWED_LEVERAGES, LeverageError, parse_leverage
from .fund import DEFAULT_INITIAL_KRW, DEFAULT_MAX_ENTRY_MARGIN_KRW
from .money import DEFAULT_STRATEGY_CAPITAL_KRW


def _levs(text: str) -> list:
    if text == "all":
        return list(ALLOWED_LEVERAGES)
    out = []
    for part in text.split(","):
        out.append(parse_leverage(part))  # 서버/CLI 측 검증: 1~10 정수만
    return out


def _capital(text: str) -> float:
    if not text.isdigit() or int(text) <= 0:
        raise argparse.ArgumentTypeError("원화 자금은 양의 정수여야 합니다")
    return float(int(text))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="csa_lab")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--data-dir", required=True)
    c.add_argument("--start", required=True, help="YYYY-MM")
    c.add_argument("--end", required=True, help="YYYY-MM")
    c.add_argument("--no-hyperliquid", action="store_true")
    c.add_argument("--no-fx", action="store_true")
    c.add_argument("--no-upbit-bitget", action="store_true", help="업비트 현물·비트겟 선물 공개 데이터 수집 생략")
    b = sub.add_parser("backtest")
    b.add_argument("--data-dir", required=True)
    b.add_argument("--results-dir", required=True)
    b.add_argument("--leverage", default="1", help="1~10 정수, 쉼표 목록, 또는 all (기본 1)")
    b.add_argument("--capital-krw", type=_capital, default=float(DEFAULT_STRATEGY_CAPITAL_KRW))
    b.add_argument("--window", action="append", default=None,
                   help="이름=YYYY-MM-DD:YYYY-MM-DD (끝 미포함). 기본: README 학습·테스트 구간")
    b.add_argument("--strategy", default="carry_binance,xvenue_funding,carry_upbit_bitget")
    b.add_argument("--profile", default="original,current_public_assumed")
    b.add_argument("--label", default="run")
    b.add_argument("--accept-quality-issues", action="store_true")
    b.add_argument("--min-segment-days", type=int, default=30,
                   help="INCOMPLETE 창 안에서 따로 평가할 완전 구간의 최소 길이(일). 더 짧은 완전 구간은 평가하지 않음")
    b.add_argument("--no-fund", action="store_true", help="자동매매 자금 원장 없이 전략별 계획 자금을 그대로 복리 운용")
    b.add_argument("--fund-initial-krw", type=_capital, default=float(DEFAULT_INITIAL_KRW),
                   help="자동매매 초기 기본 자금(참고 기준, 기본 1,000,000)")
    b.add_argument("--max-entry-krw", type=_capital, default=float(DEFAULT_MAX_ENTRY_MARGIN_KRW),
                   help="최대 진입 증거금 한도(레버리지 적용 전, 기본 1,000,000)")
    o = sub.add_parser("original")
    o.add_argument("--original-repo", required=True)
    o.add_argument("--data-dir", required=True)
    o.add_argument("--out", required=True)
    o.add_argument("--mode", default="full_backtest", choices=["full_backtest", "full", "walk_forward"])
    o.add_argument("--start-date", required=True)
    o.add_argument("--end-date", required=True)
    o.add_argument("--timeout", type=int, default=3600)
    s = sub.add_parser("soak")
    s.add_argument("--root", required=True)
    s.add_argument("--hours", type=float, required=True)
    s.add_argument("--interval-s", type=float, default=300)
    s.add_argument("--max-consecutive-failures", type=int, default=6)
    ss = sub.add_parser("soak-summary")
    ss.add_argument("--root", required=True)
    v = sub.add_parser("verify")
    v.add_argument("dir")
    a = ap.parse_args(argv)

    if a.cmd == "collect":
        from .pipeline import collect
        y1, m1 = map(int, a.start.split("-"))
        y2, m2 = map(int, a.end.split("-"))
        rep = collect(Path(a.data_dir), date(y1, m1, 1), date(y2, m2, 1),
                      with_hyperliquid=not a.no_hyperliquid, with_fx=not a.no_fx,
                      with_upbit_bitget=not a.no_upbit_bitget)
        print(json.dumps({k: rep[k] for k in rep if k not in ("klines", "markPriceKlines", "fundingRate", "spotKlines")}
                         | {k: {"ok": len(rep[k]["months_ok"]), "missing": rep[k]["months_missing"]}
                            for k in ("klines", "markPriceKlines", "fundingRate", "spotKlines")},
                         ensure_ascii=False, indent=1, default=str))
        return 0
    if a.cmd == "backtest":
        from .pipeline import WINDOWS, run_suite
        try:
            levs = _levs(a.leverage)
        except LeverageError as e:
            print(f"레버리지 입력 거부: {e}", file=sys.stderr)
            return 2
        windows = dict(WINDOWS)
        if a.window:
            windows = {}
            for w in a.window:
                name, rng = w.split("=", 1)
                ws, we = rng.split(":")
                windows[name] = (ws, we)
        out = run_suite(Path(a.data_dir), Path(a.results_dir), leverages=levs, capital_krw=a.capital_krw,
                        windows=windows, strategies=a.strategy.split(","), profiles=a.profile.split(","),
                        label=a.label, accept_quality_issues=a.accept_quality_issues, fund_mode=not a.no_fund,
                        fund_initial_krw=a.fund_initial_krw, fund_max_entry_krw=a.max_entry_krw,
                        min_segment_days=a.min_segment_days)
        print(out)
        return 0
    if a.cmd == "original":
        from .original_runner import run_original
        from .pipeline import build_market
        market, _ = build_market(Path(a.data_dir))
        rep = run_original(Path(a.original_repo), market.bars, market.funding, Path(a.out), mode=a.mode,
                           start_date=a.start_date, end_date=a.end_date, timeout_s=a.timeout)
        print(json.dumps(rep, ensure_ascii=False, indent=1, default=str))
        return 0 if rep["exit_code"] == 0 else 1
    if a.cmd == "soak":
        from .soak import run_soak
        st = run_soak(Path(a.root), duration_s=a.hours * 3600, interval_s=a.interval_s,
                      max_consecutive_failures=a.max_consecutive_failures)
        print(json.dumps({k: st[k] for k in ("status", "starts", "cycles_done")}, ensure_ascii=False))
        return 0 if st["status"] in ("COMPLETED_DURATION", "STOPPED_SIGTERM") else 1
    if a.cmd == "soak-summary":
        from .soak import summarize
        print(json.dumps(summarize(Path(a.root)), ensure_ascii=False, indent=1, default=str))
        return 0
    if a.cmd == "verify":
        from .storage import verify_manifest
        print(json.dumps(verify_manifest(Path(a.dir))))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Stage five: long-only breakout pullback/retest on a separate older window.

Public Bitget data only. No account, API key or order endpoint. Historical OI and
long/short ratios are deliberately not fabricated; the runtime collector stores
those fields for future forward validation.
"""
from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pandas as pd
import requests

STAGE4_URL = (
    "https://raw.githubusercontent.com/seungjae3908-source/seungjae20260713/"
    "38b24eaf80ddee6488212bad70e33a5a977d5b19/"
    "tools/backtest/funding_veto_long_short_backtest.py"
)
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT")
DAYS = 89
END_OFFSET_DAYS = 178
BAR_MS = 15 * 60 * 1000
MAX_TRADES_PER_RUN = 12
OUT = Path("docs/backtests")
STEM = "BITGET_5SYMBOL_OLDER89D_LONG_PULLBACK_RETEST_STAGE5"
STRATEGIES = {
    "HARD_VETO_LONG_REFERENCE": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=24,
    ),
    "PULLBACK_RETEST_40_30_30": dict(
        kind="improved", threshold=80, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=32,
    ),
    "PULLBACK_RETEST_30_30_40": dict(
        kind="improved", threshold=80, gap=20, entry=(.3, .3, .4),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=32,
    ),
}


def load_stage4() -> ModuleType:
    response = requests.get(STAGE4_URL, timeout=30)
    response.raise_for_status()
    path = Path("/tmp/funding_veto_long_short_backtest.py")
    path.write_text(response.text, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("stage4", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load pinned stage-four helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def window_bounds() -> tuple[int, int]:
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    current_open = now // BAR_MS * BAR_MS
    end = current_open - END_OFFSET_DAYS * 86_400_000
    return end - DAYS * 86_400_000, end


def add_pullback_features(frame: pd.DataFrame) -> pd.DataFrame:
    x = frame.copy()
    breakout = (x.close > x.hi20) & (x.close > x.open)
    x["recent_breakout"] = breakout.shift(1).rolling(16, min_periods=1).max().fillna(0)
    x["retest_level"] = x.hi20.where(breakout).shift(1).ffill(limit=16)
    for name in ("close", "low", "e20", "e50", "hist", "rsi"):
        x[f"prev_{name}"] = x[name].shift(1)
    return x


def context_safe(row: pd.Series) -> bool:
    needed = (
        "mark_close", "index_close", "funding_rate", "market_mark_gap",
        "mark_index_premium", "premium_med", "premium_mad",
    )
    if any(pd.isna(row.get(name)) for name in needed):
        return False
    median = float(row.premium_med)
    mad = float(row.premium_mad)
    premium_limit = max(.0010, median + 3 * mad)
    return (
        abs(float(row.market_mark_gap)) <= .0012
        and abs(float(row.mark_index_premium)) <= premium_limit
        and float(row.funding_rate) <= .00050
        and abs(float(row.funding_rate)) <= .0015
    )


def pullback_score(base: ModuleType, row: pd.Series) -> tuple[int, int, str]:
    lo, sh, regime = base.improved_score(row)
    needed = (
        "atr", "adx", "h1_adx", "h1_slope", "h4_slope", "rsi", "hist",
        "vr", "e20", "e50", "range_atr", "recent_breakout", "retest_level",
        "prev_close", "prev_low", "prev_e20", "prev_e50", "prev_hist",
    )
    if any(pd.isna(row.get(name)) for name in needed) or not context_safe(row):
        return 0, 0, "DATA_OR_CONTEXT_BLOCKED"
    atr = float(row.atr)
    if atr <= 0:
        return 0, 0, "INVALID_ATR"
    retest_level = float(row.retest_level)
    support = max(float(row.e20), retest_level)
    previous_touched = (
        float(row.prev_low) <= max(float(row.prev_e20), retest_level) + .20 * atr
        and float(row.prev_close) >= float(row.prev_e50) - .25 * atr
    )
    reclaimed = (
        float(row.close) > support
        and float(row.close) > float(row.open)
        and float(row.close) > float(row.prev_close)
        and float(row.low) >= float(row.e50) - .20 * atr
    )
    distance_atr = (float(row.close) - support) / atr
    momentum_recovery = (
        float(row["hist"]) > 0
        and float(row["hist"]) >= float(row.prev_hist)
        and 50 <= float(row.rsi) <= 64
        and float(row.rsi) >= float(row.prev_rsi)
    )
    trend = (
        regime == "BULL"
        and lo >= 80 and sh <= 50
        and float(row.h1_slope) > 0 and float(row.h4_slope) > 0
        and float(row.adx) >= 20 and float(row.h1_adx) >= 18
        and float(row.e20) > float(row.e50)
    )
    quality = (
        bool(row.recent_breakout)
        and previous_touched
        and reclaimed
        and momentum_recovery
        and .05 <= distance_atr <= .75
        and .75 <= float(row.vr) <= 1.70
        and float(row.range_atr) <= 1.60
    )
    return (lo if trend and quality else 0), 0, regime


def run_fold(
    stage4: ModuleType,
    stage3: ModuleType,
    base: ModuleType,
    symbol: str,
    frame: pd.DataFrame,
    funding: pd.DataFrame,
    mark: pd.DataFrame,
    strategy: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sliced = frame.loc[(frame.index >= start) & (frame.index < end)].copy()
    original_features, original_score = base.features, base.score
    try:
        base.features = lambda data: data
        if strategy == "HARD_VETO_LONG_REFERENCE":
            base.score = lambda cfg, row: stage4.hard_veto_score(base, row, "LONG_ONLY")
        else:
            base.score = lambda cfg, row: pullback_score(base, row)
        result, generated = base.simulate(symbol, sliced, strategy, STRATEGIES[strategy])
    finally:
        base.features, base.score = original_features, original_score
    generated = sorted(generated, key=lambda trade: trade["closed_at"])[:MAX_TRADES_PER_RUN]
    for trade in generated:
        stage3.add_funding(trade, funding, mark)
    return stage3.recalc(result, generated), generated


def aggregate(runs: list[dict[str, Any]], trades: list[dict[str, Any]], strategy: str) -> dict[str, Any]:
    rr = [run for run in runs if run["strategy"] == strategy]
    tt = [trade for trade in trades if trade["strategy"] == strategy]
    wins = [trade for trade in tt if trade["net_pnl_krw"] > 0]
    losses = [trade for trade in tt if trade["net_pnl_krw"] < 0]
    gp = sum(trade["net_pnl_krw"] for trade in wins)
    gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
    return dict(
        strategy=strategy,
        profitable_symbols=sum(
            sum(run["net_pnl_krw"] for run in rr if run["symbol"] == symbol) > 0
            for symbol in SYMBOLS
        ),
        average_return_pct=np.mean([run["return_pct"] for run in rr]),
        pooled_net_pnl_krw=sum(run["net_pnl_krw"] for run in rr),
        trades=len(tt),
        win_rate_pct=len(wins) / len(tt) * 100 if tt else 0,
        profit_factor=gp / gl if gl else None,
        worst_maximum_drawdown_pct=min(run["maximum_drawdown_pct"] for run in rr),
        total_fees_krw=sum(run["total_fees_krw"] for run in rr),
        total_funding_pnl_krw=sum(run["total_funding_pnl_krw"] for run in rr),
    )


def save(source: dict[str, Any], window_start: pd.Timestamp, window_end: pd.Timestamp,
         folds: list[tuple[str, pd.Timestamp, pd.Timestamp]], runs: list[dict[str, Any]],
         trades: list[dict[str, Any]]) -> None:
    aggregates = [aggregate(runs, trades, name) for name in STRATEGIES]
    primary = next(item for item in aggregates if item["strategy"] == "PULLBACK_RETEST_30_30_40")
    oldest = sum(
        run["net_pnl_krw"] for run in runs
        if run["strategy"] == primary["strategy"] and run["fold"] == "FOLD_A_OLDEST"
    )
    conditions = dict(
        combined_net_positive=primary["pooled_net_pnl_krw"] > 0,
        profit_factor_at_least_1_20=(primary["profit_factor"] or 0) >= 1.20,
        at_least_3_profitable_symbols=primary["profitable_symbols"] >= 3,
        at_least_30_trades=primary["trades"] >= 30,
        worst_mdd_not_below_minus_5=primary["worst_maximum_drawdown_pct"] >= -5,
        oldest_fold_positive=oldest > 0,
    )
    now = datetime.now(timezone.utc).isoformat()
    summary = dict(
        status="FIFTH_STAGE_LONG_PULLBACK_NOT_LIVE_READY",
        generated_at=now,
        source=dict(exchange="Bitget", timeframe="15m", symbols=source,
                    validation_window=dict(start=window_start.isoformat(), end=window_end.isoformat()),
                    endpoints=["history-candles", "history-mark-candles", "history-index-candles", "history-fund-rate"]),
        policy=dict(starting_capital_krw_per_run=300_000, max_planned_capital_krw=30_000,
                    leverage=5, primary_entry_splits=[.3, .3, .4], exit_splits=[.3, .3, .4],
                    fee_bps_per_fill=12, slippage_bps_per_fill=15,
                    max_trades_per_run=MAX_TRADES_PER_RUN,
                    context_is_hard_veto_only=True, short_entries_enabled=False),
        folds=[dict(name=name, start=start.isoformat(), end=end.isoformat()) for name, start, end in folds],
        aggregate=aggregates, runs=runs, pass_conditions=conditions, passed=all(conditions.values()),
        limitations=[
            "Historical OI and long/short ratios are not fabricated; the runtime collector must build forward history.",
            "The fifth-stage historical test uses price, volume, mark/index and funding only.",
            "All results are simulated and cannot justify live orders without forward shadow validation.",
        ],
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{STEM}.json").write_text(json.dumps({"summary": summary, "trades": trades}, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    pd.DataFrame(runs).to_csv(OUT / f"{STEM}_RUNS.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame([{key: value for key, value in trade.items() if key not in ("entry_events", "exit_events")} for trade in trades]).to_csv(OUT / f"{STEM}_TRADES.csv", index=False, encoding="utf-8-sig")

    def pf(value: float | None) -> str:
        return "-" if value is None else f"{value:.3f}"

    aggregate_rows = "\n".join(
        f"| {item['strategy']} | {item['profitable_symbols']}/5 | {item['average_return_pct']:+.2f}% | "
        f"{item['pooled_net_pnl_krw']:+,.0f}원 | {item['trades']} | {item['win_rate_pct']:.2f}% | "
        f"{pf(item['profit_factor'])} | {item['worst_maximum_drawdown_pct']:.2f}% |"
        for item in aggregates
    )
    fold_rows = []
    for fold_name, _, _ in folds:
        for strategy in STRATEGIES:
            ft = [trade for trade in trades if trade["fold"] == fold_name and trade["strategy"] == strategy]
            wins = [trade for trade in ft if trade["net_pnl_krw"] > 0]
            losses = [trade for trade in ft if trade["net_pnl_krw"] < 0]
            gp = sum(trade["net_pnl_krw"] for trade in wins)
            gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
            fold_rows.append(
                f"| {fold_name} | {strategy} | {sum(trade['net_pnl_krw'] for trade in ft):+,.0f}원 | "
                f"{len(ft)} | {(len(wins)/len(ft)*100 if ft else 0):.2f}% | {pf(gp/gl if gl else None)} |"
            )
    checks = "\n".join(f"- {'통과' if ok else '실패'}: {name}" for name, ok in conditions.items())
    md = f"""# Bitget 롱 눌림·재지지 5차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용했습니다.

- 생성: {now}
- 검증기간: {window_start.isoformat()} ~ {window_end.isoformat()}
- 종목: {', '.join(SYMBOLS)}
- 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 기본 분할청산 30·30·40
- 주 전략 분할진입 30·30·40, 비교안 40·30·30
- 펀딩·마크·지수는 점수 가산 없이 차단에만 사용
- 숏 신규진입 금지

## 전체 비교
| 전략 | 수익 종목 | 평균 수익률 | 15개 실행 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---:|---:|---:|---:|---:|---:|---:|
{aggregate_rows}

## 구간별 비교
| 구간 | 전략 | 5종목 합산손익 | 거래 | 승률 | PF |
|---|---|---:|---:|---:|---:|
{chr(10).join(fold_rows)}

## 주 전략 통과조건
{checks}

- 오래된 구간 주 전략 합산손익: {oldest:+,.0f}원
- 최종 판정: {'예비 통과지만 미래 섀도 검증 전 실거래 금지' if all(conditions.values()) else '탈락 또는 추가 데이터 필요'}

## 제한
- 과거 OI·롱숏비율은 만들어내지 않았습니다.
- 새 수집기가 축적한 미래 데이터로 별도 검증해야 합니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.
"""
    (OUT / f"{STEM}.md").write_text(md, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


def main() -> None:
    stage4 = load_stage4()
    stage3 = stage4.load_stage3()
    base = stage3.load_base()
    session = requests.Session()
    session.headers["User-Agent"] = "seungjae-long-pullback-stage5/1.0"
    start_ms, end_ms = window_bounds()
    frames, marks, fundings, source = {}, {}, {}, {}
    for symbol in SYMBOLS:
        market = stage4.fetch_candles(session, symbol, "/api/v2/mix/market/history-candles", start_ms, end_ms)
        mark = stage4.fetch_candles(session, symbol, "/api/v2/mix/market/history-mark-candles", start_ms, end_ms)
        index = stage4.fetch_candles(session, symbol, "/api/v2/mix/market/history-index-candles", start_ms, end_ms)
        funding = stage4.fetch_funding(session, symbol, start_ms, end_ms)
        frame = add_pullback_features(stage3.enrich(base, market, mark, index, funding))
        frames[symbol], marks[symbol], fundings[symbol] = frame, mark, funding
        source[symbol] = dict(candles=len(frame), period_start=frame.index[0].isoformat(),
                              period_end=(frame.index[-1] + pd.Timedelta(minutes=15)).isoformat(),
                              funding_records=len(funding))
    common_start = max(frame.index[0] for frame in frames.values())
    common_end = min(frame.index[-1] for frame in frames.values()) + pd.Timedelta(minutes=15)
    span = (common_end - common_start) / 3
    folds = [
        ("FOLD_A_OLDEST", common_start, common_start + span),
        ("FOLD_B_MIDDLE", common_start + span, common_start + 2 * span),
        ("FOLD_C_LATEST_IN_WINDOW", common_start + 2 * span, common_end),
    ]
    runs, trades = [], []
    for symbol, frame in frames.items():
        for fold_name, fold_start, fold_end in folds:
            for strategy in STRATEGIES:
                result, generated = run_fold(stage4, stage3, base, symbol, frame, fundings[symbol], marks[symbol], strategy, fold_start, fold_end)
                result.update(symbol=symbol, strategy=strategy, fold=fold_name,
                              fold_start=fold_start.isoformat(), fold_end=fold_end.isoformat())
                runs.append(result)
                for trade in generated:
                    trade.update(symbol=symbol, strategy=strategy, fold=fold_name)
                    trades.append(trade)
    save(source, pd.Timestamp(start_ms, unit="ms", tz="UTC"), pd.Timestamp(end_ms, unit="ms", tz="UTC"), folds, runs, trades)


if __name__ == "__main__":
    main()

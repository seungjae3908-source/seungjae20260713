#!/usr/bin/env python3
"""Fourth-stage Bitget backtest: hard vetoes, asymmetric long/short rules, unseen older window.

Public market data only. No API key, account, balance or order endpoint.
The stage-three data/PnL helpers are pinned by commit so this stage changes
entry permission and validation period, not fill accounting.
"""
from __future__ import annotations

import importlib.util
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pandas as pd
import requests

STAGE3_URL = (
    "https://raw.githubusercontent.com/seungjae3908-source/seungjae20260713/"
    "de5478c6236e44b44439e1436c221b92691c9ce0/"
    "tools/backtest/funding_mark_walkforward_backtest.py"
)
API = "https://api.bitget.com"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT")
DAYS = 89
END_OFFSET_DAYS = 89
BAR_MS = 15 * 60 * 1000
MAX_TRADES_PER_RUN = 8
OUT = Path("docs/backtests")
STEM = "BITGET_5SYMBOL_OLDER89D_HARD_VETO_LONG_SHORT"
STRATEGIES = {
    "PRICE_ONLY_REFERENCE": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=288, cooldown=8,
    ),
    "HARD_VETO_SPLIT": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=24,
    ),
    "HARD_VETO_LONG_ONLY": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=24,
    ),
    "HARD_VETO_SHORT_ONLY": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=192, cooldown=24,
    ),
}


def load_stage3() -> ModuleType:
    response = requests.get(STAGE3_URL, timeout=30)
    response.raise_for_status()
    path = Path("/tmp/funding_mark_walkforward_backtest.py")
    path.write_text(response.text, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("stage3", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load pinned stage-three helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request_json(session: requests.Session, path: str, params: dict[str, Any]) -> Any:
    last_error: Exception | None = None
    for attempt in range(6):
        try:
            response = session.get(API + path, params=params, timeout=30)
            response.raise_for_status()
            payload = response.json()
            if payload.get("code") != "00000":
                raise RuntimeError(str(payload))
            return payload.get("data")
        except Exception as exc:
            last_error = exc
            time.sleep(min(10, .8 * 2**attempt))
    raise RuntimeError(f"{path} failed: {last_error}")


def window_bounds() -> tuple[int, int]:
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    current_open = now // BAR_MS * BAR_MS
    end = current_open - END_OFFSET_DAYS * 86_400_000
    start = end - DAYS * 86_400_000
    return start, end


def fetch_candles(
    session: requests.Session, symbol: str, path: str, start: int, end: int
) -> pd.DataFrame:
    cursor, rows = end - 1, {}
    while cursor >= start:
        batch = request_json(
            session, path,
            dict(
                symbol=symbol,
                productType="usdt-futures",
                granularity="15m",
                endTime=str(cursor),
                limit="200",
            ),
        ) or []
        if not batch:
            break
        oldest = cursor
        for raw in batch:
            ts = int(raw[0])
            oldest = min(oldest, ts)
            if start <= ts < end:
                rows[ts] = [float(value) for value in raw[1:7]]
        if oldest >= cursor:
            break
        cursor = oldest - 1
        time.sleep(.055)
    frame = pd.DataFrame.from_dict(
        rows,
        orient="index",
        columns=["open", "high", "low", "close", "volume", "quote_volume"],
    ).sort_index()
    frame.index = pd.to_datetime(frame.index, unit="ms", utc=True)
    frame = frame[~frame.index.duplicated(keep="last")]
    if len(frame) < 5_000:
        raise RuntimeError(f"{symbol} {path}: insufficient candles {len(frame)}")
    return frame


def fetch_funding(
    session: requests.Session, symbol: str, start: int, end: int
) -> pd.DataFrame:
    rows: dict[int, float] = {}
    for page in range(1, 16):
        batch = request_json(
            session,
            "/api/v2/mix/market/history-fund-rate",
            dict(
                symbol=symbol,
                productType="usdt-futures",
                pageSize="100",
                pageNo=str(page),
            ),
        ) or []
        if not batch:
            break
        for item in batch:
            ts = int(item["fundingTime"])
            if start - 2 * 86_400_000 <= ts < end + 86_400_000:
                rows[ts] = float(item["fundingRate"])
        oldest = min(int(item["fundingTime"]) for item in batch)
        if oldest < start - 2 * 86_400_000 or len(batch) < 100:
            break
        time.sleep(.055)
    frame = pd.DataFrame(
        {"funding_rate": list(rows.values())},
        index=pd.to_datetime(list(rows.keys()), unit="ms", utc=True),
    ).sort_index()
    if frame.empty:
        raise RuntimeError(f"{symbol}: no funding history in requested window")
    return frame[~frame.index.duplicated(keep="last")]


def hard_veto_score(
    base: ModuleType, row: pd.Series, mode: str
) -> tuple[int, int, str]:
    """Return unchanged technical scores only when hard safety and side rules pass."""
    lo, sh, regime = base.improved_score(row)
    needed = (
        "mark_close", "index_close", "funding_rate", "market_mark_gap",
        "mark_index_premium", "premium_med", "premium_mad",
        "atr", "adx", "h1_adx", "h1_slope", "h4_slope",
        "rsi", "hist", "vr", "e20", "range_atr",
    )
    if any(pd.isna(row.get(name)) for name in needed):
        return 0, 0, "DATA_STALE"

    gap = abs(float(row.market_mark_gap))
    premium = float(row.mark_index_premium)
    funding = float(row.funding_rate)
    median = float(row.premium_med)
    mad = float(row.premium_mad)
    premium_shock = max(.0010, median + 3 * mad)

    if gap > .0015 or abs(premium) > premium_shock:
        return 0, 0, "SHOCK"

    long_allowed = (
        regime == "BULL"
        and lo >= 90 and sh <= 45
        and float(row.h1_slope) > 0 and float(row.h4_slope) > 0
        and float(row.adx) >= 22 and float(row.h1_adx) >= 20
        and 54 <= float(row.rsi) <= 66
        and float(row["hist"]) > 0
        and float(row.vr) >= 1.05
        and float(row.range_atr) <= 1.8
        and float(row.close) <= float(row.e20) + 1.3 * float(row.atr)
        and funding <= .00050
        and premium <= .00080
        and float(row.market_mark_gap) <= .0010
    )
    short_allowed = (
        regime == "BEAR"
        and sh >= 92 and lo <= 40
        and float(row.h1_slope) < 0 and float(row.h4_slope) < 0
        and float(row.adx) >= 24 and float(row.h1_adx) >= 20
        and 34 <= float(row.rsi) <= 46
        and float(row["hist"]) < 0
        and float(row.vr) >= 1.10
        and float(row.range_atr) <= 1.8
        and float(row.close) >= float(row.e20) - 1.2 * float(row.atr)
        and funding >= -.00050
        and premium >= -.00080
        and float(row.market_mark_gap) >= -.0010
    )

    if mode == "LONG_ONLY":
        short_allowed = False
    elif mode == "SHORT_ONLY":
        long_allowed = False

    return (lo if long_allowed else 0), (sh if short_allowed else 0), regime


def recalc_from_trades(stage3: ModuleType, base_result: dict[str, Any],
                       trades: list[dict[str, Any]]) -> dict[str, Any]:
    return stage3.recalc(base_result, trades)


def run_fold(
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
        if strategy == "PRICE_ONLY_REFERENCE":
            base.score = lambda cfg, row: base.improved_score(row)
        else:
            mode = (
                "LONG_ONLY" if strategy.endswith("LONG_ONLY")
                else "SHORT_ONLY" if strategy.endswith("SHORT_ONLY")
                else "BOTH"
            )
            base.score = lambda cfg, row: hard_veto_score(base, row, mode)
        result, generated = base.simulate(
            symbol, sliced, strategy, STRATEGIES[strategy]
        )
    finally:
        base.features, base.score = original_features, original_score

    generated = sorted(generated, key=lambda trade: trade["closed_at"])
    if strategy != "PRICE_ONLY_REFERENCE":
        generated = generated[:MAX_TRADES_PER_RUN]

    for trade in generated:
        stage3.add_funding(trade, funding, mark)
    return recalc_from_trades(stage3, result, generated), generated


def aggregate(
    runs: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    strategy: str,
) -> dict[str, Any]:
    rr = [run for run in runs if run["strategy"] == strategy]
    tt = [trade for trade in trades if trade["strategy"] == strategy]
    wins = [trade for trade in tt if trade["net_pnl_krw"] > 0]
    losses = [trade for trade in tt if trade["net_pnl_krw"] < 0]
    gp = sum(trade["net_pnl_krw"] for trade in wins)
    gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
    profitable_symbols = sum(
        sum(run["net_pnl_krw"] for run in rr if run["symbol"] == symbol) > 0
        for symbol in SYMBOLS
    )
    return dict(
        strategy=strategy,
        profitable_symbols=profitable_symbols,
        profitable_runs=sum(run["net_pnl_krw"] > 0 for run in rr),
        total_runs=len(rr),
        average_return_pct=np.mean([run["return_pct"] for run in rr]),
        pooled_net_pnl_krw=sum(run["net_pnl_krw"] for run in rr),
        trades=len(tt),
        win_rate_pct=len(wins) / len(tt) * 100 if tt else 0,
        profit_factor=gp / gl if gl else None,
        worst_maximum_drawdown_pct=min(run["maximum_drawdown_pct"] for run in rr),
        total_fees_krw=sum(run["total_fees_krw"] for run in rr),
        total_funding_pnl_krw=sum(run["total_funding_pnl_krw"] for run in rr),
    )


def save(
    source: dict[str, Any],
    window_start: pd.Timestamp,
    window_end: pd.Timestamp,
    folds: list[tuple[str, pd.Timestamp, pd.Timestamp]],
    runs: list[dict[str, Any]],
    trades: list[dict[str, Any]],
) -> None:
    aggregates = [aggregate(runs, trades, name) for name in STRATEGIES]
    reference = next(item for item in aggregates if item["strategy"] == "PRICE_ONLY_REFERENCE")
    candidate = next(item for item in aggregates if item["strategy"] == "HARD_VETO_SPLIT")
    oldest = sum(
        run["net_pnl_krw"] for run in runs
        if run["strategy"] == "HARD_VETO_SPLIT"
        and run["fold"] == "FOLD_A_OLDEST"
    )
    conditions = dict(
        combined_net_positive=candidate["pooled_net_pnl_krw"] > 0,
        profit_factor_at_least_1_20=(candidate["profit_factor"] or 0) >= 1.20,
        at_least_3_profitable_symbols=candidate["profitable_symbols"] >= 3,
        at_least_30_trades=candidate["trades"] >= 30,
        trade_count_not_above_reference=candidate["trades"] <= reference["trades"],
        worst_mdd_not_below_minus_5=candidate["worst_maximum_drawdown_pct"] >= -5,
        oldest_fold_positive=oldest > 0,
    )
    passed = all(conditions.values())
    now = datetime.now(timezone.utc).isoformat()
    summary = dict(
        status="FOURTH_STAGE_HARD_VETO_NOT_LIVE_READY",
        generated_at=now,
        source=dict(
            exchange="Bitget",
            timeframe="15m",
            symbols=source,
            validation_window=dict(
                start=window_start.isoformat(),
                end=window_end.isoformat(),
                note="Older window ending before the prior 89-day stage-three window",
            ),
            endpoints=[
                "/api/v2/mix/market/history-candles",
                "/api/v2/mix/market/history-mark-candles",
                "/api/v2/mix/market/history-index-candles",
                "/api/v2/mix/market/history-fund-rate",
            ],
        ),
        policy=dict(
            starting_capital_krw_per_run=300_000,
            max_planned_capital_krw=30_000,
            leverage=5,
            entry_splits=[.4, .3, .3],
            exit_splits=[.3, .3, .4],
            fee_bps_per_fill=12,
            slippage_bps_per_fill=15,
            max_trades_per_candidate_run=MAX_TRADES_PER_RUN,
            context_is_hard_veto_only=True,
            long_short_rules_are_separate=True,
        ),
        folds=[
            dict(name=name, start=start.isoformat(), end=end.isoformat())
            for name, start, end in folds
        ],
        aggregate=aggregates,
        runs=runs,
        pass_conditions=conditions,
        passed=passed,
        limitations=[
            "This fourth stage uses an older window not used by the prior 89-day stage-three report, but all results remain simulated.",
            "Funding and mark/index context only blocks entries; it never increases a signal score.",
            "Candidate runs stop accepting results after the first eight completed trades, a predeclared turnover cap.",
            "Historical OI is not available from the public current-OI endpoint; long-short API retention is not treated as guaranteed history.",
            "Order-book depth, liquidation stream, rejected orders and real fill failures are not modeled.",
            "Historical performance never guarantees future profitability.",
        ],
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{STEM}.json").write_text(
        json.dumps({"summary": summary, "trades": trades},
                   ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    pd.DataFrame(runs).to_csv(
        OUT / f"{STEM}_RUNS.csv", index=False, encoding="utf-8-sig"
    )
    pd.DataFrame([
        {key: value for key, value in trade.items()
         if key not in ("entry_events", "exit_events")}
        for trade in trades
    ]).to_csv(
        OUT / f"{STEM}_TRADES.csv", index=False, encoding="utf-8-sig"
    )

    def pf(value: float | None) -> str:
        return "-" if value is None else f"{value:.3f}"

    aggregate_rows = "\n".join(
        f"| {item['strategy']} | {item['profitable_symbols']}/5 | "
        f"{item['average_return_pct']:+.2f}% | {item['pooled_net_pnl_krw']:+,.0f}원 | "
        f"{item['trades']} | {item['win_rate_pct']:.2f}% | "
        f"{pf(item['profit_factor'])} | {item['worst_maximum_drawdown_pct']:.2f}% | "
        f"{item['total_funding_pnl_krw']:+,.0f}원 |"
        for item in aggregates
    )
    fold_rows = []
    for fold_name, _, _ in folds:
        for strategy in STRATEGIES:
            subset = [
                run for run in runs
                if run["fold"] == fold_name and run["strategy"] == strategy
            ]
            ft = [
                trade for trade in trades
                if trade["fold"] == fold_name and trade["strategy"] == strategy
            ]
            wins = [trade for trade in ft if trade["net_pnl_krw"] > 0]
            losses = [trade for trade in ft if trade["net_pnl_krw"] < 0]
            gp = sum(trade["net_pnl_krw"] for trade in wins)
            gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
            fold_rows.append(
                f"| {fold_name} | {strategy} | "
                f"{sum(run['net_pnl_krw'] for run in subset):+,.0f}원 | "
                f"{len(ft)} | "
                f"{(len(wins) / len(ft) * 100 if ft else 0):.2f}% | "
                f"{pf(gp / gl if gl else None)} |"
            )
    check_rows = "\n".join(
        f"- {'통과' if ok else '실패'}: {name}"
        for name, ok in conditions.items()
    )
    md = f"""# Bitget 5종목 과거 89일 하드차단·롱숏분리 4차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용한 예비 검증입니다.

- 생성: {now}
- 검증기간: {window_start.isoformat()} ~ {window_end.isoformat()}
- 종목: {", ".join(SYMBOLS)}
- 각 실행 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 분할진입 40·30·30 / 분할청산 30·30·40
- 매 체결 수수료 12bp + 슬리피지 15bp
- 펀딩·마크·지수 조건은 점수 가산 없이 차단에만 사용
- 롱·숏 허용 조건 분리 / 후보 실행당 최대 8거래

## 전체 비교

| 전략 | 수익 종목 | 평균 수익률 | 15개 실행 합산손익 | 거래 | 승률 | PF | 최악 MDD | 펀딩손익 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
{aggregate_rows}

## 구간별 비교

| 구간 | 전략 | 5종목 합산손익 | 거래 | 승률 | PF |
|---|---|---:|---:|---:|---:|
{chr(10).join(fold_rows)}

## 통과조건

{check_rows}

- 가장 오래된 구간 후보전략 합산손익: {oldest:+,.0f}원
- 최종 판정: {"예비 통과지만 섀도 검증 전 실거래 금지" if passed else "탈락 또는 추가 개선 필요"}

## 제한

- 공개 과거 OI를 제공하는 장기 시계열은 사용하지 못했습니다.
- 롱숏비율 API의 장기 보존 범위를 과거 전체 데이터라고 가정하지 않았습니다.
- 호가 깊이·청산 스트림·실제 주문실패는 포함되지 않았습니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.
"""
    (OUT / f"{STEM}.md").write_text(md, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


def main() -> None:
    stage3 = load_stage3()
    base = stage3.load_base()
    session = requests.Session()
    session.headers["User-Agent"] = "seungjae-hard-veto-long-short/4.0"
    start_ms, end_ms = window_bounds()
    frames, marks, fundings, source = {}, {}, {}, {}
    for symbol in SYMBOLS:
        market = fetch_candles(
            session, symbol, "/api/v2/mix/market/history-candles",
            start_ms, end_ms,
        )
        mark = fetch_candles(
            session, symbol, "/api/v2/mix/market/history-mark-candles",
            start_ms, end_ms,
        )
        index = fetch_candles(
            session, symbol, "/api/v2/mix/market/history-index-candles",
            start_ms, end_ms,
        )
        funding = fetch_funding(session, symbol, start_ms, end_ms)
        frame = stage3.enrich(base, market, mark, index, funding)
        frames[symbol], marks[symbol], fundings[symbol] = frame, mark, funding
        source[symbol] = dict(
            candles=len(frame),
            period_start=frame.index[0].isoformat(),
            period_end=(frame.index[-1] + pd.Timedelta(minutes=15)).isoformat(),
            funding_records=len(funding),
        )

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
                result, generated = run_fold(
                    stage3, base, symbol, frame, fundings[symbol], marks[symbol],
                    strategy, fold_start, fold_end,
                )
                result.update(
                    symbol=symbol,
                    strategy=strategy,
                    fold=fold_name,
                    fold_start=fold_start.isoformat(),
                    fold_end=fold_end.isoformat(),
                )
                runs.append(result)
                for trade in generated:
                    trade.update(symbol=symbol, strategy=strategy, fold=fold_name)
                    trades.append(trade)
    save(
        source,
        pd.Timestamp(start_ms, unit="ms", tz="UTC"),
        pd.Timestamp(end_ms, unit="ms", tz="UTC"),
        folds,
        runs,
        trades,
    )


if __name__ == "__main__":
    main()

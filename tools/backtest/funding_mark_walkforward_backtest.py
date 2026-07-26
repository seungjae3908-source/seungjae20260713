#!/usr/bin/env python3
"""Third-stage Bitget backtest: funding + mark/index filters across 3 fixed folds.

Uses only public endpoints. No API key, account, balance, or order endpoint.
The price-only simulator is pinned to the prior second-stage commit so the
comparison changes market context, not the fill/PnL engine.
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

BASE_SIMULATOR_URL = (
    "https://raw.githubusercontent.com/seungjae3908-source/seungjae20260713/"
    "5e10f55cb139ddb2e777ff4ba8cfe40a639afc29/"
    "tools/backtest/improved_multisymbol_split_backtest.py"
)
API = "https://api.bitget.com"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT")
DAYS = 89
BAR_MS = 15 * 60 * 1000
OUT = Path("docs/backtests")
STEM = "BITGET_5SYMBOL_89D_FUNDING_MARK_WALKFORWARD"
STRATEGIES = {
    "PRICE_ONLY_REFERENCE": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=288, cooldown=8,
    ),
    "FUNDING_MARK_FILTER": dict(
        kind="improved", threshold=85, gap=20, entry=(.4, .3, .3),
        exit=(.3, .3, .4), targets=(1.5, 2.5, 4.0), stop="structure",
        add=True, hold=288, cooldown=8,
    ),
}


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


def load_base() -> ModuleType:
    source = requests.get(BASE_SIMULATOR_URL, timeout=30)
    source.raise_for_status()
    path = Path("/tmp/improved_multisymbol_split_backtest.py")
    path.write_text(source.text, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("stage2_base", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load pinned stage-two simulator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fetch_candles(session: requests.Session, symbol: str, path: str) -> pd.DataFrame:
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    current = now // BAR_MS * BAR_MS
    start, end, rows = current - DAYS * 86_400_000, current - 1, {}
    while end >= start:
        batch = request_json(
            session, path,
            dict(symbol=symbol, productType="usdt-futures", granularity="15m",
                 endTime=str(end), limit="200"),
        ) or []
        if not batch:
            break
        oldest = end
        for raw in batch:
            ts = int(raw[0])
            oldest = min(oldest, ts)
            if start <= ts < current:
                rows[ts] = [float(value) for value in raw[1:7]]
        if oldest >= end:
            break
        end = oldest - 1
        time.sleep(.055)
    frame = pd.DataFrame.from_dict(
        rows, orient="index",
        columns=["open", "high", "low", "close", "volume", "quote_volume"],
    ).sort_index()
    frame.index = pd.to_datetime(frame.index, unit="ms", utc=True)
    frame = frame[~frame.index.duplicated(keep="last")]
    if len(frame) < 5_000:
        raise RuntimeError(f"{symbol} {path}: insufficient candles {len(frame)}")
    return frame


def fetch_funding(session: requests.Session, symbol: str) -> pd.DataFrame:
    rows: dict[int, float] = {}
    for page in range(1, 8):
        batch = request_json(
            session, "/api/v2/mix/market/history-fund-rate",
            dict(symbol=symbol, productType="usdt-futures",
                 pageSize="100", pageNo=str(page)),
        ) or []
        if not batch:
            break
        for item in batch:
            rows[int(item["fundingTime"])] = float(item["fundingRate"])
        if len(batch) < 100:
            break
        time.sleep(.055)
    frame = pd.DataFrame(
        {"funding_rate": list(rows.values())},
        index=pd.to_datetime(list(rows.keys()), unit="ms", utc=True),
    ).sort_index()
    if frame.empty:
        raise RuntimeError(f"{symbol}: no funding history")
    return frame[~frame.index.duplicated(keep="last")]


def enrich(base: ModuleType, market: pd.DataFrame, mark: pd.DataFrame,
           index: pd.DataFrame, funding: pd.DataFrame) -> pd.DataFrame:
    x = base.features(market)
    x = x.join(mark[["open", "high", "low", "close"]].add_prefix("mark_"), how="inner")
    x = x.join(index[["open", "high", "low", "close"]].add_prefix("index_"), how="inner")
    x = pd.merge_asof(
        x.sort_index(), funding.sort_index(), left_index=True, right_index=True,
        direction="backward", tolerance=pd.Timedelta(days=2),
    )
    x["funding_rate"] = x["funding_rate"].fillna(0.0)
    x["market_mark_gap"] = (x.close - x.mark_close) / x.mark_close
    x["mark_index_premium"] = (x.mark_close - x.index_close) / x.index_close
    x["premium_med"] = x.mark_index_premium.abs().rolling(96).median()
    x["premium_mad"] = (
        (x.mark_index_premium.abs() - x.premium_med).abs().rolling(96).median()
    )
    return x.replace([np.inf, -np.inf], np.nan)


def context_score(base: ModuleType, row: pd.Series) -> tuple[int, int, str]:
    lo, sh, regime = base.improved_score(row)
    needed = ("mark_close", "index_close", "funding_rate",
              "market_mark_gap", "mark_index_premium")
    if any(pd.isna(row.get(name)) for name in needed):
        return 0, 0, "DATA_STALE"
    premium_limit = max(
        .0015,
        float(row.get("premium_med", 0) or 0)
        + 4 * float(row.get("premium_mad", 0) or 0),
    )
    gap = abs(float(row.market_mark_gap))
    premium = float(row.mark_index_premium)
    funding = float(row.funding_rate)
    if gap > .0025 or abs(premium) > premium_limit:
        return 0, 0, "SHOCK"
    if funding <= .00035 and premium <= .0010:
        lo += 10
    if funding >= -.00035 and premium >= -.0010:
        sh += 10
    if funding > .00075 or premium > .0018:
        lo -= 25
    if funding < -.00075 or premium < -.0018:
        sh -= 25
    return max(lo, 0), max(sh, 0), regime


def mark_asof(mark: pd.DataFrame, ts: pd.Timestamp) -> float:
    values = mark.loc[:ts, "close"]
    return float(values.iloc[-1]) if len(values) else float("nan")


def add_funding(trade: dict[str, Any], funding: pd.DataFrame,
                mark: pd.DataFrame) -> float:
    opened = pd.Timestamp(trade["opened_at"])
    closed = pd.Timestamp(trade["closed_at"])
    events = funding.loc[(funding.index > opened) & (funding.index <= closed)]
    timeline: list[tuple[pd.Timestamp, float]] = []
    for item in trade.get("entry_events", []):
        timeline.append((pd.Timestamp(item["time"]), float(item["q"])))
    for item in trade.get("exit_events", []):
        timeline.append((pd.Timestamp(item["time"]), -float(item["q"])))
    timeline.sort(key=lambda item: item[0])
    cashflow = 0.0
    for ts, rate in events["funding_rate"].items():
        qty = sum(delta for event_ts, delta in timeline if event_ts < ts)
        if qty <= 0:
            continue
        price = mark_asof(mark, ts)
        if not np.isfinite(price):
            continue
        signed = -1 if trade["direction"] == "LONG" else 1
        cashflow += signed * qty * price * float(rate)
    trade["funding_pnl_krw"] = cashflow
    trade["net_pnl_before_funding_krw"] = trade["net_pnl_krw"]
    trade["net_pnl_krw"] += cashflow
    used = float(trade.get("used_capital_krw") or 0)
    trade["return_on_used_capital_pct"] = trade["net_pnl_krw"] / used * 100 if used else 0
    return cashflow


def recalc(base_result: dict[str, Any], trades: list[dict[str, Any]]) -> dict[str, Any]:
    wins = [trade for trade in trades if trade["net_pnl_krw"] > 0]
    losses = [trade for trade in trades if trade["net_pnl_krw"] < 0]
    gp = sum(trade["net_pnl_krw"] for trade in wins)
    gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
    equity = 300_000.0
    peak = equity
    close_mdd = 0.0
    streak = max_streak = 0
    for trade in sorted(trades, key=lambda item: item["closed_at"]):
        equity += trade["net_pnl_krw"]
        peak = max(peak, equity)
        close_mdd = min(close_mdd, (equity - peak) / peak * 100)
        streak = streak + 1 if trade["net_pnl_krw"] < 0 else 0
        max_streak = max(max_streak, streak)

    def side(direction: str) -> dict[str, Any]:
        subset = [trade for trade in trades if trade["direction"] == direction]
        return dict(
            trades=len(subset),
            win_rate_pct=(
                sum(trade["net_pnl_krw"] > 0 for trade in subset) / len(subset) * 100
                if subset else 0
            ),
            net_pnl_krw=sum(trade["net_pnl_krw"] for trade in subset),
        )

    result = dict(base_result)
    result.update(
        final_equity_krw=equity,
        net_pnl_krw=equity - 300_000.0,
        return_pct=(equity / 300_000.0 - 1) * 100,
        trades=len(trades), wins=len(wins), losses=len(losses),
        win_rate_pct=len(wins) / len(trades) * 100 if trades else 0,
        profit_factor=gp / gl if gl else None,
        expectancy_per_trade_krw=(
            np.mean([trade["net_pnl_krw"] for trade in trades]) if trades else 0
        ),
        maximum_drawdown_pct=min(
            float(base_result.get("maximum_drawdown_pct", 0)), close_mdd
        ),
        maximum_consecutive_losses=max_streak,
        total_funding_pnl_krw=sum(
            float(trade.get("funding_pnl_krw", 0)) for trade in trades
        ),
        long=side("LONG"), short=side("SHORT"),
        entry_stages_filled=dict(Counter(
            trade["entry_stages_filled"] for trade in trades
        )),
        exit_reasons=dict(Counter(trade["exit_reason"] for trade in trades)),
    )
    return result


def run_fold(base: ModuleType, symbol: str, frame: pd.DataFrame,
             funding: pd.DataFrame, mark: pd.DataFrame, strategy: str,
             start: pd.Timestamp, end: pd.Timestamp) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sliced = frame.loc[(frame.index >= start) & (frame.index < end)].copy()
    original_features, original_score = base.features, base.score
    try:
        base.features = lambda data: data
        if strategy == "FUNDING_MARK_FILTER":
            base.score = lambda cfg, row: context_score(base, row)
        else:
            base.score = lambda cfg, row: base.improved_score(row)
        result, trades = base.simulate(symbol, sliced, strategy, STRATEGIES[strategy])
    finally:
        base.features, base.score = original_features, original_score
    for trade in trades:
        add_funding(trade, funding, mark)
    return recalc(result, trades), trades


def aggregate(runs: list[dict[str, Any]], trades: list[dict[str, Any]],
              strategy: str) -> dict[str, Any]:
    rr = [run for run in runs if run["strategy"] == strategy]
    tt = [trade for trade in trades if trade["strategy"] == strategy]
    wins = [trade for trade in tt if trade["net_pnl_krw"] > 0]
    losses = [trade for trade in tt if trade["net_pnl_krw"] < 0]
    gp = sum(trade["net_pnl_krw"] for trade in wins)
    gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
    profitable_symbols = 0
    for symbol in SYMBOLS:
        if sum(run["net_pnl_krw"] for run in rr if run["symbol"] == symbol) > 0:
            profitable_symbols += 1
    return dict(
        strategy=strategy, profitable_symbols=profitable_symbols,
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


def save(source: dict[str, Any], folds: list[tuple[str, pd.Timestamp, pd.Timestamp]],
         runs: list[dict[str, Any]], trades: list[dict[str, Any]]) -> None:
    aggregates = [aggregate(runs, trades, strategy) for strategy in STRATEGIES]
    candidate = next(item for item in aggregates if item["strategy"] == "FUNDING_MARK_FILTER")
    oldest = sum(
        run["net_pnl_krw"] for run in runs
        if run["strategy"] == "FUNDING_MARK_FILTER"
        and run["fold"] == "FOLD_A_OLDEST_HOLDOUT"
    )
    conditions = dict(
        combined_net_positive=candidate["pooled_net_pnl_krw"] > 0,
        profit_factor_at_least_1_20=(candidate["profit_factor"] or 0) >= 1.20,
        at_least_3_profitable_symbols=candidate["profitable_symbols"] >= 3,
        at_least_30_trades=candidate["trades"] >= 30,
        worst_mdd_not_below_minus_5=candidate["worst_maximum_drawdown_pct"] >= -5,
        oldest_holdout_positive=oldest > 0,
    )
    passed = all(conditions.values())
    now = datetime.now(timezone.utc).isoformat()
    summary = dict(
        status="THIRD_STAGE_PUBLIC_DATA_BACKTEST_NOT_LIVE_READY",
        generated_at=now,
        source=dict(
            exchange="Bitget", timeframe="15m", symbols=source,
            endpoints=[
                "/api/v2/mix/market/history-candles",
                "/api/v2/mix/market/history-mark-candles",
                "/api/v2/mix/market/history-index-candles",
                "/api/v2/mix/market/history-fund-rate",
            ],
        ),
        policy=dict(
            starting_capital_krw_per_run=300_000, max_planned_capital_krw=30_000,
            leverage=5, entry_splits=[.4, .3, .3], exit_splits=[.3, .3, .4],
            fee_bps_per_fill=12, slippage_bps_per_fill=15,
        ),
        folds=[dict(name=name, start=start.isoformat(), end=end.isoformat())
               for name, start, end in folds],
        aggregate=aggregates, runs=runs, pass_conditions=conditions, passed=passed,
        limitations=[
            "Funding cashflows are applied to trade PnL after the fixed entry/exit simulation; they do not retroactively change intrafold daily lock timing.",
            "Mark/index divergence is an entry and shock filter; market candles remain the fill and stop/target path used by the pinned stage-two simulator.",
            "Historical OI, long-short ratio, order-book depth, liquidation stream, rejected orders and real fill failures are not modeled.",
            "The oldest fold was outside the prior 45-day tests, but all results remain simulated.",
            "Historical performance never guarantees future profitability.",
        ],
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{STEM}.json").write_text(
        json.dumps({"summary": summary, "trades": trades},
                   ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    pd.DataFrame(runs).to_csv(OUT / f"{STEM}_RUNS.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame([
        {key: value for key, value in trade.items()
         if key not in ("entry_events", "exit_events")}
        for trade in trades
    ]).to_csv(OUT / f"{STEM}_TRADES.csv", index=False, encoding="utf-8-sig")

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
            subset = [run for run in runs
                      if run["fold"] == fold_name and run["strategy"] == strategy]
            fold_trades = [trade for trade in trades
                           if trade["fold"] == fold_name and trade["strategy"] == strategy]
            wins = [trade for trade in fold_trades if trade["net_pnl_krw"] > 0]
            losses = [trade for trade in fold_trades if trade["net_pnl_krw"] < 0]
            gp = sum(trade["net_pnl_krw"] for trade in wins)
            gl = abs(sum(trade["net_pnl_krw"] for trade in losses))
            fold_rows.append(
                f"| {fold_name} | {strategy} | "
                f"{sum(run['net_pnl_krw'] for run in subset):+,.0f}원 | "
                f"{len(fold_trades)} | "
                f"{(len(wins)/len(fold_trades)*100 if fold_trades else 0):.2f}% | "
                f"{pf(gp/gl if gl else None)} |"
            )
    check_rows = "\n".join(
        f"- {'통과' if ok else '실패'}: {name}" for name, ok in conditions.items()
    )
    md = f"""# Bitget 5종목 89일 펀딩·마크·지수 워크포워드 3차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용한 예비 검증입니다.

- 생성: {now}
- 종목: {", ".join(SYMBOLS)}
- 시장·마크·지수가격 15분봉과 과거 펀딩비 사용
- 각 실행 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 분할진입 40·30·30 / 분할청산 30·30·40
- 매 체결 수수료 12bp + 슬리피지 15bp
- 89일을 오래된 미사용 구간·중간·최근 구간으로 고정 분리

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

- 오래된 미사용 구간 후보전략 합산손익: {oldest:+,.0f}원
- 최종 판정: {"예비 통과지만 섀도 검증 전 실거래 금지" if passed else "탈락 또는 추가 개선 필요"}

## 제한

- 펀딩손익은 거래 결과에 반영했지만 당일 중단 시점을 소급 변경하지 않습니다.
- 마크·지수 괴리는 진입 및 쇼크 필터이고, 체결 경로는 2차와 동일한 시장 캔들입니다.
- 과거 OI·롱숏비율·호가·청산 스트림과 실제 주문실패는 미포함입니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.
"""
    (OUT / f"{STEM}.md").write_text(md, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


def main() -> None:
    base = load_base()
    session = requests.Session()
    session.headers["User-Agent"] = "seungjae-funding-mark-walkforward/3.0"
    frames, marks, fundings, source = {}, {}, {}, {}
    for symbol in SYMBOLS:
        market = fetch_candles(session, symbol, "/api/v2/mix/market/history-candles")
        mark = fetch_candles(session, symbol, "/api/v2/mix/market/history-mark-candles")
        index = fetch_candles(session, symbol, "/api/v2/mix/market/history-index-candles")
        funding = fetch_funding(session, symbol)
        frame = enrich(base, market, mark, index, funding)
        frames[symbol], marks[symbol], fundings[symbol] = frame, mark, funding
        source[symbol] = dict(
            candles=len(frame), period_start=frame.index[0].isoformat(),
            period_end=(frame.index[-1] + pd.Timedelta(minutes=15)).isoformat(),
            funding_records=len(funding),
        )

    start = max(frame.index[0] for frame in frames.values())
    end = min(frame.index[-1] for frame in frames.values()) + pd.Timedelta(minutes=15)
    span = (end - start) / 3
    folds = [
        ("FOLD_A_OLDEST_HOLDOUT", start, start + span),
        ("FOLD_B_MIDDLE", start + span, start + 2 * span),
        ("FOLD_C_RECENT", start + 2 * span, end),
    ]
    runs, trades = [], []
    for symbol, frame in frames.items():
        for fold_name, fold_start, fold_end in folds:
            for strategy in STRATEGIES:
                result, generated = run_fold(
                    base, symbol, frame, fundings[symbol], marks[symbol],
                    strategy, fold_start, fold_end,
                )
                result.update(
                    symbol=symbol, strategy=strategy, fold=fold_name,
                    fold_start=fold_start.isoformat(), fold_end=fold_end.isoformat(),
                )
                runs.append(result)
                for trade in generated:
                    trade.update(symbol=symbol, strategy=strategy, fold=fold_name)
                    trades.append(trade)
    save(source, folds, runs, trades)


if __name__ == "__main__":
    main()

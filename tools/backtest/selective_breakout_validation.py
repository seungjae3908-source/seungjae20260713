#!/usr/bin/env python3
"""Second-pass selective breakout validation using the v2 backtest engine."""
from __future__ import annotations
import importlib.util, json, sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd

MODULE_PATH = Path(__file__).with_name("improved_multisymbol_split_backtest.py")
spec = importlib.util.spec_from_file_location("backtest_core", MODULE_PATH)
core = importlib.util.module_from_spec(spec)
sys.modules["backtest_core"] = core
assert spec.loader is not None
spec.loader.exec_module(core)

SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT")
OUT = Path("docs/backtests")
STEM = "BITGET_5SYMBOL_45D_SELECTIVE_BREAKOUT"
COSTS = {
    "CONSERVATIVE": dict(fee_bps=12, slip_bps=15),
    "LOWER_FRICTION_SENSITIVITY": dict(fee_bps=6, slip_bps=5),
}
CURRENT_IMPROVED = dict(core.STRATEGIES["IMPROVED_SPLIT"])
SELECTIVE = dict(core.STRATEGIES["IMPROVED_SPLIT"])
SELECTIVE.update(threshold=85, gap=20, selective=True, cooldown=12, hold=192)
STRATEGIES = {
    "CURRENT_IMPROVED_SPLIT": CURRENT_IMPROVED,
    "SELECTIVE_BREAKOUT_SPLIT": SELECTIVE,
}

original_features = core.features
original_score = core.score
btc_context = None


def with_btc_context(frame):
    enriched = original_features(frame)
    if btc_context is None:
        return enriched
    context = btc_context.rename(columns=lambda c: f"btc_{c}")
    return pd.merge_asof(
        enriched.sort_index(), context.sort_index(), left_index=True,
        right_index=True, direction="backward",
    )


def selective_score(row):
    long_score, short_score, regime = core.improved_score(row)
    if regime not in ("BULL", "BEAR") or bool(row.shock):
        return 0, 0, regime
    required = (
        "btc_h4_e20", "btc_h4_e50", "btc_h4_slope", "btc_h4_adx",
        "btc_h1_e20", "btc_h1_e50", "btc_h1_slope", "btc_h1_adx",
    )
    if any(pd.isna(row[name]) for name in required):
        return 0, 0, "UNKNOWN"
    btc_bull = (
        row.btc_h4_e20 > row.btc_h4_e50 and row.btc_h4_slope > 0
        and row.btc_h1_e20 > row.btc_h1_e50 and row.btc_h1_slope > 0
        and row.btc_h4_adx >= 19 and row.btc_h1_adx >= 18
    )
    btc_bear = (
        row.btc_h4_e20 < row.btc_h4_e50 and row.btc_h4_slope < 0
        and row.btc_h1_e20 < row.btc_h1_e50 and row.btc_h1_slope < 0
        and row.btc_h4_adx >= 19 and row.btc_h1_adx >= 18
    )
    chase_block = row.range_atr > 1.8
    long_ok = (
        regime == "BULL" and btc_bull and not chase_block
        and row.adx >= 22 and row.h1_adx >= 20 and row.vr >= 1.25
        and 55 <= row.rsi <= 70 and row["hist"] > 0 and row.slope15 > 0
        and pd.notna(row.hi20) and row.close > row.hi20 and row.close > row.open
    )
    short_ok = (
        regime == "BEAR" and btc_bear and not chase_block
        and row.adx >= 22 and row.h1_adx >= 20 and row.vr >= 1.25
        and 30 <= row.rsi <= 45 and row["hist"] < 0 and row.slope15 < 0
        and pd.notna(row.lo20) and row.close < row.lo20 and row.close < row.open
    )
    return (long_score if long_ok else 0, short_score if short_ok else 0, regime)


def patched_score(cfg, row):
    return selective_score(row) if cfg.get("selective") else original_score(cfg, row)


def aggregate(results, trades):
    rows = []
    for cost_name in COSTS:
        for strategy_name in STRATEGIES:
            rr = [r for r in results if r["cost_scenario"] == cost_name and r["strategy"] == strategy_name]
            tt = [t for t in trades if t["cost_scenario"] == cost_name and t["strategy"] == strategy_name]
            wins = [t for t in tt if t["net_pnl_krw"] > 0]
            losses = [t for t in tt if t["net_pnl_krw"] < 0]
            gp = sum(t["net_pnl_krw"] for t in wins)
            gl = abs(sum(t["net_pnl_krw"] for t in losses))
            rows.append(dict(
                cost_scenario=cost_name, strategy=strategy_name,
                profitable_symbols=sum(r["net_pnl_krw"] > 0 for r in rr),
                average_return_pct=float(np.mean([r["return_pct"] for r in rr])),
                pooled_net_pnl_krw=sum(r["net_pnl_krw"] for r in rr), trades=len(tt),
                win_rate_pct=len(wins) / len(tt) * 100 if tt else 0,
                profit_factor=gp / gl if gl else None,
                worst_maximum_drawdown_pct=min(r["maximum_drawdown_pct"] for r in rr),
                total_fees_krw=sum(r["total_fees_krw"] for r in rr),
                estimated_slippage_krw=sum(r["estimated_slippage_krw"] for r in rr),
                stages=dict(Counter(t["entry_stages_filled"] for t in tt)),
            ))
    return rows


def save(frames, results, trades):
    OUT.mkdir(parents=True, exist_ok=True)
    agg = aggregate(results, trades); now = datetime.now(timezone.utc).isoformat()
    payload = dict(
        status="SECOND_PASS_SELECTIVE_VALIDATION_NOT_LIVE_READY", generated_at=now,
        source=dict(exchange="Bitget", endpoint="/api/v2/mix/market/history-candles", timeframe="15m",
            symbols={s: dict(candles=len(df), period_start=df.index[0].isoformat(),
            period_end=(df.index[-1] + pd.Timedelta(minutes=15)).isoformat()) for s, df in frames.items()}),
        changes=[
            "BTC 4h/1h market direction must agree with each symbol.",
            "Only high-volume 20-bar breakouts are eligible.",
            "ADX, RSI, MACD histogram and EMA slopes must agree.",
            "Oversized breakout candles are blocked to avoid chasing.",
            "Cooldown increased and maximum holding time reduced.",
            "Conservative cost is pass/fail; lower friction is sensitivity only.",
        ], aggregate=agg, runs=results,
        limitations=[
            "This is a second pass on the same market period, so repeated tuning can overfit.",
            "OI, funding, order book, liquidation and news data remain absent.",
            "Lower-friction results are sensitivity analysis, not actual-fee claims.",
            "Stop-first intrabar handling remains conservative.",
            "No result in this report authorizes real orders.",
        ],
    )
    (OUT / f"{STEM}.json").write_text(
        json.dumps({"summary": payload, "trades": trades}, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    pd.DataFrame([{k: v for k, v in t.items() if k not in ("entry_events", "exit_events")} for t in trades]).to_csv(
        OUT / f"{STEM}_TRADES.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame(results).to_csv(OUT / f"{STEM}_RUNS.csv", index=False, encoding="utf-8-sig")
    def pf(value): return "-" if value is None else f"{value:.3f}"
    aggregate_rows = "\n".join(
        f"| {r['cost_scenario']} | {r['strategy']} | {r['profitable_symbols']}/5 | "
        f"{r['average_return_pct']:+.2f}% | {r['pooled_net_pnl_krw']:+,.0f}원 | "
        f"{r['trades']} | {r['win_rate_pct']:.2f}% | {pf(r['profit_factor'])} | "
        f"{r['worst_maximum_drawdown_pct']:.2f}% |" for r in agg)
    run_rows = "\n".join(
        f"| {r['cost_scenario']} | {r['symbol']} | {r['strategy']} | {r['return_pct']:+.2f}% | "
        f"{r['net_pnl_krw']:+,.0f}원 | {r['trades']} | {r['win_rate_pct']:.2f}% | "
        f"{pf(r['profit_factor'])} | {r['maximum_drawdown_pct']:.2f}% |" for r in results)
    selected = next(r for r in agg if r["cost_scenario"] == "CONSERVATIVE" and r["strategy"] == "SELECTIVE_BREAKOUT_SPLIT")
    passed = (selected["pooled_net_pnl_krw"] > 0 and (selected["profit_factor"] or 0) >= 1.2
        and selected["profitable_symbols"] >= 3 and selected["trades"] >= 25
        and selected["worst_maximum_drawdown_pct"] >= -5)
    md = f"""# Bitget 5종목 선택적 돌파 전략 2차 백테스트

> 같은 기간을 반복 조정하는 과최적화 위험을 명시한 2차 예비 검증입니다.

- 생성: {now}
- 종목: {", ".join(SYMBOLS)}
- 원금: 각 독립 실행 300,000원 / 거래당 최대 30,000원 / 5배
- 보수 비용: 체결마다 수수료 12bp + 슬리피지 15bp
- 낮은 비용 시나리오는 민감도 비교일 뿐 실제 수수료 주장 아님

## 2차 개선
- BTC 4시간·1시간 방향과 개별 종목 방향 동시 일치
- 거래량 1.25배 이상인 20봉 돌파만 진입
- ADX·RSI·MACD·EMA 기울기 동시 확인
- 지나치게 큰 돌파봉은 추격진입 차단
- 진입 후 재진입 대기시간 확대
- 실제 통과 판정은 보수 비용 시나리지만 사용

## 전체 결과
| 비용 | 전략 | 수익 종목 | 평균 수익률 | 5종목 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
{aggregate_rows}

## 종목별
| 비용 | 종목 | 전략 | 수익률 | 순손익 | 거래 | 승률 | PF | MDD |
|---|---|---|---:|---:|---:|---:|---:|---:|
{run_rows}

## 판정
- 보수비용 통과조건: 합산 순수익 양수, PF≥1.20, 3개 이상 종목 수익, 거래≥25, 최악 MDD≥-5%
- 결과: {"예비 통과" if passed else "탈락 또는 추가 데이터 필요"}

## 주의
- 이번도 같은 45일 시장기간이므로 결과가 좋아져도 실거래 근거로 쓰지 않습니다.
- 다음 개선은 점수 재조정보다 OI·펀딩·호가와 별도 기간 데이터를 추가하는 방향이어야 합니다.
"""
    (OUT / f"{STEM}.md").write_text(md, encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def main():
    global btc_context
    frames = {symbol: core.fetch(symbol) for symbol in SYMBOLS}
    btc_context = original_features(frames["BTCUSDT"])[
        ["h4_e20", "h4_e50", "h4_slope", "h4_adx", "h1_e20", "h1_e50", "h1_slope", "h1_adx"]]
    core.features = with_btc_context; core.score = patched_score
    results, trades = [], []
    for cost_name, costs in COSTS.items():
        core.FEE = costs["fee_bps"] / 10_000; core.SLIP = costs["slip_bps"] / 10_000
        for symbol, frame in frames.items():
            for strategy_name, cfg in STRATEGIES.items():
                result, current_trades = core.simulate(symbol, frame, strategy_name, cfg)
                result["cost_scenario"] = cost_name
                for trade in current_trades: trade["cost_scenario"] = cost_name
                results.append(result); trades.extend(current_trades)
    save(frames, results, trades)


if __name__ == "__main__": main()

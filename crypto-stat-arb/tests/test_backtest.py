import numpy as np
import pandas as pd
import pytest

from csa_lab.backtest import (CARRY_ORIGINAL, XVENUE_ORIGINAL, BacktestInputError, MarketData, StrategyParams,
                              annualized_funding, prepare_funding, run_backtest)
from csa_lab.costs import CostModel, CostRate

H = 3_600_000
T0 = 1_672_531_200_000


def market(n=24 * 20, price=100.0, b_rate=0.0002, h_rate=0.0, spike_at=None, spike=1.0, funding_until=None):
    ts = np.array([T0 + i * H for i in range(n)])
    p = np.full(n, price)
    hi = p.copy()
    if spike_at is not None:
        hi[spike_at] = price * spike
    cols = {}
    for leg in ("binance_spot", "binance_perp", "hl_perp"):
        cols.update({f"{leg}_open": p, f"{leg}_high": hi, f"{leg}_low": p, f"{leg}_close": p})
    bars = pd.DataFrame(cols, index=ts)
    end = funding_until or (T0 + n * H)
    fb = pd.DataFrame({"ts": [t for t in range(T0, end, 8 * H)], "rate": b_rate})
    fh = pd.DataFrame({"ts": [t for t in range(T0, end, H)], "rate": h_rate})
    return MarketData(bars, {"binance": prepare_funding(fb, 8), "hyperliquid": prepare_funding(fh, 1)})


def cost(fee=0.0004, slip=0.0001, spread=0.0):
    return CostModel(CostRate("taker_fee", fee, "test"), CostRate("slippage", slip, "test"),
                     CostRate("half_spread", spread, "test"), True, "test")


KW = dict(venue_fees={}, mmr={"binance": 0.004, "hyperliquid": 0.0125},
          stale_funding_hours={"binance": 9, "hyperliquid": 2})


def run(m, params, lev, c=None, capital=1000.0, n=None):
    end = int(m.bars.index[-1]) + H
    return run_backtest(m, params, leverage=lev, capital=capital, cost=c or cost(), start_ms=T0, end_ms=end, **KW)


def test_annualized_funding_uses_only_past():
    f = prepare_funding(pd.DataFrame({"ts": [T0, T0 + 8 * H, T0 + 16 * H], "rate": [0.0001, 0.0002, 0.0009]}), 8)
    ann, last = annualized_funding(f, T0 + 8 * H, 24)
    assert last == T0 + 8 * H
    assert ann == pytest.approx(np.mean([0.0001, 0.0002]) * 3 * 365)
    assert annualized_funding(f, T0 - 1, 24) == (None, None)


def test_carry_funding_accounting_exact():
    m = market(b_rate=0.0002)  # 연 21.9% > 15%
    r = run(m, CARRY_ORIGINAL, 1, c=cost(0.0, 0.0, 0.0))
    t = r["trades"]
    assert len(t) == 1 and t[0]["exit_reason"] == "end_of_data"
    # 진입: 첫 공시(T0) 직후 → T0 봉 시가 진입, T0 펀딩은 받지 않음
    assert t[0]["entry_ts"].startswith("2023-01-01T00:00")
    perp = [l for l in t[0]["legs"] if l["kind"] == "perp"][0]
    prints = len(range(T0 + 8 * H, T0 + 24 * 20 * H, 8 * H))
    assert perp["notional_entry"] == pytest.approx(500.0)
    assert r["metrics"]["funding_pnl"] == pytest.approx(500.0 * 0.0002 * prints)
    assert r["metrics"]["net_pnl"] == pytest.approx(r["metrics"]["funding_pnl"])
    assert r["metrics"]["max_drawdown"] == pytest.approx(0.0)


def test_costs_are_charged_round_trip_and_separately():
    m = market(b_rate=0.0002)
    r = run(m, CARRY_ORIGINAL, 1, c=cost(0.0004, 0.0001, 0.00005))
    mt = r["metrics"]
    per_side = 0.0004 + 0.0001 + 0.00005
    notional = 500.0 + 500.0
    assert mt["fees_entry"] == pytest.approx(notional * 0.0004)
    assert mt["fees_exit"] == pytest.approx(notional * 0.0004)
    assert mt["slippage"] == pytest.approx(2 * notional * 0.0001)
    assert mt["spread"] == pytest.approx(2 * notional * 0.00005)
    assert mt["net_pnl"] == pytest.approx(mt["funding_pnl"] - notional * per_side * 2 - 0 * mt["gross_price_pnl"])
    assert mt["win_rate_net"] in (0.0, 1.0)


def test_unknown_cost_blocks_backtest():
    m = market()
    c = CostModel(CostRate("taker_fee", None, "미확인"), CostRate("slippage", 0.0, "t"),
                  CostRate("half_spread", 0.0, "t"), True, "t")
    with pytest.raises(BacktestInputError):
        run(m, CARRY_ORIGINAL, 1, c=c)


@pytest.mark.parametrize("lev", range(1, 8))
def test_xvenue_leverage_scales_notional_funding_and_costs(lev):
    m = market(b_rate=0.0002, h_rate=0.0)  # 차이 21.9% > 10%
    base = run(m, XVENUE_ORIGINAL, 1)
    r = run(m, XVENUE_ORIGINAL, lev)
    for k in ("funding_pnl", "fees_total", "slippage", "max_notional_per_leg"):
        assert r["metrics"][k] == pytest.approx(base["metrics"][k] * lev), k
    assert r["metrics"]["net_pnl"] == pytest.approx(base["metrics"]["net_pnl"] * lev)
    assert r["metrics"]["max_notional_per_leg"] == pytest.approx(500.0 * lev)
    t = r["trades"][0]
    assert t["leverage"] == lev
    sides = {l["venue"]: l["side"] for l in t["legs"]}
    assert sides == {"binance": -1, "hyperliquid": 1}


def test_carry_leverage_split_spot_and_margin():
    m = market(b_rate=0.0002)
    r = run(m, CARRY_ORIGINAL, 3, c=cost(0, 0, 0))
    legs = {l["kind"]: l for l in r["trades"][0]["legs"]}
    assert legs["spot"]["notional_entry"] == pytest.approx(1000 * 3 / 4)
    assert legs["perp"]["margin"] == pytest.approx(1000 / 4)
    assert legs["perp"]["notional_entry"] == pytest.approx(750.0)


def test_liquidation_high_leverage_only():
    m = market(b_rate=0.0002, spike_at=100, spike=1.20)
    r7 = run(m, CARRY_ORIGINAL, 7)
    r1 = run(m, CARRY_ORIGINAL, 1)
    assert r7["metrics"]["liquidations"] == 1 and r1["metrics"]["liquidations"] == 0
    liq = [t for t in r7["trades"] if t["liquidated"]][0]
    perp = [l for l in liq["legs"] if l["kind"] == "perp"][0]
    assert perp["liq_price"] == pytest.approx(100 * (1 + 1 / 7) / 1.004)
    assert liq["exit_reason"] == "liquidation"
    assert r7["metrics"]["net_pnl"] < r1["metrics"]["net_pnl"]


def test_stale_funding_blocks_new_entries():
    m = market(b_rate=0.0002, funding_until=T0 + 24 * H)
    r = run(m, CARRY_ORIGINAL, 1)
    assert r["metrics"]["blocked_stale_hours"] > 0
    assert r["trades"][0]["exit_reason"] == "stale_data_exit"
    assert len(r["trades"]) == 1


def test_missing_bar_rejected_and_bad_inputs():
    m = market()
    m.bars = m.bars.drop(index=m.bars.index[50:60])  # 10시간 연속 누락 > 허용 6시간
    with pytest.raises(BacktestInputError):
        run(m, CARRY_ORIGINAL, 1)
    m2 = market()
    m2.bars.iloc[10, 0] = np.nan
    with pytest.raises(BacktestInputError):
        run(m2, CARRY_ORIGINAL, 1)
    from csa_lab.leverage import LeverageError
    with pytest.raises(LeverageError):
        run(market(), CARRY_ORIGINAL, 8)
    with pytest.raises(BacktestInputError):
        run(market(), CARRY_ORIGINAL, 1, capital=0)


def test_no_lookahead_future_funding_change():
    # 미래 펀딩만 바꿔도 그 이전 판단·자본은 달라지지 않아야 한다
    m1 = market(b_rate=0.0002)
    m2 = market(b_rate=0.0002)
    fb = m2.funding["binance"].copy()
    fb.loc[fb["ts"] >= T0 + 200 * H, "rate"] = -0.001
    m2.funding["binance"] = fb
    a = run(m1, CARRY_ORIGINAL, 2)
    b = run(m2, CARRY_ORIGINAL, 2)
    ea = dict(a["equity_curve_daily"])
    eb = dict(b["equity_curve_daily"])
    cutoff = pd.Timestamp(T0 + 200 * H, unit="ms", tz="UTC").isoformat()
    for k in ea:
        if k < cutoff:
            assert ea[k] == pytest.approx(eb[k])


def test_deterministic_rerun():
    m = market(b_rate=0.0002, spike_at=50, spike=1.05)
    a = run(m, XVENUE_ORIGINAL, 4)
    b = run(m, XVENUE_ORIGINAL, 4)
    assert a == b


def test_short_gap_keeps_funding_settlement():
    # 펀딩 시각이 들어 있는 봉이 빠져도 다음 봉에서 정산돼 펀딩이 누락되지 않는다
    full = run(market(b_rate=0.0002), CARRY_ORIGINAL, 1, c=cost(0, 0, 0))
    m = market(b_rate=0.0002)
    m.bars = m.bars.drop(index=[T0 + 16 * H, T0 + 17 * H])
    gap = run(m, CARRY_ORIGINAL, 1, c=cost(0, 0, 0))
    assert gap["metrics"]["missing_bars_in_window"] == 2
    assert gap["metrics"]["funding_pnl"] == pytest.approx(full["metrics"]["funding_pnl"])

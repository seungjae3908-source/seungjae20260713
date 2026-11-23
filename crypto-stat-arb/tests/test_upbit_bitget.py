"""업비트 현물 + 비트겟 무기한 캐리(carry_upbit_bitget): 수집기·시장 구성·백테스트·품질 판정 (합성 데이터)."""
from datetime import date

import numpy as np
import pandas as pd
import pytest

from csa_lab.backtest import (CARRY_ORIGINAL, CARRY_UPBIT_BITGET, BacktestInputError, MarketData, prepare_funding,
                              run_backtest)
from csa_lab.costs import CostModel, CostRate
from csa_lab.data import bitget as bg
from csa_lab.data import upbit as up
from csa_lab.http import ForbiddenRequestError, PublicHttpClient, RetryPolicy, check_request_allowed
from csa_lab.pipeline import STRATEGY_DATASETS, build_market, collect, run_suite
from csa_lab.storage import Checkpoint, read_json, verify_manifest

from fake_exchange import FakeExchange

H = 3_600_000
T0 = 1_672_531_200_000


def _client(fx):
    return PublicHttpClient(RetryPolicy(max_attempts=3, base_delay=0.001, jitter=0), transport=fx, sleep=lambda s: None)


def _ms(s):
    return int(pd.Timestamp(s, tz="UTC").value // 10**6)


# ---------------- 수집기 ----------------

def test_public_endpoints_are_allowed_and_private_ones_refused():
    check_request_allowed("GET", up.CANDLES_URL + "?market=KRW-BTC&count=200")
    for url in (bg.HISTORY_CANDLES_URL, bg.HISTORY_MARK_CANDLES_URL, bg.HISTORY_FUNDING_URL):
        check_request_allowed("GET", url + "?symbol=BTCUSDT")
    for bad in ("https://api.upbit.com/v1/orders?market=KRW-BTC", "https://api.bitget.com/api/v2/mix/order/place-order",
                "https://api.bitget.com/api/v2/mix/account/accounts"):
        with pytest.raises(ForbiddenRequestError):
            check_request_allowed("GET", bad)


def test_upbit_hour_candles_paginate_backwards_without_gaps_or_duplicates():
    fx = FakeExchange(start="2023-01-01", end="2023-02-01")
    df = up.fetch_hour_candles(_client(fx), "KRW-BTC", _ms("2023-01-01"), _ms("2023-02-01"))
    assert len(df) == 31 * 24
    assert df["ts"].is_monotonic_increasing and df["ts"].is_unique
    assert (np.diff(df["ts"].to_numpy()) == H).all()
    assert fx.calls == 4  # 744봉 / 200 → 4요청


def test_upbit_missing_hours_stay_missing_not_filled():
    gap = _ms("2023-01-10T05:00")
    fx = FakeExchange(start="2023-01-01", end="2023-01-15", upbit_drop_ts=[gap])
    df = up.fetch_hour_candles(_client(fx), "KRW-BTC", _ms("2023-01-01"), _ms("2023-01-15"))
    assert gap not in set(df["ts"]) and len(df) == 14 * 24 - 1


def test_bitget_candles_and_funding_pages():
    fx = FakeExchange(start="2023-01-01", end="2023-02-01", bg_rate=0.0003)
    c = _client(fx)
    k = bg.fetch_hour_candles(c, "BTCUSDT", _ms("2023-01-01"), _ms("2023-02-01"))
    assert len(k) == 31 * 24 and (np.diff(k["ts"].to_numpy()) == H).all()
    m = bg.fetch_hour_candles(c, "BTCUSDT", _ms("2023-01-01"), _ms("2023-02-01"), mark=True)
    assert len(m) == len(k) and (m["close"] > k["close"]).all()
    f = bg.funding_history(c, "BTCUSDT", _ms("2023-01-05"), _ms("2023-02-01"))
    assert f["ts"].min() >= _ms("2023-01-05") and (f["rate"] == 0.0003).all()
    assert (f["interval_hours"] == 8).all() and len(f) == 27 * 3


def test_bitget_funding_time_field_variants():
    assert bg._funding_ts({"fundingRate": "0.0001", "fundingTime": "1700000000000"}) == 1700000000000
    assert bg._funding_ts({"fundingRate": "0.0001", "settleTime": "1700000000000"}) == 1700000000000
    with pytest.raises(RuntimeError, match="정산 시각"):
        bg._funding_ts({"fundingRate": "0.0001"})


def test_bitget_candle_requests_cover_window_end_bar():
    """CI 11차 실측: 마지막 봉은 endTime 이 그 봉 마감(시작+1h) 이상일 때만 온다. 창마다 끝 봉이 빠지면 안 된다."""
    fx = FakeExchange(start="2023-01-01", end="2023-03-01")
    k = bg.fetch_hour_candles(_client(fx), "BTCUSDT", _ms("2023-01-01"), _ms("2023-03-01"))
    assert len(k) == 59 * 24 and (np.diff(k["ts"].to_numpy()) == H).all()


def test_bitget_error_code_is_not_silently_empty():
    with pytest.raises(RuntimeError, match="40034"):
        bg._ok({"code": "40034", "msg": "param error"}, "history-candles")


def test_unfinished_month_is_not_checkpointed(tmp_path):
    fx = FakeExchange(start="2023-01-01", end="2023-02-01")
    ck = Checkpoint(tmp_path / "ck.json")
    now = _ms("2023-01-20")
    p = up.fetch_month(_client(fx), "KRW-BTC", "2023-01", tmp_path, ck, now_ms=now)
    assert p is not None and len(pd.read_parquet(p)) == 19 * 24
    assert not ck.is_done("upbitKlines:KRW-BTC:1h:2023-01", p)
    p2 = bg.fetch_candles_month(_client(fx), "BTCUSDT", "2023-01", tmp_path, ck, now_ms=_ms("2023-03-01"))
    assert ck.is_done("bitgetKlines:BTCUSDT:1h:2023-01", p2)


def test_upbit_bitget_collect_resumes_without_redownload(tmp_path):
    fx = FakeExchange(end="2023-03-01")
    kw = dict(client=_client(fx), with_fx=False, with_hyperliquid=False)
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 2, 1), **kw)
    first = fx.calls
    rep = collect(tmp_path / "d", date(2023, 1, 1), date(2023, 2, 1), **kw)
    assert fx.calls == first, "완료된 달·펀딩 구간을 다시 받음"
    assert rep["upbit_bitget"]["upbitSpotKlines"]["months_ok"] == ["2023-01", "2023-02"]


# ---------------- 백테스트 ----------------

def _cost():
    return CostModel(CostRate("taker_fee", 0.0004, "t"), CostRate("slippage", 0.0, "t"), CostRate("half_spread", 0.0, "t"),
                     True, "t")


def _market(n=24 * 20, spot=100.0, perp=100.0, bg_rate=0.0002, premium_path=None):
    ts = np.array([T0 + i * H for i in range(n)])
    sp = np.full(n, spot) if premium_path is None else spot * np.asarray(premium_path)
    pp = np.full(n, perp)
    cols = {}
    for leg, arr in (("upbit_spot", sp), ("bitget_perp", pp), ("binance_spot", pp), ("binance_perp", pp)):
        cols.update({f"{leg}_open": arr, f"{leg}_high": arr, f"{leg}_low": arr, f"{leg}_close": arr})
    bars = pd.DataFrame(cols, index=ts)
    fb = pd.DataFrame({"ts": list(range(T0, T0 + n * H, 8 * H)), "rate": bg_rate})
    return MarketData(bars, {"bitget": prepare_funding(fb, 8), "binance": prepare_funding(fb, 8)})


def _run(m, params=CARRY_UPBIT_BITGET, lev=3, **kw):
    return run_backtest(m, params, leverage=lev, capital=1000.0, cost=_cost(),
                        venue_fees={"upbit:spot": 0.0005, "bitget:perp": 0.0006, "binance:spot": 0.0004,
                                    "binance:perp": 0.0004},
                        mmr={"bitget": 0.004, "binance": 0.004}, start_ms=T0, end_ms=T0 + 24 * 20 * H,
                        stale_funding_hours={"bitget": 9, "binance": 9}, **kw)


def test_carry_upbit_bitget_uses_upbit_spot_and_bitget_perp_with_venue_fees():
    res = _run(_market())
    t = res["trades"][0]
    legs = {l["leg"]: l for l in t["legs"]}
    assert set(legs) == {"upbit_spot", "bitget_perp"}
    assert legs["upbit_spot"]["side"] == 1 and legs["bitget_perp"]["side"] == -1
    # 3배: 현물 750, 무기한 증거금 250 → 명목 750. 거래소별 수수료가 일반 테이커 값을 대신한다: 750×0.05% + 750×0.06%
    assert t["fees_entry"] == pytest.approx(750 * 0.0005 + 750 * 0.0006)
    assert res["metrics"]["funding_pnl"] > 0  # 숏 무기한이 양의 비트겟 펀딩을 받음


def test_carry_upbit_bitget_result_differs_from_binance_when_kimchi_premium_moves():
    n = 24 * 20
    path = np.linspace(1.03, 1.00, n)  # 김치 프리미엄 3% → 0% 축소: 현물 다리 손실
    m = _market(premium_path=path)
    up_res = _run(m)
    bn_res = _run(m, params=CARRY_ORIGINAL)
    assert up_res["metrics"]["net_return"] < bn_res["metrics"]["net_return"] - 0.01


def test_missing_bitget_funding_venue_config_is_refused():
    with pytest.raises(BacktestInputError, match="bitget"):
        run_backtest(_market(), CARRY_UPBIT_BITGET, leverage=2, capital=1000.0, cost=_cost(),
                     venue_fees={"upbit:spot": 0.0005, "bitget:perp": 0.0006}, mmr={"binance": 0.004},
                     start_ms=T0, end_ms=T0 + 24 * 20 * H, stale_funding_hours={"bitget": 9})


def test_stale_bitget_funding_blocks_entries():
    m = _market()
    m.funding["bitget"] = m.funding["bitget"][m.funding["bitget"]["ts"] < T0 + 24 * H]
    res = _run(m)
    assert all(pd.Timestamp(t["entry_ts"]) < pd.Timestamp(T0 + 25 * H, unit="ms", tz="UTC") for t in res["trades"])
    assert res["metrics"]["blocked_stale_hours"] > 0


# ---------------- 파이프라인 ----------------

def test_pipeline_runs_carry_upbit_bitget_end_to_end(tmp_path):
    fx = FakeExchange(end="2023-04-01", bg_rate=0.0003)
    rep = collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    ub = rep["upbit_bitget"]
    assert ub["upbitSpotKlines"]["months_ok"] == ["2023-01", "2023-02", "2023-03"]
    assert ub["bitgetKlines"]["months_ok"] == ["2023-01", "2023-02", "2023-03"]
    assert ub["bitgetFunding"]["rows"] > 0
    market, quality = build_market(tmp_path / "d")
    assert {"upbitSpotKlines", "upbitKrwUsdtKlines", "bitgetKlines", "bitgetMarkKlines", "bitgetFunding"} <= set(market.datasets)
    # 업비트 KRW-BTC 를 KRW-USDT 로 나눈 값 = 바이낸스형 가격 × 김치 배수
    row = market.bars.iloc[100]
    assert row["upbit_spot_close"] == pytest.approx(row["bitget_perp_close"] * 1.02)
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[2, 3, 7], capital_krw=500_000,
                    windows={"w": ("2023-01-02", "2023-03-30")}, strategies=["carry_upbit_bitget"],
                    profiles=["current_public_assumed"], label="ub")
    rows = read_json(out / "summary.json")
    assert [r["status"] for r in rows] == ["OK"] * 3, rows
    run = read_json(out / "runs" / "w" / "carry_upbit_bitget" / "current_public_assumed" / "lev3.json")
    assert run["live_orders"] == 0 and run["mode"] == "BACKTEST_PAPER_ONLY"
    assert set(run["data_evidence"]["datasets"]) == set(STRATEGY_DATASETS["carry_upbit_bitget"])
    assert "Bitget history-mark-candles 사용" in run["data_evidence"]["mark_price"]
    assert "upbit_spot" in run["data_evidence"]["price_proxies"]
    assert any(v["venue"] == "bitget" for v in run["venue_leverage_status"])
    assert verify_manifest(out)["ok"]


def test_missing_source_marks_window_incomplete_never_fills(tmp_path):
    fx = FakeExchange(end="2023-04-01", bitget_down=True)
    rep = collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    assert "error" in rep["upbit_bitget"]["bitgetKlines"] and "error" in rep["upbit_bitget"]["bitgetFunding"]
    assert rep["fundingRate"]["months_ok"]  # 다른 원천 수집은 계속됨
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[3], capital_krw=500_000,
                    windows={"w": ("2023-01-02", "2023-03-30")}, strategies=["carry_binance", "carry_upbit_bitget"],
                    profiles=["original"], label="down")
    by = {r["strategy"]: r for r in read_json(out / "summary.json")}
    assert by["carry_binance"]["status"] == "OK"
    assert by["carry_upbit_bitget"]["status"] == "INCOMPLETE_DATA"
    assert "DATASET_MISSING" in by["carry_upbit_bitget"]["error"]


def test_upbit_usdt_listing_late_start_is_incomplete_and_split(tmp_path):
    fx = FakeExchange(end="2023-05-01", upbit_usdt_start="2023-02-15")
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 4, 1), client=_client(fx))
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[2], capital_krw=500_000,
                    windows={"big": ("2023-01-02", "2023-04-28")}, strategies=["carry_upbit_bitget"],
                    profiles=["original"], label="late", min_segment_days=30)
    rows = read_json(out / "summary.json")
    big = [r for r in rows if r["window"] == "big"][0]
    assert big["status"] == "INCOMPLETE_DATA" and "COVERAGE_STARTS_LATE" in big["error"]
    segs = [r for r in rows if r["parent_window"] == "big"]
    assert segs and all(r["status"] == "OK" for r in segs)
    assert segs[0]["window_start"] >= "2023-02-15"


def test_gate_evidence_export_matches_adapter_shape_and_fails_closed(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("export_gate_evidence",
                                                  str(__import__("pathlib").Path(__file__).resolve().parents[1]
                                                      / "scripts" / "export_gate_evidence.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fx = FakeExchange(end="2023-04-01", bg_rate=0.0003)
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[2, 3], capital_krw=500_000,
                    windows={"w": ("2023-01-02", "2023-03-30")}, strategies=["carry_upbit_bitget"],
                    profiles=["current_public_assumed"], label="gate")
    assert mod.main(str(out), str(tmp_path / "ev.json")) == 0
    ev = read_json(tmp_path / "ev.json")
    assert set(ev) >= {"researchCodeSha", "generatedAtMs", "rows", "gate_preview"} and ev["live_orders"] == 0
    assert set(ev["rows"][0]) == set(mod.FIELDS)
    g = {x["leverage"]: x for x in ev["gate_preview"]}
    # 87일 창 → 180일 미만이라 어떤 배율도 통과하지 않는다. 1배·8배 이상은 실거래 범위 밖이라 판정 대상이 아님
    assert set(g) == set(range(2, 8))
    assert all(x["authority"] == "NONE" for x in g.values())
    assert any(r.startswith("WINDOW_TOO_SHORT:w") for r in g[2]["reasons"])
    assert g[5]["reasons"] == ["NO_MATCHING_ROW"]

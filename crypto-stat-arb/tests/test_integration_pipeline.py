"""통합: 수집 → 품질 → 시장 구성 → 1~10배 백테스트 → 불변 저장 → 무결성 → 재실행 재현성 (합성 데이터)."""
from datetime import date

import pytest

from csa_lab.http import PublicHttpClient, RetryPolicy
from csa_lab.pipeline import collect, run_suite
from csa_lab.storage import IntegrityError, LockBusyError, read_json, run_lock, verify_manifest

from fake_exchange import FakeExchange

W = {"w": ("2023-01-02", "2023-03-30")}


def _client(fx):
    return PublicHttpClient(RetryPolicy(max_attempts=4, base_delay=0.001, jitter=0), transport=fx,
                            sleep=lambda s: None)


def test_end_to_end_all_leverages(tmp_path):
    fx = FakeExchange(fail_first=2)  # 처음 두 요청 네트워크 장애 주입 → 재시도로 복구
    rep = collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    assert rep["fundingRate"]["months_ok"] == ["2023-01", "2023-02", "2023-03"]
    assert rep["http_stats"]["retries"] >= 2
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=list(range(1, 11)), capital_krw=500_000, windows=W,
                    strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="it")
    rows = read_json(out / "summary.json")
    assert len(rows) == 20 and all(r["status"] == "OK" for r in rows), rows
    for r in rows:
        assert r["fx_unit"] == "USDT" and r["capital_units"] == pytest.approx(500_000 / r["fx"])
    cap = rows[0]["capital_units"]
    for lev in range(1, 11):
        run = read_json(out / "runs" / "w" / "xvenue_funding" / "original" / f"lev{lev}.json")
        first = run["trades"][0]
        # 첫 거래: 진입 증거금 = min(한도 100만, 기본 자금 100만, 계획 50만)/환율 = 계획 50만원분
        assert first["capital_at_entry"] == pytest.approx(cap)
        for leg in first["legs"]:
            assert leg["margin"] == pytest.approx(cap / 2)
            assert leg["notional_entry"] == pytest.approx(cap / 2 * lev)
        assert first["leverage"] == lev
        assert run["fund"]["verify"]["ok"] and run["fund"]["plans"] == {"carry_binance": 500_000, "xvenue_funding": 500_000}
        fund_file = read_json(out / "runs" / "w" / "xvenue_funding" / "original" / f"lev{lev}.fund.json")
        assert len(fund_file["settled"]) == len(run["trades"]) and fund_file["live_orders"] == 0
    assert verify_manifest(out)["ok"]
    run = read_json(out / "runs" / "w" / "xvenue_funding" / "original" / "lev7.json")
    assert run["live_orders"] == 0 and run["mode"] == "BACKTEST_PAPER_ONLY"
    assert run["capital"]["allocation"]["allocated_krw"] == 1_000_000  # 전략 2개 × 50만원 별도 할당
    assert run["venue_leverage_status"][1]["status"] == "WITHIN_VERIFIED_LIMIT"  # 가짜 meta maxLeverage 40
    # 재실행: 같은 데이터·설정이면 결과 동일, 이전 결과는 그대로 남음
    out2 = run_suite(tmp_path / "d", tmp_path / "r", leverages=list(range(1, 11)), capital_krw=500_000, windows=W,
                     strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="it2")
    assert out2 != out and read_json(out2 / "summary.json") == rows
    assert verify_manifest(out)["ok"]
    # 결과 변조 감지
    p = out / "summary.json"
    p.write_text("[]")
    with pytest.raises(IntegrityError):
        verify_manifest(out)


def test_resume_after_interruption(tmp_path):
    fx = FakeExchange()
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 1, 1), client=_client(fx), with_fx=False,
            with_hyperliquid=False)
    calls_first = fx.calls
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx), with_fx=False,
            with_hyperliquid=False)
    # 1월분은 체크포인트로 건너뛰고 2·3월만 받음 (4종 × 2개월 × 2요청)
    assert fx.calls - calls_first == 4 * 2 * 2


def test_concurrent_collect_blocked(tmp_path):
    d = tmp_path / "d"
    d.mkdir()
    with run_lock(d / ".collect.lock"):
        with pytest.raises(LockBusyError):
            collect(d, date(2023, 1, 1), date(2023, 1, 1), client=_client(FakeExchange()))


def test_missing_fx_blocks_krw_run(tmp_path):
    fx = FakeExchange()
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx), with_fx=False)
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1], capital_krw=500_000, windows=W,
                    strategies=["carry_binance"], profiles=["original"], label="nofx")
    rows = read_json(out / "summary.json")
    assert rows[0]["status"] == "BLOCKED_FX_MISSING"


def test_bad_data_blocks_strategy_evaluation(tmp_path):
    t0 = int(__import__("pandas").Timestamp("2023-02-10", tz="UTC").value // 10**6)
    fx = FakeExchange(drop_kline_ts=[t0 + i * 3_600_000 for i in range(30)])
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    windows = {"w": W["w"], "before_gap": ("2023-01-02", "2023-02-09"), "after_gap": ("2023-02-12", "2023-03-30")}
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1], capital_krw=500_000, windows=windows,
                    strategies=["carry_binance"], profiles=["original"], label="bad")
    rows = {r["window"]: r for r in read_json(out / "summary.json")}
    # 30시간 봉 결측(약 1.4%)이 든 창만 INCOMPLETE. 결측은 채우지 않고 평가하지 않는다
    assert rows["w"]["status"] == "INCOMPLETE_DATA" and rows["w"]["data_verdict"] == "INCOMPLETE"
    assert "MISSING_RATIO:30/" in rows["w"]["error"]
    # 결측을 피한 창은 독립적으로 OK
    assert rows["before_gap"]["status"] == "OK" and rows["after_gap"]["status"] == "OK"
    meta = read_json(out / "meta.json")
    wq = meta["window_quality"]["w"]["datasets"]
    assert wq["klines"]["status"] == "INCOMPLETE" and wq["klines"]["missing_intervals"] == 30
    assert wq["klines"]["missing_ranges"][0][2] == 30 and wq["klines"]["missing_ranges"][0][0].startswith("2023-02-10T00:00")
    assert wq["fundingRate"]["status"] == "OK"  # 펀딩은 빠지지 않았으므로 데이터셋별로 다르게 판정
    assert meta["window_quality"]["after_gap"]["datasets"]["klines"]["status"] == "OK"
    # 전체 데이터셋 보고는 참고용으로 남고, 차단 근거는 창별 판정이다
    assert meta["quality_blocking_global_informational"]["klines:BTCUSDT"]
    assert meta["quality_policy"].startswith("per_window")


def test_window_quality_is_independent_per_window_and_marks_incomplete(tmp_path):
    """하이퍼리퀴드 펀딩이 2월에 시작하고 2월 중순까지 8시간 간격, 마크가격은 1월에 하루 결측."""
    h = 3_600_000
    mark_gap_start = int(__import__("pandas").Timestamp("2023-01-15", tz="UTC").value // 10**6)
    fx = FakeExchange(hl_start="2023-02-01", hl_coarse_until="2023-02-15",
                      drop_mark_ts=[mark_gap_start + i * h for i in range(24)])
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    windows = {"jan": ("2023-01-02", "2023-02-01"), "feb": ("2023-02-01", "2023-03-01"), "mar": ("2023-03-01", "2023-03-30")}
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1, 3], capital_krw=500_000, windows=windows,
                    strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="win")
    rows = read_json(out / "summary.json")
    by = {(r["window"], r["strategy"], r["leverage"]): r for r in rows}
    # 1월: 하이퍼리퀴드 데이터가 원천에 없음 → 교차거래소 전략만 INCOMPLETE, 캐리 전략은 OK(필수 데이터셋이 다름)
    assert by[("jan", "xvenue_funding", 1)]["status"] == "INCOMPLETE_DATA"
    assert "NO_DATA_IN_WINDOW" in by[("jan", "xvenue_funding", 1)]["error"]
    assert by[("jan", "carry_binance", 1)]["status"] == "OK"
    # 2월: 8시간 간격 구간이 섞임 → 1시간 데이터로 취급하지 않고 INCOMPLETE(CADENCE_MISMATCH)
    feb = by[("feb", "xvenue_funding", 3)]
    assert feb["status"] == "INCOMPLETE_DATA" and "CADENCE_MISMATCH:observed=8h" in feb["error"]
    assert by[("feb", "carry_binance", 3)]["status"] == "OK"
    # 3월: 모두 완전 → OK. 레버리지마다 같은 판정
    for lev in (1, 3):
        assert by[("mar", "xvenue_funding", lev)]["status"] == "OK"
        assert by[("mar", "carry_binance", lev)]["status"] == "OK"
    meta = read_json(out / "meta.json")
    wq = meta["window_quality"]
    hl_jan, hl_feb, hl_mar = (wq[w]["datasets"]["hyperliquid"] for w in ("jan", "feb", "mar"))
    assert hl_jan["rows_in_window"] == 0 and hl_jan["status"] == "INCOMPLETE"
    assert hl_feb["status"] == "INCOMPLETE" and hl_feb["observed_median_interval_hours"] == 1  # 1시간 행이 더 많아도
    assert hl_feb["coarse_segments"][0][2] == 8 and hl_feb["coarse_segments"][0][0].startswith("2023-02-01T00:00")
    assert hl_feb["coarse_segments"][0][1].startswith("2023-02-15T00:00")  # 8시간 구간의 실제 범위를 기록
    assert hl_feb["first_in_window"].startswith("2023-02-01T00:00") and hl_feb["rows_in_window"] == 42 + 14 * 24
    assert hl_mar["status"] == "OK" and hl_mar["missing_intervals"] == 0 and hl_mar["expected_rows"] == 29 * 24
    assert hl_mar["source"].startswith("api.hyperliquid.xyz")
    # 전체 데이터셋 보고에는 8시간 구간이 cadence_segments 로 남는다
    segs = meta["data_quality"]["hyperliquid:BTC funding"]["cadence_segments"]
    assert segs[0][2] == 8 and segs[-1][2] == 1
    # 마크가격: 1월 창은 결측 24개 → 체결가 대체(창별), 2·3월 창은 마크가격 사용
    assert wq["jan"]["datasets"]["markPriceKlines"]["missing_intervals"] == 24
    assert "체결가 사용" in wq["jan"]["mark_price_note"] and "MISSING_RATIO:24/" in wq["jan"]["mark_price_note"]
    assert wq["mar"]["mark_price_note"].startswith("Binance markPriceKlines 사용")
    # 전체 데이터셋 기준 마크 결측 여부와 무관하게 창별로 결정됐는지 결과 파일에서 확인
    jan_run = read_json(out / "runs" / "jan" / "carry_binance" / "original" / "lev1.json")
    mar_run = read_json(out / "runs" / "mar" / "carry_binance" / "original" / "lev1.json")
    assert "체결가" in jan_run["price_proxies"]["binance_perp_mark"]
    assert mar_run["price_proxies"]["binance_perp_mark"].startswith("Binance markPriceKlines")
    # 결과 파일에 출처·표본 수·평가 시작/종료·README 주장(별도)이 기록된다
    ev = mar_run["data_evidence"]
    assert ev["evaluation_start"] == "2023-03-01" and ev["evaluation_end_exclusive"] == "2023-03-30" and ev["verdict"] == "OK"
    assert set(ev["datasets"]) == {"klines", "spotKlines", "fundingRate"}
    assert ev["datasets"]["fundingRate"]["rows_in_window"] == 29 * 3 and ev["datasets"]["fundingRate"]["source"].startswith("data.binance.vision")
    assert mar_run["readme_claims_unverified"]["values"]["total_return_pct"] == 203.70
    assert meta["readme_claims_unverified"]["values"]["total_trades"] == 44652
    ok_row = by[("mar", "carry_binance", 1)]
    assert ok_row["data_first"].startswith("2023-03-01T00:00") and ok_row["data_last"].startswith("2023-03-29")
    # 창을 비교하면 같은 전략·배율이라도 창마다 판정이 다르다(독립성)
    assert {by[("jan", "xvenue_funding", 1)]["status"], by[("mar", "xvenue_funding", 1)]["status"]} == {"INCOMPLETE_DATA", "OK"}


def test_plans_exceeding_fund_are_blocked(tmp_path):
    fx = FakeExchange()
    collect(tmp_path / "d", date(2023, 1, 1), date(2023, 3, 1), client=_client(fx))
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1], capital_krw=600_000, windows=W,
                    strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="over")
    rows = read_json(out / "summary.json")
    assert all(r["status"] == "BLOCKED_PLAN_EXCEEDS_FUND" for r in rows)
    out2 = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1], capital_krw=600_000, windows=W,
                     strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="nofund",
                     fund_mode=False)
    assert all(r["status"] == "OK" for r in read_json(out2 / "summary.json"))

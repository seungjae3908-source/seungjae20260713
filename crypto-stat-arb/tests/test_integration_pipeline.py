"""통합: 수집 → 품질 → 시장 구성 → 1~7배 백테스트 → 불변 저장 → 무결성 → 재실행 재현성 (합성 데이터)."""
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
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=list(range(1, 8)), capital_krw=500_000, windows=W,
                    strategies=["carry_binance", "xvenue_funding"], profiles=["original"], label="it")
    rows = read_json(out / "summary.json")
    assert len(rows) == 14 and all(r["status"] == "OK" for r in rows), rows
    for r in rows:
        assert r["fx_unit"] == "USDT" and r["capital_units"] == pytest.approx(500_000 / r["fx"])
    cap = rows[0]["capital_units"]
    for lev in range(1, 8):
        first = read_json(out / "runs" / "w" / "xvenue_funding" / "original" / f"lev{lev}.json")["trades"][0]
        # 첫 거래: 다리당 증거금 = 자본/2, 명목가치 = 증거금 × 레버리지
        for leg in first["legs"]:
            assert leg["margin"] == pytest.approx(cap / 2)
            assert leg["notional_entry"] == pytest.approx(cap / 2 * lev)
        assert first["leverage"] == lev
    assert verify_manifest(out)["ok"]
    run = read_json(out / "runs" / "w" / "xvenue_funding" / "original" / "lev7.json")
    assert run["live_orders"] == 0 and run["mode"] == "BACKTEST_PAPER_ONLY"
    assert run["capital"]["allocation"]["allocated_krw"] == 1_000_000  # 전략 2개 × 50만원 별도 할당
    assert run["venue_leverage_status"][1]["status"] == "WITHIN_VERIFIED_LIMIT"  # 가짜 meta maxLeverage 40
    # 재실행: 같은 데이터·설정이면 결과 동일, 이전 결과는 그대로 남음
    out2 = run_suite(tmp_path / "d", tmp_path / "r", leverages=list(range(1, 8)), capital_krw=500_000, windows=W,
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
    out = run_suite(tmp_path / "d", tmp_path / "r", leverages=[1], capital_krw=500_000, windows=W,
                    strategies=["carry_binance"], profiles=["original"], label="bad")
    rows = read_json(out / "summary.json")
    assert rows[0]["status"] == "BLOCKED_DATA_QUALITY"

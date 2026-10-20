import math
from datetime import datetime, timedelta, timezone

import pytest

from csa_lab.leverage import (ALLOWED_LEVERAGES, DEFAULT_LEVERAGE, LeverageError,
                              check_paper_leverage_against_venue, parse_leverage, register_verified_limit)
from csa_lab.margin import is_liquidated, liquidation_price, roi_on_margin, size_position, unrealized_pnl
from csa_lab.money import (AllocationError, AllocationLedger, FxMissingError, FxQuote, krw_to_margin_units,
                           margin_units_to_krw, require_fx)


@pytest.mark.parametrize("v", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, "1", "10", " 3 ", "5x", "5X"])
def test_leverage_accepts_integers_1_to_10(v):
    assert parse_leverage(v) in ALLOWED_LEVERAGES


@pytest.mark.parametrize("v", [0, -1, 11, 100, 1.5, 2.0, float("nan"), float("inf"), float("-inf"),
                               "0", "11", "-1", "1.5", "2.0", "abc", "", None, True, False, "07", "nan",
                               "Infinity", [], {}, "3 x 2"])
def test_leverage_rejects_invalid(v):
    with pytest.raises(LeverageError):
        parse_leverage(v)


def test_leverage_default_is_1_only_when_explicitly_allowed():
    assert DEFAULT_LEVERAGE == 1
    assert parse_leverage(None, default_if_missing=True) == 1
    assert parse_leverage("", default_if_missing=True) == 1


def test_venue_limit_unverified_and_verified():
    st = check_paper_leverage_against_venue(7, "binance", "BTCUSDT-PERP")
    assert st["status"] == "UNVERIFIED_VENUE_LIMIT" and st["live_order_allowed"] is False
    register_verified_limit("testvenue", "X", 5, "unit test")
    assert check_paper_leverage_against_venue(5, "testvenue", "X")["status"] == "WITHIN_VERIFIED_LIMIT"
    assert check_paper_leverage_against_venue(6, "testvenue", "X")["status"] == "EXCEEDS_VERIFIED_LIMIT"


@pytest.mark.parametrize("lev", ALLOWED_LEVERAGES)
def test_notional_margin_pnl_scale_with_leverage(lev):
    s = size_position(100.0, lev, 50_000.0)
    assert s.notional == pytest.approx(100.0 * lev)
    assert s.initial_margin == pytest.approx(100.0)  # 증거금은 레버리지와 무관하게 할당 자본
    assert s.quantity == pytest.approx(100.0 * lev / 50_000.0)
    pnl = unrealized_pnl(1, s.quantity, 50_000.0, 51_000.0)
    assert pnl == pytest.approx(100.0 * lev * 0.02)
    assert roi_on_margin(pnl, s.margin) == pytest.approx(0.02 * lev)


def test_liquidation_prices():
    assert liquidation_price(1, 100.0, 1, 0.004) == 0.0
    assert liquidation_price(1, 100.0, 10, 0.004) == pytest.approx(90.0 / 0.996)
    lp2 = liquidation_price(1, 100.0, 2, 0.004)
    assert lp2 == pytest.approx(50.0 / 0.996)
    sp2 = liquidation_price(-1, 100.0, 2, 0.004)
    assert sp2 == pytest.approx(150.0 / 1.004)
    # 레버리지가 클수록 청산가가 진입가에 가까워진다
    longs = [liquidation_price(1, 100.0, L, 0.004) for L in ALLOWED_LEVERAGES]
    shorts = [liquidation_price(-1, 100.0, L, 0.004) for L in ALLOWED_LEVERAGES]
    assert longs == sorted(longs) and shorts == sorted(shorts, reverse=True)
    # 청산가에서 자본 = 유지증거금 확인 (7배 롱)
    q = 7.0 / 100.0
    p = liquidation_price(1, 100.0, 7, 0.004)
    equity = 1.0 + q * (p - 100.0)
    assert equity == pytest.approx(0.004 * q * p)
    assert is_liquidated(1, p, p - 0.01, 101) and not is_liquidated(1, p, p + 0.01, 101)
    assert is_liquidated(-1, sp2, 99, sp2) and not is_liquidated(-1, sp2, 99, sp2 - 0.01)


@pytest.mark.parametrize("bad", [0, -1, float("nan"), float("inf"), None, "1", True])
def test_margin_inputs_rejected(bad):
    with pytest.raises(ValueError):
        size_position(bad, 1, 100.0)
    with pytest.raises(ValueError):
        size_position(100.0, 1, bad)
    with pytest.raises(ValueError):
        roi_on_margin(1.0, bad)


def test_fx_required_and_not_hardcoded():
    with pytest.raises(FxMissingError):
        require_fx(None, max_age_seconds=None)
    now = datetime(2024, 1, 2, tzinfo=timezone.utc)
    q = FxQuote(1300.0, "USDT", "test", now - timedelta(days=3))
    with pytest.raises(FxMissingError):
        require_fx(q, max_age_seconds=86400, now=now)
    assert require_fx(q, max_age_seconds=None) is q
    assert krw_to_margin_units(500_000, q) == pytest.approx(500_000 / 1300.0)
    assert margin_units_to_krw(krw_to_margin_units(500_000, q), q) == pytest.approx(500_000)
    for bad in (0, -5, float("nan")):
        with pytest.raises(ValueError):
            FxQuote(bad, "USDT", "x", now)
    with pytest.raises(ValueError):
        FxQuote(1300, "USDT", "x", datetime(2024, 1, 1))  # 시간대 없음
    with pytest.raises(ValueError):
        krw_to_margin_units(0, q)


def test_allocation_ledger_prevents_double_use():
    led = AllocationLedger(500_000)
    led.allocate("calendar", 500_000)
    with pytest.raises(AllocationError):
        led.allocate("cross_venue", 500_000)
    with pytest.raises(AllocationError):
        led.allocate("calendar", 1)
    led.release("calendar")
    led.allocate("cross_venue", 300_000)
    led.allocate("roll", 200_000)
    assert led.free_krw == 0
    with pytest.raises(AllocationError):
        led.allocate("x", 1)
    total = AllocationLedger(1_000_000)
    total.allocate("a", 500_000)
    total.allocate("b", 500_000)
    assert total.to_dict()["allocated_krw"] == 1_000_000

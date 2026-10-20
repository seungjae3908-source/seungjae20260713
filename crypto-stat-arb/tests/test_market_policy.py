import json

import pytest

from csa_lab.data.bitget import contract_leverage_evidence
from csa_lab.http import HttpStatusError, PublicHttpClient, RetryPolicy, check_request_allowed
from csa_lab.leverage import LeverageError, venue_limit
from csa_lab.market_policy import (BITGET_FUTURES, KR_STOCK, UPBIT_SPOT, US_STOCK, MarketPolicyError, policy_for,
                                   policy_table, reject_leverage_field, resolve_leverage)

FIXED = [UPBIT_SPOT, KR_STOCK, US_STOCK, "crypto_spot", "domestic_stock", "us_stock", "upbit", "kiwoom", "toss"]


def test_bitget_futures_1_to_10_default_1():
    assert resolve_leverage(BITGET_FUTURES) == 1
    assert resolve_leverage("crypto_futures", None) == 1
    assert resolve_leverage("bitget", "") == 1
    for v in range(1, 11):
        assert resolve_leverage(BITGET_FUTURES, v) == v
        assert resolve_leverage(BITGET_FUTURES, str(v)) == v


@pytest.mark.parametrize("v", [0, 11, -3, 1.5, 2.0, "11", "abc", "nan", True, [], "07"])
def test_bitget_futures_rejects_out_of_range(v):
    with pytest.raises(LeverageError):
        resolve_leverage(BITGET_FUTURES, v)


@pytest.mark.parametrize("market", FIXED)
def test_fixed_markets_accept_only_absent_or_1(market):
    pol = policy_for(market)
    assert pol.fixed and pol.accepts_input is False and pol.margin_products_allowed is False
    assert resolve_leverage(market) == 1
    assert resolve_leverage(market, None) == 1
    assert resolve_leverage(market, 1) == 1
    assert resolve_leverage(market, "1") == 1


@pytest.mark.parametrize("market", FIXED)
@pytest.mark.parametrize("v", [2, 3, 10, 0, -1, 1.0, 1.5, "2", "1x", "1.0", "10", "", " ", True, False, "abc", 100])
def test_fixed_markets_reject_everything_else(market, v):
    with pytest.raises(MarketPolicyError):
        resolve_leverage(market, v)


@pytest.mark.parametrize("key", ["leverage", "bitgetLeverage", "bitget_leverage", "LEVERAGE", "lev"])
@pytest.mark.parametrize("v", [2, "3", 5, 10, 1.5])
def test_upbit_spot_rejects_leverage_via_request_body_config_api(key, v):
    # API 요청 본문 / 설정 파일 / 쿼리 경로 모두 같은 dict 검사로 거부
    for path in ("api", "config", "body"):
        payload = json.loads(json.dumps({key: v, "market": "upbit", "amount_krw": 10000, "via": path}))
        with pytest.raises(MarketPolicyError):
            reject_leverage_field(UPBIT_SPOT, payload)
    # 1 또는 필드 없음은 통과
    assert reject_leverage_field(UPBIT_SPOT, {key: 1})[key] == 1
    assert reject_leverage_field(UPBIT_SPOT, {"amount_krw": 10000}) == {"amount_krw": 10000}


def test_stock_markets_reject_leverage_field():
    for m in (KR_STOCK, US_STOCK):
        with pytest.raises(MarketPolicyError):
            reject_leverage_field(m, {"leverage": 2})


def test_bitget_body_still_validated_1_to_10():
    assert reject_leverage_field(BITGET_FUTURES, {"bitgetLeverage": 10})["bitgetLeverage"] == 10
    with pytest.raises(LeverageError):
        reject_leverage_field(BITGET_FUTURES, {"bitgetLeverage": 11})


def test_unknown_market_rejected():
    with pytest.raises(MarketPolicyError):
        resolve_leverage("binance_margin", 1)


def test_policy_table_shape():
    t = {r["market"]: r for r in policy_table()}
    assert t[BITGET_FUTURES]["min"] == 1 and t[BITGET_FUTURES]["max"] == 10 and t[BITGET_FUTURES]["default"] == 1
    for m in (UPBIT_SPOT, KR_STOCK, US_STOCK):
        assert (t[m]["min"], t[m]["max"], t[m]["default"], t[m]["accepts_input"]) == (1, 1, 1, False)


# ---- 비트겟 공개 계약 정보(가짜 응답) ----
def _transport(payload: dict, status: int = 200):
    def t(req, timeout):
        assert req.get_method() == "GET" and req.full_url.startswith("https://api.bitget.com/api/v2/mix/market/contracts")
        assert "Authorization" not in req.headers and "ACCESS-KEY" not in req.headers
        return status, {}, json.dumps(payload).encode()
    return t


def _resp(min_lever, max_lever, symbol="BTCUSDT"):
    return {"code": "00000", "msg": "success", "data": [{"symbol": symbol, "minLever": str(min_lever),
                                                          "maxLever": str(max_lever), "symbolStatus": "normal"}]}


def test_bitget_contract_evidence_within_range():
    c = PublicHttpClient(RetryPolicy(max_attempts=1), transport=_transport(_resp(1, 125)))
    ev = contract_leverage_evidence(c, "BTCUSDT")
    assert (ev["min_lever"], ev["max_lever"]) == (1, 125)
    assert ev["requested_range"] == [1, 10] and ev["requested_range_supported"] is True
    assert ev["status"] == "VERIFIED_WITHIN_CONTRACT_RANGE"
    assert venue_limit("bitget", "BTCUSDT-USDT-FUTURES").verified and venue_limit("bitget", "BTCUSDT-USDT-FUTURES").max_leverage == 125


def test_bitget_contract_evidence_outside_range_is_not_marked_supported():
    c = PublicHttpClient(RetryPolicy(max_attempts=1), transport=_transport(_resp(1, 5, "XYZUSDT")))
    ev = contract_leverage_evidence(c, "XYZUSDT")
    assert ev["requested_range_supported"] is False and ev["status"] == "VERIFIED_OUTSIDE_CONTRACT_RANGE"


def test_bitget_contract_evidence_errors_do_not_fake_support():
    c = PublicHttpClient(RetryPolicy(max_attempts=1), transport=_transport({"code": "40001", "msg": "bad"}))
    with pytest.raises(RuntimeError):
        contract_leverage_evidence(c)
    c2 = PublicHttpClient(RetryPolicy(max_attempts=1), transport=_transport({}, status=403), sleep=lambda s: None)
    with pytest.raises(HttpStatusError):
        contract_leverage_evidence(c2)


@pytest.mark.parametrize("url", [
    "https://api.bitget.com/api/v2/mix/account/set-leverage",
    "https://api.bitget.com/api/v2/mix/order/place-order",
    "https://api.bitget.com/api/v2/mix/account/account",
])
def test_bitget_write_and_account_paths_forbidden(url):
    with pytest.raises(Exception):
        check_request_allowed("POST", url, None, {"symbol": "BTCUSDT", "leverage": "10"})
    with pytest.raises(Exception):
        check_request_allowed("GET", url)

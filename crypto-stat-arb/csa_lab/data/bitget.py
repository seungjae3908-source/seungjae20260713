"""비트겟 USDT-M 선물 공개 계약 정보(조회 전용, 서명 없음).

GET https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=BTCUSDT
응답의 minLever·maxLever 가 그 계약에서 허용되는 레버리지 범위다. 계정별 한도(VIP·포지션 구간)는
서명이 필요한 경로라 여기서는 조회하지 않는다. 운영 앱의 bitget-futures-public-evidence.service.ts 도
같은 필드를 읽는다.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..http import PublicHttpClient
from ..leverage import MAX_LEVERAGE, MIN_LEVERAGE, register_verified_limit

CONTRACTS_URL = "https://api.bitget.com/api/v2/mix/market/contracts"
PRODUCT_TYPE = "USDT-FUTURES"


def contract_leverage_evidence(client: PublicHttpClient, symbol: str = "BTCUSDT") -> dict:
    """계약의 minLever/maxLever 를 읽어 1~10 지원 여부를 판정한다. 실패하면 예외."""
    data = client.get_json(CONTRACTS_URL, {"productType": PRODUCT_TYPE, "symbol": symbol})
    if str(data.get("code")) != "00000":
        raise RuntimeError(f"bitget contracts 응답 코드 {data.get('code')}: {data.get('msg')}")
    rows = [r for r in data.get("data", []) if r.get("symbol") == symbol]
    if not rows:
        raise RuntimeError(f"bitget contracts 에 {symbol} 없음")
    c = rows[0]
    min_lev, max_lev = int(float(c["minLever"])), int(float(c["maxLever"]))
    if min_lev < 1 or max_lev < min_lev:
        raise RuntimeError(f"bitget 레버리지 범위가 이상함: {min_lev}~{max_lev}")
    lim = register_verified_limit("bitget", f"{symbol}-USDT-FUTURES", max_lev,
                                  f"{CONTRACTS_URL} maxLever (productType={PRODUCT_TYPE})")
    supported = min_lev <= MIN_LEVERAGE and MAX_LEVERAGE <= max_lev
    return {
        "venue": "bitget", "symbol": symbol, "product_type": PRODUCT_TYPE, "source_url": CONTRACTS_URL,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "min_lever": min_lev, "max_lever": max_lev,
        "maintain_time": c.get("maintainTime"), "symbol_status": c.get("symbolStatus"),
        "requested_range": [MIN_LEVERAGE, MAX_LEVERAGE],
        "requested_range_supported": supported,
        "status": "VERIFIED_WITHIN_CONTRACT_RANGE" if supported else "VERIFIED_OUTSIDE_CONTRACT_RANGE",
        "scope_note": "계약 단위 공개 한도. 계정별(VIP·포지션 구간) 한도는 서명 필요 경로라 미확인",
        "registered": {"venue": lim.venue, "instrument": lim.instrument, "max_leverage": lim.max_leverage},
    }

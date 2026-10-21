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


# ---- 공개 시세 이력(조회 전용): 1시간봉, 마크가격 1시간봉, 펀딩 정산 이력 ----
# GET /api/v2/mix/market/history-candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H
#     &startTime=<ms>&endTime=<ms>&limit=200   → data: [[ts, open, high, low, close, baseVol, quoteVol], ...]
# GET /api/v2/mix/market/history-mark-candles (같은 인자)
# GET /api/v2/mix/market/history-fund-rate?symbol=BTCUSDT&productType=USDT-FUTURES&pageSize=100&pageNo=N
#     → data: [{symbol, fundingRate, fundingTime}, ...] (최신부터; 정산 시각 필드명은 fundingTime, 일부 문서·버전은 settleTime)
# 봉 요청: CI 11차 실측에서 endTime=구간끝-1ms 로 보내면 각 창의 마지막 1시간봉이 빠졌다(200시간마다 1개 결측).
# 그래서 창을 199시간으로 자르고 endTime=구간 끝(포함 여부와 무관)으로 보낸 뒤 [lo, hi) 로 다시 거른다.
import io
from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd

from ..storage import Checkpoint, atomic_write_bytes, sha256_file
from .binance import months

HISTORY_CANDLES_URL = "https://api.bitget.com/api/v2/mix/market/history-candles"
HISTORY_MARK_CANDLES_URL = "https://api.bitget.com/api/v2/mix/market/history-mark-candles"
HISTORY_FUNDING_URL = "https://api.bitget.com/api/v2/mix/market/history-fund-rate"
HOUR_MS = 3_600_000
CANDLE_LIMIT = 200
FUNDING_PAGE_SIZE = 100
EMPTY_CANDLES = pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])


def _ok(data: dict, what: str) -> list:
    if not isinstance(data, dict) or str(data.get("code")) != "00000":
        code = data.get("code") if isinstance(data, dict) else type(data).__name__
        msg = data.get("msg") if isinstance(data, dict) else ""
        raise RuntimeError(f"bitget {what} 응답 코드 {code}: {msg}")
    rows = data.get("data") or []
    if not isinstance(rows, list):
        raise RuntimeError(f"bitget {what} data 형식이 목록이 아님")
    return rows


def parse_candles(rows: list) -> pd.DataFrame:
    if not rows:
        return EMPTY_CANDLES.copy()
    out = pd.DataFrame({
        "ts": [int(r[0]) for r in rows],
        "open": [float(r[1]) for r in rows], "high": [float(r[2]) for r in rows],
        "low": [float(r[3]) for r in rows], "close": [float(r[4]) for r in rows],
        "volume": [float(r[5]) if len(r) > 5 else 0.0 for r in rows],
    })
    return out.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)


def fetch_hour_candles(client: PublicHttpClient, symbol: str, start_ms: int, end_ms: int,
                       *, mark: bool = False) -> pd.DataFrame:
    """[start_ms, end_ms) 1시간봉. 200시간 창으로 잘라 순서대로 받는다."""
    url = HISTORY_MARK_CANDLES_URL if mark else HISTORY_CANDLES_URL
    frames = []
    lo = start_ms
    while lo < end_ms:
        hi = min(lo + (CANDLE_LIMIT - 1) * HOUR_MS, end_ms)
        data = client.get_json(url, {"symbol": symbol, "productType": PRODUCT_TYPE, "granularity": "1H",
                                     "startTime": lo, "endTime": hi, "limit": CANDLE_LIMIT})
        rows = _ok(data, "history-mark-candles" if mark else "history-candles")
        df = parse_candles(rows)
        df = df[(df["ts"] >= lo) & (df["ts"] < hi)]
        if not df.empty:
            frames.append(df)
        lo = hi
    if not frames:
        return EMPTY_CANDLES.copy()
    return pd.concat(frames, ignore_index=True).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)


def fetch_candles_month(client: PublicHttpClient, symbol: str, month: str, out_dir: Path, ckpt: Checkpoint,
                        *, mark: bool = False, now_ms: Optional[int] = None) -> Optional[Path]:
    kind = "bitgetMarkKlines" if mark else "bitgetKlines"
    key = f"{kind}:{symbol}:1h:{month}"
    target = Path(out_dir) / kind / symbol / f"{symbol}-{kind}-1h-{month}.parquet"
    if ckpt.is_done(key, target):
        return target
    a = pd.Timestamp(month + "-01", tz="UTC")
    b = a + pd.offsets.MonthBegin(1)
    a_ms, b_ms = int(a.value // 10**6), int(b.value // 10**6)
    now = now_ms if now_ms is not None else int(datetime.now(timezone.utc).timestamp() * 1000)
    df = fetch_hour_candles(client, symbol, a_ms, min(b_ms, now - now % HOUR_MS), mark=mark)
    if df.empty:
        return None
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    atomic_write_bytes(target, buf.getvalue())
    if b_ms <= now:
        ckpt.mark_done(key, sha256=sha256_file(target), source_url=HISTORY_MARK_CANDLES_URL if mark else HISTORY_CANDLES_URL,
                       rows=len(df), symbol=symbol)
    return target


def fetch_candles_range(client: PublicHttpClient, symbol: str, start: date, end: date, out_dir: Path, ckpt: Checkpoint,
                        *, mark: bool = False, now_ms: Optional[int] = None) -> dict:
    got, missing = [], []
    for m in months(start, end):
        p = fetch_candles_month(client, symbol, m, out_dir, ckpt, mark=mark, now_ms=now_ms)
        (got if p else missing).append(m)
    return {"kind": "bitgetMarkKlines" if mark else "bitgetKlines", "symbol": symbol,
            "months_ok": got, "months_missing": missing}


def _funding_ts(row: dict) -> int:
    for k in ("fundingTime", "settleTime"):
        if row.get(k) not in (None, ""):
            return int(row[k])
    raise RuntimeError(f"bitget history-fund-rate 응답에 정산 시각 필드가 없음: keys={sorted(row)}")


def funding_history(client: PublicHttpClient, symbol: str, start_ms: int, end_ms: int,
                    *, max_pages: int = 500) -> pd.DataFrame:
    """정산 이력을 최신 페이지부터 start_ms 이전까지 거슬러 받는다. 간격(interval_hours)은 인접 정산 시각 차로 기록."""
    rows = []
    page = 1
    last_min: Optional[int] = None
    while page <= max_pages:
        data = client.get_json(HISTORY_FUNDING_URL, {"symbol": symbol, "productType": PRODUCT_TYPE,
                                                     "pageSize": FUNDING_PAGE_SIZE, "pageNo": page})
        batch = _ok(data, "history-fund-rate")
        if not batch:
            break
        ts = [_funding_ts(r) for r in batch]
        rows.extend({"ts": t, "rate": float(r["fundingRate"])} for t, r in zip(ts, batch))
        mn = min(ts)
        if last_min is not None and mn >= last_min:
            break  # 페이지가 더 과거로 가지 않음
        last_min = mn
        if mn < start_ms:
            break
        page += 1
    if not rows:
        return pd.DataFrame(columns=["ts", "rate", "interval_hours"])
    df = pd.DataFrame(rows).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    df = df[(df["ts"] >= start_ms) & (df["ts"] < end_ms)].reset_index(drop=True)
    if df.empty:
        return pd.DataFrame(columns=["ts", "rate", "interval_hours"])
    gaps = df["ts"].diff().div(HOUR_MS)
    df["interval_hours"] = gaps.fillna(gaps.median() if gaps.notna().any() else 8).round().astype(int).clip(lower=1)
    return df

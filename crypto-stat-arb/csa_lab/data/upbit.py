"""업비트 KRW 시장 1시간봉 수집(조회 전용, 서명 없음).

GET https://api.upbit.com/v1/candles/minutes/60?market=KRW-BTC&to=<UTC ISO>&count=200
- 응답은 최신 봉부터 내림차순, 한 번에 최대 200개. `to` 는 상한 시각(그 이전 봉). 상한 포함 여부에 따라
  한 봉이 겹칠 수 있어 봉 시각(candle_date_time_utc)으로 중복을 제거한다.
- 월 단위로 받아 parquet 으로 저장하고 체크포인트에 기록한다. 아직 끝나지 않은 달은 완료로 기록하지 않는다.
- 거래가 없는 시간은 원천에 봉이 없다(만들지 않음). 품질 검사가 결측으로 집계한다.
"""
from __future__ import annotations

import io
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from ..http import PublicHttpClient
from ..storage import Checkpoint, atomic_write_bytes, sha256_file
from .binance import months

CANDLES_URL = "https://api.upbit.com/v1/candles/minutes/60"
HOUR_MS = 3_600_000
MAX_COUNT = 200
EMPTY = pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])


def _ms(t: pd.Timestamp) -> int:
    return int(t.value // 10**6)


def _iso_z(ms: int) -> str:
    return pd.Timestamp(ms, unit="ms", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_candles(rows: list) -> pd.DataFrame:
    """업비트 분봉 응답 → ts(봉 시작 UTC ms)·OHLCV. 필드가 빠지거나 숫자가 아니면 예외."""
    if not rows:
        return EMPTY.copy()
    out = pd.DataFrame({
        "ts": [_ms(pd.Timestamp(r["candle_date_time_utc"], tz="UTC")) for r in rows],
        "open": [float(r["opening_price"]) for r in rows],
        "high": [float(r["high_price"]) for r in rows],
        "low": [float(r["low_price"]) for r in rows],
        "close": [float(r["trade_price"]) for r in rows],
        "volume": [float(r.get("candle_acc_trade_volume", 0.0)) for r in rows],
    })
    return out.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)


def fetch_hour_candles(client: PublicHttpClient, market: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    """[start_ms, end_ms) 구간의 1시간봉. 상한에서 과거로 200개씩 내려가며 받는다."""
    frames = []
    to_ms = end_ms
    seen_floor: Optional[int] = None
    while to_ms > start_ms:
        rows = client.get_json(CANDLES_URL, {"market": market, "to": _iso_z(to_ms), "count": MAX_COUNT})
        if not rows:
            break
        df = parse_candles(rows)
        df = df[(df["ts"] >= start_ms) & (df["ts"] < end_ms)]
        floor = int(parse_candles(rows)["ts"].iloc[0])
        if not df.empty:
            frames.append(df)
        if seen_floor is not None and floor >= seen_floor:
            break  # 더 과거로 내려가지 않음(무한 반복 방지)
        seen_floor = floor
        if floor <= start_ms:
            break
        to_ms = floor  # 가장 오래된 봉 시각을 다음 상한으로(겹치는 한 봉은 중복 제거)
    if not frames:
        return EMPTY.copy()
    out = pd.concat(frames, ignore_index=True).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    return out


def fetch_month(client: PublicHttpClient, market: str, month: str, out_dir: Path, ckpt: Checkpoint,
                *, now_ms: Optional[int] = None) -> Optional[Path]:
    """한 달치 1시간봉을 parquet 으로 저장. 봉이 하나도 없는 달은 None. 끝나지 않은 달은 체크포인트에 안 남김."""
    kind = "upbitKlines"
    key = f"{kind}:{market}:1h:{month}"
    target = Path(out_dir) / kind / market / f"{market}-{kind}-1h-{month}.parquet"
    if ckpt.is_done(key, target):
        return target
    a = pd.Timestamp(month + "-01", tz="UTC")
    b = a + pd.offsets.MonthBegin(1)
    now = now_ms if now_ms is not None else int(datetime.now(timezone.utc).timestamp() * 1000)
    df = fetch_hour_candles(client, market, _ms(a), min(_ms(b), now - now % HOUR_MS))
    if df.empty:
        return None
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    atomic_write_bytes(target, buf.getvalue())
    if _ms(b) <= now:
        ckpt.mark_done(key, sha256=sha256_file(target), source_url=CANDLES_URL, rows=len(df), market=market)
    return target


def fetch_range(client: PublicHttpClient, market: str, start: date, end: date, out_dir: Path, ckpt: Checkpoint,
                *, now_ms: Optional[int] = None) -> dict:
    got, missing = [], []
    for m in months(start, end):
        p = fetch_month(client, market, m, out_dir, ckpt, now_ms=now_ms)
        (got if p else missing).append(m)
    return {"kind": "upbitKlines", "symbol": market, "months_ok": got, "months_missing": missing}

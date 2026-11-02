"""Binance USDT-M 공개 데이터 수집 (data.binance.vision 월별 파일 + fapi 공개 REST).

월별 zip 은 거래소가 함께 올리는 .CHECKSUM(sha256)으로 검증한 뒤 원자적으로 저장한다.
완료한 월은 체크포인트에 해시와 함께 기록하므로 중단 후 다시 실행하면 이어서 받는다.
"""
from __future__ import annotations

import io
import zipfile
from datetime import date
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from ..http import HttpStatusError, PublicHttpClient
from ..storage import Checkpoint, atomic_write_bytes, sha256_bytes, sha256_file

VISION = "https://data.binance.vision/data/futures/um/monthly"
VISION_SPOT = "https://data.binance.vision/data/spot/monthly"
FAPI = "https://fapi.binance.com"

KLINE_COLS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume",
              "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]


class ChecksumMismatch(RuntimeError):
    pass


def months(start: date, end: date) -> list[str]:
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def vision_url(kind: str, symbol: str, month: str, interval: str = "1h") -> str:
    if kind == "klines":
        return f"{VISION}/klines/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"
    if kind == "spotKlines":
        return f"{VISION_SPOT}/klines/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"
    if kind == "markPriceKlines":
        return f"{VISION}/markPriceKlines/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"
    if kind == "fundingRate":
        return f"{VISION}/fundingRate/{symbol}/{symbol}-fundingRate-{month}.zip"
    raise ValueError(kind)


def parse_checksum(text: str) -> str:
    token = text.strip().split()[0] if text.strip() else ""
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token.lower()):
        raise ChecksumMismatch(f"체크섬 파일 형식 오류: {text[:80]!r}")
    return token.lower()


def _read_zip_csv(blob: bytes) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        names = [n for n in zf.namelist() if n.endswith(".csv")]
        if len(names) != 1:
            raise ValueError(f"zip 안 CSV 개수가 1이 아님: {names}")
        raw = zf.read(names[0])
    first = raw.split(b"\n", 1)[0]
    has_header = not first.split(b",", 1)[0].strip().isdigit()
    return pd.read_csv(io.BytesIO(raw), header=0 if has_header else None)


def parse_klines(blob: bytes) -> pd.DataFrame:
    df = _read_zip_csv(blob)
    if list(df.columns[:1]) != ["open_time"]:
        df.columns = KLINE_COLS[: len(df.columns)]
    out = pd.DataFrame({
        "ts": df["open_time"].astype("int64"),
        "open": df["open"].astype(float), "high": df["high"].astype(float),
        "low": df["low"].astype(float), "close": df["close"].astype(float),
        "volume": df["volume"].astype(float),
    })
    return out


def parse_funding(blob: bytes) -> pd.DataFrame:
    df = _read_zip_csv(blob)
    if "calc_time" not in df.columns:
        df.columns = ["calc_time", "funding_interval_hours", "last_funding_rate"][: len(df.columns)]
    return pd.DataFrame({
        "ts": df["calc_time"].astype("int64"),
        "rate": df["last_funding_rate"].astype(float),
        "interval_hours": df.get("funding_interval_hours", pd.Series([8] * len(df))).astype(int),
    })


def fetch_month(client: PublicHttpClient, kind: str, symbol: str, month: str, out_dir: Path,
                ckpt: Checkpoint, interval: str = "1h") -> Optional[Path]:
    """한 달치 zip 을 받아 체크섬 검증 후 parquet 으로 원자 저장. 파일이 없는 달(404)은 None."""
    key = f"{kind}:{symbol}:{interval}:{month}"
    target = Path(out_dir) / kind / symbol / f"{symbol}-{kind}-{interval}-{month}.parquet"
    if ckpt.is_done(key, target):
        return target
    url = vision_url(kind, symbol, month, interval)
    try:
        expected = parse_checksum(client.get_bytes(url + ".CHECKSUM").decode())
    except HttpStatusError as e:
        if e.status == 404:
            return None
        raise
    blob = client.get_bytes(url)
    got = sha256_bytes(blob)
    if got != expected:
        raise ChecksumMismatch(f"{url}: sha256 {got} != {expected}")
    df = parse_funding(blob) if kind == "fundingRate" else parse_klines(blob)
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    atomic_write_bytes(target, buf.getvalue())
    ckpt.mark_done(key, sha256=sha256_file(target), source_url=url, source_sha256=expected, rows=len(df))
    return target


def fetch_range(client: PublicHttpClient, kind: str, symbol: str, start: date, end: date, out_dir: Path,
                ckpt: Checkpoint, interval: str = "1h") -> dict:
    got, missing = [], []
    for m in months(start, end):
        p = fetch_month(client, kind, symbol, m, out_dir, ckpt, interval)
        (got if p else missing).append(m)
    return {"kind": kind, "symbol": symbol, "months_ok": got, "months_missing": missing}


def load_parquets(paths: Iterable[Path]) -> pd.DataFrame:
    frames = [pd.read_parquet(p) for p in paths]
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


# ---- 최근 구간(월별 파일이 아직 없는 기간) : fapi 공개 REST ----

def fetch_recent_klines(client: PublicHttpClient, symbol: str, start_ms: int, end_ms: int,
                        interval: str = "1h") -> pd.DataFrame:
    rows, cur = [], start_ms
    while cur < end_ms:
        batch = client.get_json(f"{FAPI}/fapi/v1/klines", {"symbol": symbol, "interval": interval,
                                                            "startTime": cur, "endTime": end_ms, "limit": 1500})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1][0]) + 1
        if nxt <= cur:
            break
        cur = nxt
    if not rows:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])
    df = pd.DataFrame(rows).iloc[:, :6]
    df.columns = ["ts", "open", "high", "low", "close", "volume"]
    df = df.astype({"ts": "int64", "open": float, "high": float, "low": float, "close": float, "volume": float})
    # 아직 닫히지 않은 봉 제외 (open_time + 1h > end_ms)
    return df[df["ts"] + 3_600_000 <= end_ms].reset_index(drop=True)


def fetch_recent_funding(client: PublicHttpClient, symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    rows, cur = [], start_ms
    while cur < end_ms:
        batch = client.get_json(f"{FAPI}/fapi/v1/fundingRate", {"symbol": symbol, "startTime": cur,
                                                                "endTime": end_ms, "limit": 1000})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1]["fundingTime"]) + 1
        if nxt <= cur:
            break
        cur = nxt
    if not rows:
        return pd.DataFrame(columns=["ts", "rate"])
    return pd.DataFrame({"ts": [int(r["fundingTime"]) for r in rows],
                         "rate": [float(r["fundingRate"]) for r in rows]})

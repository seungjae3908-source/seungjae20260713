"""Hyperliquid 공개 info API (조회 전용): 펀딩 이력, 1시간봉, 레버리지 한도."""
from __future__ import annotations

import pandas as pd

from ..http import PublicHttpClient
from ..leverage import register_verified_limit


def funding_history(client: PublicHttpClient, coin: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    rows, cur = [], start_ms
    while cur < end_ms:
        batch = client.post_info({"type": "fundingHistory", "coin": coin, "startTime": cur, "endTime": end_ms})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1]["time"]) + 1
        if nxt <= cur or len(batch) < 2:
            break
        cur = nxt
    if not rows:
        return pd.DataFrame(columns=["ts", "rate"])
    return pd.DataFrame({"ts": [int(r["time"]) for r in rows], "rate": [float(r["fundingRate"]) for r in rows]})


def candles(client: PublicHttpClient, coin: str, start_ms: int, end_ms: int, interval: str = "1h") -> pd.DataFrame:
    rows, cur = [], start_ms
    while cur < end_ms:
        batch = client.post_info({"type": "candleSnapshot",
                                  "req": {"coin": coin, "interval": interval, "startTime": cur, "endTime": end_ms}})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1]["t"]) + 1
        if nxt <= cur or len(batch) < 2:
            break
        cur = nxt
    if not rows:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])
    return pd.DataFrame({"ts": [int(r["t"]) for r in rows], "open": [float(r["o"]) for r in rows],
                         "high": [float(r["h"]) for r in rows], "low": [float(r["l"]) for r in rows],
                         "close": [float(r["c"]) for r in rows], "volume": [float(r["v"]) for r in rows]})


def register_max_leverage(client: PublicHttpClient, coin: str = "BTC") -> dict:
    meta = client.post_info({"type": "meta"})
    for asset in meta.get("universe", []):
        if asset.get("name") == coin:
            lim = register_verified_limit("hyperliquid", f"{coin}-PERP", int(asset["maxLeverage"]),
                                          "Hyperliquid info meta.universe.maxLeverage")
            return {"venue": lim.venue, "instrument": lim.instrument, "max_leverage": lim.max_leverage}
    return {"venue": "hyperliquid", "instrument": f"{coin}-PERP", "max_leverage": None}

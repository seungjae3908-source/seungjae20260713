"""원화 환율 수집. 출처: 업비트 KRW-USDT 일봉 종가(실제 원화→USDT 환전 경로), 프랑크푸르터(ECB 기준 USD/KRW).

환율이 없으면 None 을 돌려주고, 호출자는 KRW 기준 실행을 중단해야 한다(money.require_fx).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import pandas as pd

from ..http import PublicHttpClient
from ..money import FxQuote


def upbit_usdt_daily(client: PublicHttpClient, end: datetime, count: int = 200) -> pd.DataFrame:
    rows = client.get_json("https://api.upbit.com/v1/candles/days",
                           {"market": "KRW-USDT", "count": count, "to": end.strftime("%Y-%m-%dT%H:%M:%SZ")})
    if not rows:
        return pd.DataFrame(columns=["date", "krw_per_unit"])
    df = pd.DataFrame({"date": [r["candle_date_time_utc"][:10] for r in rows],
                       "krw_per_unit": [float(r["trade_price"]) for r in rows]})
    return df.sort_values("date").reset_index(drop=True)


def upbit_usdt_latest(client: PublicHttpClient) -> Optional[FxQuote]:
    rows = client.get_json("https://api.upbit.com/v1/ticker", {"markets": "KRW-USDT"})
    if not rows:
        return None
    r = rows[0]
    ts = datetime.fromtimestamp(int(r["trade_timestamp"]) / 1000, tz=timezone.utc)
    return FxQuote(float(r["trade_price"]), "USDT", "upbit:KRW-USDT ticker", ts)


def frankfurter_usd_krw(client: PublicHttpClient, start: str, end: str) -> pd.DataFrame:
    data = client.get_json(f"https://api.frankfurter.app/{start}..{end}", {"from": "USD", "to": "KRW"})
    rates = data.get("rates", {})
    df = pd.DataFrame({"date": list(rates.keys()), "krw_per_unit": [float(v["KRW"]) for v in rates.values()]})
    return df.sort_values("date").reset_index(drop=True)


def quote_for_date(df: pd.DataFrame, day: str, unit: str, source: str, max_lag_days: int = 4) -> Optional[FxQuote]:
    """day 당일 또는 그 이전 가장 가까운 값(미래 환율 사용 금지). max_lag_days 초과면 None."""
    if df is None or df.empty:
        return None
    prior = df[df["date"] <= day]
    if prior.empty:
        return None
    row = prior.iloc[-1]
    lag = (pd.Timestamp(day) - pd.Timestamp(row["date"])).days
    if lag > max_lag_days:
        return None
    as_of = pd.Timestamp(row["date"]).tz_localize("UTC").to_pydatetime()
    return FxQuote(float(row["krw_per_unit"]), unit, f"{source} {row['date']}", as_of)

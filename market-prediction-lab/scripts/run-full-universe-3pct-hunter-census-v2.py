#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import time
import tempfile
from io import StringIO
from pathlib import Path

import requests

import duckdb
import pandas as pd
import polars as pl
from huggingface_hub import hf_hub_download, snapshot_download

START = pd.Timestamp("2023-04-01", tz="UTC")
END_EXCLUSIVE = pd.Timestamp("2026-04-01", tz="UTC")
THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]

US_DATASET = "mito0o852/OHLCV-1m"
KR_SNAPSHOT_DATE = "2026-03-31"
KR_CACHE_BASE = "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/master/data/listing"
KR_LISTING_SNAPSHOT_URL = f"{KR_CACHE_BASE}/krx/{KR_SNAPSHOT_DATE}.csv"
KR_DELISTING_SNAPSHOT_URL = f"{KR_CACHE_BASE}/delisting/{KR_SNAPSHOT_DATE}.csv"
KR_NAVER_DAILY_URL = "https://fchart.stock.naver.com/sise.nhn?timeframe=day&count=6000&requestType=0&symbol="
CRYPTO_DATASET = "rogerdehe/klines-binance"


def snapshot_download_retry(**kwargs):
    last = None
    for attempt in range(12):
        try:
            return snapshot_download(max_workers=2, **kwargs)
        except Exception as exc:
            last = exc
            text = str(exc)
            if "429" not in text and "Too Many Requests" not in text:
                raise
            wait = min(45 + attempt * 20, 180)
            print(json.dumps({"hfRateLimited": True, "attempt": attempt + 1, "waitSeconds": wait, "error": text[:240]}), flush=True)
            time.sleep(wait)
    raise RuntimeError(f"HF_SNAPSHOT_RETRY_EXHAUSTED:{last}")

def safe_symbol_from_file(path: str, market: str) -> str:
    stem = Path(path).stem.upper()
    if market == "CRYPTO_SPOT":
        return stem.replace("_USDT", "USDT")
    if market == "CRYPTO_FUTURES":
        return stem.replace("_USDT_USDT", "USDT")
    return stem

def _month_iter(start: pd.Timestamp, end_exclusive: pd.Timestamp):
    cursor = pd.Timestamp(start.year, start.month, 1, tz="UTC")
    last = pd.Timestamp((end_exclusive - pd.Timedelta(days=1)).year, (end_exclusive - pd.Timedelta(days=1)).month, 1, tz="UTC")
    while cursor <= last:
        yield cursor
        cursor = cursor + pd.offsets.MonthBegin(1)


def _download_us_month(month: pd.Timestamp, destination: Path) -> None:
    url = f"https://huggingface.co/datasets/{US_DATASET}/resolve/main/data/ohlcv_{month.strftime('%Y-%m')}.parquet"
    headers = {"user-agent": "market-prediction-lab/full-universe-3pct-hunter-v3"}
    last = None
    for attempt in range(10):
        try:
            with requests.get(url, headers=headers, stream=True, timeout=180, allow_redirects=True) as response:
                if response.status_code in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"HTTP_{response.status_code}")
                response.raise_for_status()
                with destination.open("wb") as out:
                    for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                        if chunk:
                            out.write(chunk)
                if destination.stat().st_size < 100_000:
                    raise RuntimeError(f"US_MONTH_TOO_SMALL:{destination.stat().st_size}")
                return
        except Exception as exc:
            last = exc
            wait = min(5 + attempt * 10, 60)
            print(json.dumps({"usMonthRetry": month.strftime("%Y-%m"), "attempt": attempt + 1, "waitSeconds": wait, "error": str(exc)[:180]}), flush=True)
            time.sleep(wait)
    raise RuntimeError(f"US_MONTH_DOWNLOAD_FAILED:{month.strftime('%Y-%m')}:{last}")


def load_us() -> tuple[pl.DataFrame, dict]:
    frames = []
    audits = []
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        for idx, month in enumerate(_month_iter(START, END_EXCLUSIVE), 1):
            path = td_path / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            _download_us_month(month, path)
            con = duckdb.connect()
            query = f"""
              WITH bars AS (
                SELECT
                  upper(ticker) AS symbol,
                  timezone('America/New_York', timestamp) AS local_ts,
                  CAST(open AS DOUBLE) AS open,
                  CAST(high AS DOUBLE) AS high,
                  CAST(low AS DOUBLE) AS low,
                  CAST(close AS DOUBLE) AS close,
                  CAST(volume AS DOUBLE) AS volume
                FROM read_parquet('{path.as_posix()}')
              ),
              regular AS (
                SELECT *, CAST(local_ts AS DATE) AS date, CAST(local_ts AS TIME) AS local_time
                FROM bars
                WHERE CAST(local_ts AS TIME) >= TIME '09:30:00'
                  AND CAST(local_ts AS TIME) < TIME '16:00:00'
                  AND regexp_matches(symbol, '^[A-Z][A-Z0-9.\\-]{{0,9}}$')
              )
              SELECT
                symbol,
                date,
                arg_min(open, local_ts) AS open,
                max(high) AS high,
                min(low) AS low,
                arg_max(close, local_ts) AS close,
                sum(volume) AS volume
              FROM regular
              GROUP BY symbol, date
            """
            frame = pl.from_arrow(con.execute(query).fetch_arrow_table())
            con.close()
            if frame.height:
                frames.append(frame)
            audits.append({"month": month.strftime("%Y-%m"), "rows": frame.height, "symbols": frame.select("symbol").unique().height if frame.height else 0})
            print(json.dumps({"usMonthDone": month.strftime("%Y-%m"), "rows": frame.height, "symbols": audits[-1]["symbols"], "monthIndex": idx}), flush=True)
    if len(frames) < 34:
        raise RuntimeError(f"US_MONTH_COVERAGE_TOO_LOW:{len(frames)}")
    return pl.concat(frames, how="vertical"), {
        "provider": US_DATASET,
        "coverageMode": "PUBLIC_1MIN_MONTHLY_PARQUET_AGGREGATED_TO_REGULAR_SESSION_DAILY",
        "months": audits,
        "monthCount": len(frames),
    }

def _kr_market_bucket(value: str) -> str:
    market = str(value or "").upper()
    if market.startswith("KOSPI"):
        return "KOSPI"
    if market.startswith("KOSDAQ"):
        return "KOSDAQ"
    if market.startswith("KONEX"):
        return "KONEX"
    return "OTHER"


def _download_kr_snapshot(url: str) -> pd.DataFrame:
    last = None
    for attempt in range(5):
        try:
            response = requests.get(
                url,
                timeout=45,
                headers={"User-Agent": "market-prediction-lab/full-universe-3pct-hunter-kr-v3"},
            )
            if response.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP_{response.status_code}")
            response.raise_for_status()
            text = response.content.decode("utf-8-sig")
            if len(text) < 1000:
                raise RuntimeError(f"KR_SNAPSHOT_TOO_SMALL:{len(text)}")
            return pd.read_csv(StringIO(text), dtype=str)
        except Exception as exc:
            last = exc
            time.sleep(min(2 + attempt * 3, 12))
    raise RuntimeError(f"KR_SNAPSHOT_DOWNLOAD_FAILED:{url}:{last}")


def _build_kr_frozen_universe() -> tuple[list[str], set[str], dict[str, str], dict]:
    current = _download_kr_snapshot(KR_LISTING_SNAPSHOT_URL)
    delisted = _download_kr_snapshot(KR_DELISTING_SNAPSHOT_URL)

    if "Code" not in current.columns or "Market" not in current.columns:
        raise RuntimeError(f"KR_CURRENT_SNAPSHOT_SCHEMA:{list(current.columns)}")
    if not {"Symbol", "Market", "ListingDate", "DelistingDate"}.issubset(delisted.columns):
        raise RuntimeError(f"KR_DELISTING_SNAPSHOT_SCHEMA:{list(delisted.columns)}")

    current = current.copy()
    current["Code"] = current["Code"].fillna("").astype(str).str.upper().str.zfill(6)
    current["bucket"] = current["Market"].map(_kr_market_bucket)
    current = current[
        current["Code"].str.match(r"^[0-9A-Z]{6}$", na=False)
        & current["bucket"].isin(["KOSPI", "KOSDAQ", "KONEX"])
    ].drop_duplicates("Code", keep="last")

    delisted = delisted.copy()
    delisted["Symbol"] = delisted["Symbol"].fillna("").astype(str).str.upper().str.zfill(6)
    delisted["bucket"] = delisted["Market"].map(_kr_market_bucket)
    delisted["ListingDate"] = delisted["ListingDate"].fillna("")
    delisted["DelistingDate"] = delisted["DelistingDate"].fillna("")
    delisted = delisted[
        delisted["Symbol"].str.match(r"^[0-9A-Z]{6}$", na=False)
        & delisted["bucket"].isin(["KOSPI", "KOSDAQ", "KONEX"])
        & (delisted["DelistingDate"] >= str(START.date()))
        & (delisted["DelistingDate"] < str(END_EXCLUSIVE.date()))
        & ((delisted["ListingDate"] == "") | (delisted["ListingDate"] < str(END_EXCLUSIVE.date())))
    ].drop_duplicates("Symbol", keep="last")

    current_symbols = set(current["Code"].tolist())
    delisted_symbols = set(delisted["Symbol"].tolist())
    overlap = current_symbols & delisted_symbols
    if overlap:
        raise RuntimeError(f"KR_FROZEN_UNIVERSE_OVERLAP:{sorted(overlap)[:20]}")

    market_by_symbol = {
        str(row.Code): str(row.bucket)
        for row in current[["Code", "bucket"]].itertuples(index=False)
    }
    market_by_symbol.update({
        str(row.Symbol): str(row.bucket)
        for row in delisted[["Symbol", "bucket"]].itertuples(index=False)
    })

    current_counts = current["bucket"].value_counts().to_dict()
    delisted_counts = delisted["bucket"].value_counts().to_dict()
    universe = sorted(current_symbols | delisted_symbols)

    if len(current_symbols) < 2800:
        raise RuntimeError(f"KR_CURRENT_UNIVERSE_TOO_SMALL:{len(current_symbols)}")
    if int(current_counts.get("KOSPI", 0)) < 900:
        raise RuntimeError(f"KR_KOSPI_CURRENT_TOO_SMALL:{current_counts}")
    if int(current_counts.get("KOSDAQ", 0)) < 1700:
        raise RuntimeError(f"KR_KOSDAQ_CURRENT_TOO_SMALL:{current_counts}")
    if int(current_counts.get("KONEX", 0)) < 80:
        raise RuntimeError(f"KR_KONEX_CURRENT_TOO_SMALL:{current_counts}")
    if len(delisted_symbols) < 180:
        raise RuntimeError(f"KR_DELISTED_PERIOD_TOO_SMALL:{len(delisted_symbols)}")
    if len(universe) < 3000:
        raise RuntimeError(f"KR_FROZEN_UNIVERSE_TOO_SMALL:{len(universe)}")

    meta = {
        "snapshotDate": KR_SNAPSHOT_DATE,
        "listingSnapshotUrl": KR_LISTING_SNAPSHOT_URL,
        "delistingSnapshotUrl": KR_DELISTING_SNAPSHOT_URL,
        "currentSnapshotSymbols": len(current_symbols),
        "delistedDuringPeriodSymbols": len(delisted_symbols),
        "universeSymbols": len(universe),
        "currentMarketCounts": {str(k): int(v) for k, v in current_counts.items()},
        "delistedMarketCounts": {str(k): int(v) for k, v in delisted_counts.items()},
        "overlapSymbols": 0,
    }
    return universe, delisted_symbols, market_by_symbol, meta


def _kr_rows_from_pandas(symbol: str, frame: pd.DataFrame) -> list[tuple]:
    if frame is None or frame.empty:
        return []
    x = frame.copy()
    if "Date" in x.columns:
        x["date"] = pd.to_datetime(x["Date"], errors="coerce").dt.date
    else:
        x["date"] = pd.to_datetime(x.index, errors="coerce").date

    rename = {}
    for col in x.columns:
        low = str(col).lower()
        if low in {"open", "high", "low", "close", "volume"}:
            rename[col] = low
    x = x.rename(columns=rename)
    required = ["open", "high", "low", "close", "volume"]
    if not all(col in x.columns for col in required):
        return []

    for col in required:
        x[col] = pd.to_numeric(x[col], errors="coerce")
    x = x.dropna(subset=["date", *required])
    x = x[
        (x["date"] >= START.date())
        & (x["date"] < END_EXCLUSIVE.date())
        & (x["open"] > 0)
        & (x["high"] > 0)
        & (x["low"] > 0)
        & (x["close"] > 0)
        & (x["volume"] >= 0)
    ]
    return [
        (
            symbol,
            row.date,
            float(row.open),
            float(row.high),
            float(row.low),
            float(row.close),
            float(row.volume),
        )
        for row in x[["date", "open", "high", "low", "close", "volume"]].itertuples(index=False)
    ]


def _fetch_kr_naver_rows(symbol: str) -> list[tuple]:
    last = None
    for attempt in range(4):
        try:
            response = requests.get(
                KR_NAVER_DAILY_URL + symbol,
                timeout=30,
                headers={"User-Agent": "market-prediction-lab/full-universe-3pct-hunter-kr-v3"},
            )
            if response.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP_{response.status_code}")
            response.raise_for_status()
            data_list = re.findall(r'<item data="(.*?)" />', response.text, re.DOTALL)
            if not data_list:
                return []
            frame = pd.read_csv(
                StringIO("\n".join(data_list)),
                delimiter="|",
                header=None,
                names=["Date", "Open", "High", "Low", "Close", "Volume"],
                dtype={"Date": str},
            )
            return _kr_rows_from_pandas(symbol, frame)
        except Exception as exc:
            last = exc
            time.sleep(min(1.5 * (attempt + 1), 6))
    raise RuntimeError(f"NAVER_FETCH_FAILED:{symbol}:{last}")


def _fetch_kr_delisted_rows(symbol: str) -> list[tuple]:
    try:
        import FinanceDataReader as fdr

        frame = fdr.DataReader(
            f"KRX-DELISTING:{symbol}",
            str(START.date()),
            str((END_EXCLUSIVE - pd.Timedelta(days=1)).date()),
        )
        return _kr_rows_from_pandas(symbol, frame)
    except Exception as exc:
        raise RuntimeError(f"KRX_DELISTING_FETCH_FAILED:{symbol}:{exc}") from exc


def _fetch_kr_symbol(symbol: str, known_delisted: bool) -> tuple[str, list[tuple], str, str | None]:
    try:
        rows = _fetch_kr_naver_rows(symbol)
        if rows:
            return symbol, rows, "NAVER", None
    except Exception as exc:
        naver_error = str(exc)[:220]
    else:
        naver_error = "NAVER_EMPTY"

    try:
        rows = _fetch_kr_delisted_rows(symbol)
        if rows:
            return symbol, rows, "KRX_DELISTING", None
    except Exception as exc:
        delisted_error = str(exc)[:220]
    else:
        delisted_error = "KRX_DELISTING_EMPTY"

    return symbol, [], "NONE", f"{naver_error};{delisted_error};knownDelisted={known_delisted}"


def load_kr() -> tuple[pl.DataFrame, dict]:
    universe, delisted_symbols, market_by_symbol, universe_meta = _build_kr_frozen_universe()
    all_rows: list[tuple] = []
    failures = []
    source_counts = {"NAVER": 0, "KRX_DELISTING": 0}
    usable_symbols = set()
    usable_market_counts = {"KOSPI": 0, "KOSDAQ": 0, "KONEX": 0, "OTHER": 0}
    usable_delisted = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        future_map = {
            pool.submit(_fetch_kr_symbol, symbol, symbol in delisted_symbols): symbol
            for symbol in universe
        }
        for idx, future in enumerate(concurrent.futures.as_completed(future_map), 1):
            symbol = future_map[future]
            try:
                symbol, rows, source, error = future.result()
            except Exception as exc:
                rows, source, error = [], "NONE", str(exc)[:300]

            if rows:
                all_rows.extend(rows)
                usable_symbols.add(symbol)
                source_counts[source] = source_counts.get(source, 0) + 1
                bucket = market_by_symbol.get(symbol, "OTHER")
                usable_market_counts[bucket] = usable_market_counts.get(bucket, 0) + 1
                if symbol in delisted_symbols:
                    usable_delisted += 1
            else:
                failures.append({"symbol": symbol, "error": error})

            if idx % 100 == 0 or idx == len(universe):
                print(json.dumps({
                    "krFrozenSymbolsComplete": idx,
                    "universeSymbols": len(universe),
                    "usableSymbols": len(usable_symbols),
                    "rows": len(all_rows),
                    "failures": len(failures),
                    "sourceCounts": source_counts,
                }), flush=True)

    min_usable = int(len(universe) * 0.95)
    if len(usable_symbols) < min_usable:
        raise RuntimeError(
            f"KR_FROZEN_PRICE_COVERAGE_TOO_LOW:usable={len(usable_symbols)} "
            f"required={min_usable} universe={len(universe)} failures={len(failures)}"
        )
    if usable_market_counts.get("KOSPI", 0) < 880:
        raise RuntimeError(f"KR_KOSPI_PRICE_COVERAGE_TOO_LOW:{usable_market_counts}")
    if usable_market_counts.get("KOSDAQ", 0) < 1650:
        raise RuntimeError(f"KR_KOSDAQ_PRICE_COVERAGE_TOO_LOW:{usable_market_counts}")
    if usable_delisted < 170:
        raise RuntimeError(
            f"KR_DELISTED_PRICE_COVERAGE_TOO_LOW:{usable_delisted}/{len(delisted_symbols)}"
        )
    if len(all_rows) < 1_000_000:
        raise RuntimeError(f"KR_RAW_ROWS_TOO_LOW:{len(all_rows)}")

    frame = pl.DataFrame(
        all_rows,
        schema=["symbol", "date", "open", "high", "low", "close", "volume"],
        orient="row",
    ).unique(subset=["symbol", "date"], keep="last").sort(["symbol", "date"])

    meta = {
        "provider": "FinanceData/fdr_krx_data_cache + NAVER + FinanceDataReader KRX-DELISTING",
        "coverageMode": "FROZEN_KRX_ALL_MARKET_2026_03_31_PLUS_DELISTED_SINCE_2023_04_01",
        **universe_meta,
        "usableSymbols": len(usable_symbols),
        "usableDelistedSymbols": usable_delisted,
        "usableMarketCounts": usable_market_counts,
        "failedSymbols": len(failures),
        "failurePreview": failures[:30],
        "priceSourceCounts": source_counts,
        "rawRows": frame.height,
        "survivorshipControl": "period-end frozen listing plus all symbols delisted within observed period",
    }
    return frame, meta


def load_crypto(market: str) -> tuple[pl.DataFrame, dict]:
    sub = "spot" if market == "CRYPTO_SPOT" else "futures"
    root = Path(snapshot_download_retry(
        repo_id=CRYPTO_DATASET,
        repo_type="dataset",
        allow_patterns=[f"{sub}/1d/*.parquet"],
    ))
    folder = root / sub / "1d"
    files = [
        p for p in sorted(folder.glob("*.parquet"))
        if "-mark" not in p.name and "-funding_rate" not in p.name and "-index" not in p.name
    ]
    frames = []
    failures = []
    for idx, file in enumerate(files, 1):
        symbol = safe_symbol_from_file(str(file), market)
        try:
            df = (
                pl.scan_parquet(file)
                .with_columns(pl.col("date").dt.date().alias("date"))
                .filter((pl.col("date") >= pl.lit(START.date())) & (pl.col("date") < pl.lit(END_EXCLUSIVE.date())))
                .select([
                    pl.lit(symbol).alias("symbol"),
                    "date",
                    pl.col("open").cast(pl.Float64),
                    pl.col("high").cast(pl.Float64),
                    pl.col("low").cast(pl.Float64),
                    pl.col("close").cast(pl.Float64),
                    pl.col("volume").cast(pl.Float64),
                ])
                .filter((pl.col("open") > 0) & (pl.col("high") > 0) & (pl.col("low") > 0) & (pl.col("close") > 0))
                .collect()
            )
            if df.height:
                frames.append(df)
        except Exception as exc:
            failures.append({"file": file.name, "error": str(exc)[:160]})
        if idx % 100 == 0:
            print(json.dumps({"market": market, "filesChecked": idx, "usable": len(frames), "failures": len(failures)}), flush=True)
    if not frames:
        raise RuntimeError(f"{market}_NO_CRYPTO_DATA")
    return pl.concat(frames, how="vertical"), {
        "provider": CRYPTO_DATASET,
        "coverageMode": "BINANCE_1D_ALL_AVAILABLE_FILES_INCLUDING_DELISTED_WHERE_DATASET_RETAINS_THEM",
        "sourceFiles": len(files),
        "usableFiles": len(frames),
        "failedFiles": len(failures),
        "failurePreview": failures[:10],
    }

def add_features(df: pl.DataFrame, market: str) -> pl.DataFrame:
    df = df.sort(["symbol","date"])
    df = df.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(6).over("symbol").alias("close_6ago"),
        pl.col("close").shift(21).over("symbol").alias("close_21ago"),
        pl.col("volume").shift(1).over("symbol").alias("prev_volume"),
        pl.col("high").shift(1).rolling_max(window_size=20, min_samples=5).over("symbol").alias("prior_high20"),
        pl.col("volume").shift(1).rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_volume_ma20"),
        (pl.col("close").shift(1) * pl.col("volume").shift(1))
          .rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_dollar_volume20"),
    ])
    df = df.with_columns([
        (pl.col("open") / pl.col("prev_close") - 1.0).alias("gap"),
        (pl.col("prev_close") / pl.col("close_6ago") - 1.0).alias("ret5_prev"),
        (pl.col("prev_close") / pl.col("close_21ago") - 1.0).alias("ret20_prev"),
        (pl.col("prev_volume") / pl.col("prior_volume_ma20")).alias("prior_rvol"),
        (pl.col("prev_close") / pl.col("prior_high20") - 1.0).alias("distance_prior_high20"),
        (pl.col("high") / pl.col("open") - 1.0).alias("long_move_from_open"),
        (pl.col("close") / pl.col("prev_close") - 1.0).alias("close_to_close_return"),
    ])
    if market == "CRYPTO_FUTURES":
        df = df.with_columns((1.0 - pl.col("low") / pl.col("open")).alias("short_move_from_open"))
    else:
        df = df.with_columns(pl.lit(None, dtype=pl.Float64).alias("short_move_from_open"))
    return df

def opportunity_rows(df: pl.DataFrame, market: str) -> pl.DataFrame:
    cols = [
        "date","symbol","close_to_close_return","gap","ret5_prev","ret20_prev","prior_rvol",
        "distance_prior_high20","prior_dollar_volume20","open","high","low","close","volume",
    ]
    long_rows = (
        df.filter(pl.col("long_move_from_open") >= 0.03)
        .select([
            pl.lit(market).alias("market"),
            *cols[:2],
            pl.lit("LONG").alias("direction"),
            pl.col("long_move_from_open").alias("max_move"),
            *cols[2:],
        ])
    )
    if market != "CRYPTO_FUTURES":
        return long_rows
    short_rows = (
        df.filter(pl.col("short_move_from_open") >= 0.03)
        .select([
            pl.lit(market).alias("market"),
            *cols[:2],
            pl.lit("SHORT").alias("direction"),
            pl.col("short_move_from_open").alias("max_move"),
            *cols[2:],
        ])
    )
    return pl.concat([long_rows, short_rows], how="vertical")

def assert_direction_policy(opp: pl.DataFrame, market: str) -> None:
    allowed = {
        "US_STOCK": {"LONG"},
        "KR_STOCK": {"LONG"},
        "CRYPTO_SPOT": {"LONG"},
        "CRYPTO_FUTURES": {"LONG", "SHORT"},
    }
    observed = set(opp.get_column("direction").unique().to_list()) if opp.height else set()
    forbidden = observed - allowed[market]
    if forbidden:
        raise RuntimeError(
            f"DIRECTION_POLICY_VIOLATION:{market}:forbidden={sorted(forbidden)}"
        )
    if market != "CRYPTO_FUTURES" and "SHORT" in observed:
        raise RuntimeError(f"SHORT_FORBIDDEN:{market}")
    print(json.dumps({
        "directionPolicyVerified": True,
        "market": market,
        "allowed": sorted(allowed[market]),
        "observed": sorted(observed),
    }), flush=True)


def market_summary(raw: pl.DataFrame, opp: pl.DataFrame, market: str, source_meta: dict) -> dict:
    dates = raw.select("date").unique().height
    symbols = raw.select("symbol").unique().height
    out = {
        "market": market,
        "source": source_meta,
        "period": {"start": str(START.date()), "endExclusive": str(END_EXCLUSIVE.date())},
        "rawRows": raw.height,
        "symbolsWithAnyData": symbols,
        "tradingDates": dates,
        "opportunities": {},
    }
    for t in THRESHOLDS:
        rows = opp.filter(pl.col("max_move") >= t)
        out["opportunities"][f"{int(t*100)}pct"] = {
            "count": rows.height,
            "distinctSymbols": rows.select("symbol").unique().height,
            "activeDates": rows.select("date").unique().height,
            "averagePerMarketDay": rows.height / max(dates, 1),
        }
    return out

def causal_baseline(raw: pl.DataFrame, market: str, top_n: int) -> dict:
    # Diagnostic only. Every opportunity is kept in the census; this top-N is not a trade cap.
    x = raw.filter(
        pl.col("prev_close").is_not_null() &
        pl.col("prior_dollar_volume20").is_not_null() &
        pl.col("prior_rvol").is_not_null() &
        pl.col("ret5_prev").is_not_null()
    )
    if x.height == 0:
        return {"topNPerDate": top_n, "selectedRows": 0}
    x = x.with_columns([
        pl.col("gap").rank("average", descending=True).over("date").alias("gap_rank"),
        pl.col("prior_rvol").rank("average", descending=True).over("date").alias("rvol_rank"),
        pl.col("ret5_prev").rank("average", descending=True).over("date").alias("ret5_rank"),
        pl.col("prior_dollar_volume20").rank("average", descending=True).over("date").alias("liq_rank"),
        pl.col("distance_prior_high20").rank("average", descending=True).over("date").alias("near_high_rank"),
    ]).with_columns(
        (-pl.col("gap_rank") - pl.col("rvol_rank") - pl.col("ret5_rank") - pl.col("liq_rank") - pl.col("near_high_rank")).alias("score")
    )
    p = x.sort(["date","score"], descending=[False,True]).group_by("date", maintain_order=True).head(top_n)
    long_hits = p.filter(pl.col("long_move_from_open") >= 0.03).height
    long_total = x.filter(pl.col("long_move_from_open") >= 0.03).height
    result = {
        "topNPerDate": top_n,
        "selectedRows": p.height,
        "long3pctHits": long_hits,
        "long3pctUniverseOpportunities": long_total,
        "long3pctRecall": long_hits / max(long_total,1),
        "precisionAmongSelected": long_hits / max(p.height,1),
    }
    if market == "CRYPTO_FUTURES":
        s = x.with_columns([
            (-pl.col("gap")).rank("average", descending=True).over("date").alias("sgap_rank"),
            (-pl.col("ret5_prev")).rank("average", descending=True).over("date").alias("sret_rank"),
        ]).with_columns(
            (-pl.col("sgap_rank") - pl.col("rvol_rank") - pl.col("sret_rank") - pl.col("liq_rank")).alias("short_score")
        )
        sp = s.sort(["date","short_score"], descending=[False,True]).group_by("date", maintain_order=True).head(top_n)
        sh = sp.filter(pl.col("short_move_from_open") >= 0.03).height
        st = s.filter(pl.col("short_move_from_open") >= 0.03).height
        result.update({
            "short3pctHits": sh,
            "short3pctUniverseOpportunities": st,
            "short3pctRecall": sh / max(st,1),
            "shortPrecisionAmongSelected": sh / max(sp.height,1),
        })
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="market-prediction-lab/docs/full-universe-3pct-hunter-v2")
    ap.add_argument("--market", choices=["US_STOCK","KR_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"])
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    loaders = {
        "US_STOCK": load_us,
        "KR_STOCK": load_kr,
        "CRYPTO_SPOT": lambda: load_crypto("CRYPTO_SPOT"),
        "CRYPTO_FUTURES": lambda: load_crypto("CRYPTO_FUTURES"),
    }
    if args.market:
        loaders = {args.market: loaders[args.market]}

    summaries = {}
    opp_frames = []
    daily_frames = []

    for market, loader in loaders.items():
        print(json.dumps({"marketStart": market}), flush=True)
        loaded, source_meta = loader()
        raw = add_features(loaded, market)
        opp = opportunity_rows(raw, market)
        assert_direction_policy(opp, market)
        summary = market_summary(raw, opp, market, source_meta)
        summary["causalBaselineTop20"] = causal_baseline(raw, market, 20)
        summary["causalBaselineTop50"] = causal_baseline(raw, market, 50)
        summaries[market] = summary
        opp_frames.append(opp)

        daily = (
            opp.group_by(["market","date","direction"])
            .agg([
                pl.len().alias("opportunities3pct"),
                pl.col("max_move").max().alias("maxMove"),
                pl.col("max_move").mean().alias("meanMove"),
                (pl.col("max_move") >= 0.05).sum().alias("count5pct"),
                (pl.col("max_move") >= 0.10).sum().alias("count10pct"),
                (pl.col("max_move") >= 0.20).sum().alias("count20pct"),
                (pl.col("max_move") >= 0.50).sum().alias("count50pct"),
                (pl.col("max_move") >= 1.00).sum().alias("count100pct"),
            ])
            .sort(["date","market","direction"])
        )
        daily_frames.append(daily)
        print(json.dumps({"marketDone": market, **summary}), flush=True)
        del raw, loaded

    all_opp = pl.concat(opp_frames, how="vertical").sort(["date","market","max_move"], descending=[False,False,True])
    all_daily = pl.concat(daily_frames, how="vertical").sort(["date","market","direction"])

    all_opp.write_parquet(out / "all-opportunities-3pct-plus.parquet", compression="zstd")
    all_daily.write_csv(out / "daily-opportunity-counts.csv")
    all_opp.sort("max_move", descending=True).head(10000).write_csv(out / "top-10000-movers.csv")

    report = {
        "schemaVersion": 2,
        "contract": "full-universe-3pct-hunter-census-v2",
        "period": {"start": str(START.date()), "endExclusive": str(END_EXCLUSIVE.date())},
        "definition": {
            "longOpportunity": "daily high / daily open - 1 >= threshold",
            "shortOpportunity": "1 - daily low / daily open >= threshold; futures only",
            "thresholds": [f"{int(t*100)}%" for t in THRESHOLDS],
            "directionPolicy": {
                "US_STOCK": "LONG_ONLY",
                "KR_STOCK": "LONG_ONLY",
                "CRYPTO_SPOT": "LONG_ONLY",
                "CRYPTO_FUTURES": "LONG_SHORT",
            },
            "selectionLimitForCensus": None,
        },
        "truthBoundary": {
            "fullOpportunityCensusRetainsEveryObserved3pctPlusCase": True,
            "dailyBarsCannotProveTMinus60TMinus30TMinus15TMinus5": True,
            "causalTopNDiagnosticsAreNotFinalTradingStrategy": True,
            "profitabilityProven": False,
            "economicCredit": 0,
            "executionAuthority": "NONE",
        },
        "markets": summaries,
        "totalOpportunityRows3pctPlus": all_opp.height,
    }
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"FINAL": report}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()

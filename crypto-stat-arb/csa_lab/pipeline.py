"""수집 → 품질 검사 → 시장 데이터 구성 → 레버리지별 백테스트 → 불변 결과 저장."""
from __future__ import annotations

import hashlib
import io
import json
import platform
import subprocess
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from . import __version__
from .backtest import CARRY_ORIGINAL, CARRY_UPBIT_BITGET, XVENUE_ORIGINAL, MarketData, prepare_funding, run_backtest
from .costs import CostModel, CostRate
from .fund import DEFAULT_INITIAL_KRW, DEFAULT_MAX_ENTRY_MARGIN_KRW, AutoTradingFund, FundError
from .data import binance as bn
from .data import bitget as bg
from .data import upbit as up
from .data import fx as fxmod
from .data import hyperliquid as hl
from .http import PublicHttpClient, RetryPolicy
from .leverage import ALLOWED_LEVERAGES, check_paper_leverage_against_venue, parse_leverage
from .money import (DEFAULT_STRATEGY_CAPITAL_KRW, AllocationLedger, FxMissingError, krw_to_margin_units,
                    margin_units_to_krw, require_fx)
from .original_runner import README_CLAIMS
from .quality import check_funding, check_ohlcv, check_window
from .storage import (Checkpoint, atomic_write_bytes, atomic_write_json, cleanup_partials, read_json, run_lock, sha256_file,
                      write_manifest)

HOUR_MS = 3_600_000
SYMBOL = "BTCUSDT"

# README 가 주장한 구간(README.md:72). 원본 코드는 이 구간을 실제로 쓰지 않는다.
# 학습 2022-01-01~2023-06-30, 테스트 2023-07-01~2024-12-31 (끝 날짜 미포함 표기).
WINDOWS = {
    "readme_train": ("2022-01-01", "2023-07-01"),
    "readme_test": ("2023-07-01", "2025-01-01"),
}

# README 주장 수치는 검증 결과와 별도로 보존한다(원본 generate_visualizations.py 상수). 검증으로 확인된 값이 아니다.
README_CLAIMS_UNVERIFIED = {
    "values": dict(README_CLAIMS),
    "note": "원본 README 표의 주장. 이 패키지의 재현·비용 반영 결과와 별개로 기록만 하며, 재현되지 않으면 미재현으로 표시한다.",
}

# 데이터셋별 출처·기대 주기·검사 종류. 창별 품질 검사와 결과 근거 기록에 쓴다.
DATASETS = {
    "klines": {"source": "data.binance.vision futures/um monthly klines 1h (sha256 CHECKSUM 검증)", "interval_ms": HOUR_MS,
               "kind": "ohlcv", "max_missing_ratio": 0.01},
    "spotKlines": {"source": "data.binance.vision spot monthly klines 1h (sha256 CHECKSUM 검증)", "interval_ms": HOUR_MS,
                   "kind": "ohlcv", "max_missing_ratio": 0.01},
    "markPriceKlines": {"source": "data.binance.vision futures/um monthly markPriceKlines 1h (sha256 CHECKSUM 검증)",
                        "interval_ms": HOUR_MS, "kind": "ohlcv", "max_missing_ratio": 0.0},
    "fundingRate": {"source": "data.binance.vision futures/um monthly fundingRate (8h 정산, sha256 CHECKSUM 검증)",
                    "interval_ms": 8 * HOUR_MS, "kind": "funding", "max_missing_ratio": 0.0},
    "hyperliquid": {"source": "api.hyperliquid.xyz info fundingHistory BTC (1h 정산)", "interval_ms": HOUR_MS,
                    "kind": "funding", "max_missing_ratio": 0.0},
    # 운영 앱 실행 조합(업비트 현물 + 비트겟 USDT-M 무기한)용 공개 데이터. 거래가 없는 시간은 원천에 봉이 없다.
    "upbitSpotKlines": {"source": "api.upbit.com /v1/candles/minutes/60 KRW-BTC (체크섬 없음, 응답 그대로)",
                        "interval_ms": HOUR_MS, "kind": "ohlcv", "max_missing_ratio": 0.01},
    "upbitKrwUsdtKlines": {"source": "api.upbit.com /v1/candles/minutes/60 KRW-USDT (현물 USDT 환산용)",
                           "interval_ms": HOUR_MS, "kind": "ohlcv", "max_missing_ratio": 0.01},
    "bitgetKlines": {"source": "api.bitget.com /api/v2/mix/market/history-candles BTCUSDT USDT-FUTURES 1H",
                     "interval_ms": HOUR_MS, "kind": "ohlcv", "max_missing_ratio": 0.01},
    "bitgetMarkKlines": {"source": "api.bitget.com /api/v2/mix/market/history-mark-candles BTCUSDT USDT-FUTURES 1H",
                         "interval_ms": HOUR_MS, "kind": "ohlcv", "max_missing_ratio": 0.0},
    "bitgetFunding": {"source": "api.bitget.com /api/v2/mix/market/history-fund-rate BTCUSDT (8h 정산)",
                      "interval_ms": 8 * HOUR_MS, "kind": "funding", "max_missing_ratio": 0.0},
}
# 전략별 필수 데이터셋. 마크가격은 선택(창 안에 완전할 때만 청산·펀딩 정산 가격으로 사용).
STRATEGY_DATASETS = {
    "carry_binance": ("klines", "spotKlines", "fundingRate"),
    "xvenue_funding": ("klines", "fundingRate", "hyperliquid"),
    "carry_upbit_bitget": ("upbitSpotKlines", "upbitKrwUsdtKlines", "bitgetKlines", "bitgetFunding"),
}
UPBIT_SPOT_MARKET = "KRW-BTC"
UPBIT_FX_MARKET = "KRW-USDT"
BITGET_SYMBOL = "BTCUSDT"


def cost_profiles(hl_mmr_source: str) -> dict:
    """비용 가정. status 가 CONFIRMED 가 아닌 값이 하나라도 있으면 순수익성은 '미검증'으로 표시된다."""
    original = {
        "cost": CostModel(
            CostRate("taker_fee", 0.0004, "원본 strategies/futures_curve/__init__.py DEFAULT_VENUE_COSTS binance taker 4bp",
                     "ORIGINAL_CONFIG"),
            CostRate("slippage", 0.0005, "원본 step4_futures_orchestrator.py 1039행 기본 슬리피지 5bp", "ORIGINAL_CONFIG"),
            CostRate("half_spread", 0.0, "원본은 bid_ask_spread 기본 0(step4 1364행) - 원본 설정 그대로", "ORIGINAL_CONFIG"),
            True, "실제 펀딩 이력(data.binance.vision fundingRate, Hyperliquid fundingHistory)"),
        "venue_fees": {"binance:perp": 0.0004, "binance:spot": 0.0004, "hyperliquid:perp": 0.00025,
                       "upbit:spot": 0.0005, "bitget:perp": 0.0006},
        "venue_fee_source": "원본 DEFAULT_VENUE_COSTS / config/venues.yaml (업비트·비트겟은 원본에 없어 공개 기본 등급 가정: ASSUMED)",
    }
    current = {
        "cost": CostModel(
            CostRate("taker_fee", 0.0005, "Binance USDT-M 일반(VIP0) 테이커 0.05% 공개 수수료표 - 이 환경에서 재확인 못함",
                     "ASSUMED"),
            CostRate("slippage", 0.0005, "원본과 같은 5bp 가정(호가 깊이 데이터 없음)", "ASSUMED"),
            CostRate("half_spread", 0.0001, "BTC 무기한 호가 간격 가정 1bp(호가 이력 미수집)", "ASSUMED"),
            True, "실제 펀딩 이력(data.binance.vision fundingRate, Hyperliquid fundingHistory)"),
        "venue_fees": {"binance:perp": 0.0005, "binance:spot": 0.001, "hyperliquid:perp": 0.00045,
                       "upbit:spot": 0.0005, "bitget:perp": 0.0006},
        "venue_fee_source": "Binance 선물 0.05%·현물 0.10%, Hyperliquid 0.045%, 업비트 KRW 현물 0.05%, Bitget USDT-M 테이커 0.06% "
                            "(공개 기본 등급, 이 환경에서 재확인 못함: ASSUMED)",
    }
    return {"original": original, "current_public_assumed": current}


@dataclass
class Paths:
    root: Path

    @property
    def raw(self) -> Path:
        return self.root / "raw"

    @property
    def ckpt(self) -> Path:
        return self.root / "checkpoint.json"

    @property
    def lock(self) -> Path:
        return self.root / ".collect.lock"


def _client(min_interval: float = 0.15) -> PublicHttpClient:  # 업비트 시세 10회/초 한도 아래로
    return PublicHttpClient(RetryPolicy(max_attempts=5, base_delay=1.0, max_delay=30.0, timeout=30.0),
                            min_interval=min_interval)


def _ms(day: str) -> int:
    return int(pd.Timestamp(day, tz="UTC").value // 1_000_000)


def collect(data_dir: Path, start: date, end: date, *, with_hyperliquid: bool = True, with_fx: bool = True,
            with_upbit_bitget: bool = True, client: Optional[PublicHttpClient] = None) -> dict:
    """공개 데이터 수집(조회 전용). 같은 디렉터리로 다시 실행하면 완료된 월은 건너뛴다."""
    p = Paths(Path(data_dir))
    p.root.mkdir(parents=True, exist_ok=True)
    report: dict = {"started_at": datetime.now(timezone.utc).isoformat(), "start": str(start), "end": str(end)}
    with run_lock(p.lock):
        report["partials_cleaned"] = cleanup_partials(p.root)
        ck = Checkpoint(p.ckpt)
        client = client or _client()
        for kind in ("klines", "markPriceKlines", "fundingRate", "spotKlines"):
            report[kind] = bn.fetch_range(client, kind, SYMBOL, start, end, p.raw, ck)
        end_ms = _ms(str(end)) + 31 * 24 * HOUR_MS
        if with_hyperliquid:
            key = f"hyperliquid:funding:{start}:{end}"
            target = p.raw / "hyperliquid" / f"BTC-funding-{start}-{end}.parquet"
            if not ck.is_done(key, target):
                df = hl.funding_history(client, "BTC", _ms(str(start)), end_ms)
                _save_parquet(target, df)
                ck.mark_done(key, sha256=sha256_file(target), rows=len(df), source="api.hyperliquid.xyz fundingHistory")
            try:
                report["hyperliquid_limit"] = hl.register_max_leverage(client, "BTC")
                atomic_write_json(p.raw / "hyperliquid" / "meta_btc.json", report["hyperliquid_limit"])
            except Exception as e:  # 한도 확인 실패는 수집 실패로 보지 않되 기록
                report["hyperliquid_limit_error"] = str(e)
        if with_upbit_bitget:
            # 운영 조합 데이터. 한 원천의 실패가 다른 원천 수집을 막지 않도록 각각 기록하고, 실패한 원천은
            # 데이터셋이 없는 것으로 남아 해당 전략 창이 INCOMPLETE(DATASET_MISSING)로 판정된다(채우지 않음).
            ub_report = {}
            jobs = {
                "upbitSpotKlines": lambda: up.fetch_range(client, UPBIT_SPOT_MARKET, start, end, p.raw, ck),
                "upbitKrwUsdtKlines": lambda: up.fetch_range(client, UPBIT_FX_MARKET, start, end, p.raw, ck),
                "bitgetKlines": lambda: bg.fetch_candles_range(client, BITGET_SYMBOL, start, end, p.raw, ck),
                "bitgetMarkKlines": lambda: bg.fetch_candles_range(client, BITGET_SYMBOL, start, end, p.raw, ck, mark=True),
            }
            for name, fn in jobs.items():
                try:
                    ub_report[name] = fn()
                except Exception as e:
                    ub_report[name] = {"error": f"{type(e).__name__}: {e}"}
            key = f"bitgetFunding:{BITGET_SYMBOL}:{start}:{end}"
            target = p.raw / "bitgetFunding" / f"{BITGET_SYMBOL}-funding-{start}-{end}.parquet"
            try:
                if not ck.is_done(key, target):
                    df = bg.funding_history(client, BITGET_SYMBOL, _ms(str(start)), end_ms)
                    _save_parquet(target, df)
                    ck.mark_done(key, sha256=sha256_file(target), rows=len(df), source=bg.HISTORY_FUNDING_URL)
                ub_report["bitgetFunding"] = {"rows": int(ck.state["done"][key].get("rows", 0))}
            except Exception as e:
                ub_report["bitgetFunding"] = {"error": f"{type(e).__name__}: {e}"}
            report["upbit_bitget"] = ub_report
        if with_fx:
            fx_report = {}
            sources = {
                "upbit_krw_usdt": lambda: _upbit_series(client, start, end),
                "frankfurter_usd_krw": lambda: fxmod.frankfurter_usd_krw(client, str(start), _month_end(end)),
            }
            for name, fn in sources.items():
                target = p.raw / "fx" / f"{name}.parquet"
                try:
                    df = fn()
                    _save_parquet(target, df)
                    fx_report[name] = {"rows": len(df), "first": df["date"].iloc[0] if len(df) else None,
                                       "last": df["date"].iloc[-1] if len(df) else None}
                except Exception as e:
                    fx_report[name] = {"error": f"{type(e).__name__}: {e}"}
            report["fx"] = fx_report
        report["http_stats"] = client.stats.__dict__
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(p.root / "collect_report.json", report)
    return report


def _save_parquet(target: Path, df: pd.DataFrame) -> None:
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    atomic_write_bytes(target, buf.getvalue())


def _month_end(d: date) -> str:
    return str((pd.Timestamp(d) + pd.offsets.MonthEnd(0)).date())


def _upbit_series(client: PublicHttpClient, start: date, end: date) -> pd.DataFrame:
    frames = []
    cursor = pd.Timestamp(_month_end(end), tz="UTC") + pd.Timedelta(days=1)
    stop = pd.Timestamp(start, tz="UTC") - pd.Timedelta(days=7)
    while cursor > stop:
        df = fxmod.upbit_usdt_daily(client, cursor.to_pydatetime(), 200)
        if df.empty:
            break
        frames.append(df)
        first = pd.Timestamp(df["date"].iloc[0], tz="UTC")
        if first >= cursor:
            break
        cursor = first
    if not frames:
        return pd.DataFrame(columns=["date", "krw_per_unit"])
    out = pd.concat(frames).drop_duplicates("date").sort_values("date").reset_index(drop=True)
    return out


def _load_kind(raw: Path, kind: str, symbol: str = SYMBOL) -> pd.DataFrame:
    files = sorted((raw / kind / symbol).glob("*.parquet"))
    return bn.load_parquets(files)


def _attach_upbit_bitget(raw: Path, bars: pd.DataFrame, frames: dict, datasets: dict, quality: dict,
                         funding: dict, proxies: dict) -> None:
    """운영 조합 데이터셋이 수집돼 있으면 다리(upbit_spot: USDT 환산, bitget_perp, bitget_perp_mark)와 비트겟 펀딩을 붙인다.
    없는 데이터셋은 등록하지 않아 전략 창 판정이 DATASET_MISSING 으로 떨어진다."""
    loaded = {}
    for kind, symbol, leg in (("upbitSpotKlines", UPBIT_SPOT_MARKET, "upbit_spot_krw"),
                              ("upbitKrwUsdtKlines", UPBIT_FX_MARKET, "upbit_krw_usdt"),
                              ("bitgetKlines", BITGET_SYMBOL, "bitget_perp"),
                              ("bitgetMarkKlines", BITGET_SYMBOL, "bitget_perp_mark")):
        df = _load_kind(raw, "upbitKlines" if kind.startswith("upbit") else kind, symbol)
        if df.empty:
            continue
        d, rep = check_ohlcv(df, f"{kind}:{symbol}", max_missing_ratio=DATASETS[kind]["max_missing_ratio"])
        quality[rep.name] = rep.to_dict()
        loaded[leg] = d.set_index("ts").reindex(bars.index)
        datasets[kind] = {"frame": d, **DATASETS[kind]}
    if "upbit_spot_krw" in loaded and "upbit_krw_usdt" in loaded:
        usdt = loaded["upbit_krw_usdt"]["close"]
        for c in ("open", "high", "low", "close"):
            bars[f"upbit_spot_{c}"] = loaded["upbit_spot_krw"][c] / usdt
            bars[f"upbit_spot_krw_{c}"] = loaded["upbit_spot_krw"][c]
        proxies["upbit_spot"] = ("업비트 KRW-BTC 1시간봉을 같은 시각 KRW-USDT 1시간봉 종가로 나눠 USDT 로 환산"
                                 "(봉 안 환율 변동은 종가 하나로 근사). 두 봉 중 하나라도 없으면 그 시각은 결측")
    if "bitget_perp" in loaded:
        for c in ("open", "high", "low", "close"):
            bars[f"bitget_perp_{c}"] = loaded["bitget_perp"][c]
    files = sorted((raw / "bitgetFunding").glob(f"{BITGET_SYMBOL}-funding-*.parquet"))
    fr = bn.load_parquets(files)
    if not fr.empty:
        f2, rep = check_funding(fr, f"bitgetFunding:{BITGET_SYMBOL}", expected_interval_ms=8 * HOUR_MS)
        quality[rep.name] = rep.to_dict()
        datasets["bitgetFunding"] = {"frame": f2, **DATASETS["bitgetFunding"]}
        funding["bitget"] = prepare_funding(f2, 8)


def build_market(data_dir: Path, *, now_ms: Optional[int] = None) -> tuple[MarketData, dict]:
    raw = Paths(Path(data_dir)).raw
    quality = {}
    frames = {}
    datasets = {}
    for kind, leg in (("klines", "binance_perp"), ("spotKlines", "binance_spot"), ("markPriceKlines", "binance_perp_mark")):
        df = _load_kind(raw, kind)
        d, rep = check_ohlcv(df, f"{kind}:{SYMBOL}", max_missing_ratio=0.01)
        quality[rep.name] = rep.to_dict()
        frames[leg] = d.set_index("ts")
        datasets[kind] = {"frame": d, **DATASETS[kind]}
    bars = pd.DataFrame(index=frames["binance_perp"].index)
    for c in ("open", "high", "low", "close"):
        bars[f"binance_perp_{c}"] = frames["binance_perp"][c]
        bars[f"binance_spot_{c}"] = frames["binance_spot"][c].reindex(bars.index)
        # 하이퍼리퀴드 1시간봉은 공개 API 가 최근 5,000개만 제공 → 바이낸스 무기한 가격을 대용(명시)
        bars[f"hl_perp_{c}"] = frames["binance_perp"][c]
    mark = frames["binance_perp_mark"].reindex(bars.index)
    if mark[["high", "low", "close"]].notna().all().all():
        bars["binance_perp_mark_high"] = mark["high"]
        bars["binance_perp_mark_low"] = mark["low"]
        bars["binance_perp_mark_close"] = mark["close"]
        mark_note = "Binance markPriceKlines 사용"
    else:
        mark_note = f"마크가격 결측 {int(mark['close'].isna().sum())}개 → 청산·펀딩 정산에 체결가 사용"
    fb_raw = _load_kind(raw, "fundingRate")
    fb, rep = check_funding(fb_raw, "fundingRate:BTCUSDT", expected_interval_ms=8 * HOUR_MS)
    quality[rep.name] = rep.to_dict()
    datasets["fundingRate"] = {"frame": fb, **DATASETS["fundingRate"]}
    fh_files = sorted((raw / "hyperliquid").glob("BTC-funding-*.parquet"))
    fh_raw = bn.load_parquets(fh_files)
    if not fh_raw.empty:
        fh, rep = check_funding(fh_raw, "hyperliquid:BTC funding", expected_interval_ms=HOUR_MS)
        quality[rep.name] = rep.to_dict()
    else:
        fh = fh_raw
        quality["hyperliquid:BTC funding"] = {"ok": False, "blocking": ["EMPTY"]}
    datasets["hyperliquid"] = {"frame": fh, **DATASETS["hyperliquid"]}
    funding = {"binance": prepare_funding(fb, 8), "hyperliquid": prepare_funding(fh, 1)}
    proxies = {"hl_perp": "Binance USDT-M BTCUSDT 1시간봉을 하이퍼리퀴드 가격 대용으로 사용(펀딩은 실제 하이퍼리퀴드 이력)",
               "binance_perp_mark": mark_note}
    _attach_upbit_bitget(raw, bars, frames, datasets, quality, funding, proxies)
    market = MarketData(bars, funding, proxies, datasets)
    return market, quality


def window_quality(market: MarketData, ws: str, we: str) -> dict:
    """한 평가 창에 대해 데이터셋별 보유 범위·결측·결함을 독립적으로 검사한다(다른 창과 무관)."""
    out = {}
    for name, ds in market.datasets.items():
        rep = check_window(ds["frame"], name, _ms(ws), _ms(we), ds["interval_ms"], source=ds["source"], kind=ds["kind"],
                           max_missing_ratio=ds.get("max_missing_ratio", 0.0),
                           gap_tolerance=1.5 if ds["kind"] == "funding" else 1.0)
        out[name] = rep.to_dict()
    return out


def strategy_window_verdict(strategy: str, wq: dict) -> tuple[str, dict]:
    """전략이 필요로 하는 데이터셋만 보고 창 판정을 내린다. (상태, 데이터셋별 상태·사유)."""
    required = STRATEGY_DATASETS[strategy]
    detail = {}
    status = "OK"
    for name in required:
        r = wq.get(name)
        if r is None:
            detail[name] = {"status": "INCOMPLETE", "reasons": ["DATASET_MISSING"]}
            if status != "BLOCKED":
                status = "INCOMPLETE"
            continue
        detail[name] = {"status": r["status"], "reasons": r["reasons"], "rows_in_window": r["rows_in_window"],
                        "first_in_window": r["first_in_window"], "last_in_window": r["last_in_window"],
                        "expected_rows": r["expected_rows"], "missing_intervals": r["missing_intervals"],
                        "lead_missing_hours": r["lead_missing_hours"], "tail_missing_hours": r["tail_missing_hours"]}
        if r["status"] == "BLOCKED":
            status = "BLOCKED"
        elif r["status"] == "INCOMPLETE" and status != "BLOCKED":
            status = "INCOMPLETE"
    return status, detail


DAY_MS = 24 * HOUR_MS
MIN_SEGMENT_DAYS = 30
MAX_SEGMENTS_PER_WINDOW = 8


def _day_ceil(ms: int) -> int:
    return -(-ms // DAY_MS) * DAY_MS


def _day_floor(ms: int) -> int:
    return (ms // DAY_MS) * DAY_MS


def _iso_day(ms: int) -> str:
    return pd.Timestamp(ms, unit="ms", tz="UTC").strftime("%Y-%m-%d")


def excluded_intervals(strategy: str, wq: dict, ws: str, we: str) -> tuple[list, bool]:
    """전략 필수 데이터셋의 창 안 결측·성긴 주기·앞뒤 미보유 구간을 [시작ms, 끝ms(미포함), 데이터셋, 사유] 로 모은다.

    반환 (구간 목록, 신뢰 가능 여부). 결측 구간 목록이 20개에서 잘려 전부를 알 수 없으면 신뢰 불가로 표시한다."""
    start_ms, end_ms = _ms(ws), _ms(we)
    out, reliable = [], True
    for name in STRATEGY_DATASETS[strategy]:
        r = wq.get(name)
        if r is None or r["rows_in_window"] == 0:
            out.append([start_ms, end_ms, name, "NO_DATA_IN_WINDOW"])
            continue
        iv = int(round(r["expected_interval_hours"] * HOUR_MS))
        first, last = _ms(r["first_in_window"]), _ms(r["last_in_window"])
        if first > start_ms:
            out.append([start_ms, first, name, "COVERAGE_STARTS_LATE"])
        if last + iv < end_ms:
            out.append([last + iv, end_ms, name, "COVERAGE_ENDS_EARLY"])
        listed = sum(int(m[2]) for m in r.get("missing_ranges") or [])
        if listed < int(r.get("missing_intervals") or 0):
            reliable = False  # 결측 구간 목록이 잘림 → 완전 구간을 계산할 수 없음
        for m in r.get("missing_ranges") or []:
            out.append([_ms(m[0]), _ms(m[1]) + iv, name, f"MISSING:{m[2]}"])
        for seg in r.get("coarse_segments") or []:
            out.append([_ms(seg[0]), _ms(seg[1]) + int(seg[2] * HOUR_MS), name, f"CADENCE_MISMATCH:{seg[2]:g}h"])
    out.sort(key=lambda x: x[0])
    return out, reliable


def complete_subwindows(strategy: str, wq: dict, ws: str, we: str, *, min_days: int = MIN_SEGMENT_DAYS,
                        max_segments: int = MAX_SEGMENTS_PER_WINDOW) -> dict:
    """INCOMPLETE 창에서 전략 필수 데이터셋이 모두 완전한 최대 구간(일 단위 정렬, min_days 이상)을 구한다.

    제외 구간과 사유를 함께 돌려주며, 원본 데이터가 없는 구간은 어떤 방법으로도 채우지 않는다.
    돌려준 후보 구간은 호출자가 다시 창별 품질 검사를 통과시킨 뒤에만 평가한다."""
    start_ms, end_ms = _ms(ws), _ms(we)
    excl, reliable = excluded_intervals(strategy, wq, ws, we)
    excluded = [{"start": _iso(a), "end_exclusive": _iso(b), "dataset": n, "reason": why} for a, b, n, why in excl]
    if not reliable:
        return {"segments": [], "excluded_intervals": excluded,
                "note": "결측 구간 목록이 잘려 완전 구간을 계산하지 못함(평가 제외)"}
    merged = []
    for a, b, _, _ in excl:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    cands, cursor = [], start_ms
    for a, b in merged + [[end_ms, end_ms]]:
        if a > cursor:
            s0, e0 = _day_ceil(cursor), _day_floor(a)
            if e0 - s0 >= min_days * DAY_MS:
                cands.append((_iso_day(s0), _iso_day(e0)))
        cursor = max(cursor, b)
    too_many = len(cands) > max_segments
    return {"segments": cands[:max_segments], "excluded_intervals": excluded,
            "note": (f"완전 구간이 {len(cands)}개로 상한 {max_segments}개만 평가" if too_many else
                     f"필수 데이터셋이 모두 완전한 {min_days}일 이상 구간만 평가(일 단위 정렬)")}


def _iso(ms: int) -> str:
    return pd.Timestamp(ms, unit="ms", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def market_for_window(market: MarketData, ws: str, we: str, wq: dict) -> tuple[MarketData, str]:
    """창에 맞춘 시장 데이터. 마크가격은 그 창 안에서 완전할 때만 붙이고, 아니면 체결가로 대신한다(창별 판정)."""
    start_ms, end_ms = _ms(ws), _ms(we)
    bars = market.bars[(market.bars.index >= start_ms) & (market.bars.index < end_ms)]
    bars = bars[[c for c in bars.columns if "_mark_" not in c]].copy()
    proxies = dict(market.price_proxies)
    notes = {}
    for ds_name, leg, label in (("markPriceKlines", "binance_perp_mark", "Binance markPriceKlines"),
                                ("bitgetMarkKlines", "bitget_perp_mark", "Bitget history-mark-candles")):
        mark_ds = market.datasets.get(ds_name)
        mark_rep = wq.get(ds_name)
        if mark_ds is not None and mark_rep is not None and mark_rep["status"] == "OK":
            mark = mark_ds["frame"].set_index("ts").reindex(bars.index)
            if mark[["high", "low", "close"]].notna().all().all():
                bars[f"{leg}_high"] = mark["high"]
                bars[f"{leg}_low"] = mark["low"]
                bars[f"{leg}_close"] = mark["close"]
                note = f"{label} 사용(이 창 안에 결측 없음)"
            else:
                note = "마크가격이 봉 인덱스와 맞지 않아 청산·펀딩 정산에 체결가 사용"
        else:
            reasons = mark_rep["reasons"] if mark_rep else ["DATASET_MISSING"]
            note = f"이 창의 마크가격 결측/결함 {reasons} → 청산·펀딩 정산에 체결가 사용(창별 판정)"
        proxies[leg] = note
        notes[leg] = note
    note = notes["binance_perp_mark"]
    if "bitgetKlines" in market.datasets:
        note = f"{note}; bitget_perp_mark: {notes['bitget_perp_mark']}"
    return MarketData(bars, market.funding, proxies, market.datasets), note


def load_fx(data_dir: Path) -> dict:
    fxdir = Paths(Path(data_dir)).raw / "fx"
    out = {}
    for name in ("upbit_krw_usdt", "frankfurter_usd_krw"):
        f = fxdir / f"{name}.parquet"
        out[name] = pd.read_parquet(f) if f.exists() else pd.DataFrame(columns=["date", "krw_per_unit"])
    return out


def pick_fx(fx: dict, day: str):
    """업비트 KRW-USDT 우선(실제 원화→USDT 경로), 없으면 ECB USD/KRW. 둘 다 없으면 None."""
    q = fxmod.quote_for_date(fx.get("upbit_krw_usdt"), day, "USDT", "upbit:KRW-USDT 일봉 종가")
    if q is not None:
        return q
    return fxmod.quote_for_date(fx.get("frankfurter_usd_krw"), day, "USD", "frankfurter(ECB) USD/KRW")


def _hash_obj(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _git_sha() -> Optional[str]:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True,
                                       cwd=Path(__file__).resolve().parent, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


def data_fingerprint(data_dir: Path) -> str:
    ck = Paths(Path(data_dir)).ckpt
    if not ck.exists():
        return "none"
    return _hash_obj(read_json(ck))


def run_suite(data_dir: Path, results_dir: Path, *, leverages: list, capital_krw: float,
              windows: dict, strategies: list, profiles: list, label: str,
              accept_quality_issues: bool = False, fund_mode: bool = True,
              fund_initial_krw: float = DEFAULT_INITIAL_KRW,
              fund_max_entry_krw: float = DEFAULT_MAX_ENTRY_MARGIN_KRW,
              min_segment_days: int = MIN_SEGMENT_DAYS) -> Path:
    """여러 전략·구간·비용·레버리지 조합을 실행해 새 결과 디렉터리에 저장(덮어쓰지 않음).

    fund_mode: 자동매매 자금 원장(기본 자금 fund_initial_krw, 최대 진입 증거금 fund_max_entry_krw, 이익 50% 재투자)을
    실행마다 새로 만들어 적용한다. 전략별 계획 capital_krw 는 이 기본 자금에서 떼어 두는 계획이라 합계가 기본 자금을
    넘으면 실행을 BLOCKED 로 기록한다. fund_mode=False 면 전략별 계획 자금을 그대로 복리 운용한다(이전 방식).
    """
    levs = [parse_leverage(l) for l in leverages]
    market, quality = build_market(data_dir)
    quality_blocking = {k: v.get("blocking") for k, v in quality.items() if v.get("blocking")}
    fx = load_fx(data_dir)
    hl_meta_f = Paths(Path(data_dir)).raw / "hyperliquid" / "meta_btc.json"
    hl_meta = read_json(hl_meta_f) if hl_meta_f.exists() else {}
    hl_max = hl_meta.get("max_leverage")
    hl_mmr = (1.0 / (2.0 * hl_max)) if hl_max else 0.0125
    mmr = {"binance": 0.004, "hyperliquid": hl_mmr, "bitget": 0.004}
    mmr_source = {
        "binance": "BTCUSDT 1구간(명목 5만 USDT 미만) 유지증거금률 0.40% - 공개 문서 기준 가정, 이 환경에서 재확인 못함(ASSUMED)",
        "bitget": "Bitget USDT-M BTCUSDT 1구간 유지증거금률 0.40% - 공개 문서 기준 가정, 이 환경에서 재확인 못함(ASSUMED)",
        "hyperliquid": (f"maxLeverage {hl_max}(공개 meta 확인) → 유지증거금률 = 1/(2×maxLeverage) 문서 공식 적용(공식은 ASSUMED)"
                        if hl_max else "meta 미확인 → 1.25% 가정(ASSUMED)"),
    }
    profs = cost_profiles(mmr_source["hyperliquid"])
    params_map = {"carry_binance": CARRY_ORIGINAL, "xvenue_funding": XVENUE_ORIGINAL,
                  "carry_upbit_bitget": CARRY_UPBIT_BITGET}
    config = {"leverages": levs, "capital_krw": capital_krw, "windows": windows, "strategies": strategies,
              "fund_mode": fund_mode, "fund_initial_krw": fund_initial_krw, "fund_max_entry_krw": fund_max_entry_krw,
              "profiles": profiles, "label": label, "accept_quality_issues": accept_quality_issues}
    fp = data_fingerprint(data_dir)
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{label}-{_hash_obj(config)}-{fp}"
    out = Path(results_dir) / run_id
    out.mkdir(parents=True, exist_ok=False)
    files = []
    summary_rows = []
    ledger = AllocationLedger(capital_krw * len(strategies))
    for s in strategies:
        ledger.allocate(s, capital_krw)  # 전략마다 별도 계획 자금. 같은 돈을 두 전략이 쓰지 않음
    plan_error = None
    if fund_mode:
        try:
            probe = AutoTradingFund(initial_krw=fund_initial_krw, max_entry_margin_krw=fund_max_entry_krw)
            for s in strategies:
                probe.allocate_plan(s, capital_krw)
        except FundError as e:
            plan_error = str(e)
    window_quality_all = {}
    # (창 이름, 시작, 끝, 상위 창, 평가할 전략들). INCOMPLETE 창은 전략별 완전 구간을 하위 창으로 추가해 평가한다.
    queue = [(wname, ws, we, None, list(strategies)) for wname, (ws, we) in windows.items()]
    while queue:
        wname, ws, we, parent, strats = queue.pop(0)
        fx_start = pick_fx(fx, ws)
        last_day = str((pd.Timestamp(we) - pd.Timedelta(days=1)).date())
        fx_end = pick_fx(fx, last_day)
        # 창별 독립 품질 검사: 학습·테스트 창은 서로의 결측에 영향받지 않는다
        wq = window_quality(market, ws, we)
        wmarket, mark_note = market_for_window(market, ws, we, wq)
        window_quality_all[wname] = {"window": [ws, we], "datasets": wq, "mark_price_note": mark_note,
                                     "parent_window": parent}
        for s in strats:
            verdict, detail = strategy_window_verdict(s, wq)
            if verdict == "INCOMPLETE" and parent is None and not accept_quality_issues:
                sub = complete_subwindows(s, wq, ws, we, min_days=min_segment_days)
                accepted, rejected = [], []
                for i, (ss, se) in enumerate(sub["segments"], 1):
                    sv, sdetail = strategy_window_verdict(s, window_quality(market, ss, se))
                    if sv == "OK":
                        sub_name = f"{wname}#{s}#seg{i}"
                        accepted.append({"window": sub_name, "start": ss, "end_exclusive": se})
                        queue.append((sub_name, ss, se, wname, [s]))
                    else:
                        rejected.append({"start": ss, "end_exclusive": se, "verdict": sv,
                                         "reasons": {n: d["reasons"] for n, d in sdetail.items() if d["reasons"]}})
                window_quality_all[wname].setdefault("complete_subwindows", {})[s] = {
                    "evaluated": accepted, "rejected_on_recheck": rejected,
                    "excluded_intervals": sub["excluded_intervals"], "note": sub["note"],
                    "min_segment_days": min_segment_days}
            evidence = {"evaluation_start": ws, "evaluation_end_exclusive": we, "verdict": verdict,
                        "parent_window": parent,
                        "datasets": {n: {**detail[n], "source": wq[n]["source"] if n in wq else None,
                                         "missing_ranges": (wq[n]["missing_ranges"][:10] if n in wq else [])}
                                     for n in detail},
                        "mark_price": mark_note,
                        "price_proxies": wmarket.price_proxies}
            for prof in profiles:
                pr = profs[prof]
                for lev in levs:
                    row = {"window": wname, "strategy": s, "cost_profile": prof, "leverage": lev,
                           "window_start": ws, "window_end_exclusive": we, "parent_window": parent,
                           "data_verdict": verdict,
                           "data_reasons": json.dumps({n: d["reasons"] for n, d in detail.items() if d["reasons"]},
                                                      ensure_ascii=False)}
                    if verdict != "OK" and not accept_quality_issues:
                        status = "BLOCKED_DATA_QUALITY" if verdict == "BLOCKED" else "INCOMPLETE_DATA"
                        row.update(status=status, error=row["data_reasons"])
                        summary_rows.append(row)
                        continue
                    try:
                        q = require_fx(fx_start, max_age_seconds=None)
                    except FxMissingError as e:
                        row.update(status="BLOCKED_FX_MISSING", error=str(e))
                        summary_rows.append(row)
                        continue
                    if plan_error:
                        row.update(status="BLOCKED_PLAN_EXCEEDS_FUND", error=plan_error)
                        summary_rows.append(row)
                        continue
                    capital_units = krw_to_margin_units(capital_krw, q)
                    fund = None
                    fund_kw = {}
                    if fund_mode:
                        fund_path = out / "runs" / wname / s / prof / f"lev{lev}.fund.json"
                        fund = AutoTradingFund.open(fund_path, initial_krw=fund_initial_krw,
                                                    max_entry_margin_krw=fund_max_entry_krw)
                        for sid in strategies:
                            fund.allocate_plan(sid, capital_krw)
                        fund_kw = {"fund": fund, "fund_fx_krw_per_unit": q.krw_per_unit, "fund_strategy_id": s}
                        capital_units = fund.allowed_entry_margin_krw(s)["allowed_krw"] / q.krw_per_unit
                    try:
                        res = run_backtest(wmarket, params_map[s], leverage=lev, capital=capital_units, cost=pr["cost"],
                                           venue_fees=pr["venue_fees"], mmr=mmr, start_ms=_ms(ws), end_ms=_ms(we),
                                           stale_funding_hours={"binance": 9, "hyperliquid": 2, "bitget": 9}, **fund_kw)
                        if fund is not None:
                            files.append(fund_path)
                    except Exception as e:
                        row.update(status="ERROR", error=f"{type(e).__name__}: {e}")
                        summary_rows.append(row)
                        continue
                    m = res["metrics"]
                    res["capital"] = {
                        "capital_krw": capital_krw,
                        "fx_start": {"krw_per_unit": q.krw_per_unit, "unit": q.unit, "source": q.source},
                        "capital_margin_units": capital_units,
                        "fx_end": ({"krw_per_unit": fx_end.krw_per_unit, "unit": fx_end.unit, "source": fx_end.source}
                                   if fx_end else "FX_MISSING"),
                        "final_equity_krw_at_end_fx": margin_units_to_krw(m["final_equity"], fx_end) if fx_end else None,
                        "final_equity_krw_at_start_fx": margin_units_to_krw(m["final_equity"], q),
                        "allocation": ledger.to_dict(),
                        "fund_mode": fund_mode,
                        "first_entry_margin_units": capital_units,
                    }
                    res["venue_leverage_status"] = [
                        check_paper_leverage_against_venue(lev, "binance", "BTCUSDT-PERP"),
                        check_paper_leverage_against_venue(lev, "hyperliquid", "BTC-PERP"),
                        check_paper_leverage_against_venue(lev, "bitget", f"{BITGET_SYMBOL}-USDT-FUTURES"),
                    ]
                    res["mmr_source"] = mmr_source
                    res["data_evidence"] = evidence
                    res["readme_claims_unverified"] = README_CLAIMS_UNVERIFIED
                    res["mode"] = "BACKTEST_PAPER_ONLY"
                    res["live_orders"] = 0
                    f = out / "runs" / wname / s / prof / f"lev{lev}.json"
                    atomic_write_json(f, res, overwrite=False)
                    files.append(f)
                    row.update(status="OK", capital_units=capital_units, fx=q.krw_per_unit, fx_unit=q.unit,
                               data_first=min((d["first_in_window"] for d in detail.values() if d.get("first_in_window")),
                                              default=None),
                               data_last=max((d["last_in_window"] for d in detail.values() if d.get("last_in_window")),
                                             default=None),
                               net_pnl_units=m["net_pnl"], net_return=m["net_return"],
                               net_pnl_krw_start_fx=margin_units_to_krw(m["net_pnl"], q) if m["net_pnl"] != 0 else 0.0,
                               max_notional_per_leg=m["max_notional_per_leg"], fees=m["fees_total"],
                               funding=m["funding_pnl"], slippage=m["slippage"], spread=m["spread"],
                               mdd=m["max_drawdown"], sharpe=m["sharpe_hourly_annualized"], trades=m["trades"],
                               win_rate_net=m["win_rate_net"], pf_net=m["profit_factor_net"],
                               avg_hold_h=m["avg_hold_hours"], liquidations=m["liquidations"],
                               blocked_stale_hours=m["blocked_stale_hours"],
                               fund_base_krw=(fund.base_balance_krw if fund else None),
                               fund_reserve_krw=(fund.reserve_krw if fund else None),
                               fund_settlements=(len(fund.settled) if fund else None),
                               blocked_fund_entries=m.get("blocked_fund_entries"),
                               all_costs_confirmed=res["cost_model"]["all_costs_confirmed"])
                    summary_rows.append(row)
    meta = {
        "run_id": run_id, "label": label, "config": config, "code_version": __version__, "git_sha": _git_sha(),
        "python": platform.python_version(), "pandas": pd.__version__,
        "data_fingerprint": fp, "data_quality": quality, "quality_blocking_global_informational": quality_blocking,
        "quality_policy": "per_window: 각 평가 창을 독립 검사해 전략별 필수 데이터셋이 모두 OK 일 때만 실행. "
                          "INCOMPLETE(원본 데이터 없음/성긴 주기)·BLOCKED(값 결함)는 PASS 가 아니며 보간하지 않음. "
                          f"INCOMPLETE 창은 필수 데이터셋이 모두 완전한 {min_segment_days}일 이상 구간만 하위 창(창이름#전략#segN)으로 "
                          "따로 평가하고 제외 구간과 사유를 window_quality.complete_subwindows 에 기록. "
                          "창 안에서 사용 다리의 가격이 결측인 봉은 제외(bars_dropped_missing_leg)하며 채우지 않음",
        "window_quality": window_quality_all,
        "readme_claims_unverified": README_CLAIMS_UNVERIFIED,
        "accept_quality_issues": accept_quality_issues, "price_proxies": market.price_proxies,
        "mmr": mmr, "mmr_source": mmr_source,
        "cost_profiles": {k: {"cost": v["cost"].to_dict(), "venue_fees": v["venue_fees"],
                              "venue_fee_source": v["venue_fee_source"]} for k, v in profs.items()},
        "created_at": datetime.now(timezone.utc).isoformat(), "live_orders": 0,
    }
    f = out / "meta.json"
    atomic_write_json(f, meta, overwrite=False)
    files.append(f)
    f = out / "summary.json"
    atomic_write_json(f, summary_rows, overwrite=False)
    files.append(f)
    pd.DataFrame(summary_rows).to_csv(out / "summary.csv", index=False)
    files.append(out / "summary.csv")
    write_manifest(out, files, {"run_id": run_id})
    return out


def comparable(result_dir: Path) -> list:
    """재현성 비교용: 실행 시각·경로처럼 매번 바뀌는 값을 뺀 결과 목록."""
    rows = read_json(Path(result_dir) / "summary.json")
    return rows


ALL_LEVERAGES = list(ALLOWED_LEVERAGES)
DEFAULT_CAPITAL_KRW = DEFAULT_STRATEGY_CAPITAL_KRW

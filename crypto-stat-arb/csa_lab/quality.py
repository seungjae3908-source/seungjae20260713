"""데이터 품질 검사: 중복·누락·비정상 가격·최신성."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

HOUR_MS = 3_600_000


class DataQualityError(RuntimeError):
    """전략 평가를 막아야 하는 데이터 결함."""


def normalize_ts_ms(ts: pd.Series) -> pd.Series:
    """초/밀리초/마이크로초 혼재를 UTC 밀리초 정수로 맞춘다."""
    s = pd.to_numeric(ts, errors="raise").astype("int64")
    us = s > 10**14
    sec = s < 10**11
    s = s.where(~us, s // 1000)
    s = s.where(~sec, s * 1000)
    return s


@dataclass
class QualityReport:
    name: str
    rows: int
    start: Optional[str]
    end: Optional[str]
    duplicates_identical: int = 0
    duplicates_conflicting: int = 0
    missing_intervals: int = 0
    missing_ranges: list = field(default_factory=list)
    nonpositive_prices: int = 0
    ohlc_inconsistent: int = 0
    outlier_jumps: int = 0
    stale_seconds: Optional[float] = None
    blocking: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.blocking

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["ok"] = self.ok
        d["missing_ranges"] = self.missing_ranges[:20]
        return d


def _iso(ms: int) -> str:
    return pd.Timestamp(int(ms), unit="ms", tz="UTC").isoformat()


def check_ohlcv(df: pd.DataFrame, name: str, interval_ms: int = HOUR_MS, *, now_ms: Optional[int] = None,
                max_stale_ms: Optional[int] = None, max_abs_log_jump: float = 0.25,
                max_missing_ratio: float = 0.001) -> tuple[pd.DataFrame, QualityReport]:
    """정렬·중복 제거된 프레임과 보고서를 돌려준다. 막아야 할 결함은 report.blocking 에 기록."""
    if df.empty:
        rep = QualityReport(name, 0, None, None)
        rep.blocking.append("EMPTY")
        return df, rep
    d = df.copy()
    d["ts"] = normalize_ts_ms(d["ts"])
    d = d.sort_values("ts", kind="mergesort")
    dup_mask = d.duplicated("ts", keep=False)
    rep = QualityReport(name, 0, None, None)
    if dup_mask.any():
        grp = d[dup_mask].groupby("ts")
        cols = [c for c in ("open", "high", "low", "close") if c in d.columns]
        conflicting = int((grp[cols].nunique() > 1).any(axis=1).sum())
        rep.duplicates_conflicting = conflicting
        rep.duplicates_identical = int(dup_mask.sum() - grp.ngroups)
        if conflicting:
            rep.blocking.append(f"CONFLICTING_DUPLICATES:{conflicting}")
    d = d.drop_duplicates("ts", keep="first").reset_index(drop=True)
    rep.rows = len(d)
    rep.start, rep.end = _iso(d["ts"].iloc[0]), _iso(d["ts"].iloc[-1])
    if (d["ts"] % interval_ms != 0).any():
        rep.blocking.append("MISALIGNED_TIMESTAMPS")
    gaps = d["ts"].diff().dropna()
    gap_idx = gaps[gaps > interval_ms].index
    missing = 0
    for i in gap_idx:
        n = int(gaps[i] // interval_ms) - 1
        missing += n
        rep.missing_ranges.append([_iso(d["ts"][i - 1] + interval_ms), _iso(d["ts"][i] - interval_ms), n])
    rep.missing_intervals = missing
    expected = int((d["ts"].iloc[-1] - d["ts"].iloc[0]) // interval_ms) + 1
    if expected > 0 and missing / expected > max_missing_ratio:
        rep.blocking.append(f"MISSING_RATIO:{missing}/{expected}")
    price_cols = [c for c in ("open", "high", "low", "close") if c in d.columns]
    vals = d[price_cols].astype(float)
    rep.nonpositive_prices = int(((vals <= 0) | ~np.isfinite(vals)).any(axis=1).sum())
    if rep.nonpositive_prices:
        rep.blocking.append(f"NONPOSITIVE_PRICE:{rep.nonpositive_prices}")
    if set(("open", "high", "low", "close")) <= set(d.columns):
        hi_bad = vals["high"] < vals[["open", "close"]].max(axis=1) - 1e-9
        lo_bad = vals["low"] > vals[["open", "close"]].min(axis=1) + 1e-9
        rep.ohlc_inconsistent = int((hi_bad | lo_bad).sum())
        if rep.ohlc_inconsistent:
            rep.blocking.append(f"OHLC_INCONSISTENT:{rep.ohlc_inconsistent}")
    if "close" in d.columns and len(d) > 1:
        lr = np.log(vals["close"].clip(lower=1e-12)).diff().abs()
        rep.outlier_jumps = int((lr > max_abs_log_jump).sum())
        if rep.outlier_jumps:
            rep.blocking.append(f"OUTLIER_JUMPS:{rep.outlier_jumps}")
    if now_ms is not None:
        rep.stale_seconds = (now_ms - int(d["ts"].iloc[-1]) - interval_ms) / 1000.0
        if max_stale_ms is not None and (now_ms - int(d["ts"].iloc[-1])) > max_stale_ms:
            rep.blocking.append(f"STALE:{rep.stale_seconds:.0f}s")
    return d, rep


def check_funding(df: pd.DataFrame, name: str, *, max_abs_rate: float = 0.03, now_ms: Optional[int] = None,
                  max_stale_ms: Optional[int] = None, expected_interval_ms: Optional[int] = 8 * HOUR_MS
                  ) -> tuple[pd.DataFrame, QualityReport]:
    if df.empty:
        rep = QualityReport(name, 0, None, None)
        rep.blocking.append("EMPTY")
        return df, rep
    d = df.copy()
    d["ts"] = normalize_ts_ms(d["ts"])
    # 펀딩 정산 시각은 수 ms 늦게 찍히는 경우가 있어 분 단위로 내림 정렬
    d["ts"] = (d["ts"] // 60_000) * 60_000
    d = d.sort_values("ts", kind="mergesort")
    rep = QualityReport(name, 0, None, None)
    dup = d.duplicated("ts", keep=False)
    if dup.any():
        conflicting = int((d[dup].groupby("ts")["rate"].nunique() > 1).sum())
        rep.duplicates_conflicting = conflicting
        rep.duplicates_identical = int(dup.sum()) - int(d[dup]["ts"].nunique())
        if conflicting:
            rep.blocking.append(f"CONFLICTING_DUPLICATES:{conflicting}")
    d = d.drop_duplicates("ts", keep="first").reset_index(drop=True)
    rep.rows = len(d)
    rep.start, rep.end = _iso(d["ts"].iloc[0]), _iso(d["ts"].iloc[-1])
    rates = d["rate"].astype(float)
    bad = (~np.isfinite(rates)) | (rates.abs() > max_abs_rate)
    rep.outlier_jumps = int(bad.sum())
    if rep.outlier_jumps:
        rep.blocking.append(f"FUNDING_OUT_OF_RANGE:{rep.outlier_jumps}")
    if expected_interval_ms:
        gaps = d["ts"].diff().dropna()
        big = gaps[gaps > expected_interval_ms * 1.5]
        rep.missing_intervals = int(sum(int(g // expected_interval_ms) - 1 for g in big))
        for i in big.index[:20]:
            rep.missing_ranges.append([_iso(d["ts"][i - 1]), _iso(d["ts"][i]), int(big[i] // expected_interval_ms) - 1])
        if rep.missing_intervals > 0:
            rep.blocking.append(f"FUNDING_GAPS:{rep.missing_intervals}")
    if now_ms is not None:
        rep.stale_seconds = (now_ms - int(d["ts"].iloc[-1])) / 1000.0
        if max_stale_ms is not None and now_ms - int(d["ts"].iloc[-1]) > max_stale_ms:
            rep.blocking.append(f"STALE:{rep.stale_seconds:.0f}s")
    return d, rep


def require_ok(*reports: QualityReport) -> None:
    bad = {r.name: r.blocking for r in reports if not r.ok}
    if bad:
        raise DataQualityError(f"데이터 결함으로 전략 평가 중단: {bad}")

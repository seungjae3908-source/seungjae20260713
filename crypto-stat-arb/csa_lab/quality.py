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
    # 연속 구간별 실제 공시 간격(시간). 예: 하이퍼리퀴드 펀딩이 초기에는 8시간, 이후 1시간 간격이면 두 구간으로 나뉜다.
    cadence_segments: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.blocking

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["ok"] = self.ok
        d["missing_ranges"] = self.missing_ranges[:20]
        d["cadence_segments"] = self.cadence_segments[:20]
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
    rep.cadence_segments = cadence_segments(d["ts"])
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


def cadence_segments(ts: pd.Series, *, min_rows: int = 3) -> list:
    """정렬·중복 제거된 ts 를 연속 간격(시간 단위 반올림)별로 묶는다. [시작, 끝, 간격(h), 행수]."""
    t = ts.to_numpy(dtype="int64")
    if len(t) < 2:
        return []
    hours = np.rint(np.diff(t) / HOUR_MS).astype("int64")
    segs = []
    start = 0
    for i in range(1, len(hours) + 1):
        if i == len(hours) or hours[i] != hours[start]:
            rows = i - start + 1
            if rows >= min_rows:
                segs.append([_iso(t[start]), _iso(t[i]), int(hours[start]), int(rows)])
            start = i
    return segs


@dataclass
class WindowQualityReport:
    """한 평가 창(start 포함, end 미포함) 안에서 한 데이터셋의 실제 보유 범위와 결함.

    status: OK / INCOMPLETE(원본 데이터가 창 일부 또는 전부에 없음, 또는 기대 주기보다 성긴 공시) / BLOCKED(값 결함).
    결측은 채우지 않는다. INCOMPLETE 인 창은 비용 반영 평가에 쓰지 않는다.
    """
    name: str
    source: str
    window_start: str
    window_end: str
    expected_interval_hours: float
    rows_in_window: int = 0
    first_in_window: Optional[str] = None
    last_in_window: Optional[str] = None
    expected_rows: int = 0
    missing_intervals: int = 0           # 창 안쪽 결측(첫 행~마지막 행 사이)
    missing_ranges: list = field(default_factory=list)
    lead_missing_hours: float = 0.0      # 창 시작 ~ 첫 행
    tail_missing_hours: float = 0.0      # 마지막 행 ~ 창 끝
    observed_median_interval_hours: Optional[float] = None
    cadence_mismatch_intervals: int = 0  # 기대 주기의 1.5배를 넘는 간격 수
    coarse_segments: list = field(default_factory=list)  # 창 안에서 기대 주기보다 성긴 연속 구간 [시작, 끝, 간격(h), 행수]
    coverage_ratio: float = 0.0          # 실제 행수 / 기대 행수
    defects: list = field(default_factory=list)
    status: str = "INCOMPLETE"
    reasons: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "OK"

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["ok"] = self.ok
        d["missing_ranges"] = self.missing_ranges[:20]
        return d


def _ohlcv_defects(vals: pd.DataFrame, max_abs_log_jump: float) -> list:
    out = []
    n_nonpos = int(((vals <= 0) | ~np.isfinite(vals)).any(axis=1).sum())
    if n_nonpos:
        out.append(f"NONPOSITIVE_PRICE:{n_nonpos}")
    if set(("open", "high", "low", "close")) <= set(vals.columns):
        hi_bad = vals["high"] < vals[["open", "close"]].max(axis=1) - 1e-9
        lo_bad = vals["low"] > vals[["open", "close"]].min(axis=1) + 1e-9
        n = int((hi_bad | lo_bad).sum())
        if n:
            out.append(f"OHLC_INCONSISTENT:{n}")
    if "close" in vals.columns and len(vals) > 1:
        lr = np.log(vals["close"].clip(lower=1e-12)).diff().abs()
        n = int((lr > max_abs_log_jump).sum())
        if n:
            out.append(f"OUTLIER_JUMPS:{n}")
    return out


def check_window(d: pd.DataFrame, name: str, start_ms: int, end_ms: int, interval_ms: int, *, source: str,
                 kind: str, max_missing_ratio: float = 0.0, gap_tolerance: float = 1.0,
                 max_abs_log_jump: float = 0.25, max_abs_rate: float = 0.03) -> WindowQualityReport:
    """check_ohlcv/check_funding 가 돌려준(정렬·중복 제거된) 프레임을 한 창에 대해 다시 검사한다.

    kind: "ohlcv" | "funding". 창별로 독립 판정하므로 다른 창의 결측이 이 창을 막지 않는다.
    - 창 시작 전에 데이터가 없으면(첫 행이 늦음) lead_missing_hours, 창 끝 전에 끊기면 tail_missing_hours.
    - 기대 주기보다 성긴 공시(예: 1시간 기대인데 8시간 간격)는 CADENCE_MISMATCH 로 INCOMPLETE. 1시간 데이터로 취급하지 않는다.
    - 값 결함(0 이하 가격, OHLC 모순, 급등락, 펀딩 범위 초과)은 BLOCKED.
    """
    if end_ms <= start_ms:
        raise ValueError("창 끝은 시작보다 커야 합니다")
    rep = WindowQualityReport(name, source, _iso(start_ms), _iso(end_ms), interval_ms / HOUR_MS)
    grid_start = -(-start_ms // interval_ms) * interval_ms  # 창 시작을 주기 격자로 올림
    rep.expected_rows = max(0, int((end_ms - 1 - grid_start) // interval_ms) + 1) if end_ms > grid_start else 0
    if d is None or d.empty or "ts" not in d.columns:
        rep.reasons.append("NO_DATA_IN_WINDOW")
        rep.lead_missing_hours = (end_ms - start_ms) / HOUR_MS
        return rep
    ts_all = d["ts"].to_numpy(dtype="int64")
    lo = int(np.searchsorted(ts_all, start_ms, side="left"))
    hi = int(np.searchsorted(ts_all, end_ms, side="left"))
    w = d.iloc[lo:hi]
    rep.rows_in_window = len(w)
    if rep.rows_in_window == 0:
        rep.reasons.append("NO_DATA_IN_WINDOW")
        rep.lead_missing_hours = (end_ms - start_ms) / HOUR_MS
        return rep
    ts = w["ts"].to_numpy(dtype="int64")
    rep.first_in_window, rep.last_in_window = _iso(ts[0]), _iso(ts[-1])
    rep.lead_missing_hours = max(0.0, (ts[0] - grid_start) / HOUR_MS)
    rep.tail_missing_hours = max(0.0, (end_ms - ts[-1] - interval_ms) / HOUR_MS)
    if len(ts) > 1:
        gaps = np.diff(ts)
        rep.observed_median_interval_hours = float(np.median(gaps) / HOUR_MS)
        big_idx = np.nonzero(gaps > interval_ms * gap_tolerance)[0]
        missing = 0
        for i in big_idx:
            n = int(gaps[i] // interval_ms) - 1
            if n <= 0:
                continue
            missing += n
            if len(rep.missing_ranges) < 20:
                rep.missing_ranges.append([_iso(ts[i] + interval_ms), _iso(ts[i + 1] - interval_ms), n])
        rep.missing_intervals = missing
        rep.cadence_mismatch_intervals = int(sum(1 for i in big_idx if gaps[i] >= interval_ms * 1.5))
        # 성긴 주기의 연속 구간(3행 이상)은 해당 주기의 데이터일 뿐 기대 주기 데이터가 아니다 → 창 전체를 INCOMPLETE 로 본다
        rep.coarse_segments = [seg for seg in cadence_segments(w["ts"])
                               if seg[2] * HOUR_MS >= interval_ms * 1.5][:20]
        if rep.coarse_segments:
            first = rep.coarse_segments[0]
            rep.reasons.append(f"CADENCE_MISMATCH:observed={first[2]:g}h_expected={interval_ms / HOUR_MS:g}h"
                               f":{first[0]}~{first[1]}({first[3]}rows,segments={len(rep.coarse_segments)})")
    rep.coverage_ratio = (rep.rows_in_window / rep.expected_rows) if rep.expected_rows else 0.0
    if rep.lead_missing_hours > (interval_ms / HOUR_MS) * gap_tolerance:
        rep.reasons.append(f"COVERAGE_STARTS_LATE:{rep.first_in_window}")
    if rep.tail_missing_hours > (interval_ms / HOUR_MS) * gap_tolerance:
        rep.reasons.append(f"COVERAGE_ENDS_EARLY:{rep.last_in_window}")
    total_missing = rep.expected_rows - rep.rows_in_window
    if rep.expected_rows and total_missing > 0 and total_missing / rep.expected_rows > max_missing_ratio:
        rep.reasons.append(f"MISSING_RATIO:{total_missing}/{rep.expected_rows}")
    if kind == "ohlcv":
        cols = [c for c in ("open", "high", "low", "close") if c in w.columns]
        rep.defects = _ohlcv_defects(w[cols].astype(float), max_abs_log_jump)
    elif kind == "funding":
        rates = w["rate"].astype(float)
        bad = int(((~np.isfinite(rates)) | (rates.abs() > max_abs_rate)).sum())
        if bad:
            rep.defects.append(f"FUNDING_OUT_OF_RANGE:{bad}")
    else:
        raise ValueError(f"알 수 없는 kind: {kind}")
    if rep.defects:
        rep.status = "BLOCKED"
        rep.reasons = rep.defects + rep.reasons
    elif rep.reasons:
        rep.status = "INCOMPLETE"
    else:
        rep.status = "OK"
    return rep

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
from .backtest import CARRY_ORIGINAL, XVENUE_ORIGINAL, MarketData, prepare_funding, run_backtest
from .costs import CostModel, CostRate
from .data import binance as bn
from .data import fx as fxmod
from .data import hyperliquid as hl
from .http import PublicHttpClient, RetryPolicy
from .leverage import ALLOWED_LEVERAGES, check_paper_leverage_against_venue, parse_leverage
from .money import (DEFAULT_STRATEGY_CAPITAL_KRW, AllocationLedger, FxMissingError, krw_to_margin_units,
                    margin_units_to_krw, require_fx)
from .quality import check_funding, check_ohlcv
from .storage import (Checkpoint, atomic_write_bytes, atomic_write_json, cleanup_partials, read_json, run_lock, sha256_file,
                      write_manifest)

HOUR_MS = 3_600_000
SYMBOL = "BTCUSDT"

# README 가 주장한 구간(README.md:72). 원본 코드는 이 구간을 실제로 쓰지 않는다.
WINDOWS = {
    "readme_train": ("2022-01-01", "2023-07-01"),
    "readme_test": ("2023-07-01", "2025-01-01"),
}


def cost_profiles(hl_mmr_source: str) -> dict:
    """비용 가정. status 가 CONFIRMED 가 아닌 값이 하나라도 있으면 순수익성은 '미검증'으로 표시된다."""
    original = {
        "cost": CostModel(
            CostRate("taker_fee", 0.0004, "원본 strategies/futures_curve/__init__.py DEFAULT_VENUE_COSTS binance taker 4bp",
                     "ORIGINAL_CONFIG"),
            CostRate("slippage", 0.0005, "원본 step4_futures_orchestrator.py 1039행 기본 슬리피지 5bp", "ORIGINAL_CONFIG"),
            CostRate("half_spread", 0.0, "원본은 bid_ask_spread 기본 0(step4 1364행) - 원본 설정 그대로", "ORIGINAL_CONFIG"),
            True, "실제 펀딩 이력(data.binance.vision fundingRate, Hyperliquid fundingHistory)"),
        "venue_fees": {"binance:perp": 0.0004, "binance:spot": 0.0004, "hyperliquid:perp": 0.00025},
        "venue_fee_source": "원본 DEFAULT_VENUE_COSTS / config/venues.yaml",
    }
    current = {
        "cost": CostModel(
            CostRate("taker_fee", 0.0005, "Binance USDT-M 일반(VIP0) 테이커 0.05% 공개 수수료표 - 이 환경에서 재확인 못함",
                     "ASSUMED"),
            CostRate("slippage", 0.0005, "원본과 같은 5bp 가정(호가 깊이 데이터 없음)", "ASSUMED"),
            CostRate("half_spread", 0.0001, "BTC 무기한 호가 간격 가정 1bp(호가 이력 미수집)", "ASSUMED"),
            True, "실제 펀딩 이력(data.binance.vision fundingRate, Hyperliquid fundingHistory)"),
        "venue_fees": {"binance:perp": 0.0005, "binance:spot": 0.001, "hyperliquid:perp": 0.00045},
        "venue_fee_source": "Binance 선물 0.05%·현물 0.10%, Hyperliquid 0.045% (공개 기본 등급, 이 환경에서 재확인 못함: ASSUMED)",
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


def _client(min_interval: float = 0.05) -> PublicHttpClient:
    return PublicHttpClient(RetryPolicy(max_attempts=5, base_delay=1.0, max_delay=30.0, timeout=30.0),
                            min_interval=min_interval)


def _ms(day: str) -> int:
    return int(pd.Timestamp(day, tz="UTC").value // 1_000_000)


def collect(data_dir: Path, start: date, end: date, *, with_hyperliquid: bool = True, with_fx: bool = True,
            client: Optional[PublicHttpClient] = None) -> dict:
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


def _load_kind(raw: Path, kind: str) -> pd.DataFrame:
    files = sorted((raw / kind / SYMBOL).glob("*.parquet"))
    return bn.load_parquets(files)


def build_market(data_dir: Path, *, now_ms: Optional[int] = None) -> tuple[MarketData, dict]:
    raw = Paths(Path(data_dir)).raw
    quality = {}
    frames = {}
    for kind, leg in (("klines", "binance_perp"), ("spotKlines", "binance_spot"), ("markPriceKlines", "binance_perp_mark")):
        df = _load_kind(raw, kind)
        d, rep = check_ohlcv(df, f"{kind}:{SYMBOL}", max_missing_ratio=0.01)
        quality[rep.name] = rep.to_dict()
        frames[leg] = d.set_index("ts")
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
    fh_files = sorted((raw / "hyperliquid").glob("BTC-funding-*.parquet"))
    fh_raw = bn.load_parquets(fh_files)
    if not fh_raw.empty:
        fh, rep = check_funding(fh_raw, "hyperliquid:BTC funding", expected_interval_ms=HOUR_MS)
        quality[rep.name] = rep.to_dict()
    else:
        fh = fh_raw
        quality["hyperliquid:BTC funding"] = {"ok": False, "blocking": ["EMPTY"]}
    market = MarketData(bars, {"binance": prepare_funding(fb, 8), "hyperliquid": prepare_funding(fh, 1)},
                        {"hl_perp": "Binance USDT-M BTCUSDT 1시간봉을 하이퍼리퀴드 가격 대용으로 사용(펀딩은 실제 하이퍼리퀴드 이력)",
                         "binance_perp_mark": mark_note})
    return market, quality


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
              accept_quality_issues: bool = False) -> Path:
    """여러 전략·구간·비용·레버리지 조합을 실행해 새 결과 디렉터리에 저장(덮어쓰지 않음)."""
    levs = [parse_leverage(l) for l in leverages]
    market, quality = build_market(data_dir)
    quality_blocking = {k: v.get("blocking") for k, v in quality.items() if v.get("blocking")}
    fx = load_fx(data_dir)
    hl_meta_f = Paths(Path(data_dir)).raw / "hyperliquid" / "meta_btc.json"
    hl_meta = read_json(hl_meta_f) if hl_meta_f.exists() else {}
    hl_max = hl_meta.get("max_leverage")
    hl_mmr = (1.0 / (2.0 * hl_max)) if hl_max else 0.0125
    mmr = {"binance": 0.004, "hyperliquid": hl_mmr}
    mmr_source = {
        "binance": "BTCUSDT 1구간(명목 5만 USDT 미만) 유지증거금률 0.40% - 공개 문서 기준 가정, 이 환경에서 재확인 못함(ASSUMED)",
        "hyperliquid": (f"maxLeverage {hl_max}(공개 meta 확인) → 유지증거금률 = 1/(2×maxLeverage) 문서 공식 적용(공식은 ASSUMED)"
                        if hl_max else "meta 미확인 → 1.25% 가정(ASSUMED)"),
    }
    profs = cost_profiles(mmr_source["hyperliquid"])
    params_map = {"carry_binance": CARRY_ORIGINAL, "xvenue_funding": XVENUE_ORIGINAL}
    config = {"leverages": levs, "capital_krw": capital_krw, "windows": windows, "strategies": strategies,
              "profiles": profiles, "label": label, "accept_quality_issues": accept_quality_issues}
    fp = data_fingerprint(data_dir)
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{label}-{_hash_obj(config)}-{fp}"
    out = Path(results_dir) / run_id
    out.mkdir(parents=True, exist_ok=False)
    files = []
    summary_rows = []
    ledger = AllocationLedger(capital_krw * len(strategies))
    for s in strategies:
        ledger.allocate(s, capital_krw)  # 전략마다 별도 50만원. 같은 돈을 두 전략이 쓰지 않음
    for wname, (ws, we) in windows.items():
        fx_start = pick_fx(fx, ws)
        last_day = str((pd.Timestamp(we) - pd.Timedelta(days=1)).date())
        fx_end = pick_fx(fx, last_day)
        for s in strategies:
            for prof in profiles:
                pr = profs[prof]
                for lev in levs:
                    row = {"window": wname, "strategy": s, "cost_profile": prof, "leverage": lev}
                    if quality_blocking and not accept_quality_issues:
                        row.update(status="BLOCKED_DATA_QUALITY", error=json.dumps(quality_blocking, ensure_ascii=False))
                        summary_rows.append(row)
                        continue
                    try:
                        q = require_fx(fx_start, max_age_seconds=None)
                    except FxMissingError as e:
                        row.update(status="BLOCKED_FX_MISSING", error=str(e))
                        summary_rows.append(row)
                        continue
                    capital_units = krw_to_margin_units(capital_krw, q)
                    try:
                        res = run_backtest(market, params_map[s], leverage=lev, capital=capital_units, cost=pr["cost"],
                                           venue_fees=pr["venue_fees"], mmr=mmr, start_ms=_ms(ws), end_ms=_ms(we),
                                           stale_funding_hours={"binance": 9, "hyperliquid": 2})
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
                    }
                    res["venue_leverage_status"] = [
                        check_paper_leverage_against_venue(lev, "binance", "BTCUSDT-PERP"),
                        check_paper_leverage_against_venue(lev, "hyperliquid", "BTC-PERP"),
                    ]
                    res["mmr_source"] = mmr_source
                    res["mode"] = "BACKTEST_PAPER_ONLY"
                    res["live_orders"] = 0
                    f = out / "runs" / wname / s / prof / f"lev{lev}.json"
                    atomic_write_json(f, res, overwrite=False)
                    files.append(f)
                    row.update(status="OK", capital_units=capital_units, fx=q.krw_per_unit, fx_unit=q.unit,
                               net_pnl_units=m["net_pnl"], net_return=m["net_return"],
                               net_pnl_krw_start_fx=margin_units_to_krw(m["net_pnl"], q) if m["net_pnl"] != 0 else 0.0,
                               max_notional_per_leg=m["max_notional_per_leg"], fees=m["fees_total"],
                               funding=m["funding_pnl"], slippage=m["slippage"], spread=m["spread"],
                               mdd=m["max_drawdown"], sharpe=m["sharpe_hourly_annualized"], trades=m["trades"],
                               win_rate_net=m["win_rate_net"], pf_net=m["profit_factor_net"],
                               avg_hold_h=m["avg_hold_hours"], liquidations=m["liquidations"],
                               blocked_stale_hours=m["blocked_stale_hours"],
                               all_costs_confirmed=res["cost_model"]["all_costs_confirmed"])
                    summary_rows.append(row)
    meta = {
        "run_id": run_id, "label": label, "config": config, "code_version": __version__, "git_sha": _git_sha(),
        "python": platform.python_version(), "pandas": pd.__version__,
        "data_fingerprint": fp, "data_quality": quality, "quality_blocking": quality_blocking,
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

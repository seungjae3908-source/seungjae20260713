"""장시간 무주문(PAPER) 운영 실행기.

주기마다: 공개 데이터 수집 → 품질·최신성 검사 → 신호 평가 → PAPER 장부 갱신 → 상태·건강 지표 기록.
- 주문 경로 없음. 모든 기록에 live_orders=0.
- 단일 실행 잠금, 주기 키로 중복 결과 방지, 상태 파일 원자 저장으로 재시작 후 이어서 실행.
- 연속 실패 한도·메모리·디스크 한도를 넘으면 오류 상태로 안전 종료(무한 재시도 없음).
"""
from __future__ import annotations

import os
import shutil
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import pandas as pd
import psutil

from .backtest import XVENUE_ORIGINAL, annualized_funding, prepare_funding
from .data import binance as bn
from .data import fx as fxmod
from .data import hyperliquid as hl
from .http import PublicHttpClient, RetryPolicy
from .logsafe import setup_logger
from .quality import check_funding, check_ohlcv
from .storage import atomic_write_json, cleanup_partials, read_json, run_lock

HOUR_MS = 3_600_000


class SoakAbort(RuntimeError):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def fetch_snapshot(client: PublicHttpClient, now_ms: int) -> dict:
    """소스별로 독립 수집. 한 소스 실패가 다른 소스를 막지 않도록 각각 기록."""
    snap: dict = {"sources": {}}
    start = now_ms - 3 * 24 * HOUR_MS
    jobs: dict[str, Callable] = {
        "hl_funding": lambda: hl.funding_history(client, "BTC", start, now_ms),
        "hl_candles": lambda: hl.candles(client, "BTC", start, now_ms),
        "binance_funding": lambda: bn.fetch_recent_funding(client, "BTCUSDT", start, now_ms),
        "binance_klines": lambda: bn.fetch_recent_klines(client, "BTCUSDT", start, now_ms),
        "fx_upbit": lambda: fxmod.upbit_usdt_latest(client),
    }
    for name, fn in jobs.items():
        t0 = time.time()
        try:
            val = fn()
            snap[name] = val
            snap["sources"][name] = {"ok": True, "ms": int((time.time() - t0) * 1000),
                                     "rows": (len(val) if isinstance(val, pd.DataFrame) else 1 if val else 0)}
        except Exception as e:
            snap[name] = None
            snap["sources"][name] = {"ok": False, "ms": int((time.time() - t0) * 1000),
                                     "error": f"{type(e).__name__}: {str(e)[:300]}"}
    return snap


def evaluate(snap: dict, now_ms: int) -> dict:
    """데이터가 모두 최신·정상일 때만 신호를 계산한다. 아니면 BLOCKED 와 사유."""
    blockers = []
    quality = {}
    hf = snap.get("hl_funding")
    bf = snap.get("binance_funding")
    if hf is None or len(hf) == 0:
        blockers.append("HL_FUNDING_UNAVAILABLE")
    else:
        _, r = check_funding(hf, "hl_funding", now_ms=now_ms, max_stale_ms=2 * HOUR_MS, expected_interval_ms=HOUR_MS)
        quality["hl_funding"] = r.to_dict()
        blockers += [f"hl_funding:{b}" for b in r.blocking]
    if bf is None or len(bf) == 0:
        blockers.append("BINANCE_FUNDING_UNAVAILABLE")
    else:
        _, r = check_funding(bf, "binance_funding", now_ms=now_ms, max_stale_ms=9 * HOUR_MS,
                             expected_interval_ms=8 * HOUR_MS)
        quality["binance_funding"] = r.to_dict()
        blockers += [f"binance_funding:{b}" for b in r.blocking]
    hc = snap.get("hl_candles")
    if hc is None or len(hc) == 0:
        blockers.append("HL_CANDLES_UNAVAILABLE")
    else:
        closed = hc[hc["ts"] + HOUR_MS <= now_ms]
        _, r = check_ohlcv(closed, "hl_candles", now_ms=now_ms, max_stale_ms=2 * HOUR_MS + 5 * 60_000)
        quality["hl_candles"] = r.to_dict()
        blockers += [f"hl_candles:{b}" for b in r.blocking]
    if snap.get("fx_upbit") is None:
        blockers.append("FX_MISSING")
    out = {"quality": quality, "blockers": blockers}
    if blockers:
        out["status"] = "BLOCKED"
        return out
    fb = prepare_funding(bf, 8)
    fh = prepare_funding(hf, 1)
    ann_b, _ = annualized_funding(fb, now_ms, XVENUE_ORIGINAL.lookback_hours)
    ann_h, _ = annualized_funding(fh, now_ms, XVENUE_ORIGINAL.lookback_hours)
    if ann_b is None or ann_h is None:
        out.update(status="BLOCKED", blockers=["FUNDING_WINDOW_EMPTY"])
        return out
    out.update(status="EVALUATED", ann_binance=ann_b, ann_hyperliquid=ann_h, signal=ann_b - ann_h,
               hl_last_close=float(hc["close"].iloc[-1]), fx_krw_per_usdt=snap["fx_upbit"].krw_per_unit)
    return out


def paper_step(state: dict, ev: dict, now_ms: int) -> dict:
    """PAPER 장부 상태 전이. 실제 주문 없음."""
    pos = state.get("paper_position")
    action = "HOLD_FLAT" if pos is None else "HOLD_OPEN"
    if ev["status"] != "EVALUATED":
        return {"action": "NO_EVAL", "live_orders": 0}
    sig = ev["signal"]
    if pos is None and abs(sig) > XVENUE_ORIGINAL.entry_annualized:
        state["paper_position"] = {"dir": 1 if sig > 0 else -1, "opened_ms": now_ms, "entry_signal": sig,
                                   "entry_price": ev["hl_last_close"]}
        action = "PAPER_OPEN"
    elif pos is not None:
        held_h = (now_ms - pos["opened_ms"]) / HOUR_MS
        if pos["dir"] * sig <= XVENUE_ORIGINAL.exit_annualized or held_h >= (XVENUE_ORIGINAL.max_hold_hours or 1e18):
            state.setdefault("paper_closed", []).append({**pos, "closed_ms": now_ms, "exit_signal": sig})
            state["paper_position"] = None
            action = "PAPER_CLOSE"
    return {"action": action, "live_orders": 0}


def health(root: Path, proc: psutil.Process) -> dict:
    du = shutil.disk_usage(root)
    size = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())
    return {"rss_mb": round(proc.memory_info().rss / 1e6, 1), "cpu_percent": proc.cpu_percent(None),
            "open_fds": proc.num_fds() if hasattr(proc, "num_fds") else None,
            "disk_free_mb": round(du.free / 1e6, 1), "soak_dir_mb": round(size / 1e6, 2), "pid": proc.pid}


def run_soak(root: Path, *, duration_s: float, interval_s: float, max_consecutive_failures: int = 6,
             max_rss_mb: float = 1500, min_disk_free_mb: float = 500, client: Optional[PublicHttpClient] = None,
             now_fn: Callable[[], int] = _now_ms, sleep_fn: Callable[[float], None] = time.sleep,
             stop_after_cycles: Optional[int] = None) -> dict:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    log = setup_logger("soak", root / "logs", max_bytes=1_000_000, backups=3, console=False)
    state_path = root / "state.json"
    cycles_dir = root / "cycles"
    stop = {"flag": False}

    def _term(signum, frame):
        stop["flag"] = True

    old = signal.signal(signal.SIGTERM, _term)
    try:
        with run_lock(root / ".soak.lock"):
            cleanup_partials(root)
            state = read_json(state_path) if state_path.exists() else {
                "created_ms": now_fn(), "starts": 0, "cycles_done": 0, "consecutive_failures": 0,
                "status": "RUNNING", "paper_position": None, "paper_closed": []}
            state["starts"] += 1
            state["status"] = "RUNNING"
            state["last_start_ms"] = now_fn()
            atomic_write_json(state_path, state)
            log.info("soak start #%d (재시작 시 상태 이어받음, cycles_done=%d)", state["starts"], state["cycles_done"])
            proc = psutil.Process()
            proc.cpu_percent(None)
            cli = client or PublicHttpClient(RetryPolicy(max_attempts=3, base_delay=2, max_delay=20, timeout=20))
            t_start = time.time()
            n_this_run = 0
            while not stop["flag"] and time.time() - t_start < duration_s:
                now = now_fn()
                key = str((now // int(interval_s * 1000)) * int(interval_s * 1000))
                cyc_file = cycles_dir / f"{key}.json"
                if cyc_file.exists():
                    state["duplicate_cycle_skips"] = state.get("duplicate_cycle_skips", 0) + 1
                    log.info("중복 주기 건너뜀 %s", key)
                else:
                    t0 = time.time()
                    snap = fetch_snapshot(cli, now)
                    ev = evaluate(snap, now)
                    act = paper_step(state, ev, now)
                    all_failed = not any(s["ok"] for s in snap["sources"].values())
                    state["consecutive_failures"] = state["consecutive_failures"] + 1 if all_failed else 0
                    h = health(root, proc)
                    rec = {"cycle_key": key, "ts": datetime.fromtimestamp(now / 1000, timezone.utc).isoformat(),
                           "sources": snap["sources"], "evaluation": {k: v for k, v in ev.items() if k != "quality"},
                           "quality_blocking": {k: v.get("blocking") for k, v in ev.get("quality", {}).items()},
                           "paper": act, "health": h, "duration_ms": int((time.time() - t0) * 1000),
                           "live_orders": 0}
                    atomic_write_json(cyc_file, rec, overwrite=False)
                    state["cycles_done"] += 1
                    state["last_cycle"] = {"key": key, "status": ev["status"], "action": act["action"]}
                    atomic_write_json(state_path, state)
                    log.info("cycle %s status=%s action=%s blockers=%s rss=%.1fMB", key, ev["status"],
                             act["action"], ev.get("blockers"), h["rss_mb"])
                    n_this_run += 1
                    if state["consecutive_failures"] >= max_consecutive_failures:
                        state["status"] = "ERROR_SOURCES_DOWN"
                        atomic_write_json(state_path, state)
                        log.error("모든 소스 연속 실패 %d회 → 오류 상태로 종료", state["consecutive_failures"])
                        break
                    if h["rss_mb"] > max_rss_mb or h["disk_free_mb"] < min_disk_free_mb:
                        state["status"] = "ABORTED_RESOURCE_LIMIT"
                        atomic_write_json(state_path, state)
                        log.error("자원 한도 초과 rss=%s disk_free=%s → 안전 종료", h["rss_mb"], h["disk_free_mb"])
                        break
                if stop_after_cycles is not None and n_this_run >= stop_after_cycles:
                    break
                # 다음 주기까지 대기(정지 신호를 1초 단위로 확인)
                next_boundary = (now // int(interval_s * 1000) + 1) * int(interval_s * 1000)
                wait = max(0.0, (next_boundary - now_fn()) / 1000.0)
                end_wait = time.time() + wait
                while not stop["flag"] and time.time() < end_wait and time.time() - t_start < duration_s:
                    sleep_fn(min(1.0, max(0.0, end_wait - time.time())))
            if state["status"] == "RUNNING":
                state["status"] = "STOPPED_SIGTERM" if stop["flag"] else "COMPLETED_DURATION"
            state["last_stop_ms"] = now_fn()
            atomic_write_json(state_path, state)
            log.info("soak stop status=%s", state["status"])
            return state
    finally:
        signal.signal(signal.SIGTERM, old)


def summarize(root: Path) -> dict:
    root = Path(root)
    recs = []
    for f in sorted((root / "cycles").glob("*.json")):
        recs.append(read_json(f))
    state = read_json(root / "state.json") if (root / "state.json").exists() else {}
    if not recs:
        return {"cycles": 0, "state": state}
    df = pd.DataFrame([{"ts": r["ts"], "status": r["evaluation"].get("status"), "action": r["paper"]["action"],
                        "rss": r["health"]["rss_mb"], "disk_free": r["health"]["disk_free_mb"],
                        "dir_mb": r["health"]["soak_dir_mb"], "dur": r["duration_ms"],
                        "all_fail": not any(s["ok"] for s in r["sources"].values())} for r in recs])
    src_fail = {}
    for r in recs:
        for k, v in r["sources"].items():
            src_fail.setdefault(k, [0, 0])
            src_fail[k][0] += 0 if v["ok"] else 1
            src_fail[k][1] += 1
    first, last = pd.Timestamp(df["ts"].iloc[0]), pd.Timestamp(df["ts"].iloc[-1])
    blockers = {}
    for r in recs:
        for b in r["evaluation"].get("blockers") or []:
            k = ":".join(b.split(":")[:2])
            blockers[k] = blockers.get(k, 0) + 1
    return {
        "cycles": len(df), "first_cycle": str(first), "last_cycle": str(last),
        "covered_hours": round((last - first).total_seconds() / 3600, 2),
        "status_counts": df["status"].value_counts().to_dict(),
        "paper_actions": df["action"].value_counts().to_dict(),
        "source_failure_rate": {k: round(a / b, 4) for k, (a, b) in src_fail.items()},
        "all_sources_failed_cycles": int(df["all_fail"].sum()),
        "rss_mb": {"first": float(df["rss"].iloc[0]), "last": float(df["rss"].iloc[-1]), "max": float(df["rss"].max())},
        "disk_free_mb": {"first": float(df["disk_free"].iloc[0]), "min": float(df["disk_free"].min())},
        "soak_dir_mb_last": float(df["dir_mb"].iloc[-1]),
        "cycle_duration_ms": {"median": float(df["dur"].median()), "max": float(df["dur"].max())},
        "blocker_counts": blockers,
        "starts": state.get("starts"), "duplicate_cycle_skips": state.get("duplicate_cycle_skips", 0),
        "final_status": state.get("status"), "paper_open_now": state.get("paper_position"),
        "paper_closed": len(state.get("paper_closed", [])), "live_orders": 0,
        "log_files": sorted(p.name for p in (root / "logs").glob("*")),
        "log_bytes_total": sum(p.stat().st_size for p in (root / "logs").glob("*")),
    }

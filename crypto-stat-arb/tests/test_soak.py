"""장시간 실행기: 재시작 복구, 중복 방지, 소스 장애 시 차단·오류 종료, 잠금, 주문 0건."""
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from csa_lab import soak
from csa_lab.money import FxQuote
from csa_lab.storage import LockBusyError, read_json, run_lock

H = 3_600_000


def fresh_snapshot(client, now_ms, b_rate=0.0003, h_rate=0.0):
    start = now_ms - 3 * 24 * H
    base = now_ms - now_ms % H
    hf = pd.DataFrame({"ts": [base - i * H for i in range(72)][::-1], "rate": h_rate})
    b0 = now_ms - now_ms % (8 * H)
    bf = pd.DataFrame({"ts": [b0 - i * 8 * H for i in range(9)][::-1], "rate": b_rate})
    hc = pd.DataFrame({"ts": [base - (i + 1) * H for i in range(72)][::-1], "open": 100.0, "high": 101.0,
                       "low": 99.0, "close": 100.0, "volume": 1.0})
    fx = FxQuote(1380.0, "USDT", "test", datetime.now(timezone.utc))
    srcs = {k: {"ok": True, "ms": 1, "rows": 1} for k in ("hl_funding", "hl_candles", "binance_funding",
                                                           "binance_klines", "fx_upbit")}
    return {"sources": srcs, "hl_funding": hf, "binance_funding": bf, "hl_candles": hc, "binance_klines": None,
            "fx_upbit": fx}


def dead_snapshot(client, now_ms):
    return {"sources": {k: {"ok": False, "ms": 1, "error": "HttpStatusError: HTTP 451"} for k in
                        ("hl_funding", "hl_candles", "binance_funding", "binance_klines", "fx_upbit")},
            "hl_funding": None, "binance_funding": None, "hl_candles": None, "binance_klines": None, "fx_upbit": None}


def test_soak_paper_cycles_restart_and_no_duplicates(tmp_path, monkeypatch):
    monkeypatch.setattr(soak, "fetch_snapshot", fresh_snapshot)
    st = soak.run_soak(tmp_path, duration_s=30, interval_s=0.05, stop_after_cycles=3)
    assert st["cycles_done"] == 3 and st["paper_position"]["dir"] == 1  # 바이낸스 펀딩이 높음 → PAPER 진입
    st2 = soak.run_soak(tmp_path, duration_s=30, interval_s=0.05, stop_after_cycles=2)
    assert st2["starts"] == 2 and st2["cycles_done"] == 5 and st2["paper_position"]["dir"] == 1
    recs = [read_json(f) for f in (tmp_path / "cycles").glob("*.json")]
    assert len(recs) == 5 and len({r["cycle_key"] for r in recs}) == 5
    assert all(r["live_orders"] == 0 for r in recs)
    summ = soak.summarize(tmp_path)
    assert summ["cycles"] == 5 and summ["live_orders"] == 0 and summ["starts"] == 2


def test_duplicate_cycle_key_skipped(tmp_path, monkeypatch):
    monkeypatch.setattr(soak, "fetch_snapshot", fresh_snapshot)
    fixed = 1_700_000_000_000
    st = soak.run_soak(tmp_path, duration_s=0.3, interval_s=3600, now_fn=lambda: fixed, sleep_fn=lambda s: None,
                       stop_after_cycles=None)
    st = soak.run_soak(tmp_path, duration_s=0.3, interval_s=3600, now_fn=lambda: fixed, sleep_fn=lambda s: None)
    assert st["cycles_done"] == 1 and st["duplicate_cycle_skips"] >= 1


def test_sources_down_blocks_then_errors_out(tmp_path, monkeypatch):
    monkeypatch.setattr(soak, "fetch_snapshot", dead_snapshot)
    st = soak.run_soak(tmp_path, duration_s=60, interval_s=0.02, max_consecutive_failures=4)
    assert st["status"] == "ERROR_SOURCES_DOWN" and st["cycles_done"] == 4
    assert st["paper_position"] is None


def test_stale_data_blocks_evaluation():
    now = 1_700_000_000_000
    snap = fresh_snapshot(None, now - 10 * H)  # 10시간 전 데이터
    ev = soak.evaluate(snap, now)
    assert ev["status"] == "BLOCKED" and any("STALE" in b for b in ev["blockers"])
    snap = fresh_snapshot(None, now)
    snap["fx_upbit"] = None
    assert "FX_MISSING" in soak.evaluate(snap, now)["blockers"]


def test_resource_limit_safe_shutdown(tmp_path, monkeypatch):
    monkeypatch.setattr(soak, "fetch_snapshot", fresh_snapshot)
    st = soak.run_soak(tmp_path, duration_s=60, interval_s=0.02, max_rss_mb=1)
    assert st["status"] == "ABORTED_RESOURCE_LIMIT"


def test_second_soak_process_blocked(tmp_path):
    with run_lock(tmp_path / ".soak.lock"):
        with pytest.raises(LockBusyError):
            soak.run_soak(tmp_path, duration_s=1, interval_s=1)


CHILD = r"""
import sys
sys.path.insert(0, {root!r})
sys.path.insert(0, {tests!r})
from csa_lab import soak
import test_soak as t
soak.fetch_snapshot = t.fresh_snapshot
soak.run_soak({d!r}, duration_s=600, interval_s=0.05)
"""


def _child(tmp_path):
    root = str(Path(__file__).resolve().parents[1])
    code = CHILD.format(root=root, tests=str(Path(__file__).resolve().parent), d=str(tmp_path))
    return subprocess.Popen([sys.executable, "-c", code])


def _wait_cycles(tmp_path, n, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if len(list((tmp_path / "cycles").glob("*.json"))) >= n:
            return
        time.sleep(0.1)
    raise AssertionError("cycles not produced")


def test_kill9_and_restart_recovers(tmp_path, monkeypatch):
    monkeypatch.setattr(soak, "fetch_snapshot", fresh_snapshot)
    p = _child(tmp_path)
    _wait_cycles(tmp_path, 3)
    p.send_signal(signal.SIGKILL)  # 비정상 종료 주입
    p.wait()
    n_before = len(list((tmp_path / "cycles").glob("*.json")))
    for f in (tmp_path / "cycles").glob("*.json"):
        read_json(f)  # 반쪽 파일이 없어야 함
    st = soak.run_soak(tmp_path, duration_s=30, interval_s=0.05, stop_after_cycles=2)
    assert st["starts"] == 2  # 이전 실행의 상태를 이어받음
    assert len(list((tmp_path / "cycles").glob("*.json"))) == n_before + 2
    assert not list(tmp_path.rglob(".*.part"))


def test_sigterm_graceful(tmp_path):
    p = _child(tmp_path)
    _wait_cycles(tmp_path, 2)
    p.send_signal(signal.SIGTERM)
    assert p.wait(timeout=20) == 0
    assert read_json(tmp_path / "state.json")["status"] == "STOPPED_SIGTERM"

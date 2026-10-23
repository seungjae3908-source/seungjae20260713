"""원본 저장소 코드를 수정 없이 실행하는 격리 실행기.

원본 저장소를 작업 디렉터리로 복사하고(원본 코드는 바꾸지 않음), 수집한 공개 데이터를
원본 로더가 읽는 형식(data/processed/...)으로 써 넣은 뒤 run_phase3.py 를 하위 프로세스로 실행한다.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from .storage import atomic_write_json, sha256_file, write_manifest

ORIGINAL_REPO_URL = "https://github.com/abailey81/Crypto-Statistical-Arbitrage"
ORIGINAL_PINNED_SHA = "44b718e4a4ef875ea12dfda30370ab1cc8b54a26"

# README.md 표에 적힌 값(원본 코드에서는 generate_visualizations.py 953-954, 1024행 상수로만 존재)
README_CLAIMS = {
    "sharpe_ratio": 5.81, "total_return_pct": 203.70, "max_drawdown_pct": 0.89,
    "win_rate_pct": 95.02, "total_trades": 44652, "profit_factor": 28.53,
}


def _git_head(repo: Path) -> Optional[str]:
    try:
        return subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None


def _write(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)


def write_original_format(work: Path, market_bars: pd.DataFrame, funding: dict) -> dict:
    """원본 _load_data 가 찾는 첫 번째 경로에 파일을 쓴다(phase3run.py 1498-1561행)."""
    proc = work / "data" / "processed"
    ts = pd.to_datetime(market_bars.index.to_numpy(), unit="ms", utc=True)
    ohlcv = pd.DataFrame({"timestamp": ts, "symbol": "BTC",
                          "open": market_bars["binance_perp_open"].to_numpy(),
                          "high": market_bars["binance_perp_high"].to_numpy(),
                          "low": market_bars["binance_perp_low"].to_numpy(),
                          "close": market_bars["binance_perp_close"].to_numpy(),
                          "volume": 0.0})
    written = {}
    for venue in ("binance", "hyperliquid"):
        f = funding.get(venue)
        if f is None or f.empty:
            continue
        fdf = pd.DataFrame({"timestamp": pd.to_datetime(f["ts"].to_numpy(), unit="ms", utc=True),
                            "symbol": "BTC", "funding_rate": f["rate"].to_numpy(dtype=float)})
        p1 = proc / "funding_rates" / venue / "funding_rates.parquet"
        p2 = proc / "ohlcv" / venue / "ohlcv.parquet"
        _write(fdf, p1)
        _write(ohlcv, p2)  # 하이퍼리퀴드 가격은 바이낸스 대용(원본 병합에 필요)
        written[venue] = {"funding_rows": len(fdf), "ohlcv_rows": len(ohlcv),
                          "ohlcv_note": "Binance BTCUSDT 1h" if venue == "binance" else "Binance BTCUSDT 1h 대용"}
    _write(ohlcv[["timestamp", "symbol", "close"]], proc / "binance" / "binance_ohlcv.parquet")
    return written


def run_original(original_repo: Path, market_bars: pd.DataFrame, funding: dict, out_dir: Path, *,
                 mode: str, start_date: str, end_date: str, timeout_s: int, python: str = sys.executable) -> dict:
    original_repo = Path(original_repo)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=False)
    head = _git_head(original_repo)
    work = out_dir / "work"
    shutil.copytree(original_repo, work, ignore=shutil.ignore_patterns(".git", "output", "processed"))
    written = write_original_format(work, market_bars, funding)
    result_dir = out_dir / "original_output"
    log_path = out_dir / "original_stdout.log"
    cmd = [python, "run_phase3.py", "--mode", mode, "--start-date", start_date, "--end-date", end_date,
           "-o", str(result_dir)]
    t0 = time.time()
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ("KEY", "SECRET", "TOKEN", "PASS"))}
    env["PYTHONHASHSEED"] = "0"
    timed_out = False
    with open(log_path, "wb") as logf:
        try:
            rc = subprocess.run(cmd, cwd=work, stdout=logf, stderr=subprocess.STDOUT, timeout=timeout_s, env=env).returncode
        except subprocess.TimeoutExpired:
            rc = None
            timed_out = True
    elapsed = time.time() - t0
    summary_path = result_dir / "execution_summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else None
    bt = (summary or {}).get("backtest") or {}
    produced = {
        "sharpe_ratio": bt.get("sharpe_ratio"), "total_return_pct": bt.get("total_return_pct"),
        "max_drawdown_pct": bt.get("max_drawdown_pct"), "win_rate_pct": bt.get("win_rate_pct"),
        "total_trades": bt.get("total_trades"), "profit_factor": bt.get("profit_factor"),
    }
    # 원본 출력 파일을 그대로 보관(덮어쓰지 않음)
    files = [log_path]
    if result_dir.exists():
        files += [p for p in result_dir.rglob("*") if p.is_file()]
    report = {
        "original_repo": ORIGINAL_REPO_URL, "original_head": head, "pinned_sha": ORIGINAL_PINNED_SHA,
        "head_matches_pin": head == ORIGINAL_PINNED_SHA, "code_modified": False,
        "mode": mode, "start_date": start_date, "end_date": end_date, "command": cmd,
        "exit_code": rc, "timed_out": timed_out, "elapsed_s": round(elapsed, 1), "data_written": written,
        "readme_claims": README_CLAIMS, "produced": produced,
        "backtest_summary_keys": sorted(bt.keys()) if bt else [],
        "notes": [
            "README 수치는 원본 코드의 결과 파일이 아니라 generate_visualizations.py 상수로만 존재",
            "원본은 예상수익을 진입 즉시 실현손익으로 기록(보유 0시간), 펀딩 정산 없음",
            "README 는 2022-2024 데이터·원본 수집 데이터 기반이라 공개 데이터 재실행 값과 일치를 기대할 수 없음",
        ],
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    atomic_write_json(out_dir / "original_run_report.json", report, overwrite=False)
    files.append(out_dir / "original_run_report.json")
    write_manifest(out_dir, files, {"kind": "original_run"})
    return report

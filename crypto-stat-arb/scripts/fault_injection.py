"""실제 공개 데이터 경로에서의 장애 주입 검사. 결과를 JSON 으로 출력(각 항목 PASS/FAIL).

사용: python scripts/fault_injection.py <기존 수집 디렉터리> <작업 디렉터리>
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from csa_lab.storage import read_json, sha256_file  # noqa: E402

PY = sys.executable


def cli(args, env=None, timeout=900):
    return subprocess.run([PY, "-m", "csa_lab", *args], cwd=ROOT, capture_output=True, text=True,
                          env={**os.environ, **(env or {})}, timeout=timeout)


def case(name, fn, results):
    t0 = time.time()
    try:
        detail = fn()
        results.append({"case": name, "result": "PASS", "detail": detail, "s": round(time.time() - t0, 1)})
    except AssertionError as e:
        results.append({"case": name, "result": "FAIL", "detail": str(e), "s": round(time.time() - t0, 1)})
    except Exception as e:
        results.append({"case": name, "result": "FAIL", "detail": f"{type(e).__name__}: {e}",
                        "s": round(time.time() - t0, 1)})


def main(data_dir: str, work: str):
    data = Path(data_dir)
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    results = []

    def resume_no_redownload():
        before = read_json(data / "checkpoint.json")
        r = cli(["collect", "--data-dir", str(data), "--start", "2023-01", "--end", "2023-06", "--no-hyperliquid",
                 "--no-fx"])
        assert r.returncode == 0, r.stderr[-2000:]
        rep = read_json(data / "collect_report.json")
        assert rep["http_stats"]["requests"] == 0, f"재다운로드 발생: {rep['http_stats']}"
        assert read_json(data / "checkpoint.json") == before
        return {"requests": 0}

    def kill9_during_collect_then_resume():
        d = work / "kill9"
        p = subprocess.Popen([PY, "-m", "csa_lab", "collect", "--data-dir", str(d), "--start", "2021-01", "--end",
                              "2021-12", "--no-hyperliquid", "--no-fx"], cwd=ROOT, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        deadline = time.time() + 120
        while time.time() < deadline:
            ck = d / "checkpoint.json"
            if ck.exists() and len(read_json(ck)["done"]) >= 5:
                break
            time.sleep(0.2)
        p.send_signal(signal.SIGKILL)
        p.wait()
        done_at_kill = len(read_json(d / "checkpoint.json")["done"])
        r = cli(["collect", "--data-dir", str(d), "--start", "2021-01", "--end", "2021-12", "--no-hyperliquid",
                 "--no-fx"])
        assert r.returncode == 0, r.stderr[-2000:]
        rep = read_json(d / "collect_report.json")
        assert not list(d.rglob(".*.part")), "반쪽 파일 남음"
        assert len(read_json(d / "checkpoint.json")["done"]) == 48
        # 같은 월 파일은 원본 수집 디렉터리와 바이트 단위로 같아야 함(재현성)
        same = 0
        for f in (d / "raw").rglob("*.parquet"):
            twin = data / f.relative_to(d)
            if twin.exists():
                assert sha256_file(f) == sha256_file(twin), f"불일치 {f.name}"
                same += 1
        return {"done_at_kill": done_at_kill, "resumed_requests": rep["http_stats"]["requests"],
                "partials_cleaned": rep["partials_cleaned"], "identical_files": same}

    def network_down_fails_cleanly():
        d = work / "netdown"
        r = cli(["collect", "--data-dir", str(d), "--start", "2020-06", "--end", "2020-06", "--no-hyperliquid",
                 "--no-fx"], env={"HTTPS_PROXY": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9"},
                timeout=600)
        assert r.returncode != 0, "네트워크 단절인데 성공으로 끝남"
        assert "RetryExhausted" in r.stderr or "재시도" in r.stderr, r.stderr[-1500:]
        assert not list(d.rglob("*.parquet")), "불완전한 데이터가 저장됨"
        return {"exit_code": r.returncode, "tail": r.stderr.strip().splitlines()[-1][:300]}

    def tampered_cache_redownloaded():
        files = sorted((data / "raw" / "fundingRate").rglob("*2023-02.parquet"))
        assert files, "대상 파일 없음"
        f = files[0]
        good = sha256_file(f)
        f.write_bytes(b"corrupted")
        r = cli(["collect", "--data-dir", str(data), "--start", "2023-02", "--end", "2023-02", "--no-hyperliquid",
                 "--no-fx"])
        assert r.returncode == 0, r.stderr[-2000:]
        assert sha256_file(f) == good, "변조 파일이 복구되지 않음"
        return {"restored": True}

    def readonly_results_dir_fails_cleanly():
        d = work / "ro"
        d.mkdir(exist_ok=True)
        os.chmod(d, 0o555)
        try:
            r = cli(["backtest", "--data-dir", str(data), "--results-dir", str(d), "--leverage", "1",
                     "--window", "w=2023-07-01:2023-08-01", "--strategy", "carry_binance", "--profile", "original"])
        finally:
            os.chmod(d, 0o755)
        assert r.returncode != 0, "쓰기 불가 디렉터리인데 성공"
        assert not list(d.rglob("*")), "부분 결과가 남음"
        return {"exit_code": r.returncode, "tail": r.stderr.strip().splitlines()[-1][:300]}

    def invalid_leverage_rejected_at_cli():
        out = {}
        for bad in ["0", "8", "-1", "1.5", "abc", "nan", "inf", ""]:
            r = cli(["backtest", "--data-dir", str(data), "--results-dir", str(work / "x"), "--leverage", bad])
            assert r.returncode == 2, f"{bad!r} 거부 안 됨"
            out[bad] = r.stderr.strip()[:80]
        return out

    for name, fn in [("resume_no_redownload", resume_no_redownload),
                     ("kill9_during_collect_then_resume", kill9_during_collect_then_resume),
                     ("network_down_fails_cleanly", network_down_fails_cleanly),
                     ("tampered_cache_redownloaded", tampered_cache_redownloaded),
                     ("readonly_results_dir_fails_cleanly", readonly_results_dir_fails_cleanly),
                     ("invalid_leverage_rejected_at_cli", invalid_leverage_rejected_at_cli)]:
        case(name, fn, results)
    print(json.dumps(results, ensure_ascii=False, indent=1))
    return 0 if all(r["result"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))

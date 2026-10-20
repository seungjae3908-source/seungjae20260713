import io
import json
import multiprocessing as mp
import os
import zipfile
from pathlib import Path

import pandas as pd
import pytest

from csa_lab.data.binance import ChecksumMismatch, fetch_month, parse_checksum, parse_funding, parse_klines
from csa_lab.http import (ForbiddenRequestError, HttpStatusError, PublicHttpClient, RetryExhausted, RetryPolicy,
                          check_request_allowed)
from csa_lab.logsafe import mask_secrets, setup_logger
from csa_lab.quality import DataQualityError, check_funding, check_ohlcv, require_ok
from csa_lab.storage import (Checkpoint, IntegrityError, LockBusyError, atomic_write_bytes, atomic_write_json,
                             cleanup_partials, run_lock, sha256_bytes, verify_manifest, write_manifest)

H = 3_600_000
T0 = 1_672_531_200_000  # 2023-01-01 UTC


# ---------- 읽기 전용·주문 차단 ----------
@pytest.mark.parametrize("url", [
    "https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT",
    "https://fapi.binance.com/fapi/v1/leverage",
    "https://fapi.binance.com/fapi/v2/account",
    "https://fapi.binance.com/fapi/v1/listenKey",
    "https://api.binance.com/api/v3/order",
    "https://api.upbit.com/v1/orders",
    "http://fapi.binance.com/fapi/v1/klines",
    "https://evil.example.com/x",
    "https://fapi.binance.com/fapi/v1/klines?signature=abc",
])
def test_forbidden_get(url):
    with pytest.raises(ForbiddenRequestError):
        check_request_allowed("GET", url)


def test_forbidden_methods_headers_and_hyperliquid_exchange():
    with pytest.raises(ForbiddenRequestError):
        check_request_allowed("GET", "https://fapi.binance.com/fapi/v1/klines", {"X-MBX-APIKEY": "k"})
    with pytest.raises(ForbiddenRequestError):
        check_request_allowed("DELETE", "https://fapi.binance.com/fapi/v1/klines")
    with pytest.raises(ForbiddenRequestError):
        check_request_allowed("POST", "https://api.hyperliquid.xyz/exchange", body={"type": "order"})
    with pytest.raises(ForbiddenRequestError):
        check_request_allowed("POST", "https://api.hyperliquid.xyz/info", body={"type": "clearinghouseState"})
    check_request_allowed("POST", "https://api.hyperliquid.xyz/info", body={"type": "fundingHistory"})
    check_request_allowed("GET", "https://fapi.binance.com/fapi/v1/fundingRate")
    check_request_allowed("GET", "https://fapi.binance.com/fapi/v1/exchangeInfo")


def test_package_has_no_order_code():
    root = Path(__file__).resolve().parents[1] / "csa_lab"
    text = "\n".join(p.read_text(encoding="utf-8") for p in root.rglob("*.py"))
    for needle in ("create_order", "new_order", "place_order", "cancel_order", "/fapi/v1/order\"", "hmac.new",
                   "ccxt", "os.environ[\"BINANCE", "API_SECRET"):
        assert needle not in text, needle


# ---------- 재시도·장애 주입 ----------
class FakeTransport:
    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def __call__(self, req, timeout):
        self.calls += 1
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_retry_then_success_with_backoff():
    sleeps = []
    t = FakeTransport([ConnectionError("down"), (503, {}, b"x"), (429, {"Retry-After": "7"}, b""), (200, {}, b"[1]")])
    c = PublicHttpClient(RetryPolicy(max_attempts=5, base_delay=1, jitter=0), transport=t, sleep=sleeps.append)
    assert c.get_json("https://fapi.binance.com/fapi/v1/klines") == [1]
    assert t.calls == 4 and c.stats.retries == 3 and c.stats.rate_limited == 1
    assert sleeps == [1, 2, 7]


def test_retry_limit_exhausts_no_infinite_loop():
    t = FakeTransport([TimeoutError("t")] * 3)
    c = PublicHttpClient(RetryPolicy(max_attempts=3, base_delay=0.01, jitter=0), transport=t, sleep=lambda s: None)
    with pytest.raises(RetryExhausted):
        c.get_bytes("https://fapi.binance.com/fapi/v1/klines")
    assert t.calls == 3 and c.stats.failures == 1


@pytest.mark.parametrize("code", [400, 403, 451, 404])
def test_non_retryable_status(code):
    t = FakeTransport([(code, {}, b"blocked")])
    c = PublicHttpClient(RetryPolicy(max_attempts=5), transport=t, sleep=lambda s: None)
    with pytest.raises(HttpStatusError):
        c.get_bytes("https://fapi.binance.com/fapi/v1/klines")
    assert t.calls == 1


# ---------- 원자 저장·잠금·체크포인트·무결성 ----------
def test_atomic_write_no_partial_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "a.json"
    atomic_write_json(target, {"v": 1})

    def boom(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_json(target, {"v": 2})
    monkeypatch.undo()
    assert json.loads(target.read_text())["v"] == 1
    assert not list(tmp_path.glob(".*.part"))


def test_no_overwrite_results(tmp_path):
    p = tmp_path / "r.json"
    atomic_write_json(p, {"a": 1}, overwrite=False)
    with pytest.raises(FileExistsError):
        atomic_write_json(p, {"a": 2}, overwrite=False)


def test_cleanup_partials(tmp_path):
    (tmp_path / ".x.json.abc.part").write_text("half")
    assert cleanup_partials(tmp_path) == 1


def _hold_lock(path, q):
    with run_lock(Path(path)):
        q.put("held")
        import time
        time.sleep(1.5)


def test_run_lock_blocks_second_process(tmp_path):
    q = mp.Queue()
    p = mp.Process(target=_hold_lock, args=(str(tmp_path / "x.lock"), q))
    p.start()
    assert q.get(timeout=5) == "held"
    with pytest.raises(LockBusyError):
        with run_lock(tmp_path / "x.lock"):
            pass
    p.join()
    with run_lock(tmp_path / "x.lock"):
        pass


def test_lock_released_when_process_killed(tmp_path):
    q = mp.Queue()
    p = mp.Process(target=_hold_lock, args=(str(tmp_path / "k.lock"), q))
    p.start()
    q.get(timeout=5)
    p.kill()
    p.join()
    with run_lock(tmp_path / "k.lock"):
        pass


def test_checkpoint_detects_tampered_artifact(tmp_path):
    art = tmp_path / "f.bin"
    atomic_write_bytes(art, b"hello")
    ck = Checkpoint(tmp_path / "ck.json")
    ck.mark_done("k", sha256=sha256_bytes(b"hello"))
    assert Checkpoint(tmp_path / "ck.json").is_done("k", art)
    art.write_bytes(b"tampered")
    assert not Checkpoint(tmp_path / "ck.json").is_done("k", art)


def test_manifest_integrity(tmp_path):
    f = tmp_path / "x.json"
    atomic_write_json(f, {"a": 1})
    write_manifest(tmp_path, [f])
    assert verify_manifest(tmp_path)["ok"]
    f.write_text("{}")
    with pytest.raises(IntegrityError):
        verify_manifest(tmp_path)


# ---------- 데이터 품질 ----------
def _ohlcv(n=10, start=T0):
    ts = [start + i * H for i in range(n)]
    return pd.DataFrame({"ts": ts, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1.0})


def test_quality_clean():
    d, rep = check_ohlcv(_ohlcv(), "x")
    assert rep.ok and rep.rows == 10


def test_quality_detects_defects():
    df = _ohlcv(10)
    df = pd.concat([df, df.iloc[[3]]])  # 동일 중복
    d, rep = check_ohlcv(df, "x")
    assert rep.duplicates_identical == 1 and rep.ok
    bad = _ohlcv(10)
    bad2 = bad.iloc[[4]].copy()
    bad2["close"] = 150.0
    d, rep = check_ohlcv(pd.concat([bad, bad2]), "x")
    assert any(b.startswith("CONFLICTING") for b in rep.blocking)
    gap = _ohlcv(100).drop(index=[50, 51, 52])
    d, rep = check_ohlcv(gap, "x")
    assert rep.missing_intervals == 3 and not rep.ok
    neg = _ohlcv(5)
    neg.loc[2, "low"] = -1
    assert not check_ohlcv(neg, "x")[1].ok
    jump = _ohlcv(5)
    jump.loc[3, ["open", "high", "low", "close"]] = [200, 200, 200, 200]
    assert any(b.startswith("OUTLIER") for b in check_ohlcv(jump, "x")[1].blocking)
    d, rep = check_ohlcv(_ohlcv(5), "x", now_ms=T0 + 100 * H, max_stale_ms=3 * H)
    assert any(b.startswith("STALE") for b in rep.blocking)
    with pytest.raises(DataQualityError):
        require_ok(rep)


def test_quality_ts_units_normalized():
    df = _ohlcv(3)
    df["ts"] = df["ts"] * 1000  # 마이크로초
    d, rep = check_ohlcv(df, "x")
    assert rep.ok and d["ts"].iloc[1] == T0 + H


def test_funding_quality():
    ts = [T0 + i * 8 * H + 3 for i in range(10)]
    df = pd.DataFrame({"ts": ts, "rate": 0.0001})
    d, rep = check_funding(df, "f")
    assert rep.ok and d["ts"].iloc[1] == T0 + 8 * H
    df2 = df.drop(index=[4])
    assert not check_funding(df2, "f")[1].ok
    df3 = df.copy()
    df3.loc[2, "rate"] = 0.5
    assert not check_funding(df3, "f")[1].ok


# ---------- Binance 월별 파일 파서·체크섬 ----------
def _zip(name, text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, text)
    return buf.getvalue()


def test_parse_kline_with_and_without_header():
    row = "1672531200000,16500.1,16600,16400,16550,123.4,1672534799999,2000000,100,50,800000,0\n"
    hdr = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n"
    a = parse_klines(_zip("a.csv", row))
    b = parse_klines(_zip("b.csv", hdr + row))
    assert a.equals(b) and a["close"].iloc[0] == 16550


def test_parse_funding():
    f = parse_funding(_zip("f.csv", "calc_time,funding_interval_hours,last_funding_rate\n1672531200000,8,0.0001\n"))
    assert f["rate"].iloc[0] == 0.0001


def test_fetch_month_checksum_and_resume(tmp_path):
    blob = _zip("f.csv", "calc_time,funding_interval_hours,last_funding_rate\n1672531200000,8,0.0001\n")
    good = sha256_bytes(blob)

    class C:
        def __init__(self, checksum):
            self.checksum = checksum
            self.calls = 0

        def get_bytes(self, url):
            self.calls += 1
            if url.endswith(".CHECKSUM"):
                return f"{self.checksum}  x.zip\n".encode()
            return blob

    ck = Checkpoint(tmp_path / "ck.json")
    with pytest.raises(ChecksumMismatch):
        fetch_month(C("0" * 64), "fundingRate", "BTCUSDT", "2023-01", tmp_path, ck)
    assert not list(tmp_path.rglob("*.parquet"))
    c = C(good)
    p = fetch_month(c, "fundingRate", "BTCUSDT", "2023-01", tmp_path, ck)
    assert p.exists() and c.calls == 2
    c2 = C(good)
    fetch_month(c2, "fundingRate", "BTCUSDT", "2023-01", tmp_path, Checkpoint(tmp_path / "ck.json"))
    assert c2.calls == 0  # 체크포인트로 재개
    with pytest.raises(ChecksumMismatch):
        parse_checksum("not-a-hash")


# ---------- 로그 마스킹·회전 ----------
def test_secret_masking_and_rotation(tmp_path):
    s = mask_secrets("api_key=ABCDEF123 secret: xyz token=1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA Bearer abcdefghijkl")
    assert "ABCDEF123" not in s and "xyz" not in s and "AAAAAAAA" not in s and "abcdefghijkl" not in s
    lg = setup_logger("rot", tmp_path, max_bytes=2000, backups=2, console=False)
    for i in range(500):
        lg.info("line %d api_key=SECRET%d", i, i)
    files = list(tmp_path.glob("rot.log*"))
    assert len(files) <= 3
    assert sum(f.stat().st_size for f in files) < 2000 * 3 + 500
    assert "SECRET" not in "".join(f.read_text() for f in files)

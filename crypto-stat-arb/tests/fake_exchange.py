"""통합 테스트용 가짜 공개 API(합성 데이터). 실제 결과로 쓰지 않는다."""
import hashlib
import io
import json
import re
import urllib.parse
import zipfile

import numpy as np
import pandas as pd

H = 3_600_000


def _zip(name, text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        # 고정 시각: 체크섬 요청과 본문 요청 사이에 초가 바뀌어도 같은 바이트가 나오게
        zf.writestr(zipfile.ZipInfo(name, date_time=(2023, 1, 1, 0, 0, 0)), text)
    return buf.getvalue()


class FakeExchange:
    def __init__(self, start="2023-01-01", end="2023-04-01", seed=7, b_rate=0.0002, h_rate=0.0, fail_first=0,
                 drop_kline_ts=None):
        self.t0 = int(pd.Timestamp(start, tz="UTC").value // 10**6)
        self.t1 = int(pd.Timestamp(end, tz="UTC").value // 10**6)
        n = (self.t1 - self.t0) // H
        rng = np.random.default_rng(seed)
        self.ts = np.array([self.t0 + i * H for i in range(n)])
        self.close = 20000 * np.exp(np.cumsum(rng.normal(0, 0.003, n)))
        self.b_rate = b_rate
        self.h_rate = h_rate
        self.fail_first = fail_first
        self.calls = 0
        self.drop = set(drop_kline_ts or [])

    def _month_rows(self, month, step):
        a = int(pd.Timestamp(month + "-01", tz="UTC").value // 10**6)
        b = int((pd.Timestamp(month + "-01", tz="UTC") + pd.offsets.MonthBegin(1)).value // 10**6)
        return [t for t in range(a, b, step) if self.t0 <= t < self.t1]

    def _kline_csv(self, month, mult=1.0):
        lines = []
        for t in self._month_rows(month, H):
            if t in self.drop:
                continue
            i = (t - self.t0) // H
            c = self.close[i] * mult
            o = self.close[i - 1] * mult if i > 0 else c
            hi, lo = max(o, c) * 1.001, min(o, c) * 0.999
            lines.append(f"{t},{o},{hi},{lo},{c},10,{t + H - 1},0,0,0,0,0")
        return "\n".join(lines) + "\n"

    def _funding_csv(self, month):
        rows = [f"{t},8,{self.b_rate}" for t in self._month_rows(month, 8 * H)]
        return "calc_time,funding_interval_hours,last_funding_rate\n" + "\n".join(rows) + "\n"

    def __call__(self, req, timeout):
        self.calls += 1
        if self.calls <= self.fail_first:
            raise ConnectionError("injected network failure")
        url = req.full_url
        u = urllib.parse.urlparse(url)
        if u.hostname == "data.binance.vision":
            m = re.search(r"-(\d{4}-\d{2})\.zip", u.path)
            month = m.group(1)
            if "fundingRate" in u.path:
                blob = _zip("f.csv", self._funding_csv(month))
            elif "markPriceKlines" in u.path:
                blob = _zip("m.csv", self._kline_csv(month, 1.0001))
            elif "/spot/" in u.path:
                blob = _zip("s.csv", self._kline_csv(month, 0.9995))
            else:
                blob = _zip("k.csv", self._kline_csv(month))
            if not self._month_rows(month, H):
                return 404, {}, b""
            if u.path.endswith(".CHECKSUM"):
                return 200, {}, f"{hashlib.sha256(blob).hexdigest()}  x.zip\n".encode()
            return 200, {}, blob
        if u.hostname == "api.hyperliquid.xyz":
            body = json.loads(req.data)
            if body["type"] == "meta":
                return 200, {}, json.dumps({"universe": [{"name": "BTC", "maxLeverage": 40}]}).encode()
            if body["type"] == "fundingHistory":
                st = max(body["startTime"], self.t0)
                rows = [{"coin": "BTC", "fundingRate": str(self.h_rate), "premium": "0", "time": t}
                        for t in range(st - st % H, min(body["endTime"], self.t1), H)][:500]
                return 200, {}, json.dumps(rows).encode()
        if u.hostname == "api.upbit.com":
            q = urllib.parse.parse_qs(u.query)
            to = pd.Timestamp(q["to"][0])
            days = pd.date_range(end=to - pd.Timedelta(days=1), periods=int(q["count"][0]), freq="D")
            rows = [{"candle_date_time_utc": d.strftime("%Y-%m-%dT00:00:00"), "trade_price": 1300.0 + (d.day % 5)}
                    for d in reversed(days) if d >= pd.Timestamp("2022-06-01", tz="UTC")]
            return 200, {}, json.dumps(rows).encode()
        if u.hostname == "api.frankfurter.app":
            return 200, {}, json.dumps({"rates": {"2023-01-02": {"KRW": 1270.0}}}).encode()
        return 404, {}, b""

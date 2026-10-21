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
                 drop_kline_ts=None, hl_start=None, hl_coarse_until=None, drop_mark_ts=None,
                 drop_spot_ts=None, hl_drop_ts=None, bg_rate=None, krw_per_usdt=1350.0, kimchi=1.02,
                 upbit_drop_ts=None, upbit_usdt_start=None, bitget_down=False):
        """hl_start: 하이퍼리퀴드 펀딩 이력이 시작되는 날짜(그 전은 원천에 없음).
        hl_coarse_until: 이 날짜 전까지 하이퍼리퀴드 펀딩이 8시간 간격으로만 존재(실제 2023-05~06 초기 구간 모사).
        drop_mark_ts: 마크가격 봉만 빠지는 시각 목록. drop_spot_ts: 현물 봉만 빠지는 시각 목록.
        hl_drop_ts: 하이퍼리퀴드 펀딩 공시만 빠지는 시각 목록(실제 2023-07~12 구간의 단발 결측 모사).
        bg_rate: 비트겟 8시간 펀딩(기본 b_rate). krw_per_usdt·kimchi: 업비트 KRW-USDT 값과 KRW-BTC 프리미엄 배수.
        upbit_drop_ts: 업비트 KRW-BTC 봉만 빠지는 시각(무거래 시간 모사). upbit_usdt_start: KRW-USDT 상장 시작일.
        bitget_down: 비트겟 시세 경로가 계속 503 을 돌려줌(원천 장애 모사)."""
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
        self.drop_mark = set(drop_mark_ts or [])
        self.drop_spot = set(drop_spot_ts or [])
        self.hl_drop = set(hl_drop_ts or [])
        self.hl_start = int(pd.Timestamp(hl_start, tz="UTC").value // 10**6) if hl_start else self.t0
        self.hl_coarse_until = int(pd.Timestamp(hl_coarse_until, tz="UTC").value // 10**6) if hl_coarse_until else None
        self.bg_rate = b_rate if bg_rate is None else bg_rate
        self.krw_per_usdt = krw_per_usdt
        self.kimchi = kimchi
        self.upbit_drop = set(upbit_drop_ts or [])
        self.upbit_usdt_start = int(pd.Timestamp(upbit_usdt_start, tz="UTC").value // 10**6) if upbit_usdt_start else self.t0
        self.bitget_down = bitget_down

    def _ohlc(self, t, mult):
        i = (t - self.t0) // H
        c = self.close[i] * mult
        o = self.close[i - 1] * mult if i > 0 else c
        return o, max(o, c) * 1.001, min(o, c) * 0.999, c

    def _month_rows(self, month, step):
        a = int(pd.Timestamp(month + "-01", tz="UTC").value // 10**6)
        b = int((pd.Timestamp(month + "-01", tz="UTC") + pd.offsets.MonthBegin(1)).value // 10**6)
        return [t for t in range(a, b, step) if self.t0 <= t < self.t1]

    def _kline_csv(self, month, mult=1.0, drop=None):
        lines = []
        drop = self.drop if drop is None else drop
        for t in self._month_rows(month, H):
            if t in drop:
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
                blob = _zip("m.csv", self._kline_csv(month, 1.0001, drop=self.drop | self.drop_mark))
            elif "/spot/" in u.path:
                blob = _zip("s.csv", self._kline_csv(month, 0.9995, drop=self.drop | self.drop_spot))
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
                st = max(body["startTime"], self.t0, self.hl_start)
                rows = []
                for t in range(st - st % H, min(body["endTime"], self.t1), H):
                    if self.hl_coarse_until is not None and t < self.hl_coarse_until and (t - self.t0) % (8 * H) != 0:
                        continue  # 초기 구간은 8시간 간격 공시만 존재
                    if t in self.hl_drop:
                        continue  # 단발 결측 공시
                    rows.append({"coin": "BTC", "fundingRate": str(self.h_rate), "premium": "0", "time": t})
                    if len(rows) >= 500:
                        break
                return 200, {}, json.dumps(rows).encode()
        if u.hostname == "api.upbit.com" and u.path == "/v1/candles/minutes/60":
            q = urllib.parse.parse_qs(u.query)
            market = q["market"][0]
            to = int(pd.Timestamp(q["to"][0]).value // 10**6)
            count = int(q["count"][0])
            rows = []
            t = min(to - to % H, self.t1)
            t = t - H if t >= to else t
            while t >= self.t0 and len(rows) < count:
                if market == "KRW-USDT":
                    ok = t >= self.upbit_usdt_start
                    vals = (self.krw_per_usdt,) * 4
                else:
                    ok = t not in self.upbit_drop
                    o, hi, lo, c = self._ohlc(t, self.krw_per_usdt * self.kimchi)
                    vals = (o, hi, lo, c)
                if ok and t < self.t1:
                    rows.append({"market": market,
                                 "candle_date_time_utc": pd.Timestamp(t, unit="ms").strftime("%Y-%m-%dT%H:%M:%S"),
                                 "opening_price": vals[0], "high_price": vals[1], "low_price": vals[2],
                                 "trade_price": vals[3], "candle_acc_trade_volume": 1.0})
                t -= H
            return 200, {}, json.dumps(rows).encode()
        if u.hostname == "api.bitget.com" and u.path.startswith("/api/v2/mix/market/history"):
            if self.bitget_down:
                return 503, {}, b"down"
            q = urllib.parse.parse_qs(u.query)
            if u.path.endswith("history-fund-rate"):
                size, page = int(q["pageSize"][0]), int(q["pageNo"][0])
                all_t = [t for t in range(self.t0, self.t1, 8 * H)][::-1]
                chunk = all_t[(page - 1) * size: page * size]
                data = [{"symbol": "BTCUSDT", "fundingRate": str(self.bg_rate), "settleTime": str(t)} for t in chunk]
                return 200, {}, json.dumps({"code": "00000", "msg": "success", "data": data}).encode()
            st, et, lim = int(q["startTime"][0]), int(q["endTime"][0]), int(q["limit"][0])
            mult = 1.0002 if "history-mark-candles" in u.path else 1.0
            data = []
            for t in range(st - st % H + (H if st % H else 0), et + 1, H):
                if self.t0 <= t < self.t1 and len(data) < lim:
                    o, hi, lo, c = self._ohlc(t, mult)
                    data.append([str(t), str(o), str(hi), str(lo), str(c), "1", "1"])
            return 200, {}, json.dumps({"code": "00000", "msg": "success", "data": data}).encode()
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

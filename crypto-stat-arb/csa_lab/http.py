"""읽기 전용 공개 데이터 HTTP 클라이언트.

- 허용 호스트·경로만 접속. 주문/계정 경로와 인증 헤더는 요청 전에 거부한다.
- 지수형 재시도(상한 있음), 429/418 Retry-After 존중, 타임아웃.
- 재시도 한도를 넘으면 RetryExhausted 로 끝낸다(무한 재시도 금지).
"""
from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

ALLOWED_GET_HOSTS = {
    "data.binance.vision",
    "fapi.binance.com",
    "api.upbit.com",
    "api.frankfurter.app",
    "www.deribit.com",
}
# Hyperliquid 의 공개 info 엔드포인트는 POST 지만 조회 전용이다.
ALLOWED_POST = {("api.hyperliquid.xyz", "/info")}
HYPERLIQUID_READONLY_TYPES = {"meta", "metaAndAssetCtxs", "candleSnapshot", "fundingHistory"}

# 주문·계정·출금 등 쓰기/개인 경로 패턴(대소문자 무시)
FORBIDDEN_PATH_PARTS = (
    "/order", "/batchorders", "/allopenorders", "/leverage", "/margintype", "/positionmargin",
    "/account", "/balance", "/withdraw", "/transfer", "/listenkey", "/positionside",
    "/private/", "/sapi/", "/v1/orders", "/v1/withdraws", "/v1/deposits",
)
FORBIDDEN_HEADERS = {"x-mbx-apikey", "authorization", "api-key", "x-api-key", "ok-access-key", "x-bapi-api-key"}


class ForbiddenRequestError(RuntimeError):
    pass


class RetryExhausted(RuntimeError):
    pass


class HttpStatusError(RuntimeError):
    def __init__(self, status: int, url: str, body: str = ""):
        super().__init__(f"HTTP {status} {url} {body[:200]}")
        self.status = status
        self.url = url


def check_request_allowed(method: str, url: str, headers: Optional[dict] = None, body: Optional[dict] = None) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ForbiddenRequestError(f"https 만 허용: {url}")
    host = parsed.hostname or ""
    path = parsed.path.lower()
    for h in (headers or {}):
        if h.lower() in FORBIDDEN_HEADERS:
            raise ForbiddenRequestError(f"인증 헤더 금지: {h}")
    if "signature=" in (parsed.query or "").lower() or "apikey" in (parsed.query or "").lower():
        raise ForbiddenRequestError("서명/키 파라미터 금지")
    if method == "GET":
        if host not in ALLOWED_GET_HOSTS:
            raise ForbiddenRequestError(f"허용되지 않은 호스트: {host}")
        if any(part in path for part in FORBIDDEN_PATH_PARTS):
            raise ForbiddenRequestError(f"주문/계정 경로 금지: {parsed.path}")
        return
    if method == "POST":
        if (host, parsed.path) not in ALLOWED_POST:
            raise ForbiddenRequestError(f"허용되지 않은 POST: {host}{parsed.path}")
        t = (body or {}).get("type")
        if t not in HYPERLIQUID_READONLY_TYPES:
            raise ForbiddenRequestError(f"조회 전용이 아닌 Hyperliquid 요청 금지: {t!r}")
        return
    raise ForbiddenRequestError(f"허용되지 않은 메서드: {method}")


@dataclass
class RetryPolicy:
    max_attempts: int = 5
    base_delay: float = 1.0
    max_delay: float = 30.0
    timeout: float = 20.0
    jitter: float = 0.2


@dataclass
class FetchStats:
    requests: int = 0
    retries: int = 0
    failures: int = 0
    rate_limited: int = 0
    bytes: int = 0
    errors: list = field(default_factory=list)


Transport = Callable[[urllib.request.Request, float], tuple[int, dict, bytes]]


def _default_transport(req: urllib.request.Request, timeout: float) -> tuple[int, dict, bytes]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read() if hasattr(e, "read") else b""


class PublicHttpClient:
    def __init__(self, policy: Optional[RetryPolicy] = None, transport: Optional[Transport] = None,
                 sleep: Callable[[float], None] = time.sleep, min_interval: float = 0.0):
        self.policy = policy or RetryPolicy()
        self.transport = transport or _default_transport
        self.sleep = sleep
        self.min_interval = min_interval
        self._last = 0.0
        self.stats = FetchStats()

    def _throttle(self):
        if self.min_interval > 0:
            wait = self._last + self.min_interval - time.monotonic()
            if wait > 0:
                self.sleep(wait)
        self._last = time.monotonic()

    def request(self, method: str, url: str, *, body: Optional[dict] = None, headers: Optional[dict] = None) -> bytes:
        check_request_allowed(method, url, headers, body)
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"User-Agent": "csa-lab-readonly/1.0", **(headers or {})}
        if data is not None:
            hdrs["Content-Type"] = "application/json"
        last_err: Optional[Exception] = None
        for attempt in range(1, self.policy.max_attempts + 1):
            self._throttle()
            self.stats.requests += 1
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            try:
                status, resp_headers, payload = self.transport(req, self.policy.timeout)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last_err = e
                status, resp_headers, payload = -1, {}, b""
            if 200 <= status < 300:
                self.stats.bytes += len(payload)
                return payload
            if status == 404:
                raise HttpStatusError(404, url)
            if status in (400, 401, 403, 451) :
                # 권한/지역 차단/잘못된 요청은 재시도해도 바뀌지 않는다.
                self.stats.failures += 1
                raise HttpStatusError(status, url, payload.decode(errors="replace"))
            retry_after = None
            if status in (418, 429):
                self.stats.rate_limited += 1
                ra = {k.lower(): v for k, v in resp_headers.items()}.get("retry-after")
                try:
                    retry_after = float(ra) if ra is not None else None
                except ValueError:
                    retry_after = None
            if status != -1:
                last_err = HttpStatusError(status, url, payload.decode(errors="replace"))
            if attempt == self.policy.max_attempts:
                break
            delay = retry_after if retry_after is not None else min(
                self.policy.max_delay, self.policy.base_delay * (2 ** (attempt - 1)))
            delay = min(delay, self.policy.max_delay * 4)
            delay *= 1 + random.uniform(0, self.policy.jitter)
            self.stats.retries += 1
            self.sleep(delay)
        self.stats.failures += 1
        self.stats.errors.append(str(last_err))
        raise RetryExhausted(f"재시도 {self.policy.max_attempts}회 초과: {url} ({last_err})")

    def get_json(self, url: str, params: Optional[dict] = None) -> Any:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        return json.loads(self.request("GET", url).decode())

    def get_bytes(self, url: str) -> bytes:
        return self.request("GET", url)

    def post_info(self, body: dict) -> Any:
        return json.loads(self.request("POST", "https://api.hyperliquid.xyz/info", body=body).decode())

# Standalone Trade Execution Gateway v0.5

Production 앱과 분리된 **PAPER 전용 OMS / Execution Safety 준비 서비스**입니다.

## 절대 안전 경계

- `PAPER_ONLY`
- `LIVE_TRADING=false`
- `REAL_ORDER_ENABLED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- 주문/private/account outbound network 권한 없음
- 실제 계좌/잔고/private provider API 호출 없음
- 실제 주문/취소/정정/이체/출금 없음
- Production/Staging route 미연결
- 기본 bind `127.0.0.1:8792`
- 기존 앱/Production workflow/DB/Supabase/Secret 수정 없음

공개 시세 네트워크는 별도입니다. 기본 OFF이며 명시적으로 활성화한 경우에만 hard-coded Upbit/Bitget **public WebSocket**으로 outbound가 가능합니다. 이 public transport는 주문 권한을 만들지 않습니다.

## Durable Paper OMS

- 기본 파일: `trade-execution-gateway/.state/paper-state.json`
- Production DB 사용 `false`, secret 저장 `false`
- SHA-256 integrity checksum
- file `fsync` → atomic rename → directory `fsync`
- 이전 snapshot `.bak` 유지
- state file `0600`, state directory `0700`
- 최대 5 MiB / 10,000 Paper orders fail-closed cap
- 주문과 idempotency key 함께 복구

**재시작 후 자동 재제출은 금지**합니다. `CREATED/RISK_ACCEPTED/SUBMITTED` 중단 상태는 `recoveryHold=true`로 복구되며 같은 idempotency key가 재입력돼도 adapter submission을 실행하지 않습니다.

Paper adapter 호출 **전** durable state를 먼저 저장하고, adapter accepted 후 다시 저장합니다. accepted 저장 직전에 프로세스가 중단돼도 재시작 시 자동 재주문 대신 recovery hold로 멈춥니다.

## Public-only WebSocket runtime

기본값은 네트워크 OFF입니다.

```text
TEG_PUBLIC_MARKET_DATA_ENABLED=true
TEG_UPBIT_PUBLIC_SYMBOL=KRW-BTC
TEG_BITGET_PUBLIC_SYMBOL=BTCUSDT
```

명시적으로 활성화했을 때만:

- Upbit Spot: `wss://api.upbit.com/websocket/v1`
- Bitget Futures: `wss://ws.bitget.com/v2/ws/public`

URL override 및 credentials/header/token/API key/passphrase 입력은 지원하지 않습니다. Private WebSocket은 구현하지 않습니다.

Public runtime이 직접 수신한 메시지만 `serverAttested=true`, `transportObservedByGateway=true`, `callerSuppliedEvidence=false`로 승격됩니다. 그러나 항상 `liveExecutionEligible=false`, `orderSubmissionAllowed=false`입니다.

## Stream 복구 / Clock / Health

- Upbit reconnect 후 orderbook `SNAPSHOT` 필수, timestamp regression 차단, `PING` keepalive
- Bitget `books` snapshot + incremental
- Bitget 첫 update: snapshot seq가 `[pseq, seq]` 범위에 포함되어야 함
- 이후 `previous seq == next pseq` 필수
- `pseq=0` reset은 fresh snapshot 재동기화 요구
- Bitget `ping/pong` keepalive
- provider clock skew fail-closed
- stale provider health
- reconnect rate-limit + exponential backoff
- consecutive failure circuit breaker
- disconnect가 clock/sequence 등 actionable root failure를 덮어쓰지 않음

## Execution guards

- caller evidence → `CALLER_SUPPLIED_UNATTESTED`
- gateway public transport evidence → `GATEWAY_TRANSPORT_OBSERVED_PUBLIC`

stale / price-deviation / spread / depth / slippage guard를 적용하지만 실주문 권한은 0입니다.

## 검증

```bash
cd trade-execution-gateway
npm test
```

- 기존 Application CI exact-head 단계의 `.github/tests/pr-exact-head-trade-execution-gateway.test.mjs`가 package `npm test`를 직접 실행
- `.github/workflows/trade-execution-gateway-validation.yml`은 Node 22 독립 exact-head validation
- deploy/secret/private network 없음
- deterministic public-WebSocket tests는 mock transport 사용

## 현재 미연결

- authenticated account read/reconciliation adapter
- actual private order/cancel/amend adapter
- Production route
- server-authoritative live portfolio policy
- Execution Quality / TCA
- Paper↔Live parity harness
- 실제 실주문

별도 승인 전까지 연결하지 않습니다.

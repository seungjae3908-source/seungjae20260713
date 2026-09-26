# Standalone Trade Execution Gateway v0.8

Production 앱과 분리된 **PAPER 전용 OMS / Execution Safety / Execution Quality / Compounding Capital 준비 서비스**입니다.

## 절대 안전 경계

- `PAPER_ONLY`
- `LIVE_TRADING=false`
- `AUTO_TRADING=false`
- `REAL_ORDER_ENABLED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- 주문/private/account outbound network 권한 없음
- 실제 계좌/잔고/private provider API 호출 없음
- 실제 주문/취소/정정/이체/출금 없음
- Production/Staging route 미연결
- 기본 bind `127.0.0.1:8792`

공개 시세 네트워크는 별도이며 기본 OFF입니다. 명시적으로 활성화한 경우에만 hard-coded Upbit/Bitget public WebSocket을 사용할 수 있고 주문 권한은 만들지 않습니다.

## v0.5 기반 유지

- Durable Paper OMS + idempotency 재시작 복구
- `fsync` → atomic rename → directory `fsync`
- 손상 state fail-closed
- 중단 주문 `recoveryHold`, 자동 재제출 0
- Upbit/Bitget public-only WebSocket runtime
- sequence/clock/stale/circuit breaker
- server-attested public evidence와 caller evidence 분리
- spread/deviation/depth/slippage guard

## v0.6 Execution Cost / TCA / Paper↔Live Parity

- `POST /v1/execution/costs/preview`
- `POST /v1/execution/tca/preview`
- `POST /v1/paper/orders/:orderId/tca/preview`
- `POST /v1/parity/preview`

수수료/세금/FX/펀딩은 explicit evidence만 사용하고 현재 값을 코드에 하드코딩하지 않습니다. TCA는 fill VWAP, fill ratio, implementation/decision shortfall, prediction error, all-in shortfall을 측정합니다.

Canonical provider 계약은 KR/US stock=Toss, crypto spot=Upbit, crypto futures=Bitget입니다. 모두 일치해도 `CONTRACT_MATCH_DISABLED`일 뿐이며 실제 Paper↔Live runtime parity proven=false입니다.

## v0.7 서버 장애 / 로스컷 보호 기반

- 신규노출 watchdog gate는 default OFF
- heartbeat missing/stale/future → 신규노출 fail-closed
- 체결 후 보호 ACK가 없으면 다음 신규진입 차단
- 재시작 시 pending protection은 `RECONCILIATION_REQUIRED`
- 중단 entry/protection 자동 재제출 0
- KR/US/Spot `SELL`, Futures `reduceOnly=true`는 장애 시에도 축소/청산 예외
- provider-native stop 지속성은 실제 증거 전까지 지원된 것으로 추정하지 않음
- 실제 emergency execution은 없고 `REDUCE_OR_CLOSE_SIMULATION_ONLY` intent만 제공

## v0.8 자동 복리 자본관리 — Paper only

기본 정책:

- 최초 관리자본 상한: `1,000,000 KRW`
- 현재 compound/high-watermark 기준 +10% 도달 시 기준자본의 5%를 `profitReserveKrw`로 잠금
- 나머지 5%만 복리 기준자본에 편입
- 손실 시 high-watermark는 낮추지 않고 실제 주문가능 자본만 현재 managed equity까지 즉시 축소
- 단순 회복으로 동일 수익구간의 reserve를 다시 생성하지 않음
- 시작 계좌가 100만원을 초과하면 초과분은 `initialExcludedCapitalKrw`로 분리하여 수익으로 오인하지 않음

예시:

- 600,000 → 660,000
- 30,000원 = `PAPER_LOCKED_NON_TRADEABLE_ONLY`
- 복리 기준 = 630,000원
- 이후 손실로 managed active equity가 600,000원이면 주문가능 한도도 600,000원으로 축소
- high-watermark는 630,000원을 유지

### OMS 강제 게이트

`TEG_PAPER_COMPOUNDING_CAPITAL_ENABLED=true`일 때 신규노출은 실제 Paper OMS state와 latest capital settlement에 묶여 직렬화됩니다.

- 동시 신규주문은 admission queue로 직렬화하여 자본한도 초과 race를 차단
- 취소되지 않은 신규 entry 주문의 committed notional도 자본을 예약
- filled entry는 fresh flat settlement 전까지 자본을 계속 예약
- `SELL` / `reduceOnly` 축소·청산은 자본 gate 예외
- direct KRW valuation은 현재 KR stock 및 Upbit `KRW-*` Spot만 인정
- US stock / USDT Futures 등 외화 신규노출은 authoritative KRW valuation adapter가 없으므로 fail-closed

### 자본 settlement

- `GET /v1/capital/health`
- `POST /v1/capital/settlement`

settlement ingest는 `TEG_PAPER_COMPOUNDING_SETTLEMENT_INGEST_ENABLED=true`일 때만 열리고 기본 OFF입니다.

settlement는 다음 simulated evidence를 요구합니다.

- `positionsFlat=true`
- `openOrderCount=0`
- `managedExposureKrw=0`
- 기존 exposure-increasing OMS 주문이 아직 open이면 차단
- settlement sequence/timestamp/idempotency는 monotonic/fail-closed

현재 settlement authority는 `CALLER_SUPPLIED_SIMULATED_FLAT_EVIDENCE_ONLY`이며 실제 계좌/브로커 reconciliation이 증명된 상태가 아닙니다.

### 실제 출금은 아직 하지 않음

`profitReserveKrw`는 **재투자 금지로 잠긴 Paper 자금**일 뿐 실제 은행·거래소 출금이 아닙니다.

- `externalWithdrawalSupported=false`
- `externalWithdrawalPerformed=false`
- transfer/withdrawal/private API 호출 0

실제 자동출금은 provider별 공식 권한, 2FA, 출금 제한, 계좌 reconciliation을 별도 승인·검증한 뒤의 후속 단계입니다.

## 검증

```bash
cd trade-execution-gateway
npm test
```

전용 exact-head workflow와 기존 Application CI exact-head bridge가 package test를 직접 실행합니다. Public WebSocket 단위 테스트는 deterministic mock transport를 사용하며 검증 중 주문/private network는 활성화하지 않습니다.

## 의도적 미연결

- authenticated read-only account/order/protection reconciliation adapter
- authoritative USD/USDT → KRW valuation adapter
- actual broker/exchange fee statement ingestion
- server-authoritative live portfolio policy
- real Paper↔Live runtime replay/parity harness
- actual private order/cancel/amend adapter
- actual provider-native protective stop adapter
- actual bank/exchange withdrawal adapter
- Production route / 실주문

별도 승인 전까지 연결하지 않습니다.

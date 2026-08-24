# Standalone Trade Execution Gateway v0.6

Production 앱과 분리된 **PAPER 전용 OMS / Execution Safety / Execution Quality 준비 서비스**입니다.

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

## v0.6 Execution Cost Evidence

수수료/세금/환전비용/펀딩을 **코드에 현재 값으로 하드코딩하지 않습니다.**

`POST /v1/execution/costs/preview`

비용 schedule은 반드시 다음을 명시합니다.

- market/provider/symbol identity
- source + scheduleVersion
- currency
- effectiveFrom/effectiveTo
- maker/taker fee bps
- buy/sell tax bps
- FX conversion bps

선물 funding은 각 event마다 `rateBps`와 `payerSide=LONG|SHORT`를 명시하므로 provider 방향 규칙을 코드가 추측하지 않습니다.

결과는 항상 `READ_ONLY_PAPER_COST_ESTIMATE`이며 actual broker charge evidence가 아닙니다.

## v0.6 Execution Quality / TCA

- `POST /v1/execution/tca/preview`
- `POST /v1/paper/orders/:orderId/tca/preview`

측정값:

- fill VWAP
- fill ratio / COMPLETE vs PARTIAL
- arrival-price implementation shortfall bps
- decision-price shortfall bps
- pre-trade expected-fill prediction error bps
- explicit cost evidence 포함 all-in shortfall bps

실제 거래소 fill이라고 주장하는 evidence는 v0.6에서 검증된 것으로 받아들이지 않습니다. Paper fill 또는 caller-supplied read-only evidence만 분석하며 `executionAuthority=NONE`입니다.

## v0.6 Paper↔Live Parity Foundation

`POST /v1/parity/preview`

현재 canonical provider 계약:

- KR/US stock → Toss
- crypto spot → Upbit
- crypto futures → Bitget

Live candidate는 반드시 `runtimeStatus=DISABLED`이고 private/order/cancel/amend runtime 권한이 모두 꺼져 있어야 합니다.

비교 항목:

- order intent fields
- LIMIT/MARKET
- cash BUY/SELL 또는 futures LONG/SHORT
- OMS state model
- idempotency
- strict precision
- partial fill
- cancel/replace semantics
- risk revalidation
- cost evidence
- reconciliation
- futures reduceOnly

계약이 전부 맞아도 결과는 `CONTRACT_MATCH_DISABLED`일 뿐이며 `activationAllowed=false`, 실제 Paper↔Live runtime parity proven=false입니다.

## 검증

```bash
cd trade-execution-gateway
npm test
```

전용 exact-head workflow와 기존 Application CI exact-head bridge가 package test를 직접 실행합니다. Public WebSocket 단위 테스트는 deterministic mock transport를 사용하며 검증 중 public network는 활성화하지 않습니다.

## 의도적 미연결

- authenticated read-only account/order reconciliation adapter
- 실제 broker/exchange fee statement ingestion
- actual private order/cancel/amend adapter
- server-authoritative live portfolio policy
- real Paper↔Live runtime replay/parity harness
- Production route / 실주문

별도 승인 전까지 연결하지 않습니다.

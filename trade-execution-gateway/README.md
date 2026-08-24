# Standalone Trade Execution Gateway v0.1

Production 앱과 분리된 **OMS / Risk / Broker Adapter 준비 서비스**입니다.

현재 버전의 목적은 스마트 호가창/매매창 뒤에 붙을 주문 실행 계층을 독립적으로 준비하는 것입니다. 이 디렉터리는 기존 `api-server`, `stock-analyzer`, Production 배포, DB, Secret, 기존 주문 경로를 수정하지 않습니다.

## 현재 권한

- `PAPER_ONLY`
- `LIVE_TRADING=false`
- `REAL_ORDER_ENABLED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- 실계좌/잔고/포지션 조회 없음
- 주문/취소를 포함한 외부 broker/exchange 네트워크 요청 없음
- 메모리 저장만 사용
- 기본 bind `127.0.0.1:8792`

즉, 환경변수를 실수로 추가해도 v0.1은 live/private/network adapter 자체를 거부합니다.

## 구조

```text
스마트 호가창 / 주문 티켓 (향후 연결)
        ↓
Trade Execution Gateway
        ├─ Order intent normalization
        ├─ Risk policy
        ├─ Idempotent OMS
        └─ Broker Adapter contract
                ↓
        PaperMockBrokerAdapter (현재 유일)
```

기존 UI/거래 기능을 재작성하지 않습니다.

- 기존 AI 매매 워크스페이스/호가창: 향후 주문 티켓 producer로 연결
- 기존 Paper approval: 향후 승인 evidence consumer로 연결
- 기존 trading readiness/profitability/risk 계약: 향후 live adapter 승격 전 prerequisite로 연결

현재 단계에서는 서로 import하거나 route를 바꾸지 않아 기존 운영 배포에 영향이 없습니다.

## 실행

Node.js 20 이상:

```bash
cd trade-execution-gateway
npm test
npm start
```

`npm start`는 loopback에만 바인딩합니다. 외부 인터페이스 bind 옵션은 제공하지 않습니다.

## Paper risk 설정

주문을 받으려면 시장별 수량/금액 상한을 둘 다 명시해야 합니다. 누락 시 `RISK_POLICY_NOT_CONFIGURED`로 fail-closed 합니다.

```text
TEG_PAPER_MAX_QUANTITY_KR_STOCK
TEG_PAPER_MAX_NOTIONAL_KR_STOCK
TEG_PAPER_MAX_QUANTITY_US_STOCK
TEG_PAPER_MAX_NOTIONAL_US_STOCK
TEG_PAPER_MAX_QUANTITY_CRYPTO_SPOT
TEG_PAPER_MAX_NOTIONAL_CRYPTO_SPOT
TEG_PAPER_MAX_QUANTITY_CRYPTO_FUTURES
TEG_PAPER_MAX_NOTIONAL_CRYPTO_FUTURES
```

`TEG_PORT`만 1024~65535 범위에서 변경할 수 있습니다. host는 `127.0.0.1`로 고정됩니다.

## API

### `GET /health`

실행 상태, adapter, 설정된 risk market과 안전 플래그를 반환합니다.

### `GET /v1/contracts`

시장/방향/주문타입/상태 및 Broker Adapter 안전 계약을 반환합니다.

### `POST /v1/orders/preview`

주문을 제출하지 않고 intent + risk 검증만 수행합니다.

### `POST /v1/paper/orders`

Risk gate를 통과한 Paper 주문만 OMS에 등록하고 `PaperMockBrokerAdapter`에 제출합니다. 실제 체결을 만들지 않으며 `fillEvidence=null`입니다.

### `GET /v1/orders/:orderId`

메모리 OMS의 Paper 주문 상태를 조회합니다.

### `POST /v1/paper/orders/:orderId/cancel`

Paper mock 주문만 취소합니다.

## 필수 주문 계약

예시:

```json
{
  "mode": "PAPER",
  "market": "KR_STOCK",
  "symbol": "005930",
  "side": "BUY",
  "orderType": "LIMIT",
  "quantity": 10,
  "limitPrice": 70000,
  "idempotencyKey": "workspace-005930-20260824-001"
}
```

Cash 시장은 `BUY/SELL`, 코인 선물은 `LONG/SHORT`만 허용합니다. `MARKET` Paper 주문은 risk notional 계산을 위해 `referencePrice`가 필요합니다.

## 실제 증권사 API를 붙이는 다음 단계

v0.1에 실제 증권사 API 키를 넣지 않습니다. 이후 별도 승인된 PR에서만 다음을 추가합니다.

1. 해당 증권사 공식 주문/취소/조회 capability 검증
2. 별도 Broker Adapter 구현
3. 서버 측 계좌/권한/수익성/리스크/중복주문/idempotency/reconciliation 검증
4. Secret 저장 경계 및 감사로그
5. Mock/Paper와 Live adapter의 완전 분리
6. Staging에서 실제 계좌 주문 없이 private-read 및 계약 검증
7. 별도 명시 승인 후에만 live-order 권한 검토

현재 `TradeExecutionGateway`는 `liveTrading=true`, `privateTradingApiAllowed=true`, `outboundNetwork=true`인 adapter를 `UNSAFE_ADAPTER_REJECTED`로 차단하므로 실제 주문 연결은 암묵적으로 활성화될 수 없습니다.

## 배포 상태

`PREPARED_AS_ISOLATED_SOURCE_ONLY`

- Production deploy: 하지 않음
- Staging deploy: 하지 않음
- 기존 서버/PM2/Caddy: 변경하지 않음
- 기존 DB/Supabase: 변경하지 않음
- 기존 Secret/env: 변경하지 않음
- 기존 앱 route/navigation: 변경하지 않음

독립 실행/배포 활성화는 현재 PR 범위가 아니며 별도 승인 대상입니다.

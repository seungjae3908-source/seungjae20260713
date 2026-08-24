# Standalone Trade Execution Gateway v0.2

Production 앱과 분리된 **OMS / Risk / Broker Adapter 준비 서비스**입니다. 기존 `api-server`, `stock-analyzer`, DB, Secret, Staging/Production 배포 경로는 수정하지 않습니다.

## 안전 상태

- `PAPER_ONLY`
- `LIVE_TRADING=false`
- `REAL_ORDER_ENABLED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- 외부 broker/exchange network outbound = 0
- 계좌/잔고/포지션 private read = 0
- 메모리 저장만 사용
- loopback `127.0.0.1:8792` 고정

환경변수를 잘못 넣어도 live/private/network adapter는 `UNSAFE_ADAPTER_REJECTED`로 거부됩니다.

## v0.2 연결 구조

```text
기존 #88 AI 매매 워크스페이스 / 읽기전용 호가
        │  (기존 파일 변경 0)
        │  PreparedMockOrder 호환 계약
        ▼
Workspace Bridge
        ├─ KR -> KR_STOCK
        ├─ US -> US_STOCK
        ├─ buy/sell -> BUY/SELL
        ├─ limit/market -> LIMIT/MARKET
        └─ MARKET referencePrice 없으면 fail-closed
        ▼
Trade Execution Gateway
        ├─ Order intent normalization
        ├─ Risk policy
        ├─ Idempotent OMS
        └─ PaperMockBrokerAdapter
```

기존 #88의 `sessionStorage` UI 파일은 이 PR에서 수정하지 않습니다. v0.2는 그 입력 형식을 독립 서비스가 받을 수 있는 호환 브리지와 endpoint만 준비합니다. 실제 앱 route 연결은 향후 별도 통합 승인 단계입니다.

## Workspace 호환 API

### `POST /v1/workspace/orders/preview`

기존 워크스페이스 주문 티켓을 OMS intent로 변환하고 Risk Preview만 수행합니다. Paper 주문조차 제출하지 않습니다.

```json
{
  "order": {
    "side": "buy",
    "orderType": "limit",
    "quantity": 10,
    "price": 70000,
    "ticker": "005930",
    "displayName": "삼성전자",
    "market": "KR"
  },
  "idempotencyKey": "workspace-005930-20260824-001"
}
```

시장가 주문은 브리지에서 현재가를 추정하지 않습니다. 호출자가 검증된 현재가를 `referencePrice`로 명시해야 하며 없으면 `WORKSPACE_REFERENCE_PRICE_REQUIRED`입니다.

### `POST /v1/workspace/paper/orders`

동일한 변환 뒤 Paper OMS에 기록합니다. `confirmPaper: true`가 없으면 `PAPER_CONFIRMATION_REQUIRED`로 차단합니다. 실제 증권사 주문은 발생하지 않고 `PaperMockBrokerAdapter` 메모리 상태만 바뀝니다.

## 기존 canonical API

- `GET /health`
- `GET /v1/contracts`
- `POST /v1/orders/preview`
- `POST /v1/paper/orders`
- `GET /v1/orders/:orderId`
- `POST /v1/paper/orders/:orderId/cancel`

## Paper risk 설정

시장별 수량/금액 상한을 모두 명시해야 합니다. 없으면 `RISK_POLICY_NOT_CONFIGURED`입니다.

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

## 실제 증권사 Adapter 준비 상태

실제 증권사 코드는 아직 실행 가능한 adapter가 아닙니다. 다음 disabled placeholder만 존재합니다.

| Provider | 상태 | 현재 canonical stock authority |
|---|---|---|
| Toss Securities | `CONTRACT_PLACEHOLDER_ONLY` | yes |
| Korea Investment & Securities (KIS) | `NON_CANONICAL_CANDIDATE_DISABLED` | no |
| Kiwoom Securities | `NON_CANONICAL_CANDIDATE_DISABLED` | no |

모든 placeholder는:

- `executionMode=DISABLED`
- credential 수신 불가
- account read 불가
- submit/cancel/amend 불가
- outbound network 불가
- `TradeExecutionGateway`에 주입하면 `UNSAFE_ADAPTER_REJECTED`

따라서 KIS/키움 골격을 추가했지만 기존 canonical provider 계약을 바꾸거나 실주문 경로를 만들지 않습니다.

## 실행/테스트

Node.js 20 이상:

```bash
cd trade-execution-gateway
npm test
npm start
```

테스트는 기존 OMS/Risk/idempotency와 함께 Workspace 변환, 시장가 fail-closed, explicit Paper 확인, Toss/KIS/Kiwoom disabled adapter 차단을 검증합니다.

## 배포 상태

`PREPARED_AS_ISOLATED_SOURCE_ONLY`

- Production deploy: 0
- Staging deploy: 0
- 기존 서버/PM2/Caddy 변경: 0
- 기존 DB/Supabase 변경: 0
- 기존 Secret/env 변경: 0
- 기존 앱 route/navigation 변경: 0
- private broker request: 0
- real order/cancel/amend/transfer/withdrawal: 0

독립 실행/배포 활성화와 기존 앱 UI 연결은 별도 승인 대상입니다.

# Standalone Trade Execution Gateway v0.3

Production 앱과 분리된 **PAPER 전용 OMS / Risk / Broker Adapter 준비 서비스**입니다.

## 격리 원칙

- 변경 경로: `trade-execution-gateway/**`만
- 기존 `api-server`, `stock-analyzer`, `.github`, DB/Supabase, Production/Staging 설정 변경 없음
- 기본 bind: `127.0.0.1:8792`
- 메모리 저장만 사용
- 실제 계좌/잔고/포지션/private provider 호출 없음
- 실제 주문/취소/정정/이체/출금 없음

## 안전 계약

- `PAPER_ONLY`
- `LIVE_TRADING=false`
- `REAL_ORDER_ENABLED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- `outboundNetwork=false`
- `productionIntegrated=false`
- live/private/network adapter 장착 불가
- 실제 broker placeholder는 credential/account/order/network 권한이 모두 0

## v0.3 구조

```text
AI 매매 워크스페이스 / 코인 주문 티켓
              ↓
     Workspace / Coin Bridge
              ↓
      Market Rule Evidence
   tick / lot / min notional
              ↓
     Portfolio Risk Guard
 exposure / daily loss / leverage
        / explicit kill switch
              ↓
              OMS
              ↓
       PaperMockBrokerAdapter
              ↓
    Reconciliation Preview
```

### 주식

기존 #88 주문 티켓을 다음 독립 API로 변환할 수 있습니다.

- `POST /v1/workspace/orders/preview`
- `POST /v1/workspace/paper/orders`
- Paper 기록은 `confirmPaper=true` 필수
- MARKET 주문은 명시적 `referencePrice` 필수

### 코인 현물

Canonical provider 계약:

- `CRYPTO_SPOT -> upbit`
- side: `BUY / SELL`
- leverage: 1x only
- provider의 fresh market-rule evidence 필수
- tick size / lot size / minimum notional이 맞지 않으면 자동 반올림하지 않고 fail-closed
- portfolio exposure / open orders / daily loss / kill-switch evidence 필수

### 코인 선물

Canonical provider 계약:

- `CRYPTO_FUTURES -> bitget`
- side: `LONG / SHORT`
- leverage 필수
- margin mode: `ISOLATED / CROSS`
- `reduceOnly` 명시 가능
- provider max-leverage evidence 필수
- portfolio max-leverage 정책도 별도 적용
- market rule과 portfolio policy 중 더 강한 차단이 우선

### 실제 Provider Adapter 준비 상태

- Toss: stock canonical placeholder, disabled
- Upbit: spot canonical placeholder, disabled
- Bitget: futures canonical placeholder, disabled
- KIS: non-canonical candidate, disabled
- Kiwoom: non-canonical candidate, disabled

모든 placeholder:

- `executionMode=DISABLED`
- credentials accepted = false
- account read = false
- order/cancel/amend = false
- private WebSocket = false
- outbound network = false

## Reconciliation

`POST /v1/reconciliation/order/preview`

OMS order evidence와 caller-supplied broker evidence를 **읽기 전용으로 비교**합니다.

- broker evidence가 없으면 `BROKER_EVIDENCE_MISSING`
- broker order ID mismatch를 명시
- order state mismatch를 명시
- `FILLED/PARTIALLY_FILLED`인데 fill evidence가 없으면 `FILL_EVIDENCE_REQUIRED`
- OMS state를 자동 변경하지 않음
- broker network를 직접 조회하지 않음

향후 실제 provider 연결 시에는 이 계약 뒤에 authenticated read adapter를 별도 승인으로 추가해야 합니다.

## Paper Risk 설정

기존 gateway max quantity/notional 상한은 환경변수로만 설정합니다.

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

코인 v0.3 preflight의 market-rule / portfolio-policy / kill-switch 데이터는 **PAPER-only caller evidence**이며 live authority가 아닙니다. 실제 live 전환 시에는 반드시 서버 authoritative policy/evidence로 대체해야 합니다.

## 실행

```bash
cd trade-execution-gateway
npm test
npm start
```

## 다음 단계

아직 의도적으로 연결하지 않은 항목:

1. public-only WebSocket 호가/체결 stream
2. stale-price / price-deviation / spread / slippage guard
3. partial-fill state machine
4. cancel/replace / OCO / bracket / trailing contract
5. server-authoritative portfolio policy
6. authenticated read-only reconciliation adapter
7. rate-limit / clock-sync / provider-health circuit breaker
8. execution-quality / TCA
9. Paper↔Live parity harness
10. 실제 private/live broker adapter

실제 private API, 실제 계좌 읽기, 실주문 및 Production 연결은 별도 명시 승인 전 금지입니다.

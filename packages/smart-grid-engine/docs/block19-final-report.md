# BLOCK 19 — AI Autonomous Grid 최종 기술 문서

**기준 커밋**: 66e3c0f9bd82a5f72c0181dda898d3dd62345548
**브랜치**: feature/block19-ai-grid
**작성 시점**: 2026-10-30
**문서 상태**: Paper 파이프라인 구현 완료, 실거래 미활성화

---

## 0. 문서 원칙

본 문서는 **실제 구현된 기능**과 **향후 계획**을 명확히 구분한다.
다음을 주장하지 않는다: 실거래 수익성 검증 완료 / 실제 Bitget 공개 데이터 연결 완료 / 실제 Telegram 전송 완료 / Paper 테스트 결과를 실제 체결 결과로 해석.

---

## 1. BLOCK 19 전체 아키텍처

### 1.1 목표

Bitget USDT 무기한 선물을 대상으로 AI가 시장 국면을 판단하고 스스로 전략·그리드·레버리지·자본을 결정하되 **실제 주문 없이 Paper 환경에서만 검증**하는 자율형 그리드 엔진.

### 1.2 절대 안전 원칙

- 실거래 API 호출 **0건**
- LIVE 게이트 반환값 `allowed:false` **항상 강제**
- `.env` 접근 **0건**, `paper-abc/` 접근 **0건**
- 기존 4개 수정 파일(backtest-engine, bitget-adapter, grid-math, risk-manager) **무변경 유지**

---

## 2. Step 1~5 AI Grid 엔진 (커밋 fae9dbab9)

| 파일 | 라인 | 역할 |
|---|---|---|
| `market-regime-classifier.mjs` | 157 | 4국면 + FAIL_CLOSED |
| `ai-strategy-selector.mjs` | 137 | 4국면 → 4전략 + B fallback |
| `adaptive-grid-planner.mjs` | 318 | ATR 기반 그리드 계획 |
| `ai-risk-orchestrator.mjs` | 427 | 500K 한도, 레버리지 1-10, UTC 일일 손실, 청산 위험, 수수료/펀딩 |
| `live-order-gate.mjs` | 233 | LIVE 다중 조건 차단 |
| `paper-execution-adapter.mjs` | 264 | 가상 체결 (LONG/SHORT) |
| `elite-trader-analyzer.mjs` | 264 | advisoryOnly, 주문 권한 없음 |

국면 → 전략: STRONG_UPTREND→LONG_TRAILING_GRID / STRONG_DOWNTREND→SHORT_TRAILING_GRID / SIDEWAYS→NEUTRAL_GRID / HIGH_VOLATILITY→NO_NEW_ENTRY / FAIL_CLOSED→SAFE_WAIT.

`ai-strategy-selector`는 항상 `fallback: STRATEGY_B_FALLBACK` 포함.

---

## 3. Step 6-B AI Paper Orchestrator (커밋 a7686279b)

파이프라인 순서: 시장 데이터 검증 → AI 판단 + 그리드 → 위험 검증 → LIVE 게이트(기록만) → Paper 전용 분기(선행조건: 시장/AI/위험/수량, **LIVE candidateEligible 참조 안 함**) → paper 실행 → B 병렬 → 3-state 저장 → 리포트.

---

## 4. Step 6-C NEUTRAL_GRID (커밋 b429aa162)

- LONG/SHORT와 **완전 독립** (별도 state 파일, 별도 로직)
- 3-state 레벨: EMPTY / BUY_PENDING / HOLDING
- 경계: IN_RANGE / BREACH_HIGH / BREACH_LOW
- 경계 이탈 시 신규 BUY_PENDING 재장전 금지
- `calculateGridLevels`는 `gridCount+1` 반환 → `slice(0, gridCount)` 처리
- NaN/Infinity/`high<low`/`close` 범위 밖 → fail-closed, 상태 미변경
- 중복 ts → DUPLICATE_TS skip


---

## 5. Step 6-E Gitignore (커밋 9b3f1d5a0)

`.gitignore`: `.runtime/`, `.backups/`, `paper-state.bak-*/`, `paper-reports/`, `*.bak.*`, `*.corrupt.*`, `*.bak`, `*.bak-*`.

디스크의 15개 `.bak.*` 무시 중. 삭제는 별도 승인.

## 6. Step 7-Lite Notification (커밋 66e3c0f9b)

| 파일 | 라인 |
|---|---|
| notification-payload-builder.mjs | 241 |
| notification-queue.mjs | 136 |
| mock-telegram-adapter.mjs | 68 |
| tests/block19-notifications.test.mjs | 397 |

### 6.1 지원 이벤트 (7종)

AI_PAPER_ENTRY, NEUTRAL_BUY, NEUTRAL_SELL, B_TRAILING_CYCLE, RISK_BLOCK, FAIL_CLOSED, DAILY_SUMMARY

### 6.2 Queue 상태 전이

```
enqueueEvent()  -> pending
drainPending()  -> delivered_mock
markFailed()    -> failed
```

중복 방지 = SHA256(parts) 앞 16자. 순서 유지 = 배열 append-only. Atomic save = `tmp.<ts>.<uuid>` → `renameSync`. 손상 격리 = `.corrupt.<ts>.<uuid>` rename.

### 6.3 정적 안전 검증 (완료)

fetch/axios/http/https 0건, `api.telegram.org` 0건, Bot Token 0건, `.env`/`dotenv`/`process.env` 0건, `/opt/stock-app` 0건, `paper-abc` 0건, 실주문 함수 0건. 모든 반환값 `realApiCalled:false`, `mock:true` 강제.

### 6.4 미완성

실제 Telegram 전송 미구현 (Bot Token + 네트워크 필요). orchestrator→queue 통합 미완료 (인터페이스만). `/opt/stock-app`의 텔레그램 `.ts` 파일 참고/복사 0건.

## 7. AI/B/NEUTRAL 상태 저장 구조

세 상태 파일 물리적 완전 분리. B 실패가 AI 상태를 손상시키지 않음.

```
.runtime/paper-ai/
├── state-ai.json       (LONG/SHORT)
├── state-b.json        (B Trailing, read-only)
├── state-neutral.json  (NEUTRAL, 독립)
└── reports/YYYY-MM-DD.json
```

- AI: version, initialUsdt, usdtBalance, positions{}, orders{}, fills[], feesPaid, fundingPaid, realizedPnl
- B: `paper-forward-trailing.initStateB()` 스키마 (Step 6-B read-only)
- NEUTRAL: symbol, lowerPrice, upperPrice, gridCount, spacing, quantityPerGrid, usdtBalance, baseHolding, levels[{idx, price, state, qty, entryPrice, entryTs, entryFee}], realizedPnl, feesPaid, roundTrips, fills[], boundaryState, lastCandleTs

손상 처리: `.corrupt.<ts>.<uuid>` rename. B 실패가 AI 상태 무영향 (E2, E3 검증).

## 8. 리스크 관리 (`ai-risk-orchestrator.RISK_DEFAULTS`)

| 항목 | 값 |
|---|---|
| 하드 캡 | 500,000 KRW |
| 최대 투입 | 65% |
| 최소 예비금 | 30% |
| 레버리지 | 1~10 (자동 결정 상한 5x) |
| 일일 손실 한도 | 100,000 KRW (UTC) |
| 청산 안전거리 | 10% |
| 중복 주문 TTL | 60분 |

전략별 deployFraction: LONG/SHORT 0.55, NEUTRAL 0.45, NO_ENTRY/SAFE_WAIT 0. 레버리지 자동: ATR% >=2% → 1x, >=1% → 2x, >=0.5% → 3x, 그 외 4x. NEUTRAL 최대 2x.

일일 손실: `utcDayKey(nowMs)` = ISO date 앞 10자. 날짜 변경 시 0 리셋. `statePath` 제공 시 재시작 후에도 손실 누적 유지.

## 9. LIVE 게이트 안전 구조

### 9.1 반환값 (모든 경로)

allowed: false, wouldExecute: false, realApiCalled: false, candidateEligible, reasons[], checks{flags, authority, approval, market, account, consistency, risk, size}.

### 9.2 SAFE_LIVE_ENV 하드코딩

LIVE_TRADING=false, AUTO_TRADING=false, REAL_ORDER_ENABLED=false, PRIVATE_TRADING_API_ALLOWED=false, EXECUTION_AUTHORITY=NONE.

### 9.3 다중 검사

4개 플래그 true + EXPLICIT_LIVE + 승인토큰(>=16자) + 시장 신선도(<=60초) + 계좌 신선도(<=120초) + 계좌 일관성 + 위험 평가 + 수량/자금 한도. 모든 통과해도 allowed=false 유지.

### 9.4 Paper 분기 (지시서 §3)

`paperPrecondsMet`는 LIVE 게이트 `candidateEligible` 참조 안 함. Paper는 LIVE 게이트를 우회하지 않으며 독립된 실행 경로. LIVE 결과는 payload에 기록만.

## 10. 전체 테스트 결과 (HEAD 66e3c0f9b)

| 스위트 | tests | pass | fail | skip |
|---|---|---|---|---|
| block19-regime | 18 | 18 | 0 | 0 |
| block19-strategy | 35 | 35 | 0 | 0 |
| block19-risk | 37 | 37 | 0 | 0 |
| block19-gate | 61 | 61 | 0 | 0 |
| block19-elite | 15 | 15 | 0 | 0 |
| block19-regression | 9 | 8 | 0 | 1 (E55) |
| block19-orchestrator | 26 | 26 | 0 | 0 |
| block19-neutral-grid | 26 | 26 | 0 | 0 |
| block19-notifications | 32 | 32 | 0 | 0 |
| 합계 | 259 | 258 | 0 | 1 |

BLOCK 지시서 기재 258/257/0/1은 Step 6-C 시점 값. 실측 최종 259/258/0/1. E55 skip은 파일 부재로 인한 정당한 skip.

## 11. 알려진 결함 및 미검증

### 11.1 회귀 skip
E55 파일 없음 → skip (기준값 임의 생성 금지).

### 11.2 CLI demo 한계
- NEUTRAL demo fills 0: 횡보 fixture(99.9~100.1)가 grid level(90,94,98) 미도달. 엔진은 N2/N2b/N6/N6b로 검증됨.
- B trades n/a: 10 bars 내 B 그리드 미돌파.

### 11.3 커밋 상태
- 기존 4개 M 파일 (backtest-engine, bitget-adapter, grid-math, risk-manager) 커밋 밖 유지
- 백업 15개 `.bak.*` gitignore 무시 중, 디스크 잔존
- untracked (docs/, experiments/, paper-abc/ 등) 커밋 대상 아님

### 11.4 미검증
AI 실 시장 성과 / B vs AI vs NEUTRAL 비교 / Elite Trader 실 데이터 / 실 Telegram 전송

## 12. 실제 시장 데이터 연결 전 작업

`bitget-adapter.mjs`에 이미 존재: fetchCandles, fetchFundingRateHistory, fetchContractInfo, fetchLiveOrderBook, fetchKrwUsdtRate (모두 GET).

| 작업 | 내용 |
|---|---|
| 네트워크 예외 승인 | Bitget 공개 GET 파이프라인 허용 |
| orchestrator 파라미터화 | fixture → 실제 candle/indicators 소스 |
| 지표 계산 | OHLCV → ATR/ADX/RSI/MACD/BB/VWAP |
| 캐시/재시도 | 네트워크 오류 시 FAIL_CLOSED |
| 실행 스케줄 | cron/systemd 미등록 |

## 13. Telegram 실제 전송 전 작업

| 작업 | 내용 |
|---|---|
| 네트워크 예외 승인 | api.telegram.org/bot<TOKEN>/sendMessage 허용 |
| Bot Token 주입 | .env에 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, 로그 출력 금지 |
| 실제 어댑터 | real-telegram-adapter.mjs 신규 |
| orchestrator 통합 | buildPayloadsFromCycle → enqueueEvent → drainPending → send |
| 재시도 | 429 backoff, 5xx 재시도, 4xx markFailed |

크로스 프로젝트: /opt/stock-app/api-server/src/services/telegram-*.ts (30개) 는 .ts vs .mjs import 불가. 참고/복사/import 0건.

## 14. 배포 및 LIVE 활성화 승인 절차

Paper 파이프라인 완성, LIVE 미활성화.

| 단계 | 항목 | 승인 |
|---|---|---|
| A | 실 시장 데이터 연결 (Step 8) | 네트워크 예외 |
| B | 4주 이상 Paper 실행 검증 | 별도 계획 |
| C | Telegram 실제 알림 (Step 9) | 네트워크 + Bot Token |
| D | Bitget API 키 권한 검토 | 보안 검토 |
| E | .env LIVE 플래그 활성화 | 명시적 승인 |
| F | EXECUTION_AUTHORITY=EXPLICIT_LIVE + 승인 토큰 | 명시적 승인 |
| G | 라이브 로그/모니터링 | 운영 승인 |

코드 레벨 강제: 모든 커밋은 live-order-gate 변경 없음. LIVE 활성화는 .env 값 변경만으로 불가 — evaluateLiveGate의 allowed:false 상수를 조건부 로직으로 변경 + 리뷰 필수. 실주문 API 호출 코드도 신규 추가 + 보안 리뷰 필수.

문서 작성 시점 실제 Bitget 주문 0건, 계좌 변경 0건, .env 접근 0건, PM2 재시작 0건, 배포 0건, Git add/commit/push 0건.

---

## 부록 A. 커밋 히스토리

```
66e3c0f9b (HEAD) feat(smart-grid): block19 telegram notification interface stub
9b3f1d5a0 chore(smart-grid): gitignore runtime state and backup files
b429aa162 feat(smart-grid): block19 NEUTRAL_GRID paper execution
a7686279b feat(smart-grid): block19 AI paper pipeline orchestrator
fae9dbab9 feat(smart-grid): block19 AI autonomous grid engine
```

## 부록 B. 신규 파일 SHA256 (앞 16자)

| 파일 | SHA256 |
|---|---|
| market-regime-classifier.mjs | 90a9e4776cbfb4ee |
| ai-strategy-selector.mjs | 6f12297b8a4730e3 |
| adaptive-grid-planner.mjs | 743587930bbadf8d |
| ai-risk-orchestrator.mjs | 839cb5dff32827aa |
| live-order-gate.mjs | dbd20450d9eb6ad0 |
| paper-execution-adapter.mjs | e9bb015051cb01f6 |
| elite-trader-analyzer.mjs | adcfeeffcaed910f |
| neutral-grid-paper.mjs | e15cbb6c787f9078 |
| orchestrator-ai-paper.mjs | 674dd7c391ef5f83 |
| notification-payload-builder.mjs | 033206f552e56373 |
| notification-queue.mjs | e6fc7275d0dbb2d9 |
| mock-telegram-adapter.mjs | 0d4fd79fa435a050 |

## 부록 C. 기존 파일 보존 확인

backtest-engine 5cbb7e9c / bitget-adapter 5c4d885c / grid-math cc6e136f / risk-manager 3e0ed22e. experiments E1~H1 (cfc7cb92 / d85a1f37 / a05bb153 / da89f522 / 7a78121f / bdad4c92) 유지. paper-abc mtime 2026-10-30 13:13:37 유지.

**문서 끝**

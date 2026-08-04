# PR #51 / PR #52 승인형 주문 통합 계약

조사 기준일: 2026-08-04 (Asia/Seoul)

이 문서는 PR #51 승인형 자동매매 최적화와 PR #52 AI 신호검색기·승인 생명주기의 책임 경계, 직접 충돌, 주문 안전 경로, 테스트 소유권과 운영 완료 후 수동 통합 순서를 기록한다.

이 문서 추가는 동작 코드를 변경하지 않는다. PR 병합, rebase, cherry-pick, 배포, DB/Supabase/Secret 변경, 실계좌 조회, 거래소 인증 API 호출, 실제 주문 또는 live 활성화 플래그 변경을 포함하지 않는다.

## 1. 조사 기준

| 항목 | PR #51 | PR #52 |
| --- | --- | --- |
| 제목 | `feat: add cost-aware auto-trading optimization guardrails` | `feat: add AI scanner approval signal lifecycle` |
| 브랜치 | `agent/auto-trading-optimization-guardrails` | `agent/ai-scanner-approval-lifecycle` |
| 조사 시작 HEAD | `280fbe1c857e4365524b38f9fb08635a431b1653` | `65a01be54d3f5b1cc5fd8673cc0e43ceaec49aa5` |
| 상태 | open, Draft, 미병합, mergeable | open, Draft, 미병합, mergeable |
| 최신 main | `1987b74799d213b63d065c63a7c8c3b675a863f4` | 동일 |
| main 대비 | ahead 25, behind 3, diverged | ahead 72, behind 4, diverged |
| 변경 파일 | 17 | 38 |
| 최신 Application CI | `30883147603` success | `30888595069` success |
| 필수 status | 6/6 success | 6/6 success |
| 리뷰·미해결 스레드 | 0 | 0 |

필수 status 6개:

- `application-ci/verified`
- `browser-ui/verified`
- `security-integration/verified`
- `ai-privacy/verified`
- `database-rls/verified`
- `futures-public-network-smoke/verified`

## 2. 최종 책임 경계

### PR #52가 소유할 계약

- AI 조건검색과 시장별 scanner 결과
- 신호 생성, 유지, 약화, 해제, 만료, 재진입 주기
- `TradingSignalState`, 상태 이력과 승인 가능 상태
- 승인 요청 생성과 승인 알림 생명주기
- scanner 결과를 서버에서 다시 계산하여 Paper 계획 생성
- 승인 직전 scanner 조건, 가격, 1분 변동성, 호가 재검증
- 조건 해제 시 승인 비활성화와 미체결 잔량 취소 요청
- 승인 queue의 신호 상태·만료·재검증 표시
- 신호 알림과 전달 중복 방지
- 저장 검색과 scanner 시장 UI
- AI 차트에서 승인 대기 등록 화면으로 이동

### PR #51이 소유할 계약

- 비용 후 기대값, 위험예산, 주문금액 상한과 pilot 단계
- `TradingEconomics`, `TradingOptimizationAssessment`와 최적화 정책
- 승인된 주문 계획의 최종 위험 재검사
- 주문 생성과 실행 상태
- 계획·주문 idempotency와 주문 이벤트
- 자동 주문 모드의 정책·확인·긴급정지·재개
- Paper/mock/live adapter 선택
- Bitget, Upbit, Kiwoom 실행 adapter와 취소 adapter
- 체결·부분체결·취소·복구 상태
- 재시도와 모호한 네트워크 결과의 reconciliation
- 거래소별 연결 상태와 live 실행 서버 게이트
- 자동매매 설정·위험 최적화 UI

### 공유하되 단일 구현만 둘 계약

- `TradingPlan`과 `TradingOrder` 저장소
- `TradeAutomationService`
- `trade-approval-queue.tsx`
- `auto-trading.tsx`
- Phase 12 E2E route와 fixture
- `api-server/test.mjs` Phase 12 등록

공유 계약은 PR #52 병합 후 PR #51이 소비한다. 같은 상태나 queue를 두 벌로 유지하지 않는다.

## 3. 직접 충돌 행렬

| 파일 | PR #51 변경 | PR #52 변경 | 유형 | 최종 책임 | 수동 통합 원칙 |
| --- | --- | --- | --- | --- | --- |
| `api-server/src/services/trade-automation.types.ts` | 소문자 신호 상태, 경제성·위험평가·pilot·재검증 입력 | 대문자 신호 생명주기, validation·approval status·history·scanner context | A, D | 신호 상태 #52, 최적화 타입 #51 | #51의 `TradingSignalState` 제거. #52 상태를 유지하고 #51 경제성·위험 타입만 추가한다. |
| `api-server/src/services/trade-automation.service.ts` | create/approve/automatic/createOrder 위험 재검사와 riskAssessment | lifecycle 초기화·재검증·승인상태·무효화·미체결 취소 | A, C | lifecycle #52, 실행 위험검사 #51 | #52 흐름에 #51 `recheck`를 삽입한다. createOrder dedupe와 최종 위험검사는 한 번만 유지한다. |
| `api-server/src/services/trade-automation.repository.ts` | `listPlans` 추가, 100건 | `listPlans` 추가, 200건 | A | 공용 저장소 | 메서드 하나만 유지한다. 정렬은 파싱 가능한 날짜 기준으로 하고 한도를 명시한다. |
| `stock-analyzer/src/components/trade-approval-queue.tsx` | `/plans`·`/status`, 위험최적화 표시, 별도 queue 타입 | `/approval-queue`, lifecycle·10초 갱신·status 재확인·거절 | A, C, D | 구조·행동 #52, 위험 메타데이터 #51 | #52 queue 하나만 유지하고 서버 응답에 #51 EV·위험예산·최대금액·pilot 필드를 추가한다. |
| `stock-analyzer/src/pages/auto-trading.tsx` | 설정 + #51 queue, 제목 자동매매 | 알림 + #52 queue + 설정, 제목 승인형 주문 | A | 화면 구조 #52, 설정 #51 | 알림 → 단일 승인 queue → 위험 설정 순서. 승인 버튼은 하나만 둔다. |
| `stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx` | 경제성·pilot·confirmed/weakening fixture | lifecycle alert·READY/INVALIDATED fixture | A, D | 통합 fixture | #52 lifecycle fixture에 #51 riskAssessment를 추가한다. 상충 enum fixture를 제거한다. |
| `stock-analyzer/e2e/phase12-trade-automation.spec.ts` | 위험최적화와 queue·긴급재개 검증 | lifecycle·승인 비활성화·브라우저 오류 검증 | A | 기능별 공동, 시나리오 분리 | 파일을 lifecycle, execution, integrated E2E로 분리하거나 테스트명을 명확히 구분한다. |
| `api-server/test.mjs` | 최적화·policy guard·plan queue 테스트 등록 | lifecycle·alert·scanner approval·market 테스트 등록 | B, E | 테스트 runner | 두 목록을 합치되 중복 base 테스트는 한 번만 등록한다. |

공통 변경 파일은 위 8개다.

## 4. 타입 계약 해결

두 PR은 같은 `TradingSignalState` 이름에 서로 다른 값을 정의한다.

PR #51:

- `forming`
- `candidate`
- `confirmed`
- `weakening`
- `invalid`
- `expired`

PR #52:

- `WATCHING`
- `READY_FOR_APPROVAL`
- `WEAKENED`
- `INVALIDATED`
- `EXPIRED`

최종 계약은 PR #52의 상태를 사용한다. 승인 가능 여부가 상태 이름 자체가 아니라 다음 서버 조건의 결합으로 계산되기 때문이다.

- plan이 `APPROVAL_PENDING`
- signal이 `READY_FOR_APPROVAL`
- 승인 만료 전
- 신호 만료 전
- 마지막 서버 검증이 30초 이내

PR #51 최적화 서비스의 상태 판정은 다음처럼 변경한다.

- actionable: `READY_FOR_APPROVAL`
- terminal: `INVALIDATED`, `EXPIRED`
- 재검증 필요/경고: `WATCHING`, `WEAKENED`

`confirmed`를 별도 상태로 다시 만들지 않는다.

## 5. queue 구현 조사

### 서버 영속 queue

실제 서버 영속 상태는 한 체계다.

- 계획: `trade_order_plans`
- 주문: `trade_orders`
- 이벤트: `trade_order_events`

PR #51과 #52 모두 같은 repository를 사용한다. PR별 `TradeApprovalQueue`는 별도 저장 queue가 아니라 같은 계획·주문을 다르게 보여주는 경쟁 UI다.

### 사용자 화면에 남은 별도 레거시 queue

`ScannerPage`의 `viewMode === "auto"`는 다음 브라우저 저장소를 사용한다.

- `sa-auto-trade-settings-v1`
- `sa-auto-trade-candidates-v1`
- `sa-auto-trade-executed-v1`
- sessionStorage 실행키

이 경로는 `/api/stocks/auto-trade/*`를 호출하려 하지만 서버 route index가 `/stocks/auto-trade` 전체를 `PRIVATE_EXCHANGE_API_DISABLED`로 먼저 차단한다. 현재 실주문은 도달하지 않지만 공식 `/auto-trading`과 다른 상태·queue·용어를 노출한다.

최종 사용자 queue는 서버 `trade_order_plans` 기반 하나만 유지한다. `/scanner`의 auto 탭은 공식 `/auto-trading`으로 이동하거나, 주문 기능이 아닌 후보 미리보기로 명확히 축소해야 한다.

### 상태 대응

| 의미 | 최종 상태 |
| --- | --- |
| 승인 대기 | plan `APPROVAL_PENDING` + signal `READY_FOR_APPROVAL` |
| 실행 준비 | plan `SUBMITTED` |
| 실행 중 | order `SUBMITTED` 또는 `ACCEPTED` |
| 부분체결 | order `PARTIALLY_FILLED` |
| 완료 | order `FILLED` |
| 실패 | order `REJECTED` 또는 `RECOVERY_REQUIRED` |
| 만료 | plan/signal `EXPIRED` |
| 취소 | order `CANCELED` |
| 재시도 필요 | `RECOVERY_REQUIRED`, `retryCount`, `lastErrorCode` |

별도 `pending`, `executing`, `failed`, `cancelled` 문자열 queue를 추가하지 않는다.

## 6. 활성 사용자 경로

| 경로 | 실제 페이지 | queue/상태 생성 | 주문 함수 | 도달 가능 | 판정 |
| --- | --- | --- | --- | --- | --- |
| `/scanner` | `TechnicalWorkspacePage` → `ScannerPage` | 조건검색 결과와 브라우저 레거시 auto 후보 | 레거시 `/stocks/auto-trade` 호출 시도 | regular/admin | 서버 차단 상태. 공식 queue와 다른 기능이다. |
| `/scanner`, `viewMode="auto"` | `ScannerPage` 내부 auto 화면 | localStorage 후보·실행완료 key | `executeAutoTradeCandidates` | 사용자가 탭 클릭 | 공식 `/auto-trading`과 합쳐야 한다. UI 진입만으로 주문은 발생하지 않는다. |
| `/auto-trading` | `TechnicalWorkspacePage` → `AutoTradingPage` | 서버 plan/order 목록을 읽음 | 승인 버튼이 generic 또는 scanner paper approve 호출 | `canAccessPaperTrading` | 공식 승인형 주문 화면이다. |
| `/ai-chart` composer | `ScannerApprovalComposer` | 버튼 클릭 후 `/scanner/plans`가 서버검증 Paper plan 생성 | 주문 실행 없음 | KR scanner 선택 시 | 승인 요청 생성만 한다. |
| 신호 알림 | `TradeSignalAlerts` | plan history에서 파생 | 주문 함수 없음 | `/auto-trading` | 알림에는 승인 버튼이 없다. |
| 승인 queue | `TradeApprovalQueue` | 저장된 plan/order 읽기 | `/plans/:id/approve` | `/auto-trading` | 단일 최종 승인 버튼 위치다. |
| Phase 12 | `/__phase12-trade-automation-e2e` | fixture만 사용 | fixture 동작 | E2E flag에서만 | 사용자 메뉴에 노출 금지. |

저장 신호의 경로:

`ScannerPage` 종목 선택 → `/ai-chart` → `ScannerApprovalComposer` → 서버검증 Paper plan 생성 → `/auto-trading` → 승인 queue.

## 7. 승인부터 주문까지의 최종 안전 흐름

| 단계 | 최종 함수·소유권 | 검사 |
| --- | --- | --- |
| 신호 생성 | scanner/PR #52 | 검색 조건, 점수, 신뢰도, 위험점수 |
| 승인 요청 생성 | `ScannerApprovalPlanService.createPaperPlan`/#52 | 서버 재검색, 호가·캔들, 금액 상한, 중복 활성 종목 |
| 신호 생명주기 | `initializeSignalLifecycle`/#52 | 상태·만료·history |
| 승인 직전 provider 재검증 | `revalidatePaperPlan`/#52 | 같은 AND 조건, 최신 quote, 1분 변동, top-of-book, entry drift |
| 승인 가능 판정 | `revalidatePlan` + `approvalStatus`/#52 | READY, fresh, unexpired |
| 비용·위험 재검사 | `evaluateTradingPlan` + optimization/#51 | EV, risk budget, daily loss, spread, slippage, pilot, live gate |
| 승인 상태 전환 | 통합 `approvePlan` | lifecycle와 위험검사 모두 통과해야 `SUBMITTED` |
| 주문 생성 | 통합 `createOrder`/#51 | plan당 기존 order 확인, 최종 위험검사 |
| Paper 실행 | scanner paper route/#52 또는 공용 Paper adapter/#51 | 외부 거래소 요청 0 |
| live 실행 | `TradeExecutionService.execute`/#51 | 연결 mode 일치, server flags, 거래소 preflight |
| 결과 기록 | repository + order events/#51 | 상태 머신과 event append |
| 알림 | signal alerts/#52, order result UI/#51 | 신호와 주문 결과를 구분 |

## 8. Paper/live 분기와 실주문 위험

### Scanner 승인 경로

- 국내주식 KR Paper만 지원한다.
- 미국주식은 `US_ORDER_ADAPTER_NOT_AVAILABLE`로 차단된다.
- 승인 직전 서버 재검증 후 내부 Paper order를 `ACCEPTED` → `FILLED`로 전환한다.
- `exchangeRequestSent=false`, `liveOrderSubmitted=false`를 반환한다.
- 거래소 adapter를 호출하지 않는다.

### 공용 실행 경로

`TradeExecutionService.execute`가 유일한 지원 실행 중심이다.

- Paper와 비-Kiwoom mock은 외부 요청 없이 내부 체결한다.
- live는 저장된 연결·암호화 자격증명·account mode 일치가 필요하다.
- 전역 `ORDER_EXECUTION_ENABLED=true`
- 전역 `LIVE_TRADING_ACTIVATION_APPROVED=true`
- 거래소별 `*_LIVE_ORDER_ENABLED=true`
- 위 조건이 모두 맞아야 실제 adapter에 도달한다.
- 네트워크 timeout은 blind retry가 아니라 `RECOVERY_REQUIRED`로 전환한다.
- mock 실패가 live endpoint로 fallback하는 코드는 없다.

현재 코드상 통제된 live 실행 중심 경로는 1개이며 그 아래 Bitget·Upbit·Kiwoom 3개 adapter 분기가 있다. 이번 조사에서는 어떤 실행 함수·인증 API·계좌 조회·주문 endpoint도 호출하지 않았다.

## 9. 권한 경계

클라이언트:

- `/auto-trading`은 `canAccessPaperTrading` gate로 감싼다.
- 버튼 비활성화와 확인 dialog는 보조 UX다.

서버:

- 인증 후 `/trade-automation` 전체에 `requireCapability('canAccessPaperTrading')`를 적용한다.
- regular/admin만 해당 capability를 가진다.
- scanner revalidation endpoint는 별도 `SIGNAL_MONITOR_TOKEN`을 timing-safe 비교한다.
- explicit approval body가 없으면 승인하지 않는다.
- live 실행은 서버 환경 플래그와 연결 mode를 재확인한다.

권한은 클라이언트에만 존재하지 않는다.

## 10. idempotency와 동시성

현재 존재하는 보호:

- plan key: `user + exchange + signalId + strategyId + market + symbol + side` SHA-256
- plan 생성 전 `findPlanByIdempotency`
- scanner signal ID는 5분 bucket 포함
- scanner는 같은 종목의 활성 plan/order를 별도 차단
- order 생성 전 `findOrderByPlan`
- exchange client order ID는 plan idempotency key에서 결정
- PR #52 UI는 같은 탭의 연속 클릭을 `actionId`로 차단
- 순차 중복 호출 테스트가 존재한다.

남은 위험:

- plan 조회→생성, 승인상태 조회→저장, order 조회→생성이 원자적 transaction/CAS가 아니다.
- repository upsert conflict target은 `user_id,id`다.
- 코드에서 `user_id,idempotency_key`, `user_id,plan_id`, `client_order_id`의 원자적 고유 보장을 확인할 수 없다.
- 서로 다른 탭·프로세스가 동시에 승인하면 두 요청이 모두 이전 상태를 읽을 수 있다.
- 현재 테스트는 동시 `Promise.all` 승인 또는 order 생성 경쟁을 검증하지 않는다.

따라서 병합 전 다음 중 하나를 별도 승인된 DB/서버 작업으로 구현해야 한다.

1. DB conditional state transition + unique `(user_id, plan_id)` order 제약
2. 단일 transaction/RPC로 approval CAS와 order insert 수행
3. 같은 idempotency key·client order ID 충돌을 성공적 duplicate로 복구

DB 변경은 이 조사 범위에서 수행하지 않는다.

## 11. auto-trading.tsx 수동 통합안

최종 레이아웃:

1. 제목 `승인형 주문`
2. Paper/live 상태와 server live gate 배지
3. `TradeSignalAlerts`
4. 단일 `TradeApprovalQueue`
5. `TradeAutomationSettings`
6. 주문·체결·복구 상태

규칙:

- #52 queue를 기준 구현으로 사용한다.
- #51 queue 컴포넌트는 제거한다.
- #51의 `riskAssessment`를 #52 approval queue item의 선택 필드로 확장한다.
- 승인 버튼은 한 카드에 하나만 둔다.
- `approvalStatus.approvalEnabled=false`이면 버튼을 비활성화한다.
- 버튼 클릭 후 status 조회만으로 끝내지 않고 scanner plan은 provider 재검증 route를 거친다.
- 서버 재검증 실패 시 plan/order 생성 또는 adapter 실행을 금지한다.
- UI mount, polling, focus, online 이벤트는 읽기 요청만 수행한다.
- Paper, mock, live를 명확한 배지와 문구로 구분한다.
- live는 서버 플래그 false이면 실행 버튼 대신 차단 이유를 표시한다.

## 12. 테스트 소유권

### PR #52 소유

- signal lifecycle 순수 함수
- WATCHING/READY/WEAKENED/INVALIDATED/EXPIRED
- freshness 30초, 만료, clock skew
- 승인 가능/비활성 reason code
- monitor token 인증
- 조건 해제·만료 알림과 재진입 cycle
- scanner server plan 생성
- 승인 직전 scanner 재검증
- 조건 해제 시 order 0
- 부분체결 보존·미체결 취소
- saved search와 KR/US/spot/futures scanner UI

### PR #51 소유

- EV 계산
- 표본·profit factor·drawdown·cost 검증
- 위험예산 기반 주문금액 상한
- correlated exposure·slippage·spread·pilot gate
- policy downgrade 방지와 emergency resume
- Paper/mock/live adapter 분기
- createOrder 최종 risk recheck
- 실행·취소·recovery와 client order ID
- 설정 UI와 최적화 요약

### 통합 후 추가할 E2E/통합 테스트

1. scanner 신호 생성
2. 승인 가능 상태
3. 조건 해제 시 버튼 비활성화
4. 승인 직전 provider 재검증
5. #51 비용·위험 최종 재검증
6. Paper order 하나 생성
7. 같은 탭 연속 클릭에 한 번만 실행
8. 서로 다른 탭/동시 요청에도 order 한 개
9. 실제 거래소 요청 0
10. 만료·거절 후 실행 금지
11. 새로고침 후 중복 plan/order 없음
12. timeout 후 blind retry 없이 reconciliation
13. live flags false에서 adapter 호출 0
14. 알림 UI에는 별도 승인 버튼 없음
15. `/scanner` auto 탭이 공식 `/auto-trading` 외 별도 실행 queue를 만들지 않음

### 중복·충돌 테스트 처리

- 두 PR의 `phase12-trade-automation.spec.ts`를 그대로 덮어쓰지 않는다.
- lifecycle UI와 optimization/settings UI 테스트를 분리한다.
- 통합 fixture는 #52 lifecycle 상태와 #51 riskAssessment를 함께 사용한다.
- `api-server/test.mjs`에는 양쪽 신규 테스트를 모두 한 번씩 등록한다.
- 같은 base `trade-automation-integration.test.ts`와 smoke test는 중복 등록하지 않는다.

## 13. 운영 완료 후 통합 순서

의존성은 PR #52 → PR #51 방향이다. PR #51의 최적화가 최종 신호·승인 계약을 소비해야 하기 때문이다.

1. 운영 배포와 사후 헬스검증 완료 확인
2. 최신 main SHA 재확인
3. 별도 승인 후 PR #52에 최신 main 반영
4. PR #52 충돌 해결
5. PR #52 전체 CI와 실제 주문 요청 0 검증
6. 사용자 별도 승인 후 PR #52 병합
7. 별도 승인 후 PR #51에 새 main 반영
8. PR #51의 소문자 `TradingSignalState` 제거
9. PR #52 lifecycle 상태를 optimization에 연결
10. `TradeAutomationService`에서 lifecycle와 risk recheck 결합
11. repository `listPlans` 중복 제거
12. #52 approval queue 하나를 유지하고 #51 riskAssessment 표시 추가
13. `auto-trading.tsx` 수동 통합
14. `/scanner` legacy auto 화면을 공식 승인형 주문 경로로 정리
15. Phase 12 테스트 책임 분리
16. 동시 승인·동시 order 생성 atomic idempotency 테스트 추가
17. 실제 주문 요청 0, console.error/pageerror/예상 밖 HTTP 0 검증
18. 전체 typecheck, unit, API smoke, desktop/mobile Playwright
19. 기능별 staging은 별도 승인 후 수행
20. 사용자 별도 승인 전 PR #51 병합·운영 배포 금지

## 14. 이번 조사에서 수행하지 않은 작업

- PR #51/#52 병합
- main 병합 또는 수정
- merge/rebase/cherry-pick/squash
- PR Ready 전환
- 서버·Vultr·SSH·PM2·Caddy 작업
- DB migration 또는 Supabase 변경
- Secret 또는 live flag 변경
- 거래소 자격증명 사용
- 실제 계좌·포지션 조회
- 실제 주문·취소
- 스테이징·운영 배포

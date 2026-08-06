# PR #51 승인형 Paper 주문 계약 경계

기준 브랜치: `agent/auto-trading-optimization-guardrails`

이 문서는 PR #51을 운영배포 전 통합 후보 작업공간으로 사용할 때 유지해야 하는 단일 책임 경계를 기록한다. PR #52, #54, #74, #109와 `main`은 읽기 전용 비교 자료이며 통째로 병합하거나 복제하지 않는다.

## 공식 계약

| 책임 | 공식 위치 | 계약 |
|---|---|---|
| 회원 등급과 주문 권한 | `packages/member-access/src/index.js` | DB에서 확인한 active admin만 `canPlaceOrders=true`. pending, associate, regular, inactive/suspended admin은 false. |
| 서버 권한 적용 | `api-server/src/middleware/auth.ts`, `api-server/src/routes/index.ts` | `requireAuthenticated`가 DB 프로필을 확인한 뒤 `/api/trade-automation/**` 전체에 `canPlaceOrders`를 적용한다. 클라이언트 role 문자열은 권한 근거가 아니다. |
| UI 주문 권한 | `stock-analyzer/src/pages/technical-workspace.tsx`, `stock-analyzer/src/components/bottom-nav.tsx`, `stock-analyzer/src/components/scanner-approval-composer.tsx` | 검색·차트는 유지하되 주문 화면·메뉴·등록 컨트롤은 `canPlaceOrders`가 없으면 렌더링하지 않는다. |
| 공식 신호 상태 머신 | `api-server/src/services/trade-signal-lifecycle.service.ts` | `WATCHING → READY_FOR_APPROVAL → WEAKENED/INVALIDATED/EXPIRED`와 승인 가능 여부를 결정한다. |
| Scanner 신호 생성·재검증 | `api-server/src/services/scanner-approval-plan.service.ts` | 공급자 데이터, 가격, 호가, 캔들, 조건, 위험 한도를 서버에서 다시 계산한다. 클라이언트 가격·점수는 주문 근거로 사용하지 않는다. |
| 승인 직전 재검증 | `api-server/src/routes/scanner-approval.ts` → `ScannerApprovalPlanService.revalidatePaperPlan` → `TradeAutomationService.revalidatePlan` | 승인 직전에 신호·시장 시각·가격·스프레드·변동·위험 조건을 재검사하고 `approvalEnabled=true`일 때만 원자 주문 생성으로 이동한다. |
| 승인형 Paper 모드 경계 | `api-server/src/services/trade-approval-paper-guard.service.ts` | `mode=approval`, `accountMode=paper/mock`, Paper/mock adapter만 허용한다. automatic, 자동 승인, live, 잘못된 adapter는 안정적인 오류 코드로 거부한다. |
| 공식 Scanner 승인 API | `POST /api/trade-automation/plans/:id/approve-paper`와 Scanner 계획에 대한 `POST /api/trade-automation/plans/:id/approve` | 명시 승인, 최신 재검증, Paper/mock 저장 계획, active admin을 모두 요구한다. |
| 공식 일반 승인 API | `api-server/src/routes/trade-automation.ts`의 `POST /plans/:id/approve` | 저장 계획을 다시 읽고 Paper/mock 여부를 확인한 뒤 원자 submit/claim 계층을 호출한다. |
| 공식 Paper 계획 생성 API | Scanner: `POST /api/trade-automation/scanner/plans`; 일반: `POST /api/trade-automation/plans` | 서버가 approval-only 정책을 강제하고 계획만 생성한다. automatic 즉시 실행 분기는 승인형 경로에서 사용하지 않는다. |
| 원자적 plan/order/event/claim | `TradeAutomationService.approvePlanAndCreateOrder`, `TradingRepository.submitPlanAndCreateOrder`, `2026080402_trade_order_atomic_execution.sql` | 계획 CAS, order/event insert, execution claim을 단일 원자 계약으로 처리한다. 프로세스 잠금은 보조 수단이며 DB RPC가 최종 경합 경계다. |
| 비용·노출·위험 검사 | `api-server/src/services/trade-automation-risk.service.ts`, `trade-automation-optimization.service.ts` | 주문금액, 종목·상관 노출, 포지션 수, 일일 주문, 급변, spread, slippage, 기대값과 비용을 재사용한다. |
| 부분체결·미체결 취소 | `TradeAutomationService.invalidatePlan`, `TradeExecutionCoordinator.cancel` | 체결수량은 보존하고 미체결 주문만 `CANCEL_REQUESTED` 이후 reconciliation 대상으로 전환한다. 즉시 시장청산은 별도 승인 없이는 수행하지 않는다. |
| 모호 응답 reconciliation | `api-server/src/services/trade-exchange-reconciliation.service.ts`, `trade-execution-coordinator.service.ts` | 제출 claim 이후 결과가 모호하면 재전송하지 않고 상태 조회로 수렴한다. |
| 재시작 복구 | `TradeExecutionCoordinator.reconcileRecoverableOrders`, `trade-recovery-audit.service.ts` | 복구 대상 주문을 재조회하며 동일 주문을 다시 제출하지 않는다. |
| DB 권한 | `2026080401_trade_automation_admin_only.sql`, `trade_automation_admin_only_rls_integration.sql` | 주문성 테이블은 owner-scoped active admin만 접근한다. API 권한 거부와 RLS를 이중 경계로 유지한다. |

## 최신 main에서만 존재하는 후속 계층

최신 main에는 PR #51 이후의 child-order materializer/repository, 제출 직전 DB fence, cancel reconciliation, recovery worker lease가 존재한다. 운영배포 완료 후 최신 main을 PR #51에 일반 병합할 때 이 구현을 기준으로 보존하고 PR #51의 오래된 동등 구현으로 덮어쓰지 않는다.

## 중복 구현과 제거 후보

1. PR #52의 signal lifecycle과 Scanner 승인 라우트는 PR #51 계보에 이미 포함돼 있으므로 다시 병합하지 않는다.
2. PR #54의 `scanner-approval.service.ts`, 별도 scanner approval page와 40/35/25 분할 흐름은 PR #51의 공식 `scanner-approval-plan.service.ts`, 승인 queue, 원자 주문 계층과 중복된다. 필요한 UX 요구만 선별하고 별도 주문 저장 계층은 제거 후보로 둔다.
3. PR #74의 `canPlaceOrders` 개념은 이번 공통 capability가 공식 위치다. 다른 route별 role 비교를 추가하지 않는다.
4. PR #109의 검색기 조회 권한 분리는 후속 main 통합에서 `canAccessSignalScanner`로 선별한다. 주문 권한은 계속 `canPlaceOrders` 하나만 사용한다.
5. `stock-analyzer/src/lib/auto-trading-legacy.ts`와 브라우저 localStorage 주문 queue는 공식 주문 상태가 아니다. 서버 queue와 병행해 사용자 주문 상태로 표시하는 코드는 제거 후보이며, 읽기 전용 레거시 화면 외 신규 기능에서 사용하지 않는다.
6. adapter 이름·mode·accountMode 검사를 각 route에 복제하지 않고 `trade-approval-paper-guard.service.ts`만 사용한다.

## 운영배포 전 불변 조건

- PR #51은 Open Draft로 유지한다.
- main 병합, Staging/Production, 운영 DB migration, Secret·서버 변경을 수행하지 않는다.
- 승인형 경로는 live/automatic으로 승격되지 않는다.
- private exchange 요청, 실제 계좌 접근, 실제 주문·취소는 0이다.
- Paper 결과를 실거래 성과로 표현하지 않는다.

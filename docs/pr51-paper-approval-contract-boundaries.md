# PR #51 승인형 Paper 주문 계약 경계 및 전체 변경 감사

기준 브랜치: `agent/auto-trading-optimization-guardrails`

감사 시작 HEAD: `8f822d55d4c6a9d6e9cc509b26ced140fb67dc71`
감사 기준 최신 main: `b0afa9bbb8f731737582ce92329d51a5e20a60ce`
공통 merge base: `249543848adf09d1ff347f94648fe9cefd1aedee`

이 문서는 PR #51을 운영배포 전 통합 후보 작업공간으로 사용할 때 유지해야 하는 단일 책임 경계와 전체 변경 파일의 출처를 기록한다. PR #52, #54, #74, #97, #109와 `main`은 읽기 전용 비교 자료이며 통째로 병합하거나 기능을 복제하지 않는다.

## 범위 수치 분리

| 범위 | 파일 | 커밋 | 설명 |
|---|---:|---:|---|
| 감사 시작 시 PR 전체 main 대비 diff | 77 | 275 | `8f822d55...` 대 `b0afa9bb...`: ahead 275 / behind 11 / diverged |
| 이번 보안 보완에서 수정하는 파일 | 3 | 1 | 임시 workflow, 기존 security verifier, 이 문서 |
| 보완 후 예상 PR 전체 diff | 78 | 276 | security verifier가 처음 main 대비 변경 파일로 추가되므로 전체 파일 수가 1 증가한다. 최종 수치는 push 후 GitHub compare로 다시 확정한다. |

이번 작업 파일 수와 PR 전체 변경 파일 수를 PR 본문·Issue #62 보고에서 혼용하지 않는다.

## 공식 계약

| 책임 | 공식 위치 | 계약 |
|---|---|---|
| 회원 등급과 주문 권한 | `packages/member-access/src/index.js` | DB에서 확인한 active admin만 `canPlaceOrders=true`. pending, associate, regular, inactive/suspended admin은 false. |
| 서버 권한 적용 | `api-server/src/middleware/auth.ts`, `api-server/src/routes/index.ts` | `requireAuthenticated`가 DB 프로필을 확인한 뒤 `/api/trade-automation/**` 전체에 `canPlaceOrders`를 적용한다. 클라이언트 role 문자열은 권한 근거가 아니다. |
| UI 주문 권한 | `stock-analyzer/src/pages/technical-workspace.tsx`, `stock-analyzer/src/components/bottom-nav.tsx`, `stock-analyzer/src/components/scanner-approval-composer.tsx` | 검색·차트는 유지하되 주문 화면·메뉴·등록 컨트롤은 `canPlaceOrders`가 없으면 렌더링하지 않는다. |
| 공식 신호 상태 머신 | `api-server/src/services/trade-signal-lifecycle.service.ts` | PR #52에서 상속한 `WATCHING → READY_FOR_APPROVAL → WEAKENED/INVALIDATED/EXPIRED` 계약을 소비한다. PR #51에서 별도 상태 머신을 만들지 않는다. |
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

## 전체 변경 파일 1차 책임 분류

아래 목록은 보완 후 예상 78개 파일을 정확히 한 번씩 배치한다. secondary overlap은 다음 절에서 별도로 기록한다.

### 임시 CI 검증 지원 — 2개

- `.github/workflows/pr51-application-ci-dispatch.yml`
- `api-server/scripts/verify-phase8-security.mjs`

### PR #51 공식 주문 실행 책임 — 23개

- `api-server/src/routes/scanner-approval.smoke.test.ts`
- `api-server/src/routes/scanner-approval.ts`
- `api-server/src/routes/trade-automation.smoke.test.ts`
- `api-server/src/routes/trade-automation.ts`
- `api-server/src/routes/trade-signal-approval.smoke.test.ts`
- `api-server/src/routes/trade-signal-approval.ts`
- `api-server/src/services/scanner-approval-plan.service.test.ts`
- `api-server/src/services/scanner-approval-plan.service.ts`
- `api-server/src/services/scanner-approval-revalidation.service.test.ts`
- `api-server/src/services/trade-approval-paper-guard.service.test.ts`
- `api-server/src/services/trade-approval-paper-guard.service.ts`
- `api-server/src/services/trade-automation-integration.test.ts`
- `api-server/src/services/trade-automation-optimization.service.ts`
- `api-server/src/services/trade-automation-policy-guard.service.ts`
- `api-server/src/services/trade-automation-risk.service.ts`
- `api-server/src/services/trade-automation.repository.ts`
- `api-server/src/services/trade-automation.service.ts`
- `api-server/src/services/trade-automation.types.ts`
- `api-server/src/services/trade-exchange-reconciliation.service.ts`
- `api-server/src/services/trade-execution-coordinator.service.ts`
- `api-server/src/services/trade-execution.service.ts`
- `api-server/src/services/trade-order-state-machine.service.ts`
- `api-server/src/services/trade-recovery-audit.service.ts`

### PR #51 필수 DB·RLS·원자성 책임 — 9개

- `api-server/scripts/verify-phase8-db.sh`
- `api-server/scripts/verify-trade-atomic-race.sh`
- `api-server/supabase/migrations/2026080401_trade_automation_admin_only.down.sql`
- `api-server/supabase/migrations/2026080401_trade_automation_admin_only.sql`
- `api-server/supabase/migrations/2026080402_trade_order_atomic_execution.down.sql`
- `api-server/supabase/migrations/2026080402_trade_order_atomic_execution.sql`
- `api-server/supabase/test/trade_automation_admin_only_rls_integration.sql`
- `api-server/supabase/test/trade_automation_atomic_execution_rollback_assert.sql`
- `api-server/supabase/test/trade_automation_atomicity_integration.sql`

### PR #51 필수 UI 책임 — 8개

- `stock-analyzer/e2e/phase12-trade-automation.spec.ts`
- `stock-analyzer/src/components/scanner-approval-composer.tsx`
- `stock-analyzer/src/components/trade-approval-confirmation-dialog.tsx`
- `stock-analyzer/src/components/trade-approval-queue.tsx`
- `stock-analyzer/src/lib/auto-trading.ts`
- `stock-analyzer/src/lib/trade-approval-ui.ts`
- `stock-analyzer/src/pages/auto-trading.tsx`
- `stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx`

### PR #52 생명주기·saved search·알림 책임 — 12개

- `api-server/src/routes/trade-signal-alerts.smoke.test.ts`
- `api-server/src/routes/trade-signal-alerts.ts`
- `api-server/src/services/trade-signal-alert.service.test.ts`
- `api-server/src/services/trade-signal-alert.service.ts`
- `api-server/src/services/trade-signal-lifecycle.service.test.ts`
- `api-server/src/services/trade-signal-lifecycle.service.ts`
- `docs/pr52-ai-scanner-approval-lifecycle-audit.md`
- `stock-analyzer/e2e/scanner-approval-lifecycle.spec.ts`
- `stock-analyzer/src/components/scanner-saved-search-manager.tsx`
- `stock-analyzer/src/components/trade-signal-alerts.tsx`
- `stock-analyzer/src/lib/scanner-saved-searches.test.ts`
- `stock-analyzer/src/lib/scanner-saved-searches.ts`

### PR #97 이전 시장 스캐너 선행 책임 — 8개

- `stock-analyzer/e2e/phase12-scanner-markets.spec.ts`
- `stock-analyzer/src/lib/crypto-futures-scanner.test.ts`
- `stock-analyzer/src/lib/crypto-futures-scanner.ts`
- `stock-analyzer/src/lib/crypto-spot-scanner.test.ts`
- `stock-analyzer/src/lib/crypto-spot-scanner.ts`
- `stock-analyzer/src/pages/crypto-futures-scanner.tsx`
- `stock-analyzer/src/pages/crypto-spot-scanner.tsx`
- `stock-analyzer/src/pages/phase12-scanner-markets-e2e.tsx`

이 8개 파일은 공개 Upbit/Bitget 점수화·시장 분리 UI와 E2E를 먼저 구현한 선행 계보다. PR #97의 직접 변경 파일인 `scanner-market-action*`, `scanner-market-approval-safety*`, `scanner-signal-lifecycle*`, `scanner-signal.types.ts`와는 파일이 겹치지 않는다. 따라서 PR #97의 BUY/SELL/LONG/SHORT 서버 계약을 PR #51에 새로 복제하지 않는다.

### PR #109 capability 중복·통합 경계 — 6개

- `api-server/src/routes/trade-order-capability.smoke.test.ts`
- `api-server/src/services/member-access-phase8.test.ts`
- `packages/member-access/src/index.d.ts`
- `packages/member-access/src/index.js`
- `stock-analyzer/src/components/bottom-nav.tsx`
- `stock-analyzer/src/components/capability-gate.tsx`

PR #51에서는 active-admin Paper 주문을 막기 위해 `canPlaceOrders`를 소비한다. 최종 공통 capability helper는 운영배포 후 PR #109와 통합할 때 하나만 남긴다.

### 선행 작업에서 상속된 필수 변경 — 8개

- `api-server/src/routes/index.ts`
- `api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql`
- `api-server/supabase/test/member_permission_audit_privileges_integration.sql`
- `api-server/test.mjs`
- `stock-analyzer/e2e/phase11-ai-workspace.spec.ts`
- `stock-analyzer/src/App.tsx`
- `stock-analyzer/src/pages/ai-chart.tsx`
- `stock-analyzer/src/pages/technical-workspace.tsx`

이 파일들은 라우트 등록, 공통 테스트 등록, PR #50 실시간 AI 차트/검색기 결합, Phase 7 권한 검증을 연결한다. PR #51 단독 주문 도메인 소유 파일은 아니지만 현재 계보의 컴파일·사용자 경로·회귀 테스트를 유지하므로 지금 삭제하지 않는다.

### 운영배포 후 제거 후보 — 1개

- `stock-analyzer/src/lib/auto-trading-legacy.ts`

브라우저 localStorage 기반 legacy 주문 queue는 서버 원자 주문 상태의 공식 source of truth가 아니다. 최신 main 통합 후 실제 사용처와 회귀 테스트를 확인한 뒤 제거한다.

### 감사 문서 — 1개

- `docs/pr51-paper-approval-contract-boundaries.md`

**합계: 78개. 중복 배치 0, 미분류 0.**

## 집중 파일 감사

| 파일 | 출처 근거 | 판정 | 운영배포 후 행동 |
|---|---|---|---|
| `stock-analyzer/src/pages/ai-chart.tsx` | PR #50 기반 파일에 `ScannerApprovalComposer` import와 렌더 2곳이 추가된 최소 결합 | 선행 AI 차트 변경 + PR #51 승인 UI 연결. 단순 중복 아님 | 최신 main AI 차트에 composer 연결이 필요한지 재적용하고 중복 import/render만 제거 |
| `stock-analyzer/src/lib/crypto-spot-scanner.ts` | `564b11da...` “deterministic Upbit spot scanner scoring and filters” | PR #97보다 앞선 공개 시세 스캐너 선행 구현 | PR #97의 action 계약을 복제하지 말고 최신 main의 scanner 구현과 기능 동등성 비교 |
| `stock-analyzer/src/lib/crypto-futures-scanner.ts` | `d6cc75c6...` “deterministic public Bitget futures scanner scoring” | PR #97보다 앞선 공개 시세 스캐너 선행 구현 | funding/OI/action 정책은 PR #97/최신 main에서 소비하고 이 파일에 별도 정책 엔진을 추가하지 않음 |
| `stock-analyzer/src/components/scanner-saved-search-manager.tsx` | PR #52 현재 13개 diff에도 포함되며 PR #51에서는 `4911e759...`에서 생성 | PR #52 책임과 중복되는 상속 파일 | PR #52의 최신 revision/race 계약을 기준으로 하나만 유지 |
| `stock-analyzer/src/lib/scanner-saved-searches.ts` | PR #52 현재 diff에 포함되며 PR #51에서는 `73df7968...`에서 생성 | PR #52 저장소 책임과 중복 | PR #52 최신 구현과 비교해 단일 helper로 통합 |
| `docs/pr52-ai-scanner-approval-lifecycle-audit.md` | `8d7e3e80...` “map PR52 scanner approval lifecycle and integration risks” | PR #52 전용 문서가 PR #51 계보에 상속됨 | PR #52 최종 문서가 기준. PR #51 병합 diff에서는 제거 후보 |
| `stock-analyzer/e2e/phase11-ai-workspace.spec.ts` | PR #50 merge와 `a11a436f...` 최소화 커밋 계보 | AI 차트·zero-order 회귀 선행 테스트 | 최신 main 동일 테스트와 비교 후 중복 assertion만 정리 |
| `stock-analyzer/e2e/phase12-scanner-markets.spec.ts` | `8c2d967d...` 공개 spot/futures 분리·private request 0, 후속 fixture 보정 계보 | PR #97 직접 파일은 아니며 공개 시장 분리 선행 테스트 | 최신 main/PR #97 통합 후 중복 테스트 이름·fixture만 정리, private request 0 검증은 보존 |

## secondary overlap과 통합 후보

### 최신 main에서 이미 구현된 기능

최신 main `b0afa9bb...`에는 다음 기준 계층이 존재한다.

- `trade-cancel-reconciliation.service.ts`
- `trade-execution-snapshot.service.ts`
- `trade-order-recovery.service.ts`
- `trade-pre-submission-risk.service.ts`
- `trade-recovery-worker.service.ts`
- `trade-split-order-*`
- `2026080502_trade_automation_safety_hardening*`
- `2026080503_trade_recovery_worker_leases*`
- `2026080504_trade_pre_submission_fence*`
- `2026080505_trade_split_child_orders*`
- cancel/recovery/split/pre-submission race와 repository compatibility 테스트

따라서 PR #51의 `trade-automation.repository.ts`, `trade-automation.service.ts`, `trade-automation.types.ts`, `trade-automation-risk.service.ts`, `trade-execution.service.ts`, `trade-order-state-machine.service.ts`, `trade-exchange-reconciliation.service.ts`, `trade-execution-coordinator.service.ts`, `trade-recovery-audit.service.ts`는 운영배포 후 최신 main 구현과 충돌 단위로 비교한다. 지금은 migration·down migration·RLS·원자 RPC·reconciliation·recovery 테스트를 삭제하지 않는다.

### 다른 PR과 중복되는 기능

- **PR #52:** 신호 lifecycle, READY 알림, saved search, 읽기 전용 approval queue 일부.
- **PR #54:** 별도 scanner approval 저장 서비스와 40/35/25 분할 흐름. PR #51 원자 주문/queue와 중복.
- **PR #74:** active-admin `canPlaceOrders` 개념.
- **PR #97:** 시장별 BUY/SELL/LONG/SHORT와 승인 안전 정책. PR #51에 직접 파일은 없으므로 새로 복제하지 않는다.
- **PR #109:** scanner 조회와 주문/자동매매/Paper 승인 capability 분리. 공통 helper는 최종 하나만 유지.

### PR #51 책임 밖이지만 지금 보존하는 변경

- Phase 7 journal migration과 member permission audit 테스트
- PR #50 AI 차트/검색기 통합 파일
- 공개 crypto spot/futures scanner와 scanner-market E2E
- PR #52 audit 문서와 saved search/lifecycle 파일
- shared `App.tsx`, `routes/index.ts`, `api-server/test.mjs`

현재 계보가 오래 분기되어 있어 대규모 삭제는 오히려 테스트·migration 계약을 훼손할 수 있다. 최신 main 일반 병합 후 실제 파일 단위 비교 전까지 보존한다.

### 출처 또는 필요성이 불명확한 변경

커밋 계보·관련 PR diff·현재 사용자 경로를 대조한 결과 **미분류 0개**다. 다만 “출처가 확인됨”은 “PR #51 최종 병합 diff에 반드시 남아야 함”을 뜻하지 않는다. 선행/중복 파일은 운영배포 후 제거 후보로 재평가한다.

## 임시 PR #51 CI dispatch 보안 계약

`/.github/workflows/pr51-application-ci-dispatch.yml`은 충돌 중인 PR에서 정상 `pull_request` merge ref가 생성되지 않는 동안만 사용한다.

- trigger branch는 `agent/auto-trading-optimization-guardrails` 하나다.
- `actions/github-script`는 공식 v7 태그가 가리킨 검증된 40자리 commit SHA로 고정한다.
- workflow-level permissions는 정확히 `actions: write`, `contents: read`만 허용한다.
- `targetSha = context.sha`이고 실제 branch HEAD가 같을 때만 dispatch한다.
- workflow ID는 `futures-public-network-smoke.yml`로 고정한다.
- `target_sha`와 `checkout_ref`는 모두 동일한 exact PR HEAD다.
- issue/PR 본문, Secret, shell command, deployment, merge, main push, Git data write API를 사용하지 않는다.
- 이 workflow를 main에 병합하지 않는다.

## 임시 workflow 제거 조건

운영배포 후 아래 순서를 모두 만족해야 한다.

1. 최신 main을 PR #51에 일반 2-parent merge한다.
2. 충돌을 해결한다.
3. GitHub가 정상 `pull_request` merge ref를 생성하는지 확인한다.
4. 공식 Application CI가 자동 실행되는지 확인한다.
5. 정확한 최종 PR HEAD에서 필수 상태 6/6을 확인한다.
6. `.github/workflows/pr51-application-ci-dispatch.yml`을 제거한다.
7. workflow 제거 후 다시 공식 CI 6/6을 확인한다.
8. 그 뒤에만 Draft 해제 또는 병합 승인을 요청한다.

## 운영배포 전 불변 조건

- PR #51은 Open Draft로 유지한다.
- main 병합, rebase, cherry-pick, force push를 수행하지 않는다.
- Staging/Production, 운영 DB migration, Secret·서버 변경을 수행하지 않는다.
- 승인형 경로는 live/automatic으로 승격되지 않는다.
- private exchange 요청, 실제 계좌 접근, 실제 주문·취소는 0이다.
- Paper 결과를 실거래 성과로 표현하지 않는다.

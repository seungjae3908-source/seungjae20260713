# PR #51 / PR #52 승인 동시성 후속 점검

점검 기준일: 2026-08-04 (Asia/Seoul)

이 문서는 PR #51과 PR #52의 안전 보강 이후, 검증된 중복 승인 범위와 아직 남은 다중 프로세스·DB 원자성 위험을 구분한다.

이 작업은 병합, rebase, cherry-pick, Ready 전환, main 수정, 배포, 서버·DB·Supabase·Secret 변경, 거래소 인증 호출, 실제 계좌 조회, 실제 주문 또는 live 활성화 플래그 변경을 포함하지 않는다.

## 1. 최신 확인 상태

| 항목 | PR #51 | PR #52 |
| --- | --- | --- |
| 브랜치 | `agent/auto-trading-optimization-guardrails` | `agent/ai-scanner-approval-lifecycle` |
| 검증 HEAD | `a3ee12b46f8c74313476342664a625ac537d9871` | `8d7e3e8083ec88ac0d4ce19c30d0a4aa9a55940d` |
| 상태 | open, Draft, 미병합, mergeable | open, Draft, 미병합, mergeable |
| Application CI | `30901038021` success | `30898902907` success |
| 필수 status | 6/6 success | 6/6 success |
| Playwright | 57 passed, 10 staging-only skipped | 61 passed, 10 staging-only skipped |
| failed / flaky | 0 / 0 | 0 / 0 |
| 최신 main 대비 | ahead 31, behind 5, diverged | ahead 77, behind 6, diverged |

최신 main은 `ddc679065781e40f46dc6f13962d6039bccd4e58`이다. 이번 점검에서 main 반영이나 병합은 수행하지 않았다.

## 2. PR #51 동시성 방어

`TradeAutomationService`의 process-local `operationLocks`는 다음 key를 직렬화한다.

- 계획 생성: `create-plan:${userId}:${idempotencyKey}`
- 승인·자동 제출·주문 생성: `plan:${userId}:${planId}`

같은 Node.js 프로세스 안에서는 다음을 방어한다.

- 같은 idempotency key의 동시 plan 생성
- 같은 plan의 동시 승인
- 같은 plan의 승인과 order 생성
- 같은 plan의 동시 order 생성

기존 HTTP route 동시 테스트는 다음을 검증한다.

- 동시 동일 plan 요청 두 번에서 plan 한 개
- duplicate 응답 한 개
- 동시 승인 중 성공 한 번
- 두 번째 승인은 `TRADE_PLAN_NOT_APPROVAL_PENDING`
- Paper order 한 개
- `ORDER_CREATED`, `PAPER_BROKER_ACCEPTED`, `PAPER_BROKER_FILLED` 이벤트 각각 한 개
- 외부 거래소 요청 0

## 3. 이번에 추가한 직접 회귀테스트

파일: `api-server/src/routes/trade-automation-plan-queue.test.ts`

### 서로 다른 service instance가 같은 repository를 공유하는 경우

두 개의 `TradeAutomationService` 객체를 만들고 같은 `InMemoryTradingRepository`를 공유시킨 뒤 동시에 호출한다.

검증 계약:

- 동시 `createPlan` → 저장 plan 한 개, 동일 plan ID, duplicate 한 개
- 동시 `approvePlan` → 성공 한 개, 실패 한 개
- 실패 이유 `TRADE_PLAN_NOT_APPROVAL_PENDING`
- 동시 `createOrder` → 저장 order 한 개, 동일 order ID, duplicate 한 개
- `ORDER_CREATED` 이벤트 한 개

이 테스트는 요청마다 서비스 객체가 달라져도 같은 프로세스의 정적 operation lock이 공유되는지 직접 검증한다.

### 서비스 재생성 이후 완료 주문 복원

기존 서비스로 plan 승인·order 생성 후 상태를 `ACCEPTED`와 `FILLED`로 전환하고 새 `TradeAutomationService` 객체를 생성한다.

검증 계약:

- 같은 plan으로 `createOrder` 재호출 시 기존 FILLED order를 duplicate로 반환
- 새 order 생성 없음
- `recoverOpenOrders` 결과 빈 배열
- 저장 order 한 개 유지
- 추가 event 없음

이는 서비스 객체 재생성만으로 완료 주문이 다시 실행되거나 recovery 대상으로 복원되지 않는다는 것을 검증한다.

## 4. 테스트 실행 증거

`api-server/test.mjs`의 `phase12` 그룹은 `trade-automation-plan-queue.test.ts`를 등록한다.

Application CI Run `30901038021`에서 다음이 success였다.

- frontend/backend typecheck
- Phase 2~9 회귀
- trade automation safety and adapter tests
- API smoke
- frontend/backend production build
- security/outbound verification
- AI privacy verification
- disposable PostgreSQL migration/RLS
- Bitget public network smoke
- Playwright desktop/mobile
- 필수 status 6/6

Playwright 산출물의 내부 `report.json` 기준:

- total 67
- passed 57
- skipped 10
- failed 0
- flaky 0
- ok true

## 5. PR #52 UI 무부작용 계약

독립 Playwright `scanner-approval-lifecycle.spec.ts`는 다음을 검증한다.

- 승인형 주문 E2E route 진입
- 유효 plan 승인 버튼 활성
- 무효 plan 승인 버튼 비활성
- 최초 진입 시 order-like mutation 0
- 새로고침 후 order-like mutation 0
- `console.error` 0
- `pageerror` 0
- 예상 밖 API HTTP 4xx/5xx 0

## 6. 현재 해결된 범위

| 위험 | 판정 | 근거 |
| --- | --- | --- |
| 같은 브라우저 컴포넌트 연속 클릭 | 방어됨 | PR #52 `actionId` guard |
| 같은 서버 프로세스의 동시 plan 생성 | 방어됨 | operation lock + route/service-instance 테스트 |
| 같은 서버 프로세스의 동시 승인 | 방어됨 | plan lock + 상태 재조회 |
| 같은 서버 프로세스의 동시 order 생성 | 방어됨 | plan lock + `findOrderByPlan` |
| 서비스 객체 재생성 후 완료 주문 재생성 | 방어됨 | FILLED duplicate/recovery 테스트 |
| UI 진입만으로 주문 요청 발생 | 방어됨 | PR #52 mutation 0 |
| UI 새로고침으로 주문 재실행 | 방어됨 | PR #52 reload mutation 0 |
| Paper 동시 승인 중 외부 요청 | 방어됨 | PR #51 external request 0 |

## 7. 아직 해결되지 않은 범위

`operationLocks`는 Node.js 메모리의 `Map<string, Promise<void>>`다. 다음 경계에서는 공유되지 않는다.

- PM2 cluster의 서로 다른 worker
- 수평 확장된 서버 인스턴스
- 서버리스의 서로 다른 invocation
- 실제 프로세스 종료와 재시작 전후
- 서로 다른 배포 세대
- 동일 DB를 사용하는 별도 OS 프로세스

이번 테스트의 두 service instance는 **같은 Node.js 프로세스 안의 객체 두 개**다. 이는 multi-instance object 경계를 검증하지만 distributed/multi-process 원자성을 증명하지 않는다.

현재 코드만으로 확정할 수 없는 DB 보장:

- unique `(user_id, idempotency_key)`
- unique `(user_id, plan_id)`
- unique `client_order_id`
- conditional `APPROVAL_PENDING -> SUBMITTED` compare-and-swap
- approval transition과 order insert의 단일 transaction/RPC

## 8. 최종 통합 전 필수 원자성 계약

별도 승인된 DB·서버 통합 단계에서 다음을 만족해야 한다.

### 계획 생성

- 동일 사용자·거래소·신호·전략·시장·종목·방향의 활성 plan 하나
- DB unique 충돌은 500 대신 기존 plan을 duplicate 성공으로 반환
- process lock은 최적화일 뿐 정확성의 유일한 근거가 아님

### 승인 전환

- `APPROVAL_PENDING` 행만 한 요청이 `SUBMITTED`로 전환
- 이미 처리된 요청은 기존 결과 또는 명확한 idempotent 응답 반환
- 만료·무효·거절 plan은 전환 불가

### 주문 생성

- 사용자·plan 조합당 order 하나
- 결정적 client order ID 하나
- unique 충돌 후 기존 order 조회로 복구
- approval 전환과 order insert 사이 실패를 재시작 후 안전하게 복구

### 실행

- Paper/mock은 외부 인증 API와 주문 endpoint 호출 0
- live는 전역 flag, 거래소별 flag, 연결 mode, 권한, 최신 위험검사를 모두 통과해야 함
- timeout과 모호한 응답은 blind retry 금지, `RECOVERY_REQUIRED` 전환

## 9. 남은 통합 테스트

이번에 완료:

1. 서로 다른 service instance 두 개가 같은 repository를 공유하는 동시 plan 생성
2. 서로 다른 service instance 두 개의 동시 승인
3. 서로 다른 service instance 두 개의 동시 order 생성
4. 완료 order가 서비스 재생성 후 다시 생성·복구되지 않음

별도 승인 단계에서 남음:

1. 실제 별도 프로세스 두 개와 disposable PostgreSQL 동시 plan 생성
2. DB unique 충돌 후 기존 plan/order 복구
3. approval CAS 이후 order insert 실패와 프로세스 재시작 복구
4. 만료·무효·거절 plan의 분산 동시 승인 차단
5. 동일 client order ID 유지
6. 실제 거래소 요청 0
7. alert delivery와 주문 실행 idempotency 분리

## 10. 책임과 통합 순서

PR #52:

- 신호 생성·유지·약화·무효·만료
- 승인 가능 상태
- scanner provider 최종 재검증
- 승인 알림 생명주기
- UI mount·reload 무부작용

PR #51:

- 비용·위험 최종검사
- plan/order idempotency
- queue 등록과 실행 상태
- Paper/mock/live adapter
- 주문·체결·취소·복구

최종 통합은 PR #52의 승인 결과를 PR #51 실행 계층이 소비하는 방향을 유지한다. PR #52 scanner route의 별도 order 생성·Paper FILLED 구현은 최종 통합에서 제거한다.

## 11. 최종 판정

- same-process service-instance 동시성: 검증됨
- 서비스 객체 재생성 후 완료 주문 재실행 금지: 검증됨
- UI 진입·reload 무부작용: 검증됨
- Paper 외부 주문 요청: 0 검증됨
- distributed/multi-process 원자성: 미해결
- DB unique/CAS/transaction: 미확정
- PR #52 → PR #51 통합 순서: 유지
- 현재 병합 가능 판정: 아직 아님

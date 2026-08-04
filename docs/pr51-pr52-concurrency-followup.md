# PR #51 / PR #52 승인 동시성 후속 점검

점검 기준일: 2026-08-04 (Asia/Seoul)

이 문서는 PR #51과 PR #52의 최근 안전 보강 이후, 해결된 중복 승인 범위와 아직 남은 다중 프로세스 원자성 위험을 구분한다.

이 변경은 문서만 추가한다. 병합, rebase, cherry-pick, Ready 전환, main 수정, 배포, 서버·DB·Supabase·Secret 변경, 거래소 인증 호출, 실제 계좌 조회, 실제 주문 또는 live 활성화 플래그 변경을 포함하지 않는다.

## 1. 최신 확인 상태

| 항목 | PR #51 | PR #52 |
| --- | --- | --- |
| 브랜치 | `agent/auto-trading-optimization-guardrails` | `agent/ai-scanner-approval-lifecycle` |
| 확인 HEAD | `28ee12ce8e75b8a1119a8dbd7a5e21a97bf368a6` | `8d7e3e8083ec88ac0d4ce19c30d0a4aa9a55940d` |
| 상태 | open, Draft, 미병합, mergeable | open, Draft, 미병합, mergeable |
| 최신 Application CI | `30899985584` success | `30898902907` success |
| 필수 status | 6/6 success | 6/6 success |
| Playwright | 57 passed, 10 staging-only skipped | 61 passed, 10 staging-only skipped |
| failed / flaky | 0 / 0 | 0 / 0 |

현재 main은 `1987b74799d213b63d065c63a7c8c3b675a863f4`이며, 이번 점검에서 main 반영이나 병합은 수행하지 않는다.

## 2. 최근 추가된 안전 보강

### PR #51

`TradeAutomationService`에 process-local `operationLocks`가 추가됐다.

보호 key:

- 계획 생성: `create-plan:${userId}:${idempotencyKey}`
- 승인·자동 제출·주문 생성: `plan:${userId}:${planId}`

같은 Node.js 프로세스 안에서는 다음 작업을 직렬화한다.

- 같은 idempotency key의 동시 plan 생성
- 같은 plan의 동시 승인
- 같은 plan의 승인과 order 생성
- 같은 plan의 동시 order 생성

추가된 route 통합 테스트는 `Promise.all`로 두 개의 plan 생성 요청과 두 개의 승인 요청을 동시에 실행한다.

검증 결과:

- plan 한 개
- 중복 생성 응답 한 개
- 승인 성공 한 개
- 두 번째 승인은 `TRADE_PLAN_NOT_APPROVAL_PENDING`
- Paper order 한 개
- `ORDER_CREATED`, `PAPER_BROKER_ACCEPTED`, `PAPER_BROKER_FILLED` 이벤트 각각 한 개
- 외부 거래소 요청 0

### PR #52

독립 Playwright `scanner-approval-lifecycle.spec.ts`가 추가됐다.

검증 범위:

- 승인형 주문 E2E route 진입
- 승인 가능 plan 한 개 표시
- 무효 plan 한 개 표시
- 유효 plan 승인 버튼 활성
- 무효 plan 승인 버튼 비활성
- 최초 진입 시 order-like mutation 0
- 새로고침 후 order-like mutation 0
- `console.error` 0
- `pageerror` 0
- 예상 밖 API HTTP 4xx/5xx 0

이 테스트는 UI mount, fixture 복원, reload만으로 승인·주문 POST가 발생하지 않는다는 계약을 고정한다.

## 3. 현재 해결된 범위

| 위험 | 현재 판정 | 근거 |
| --- | --- | --- |
| 같은 브라우저 컴포넌트 연속 클릭 | 방어됨 | PR #52 `actionId` guard |
| 같은 서버 프로세스의 동시 plan 생성 | 방어됨 | idempotency key별 process lock + 동시 테스트 |
| 같은 서버 프로세스의 동시 승인 | 방어됨 | plan별 process lock + 상태 재조회 |
| 같은 서버 프로세스의 동시 order 생성 | 방어됨 | plan별 process lock + `findOrderByPlan` |
| UI 진입만으로 주문 요청 발생 | 방어됨 | PR #52 독립 Playwright mutation 0 |
| UI 새로고침으로 주문 재실행 | 방어됨 | PR #52 reload mutation 0 |
| Paper 동시 승인 중 외부 요청 | 방어됨 | PR #51 route 테스트 external request 0 |

## 4. 아직 해결되지 않은 범위

`operationLocks`는 Node.js 메모리의 `Map<string, Promise<void>>`다. 따라서 다음 경계에서는 공유되지 않는다.

- PM2 cluster의 서로 다른 worker
- 수평 확장된 서버 인스턴스
- 서버리스의 서로 다른 invocation
- 서버 재시작 전후
- 서로 다른 배포 세대
- 동일 DB를 사용하는 별도 프로세스

따라서 현재 보강은 **single-process concurrency guard**이며 **distributed atomic idempotency**는 아니다.

### 남은 경쟁 조건

1. 프로세스 A와 B가 동시에 `findPlanByIdempotency`에서 없음 확인
2. 두 프로세스가 서로 다른 plan ID 생성
3. 프로세스 A와 B가 같은 plan의 `APPROVAL_PENDING` 상태를 동시에 읽음
4. 두 프로세스가 각각 `SUBMITTED` 저장
5. 두 프로세스가 `findOrderByPlan`에서 없음 확인
6. 두 order가 저장되거나 한 요청이 DB 오류로 끝남

현재 확인된 repository 저장 충돌 기준은 주로 `user_id,id`다. 다음 DB 단위 보장은 코드만으로 확정할 수 없다.

- unique `(user_id, idempotency_key)`
- unique `(user_id, plan_id)`
- unique `client_order_id`
- conditional `APPROVAL_PENDING -> SUBMITTED` compare-and-swap
- approval transition과 order insert의 단일 transaction

## 5. 최종 통합 전 필수 원자성 계약

DB·서버 변경은 별도 승인 단계에서만 수행한다. 최종 구현은 다음 계약을 만족해야 한다.

### 계획 생성

- 동일 사용자·거래소·신호·전략·시장·종목·방향은 활성 plan 하나
- DB unique 충돌은 500이 아니라 기존 plan을 반환하는 duplicate 성공으로 처리
- 프로세스 메모리 lock은 최적화일 뿐 정확성의 유일한 근거가 아니어야 함

### 승인 전환

- `APPROVAL_PENDING`인 행만 한 요청이 `SUBMITTED`로 전환
- 이미 처리된 요청은 기존 결과 또는 명확한 idempotent 응답 반환
- 만료·무효·거절된 plan은 어떤 프로세스에서도 전환 불가

### 주문 생성

- 사용자·plan 조합당 order 하나
- 결정적 client order ID 하나
- order unique 충돌은 기존 order 조회로 복구
- approval 전환과 order insert 사이 실패를 재시작 후 안전하게 복구

### 실행

- Paper/mock은 외부 인증 API와 주문 endpoint 호출 0
- live는 전역 2개 flag와 거래소별 flag, 연결 mode, 권한, 최신 위험검사를 모두 통과해야 함
- timeout과 모호한 응답은 blind retry 금지, `RECOVERY_REQUIRED`로 전환

## 6. 최종 통합 테스트 추가 기준

현재 single-process 테스트를 유지하면서 다음 별도 테스트가 필요하다.

1. 서로 다른 service instance 두 개가 같은 repository를 공유하는 동시 plan 생성
2. 서로 다른 service instance 두 개의 동시 승인
3. 서로 다른 service instance 두 개의 동시 order 생성
4. DB unique 충돌 후 기존 plan/order 복구
5. 승인 상태 전환 후 order insert 실패와 재시작 복구
6. 완료 order가 재시작 후 다시 실행되지 않음
7. 만료·무효·거절 plan의 동시 승인 모두 실패
8. 동일 client order ID 유지
9. 실제 거래소 요청 0
10. alert delivery와 주문 실행 idempotency를 서로 분리

실제 PostgreSQL 기반 검증은 운영 DB가 아니라 disposable CI database에서만 수행한다.

## 7. PR 책임 경계 유지

PR #52:

- 신호 생성·유지·약화·무효·만료
- 승인 가능 상태
- scanner provider 최종 재검증
- 승인 알림 생명주기
- UI mount·reload 무부작용 계약

PR #51:

- 비용·위험 최종검사
- plan/order atomic idempotency
- queue 등록과 실행 상태
- Paper/mock/live adapter
- 주문·체결·취소·복구

최종 통합 시 PR #52의 승인 결과를 PR #51 실행 계층이 소비한다. PR #52 scanner route가 별도 order 생성·Paper FILLED 구현을 계속 소유해서는 안 된다.

## 8. 이번 후속 점검 판정

- single-process 동시 승인 위험: 개선됨
- UI 진입·reload 무부작용: 검증됨
- Paper 외부 주문 요청: 0 검증됨
- distributed/multi-process 원자성: 미해결
- DB unique/CAS/transaction: 미확정
- PR #52 -> PR #51 통합 순서: 유지
- 현재 병합 가능 판정: 아직 아님
- 다음 안전 단계: 최신 main 반영 전까지 문서·독립 테스트만 유지하고, 실제 원자성 변경은 운영 완료 후 별도 승인된 통합 단계에서 수행

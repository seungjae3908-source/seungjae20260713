# PR #52 AI 신호 생명주기 독립 감사 및 통합 준비

기준 저장소: `seungjae3908-source/seungjae20260713`

이 문서는 운영배포 전 PR #52를 생명주기·saved search·알림 후보·모바일 승인 대기 표시 책임으로 한정한 결과와, PR #97·PR #109를 실제 병합하지 않은 통합 준비 기준을 기록합니다.

## 공식 책임 기준

- 시장 행동 계약: PR #97
- 생명주기·saved search·알림·모바일 승인 대기 표시: PR #52
- 검색기 조회·주문·자동매매 capability: PR #109
- 실제 주문·취소·복구 및 live adapter: 최신 운영배포 main

PR #52는 시장별 `BUY/SELL/LONG/SHORT` 기준, 관리자 주문 권한, 자동매매 권한, 주문 실행 service, live adapter, 배포 코드를 정의하지 않습니다.

## 45개 변경 파일 감사

| 파일 | 분류 | 정리 결과 |
|---|---|---|
| `api-server/src/routes/index.ts` | PR #109 충돌 예정·책임 밖 | PR 시작 기준 원복 |
| `api-server/src/routes/scanner-approval.smoke.test.ts` | 실제 주문 mutation 테스트·책임 밖 | 삭제 |
| `api-server/src/routes/scanner-approval.ts` | Paper 주문 생성·책임 밖 | 삭제 |
| `api-server/src/routes/trade-signal-alerts.smoke.test.ts` | 주문 repository 결합 | 삭제, 순수 서비스 테스트로 대체 |
| `api-server/src/routes/trade-signal-alerts.ts` | 주문 repository 결합 | 삭제, 알림 후보 순수 서비스로 대체 |
| `api-server/src/routes/trade-signal-approval.smoke.test.ts` | 취소·재검증 mutation 포함 | 삭제 |
| `api-server/src/routes/trade-signal-approval.ts` | 주문 취소·worker token 경로 포함 | 삭제 |
| `api-server/src/services/scanner-approval-plan.service.test.ts` | 주문 plan 생성 테스트 | 삭제 |
| `api-server/src/services/scanner-approval-plan.service.ts` | 실제 주문 plan 계층 중복 | 삭제 |
| `api-server/src/services/scanner-approval-revalidation.service.test.ts` | 주문 승인 직전 실행 계층 | 삭제 |
| `api-server/src/services/trade-automation.repository.ts` | 실제 주문 repository | PR 시작 기준 원복 |
| `api-server/src/services/trade-automation.service.ts` | 실제 주문·취소 실행 | PR 시작 기준 원복 |
| `api-server/src/services/trade-automation.types.ts` | 공통 주문 타입 | PR 시작 기준 원복 |
| `api-server/src/services/trade-signal-alert.service.test.ts` | 알림 테스트 필수 | 주문 타입 의존 제거 후 유지 |
| `api-server/src/services/trade-signal-alert.service.ts` | 알림 필수 | 순수 READY 후보·cycle 중복 억제로 유지 |
| `api-server/src/services/trade-signal-lifecycle.service.test.ts` | 생명주기 테스트 필수 | 주문 service 의존 제거 후 유지 |
| `api-server/src/services/trade-signal-lifecycle.service.ts` | 생명주기 필수 | 독립 상태 머신으로 유지 |
| `api-server/test.mjs` | 테스트 필수 | 순수 생명주기·알림·saved search만 등록 |
| `docs/pr52-ai-scanner-approval-lifecycle-audit.md` | 문서 | 본 문서로 갱신 |
| `stock-analyzer/e2e/phase11-ai-workspace.spec.ts` | 자동매매·책임 밖 | PR 시작 기준 원복 |
| `stock-analyzer/e2e/phase12-scanner-markets.spec.ts` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/e2e/phase12-trade-automation.spec.ts` | 모바일 UI 테스트 필수 | 주문 mutation 0 읽기 전용 테스트로 교체 |
| `stock-analyzer/e2e/scanner-approval-lifecycle.spec.ts` | 중복 E2E | 삭제, Phase 12 읽기 전용 E2E로 통합 |
| `stock-analyzer/src/App.tsx` | PR #109 충돌 예정·공통 route | PR 시작 기준 원복 |
| `stock-analyzer/src/components/scanner-approval-composer.tsx` | 주문 plan 생성 UI | 삭제 |
| `stock-analyzer/src/components/scanner-saved-search-manager.tsx` | saved search 필수 | 사용자별 revision·알림 on/off UI로 유지 |
| `stock-analyzer/src/components/trade-approval-confirmation-dialog.tsx` | 실제 승인 UI·책임 밖 | 삭제 |
| `stock-analyzer/src/components/trade-approval-queue.tsx` | 모바일 승인 대기 UI 필수 | 읽기 전용 상세 Dialog로 교체 |
| `stock-analyzer/src/components/trade-signal-alerts.tsx` | 알림 필수 | fixture·로컬 읽기 전용 후보 표시로 유지 |
| `stock-analyzer/src/lib/auto-trading-legacy.ts` | 자동매매·책임 밖 | 삭제 |
| `stock-analyzer/src/lib/auto-trading.ts` | 자동매매 실행 계층 | PR 시작 기준 원복 |
| `stock-analyzer/src/lib/crypto-futures-scanner.test.ts` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/lib/crypto-futures-scanner.ts` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/lib/crypto-spot-scanner.test.ts` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/lib/crypto-spot-scanner.ts` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/lib/scanner-saved-searches.test.ts` | saved search 테스트 필수 | 사용자 격리·중복·race 테스트로 유지 |
| `stock-analyzer/src/lib/scanner-saved-searches.ts` | saved search 필수 | 사용자별 key·revision 충돌 방지로 유지 |
| `stock-analyzer/src/lib/trade-approval-ui.ts` | 주문 승인 UI helper | 삭제 |
| `stock-analyzer/src/pages/ai-chart.tsx` | 공통 차트·PR #109 충돌 예정 | PR 시작 기준 원복 |
| `stock-analyzer/src/pages/auto-trading.tsx` | 자동매매·책임 밖 | PR 시작 기준 원복 |
| `stock-analyzer/src/pages/crypto-futures-scanner.tsx` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/pages/crypto-spot-scanner.tsx` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/pages/phase12-scanner-markets-e2e.tsx` | PR #97 시장 계약 중복 | 삭제 |
| `stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx` | 모바일 UI fixture 필수 | 읽기 전용 생명주기 fixture로 교체 |
| `stock-analyzer/src/pages/technical-workspace.tsx` | PR #109 충돌 예정·공통 메뉴 | PR 시작 기준 원복 |

## 생명주기 계약

허용 전이:

- `DETECTED → WATCHING`
- `WATCHING → READY_FOR_APPROVAL`
- `WATCHING → WEAKENED`
- `WATCHING → INVALIDATED`
- `WATCHING → EXPIRED`
- `READY_FOR_APPROVAL → WEAKENED`
- `READY_FOR_APPROVAL → INVALIDATED`
- `READY_FOR_APPROVAL → EXPIRED`

차단 계약:

- `INVALIDATED`와 `EXPIRED`는 terminal이며 같은 signal/cycle에서 READY로 돌아가지 않음
- `WEAKENED`는 자동 주문을 만들지 않으며 명시적 새 cycle 시작 전 READY로 돌아가지 않음
- 이전 cycle 승인 요청은 `SCANNER_PREVIOUS_CYCLE_REJECTED`
- partial·stale·unavailable·미래 시각·관측 만료 데이터는 fail-closed
- READY 후보와 모바일 항목은 항상 `orderSubmitted: false`, `exchangeRequestSent: false`

## saved search·알림 계약

- 저장 key는 사용자 ID별 분리
- 시장·종목·시간봉·조건을 fingerprint로 사용
- 같은 조건 중복 저장 차단
- revision 기반 빠른 저장·삭제 race 차단
- 존재하지 않는 항목 삭제 fail-closed
- 알림 on/off 저장
- stale·partial·expired 신호는 READY 알림 후보에서 제외
- 같은 cycle READY 알림은 한 번만 생성
- 명시적 새 cycle에서만 새 READY 알림 생성
- 운영 worker와 private exchange API는 실행하지 않음

## 모바일 승인 대기 표시

읽기 전용 화면에 다음을 표시합니다.

- 방향, 시장, 종목, 시간봉
- 신호 시각, 만료 시각
- 데이터 상태, 신뢰도, 위험점수, 추격 위험
- 부분 데이터 경고와 승인 불가 사유
- `WEAKENED`, `INVALIDATED`, `EXPIRED` 상태
- 가격·보유 수량·신호 상태가 최종 확정이 아니라는 경고
- 주문 생성·거래소 요청이 `false`임을 명시

Dialog는 accessible name, Escape, 브라우저 뒤로가기, focus 복귀만 지원합니다. 주문 승인 버튼과 API mutation은 존재하지 않습니다.

## 중복 파일과 운영배포 후 원칙

중복 가능 파일:

- `api-server/src/routes/index.ts`
- `stock-analyzer/src/App.tsx`
- `stock-analyzer/src/pages/technical-workspace.tsx`
- 공통 권한 파일
- 공통 신호 타입
- 공통 API response 타입

운영배포 후 유지 원칙:

- 최신 main의 주문·취소·복구 계층 보존
- PR #97의 시장 행동 계약 보존
- PR #52의 생명주기·saved search·알림·읽기 전용 UI만 선별
- PR #109의 capability만 선별
- 중복 route·상태 머신·permission helper 생성 금지
- main의 API 이름과 DB 계약 우선
- DB migration은 disposable PostgreSQL 검증 및 별도 승인 전 금지

## 예상 통합 순서

1. 실제 운영배포 main SHA 확인
2. 최신 main 기준 통합 브랜치 생성
3. PR #97 계약 반영
4. PR #52 생명주기·saved search·알림 반영
5. PR #109 capability 반영
6. 공통 파일 최소 수동 해결
7. typecheck·test·build
8. Desktop·Mobile Playwright
9. 주문 mutation 0
10. Application CI 6/6
11. Draft 통합 PR 보고
12. 별도 병합 승인

현재 이 문서 작성 과정에서 통합 브랜치 생성·PR 상호 병합·main 병합은 수행하지 않았습니다.

## 백테스트 작업방 전달 요구

`UNVALIDATED_INITIAL_POLICY`를 유지하며 승인 점수·신뢰도·위험·완성도·추격·펀딩비·OI 기준을 변경하지 않습니다. 백테스트에서는 시장·시간봉·종목·BUY/SELL/LONG/SHORT별 표본 수, 수수료·세금·펀딩비·슬리피지, 최대낙폭, 기대값, 손익비, 신호 후 최대 상승·하락폭, 급등 추격군, partial·stale 제외 효과, 기준/후보 정책 비교, train/validation/test 분리와 walk-forward를 검증해야 합니다.

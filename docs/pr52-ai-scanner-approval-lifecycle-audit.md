# PR #52 AI 신호검색기·승인 생명주기 감사

## 범위와 기준

- 대상 브랜치: `agent/ai-scanner-approval-lifecycle`
- 대상 PR: #52, Draft 유지
- 기준 main: `1987b74799d213b63d065c63a7c8c3b675a863f4`
- 조사 시작 HEAD: `65a01be54d3f5b1cc5fd8673cc0e43ceaec49aa5`
- 금지 범위: main 병합, rebase, cherry-pick, Ready 전환, 배포, 서버·DB·Secret·실주문 변경
- 주문 실행 경계: PR #52는 신호·승인·최종 재검증까지, PR #51은 queue 등록과 주문 실행부터 담당하는 것을 최종 통합 원칙으로 한다.

## 기능별 책임과 실제 호출 위치

| 기능 | 파일 | 함수·컴포넌트 | 서버 호출 | 권한 검사 | PR #52 책임 | 문제·판정 |
|---|---|---|---|---|---|---|
| 주식 조건검색 | `api-server/src/services/signal.service.ts` | `SignalService.scan` | 시장 시세·캔들·재무·위험·뉴스 공급자 | 상위 라우터의 로그인·기본정보/리스크 권한 | 예 | 조건 미충족과 공급자 실패를 구분함 |
| 승인 계획용 서버 재검색 | `api-server/src/services/scanner-approval-plan.service.ts` | `createPaperPlan` | `SignalService.scan`, quote, candles, orderbook | `/trade-automation`의 `canAccessPaperTrading` | 예 | KR Paper만 허용, US 차단 |
| Upbit 현물 신호검색 | `stock-analyzer/src/lib/crypto-spot-scanner.ts` | `scoreCryptoSpotTicker`, `scanCryptoSpotMarket` | 공개 현물 GET만 | `canAccessSpot` | 예 | 승인 계획 연결은 아직 없음 |
| Bitget 선물 신호검색 | `stock-analyzer/src/lib/crypto-futures-scanner.ts` | `scoreCryptoFuturesTicker`, `scanCryptoFuturesMarket` | 공개 선물 GET만 | `canAccessFutures` | 예 | 승인 계획 연결은 아직 없음 |
| 신호 생성·초기 상태 | `api-server/src/services/trade-signal-lifecycle.service.ts` | `initializeSignalLifecycle`, `evaluateSignalLifecycle` | 없음 | 서비스 호출 전 사용자 범위 검사 | 예 | 실제 상태명은 `WATCHING`, `READY_FOR_APPROVAL`, `WEAKENED`, `INVALIDATED`, `EXPIRED` |
| 신호 저장 | `api-server/src/services/trade-automation.repository.ts` | `savePlan` | Supabase 또는 InMemory | 사용자 소유권 `owned` | 경계 공유 | PR #51과 공통 파일, 직접 통합 금지 |
| 신호 유지·해제·만료 | `api-server/src/services/trade-signal-lifecycle.service.ts` | `applySignalValidation`, `approvalStatus` | 없음 | 호출 라우트에서 인증 | 예 | 무효·만료는 승인 불가 |
| 재진입 | `api-server/src/services/scanner-approval-plan.service.ts` | `nextScannerSignalId`, `createPaperPlan` | 없음 | 기존 계획 사용자 범위 | 예 | 동일 5분 버킷에서도 새 `:reentry:N` ID 발급 |
| 승인 대기 목록 | `api-server/src/routes/trade-signal-approval.ts` | `GET /approval-queue` | 계획·주문 조회 | 로그인 + `canAccessPaperTrading` | 예 | 조회만으로 주문 생성 없음 |
| 승인 UI | `stock-analyzer/src/components/trade-approval-queue.tsx` | `approve`, `reject` | approval-status GET, approve/invalidate POST | 페이지 capability + 서버 capability | 예 | 단일 컴포넌트 연속 클릭은 차단, 다중 탭 원자성 없음 |
| 승인 직전 재검증 | `api-server/src/routes/scanner-approval.ts` | `approveScannerPaperPlan` | `revalidatePaperPlan` 후 `revalidatePlan` | 로그인 + `canAccessPaperTrading` | 예 | 클라이언트 확인 뒤 서버에서 다시 스캔·호가·캔들·위험검사 |
| 승인 알림 생성 | `api-server/src/services/trade-signal-alert.service.ts` | `deriveTradeSignalAlerts`, `listTradeSignalAlerts` | 없음 | 알림 라우트 사용자 범위 | 예 | 계획·주기·종류 기반 결정적 ID |
| 브라우저 알림 전달 | `stock-analyzer/src/components/trade-signal-alerts.tsx` | 알림 `useEffect` | 알림 목록 GET | 페이지 capability | 예 | localStorage 전달 이력은 탭 간 원자적이지 않음 |
| 저장 검색 수정·삭제·초기화 | `stock-analyzer/src/lib/scanner-saved-searches.ts` | `updateScannerSavedSearch`, `deleteScannerSavedSearch`, `resetScannerSearchStorage` | 없음 | `/scanner` capability | 예 | localStorage 기반, 관리자 닫기 시 reload로 반영 |
| 주문 계획 전달 | `api-server/src/routes/scanner-approval.ts` | `approveScannerPaperPlan` | 현재 `createOrder`와 Paper FILLED까지 수행 | `canAccessPaperTrading` | 최종 통합 전까지만 임시 연결 | PR #51 책임과 겹침. 최종 통합에서 승인 결과 계약만 남기고 queue 등록 이후는 PR #51로 이동 |

## 활성 사용자 경로

| 경로 | 실제 페이지 | 신호 상태 | 승인 UI | 주문 UI | 사용자 도달 가능 | 관련 PR |
|---|---|---|---|---|---|---|
| `/scanner` 모바일 stock | `TechnicalWorkspacePage` → `ScannerPage` + 저장검색 관리자 | 분석 선택 상태 | 직접 승인 composer 없음 | legacy auto 모드가 ScannerPage 내부에 존재 | `canAccessRiskPreview` | #52, legacy 실행부는 #51 정리 대상 |
| `/scanner` 데스크톱 stock | `ScannerPage embedded` + `AiChartPage embedded` | 동일 `AnalysisSelectionProvider` | `AiChartPage`의 composer 1개 | ScannerPage legacy auto 모드 | `canAccessRiskPreview` | #50 차트 + #52 composer |
| Scanner condition 모드 | `ScannerPage` | 스캔 결과 | 결과를 차트 선택으로 전달 | 진입만으로 주문 없음 | 가능 | #52 |
| Scanner chart 모드 | `ScannerPage` 내부 차트 | 차트 신호 | 공식 approval queue 없음 | 진입만으로 주문 없음 | 가능 | #50/#52 |
| Scanner auto 모드 | `ScannerPage` legacy auto | 후보 localStorage·저널 | 별도 legacy 승인 흐름 | 실행 버튼·모니터 코드 존재 | 가능 | 최종적으로 #51 책임 |
| `/ai-chart` | `AiChartPage` | 전역 분석 선택 | `ScannerApprovalComposer` 1개 | 계획 등록 버튼만 | `canAccessRiskPreview` | #50/#52 |
| `/auto-trading` | `TechnicalWorkspacePage` → `AutoTradingPage` | 서버 계획·알림 | `TradeApprovalQueue` | 설정 UI와 승인 버튼 | `canAccessRiskPreview` + `canAccessPaperTrading` | #52, 실행 계층 #51 |
| 승인 알림 클릭 | 브라우저 알림 `onclick` | 현재 상태 표시 | 이동 없음 | 없음 | 알림 권한 사용자 | #52, 승인 화면 이동은 미구현 |
| 저장 검색 재실행 | `ScannerPage.restoreSavedSearch` | 조건 복원 후 스캔 | 결과 선택 후 composer | 없음 | `/scanner` 사용자 | #52 |
| Phase 12 승인 route | `/__phase12-trade-automation-e2e` | fixture | fixture queue | fixture settings | E2E env 전용 | #51/#52 공통 fixture |
| Phase 12 시장 route | `/__phase12-scanner-markets-e2e` | 공개 spot/futures fixture 진입 | 없음 | 없음 | E2E env 전용 | #52 |

### 경로 판정

- 모바일·데스크톱 stock scanner는 같은 `AnalysisSelectionProvider`를 사용한다.
- 데스크톱 `/scanner`는 embedded `AiChartPage` 한 개만 마운트하므로 approval composer 중복 마운트는 확인되지 않았다.
- `/auto-trading`은 composer를 마운트하지 않고 서버 계획을 조회하므로 scanner와 별도의 승인 계획을 자동 생성하지 않는다.
- 새로고침은 fixture와 서버 계획을 다시 조회할 뿐 UI 진입만으로 승인·주문 POST를 만들지 않는다.
- ScannerPage의 legacy auto 모드는 별도 실행 코드가 남아 있으나, 기본 설정 OFF 상태의 단순 진입만으로 주문 실행 함수가 호출되지는 않는다.

## 실제 신호·계획 상태도

| 현재 상태 | 이벤트 | 다음 상태 | 서버 검증 | 승인 가능 | 주문 전달 가능 |
|---|---|---|---|---|---|
| 없음 | 최초 평가, 기준 미달 전 감시 | `WATCHING` 또는 `WEAKENED` | 점수·신뢰도·핵심조건·손익비·데이터 시각 | 아니오 | 아니오 |
| 없음/감시 | 모든 기준 충족 | `READY_FOR_APPROVAL` + plan `APPROVAL_PENDING` | 서버 스캔·시세·호가·캔들·위험 | 예 | 승인 전 아니오 |
| `READY_FOR_APPROVAL` | 유지 재검증 성공 | `READY_FOR_APPROVAL` | 최신 validation 시각 갱신 | 예 | 승인 전 아니오 |
| `READY_FOR_APPROVAL` | 점수·신뢰도 소폭 미달 | `WEAKENED` | 서버 validation | 아니오 | 아니오 |
| 모든 비종료 상태 | 핵심조건 이탈·RR 붕괴·데이터 불량 | `INVALIDATED`, plan `EXPIRED` | 서버 validation | 아니오 | 아니오 |
| 모든 비종료 상태 | signal/approval TTL 경과 | `EXPIRED`, plan `EXPIRED` | 서버 시각 | 아니오 | 아니오 |
| `WEAKENED` | 조건 재충족 | `READY_FOR_APPROVAL` | 서버 validation | 예 | 승인 전 아니오 |
| 종료 계획 | 동일 조건 재진입 | 새 plan + 새 `signalId:reentry:N` | 계획 생성 전체 재검증 | 예 | 승인 전 아니오 |
| `READY_FOR_APPROVAL` | 사용자 거절 | validation invalidation, plan `EXPIRED` | 서버 사용자 범위 | 아니오 | 아니오 |
| `READY_FOR_APPROVAL` | 사용자 승인 | plan `SUBMITTED` | 최종 scanner 재검증 + risk 재검증 | 처리 중에는 아니오 | 현재 구현은 Paper order 생성으로 연결 |

`revalidating`, `approved`, `rejected`, `released`, `cancelled`, `reentered`는 별도 signal enum이 아니라 요청 중 상태, plan/order 상태 또는 이력 이벤트로 표현된다.

## 승인 직전 재검증 흐름

| 단계 | 함수 | 파일 | 클라이언트 검사 | 서버 검사 | idempotency | 실패 시 결과 |
|---|---|---|---|---|---|---|
| 1. 승인 가능 표시 | `approvalReason`, render | `trade-approval-queue.tsx` | 현재 approval·만료 | 없음 | 없음 | 버튼 비활성 |
| 2. 클릭 잠금 | `approve` | 같은 파일 | `actionId` | 없음 | 단일 인스턴스만 | 중복 클릭 반환 |
| 3. 사전 상태 조회 | GET `approval-status` | `trade-signal-approval.ts` | 응답 확인 | plan/signal/TTL/validation age | plan ID | confirm 전 차단 |
| 4. 사용자 확인 | `window.confirm` | `trade-approval-queue.tsx` | 명시 확인 | 없음 | 없음 | POST 없음 |
| 5. 승인 POST | `approveScannerPaperPlan` | `scanner-approval.ts` | `approved:true` | 사용자, plan 종류, KR Paper scanner | plan ID | 4xx, 주문 0 |
| 6. 최신 시장 재검증 | `revalidatePaperPlan` | `scanner-approval-plan.service.ts` | 없음 | 재스캔, 현재가 drift, 1m 변동, 호가 spread | 없음 | signal invalidation |
| 7. 상태 적용 | `revalidatePlan` | `trade-automation.service.ts` | 없음 | lifecycle 평가·저장 | plan ID | plan EXPIRED, 주문 0 |
| 8. 위험 재검증 | `approvePlan` | 같은 파일 | 없음 | 정책·긴급정지·live gate | plan ID | risk failure, plan EXPIRED |
| 9. 승인 확정 | `approvePlan` | 같은 파일 | 없음 | plan `SUBMITTED` 저장 | 재호출 시 approval 불가 | 오류 또는 기존 주문 조회 |
| 10. 실행 경계 | 현재 `createOrder` 이후 Paper FILLED | `scanner-approval.ts` | 없음 | 기존 order 선조회 | 비원자적 | PR #51로 이전 필요 |

## 위험 판정

| 위험 | 판정 | 근거 | 후속 조치 |
|---|---|---|---|
| 해제된 신호 승인 | 안전 | INVALIDATED/EXPIRED는 `approvalEnabled=false`, plan EXPIRED | 회귀 테스트 유지 |
| 만료된 신호 승인 | 안전 | signal TTL·approval TTL·validation age 모두 서버 검사 | 회귀 테스트 유지 |
| 취소한 승인 재사용 | 안전에 가까움 | invalidate 후 plan EXPIRED | 다중 요청 테스트 유지 |
| 재진입이 이전 approval ID 재사용 | 보강 완료 | `nextScannerSignalId`가 동일 버킷에서도 새 주기 ID 발급 | 단위·통합 테스트 고정 |
| 승인 API 지연 중 연속 클릭 | 부분 보호 | React `actionId`는 단일 컴포넌트만 보호 | 서버 atomic claim은 PR #51 저장소 계약에서 추가 |
| 승인 응답 유실 후 재시도 | 부분 보호 | 기존 order 선조회는 있으나 원자적이지 않음 | plan 단위 unique/CAS 확인 필요 |
| 두 브라우저 탭 동시 승인 | 중복 가능 | find → approve → createOrder가 여러 저장 호출 | DB 변경 금지 범위 밖. PR #51에서 atomic queue claim 필요 |
| 브라우저 알림 두 탭 중복 | 부분 보호 | localStorage delivered ID와 Notification tag 사용, 탭 간 CAS 없음 | BroadcastChannel/서버 delivery ledger 후보 |
| 권한 없는 시장 승인 | 안전 | `/trade-automation` 전체 `canAccessPaperTrading`, scanner plan은 KR Paper만 | spot/futures 승인 연결 시 시장별 capability 서버 검사 추가 |
| 실주문 endpoint 도달 | scanner KR Paper는 안전 | scanner router가 generic execution route보다 먼저 가로채고 exchange request false | 최종 통합 후 route 순서 회귀 테스트 필요 |

## NotificationOptions 타입 수정 재확인

`stock-analyzer/src/components/trade-signal-alerts.tsx`는 다음 조건을 만족한다.

- `NotificationOptions.renotify` 사용 없음
- `as any`, `@ts-ignore`, `@ts-expect-error` 없음
- 전역 DOM 타입 확장 없음
- Service Worker Notification API 혼용 없음
- `tag: alert.id` 유지
- localStorage 전달 이력 기반 동일 alert ID 중복 방지 유지

## 저장 검색

- 수정: ID와 생성 시각을 유지하고 이름·시장·시간봉·조건·점수·위험·임계값을 정규화한다.
- 삭제: 선택 ID만 제거 후 정규화 저장한다.
- 초기화: 저장 검색, scanner threshold, scanner market 키를 제거한다.
- 같은 페이지의 ScannerPage와 관리자는 localStorage를 공유하되 관리자가 닫힐 때 reload로 상태를 다시 읽는다.
- 서버 persistence는 이번 범위에 추가하지 않는다.

## 다른 PR과 실제 충돌 구간

| 파일·구간 | PR #52 목적 | 다른 PR 목적 | 충돌 유형 | 통합 방법 |
|---|---|---|---|---|
| `stock-analyzer/src/pages/ai-chart.tsx` | approval composer와 selection 연결 | #50 차트 구조·데이터·방송 안정성 | 동일 파일 직접 충돌 | #50 파일을 기준으로 유지하고 composer import·mount만 수동 삽입 |
| `api-server/test.mjs` | Phase 12 scanner/lifecycle tests 등록 | #50/#51/#58 각 테스트 등록 | 배열 hunk 충돌 | 최종 파일에서 테스트 entry만 합집합 |
| `trade-automation.repository.ts` | 계획 상태 조회·저장 | #51 atomic queue/order 저장 | 구조적 책임 충돌 | #51 repository를 기준으로 PR #52가 요구하는 plan 조회 계약만 보존 |
| `trade-automation.service.ts` | lifecycle 적용·approval status | #51 queue·order state·execution guardrail | 구조적 책임 충돌 | lifecycle 검사는 유지, order 생성·실행은 #51 서비스로 이동 |
| `trade-automation.types.ts` | signal/scanner context 타입 | #51 queue/order 타입 | 타입 병합 | signal 타입과 queue 타입을 분리 export 후 합집합 |
| `trade-approval-queue.tsx` | 승인 UI·재검증 호출 | #51 queue UI·주문 상태 | 동일 컴포넌트 충돌 | #51 queue 렌더를 유지하고 PR #52의 approvalEnabled/reason/최종검증 UI 삽입 |
| `auto-trading.tsx` | alerts + approval queue 배치 | #51 설정·queue·실행 상태 | 레이아웃 충돌 | #51 페이지 기준, PR #52 alerts/approval section만 수동 삽입 |
| `phase12-trade-automation.spec.ts` | approval state UI | #51 execution guardrail UI | 공유 테스트 충돌 | 공유 파일 직접 수정 대신 PR #52 독립 spec 유지 |
| `api-server/src/routes/index.ts` | scanner router 우선순위·capability | #58 일반 검색 route 인접 수정 | 인접 hunk 충돌 | 일반 검색은 #58, `/trade-automation` 순서는 #52 수동 보존 |
| `stock-analyzer/src/App.tsx` | Phase 12 scanner route | #58 검색 route | route 목록 충돌 | 양쪽 route를 순서 검토 후 수동 병합, 컴포넌트 복사 금지 |

## 테스트 계약

현재 직접 또는 기존 테스트로 고정된 계약:

- 신호 생성 후 승인 가능
- 조건 약화·해제·만료 후 승인 불가
- 승인 직전 가격 drift·조건 재검증
- 재검증 실패 시 주문 0
- 동일 버킷 재진입 시 새 signal ID와 새 plan ID
- 결정적 알림 ID와 주기별 최초·유지·해제·만료 알림
- 저장 검색 수정·삭제·초기화
- US scanner 승인 계획 차단
- 공개 spot/futures scanner에서 mutation·private API 0
- 승인 UI 진입·reload로 주문성 mutation 0

남은 비원자적 계약:

- 두 탭의 완전 동시 승인
- 네트워크 응답 유실과 정확히 동시에 발생한 재시도
- 여러 탭의 브라우저 Notification 전달 exactly-once

이 세 항목은 DB 또는 서버 atomic claim 없이 안전을 증명할 수 없으며, 이번 PR의 DB 변경 금지 조건 때문에 `부분 보호/중복 가능`로 명시한다.

## 최종 통합 순서

1. 운영 작업 종료 후 최신 main 확정
2. PR #50 차트 구조를 먼저 기준으로 선택
3. PR #58 일반 검색 route·App route 반영
4. PR #52 signal lifecycle, scanner service, composer, alerts, saved-search 계약 수동 삽입
5. PR #51 repository·queue·execution 구현을 기준으로 승인 완료 → queue claim 경계 연결
6. plan 단위 atomic queue claim 또는 unique/CAS 검증
7. 전체 typecheck, unit, backend smoke, desktop/mobile Playwright, frontend/backend build
8. 실제 주문 request 0인 Paper/E2E 검증 후에만 별도 병합 승인 검토

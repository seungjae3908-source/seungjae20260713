# PR #77 외부 AI 차트 창 — 최신 main 최소 통합 설계

작성 기준: 2026-08-06 KST

## 기준과 안전 경계

- 저장소: `seungjae3908-source/seungjae20260713`
- PR: `#77`
- 작업 브랜치: `audit/ai-realtime-chart-improvements`
- 설계 시작 HEAD: `76ef63a5315cd8072372043004cd8276eb890fa7`
- 읽기 전용 비교 main: `6e7ccd281e0255d99bbcd2f8574866a7fe8cc588`
- 이 문서를 작성하는 단계에서는 main merge, rebase, Draft 해제, 배포, DB·Secret·서버 변경을 수행하지 않는다.
- PR #77은 주문·계좌·포지션·자동매매 기능을 소유하지 않는다.

## 현재 충돌 원인

PR #77의 `stock-analyzer/src/pages/ai-chart.tsx`는 `ChartBroadcastPanel`을 직접 렌더링한다. 이 컴포넌트는 현재 브랜치에서 KR·US 주식 차트, 데이터 요청, 캔들 정규화, 지표와 분석 UI를 함께 소유한다.

최신 main의 같은 페이지는 `UnifiedAnalysisChart`를 렌더링한다. 최신 컴포넌트의 계약은 다음과 같다.

- `selection: AnalysisSelection`
- `onSelectionChange: (selection: AnalysisSelection) => void`
- `onAnalysisChange?: (analysis: ChartAnalysis | null) => void`

`UnifiedAnalysisChart`와 `unified-chart-data.ts`가 KR·US·UPBIT·BITGET, 실제 데이터 요청, AbortSignal, 최신 응답 반영, 캔들 정규화, 지표, 구조·패턴 분석을 소유한다. 따라서 PR #77의 구형 페이지를 최신 main 위에 덮으면 4시장 차트가 KR·US 전용 구현으로 퇴행한다.

## 운영배포 후 목표 구조

### 페이지 shell

`AiChartPage`는 다음만 소유한다.

1. route에서 검증된 `AnalysisSelection` 읽기
2. 본창/외부 창 layout 차이
3. 데스크톱 외부 창 열기·focus·1개 제한
4. 팝업 차단·닫힘·새로고침·unmount 처리
5. `BroadcastChannel` 세션 및 창 pair 수명주기
6. 시장·종목·시간봉의 원자적 선택 snapshot 동기화
7. 상태 안내와 모바일 버튼 비노출
8. 최신 main의 `UnifiedAnalysisChart` 렌더링

### 단일 차트 엔진

본창과 외부 창은 모두 아래 한 컴포넌트를 사용한다.

```tsx
<UnifiedAnalysisChart
  selection={selection}
  onSelectionChange={updateSelection}
  onAnalysisChange={setAnalysis}
/>
```

외부 창 전용 차트 컴포넌트, 별도 polling, 별도 캔들 정규화, 별도 지표 계산, 별도 패턴 엔진을 만들지 않는다.

## 유지할 코드

- `stock-analyzer/src/lib/chart-external-window.ts`
  - strict route와 URL 생성
  - session/pair/source/origin/sequence 검증
  - stale·future·역순·교체된 창 메시지 차단
  - 원자적 선택 snapshot과 결정론적 충돌 순서
  - listener와 popup timer cleanup helper
- `stock-analyzer/src/lib/chart-external-window.test.ts`
- `stock-analyzer/e2e/ai-chart-external-window.spec.ts`
  - 최신 main UI 이름과 시간봉 계약에 맞춰 최소 selector 수정
- `api-server/test.mjs`의 helper 테스트 등록

## 제거할 코드

최신 main을 일반 2-parent merge한 뒤 충돌 해결에서 다음 PR #77 쪽 코드를 제거한다.

- `ChartBroadcastPanel` import와 렌더링
- `ChartBroadcastMarket` 변환
- UPBIT·BITGET 선택을 KR로 축소하는 fallback
- 구형 차트 컴포넌트에 맞춘 종목·시간봉 변환 로직
- 페이지 안에서 중복된 데이터 요청·지표·패턴·시장 표시 로직

`stock-analyzer/src/components/chart-broadcast.tsx` 파일 자체는 PR #77이 삭제하지 않는다. 다른 사용자 경로가 사용하는지 최신 main에서 다시 검색한 뒤, 별도 책임의 변경에서만 제거 여부를 판단한다.

## 예상 충돌 파일

### 직접 충돌 가능성이 높은 파일

- `stock-analyzer/src/pages/ai-chart.tsx`
  - 최신 main의 `UnifiedAnalysisChart` UI를 기준으로 유지
  - PR #77에서는 외부 창 shell과 동기화 effect만 이식
- `api-server/test.mjs`
  - 최신 main의 테스트 그룹을 보존하고 helper 테스트 한 줄만 유지

### selector 또는 계약 조정 가능 파일

- `stock-analyzer/e2e/ai-chart-external-window.spec.ts`
  - 최신 main heading, 시간봉 버튼, 4시장 route와 API mock 계약 반영
- `stock-analyzer/src/lib/chart-external-window.test.ts`
  - 최신 main이 지원하는 시간봉 allowlist와 symbol 정규화 계약 확인

### 충돌 없이 유지할 가능성이 높은 파일

- `stock-analyzer/src/lib/chart-external-window.ts`
- 이 통합 설계 문서

## 상태 소유 규칙

- `AiChartPage`의 `selection`이 shell의 단일 현재 snapshot이다.
- `UnifiedAnalysisChart`가 사용자 선택을 변경하면 완전한 `AnalysisSelection` 한 개를 반환한다.
- shell은 검증 후 local state·URL·공유 selection store를 같은 snapshot으로 갱신한다.
- 외부 창으로는 점수·신뢰도·근거·주문 정보가 아니라 시장·종목·표시명·시간봉·선택시각만 전송한다.
- 서로 다른 창에서 동시에 변경하면 `sentAt → sourceId → sequence`의 전순서로 한 snapshot만 선택한다.
- 현재 session, pair, origin, 반대 role, 현재 peer source만 허용한다.
- 외부 창이 교체되면 이전 source ID를 폐기 목록에 넣고 이후 `ready`를 포함한 모든 메시지를 거부한다.

## route 계약

- 본창: `/ai-chart?<validated-selection>`
- 외부 창: `/ai-chart?<validated-selection>&chartWindow=external&chartSync=<session>&chartPair=<pair>`
- 중복 query parameter, 빈 종목, 알 수 없는 시장, 지원하지 않는 시간봉, 제어문자, traversal·script-like 문자열은 fail-closed 처리한다.
- 잘못된 route를 삼성전자 등 임의 기본 차트로 바꾸지 않는다. 기존 정상 selection을 유지하거나 명시적 오류를 표시한다.

## 운영배포 후 실행 순서

1. 실제 운영배포 main 40자리 SHA와 main CI 6/6을 확인한다.
2. 그 main을 PR #77 브랜치에 일반 2-parent merge한다.
3. `ai-chart.tsx` 충돌은 최신 main 페이지를 기준으로 해결한다.
4. `ChartBroadcastPanel` 연결을 제거하고 `UnifiedAnalysisChart`를 그대로 유지한다.
5. 외부 창 shell과 helper 호출만 최신 페이지에 이식한다.
6. helper 시간봉 allowlist를 최신 `UNIFIED_CHART_TIMEFRAMES`와 일치시킨다.
7. KR·US·UPBIT·BITGET 및 전체 지원 시간봉을 본창·외부 창 양방향으로 검증한다.
8. frontend/backend typecheck, 단위·회귀, production build를 실행한다.
9. Desktop·Mobile Playwright, console/page/unhandled/HTTP 오류 0, 주문성 mutation 및 계좌·포지션 요청 0을 확인한다.
10. Application CI가 PR HEAD와 동일한 SHA를 검사하고 필수 상태 6/6 success인지 확인한다.
11. PR은 Draft 상태로 유지하고 병합은 별도 승인 전까지 수행하지 않는다.

## 완료 판정

운영배포 전 완료는 helper·shell 계약과 현재 브랜치 검증까지다. 4시장 통합 완료 판정은 최신 배포 main을 실제로 병합한 이후에만 가능하다. 최신 main 병합 전에는 코인 선택을 주식으로 변환하거나 구형 엔진을 확장해 임시 4시장 지원을 만들지 않는다.

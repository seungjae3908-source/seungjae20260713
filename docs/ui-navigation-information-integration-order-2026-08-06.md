# UI·내비게이션·정보방 통합 순서 후보 — 2026-08-06

이 문서는 운영배포 완료 후의 통합 후보 순서만 기록한다. 이 문서 작성은 main 병합, 기능 브랜치 갱신, rebase, cherry-pick, Staging·Production 실행, 배포·DB·Secret·서버 변경을 승인하거나 수행하지 않는다.

## 확인 기준

- 저장소: `seungjae3908-source/seungjae20260713`
- 최신 확인 main: `6e7ccd281e0255d99bbcd2f8574866a7fe8cc588`
- PR #56: 종목정보 안정화와 종목분석
- PR #58: 검색 백엔드와 통합 검색 UI
- PR #76: 국내·미국주식·코인 현물·코인 선물 정보방
- PR #61: 전역 메뉴, route 표현, breadcrumb, 활성 상태, 접근성
- 운영배포 완료 전에는 네 PR 모두 미병합 상태를 유지한다.

## 책임 경계

| PR | 소유 책임 | 통합 시 금지 |
| --- | --- | --- |
| #56 | `/stock-info` 데이터 안정화, 시장 격리, 종목분석 허브 | 통합 검색 재구현, 전역 메뉴 변경, 자동매매 설정 변경 |
| #58 | 통합 자산 검색 인덱스·API·autocomplete·검색 route | 종목분석 엔진 복제, 정보방 데이터 API 복제, 전역 메뉴 접근성 재구현 |
| #76 | 네 시장 정보방 route·공개 데이터 계약·상태 UI | `BottomNav` 변경, 통합 검색 구현 복제, 종목분석 엔진 변경 |
| #61 | 최종 route 표현·메뉴 그룹·breadcrumb·활성 상태·접근성 | 기능 API·분석 수식·차트·검색기·자동매매 로직 변경 |

## 통합 순서 후보

### 1. PR #56 — 종목정보 안정화와 종목분석

먼저 최종 상세 도착점인 `/stock-info` 계약을 안정화한다. 검색과 정보방이 상세 화면으로 이동할 때 의존하는 시장·종목 식별, 오류·부분 데이터·stale 처리, 직접 URL·새로고침 동작을 먼저 확정한다.

통합 전 확인:

- 운영배포 완료 main SHA 재확인
- 최신 main을 PR #56 브랜치에 일반 2-parent merge
- `App.tsx` 테스트 route만 최소 충돌 해결
- 자동매매·설정 파일 변경이 PR diff에 없는지 재확인

필수 검증:

- frontend/backend typecheck
- 종목정보·종목분석 단위·계약·Playwright
- 전체 회귀와 production build
- 360·390·430px 및 데스크톱
- 직접 URL·새로고침·뒤로가기·빠른 KR/US 전환
- console/page/unhandled·예상 밖 HTTP 오류 0
- 주문성 mutation 0
- 정확한 HEAD에서 CI 6/6

CI 6/6 결과를 보고한 뒤 PR #56 병합 승인을 별도로 요청한다.

### 2. PR #58 — 검색 백엔드와 통합 검색 UI

상세 도착점이 확정된 다음 국내주식·미국주식·코인 현물·코인 선물 통합 검색을 넣는다. `/stocks`, `/search`, `/market-rankings`, `/market-browser`의 최종 검색·순위 route 소유권을 먼저 확정해 이후 정보방과 내비게이션이 이 계약을 소비하게 한다.

통합 전 확인:

- PR #56 병합 완료 main SHA 재확인
- 최신 main을 PR #58 브랜치에 일반 2-parent merge
- `App.tsx`, `api-server/src/routes/index.ts`, `api-server/test.mjs`를 기능 단위로 수동 병합
- `/stock-info` 상세 이동 계약을 PR #56 기준으로 검증
- 배포 workflow·ops·DB·Secret 파일 변경이 없는지 확인

필수 검증:

- 검색 단위·API·fallback·IME·빠른 입력·요청 취소
- 네 시장 분리와 정확한 상세 이동
- 전체 backend 회귀와 frontend/backend production build
- 360·390·430px 및 데스크톱 Playwright
- console/page/unhandled·예상 밖 HTTP 오류 0
- 주문성 mutation 0
- 정확한 HEAD에서 CI 6/6

CI 6/6 결과를 보고한 뒤 PR #58 병합 승인을 별도로 요청한다.

### 3. PR #76 — 네 시장 정보방

검색 route와 상세 도착점이 확정된 뒤 네 시장 정보방을 추가한다. PR #76은 `App.tsx`, API route index, test registry에서 PR #58 결과를 보존한 채 정보방 route와 공개 데이터 API만 더한다.

통합 전 확인:

- PR #58 병합 완료 main SHA 재확인
- 최신 main을 PR #76 브랜치에 일반 2-parent merge
- `App.tsx`, `api-server/src/routes/index.ts`, `api-server/test.mjs` 충돌을 전체 파일 선택 없이 기능 hunk 단위로 해결
- `bottom-nav.tsx`가 PR #76 diff에 다시 들어오지 않는지 확인
- 검색 API·종목분석 엔진 중복 구현이 없는지 확인

필수 검증:

- `/stocks/kr`, `/stocks/us`, `/coins/spot`, `/coins/futures` 직접 진입
- 새로고침·뒤로가기·앞으로가기
- 빠른 시장 전환과 이전 응답 취소
- 로딩·빈 결과·부분 데이터·stale·401·403·429·timeout·provider 오류
- 공개 데이터만 사용하고 private/account/order 요청 0
- 360·390·430px 및 데스크톱
- console/page/unhandled·예상 밖 HTTP 오류 0
- 정확한 HEAD에서 CI 6/6

CI 6/6 결과를 보고한 뒤 PR #76 병합 승인을 별도로 요청한다.

### 4. PR #61 — 전역 UI·내비게이션

기능 route가 모두 확정된 뒤 내비게이션을 마지막에 통합한다. 최종 main의 실제 route를 `APP_NAVIGATION`과 `APP_ROUTE_PRESENTATIONS`에서 소비하고, 기능 코드를 복사하지 않는다.

통합 전 확인:

- PR #76 병합 완료 main SHA 재확인
- 최신 main을 PR #61 브랜치에 일반 2-parent merge
- 종목 메뉴는 PR #58 최종 검색 route를 사용
- 정보 메뉴는 PR #76 네 정보방과 기존 종목정보 route를 일관되게 표현
- pending·associate·regular·admin capability 노출을 실제 권한 계약과 대조
- 테스트 전용 `__` route는 제품 메뉴에서 제외

필수 검증:

- 상위 메뉴·화면 제목·breadcrumb·활성 상태 일치
- 선택 직후 팝업 닫힘과 별도 전체 화면 이동
- Escape·외부 클릭·포커스 복귀·menu focus trap
- 최소 44px 터치 영역
- 360·390·430px 및 데스크톱
- 직접 URL·새로고침·뒤로가기
- 미연결 버튼·중복 버튼·임시 alert 0
- console/page/unhandled·예상 밖 HTTP 오류 0
- 주문성 mutation 0
- 정확한 HEAD에서 CI 6/6

CI 6/6 결과를 보고한 뒤 PR #61 병합 승인을 별도로 요청한다.

## 공통 승인 게이트

각 단계는 반드시 다음 순서로 끊어서 진행한다.

1. 직전 기능 병합·CI 완료 확인
2. 현재 main SHA 재확인
3. 대상 기능 브랜치에 최신 main 일반 merge
4. 해당 PR 책임 안에서만 충돌 최소 해결
5. 전체 검증과 정확한 HEAD의 CI 6/6 확인
6. 결과·남은 문제·다음 작업 보고
7. 해당 기능 하나의 main 병합 승인 요청
8. 승인 전 다음 기능 통합 시작 금지

여러 기능을 한 번에 main에 넣지 않는다. force push, rebase, cherry-pick, 테스트 삭제·완화, 실패 은폐, 운영 설정 변경은 사용하지 않는다.

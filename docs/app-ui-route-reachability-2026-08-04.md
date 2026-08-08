# 앱 UI route 도달성·표현 계약 감사 — 2026-08-04

이 문서는 UI PR #61의 내비게이션·접근성·route 소비 계약만 다룬다. `App.tsx`, 검색·차트·신호·주문 기능, 서버, DB, 배포, Secret, 실제 계좌와 주문은 변경하지 않는다.

## 검증 기준과 제한

- 저장소: `seungjae3908-source/seungjae20260713`
- 기준 `main`: `1987b74799d213b63d065c63a7c8c3b675a863f4`
- 대상 브랜치: `feature/app-ui-navigation-cleanup`
- PR #61은 open·Draft·미병합 상태를 유지한다.
- 현재 `App.tsx`에 선언된 제품·별칭·redirect route 패턴은 29개다.
- 환경 플래그로만 활성화되는 `__` 테스트 route 패턴은 10개다.
- `/market-rankings`, `/market-browser`는 현재 브랜치에 존재하지 않으며 PR #58 통합 전에는 메뉴에 연결하지 않는다.
- GitHub App의 이 저장소 코드 검색 인덱스가 비활성화되어 있어 저장소 전체 문자열 검색 결과 0개를 결함 0개로 간주하지 않았다. 알려진 route 파일, 페이지 파일, PR diff와 통합 감사 문서를 직접 대조했다.

## 활성 route 도달성

| 경로 | 페이지 | 메뉴 진입 | 사용자 도달 가능 | 모바일 | 데스크톱 | 책임 PR | 문제 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/`, `/home` | `HomePage` | 홈 상위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/stocks` | `StocksPage` | 홈 검색 버튼·종목 메뉴 | 예 | 예 | 예 | 현재 UI, 통합 후 #58 | 현재 자산 검색 구현은 #58 통합 후 교체 대상 |
| `/search` | `SearchPage` | 종목 메뉴의 시장 순위 | 예 | 예 | 예 | 현재 UI, 통합 후 #58 | 통합 후 unified search alias가 되고 순위는 `/market-rankings`로 이동 |
| `/stock/:ticker` | `DetailPage` | 종목 목록·검색 결과 | 예 | 예 | 예 | 기존 상세/#58 선택 계약 | 종목 상위 메뉴 활성 계약 유지 |
| `/stock-info` | `StockInfoAccess` | 코인 목록·redirect·상세 이동 | 권한 충족 시 예 | 예 | 예 | 기존 상세/#56·#58 | 종목 상위 메뉴 활성 계약 유지 |
| `/recommendations` | `RecommendationsPage` | 상위 메뉴 항목 없음; 직접 route 또는 기존 기능 진입점 | 권한 충족 시 예 | 예 | 예 | 기존 기능, 활성 표시 #61 | 기존에는 `BottomNav`를 렌더링해도 상위 메뉴 활성 표시가 없었음. 종목 그룹으로 수정 |
| `/themes` | `ThemesPage` | 종목 하위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/watchlist` | `WatchlistPage` | 종목 하위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/alerts` | `AlertsPage` | 홈 알림 버튼·종목 하위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/scanner` | `ScannerAccess` → `TechnicalWorkspacePage` | 기술 하위 메뉴 | `canAccessRiskPreview` 충족 시 예 | 예 | 예 | #52, 연결 #61 | 기능·권한은 #52 소유 |
| `/ai-chart` | `AiChartAccess` | 기술 하위 메뉴 | `canAccessRiskPreview` 충족 시 예 | 예 | 예 | #50/#52, 연결 #61 | 차트 내부는 #50, 승인 composer는 #52 |
| `/auto-trading` | `ScannerAccess` → `TechnicalWorkspacePage` | 기술 하위 메뉴 | 권한 충족 시 예 | 예 | 예 | #51/#52, 연결 #61 | queue·승인 상태는 내비게이션에서 생성하지 않음 |
| `/backtests` | `BacktestsPage` | 상위 메뉴 항목 없음; 직접 route 또는 기존 기능 진입점 | 권한 충족 시 예 | 예 | 예 | 기존 백테스트, 활성 표시 #61 | 기존에는 `BottomNav`의 활성 상위 메뉴가 없었음. 기술 그룹으로 수정 |
| `/paper-trading` | `PaperTradingPage` | `/backtests`의 모의매매 이동 링크·직접 route | `canAccessPaperTrading` 충족 시 예 | 예 | 예 | 기존 Paper, 활성 표시 #61 | 기존에는 `BottomNav`의 활성 상위 메뉴가 없었음. 기술 그룹으로 수정 |
| `/market-overview` | `MarketOverviewPage` | 정보 하위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/learn` | `LearnPage` | 정보 하위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/ai-chat` | `AiChatAccess` | 정보 하위 메뉴 | `canAccessBasicInfo` 충족 시 예 | 예 | 예 | 정보 기능, 연결 #61 | 없음 |
| `/portfolio`, `/assets` | `PortfolioAccess` | 정보 하위 메뉴·설정의 포트폴리오 버튼 | `canAccessPaperTrading` 충족 시 예 | 예 | 예 | 기존 포트폴리오, 연결 #61 | `/assets` alias도 정보 그룹 활성 |
| `/more`, `/settings` | `MorePage` | 설정 상위 메뉴 | 예 | 예 | 예 | #61 | 없음 |
| `/account`, `/login` | `AccountPage` | 설정 화면의 계정 버튼·인증 진입 | 예 | 예 | 예 | 기존 인증, 연결 #61 | 승인 전에는 제품 메뉴를 숨기는 기존 동작 유지 |
| `/admin` | `AdminAccess` → `AdminPage` | 관리자 계정 화면의 회원 관리 버튼 | `canManageMembers` 충족 시 예 | 예 | 예 | 기존 관리자, 활성 표시 #61 | 설정 그룹 표현 계약 추가. 관리자 페이지 자체에는 `BottomNav`가 없음 |
| `/install` | `InstallPage` | 설치 흐름·직접 route | 예 | 예 | 예 | 기존 설치 | 인증 전 독립 화면이라 상위 메뉴 없음 |
| `/crypto` | `CryptoHomeRedirect` | legacy deep link | redirect만 가능 | 예 | 예 | 기존 redirect | `/home`으로 즉시 이동하는 transient route |
| `/crypto/search` | `CryptoSearchRedirect` | legacy deep link | redirect만 가능 | 예 | 예 | 기존 redirect | `/stocks`로 즉시 이동하는 transient route |
| `/crypto/:symbol` | `CryptoDetailRedirect` | legacy deep link | redirect만 가능 | 예 | 예 | 기존 redirect | `/stock-info`로 즉시 이동하는 transient route |
| `/__phase4-risk-e2e` | Phase 4 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 4 | 환경 플래그 전용 |
| `/__phase5-backtest-e2e` | Phase 5 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 5 | 환경 플래그 전용 |
| `/__phase6-paper-trading-e2e` | Phase 6 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 6 | 환경 플래그 전용 |
| `/__phase7-journal-sync-e2e` | Phase 7 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 7 | 환경 플래그 전용 |
| `/__phase8-release-candidate-e2e` | Phase 8 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 8 | 환경 플래그 전용 |
| `/__phase9-ai-review-e2e` | Phase 9 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 9 | 환경 플래그 전용 |
| `/__phase11-ai-workspace-e2e` | Phase 11 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 11 | 환경 플래그 전용 |
| `/__phase11-ai-chat-e2e` | Phase 11 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 11 | 환경 플래그 전용 |
| `/__phase11-technical-workspace-e2e` | Phase 11 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | Phase 11/#61 | 환경 플래그 전용; 내비게이션 회귀 fixture로만 사용 |
| `/__phase12-trade-automation-e2e` | Phase 12 fixture | 제품 메뉴 없음 | 일반 사용자 불가 | 테스트 | 테스트 | #51/#52 | 환경 플래그 전용 |

## 화면 제목·활성 메뉴·breadcrumb 계약

`APP_ROUTE_PRESENTATIONS`는 route별 화면 제목, breadcrumb, 상위 메뉴 그룹을 독립 메타데이터로 정의한다. 현재 단계에서는 페이지 렌더링이나 `App.tsx` route를 바꾸지 않고 통합 후 소비할 계약만 제공한다.

| route 묶음 | 화면 제목 계약 | 활성 상위 메뉴 | breadcrumb |
| --- | --- | --- | --- |
| `/`, `/home` | 홈 | 홈 | 홈 |
| 자산 검색·순위·테마·관심·알림 | 각 기능 제목 | 종목 | 종목 → 기능 |
| `/stock/:ticker`, `/stock-info` | 종목 상세·종목 정보 | 종목 | 종목 → 상세/정보 |
| `/recommendations` | AI 추천 | 종목 | 종목 → AI 추천 |
| `/scanner`, `/ai-chart`, `/auto-trading` | AI 검색기·AI 차트 분석기·승인형 주문 | 기술 | 기술 → 기능 |
| `/backtests`, `/paper-trading` | 코인 선물 백테스트 연구·모의매매 | 기술 | 기술 → 백테스트/모의매매 |
| 정보 기능 | 시황·공부·AI 정보·포트폴리오 | 정보 | 정보 → 기능 |
| 설정·계정·관리자 | 설정·계정·회원 관리 | 설정 | 설정 → 기능 |
| redirect route | 이동 목적에 맞는 임시 제목 | 제품 메뉴 판단 대상 아님 | 목적 화면 기준 |
| `__` route | 테스트 전용 | 모든 제품 메뉴 비활성 | 테스트 전용 |

모바일과 데스크톱은 같은 `BottomNav`와 같은 route 메타데이터를 소비하므로 활성 상태 기준이 동일하다. 브라우저 뒤로가기와 직접 URL 접근도 현재 location으로 매번 다시 계산한다.

## 중복 검색 UI 역할

| UI 위치 | 현재 목적 | PR #58 이후 목적 | 유지·교체 | 책임 PR | 통합 방법 |
| --- | --- | --- | --- | --- | --- |
| 홈 검색 버튼 | 검색 화면 진입 | `UnifiedAssetSearchPage` 진입 | 유지 | 홈 진입 #61, 검색 동작 #58 | `/stocks` route 값만 소비 |
| `StocksPage` 검색 입력 | 주식·코인 자산 검색·필터 | `UnifiedAssetSearch` 기반 자산 자동완성 검색 | 교체 | #58 | 컴포넌트·API·타입·상세 helper를 #58에서 그대로 소비 |
| `SearchPage` 입력 | 시장순위 목록의 종목명·코드 필터 | 순위 기능은 `/market-rankings`; `/search`는 unified search alias | route 역할 분리 | #58 | #58 병합 후 메뉴의 시장 순위 href만 `/market-rankings`로 변경 |
| 향후 `/market-browser` | 현재 route 없음 | 기존 브라우저 기능 보존 | 통합 후 추가 여부 결정 | #58/#61 | 실제 route 존재와 사용자 가치 확인 전 메뉴에 추가하지 않음 |

UI PR은 `UnifiedAssetSearch`, `UnifiedAssetSearchPage`, `GET /api/search/suggest`, `UnifiedAssetSuggestion`, `UnifiedAssetSuggestResponse`, `unifiedAssetDetailPath()`, `partial`, `stale`, `dataAsOf`를 재정의하지 않는다.

## 더미·미연결 UI 감사

| 후보 | 분류 | 결과 | 처리 |
| --- | --- | --- | --- |
| UI PR 변경 파일의 빈 `onClick`, `onClick={() => {}}`, `href="#"`, 임시 `alert`, `console.log` 전용 동작 | E. 확인된 문제 없음 | 변경 diff와 직접 파일 점검에서 확인되지 않음 | 수정 없음 |
| `/recommendations`의 상위 메뉴 활성 누락 | A. 사용자 노출 결함 | 페이지에 `BottomNav`가 있으나 어느 그룹도 활성화되지 않았음 | 종목 그룹 active route로 추가 |
| `/backtests`의 상위 메뉴 활성 누락 | A. 사용자 노출 결함 | 페이지에 `BottomNav`가 있으나 어느 그룹도 활성화되지 않았음 | 기술 그룹 active route로 추가 |
| `/paper-trading`의 상위 메뉴 활성 누락 | A. 사용자 노출 결함 | 페이지에 `BottomNav`가 있으나 어느 그룹도 활성화되지 않았음 | 기술 그룹 active route로 추가 |
| `/admin` 표현 계약 누락 | D. 활성 route의 레거시 공백 | 계정 화면에서 도달 가능하지만 route 제목·상위 그룹 메타데이터가 없었음 | 설정 그룹 표현 계약 추가; 기능 화면 미수정 |
| Scanner 내부 constant-false threshold/help 조각 2개 | D. 레거시 코드, 현재 사용자 결함 아님 | 동일 파일에 실제 dialog·threshold UI가 별도로 활성 구현되어 있음 | Scanner 소유로 보고만 하고 #61에서 수정하지 않음 |
| `/recommendations`, `/backtests`의 상위 메뉴 직접 진입 항목 부재 | D. 활성 route지만 주 진입점 제한 | route는 활성이나 5개 상위 메뉴의 하위 항목에는 없음 | 기능 배치 결정 전 조기 메뉴 추가 금지; 도달성 후보로 기록 |
| `/paper-trading` 상위 메뉴 직접 진입 항목 부재 | B/D. 의도적 보조 기능 | `/backtests`에서 이동 가능 | 현 구조 유지; 기능 소유 PR에서 배치 결정 |
| `/admin` 상위 메뉴 직접 항목 부재 | B. 권한 제한 기능 | 관리자 계정 화면에서만 버튼 노출 | 기존 권한 기반 진입 유지 |
| `__` 테스트 버튼·route 제품 노출 | C. 테스트 전용 | 모두 env flag 및 제품 메뉴 미연결 | 테스트 전용 메타데이터로 고정 |

확인된 사용자 노출 활성-state 결함은 3개이며 모두 UI 메타데이터에서 수정했다. 잘못된 현재 route 링크는 확인되지 않았다. 저장소 코드 검색 인덱스가 비활성 상태이므로 전체 저장소 패턴 검색의 절대적인 0건을 주장하지 않으며, 통합 tree에서 로컬 정적 검색과 전체 Playwright를 다시 실행해야 한다.

## 기능 PR 통합 계약

| 기능 | 책임 PR | UI가 소비할 공개 계약 | UI 수정 파일 | `App.tsx` 처리 |
| --- | --- | --- | --- | --- |
| 통합검색 | #58 | `/stocks`, `/search`, 통합 후 `/market-rankings`, 선택적으로 `/market-browser`; unified search 컴포넌트·응답·상세 경로 helper | `app-navigation.ts`, 통합 후 내비게이션 테스트·문서 | #58 route 블록을 그대로 유지하고 #61에서 재작성하지 않음 |
| AI 차트 | #50 | `/ai-chart`, `canAccessRiskPreview`, 차트 페이지 공개 구조 | route 메타데이터·내비게이션 테스트 | #50 구조 유지; #61은 route 소비만 함 |
| AI 신호검색기 | #52 | `/scanner`, 시장별 capability, 승인 생명주기와 저장 검색의 공개 UI 경계 | route 메타데이터·내비게이션 테스트 | #52 route·fixture를 유지; #61은 scanner 코드 복사 금지 |
| 승인형 주문·최적화 | #52 생명주기 + #51 경제성·위험 평가 | `/auto-trading`, `canAccessPaperTrading`, 하나의 승인 queue 계약 | route 메타데이터·내비게이션 테스트 | 기능 PR들이 통합한 route를 소비하며 queue나 승인 상태를 router/nav에서 만들지 않음 |

## 안전 결과

- `App.tsx` 수정: 0
- 검색·차트·Scanner·자동매매 기능 코드 복사: 0
- 서버·DB·Supabase·Secret·배포 변경: 0
- 주문성 API 호출: 0
- 실제 계좌 접근·실제 주문: 0
- PR #61은 Draft 유지

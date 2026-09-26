# 앱 UI 정적 연결 감사 — 2026-08-04

UI PR #61의 CI checkout에서 `stock-analyzer/src` 아래 `.ts`, `.tsx` 파일을 재귀 스캔했다. GitHub 코드 검색 인덱스 상태와 무관하게 실제 PR merge ref의 소스 123개 파일을 검사한다.

## 검사 패턴

- 빈 `onClick={() => {}}`
- `href="#"`
- 임시 `alert()` / `window.alert()`
- 제품 코드의 `console.log()`
- `{false && ...}` constant-false 렌더 조각
- `navigate("/...")`, `href="/..."`, `to="/..."` 형태의 정적 내부 route가 route 표현 계약으로 해석되는지

테스트 파일: `stock-analyzer/e2e/ui-static-audit.spec.ts`

감사 결과는 Playwright 첨부 파일 `ui-static-audit.json`과 CI 로그의 `UI_STATIC_AUDIT=` 레코드에 남는다.

## 최초 스캔 결과

Application CI Run `30899191200`, HEAD `4560504e4c44921821810b375c7d14fd8ae53010`에서 다음을 확인했다.

| 항목 | 건수 | 분류 | 처리 |
| --- | ---: | --- | --- |
| 빈 `onClick` | 0 | 문제 없음 | 없음 |
| `href="#"` | 0 | 문제 없음 | 없음 |
| `console.log` 제품 동작 | 0 | 문제 없음 | 없음 |
| 해석되지 않는 정적 내부 route | 0 | 문제 없음 | 없음 |
| 임시 `alert()` | 1 | A. 사용자 노출 UI 결함 | 수정 |
| constant-false 렌더 | 2 | D. Scanner 레거시 조각 | 기능 PR 보고 유지 |

## 수정한 사용자 노출 결함

`stock-analyzer/src/components/tabs/news-tab.tsx`에서 원문 URL이 없거나 `http/https`가 아닌 경우 브라우저 `alert("원문 링크를 사용할 수 없습니다.")`를 호출하던 동작을 제거했다.

변경 후 계약:

- 유효한 `http/https` URL만 새 창으로 연다.
- 원문 URL이 없으면 뉴스 항목 버튼을 비활성화한다.
- 비활성 사유를 `title="원문 링크를 사용할 수 없습니다."`와 화면의 `원문 링크 없음` 배지로 표시한다.
- 비활성 버튼은 `aria-disabled`, `disabled`, 금지 커서와 명확한 시각 상태를 가진다.
- 뉴스 데이터, 감성 점수, API, 서버 로직은 변경하지 않는다.

## 보고만 한 항목

`stock-analyzer/src/pages/scanner.tsx`의 constant-false 렌더 2개는 같은 파일에 실제 threshold dialog와 도움말 UI가 별도로 활성 구현되어 있어 현재 사용자에게 노출되는 빈 버튼이 아니다. Scanner 기능 소유 PR #52 범위로 보고만 하고 UI PR #61에서는 제거하거나 기능을 복사하지 않는다.

## 안전 경계

- `App.tsx` 수정 없음
- 검색·차트·신호·주문 비즈니스 로직 변경 없음
- 서버·DB·Supabase·Secret·배포 변경 없음
- 주문성 API 요청 없음
- 실제 계좌 접근·실제 주문 없음
- PR #61 Draft 유지

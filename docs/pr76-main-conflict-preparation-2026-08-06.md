# PR #76 운영배포 후 충돌 준비 자료

기준일: 2026-08-06

## 고정 기준

- 저장소: `seungjae3908-source/seungjae20260713`
- 최신 확인 main: `6e7ccd281e0255d99bbcd2f8574866a7fe8cc588`
- merge base: `c650fbb6eefe6dd728a9e1baaabe65eef2688caa`
- 분석 시작 PR #76 HEAD: `a43511327554a67393831559e5753bf66cd6f935`
- 브랜치: `audit/market-information-room-improvements`
- 실제 merge/rebase/cherry-pick: **0회**
- main 반영: **0회**
- Staging/Production/DB/Secret/서버 변경: **0회**

이 문서는 실제 병합 없이 merge base 이후 main 변경 파일과 PR #76 변경 파일의 교집합을 읽기 전용으로 분석한 결과다.

## 충돌 예상 파일

### `api-server/src/routes/index.ts`

main에서 유지할 책임:

- `/market/scan` bounded scanner 우선 등록
- `/scanner/crypto` 인증·capability 보호 등록
- private 계좌·포지션·주문 경로 선행 차단
- `kiwoom-rankings-safe`를 legacy Kiwoom router보다 먼저 등록하는 fallback 계약
- 최신 main의 인증·capability 순서 전체

PR #76에서 유지할 책임:

- `market-information` router import
- `/market-information/coins-spot`의 `canAccessSpot` 검사
- `/market-information/coins-futures`의 `canAccessFutures` 검사
- `/market-information`의 `canAccessBasicInfo` 검사와 읽기 전용 router 연결

운영배포 후 해결 원칙:

1. 최신 main 파일을 기준으로 유지한다.
2. private 경로 차단 직후, 기존 crypto capability 등록 전에 PR #76의 정보방 capability와 router만 추가한다.
3. main의 scanner·safe Kiwoom route를 삭제하거나 순서를 낮추지 않는다.
4. 정보방 router를 legacy crypto router 내부에 중복 등록하지 않는다.
5. private/account/order router를 정보방 코드에서 import하지 않는다.

삭제할 중복:

- 동일 `/market-information` router 중복 등록
- PR #76 책임 밖의 scanner·Kiwoom 변경
- private exchange 경로와 겹치는 정보방 우회 경로

예상 테스트 영향:

- API route smoke 전체
- capability별 401/403
- safe Kiwoom·scanner route 우선순위
- private/order 요청 0 검증

### `api-server/test.mjs`

main에서 유지할 책임:

- 최신 trade automation, recovery, split order, scanner, safe Kiwoom 테스트 목록
- 기존 `phase12`, `smoke`, `unit`, `all` 조합
- 최신 테스트 실행 순서와 허용 mode

PR #76에서 유지할 책임:

- `src/services/market-information.service.test.ts`
- `stock-analyzer/src/lib/market-information.test.ts`
- `src/routes/market-information.smoke.test.ts`

운영배포 후 해결 원칙:

1. 최신 main의 `test.mjs`를 기준으로 유지한다.
2. 정보방 service와 frontend contract 테스트를 `phase12` 배열에 추가한다.
3. 정보방 route smoke 테스트를 `smoke` 배열에 추가한다.
4. main의 기존 항목을 PR #76의 오래된 배열로 덮어쓰지 않는다.
5. 중복 경로가 없는지 확인한 뒤 `all`, `phase12`, `smoke`를 각각 실행한다.

삭제할 중복:

- 같은 정보방 테스트 경로의 중복 항목
- main에서 이동·대체된 이전 테스트 경로

예상 테스트 영향:

- backend 전체 회귀 수행 시간 증가
- 누락 파일 또는 중복 실행 시 CI 실패 가능

## 통합 때 재확인할 파일

### `stock-analyzer/src/App.tsx`

현재 main과의 직접 교집합에는 없지만 PR #58·#61 통합 후 route 영역이 변경될 수 있다.

유지할 PR #76 코드:

- `/stocks/kr`
- `/stocks/us`
- `/coins/spot`
- `/coins/futures`
- `canAccessBasicInfo`, `canAccessSpot`, `canAccessFutures`별 접근 wrapper

유지할 최신 main 코드:

- 최신 router 순서와 기존 직접 route
- 인증·승인·capability gate
- lazy loading과 fallback

삭제할 중복:

- PR #61이 소유하는 전역 메뉴·breadcrumb·활성 상태 구현
- PR #58이 소유하는 통합검색 route 생성 로직

### `stock-analyzer/playwright.config.ts`

PR #76의 E2E Supabase 공개 fixture 환경변수는 유지하되, 운영배포 후 최신 main의 webServer 명령과 환경변수를 기준으로 합친다. 기존 Phase E2E 플래그는 제거하지 않는다.

## PR #58 읽기 전용 interface

UI/UX 작업방에서는 PR #58 코드를 수정하지 않는다. PR #61·#76이 소비할 최소 계약은 다음과 같다.

주식 상세 이동:

```text
/stock-info?asset=stock&market=<KR|US>&ticker=<ticker>
```

코인 상세 이동:

```text
/stock-info?asset=coin&coinMarket=<spot|futures>&symbol=<symbol>
```

식별자 규칙:

- 국내주식: `market=KR`, 종목코드 `ticker`
- 미국주식: `market=US`, 대문자 ticker
- Upbit 현물: `coinMarket=spot`, 현물 symbol
- Bitget 선물: `coinMarket=futures`, 선물 symbol
- 현물과 선물은 기초자산 이름이 같아도 시장·거래소·상품 식별자를 분리한다.

PR #76의 `marketInformationDetailPath`는 위 계약만 소비하며 검색 인덱스·별칭·autocomplete를 구현하지 않는다.

## Application CI 실행 조건 조사

PR #76 브랜치의 `.github/workflows/futures-public-network-smoke.yml` 확인 결과:

- `workflow_dispatch`: 지원
- `pull_request`: main 대상
- `push`: main 브랜치만 대상이며 기능 브랜치 push는 실행하지 않음
- path filter: pull_request에는 없음
- Draft PR 제외 조건: 없음
- concurrency: 동일 PR/ref의 이전 실행을 취소할 수 있음
- workflow syntax 오류: 정적 확인에서 없음
- 충돌로 PR merge ref가 생성되지 않으면 pull_request 실행이 생성되지 않을 수 있음

Application CI의 browser job은 `pnpm --dir stock-analyzer run test:e2e`를 실행하고, 해당 script는 Playwright 설정의 `e2e` 디렉터리 전체를 검사한다. 따라서 기존 `e2e/market-information-room.spec.ts`는 원래부터 CI 대상이며 파일명 변경은 필요하지 않다. 이번 작업에서는 기존 파일명을 유지하고 별도 `e2e/phase12-market-information-room-edge-cases.spec.ts`만 추가했다.

현재 연결된 GitHub 도구에는 workflow_dispatch 실행 함수가 노출되지 않았고, 저장소에는 기능 브랜치용 dispatch bridge가 없다. main 전용 fallback은 기능 브랜치 실행을 명시적으로 거부한다. workflow·Agent Hub 정책·worker registry를 수정하거나 임시 브랜치/PR을 만드는 우회는 하지 않는다.

## 운영배포 후 통합 절차

1. 실제 운영배포 main SHA 확인
2. PR #56 통합 완료 확인
3. PR #58 통합 완료 확인
4. PR #76에 최신 main 일반 2-parent merge
5. 위 충돌 파일을 main 우선 원칙으로 해결하고 정보방 변경만 추가
6. frontend/backend typecheck
7. 단위·전체 회귀·frontend/backend production build
8. Desktop·Mobile Playwright와 360/390/430px 검증
9. console/page/unhandled 오류 0, 예상 밖 HTTP 오류 0, 주문성 mutation 0 확인
10. 정확한 PR #76 HEAD에서 Application CI 필수 상태 6/6 확인
11. PR #76 하나의 병합 승인 요청

## 현재 안전 확인

- 실제 merge 수행: 0
- main 변경: 0
- 배포 workflow 변경: 0
- 운영 설정 변경: 0
- DB/Secret/서버 변경: 0
- private API 호출: 0
- 실제 주문·취소: 0

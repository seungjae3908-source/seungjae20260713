# PR #76 Production main 확정 전 통합 준비 자료

기준일: 2026-08-08

## 현재 사실

- 저장소: `seungjae3908-source/seungjae20260713`
- 현재 확인 main: `128beab907393af3d06475129df724090de63331`
- merge base: `c650fbb6eefe6dd728a9e1baaabe65eef2688caa`
- 현재 PR #76 HEAD: `8397f816737c4306d7f816314d26f08def053d31`
- 브랜치: `audit/market-information-room-improvements`
- 현재 main 기준: ahead 28 / behind 46 / diverged
- PR 상태: Open / Draft / 미병합 / mergeable=false
- 최신 main merge/rebase/cherry-pick/force push: **0회**
- main 직접 변경: **0회**
- Staging/Production/운영 DB/Supabase/Secret/서버 변경: **0회**

서버·Production 작업이 끝나 실제 Production main SHA가 확정될 때까지 최신 main을 반복 병합하지 않는다. 이 문서는 현재 main과 PR #76의 책임 경계 및 향후 한 번의 재동기화를 준비하기 위한 기록이다.

## 책임 경계

PR #76이 소유하는 범위:

- `/stocks/kr` 국내주식 정보방
- `/stocks/us` 미국주식 정보방
- `/coins/spot` Upbit 현물 정보방
- `/coins/futures` Bitget 선물 공개 시장정보방
- 읽기 전용 공개 시장데이터 계약
- 정보방 전용 source/dataAsOf/stale/partial/error/empty UI
- 정보방 전용 Abort/race 처리와 테스트

PR #76이 소유하지 않는 범위:

- PR #58 통합검색·autocomplete·검색 alias·검색 normalization
- PR #61 전역 메뉴·breadcrumb·활성 상태·포커스
- AI scanner·차트 엔진·자동매매·실주문
- 운영 배포·DB·Secret·서버

PR #76의 상세 이동은 기존 `/stock-info` 계약만 소비하며 검색 인덱스나 autocomplete를 재구현하지 않는다.

## 현재 main과 겹치는 공통 조립 파일

현재 merge base 이후 main 변경과 PR #76 변경의 실제 교집합은 다음 두 공통 조립 파일이다.

### `api-server/src/routes/index.ts`

현재 main에서 반드시 보존할 계약:

- `/market/scan` bounded scanner 우선 등록
- `/scanner/crypto` 인증·capability 보호 등록
- private 계좌·포지션·주문 경로 선행 차단
- `kiwoom-rankings-safe`를 legacy Kiwoom router보다 먼저 등록
- 최신 인증·capability 순서

PR #76에서 추가할 계약:

- `market-information` router import
- `/market-information/coins-spot` → `canAccessSpot`
- `/market-information/coins-futures` → `canAccessFutures`
- `/market-information` → `canAccessBasicInfo` + read-only router

현재 브랜치 파일은 main을 병합하지 않고 `db82ee7e3458d14f175f1fb1f001b2af22689911` 시점의 최신 scanner/safe-Kiwoom 조립 계약을 보존한 뒤 위 시장정보 연결만 최소 추가하도록 정리했다. 이후 main `128beab...`의 추가 커밋은 fallback CI provenance workflow만 수정했으므로 이 route 조립 계약에는 새 교집합이 없다.

Production main 확정 후에는 확정 main 파일을 다시 기준으로 삼아 이 시장정보 연결만 최소 재적용한다.

### `api-server/test.mjs`

현재 main에서 반드시 보존할 계약:

- 최신 scanner 테스트
- paper journal privilege/query identity 테스트
- trade automation recovery/cancel/split/pre-submission 테스트
- safe Kiwoom 테스트
- phase9 직렬 실행 계약
- 기존 `phase12`, `smoke`, `unit`, `all` 조합

PR #76에서 추가할 테스트:

- `src/services/market-information.service.test.ts`
- `src/services/public-market-http.test.ts`
- `stock-analyzer/src/lib/market-information.test.ts`
- `src/routes/market-information.smoke.test.ts`

현재 브랜치는 main의 확장된 테스트 matrix를 보존하고 정보방 테스트만 추가하도록 정리했다. Production main 확정 후 동일 원칙으로 재대조한다.

## 정보방 전용 파일

현재 PR #76의 변경 파일은 17개이며, 공통 조립 파일 2개를 제외한 시장정보 핵심 파일은 다음과 같다.

- `api-server/src/routes/market-information.smoke.test.ts`
- `api-server/src/routes/market-information.ts`
- `api-server/src/services/market-information.contract.ts`
- `api-server/src/services/market-information.service.test.ts`
- `api-server/src/services/market-information.service.ts`
- `api-server/src/services/public-market-http.test.ts`
- `api-server/src/services/public-market-http.ts`
- `stock-analyzer/e2e/market-information-room.spec.ts`
- `stock-analyzer/e2e/phase12-market-information-room-edge-cases.spec.ts`
- `stock-analyzer/src/lib/market-information.test.ts`
- `stock-analyzer/src/lib/market-information.ts`
- `stock-analyzer/src/pages/market-information.tsx`

추가 조립/설정 파일:

- `stock-analyzer/src/App.tsx`
- `stock-analyzer/playwright.config.ts`
- 이 문서

`stock-analyzer/src/App.tsx`와 `stock-analyzer/playwright.config.ts`는 현재 merge base 이후 main 변경과 직접 교집합이 없지만 Production main 확정 시 다시 대조한다.

## 네 시장 route와 capability 계약

- `/stocks/kr` → `stocks-kr` → `canAccessBasicInfo`
- `/stocks/us` → `stocks-us` → `canAccessBasicInfo`
- `/coins/spot` → `coins-spot` → `canAccessSpot`
- `/coins/futures` → `coins-futures` → `canAccessFutures`

백엔드 `/api/market-information/:room`은 알려진 네 room만 허용하고, 요청 취소를 AbortSignal로 service/provider 계층까지 전달한다.

## 공개 시장데이터 전용 정책

외부 직접 HTTP allowlist:

- Upbit: `/v1/market/all`, `/v1/ticker`
- Bitget: `/api/v2/mix/market/*`, `/api/v3/market/*`

계좌·잔고·포지션·주문·취소 endpoint는 allowlist에 포함하지 않는다. 응답의 `requestPolicy`도 private/account/balance/position/order/cancel/AI request count가 모두 0이어야 하며 frontend parser가 non-zero 값을 fail-closed 처리한다.

## 오류·신선도 계약

현재 구현 및 테스트가 고정하는 상태:

- empty body / invalid JSON / primitive / empty object 거부
- 429와 500/502/503/504는 제한된 1회 retry
- 403은 retry하지 않음
- caller Abort와 provider timeout을 구분
- fresh / stale / last-good fallback
- section 단위 ready / empty / partial / stale / unsupported / unavailable / error
- 401 인증 만료, 403 capability 부족, 504 timeout 별도 UI
- providerUpdatedAt/observedAt/fetchedAt와 stale/partial 표시

## Abort/race 보강

기존 cold cache load가 동일 key의 `inFlight` Promise를 공유할 때 첫 요청의 AbortSignal이 loader에 캡처되어 있으면, 첫 route 전환 취소가 두 번째 정상 요청까지 함께 실패시킬 수 있었다.

현재 수정:

- fresh cache hit는 그대로 재사용
- stale 데이터는 즉시 반환하고 background refresh만 `inFlight`로 중복 억제
- **cold load는 요청별 loader를 독립 실행**하여 한 요청의 취소가 다른 요청으로 전파되지 않게 함
- refresh 실패 시 기존 last-good 값을 stale로 반환하는 계약 유지

`public-market-http.test.ts`에 다음 회귀를 추가했다.

- 동일 key concurrent cold load에서 첫 요청 abort 후 두 번째 요청 독립 성공
- 두 번째 성공값이 fresh cache에 저장됨
- cold refresh 실패 시 last-good stale fallback

Frontend E2E도 빠른 KR→US 이동에서 늦은 KR 응답이 US 화면을 덮어쓰지 않는 계약을 검증한다.

## 브라우저 검증 계약

`market-information-room.spec.ts`:

- 네 직접 route
- reload / history
- source metadata
- 공개 데이터 전용 요청
- 빠른 KR→US 전환과 이전 응답 격리
- partial / stale / unsupported / 429 / provider error
- 360 / 390 / 430 / 1440 폭
- 가로 overflow 방지
- 최소 44px 주요 터치 target
- console/page/request/unexpected HTTP/private-order 요청 계측

`phase12-market-information-room-edge-cases.spec.ts`:

- explicit empty state
- 401 인증 만료
- 403 권한 부족
- 504 provider timeout
- console error 0
- page error 0
- unhandled rejection 0
- unexpected HTTP error 0
- private/account/balance/position/order/cancel/trade-automation request 0

## exact-HEAD 실행 검증 상태

현재 HEAD `8397f816737c4306d7f816314d26f08def053d31`은 PR conflict 상태이므로 pull_request merge ref 기반 Application CI run이 생성되지 않았다.

현재 연결된 GitHub 기능에는 기능 브랜치를 대상으로 새 `workflow_dispatch`를 시작하는 action이 없고, Agent Hub worker registry는 `audit/*` 브랜치를 허용하지 않는다. 정책·workflow·worker registry 변경, 임시 validation PR, no-op commit 같은 우회는 하지 않는다.

따라서 현 시점에는 source/test contract 정적 대조와 브랜치 코드 보강까지 완료했으며, **현재 exact HEAD의 typecheck/build/Playwright/Application CI 성공을 아직 주장하지 않는다.**

## Production main 확정 후 한 번 수행할 통합 절차

1. 실제 Production main SHA 확인
2. 그 확정 SHA를 PR #76에 비강제 방식으로 한 번 재동기화
3. 공통 조립 파일은 최신 main 우선, 시장정보 연결·테스트 항목만 최소 적용
4. PR #58 통합검색 구현을 가져오거나 재구현하지 않았는지 diff 확인
5. `git diff --check`
6. frontend/backend typecheck
7. lint 및 시장정보 단위/API/backend regression
8. frontend/backend build
9. desktop/mobile/전체 관련 Playwright
10. console/page/unhandled 0, unexpected HTTP 0, private/order API 0 확인
11. exact-HEAD Application CI 필수 상태 6/6 확인
12. Draft 상태에서 통합 준비 결과만 보고

## 안전 확인

- main 변경: 0
- main 병합: 0
- Ready for review: 0
- Staging/Production 실행: 0
- 운영 DB/Supabase/Secret 변경: 0
- 서버/PM2/Caddy 변경: 0
- private account/order API 호출: 0
- 실제 주문·취소: 0

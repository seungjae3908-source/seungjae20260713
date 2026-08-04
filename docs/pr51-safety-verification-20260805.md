# PR #51 최신 main 통합 및 자동매매 안전검증

기준일: 2026-08-05 (Asia/Seoul)

이 문서는 PR #51 브랜치에서 수행한 최신 main 일반 merge, 관리자 전용 권한, DB 원자성 migration 분리, 거래소 불완전 응답 처리, 복구 무재전송 계약과 CI 검증 범위를 기록한다.

## 범위

- 대상 브랜치: `agent/auto-trading-optimization-guardrails`
- 통합한 main: `c650fbb6eefe6dd728a9e1baaabe65eef2688caa`
- 일반 2-parent merge commit: `63e542b98544583a4ee8d8e0658627d4dfe5be4e`
- rebase, force push, cherry-pick 없음
- main 직접 수정, PR #51 병합, Ready 전환, 배포 없음

## 충돌 해결

실제 충돌 교집합은 다음 세 파일이었다.

- `stock-analyzer/src/App.tsx`
- `api-server/src/routes/index.ts`
- `api-server/test.mjs`

해결 원칙:

- main의 scanner readiness, query abort bridge, 인증·세션 경로, 신규 테스트를 보존했다.
- `/auto-trading`은 `canManageMembers` 전용 `AutoTradingAccess`를 유지했다.
- backend는 `requireAuthenticated` 이후 `requireAdmin`을 적용했다.
- main과 PR #51의 테스트 그룹을 모두 유지하고 조건부 skip을 추가하지 않았다.

## DB migration

기존 `2026080301_trade_automation_integration` forward/down 파일은 main 원본으로 복원했다.

새 순방향 migration:

- `2026080402_trade_order_atomic_execution.sql`
- `2026080402_trade_order_atomic_execution.down.sql`

계약:

- execution claim 열만 추가한다.
- `SECURITY INVOKER`와 고정 search path의 원자적 RPC를 추가한다.
- 관리자이며 `auth.uid() = user_id`인 본인 데이터만 처리한다.
- plan 전환, order insert, event insert, execution claim을 하나의 transaction으로 처리한다.
- 중복 호출은 order/event/claim을 다시 만들지 않는다.
- down은 새 RPC·권한·열만 제거하고 기존 테이블·데이터를 삭제하지 않는다.

CI의 disposable PostgreSQL에서 apply, 이중 apply, 실제 두 세션 race, rollback, rollback scope, reapply를 검증한다. 실제 Supabase나 운영 DB에는 적용하지 않는다.

## 거래소 불완전 응답

주문 POST가 시작된 후 다음 결과는 `RECOVERY_REQUIRED`로 fail-closed 처리한다.

- timeout, network TypeError, DNS/socket/connection reset
- HTTP 500/502/503/504
- 빈 응답, JSON parse 실패, primitive payload
- Bitget 성공 코드 또는 식별자 누락
- Upbit uuid 및 exact identifier 누락
- Kiwoom 응답 코드 또는 정확한 주문번호 누락
- 주문 응답 후 상태 조회 실패

자동 재전송은 하지 않는다. 복구는 Bitget exact `clientOid`, Upbit exact `identifier`, Kiwoom exact order number만 사용한다. Kiwoom 주문번호가 없으면 token 발급·상태 조회·재주문·취소를 모두 하지 않는다.

## 관리자 전용

- 정회원 메뉴에서 자동매매 항목 없음
- 직접 `/auto-trading` 접근 capability 차단
- 비관리자 설정 DOM 및 자동매매 API 요청 0
- API 직접 호출 시 `403 ADMIN_REQUIRED`
- regular, associate, pending RLS 접근 거부
- 관리자 A/B 상호 소유 데이터 격리
- production에서는 `VITE_PHASE12_E2E=true`가 아니면 fixture route 미등록

## 프로세스 장애

- claim 후 거래소 요청 전 재시작: 상태 조회만 수행, 주문 POST 0
- 거래소 응답 후 DB 저장 전 재시작: exact identifier 조회로 기존 주문 흡수, 주문 POST 0
- terminal order 재시작: 외부 요청 0
- process-local lock은 최적화이며 DB unique, row lock, transaction RPC가 최종 중복을 방어한다.

## CI 주의

Application CI Run `30937932149`에서 application, security, AI privacy, disposable DB, Bitget public smoke는 성공했다. browser job은 코드 테스트 전 Chromium 설치 단계가 장시간 정체되어 동일 소스 트리의 새 runner 검증을 발생시켰다. 설치 정체를 성공으로 간주하지 않으며 최종 HEAD의 필수 상태 6/6 success만 완료 근거로 사용한다.

## 안전 경계

이 작업에서 수행하지 않은 항목:

- main 직접 수정
- PR #51 또는 PR #52 병합
- Ready 전환
- 스테이징·운영 배포
- 실제 DB migration 적용
- Supabase·Secret·환경변수 변경
- 서버·SSH·PM2·Caddy 변경
- 거래소 인증 키 사용
- 실계좌·잔고·포지션 조회
- 실제 주문·취소
- live 실행 활성화

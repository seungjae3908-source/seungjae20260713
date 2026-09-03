# Phase 8 Release Candidate Hardening

## 상태와 안전 경계

Phase 8은 신규 대형 기능 단계가 아니라 완성형 베타 출시 전 검증·복구·권한 보완 단계다.

고정 안전 계약:

```text
orderSubmitted=false
exchangeRequestSent=false
externalAiCalled=false
```

이 단계에서는 운영 Supabase 프로젝트, 실제 사용자 데이터, 거래소 비공개 API, 실제 주문, 자동매매, 외부 AI API, 운영 환경변수와 운영 배포를 사용하지 않는다. `api-server/src/routes/crypto-auto.ts`는 변경하지 않으며 상위 라우터에서 실제 주문·비공개 계좌 경로를 먼저 차단한다.

## 실제 임시 DB 검증 방식

GitHub Actions `database-rls` job에서 `postgres:16-alpine` service container를 생성한다. 연결 정보는 CI 전용이며 운영 Supabase URL이나 키를 사용하지 않는다. 검증 스크립트는 연결 URL을 출력하지 않고 `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`를 사용한다.

검증 순서:

1. `phase8_auth_harness.sql`로 임시 `auth.users`, `auth.uid()`, `authenticated`, `anon`, 레거시 `profiles`를 만든다.
2. Phase 7 paper-journal migration을 실제 적용한다.
3. Phase 8 회원 4등급 migration을 실제 적용한다.
4. Phase 8 paper capability RLS overlay를 실제 적용한다.
5. 세 migration을 재실행해 idempotent DDL 동작을 확인한다.
6. SQL 세션 role과 JWT subject claim을 바꿔 소유권 및 등급 RLS CRUD를 실행한다.
7. 의도적인 transaction 실패 후 부분 객체가 남지 않는지 확인한다.
8. capability overlay, 회원 migration, Phase 7 migration 순서로 rollback한다.
9. 잔여 테이블·컬럼·함수 부재를 확인한다.
10. 세 migration을 다시 적용하고 RLS를 재검증한다.

운영 DB에는 migration을 적용하지 않는다.

## Migration apply·rollback

Phase 7 paper storage:

```text
api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql
api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.down.sql
```

Phase 8 member permissions:

```text
api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql
api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.down.sql
```

Phase 8 paper capability RLS overlay:

```text
api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql
api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.down.sql
```

Phase 7 테이블:

- `paper_accounts`
- `paper_orders`
- `paper_positions`
- `paper_fills`
- `paper_journal_entries`
- `paper_sync_state`

모든 paper 테이블은 `(user_id, id)` 복합 기본키, 사용자·갱신시각 인덱스, `version`, `deleted_at`, `created_at`, `updated_at`을 갖는다.

Phase 8은 `profiles`에 `membership_level`, `is_active`, `permissions_updated_at`을 추가하고 `member_permission_audit`를 만든다. 기존 승인 사용자는 `regular`, 기존 승인 관리자는 `admin`, 나머지는 `pending`으로 호환 매핑한다.

Phase 7의 `auth.uid() = user_id` 소유권 정책만으로는 준회원이 Supabase를 직접 호출하는 우회를 막을 수 없다. 따라서 Phase 8 overlay는 6개 paper 테이블의 CRUD 정책에 다음 조건을 함께 요구한다.

```sql
auth.uid() = user_id
and public.current_membership_level() in ('regular', 'admin')
```

rollback 시에는 Phase 7의 소유권 전용 정책으로 복원한 뒤 회원 helper를 제거한다.

## 실제 RLS 통합 기준

### 정회원 사용자 A

- 자기 account 조회
- 자기 order 생성
- 자기 position 수정
- 자기 fill 삭제
- 자기 journal 조회
- 자기 sync state 변경

### 정회원 사용자 B

- A의 6개 테이블 행 조회 결과 0건
- A 행 update·delete 영향 0건
- A의 `user_id`를 넣은 insert가 RLS 오류
- 동일 record ID를 B 소유 범위에서 생성 가능

### 준회원

- 유효한 인증 subject와 자기 UUID를 사용해도 paper-table 조회 결과 0건
- 자기 account insert 차단
- paper row update·delete 차단
- API 가드뿐 아니라 직접 Supabase CRUD도 차단

### 승인대기

- 유효한 인증 subject가 있어도 paper journal 조회·생성 차단

### 비로그인 `anon`

- 조회 결과 0건
- insert RLS 오류
- update·delete 영향 0건

### 관리자

- 회원 profile과 권한 감사 이력 접근 가능
- 자기 소유 paper 데이터는 regular 기능으로 사용 가능
- 다른 사용자의 paper journal과 원본 메모 조회 결과 0건
- 관리자에게 개인 거래기록 전체를 허용하는 정책 없음

## 회원 4등급과 권한 매트릭스

단일 소스:

```text
packages/member-access/src/index.js
```

| 기능 | pending | associate | regular | admin |
|---|---:|---:|---:|---:|
| 기본 정보 | 차단 | 허용 | 허용 | 허용 |
| 코인 현물 | 차단 | 허용 | 허용 | 허용 |
| 코인 선물 | 차단 | 차단 | 허용 | 허용 |
| 리스크 미리보기 | 차단 | 차단 | 허용 | 허용 |
| 백테스트 | 차단 | 차단 | 허용 | 허용 |
| 모의매매 | 차단 | 차단 | 허용 | 허용 |
| 거래일지 동기화 | 차단 | 차단 | 허용 | 허용 |
| 거래 분석 | 차단 | 차단 | 허용 | 허용 |
| 회원 관리 | 차단 | 차단 | 차단 | 허용 |

표시 이름:

```text
pending   = 일반회원 · 승인대기
associate = 준회원
regular   = 정회원
admin     = 관리자
```

서버는 매 요청마다 로그인 사용자와 현재 DB profile을 읽는다. 클라이언트 body, app metadata 또는 client role은 권한 근거가 아니다. 프런트는 포커스·탭 복귀와 30초 주기로 profile을 다시 읽어 등급 변경을 반영한다.

권한은 다음 위치에서 같은 매트릭스를 사용한다.

- 프런트 메뉴 표시
- 프런트 route guard와 직접 URL 접근
- 백엔드 API capability middleware
- paper-table DB RLS
- 관리자 변경 후 profile·session refresh

버튼만 숨기고 API 또는 DB 접근을 허용하지 않는다.

## 관리자 안전성

- 아이디·표시 이름 검색
- 회원 상세와 현재 등급·활성 상태
- pending 사용자의 준회원 승인
- 등급·활성 상태 변경 전 명시적 확인
- 3~500자 변경 사유 필수
- 대상 사용자, 관리자 ID, 변경 전·후 값, 사유, 시각 감사 기록
- 마지막 활성 관리자 등급 하향·비활성화 차단
- 감사 저장 실패 시 profile 변경을 이전 값으로 되돌리는 보상 처리
- 관리자 화면과 API에 개인 거래 메모·원본 paper 기록 조회 기능 없음

## 전체 통합 E2E

`/__phase8-release-candidate-e2e` fixture에서 다음 순서를 연결한다.

1. 회원 등급 선택
2. 선물 데이터 조회
3. 계약 규칙 조회
4. 리스크 미리보기
5. 백테스트
6. 모의주문
7. 부분청산
8. 전체청산
9. 거래일지 생성
10. 서버 동기화
11. 거래 분석
12. 개인정보 최소화 review dataset

각 단계에서 실제 주문과 외부 AI를 호출하지 않는다. pending, associate, regular, admin 흐름과 관리자 감사·마지막 관리자 보호, 동기화 실패 후 수동 재시도, 계정별 hashed namespace를 함께 검증한다.

viewport:

```text
1440×900
390×844
360×740
```

가로 스크롤, console error와 uncaught exception을 허용하지 않는다.

## 충돌·복구

- 동일 version·다른 payload는 양쪽 버전을 포함한 명시적 충돌
- tombstone과 수정이 같은 version이면 충돌
- 높은 version 우선
- 서버 시각보다 version 우선
- 사용자·idempotency key별 in-flight Promise 공유
- 500개 초과 요청의 batch별 고유 idempotency key
- 부분 실패는 성공·실패 항목 분리
- 오프라인과 실패 상태에서도 로컬 상태·tombstone 유지
- localStorage 손상 시 원문 backup 후 복구
- 네트워크 실패 후 무한 자동 재시도 없음
- 클라이언트 중단 후 같은 idempotency key 재전송 가능

## 장기 저장과 archive

활성 브라우저 거래일지는 최근 500개로 유지한다. 500개를 넘은 오래된 기록은 사용자별 hashed archive key로 이동하며 삭제하지 않는다.

```text
active:  seungjae.paper-trading.v2:<hashed namespace>
archive: seungjae.paper-journal-archive.v1:<hashed namespace>
```

- 다른 계정이 archive를 읽을 수 없음
- 전체 초기화 시에도 archive 자동 삭제 없음
- archive는 동기화 준비에 포함
- 500개 초과 요청은 클라이언트 API에서 500개 단위로 순차 배치
- 서버 repository는 종류별 500개 hard limit을 제거하고 range pagination으로 끝까지 조회
- 사용자의 명시적 export 전에 archive 자동 삭제 없음

archive 삭제 UI와 장기 cold-storage 이동은 이번 범위를 넘으므로 설계·warning과 데이터 보존까지만 구현한다.

## 부하 측정

CI는 각 작업의 실행시간과 heap 증감량을 `[phase8-performance]` JSON 로그로 남긴다. 환경에 따라 흔들리는 짧은 절대 기준 대신 15초 이상의 장시간 이벤트 루프 점유를 실패로 판정한다.

측정 대상:

- 거래 분석 100건
- 거래 분석 500건
- 동기화 100건
- 동기화 500건
- snapshot 5페이지
- 충돌 100건
- review dataset 500건

## 보안 검사

자동 검사:

- 프런트 production bundle의 서비스 역할 키 문자열
- `crypto-auto.ts` Git blob SHA 변경
- 실제 주문·비공개 계좌 경로가 crypto router보다 먼저 차단되는지
- Phase 8 민감 코드의 외부 AI endpoint
- review dataset의 이메일·메모·내부 ID 노출
- raw UUID localStorage key
- client `user_id`·role·actor 강제 주입
- SQL injection 형태 ID·payload
- XSS 메모
- oversized sync
- `__proto__`, `prototype`, `constructor`
- 잘못된 cursor와 conflict ID
- stack trace·Secret을 포함하지 않는 오류
- 준회원·승인대기 사용자의 직접 DB paper 접근

## CI

필수 상태:

```text
application-ci/verified
browser-ui/verified
database-rls/verified
security-integration/verified
```

실제 Bitget 공개 네트워크 smoke는 기존 `futures-public-network-smoke/verified` non-blocking 정책을 유지한다.

## Release Candidate 판정 기준

다음이 모두 참일 때만 리뷰 준비 상태로 전환한다.

- frozen lockfile 설치 성공
- 프런트·백엔드 타입검사 성공
- 기존 Phase 2~7 테스트 유지
- Phase 8 신규 테스트 성공
- API smoke 성공
- 세 migration의 실제 apply·idempotent rerun·rollback·reapply 성공
- 실제 RLS A/B/준회원/승인대기/비로그인/관리자 통합 성공
- 프런트 메뉴·route와 백엔드 API 권한 테스트 성공
- Playwright 전체 성공
- 보안·bundle 검사 성공
- 프런트·백엔드 production build 성공
- 실제 주문·비공개 거래소 API·외부 AI 호출 0회
- 운영 DB 적용과 운영 배포 0회

## 남은 미검증

최종 CI 결과와 함께 확정한다. 자동화 범위 밖으로 남길 수 있는 항목:

- 실제 운영 Supabase migration 적용 시간과 rollback
- 운영 데이터량에서의 lock·index 생성 시간
- 다중 서버 인스턴스 사이의 분산 idempotency lock
- 실제 모바일 소프트 키보드가 열린 viewport
- 실제 스크린리더 수동 감사
- 장기간 수만 건 cold-storage 정책

운영 DB와 운영 서버 검증은 이 PR에서 의도적으로 수행하지 않는다.

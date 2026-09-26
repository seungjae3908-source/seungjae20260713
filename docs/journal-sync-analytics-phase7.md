# Phase 7 — 사용자별 거래일지 동기화와 개인정보 최소화 분석

## 범위와 안전 계약

Phase 7은 Phase 6 모의매매 기록을 로그인 사용자별로 동기화하고, 외부 AI 호출 없이 규칙·통계 기반 분석과 복기 입력 JSON을 생성한다.

```text
sync mode = journal-sync-only
analysis mode = analysis-only
orderSubmitted = false
exchangeRequestSent = false
externalAiCalled = false
```

실제 주문, 자동매매, 거래소 비공개 API, 계좌 조회, 외부 AI 네트워크 요청, 운영 배포는 포함하지 않는다.

## 데이터 모델

migration 파일:

```text
api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql
```

이 migration은 코드 리뷰와 CI 정적 검증을 위해 작성했으며 이번 단계에서 운영 DB에 적용하지 않는다. 기존 `api-server/supabase/schema.sql`은 교체하지 않는다.

신규 테이블:

- `paper_accounts`
- `paper_orders`
- `paper_positions`
- `paper_fills`
- `paper_journal_entries`
- `paper_sync_state`

모든 사용자 소유 테이블은 다음 공통 필드를 갖는다.

```text
user_id uuid not null
id text not null
payload jsonb not null
version bigint not null
created_at timestamptz not null
updated_at timestamptz not null
deleted_at timestamptz null
primary key (user_id, id)
```

거래·주문·포지션 ID는 전역이 아니라 사용자 범위에서 유일하다. `paper_sync_state`는 idempotency 응답, 충돌과 장치 메타데이터를 사용자 범위로 보존한다.

## RLS 정책

6개 테이블 모두 Row Level Security를 활성화한다. 정책은 기존 포트폴리오 RLS 패턴을 재사용한다.

```sql
auth.uid() = user_id
```

사용자는 자신의 행만 조회·추가·수정·삭제할 수 있다. 관리자 개인 메모 열람 정책은 추가하지 않았다. 서버 라우트는 `requireMember` 뒤에 등록되며 `req.member.id`와 사용자 access token 기반 `getUserSupabase()`만 사용한다. 클라이언트가 요청에 넣은 `user_id` 또는 `userId`는 거부한다.

서비스 역할 키는 프런트에 전달하지 않으며 Phase 7에서 새 Secret이나 환경변수를 추가하지 않는다.

## 로컬·서버 동기화

기존 로컬 키는 삭제하거나 덮어쓰지 않는다.

```text
legacy: seungjae.paper-trading.v1
user state: seungjae.paper-trading.v2:<hashed-user-namespace>
sync metadata: seungjae.paper-journal-sync.v2:<hashed-user-namespace>
```

첫 로그인 사용자는 기존 v1 원본을 timestamp가 포함된 backup 키로 복사한 뒤 사용자 namespace로 마이그레이션한다. v1 원본은 유지한다. legacy owner marker를 기록해 같은 공용 브라우저의 다음 계정이 이전 계정의 v1 기록을 가져가지 못하게 한다. 사용자 UUID는 storage key에 원문으로 넣지 않고 결정론적 namespace hash를 사용한다.

동기화 레코드:

```text
kind
id
version
updatedAt
deletedAt
payload
```

동기화 정책:

- 서버에 ID가 없으면 기기 레코드를 업로드한다.
- 기기 version이 높으면 기기 레코드를 업로드한다.
- 서버 version이 높으면 서버 레코드를 다운로드한다.
- version과 내용이 같으면 unchanged로 처리한다.
- version이 같고 내용이 다르면 충돌을 생성하고 두 버전을 보존한다.
- 로컬에서 사라진 레코드는 version을 올린 tombstone으로 전송한다.
- 서버 성공 응답 전에는 로컬 기록이나 tombstone을 삭제하지 않는다.
- 일부 실패는 성공·실패 항목을 나누고 성공한 항목을 폐기하지 않는다.
- 같은 idempotency key 재전송은 저장된 응답을 반환한다.
- 서버 시각과 클라이언트 시각 차이가 5분을 초과하면 clock skew 경고를 반환한다.
- version이 시간보다 우선한다.

한 요청은 최대 500개 레코드, snapshot 페이지는 최대 100개로 제한한다. snapshot cursor는 opaque base64url 값이다.

## 충돌 정책

충돌은 자동으로 조용히 폐기하지 않는다. 사용자에게 다음 세 선택을 제공한다.

1. 서버 버전 유지
2. 이 기기 버전 유지
3. 둘 다 사본으로 보존

기기 버전 유지 시 서버와 기기 version 중 큰 값보다 1 높은 version으로 저장한다. 둘 다 보존 시 서버 원본은 유지하고 기기 레코드는 새 copy ID로 저장한다. 해결된 충돌은 다시 처리할 수 없다.

## 삭제 tombstone

로컬 레코드가 사라지면 빈 payload와 `deletedAt`을 가진 tombstone을 만든다. 같은 tombstone 재시도는 version을 계속 증가시키지 않는다. 서버가 더 높은 tombstone을 반환하면 해당 로컬 항목을 삭제한다. 전체 서버 데이터 삭제는 다음 확인 문자열이 정확히 일치해야 한다.

```text
DELETE MY PAPER JOURNAL
```

삭제 API도 로그인 사용자 소유 행에만 적용된다.

## 계정별 격리

- 사용자마다 별도 로컬 상태 key와 sync metadata key를 사용한다.
- 계정 UUID는 key에 원문으로 노출하지 않는다.
- 로그아웃·계정 전환 후 다른 계정의 local state를 자동 로드하지 않는다.
- 서버 repository는 모든 쿼리에 세션 사용자 ID를 적용한다.
- 요청 body의 사용자 ID를 신뢰하지 않는다.
- RLS가 다른 사용자의 조회·추가·수정·삭제를 차단한다.

## 오프라인 처리

네트워크가 없더라도 Phase 6 로컬 모의매매와 거래일지는 계속 사용할 수 있다. 동기화 버튼은 offline 상태와 재시도 가능 안내를 표시한다. 로컬 기록은 삭제하지 않으며 온라인 복구 후 사용자가 직접 다시 동기화할 수 있다. 무한 자동 재시도는 구현하지 않았다.

## API

인증 이후 등록된 경로:

```text
POST   /api/paper-journal/sync
GET    /api/paper-journal/snapshot
POST   /api/paper-journal/conflicts/:id/resolve
DELETE /api/paper-journal/all
GET    /api/paper-journal/analytics
POST   /api/paper-journal/review-dataset
```

동기화 응답:

```json
{
  "ok": true,
  "mode": "journal-sync-only",
  "orderSubmitted": false,
  "exchangeRequestSent": false
}
```

분석·복기 응답:

```json
{
  "ok": true,
  "mode": "analysis-only",
  "externalAiCalled": false,
  "result": {}
}
```

요청 body는 512 KiB로 제한한다. 예상하지 못한 오류는 일반화된 코드와 메시지로 반환하며 stack trace, DB 연결 문자열, Authorization, Secret을 응답하지 않는다.

## 분석 공식

분석 대상은 유효한 종료 거래만 사용한다. NaN·Infinity·잘못된 시각의 레코드는 제외한다.

```text
승률 = 이익 거래 수 / 전체 거래 수 × 100
기대값 = 순손익 합계 / 전체 거래 수
평균 R = 유효 R 합계 / 전체 거래 수
Profit Factor = 총 이익 / |총 손실|
비용 = 진입 수수료 + 종료 수수료 + 슬리피지 + 펀딩비
비용 비중 = 총 비용 / gross PnL 절대값 합계 × 100
규칙 위반률 = ruleViolation 거래 / 전체 거래 × 100
```

분석 그룹:

- 롱·숏
- 종목
- 전략
- UTC 시간대
- UTC 요일
- 종료 이유
- 데이터 상태
- 시장 상태
- 레버리지 구간
- 위험률 구간

표본 기준:

```text
기본 통계: 5건
행동 패턴: 10건
그룹 비교: 그룹별 10건
```

표본이 부족하면 승률·기대값·평균 R 등의 확정 값을 `null`로 반환하고 certainty를 `insufficient`로 표시한다.

## 행동 패턴 후보 기준

확정 사실과 추정 후보를 구분한다.

확정:

- 종료 거래 수
- 손절가 없이 기록된 거래 수
- `ruleViolation=true` 거래 수
- 기록 warnings에 명시된 추격 진입
- 기록 warnings에 명시된 손절 확대

후보:

- 손실 종료 후 10분 이내 동일 종목 재진입
- 한 시간에 6건 이상 진입
- gross PnL은 양수지만 비용 후 net PnL이 0 이하인 거래

손절 변경 이력이 없는 경우 손절 확대를 추측하지 않고 `insufficient`로 표시한다.

## 개인정보 최소화와 AI 복기 입력 계약

Phase 7은 외부 AI를 호출하지 않는다. `review-dataset`은 서버 내부에서 구조화된 JSON만 생성한다.

기본 제외 필드:

- 이메일
- 이름
- 생년월일
- API Key
- Secret
- 실제 계좌번호
- 원본 사용자 메모
- 내부 DB UUID
- 전체 주문 원문

대표 거래 ID는 내부 ID를 SHA-256 기반 16자리 익명 ID로 변환한다. 대표 거래는 최대 12건이며 방향, 전략, 위험률, R, 순손익률, 종료 이유, 규칙 위반 요약만 포함한다.

```ts
export type TradingReviewDataset = {
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  aggregateMetrics: Record<string, unknown>;
  behaviorSignals: BehaviorSignal[];
  strategyMetrics: AnalyticsMetricGroup[];
  symbolMetrics: AnalyticsMetricGroup[];
  timeMetrics: AnalyticsMetricGroup[];
  representativeTrades: Array<{
    anonymizedId: string;
    side: "long" | "short";
    strategy: string | null;
    riskPercent: number | null;
    rMultiple: number | null;
    netPnlPercent: number | null;
    exitReason: string;
    ruleViolations: string[];
  }>;
  excludedFields: string[];
  warnings: string[];
};
```

UI 안내:

```text
현재 단계에서는 거래기록을 외부 AI로 전송하지 않습니다.
개인정보를 제외한 구조화된 복기 데이터만 준비합니다.
```

## UI

기존 `/paper-trading` 화면과 하단 내비게이션을 재작성하지 않는다. 기존 모의매매 화면 위에 `동기화·분석` 오버레이를 추가한다.

- 동기화 상태
- 마지막 동기화 시각
- 업로드·다운로드 수
- 실패·충돌 수
- offline 안내
- 세 가지 충돌 해결 선택
- 기간 선택
- 총 거래·순손익·승률·기대값·평균 R·비용·규칙 위반
- 전략·종목·시간대 그룹
- 확정 사실과 행동 후보
- 표본 부족 안내
- 개인정보 최소화 복기 데이터 준비 상태

## 테스트

Phase 7 테스트는 다음을 포함한다.

- sync 입력 검증과 요청 user ID 거부
- Secret 유사 키 거부
- 신규 업로드와 서버 다운로드
- 높은 version 우선
- 같은 version 충돌
- tombstone
- idempotency
- 부분 실패
- clock skew
- 세 가지 충돌 해결
- 사용자 간 conflict·snapshot·delete 격리
- v1 원본·backup 보존
- 사용자별 namespace
- 계정 전환 격리
- 손상 metadata 복구
- version 재시도 안정성
- 승률·기대값·평균 R·Profit Factor
- 전략·종목·시간·요일·데이터·시장·레버리지·위험률 그룹
- 손절·목표 준수와 규칙 위반
- 재진입·과도한 거래·추격·손절 확대·비용 후보
- 표본 부족
- NaN·Infinity 차단
- 이메일·메모·내부 ID 제외
- 익명 ID
- `externalAiCalled=false`
- API 요청 제한과 안전 응답
- 외부 AI·거래소 네트워크 호출 0회
- 데스크톱·390px·360px
- offline·성공·실패·충돌·분석·표본 부족·계정 전환
- 가로 스크롤·console error 검사

기존 Phase 2~6 테스트와 Playwright 검증을 모두 유지한다.

## migration 미적용

이번 PR은 migration SQL 파일과 정적 SQL/RLS 테스트만 추가한다. 운영 Supabase DB에는 적용하지 않는다. 실제 DB 적용·rollback·대용량 데이터 migration 시간은 미검증이다.

## 미검증 항목

- 실제 운영 Supabase에 migration 적용 및 rollback
- 실제 RLS 통합 테스트용 임시 PostgreSQL/Supabase 인스턴스
- 다중 기기에서 같은 millisecond에 동시에 수정하는 장기 부하
- 500개를 초과하는 장기간 데이터의 archive 정책
- 실제 모바일 소프트 키보드가 열린 viewport
- 실제 스크린리더 수동 감사
- 외부 AI 품질과 프롬프트 설계 — 이번 단계는 외부 AI를 호출하지 않음

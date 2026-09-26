# Phase 9 개인정보 최소화 AI 거래 복기

과거 모의거래를 학습 목적으로 복기한다. 실제 주문·자동매매·미래 수익 보장·확정 추천과 분리되며 운영 DB migration 및 운영 배포를 수행하지 않는다.

## 동의와 호출 상태

`POST /api/paper-journal/ai-review/preview`는 서버가 Phase 7 `TradingReviewDataset`을 재생성해 실제 전송 payload, 포함·제외 필드와 경고를 보여준다. 사용자가 매번 체크박스로 명시적으로 동의한 뒤 generate를 직접 눌러야 provider가 호출된다. 페이지 진입·로그인·동기화·거래 종료·스케줄에서는 호출하지 않는다.

모든 응답은 `providerCall={attempted,completed,reused}`를 제공한다. 동의·권한·검증·provider 설정 단계에서 차단되면 attempted=false다. 실제 요청 시작 후 429·5xx·timeout·JSON·출력 검증 실패는 attempted=true, completed=false다. 안전 검증까지 성공해야 completed=true다. 성공 결과나 진행 중 Promise를 재사용한 현재 요청은 attempted=false, reused=true다. `externalAiCalled`는 해당 요청의 attempted와 항상 일치한다. `orderSubmitted=false`, `exchangeRequestSent=false` 계약을 유지한다.

## Provider, Secret과 환경설정

라우트는 `TradingReviewProvider` interface에만 의존한다. Secret은 서버 환경의 `TRADING_REVIEW_PROVIDER`, `TRADING_REVIEW_API_KEY`, `TRADING_REVIEW_MODEL`, `TRADING_REVIEW_TIMEOUT_MS`, `TRADING_REVIEW_DAILY_LIMIT`에서만 읽는다. timeout은 1,000~30,000ms, 하루 제한은 1~10의 안전한 정수만 허용한다. 미설정·NaN·Infinity·음수·소수·범위 밖 값은 각각 30,000ms와 10회의 기본값을 사용한다.

실제 값이나 `.env`는 저장소에 넣지 않는다. 설정이 없으면 기존 앱은 정상 시작하고 생성 API만 `AI_REVIEW_PROVIDER_UNAVAILABLE`로 안전하게 실패한다. 프런트·응답·로그·artifact에는 환경변수 값, Secret, Authorization, 전체 요청 payload와 provider 원문 응답을 남기지 않는다.

## 개인정보와 출력 방어

전송 데이터는 기간·표본·서버 계산 집계·행동 신호·그룹 통계·익명 대표 거래 ID로 제한한다. 이름, 이메일, 생년월일, 전화번호, 사용자/DB UUID, 실제 계좌, API Key·Secret·Token·Authorization, 원본 메모, 전체 주문 원문, 브라우저 키, IP, 세션, 실제 잔고와 거래소 계좌는 제외한다. 서버가 payload를 재순회해 금지 키와 Secret 형태를 차단한다.

모든 출력 문자열은 Unicode NFKC 정규화, 제로폭 문자 제거, HTML 태그 문자 제거, 연속 공백 축약과 대소문자 독립 검사를 거친다. 구조화 JSON으로 검증하며 HTML로 렌더링하거나 `dangerouslySetInnerHTML`을 사용하지 않는다. 한국어·영어 매수/매도 명령, 확정 수익, 손실 복구 레버리지 확대, 입출금·송금, URL 방문, 도구 호출, 코드 실행, 시스템 프롬프트와 API Key·Secret·Token 요청을 모든 텍스트 필드에서 거부한다. evidence ID는 서버 발급 익명 ID만 허용한다.

거래 수, 순손익, 승률, 기대값, 평균 R, Profit Factor, 총비용, 손절 준수율과 규칙 위반률의 원본은 Phase 7 분석 엔진이다. AI는 한국어와 영어로 이 핵심 수치를 재서술할 수 없다.

## Idempotency와 프로세스 로컬 제한

호출 시도 기록과 idempotency 캐시는 분리한다. 성공 결과와 진행 중 Promise만 10분 TTL 동안 재사용하며 실패 entry는 제거해 같은 key 재시도를 허용한다. 실패한 실제 호출도 시간·일일 시도 횟수에는 남는다. 서로 다른 key의 동시 요청은 차단하고 사용자별 상태를 격리한다. 모든 사용자 map은 요청마다 만료 정리한다.

기간 최대 90일, 대표 거래 12개, 동시 실행 1개, 시간당 3회, 하루 기본 10회, timeout 기본 30초, 자동 재시도 없음이다. 응답은 `rateLimitScope="process"`를 명시한다.

현재 rate limit, concurrency, idempotency 캐시는 단일 서버 프로세스 범위다. 서버 재시작 또는 다중 인스턴스 전체를 통합하는 전역 제한은 아니다. 운영 DB migration이나 Redis 기반 전역 제한은 이번 Phase에 추가하지 않는다.

## 권한과 저장

`canAccessAiTradingReview`는 regular/admin 자기 데이터에만 허용한다. pending, associate, 비로그인, 비활성 사용자는 프런트 capability와 백엔드에서 차단된다. 관리자가 다른 사용자 복기를 생성하는 경로는 없다.

결과는 기본적으로 저장하지 않는다. 사용자가 선택한 경우에만 사용자별 hashed namespace, schema v1, 최대 10개로 브라우저에 저장하며 provider 요청 payload와 request ID를 보존하지 않는다. 복원, JSON export, 명시적 삭제, 계정 전환 격리와 손상 데이터 복구를 제공한다.

## 테스트와 CI

Phase 2~8 검증을 유지하고 Phase 9 호출 상태, 권한, 최소화, 환경설정, timeout/429/5xx, 잘못된 JSON, 실패 캐시 제거, TTL, 사용자 격리, Unicode 우회, 모든 출력 필드, API 계약과 로컬 저장을 검증한다. Playwright는 1440×900, 390×844, 360×740을 확인한다.

`ai-privacy/verified`는 실제 AI key 없이 injected mock provider만 사용한다. 테스트 network guard가 `fetch`, `http.request`, `https.request`의 외부 AI host를 전송 전에 차단하고 예상하지 않은 시도 0회를 assertion한다. 로컬 테스트 서버는 허용하며 Bitget 공개 smoke는 별도 non-blocking job으로 유지한다. 실제 주문 0회, 비공개 거래소 호출 0회, 프런트 Secret 0개도 확인한다.

제한: provider가 설정되지 않은 환경에서는 미리보기와 기존 분석은 가능하지만 AI 생성은 불가능하다. 결과는 학습용이며 투자 조언이 아니다.

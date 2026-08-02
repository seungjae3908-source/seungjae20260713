# Phase 9 개인정보 최소화 AI 거래 복기

과거 모의거래를 학습 목적으로 복기한다. 실제 주문·자동매매·미래 수익 보장·확정 추천과 분리되며 운영 DB migration 및 운영 배포를 수행하지 않는다.

## 동의와 흐름

`POST /api/paper-journal/ai-review/preview`는 서버가 Phase 7 `TradingReviewDataset`을 재생성해 실제 전송 payload, 포함·제외 필드와 경고를 보여준다. 이 단계의 `externalAiCalled=false`다. 사용자가 매번 체크박스로 명시적으로 동의한 뒤 `POST /api/paper-journal/ai-review/generate`를 직접 눌러야 provider가 호출된다. 페이지 진입·로그인·동기화·거래 종료·스케줄에서는 호출하지 않는다.

## Provider와 Secret

라우트는 `TradingReviewProvider` interface에만 의존한다. Secret은 서버 환경의 `TRADING_REVIEW_PROVIDER`, `TRADING_REVIEW_API_KEY`, `TRADING_REVIEW_MODEL`, `TRADING_REVIEW_TIMEOUT_MS`, `TRADING_REVIEW_DAILY_LIMIT`에서만 읽는다. 실제 값이나 `.env`는 저장소에 넣지 않는다. 설정이 없으면 기존 앱은 정상 시작하고 생성 API만 `AI_REVIEW_PROVIDER_UNAVAILABLE`로 안전하게 실패한다. 프런트·응답·로그·artifact에는 Secret과 전체 payload를 남기지 않는다.

## 개인정보 최소화와 방어

전송 데이터는 기간·표본·서버 계산 집계·행동 신호·그룹 통계·익명 대표 거래 ID로 제한한다. 이름, 이메일, 생년월일, 전화번호, 사용자/DB UUID, 실제 계좌, API Key·Secret·Token·Authorization, 원본 메모, 전체 주문 원문, 브라우저 키, IP, 세션, 실제 잔고와 거래소 계좌는 제외한다. 서버가 payload를 재순회해 금지 키와 Secret 형태를 차단한다.

시스템 지침은 입력 문자열을 명령이 아닌 데이터로 취급하고 URL·도구·코드 실행·주문·Secret 요청을 금지한다. 출력은 구조화 JSON으로 검증하며 HTML로 렌더링하지 않는다. 매수·매도 명령, 수익 보장, 손실 복구 레버리지 확대, 개인정보/API Key/입출금/시스템 프롬프트 요청은 거부한다. evidence ID는 서버가 발급한 익명 ID만 허용한다. 표본 부족은 `insufficient`로 유지한다.

## 수치 원본과 제한

거래 수, 순손익, 승률, 기대값, 평균 R, Profit Factor, 총비용, 손절 준수율과 규칙 위반률의 원본은 Phase 7 분석 엔진이다. AI는 계산 원본이 아니다. 기간 최대 90일, 대표 거래 12개, 동시 실행 1개, 시간당 3회, 하루 10회, timeout 30초, 자동 재시도 없음이 기본이다. idempotency key는 중복 외부 호출을 공유한다. 429·timeout·provider 오류는 구분하며 기존 거래일지를 변경하지 않는다.

## 권한과 저장

`canAccessAiTradingReview`는 regular/admin 자기 데이터에만 허용한다. pending, associate, 비로그인, 비활성 사용자는 프런트 capability와 백엔드에서 차단된다. 관리자가 다른 사용자 복기를 생성하는 경로는 없다.

결과는 기본적으로 저장하지 않는다. 사용자가 선택한 경우에만 사용자별 hashed namespace, schema v1, 최대 10개로 브라우저에 저장하며 provider 요청 payload와 request ID를 보존하지 않는다. 복원, JSON export, 명시적 삭제, 계정 전환 격리와 손상 데이터 복구를 제공한다.

## 테스트와 CI

Phase 2~8 검증을 유지하고 Phase 9 권한, 최소화, 동의, mock provider, timeout/429/5xx, 잘못된 JSON·schema, idempotency·rate limit, prompt injection, 출력 안전성, API 계약과 로컬 저장을 검증한다. Playwright는 1440×900, 390×844, 360×740을 확인한다. `ai-privacy/verified`는 mock만 사용하고 CI 실제 외부 AI 호출 0회, 실제 주문 0회, 비공개 거래소 호출 0회, 프런트 Secret 0개를 확인한다.

제한: provider가 설정되지 않은 환경에서는 미리보기와 기존 분석은 가능하지만 AI 생성은 불가능하다. 결과는 학습용이며 투자 조언이 아니다.

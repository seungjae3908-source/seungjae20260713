# 승재주식 AI 앱 1차 설정

## 1. Replit Secrets

API 서버용:

- `KIWOOM_APP_KEY`
- `KIWOOM_APP_SECRET`
- `KIWOOM_MODE=real` (모의투자는 `mock`)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` 또는 `SUPABASE_SECRET_KEY`

프론트 빌드용:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_VAPID_PUBLIC_KEY` (푸시를 사용할 때)

푸시 서버용:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT=mailto:본인이메일`

키움 App Key/Secret은 절대 `VITE_` 접두사를 붙이지 마세요.

## 2. Supabase

Supabase Dashboard > SQL Editor에서 다음 파일 전체를 실행합니다.

`artifacts/api-server/supabase/schema.sql`

Authentication > Providers > Email을 활성화합니다.
이메일 인증을 바로 테스트하려면 개발 중에는 Confirm email 옵션을 끌 수 있습니다.

## 3. 1차 확인 주소

- `/api`
- `/api/kiwoom/status`
- `/api/kiwoom/token-test`
- `/api/kiwoom/test`
- `/api/kiwoom/rankings?market=KR&type=volume&limit=30`
- `/api/kiwoom/rankings?market=KR&type=tradingValue&limit=30`
- `/api/kiwoom/rankings?market=KR&type=gainers&limit=30`
- `/api/kiwoom/rankings?market=US&type=volume&limit=30`

## 4. 구현된 1차 범위

- 기존 국내/해외 검색과 시장 화면 유지
- 국내/해외 추천 목록 각 30개
- 거래량/거래대금/급등/급락은 키움 랭킹 우선, 실패 시 기존 데이터 자동 대체
- 종목 상세의 차트/재무/AI/뉴스/공시 화면 유지
- Supabase 이메일 로그인/회원가입
- 사용자별 포트폴리오 저장과 실시간 손익 계산
- 기존 알림 화면과 브라우저/푸시 알림 설정 유지
- 현재 모바일 디자인 유지

## 5. 키움 랭킹 오류 확인

키움 랭킹 TR의 입력값이 계정/서비스 설정에 따라 오류를 반환하면 아래 진단 주소에서 원문을 확인합니다.

`/api/kiwoom/raw-ranking?market=KR&type=volume`

이 주소는 App Key, Secret, 토큰을 반환하지 않습니다.

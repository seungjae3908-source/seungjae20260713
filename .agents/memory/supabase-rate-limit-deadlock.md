---
name: Supabase 무한 로딩 사고 (교착 + tarpit)
description: 앱 전체 API가 무한 로딩될 때 의심할 두 가지 — 프런트 auth 락 교착, Supabase 에지 rate-limit tarpit
---

## 증상
모든 화면/차트가 무한 로딩. Network에 요청이 아예 안 뜨거나(프런트 교착), 요청이 응답 없이 걸림(서버 tarpit).

## 원인 1: supabase-js onAuthStateChange 교착
`onAuthStateChange` 콜백 안에서 다른 supabase 호출(from(), getSession 등)을 기다리면 auth 내부 락이 안 풀려 이후 모든 `getSession()`이 영원히 대기 → authorizedFetch가 토큰을 못 얻어 요청 자체가 안 나감.
**How to apply:** 콜백 내부 작업은 반드시 `setTimeout(0)`으로 연기. authorizedFetch는 getSession 5초 레이스 폴백 유지.

## 원인 2: Supabase 에지 rate-limit tarpit
요청마다 `auth.getUser + profiles` 조회(차트 20~30초 폴링 × 사용자 + 클라이언트 30초 프로필 폴링)가 겹치면 Supabase가 **유효한 apikey 요청만 무응답으로 지연**시킴(잘못된 키는 즉시 401 — 이게 진단 시그니처). curl로 `auth/v1/health`를 apikey 있음/없음으로 비교하면 판별 가능.
**How to apply:** requireMember는 토큰→회원 60초 캐시 + supabase 호출 10초 타임아웃(503 AUTH_UPSTREAM_TIMEOUT) 유지. 클라이언트 프로필 폴링 5분. 폴링 주기 줄이는 변경 금지.

## 기타
- apiGet에 60초 AbortSignal 타임아웃 있음 (국내주식 1분봉 첫 조회 40초+ 걸림 — 더 줄이지 말 것).
- 업비트 spot candles의 symbol 파라미터는 `BTC` (KRW- 접두사 붙이면 502).
- 서버 검증 테스트: service role로 magiclink generateLink→verifyOtp로 토큰 발급이 가장 안정적(password 로그인은 rate limit 걸림).

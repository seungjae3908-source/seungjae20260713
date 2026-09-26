# 승재주식 (AI 주식 분석 앱)

## 프로젝트 개요

국내/해외 주식 분석 모바일 앱. 키움 API로 실시간 시세와 랭킹을 가져오고, Supabase로 사용자 인증과 포트폴리오를 관리합니다.

## 구조

| 디렉토리 | 역할 |
|---|---|
| `api-server/` | Express + TypeScript 백엔드 (포트 8080) |
| `stock-analyzer/` | React + Vite 프론트엔드 (포트 18797, dev) |
| `mockup-sandbox/` | UI 컴포넌트 미리보기 서버 |
| `packages/stock-grade/` | 주식 분류 로직 공유 패키지 |
| `packages/api-zod/` | API 응답 zod 스키마 |

## 실행 방법

```bash
# 의존성 설치 (최초 1회)
pnpm install

# API 서버 (포트 8080)
pnpm --filter @workspace/api-server run dev

# 프론트엔드 (포트 18797)
pnpm --filter @workspace/stock-analyzer run dev
```

Replit 워크플로우로 자동 실행됩니다.

## 필수 시크릿

`STOCK_AI_V1_SETUP.md` 참고:

- `KIWOOM_APP_KEY` / `KIWOOM_APP_SECRET` — 키움 OpenAPI 앱 키
- `KIWOOM_MODE` — `real` (실거래) 또는 `mock` (모의투자)
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase 프로젝트
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — 프론트엔드용 Supabase
- `VITE_VAPID_PUBLIC_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — 푸시 알림 (선택)

선택 시크릿 (없으면 해당 기능만 비활성화):
- `FINNHUB_API_KEY` — 해외 주식 데이터
- `ALPHA_VANTAGE_API_KEY` — 재무제표
- `DART_API_KEY` — 국내 공시

## 기술 스택

- **백엔드**: Node.js 20, Express 5, TypeScript, esbuild
- **프론트엔드**: React 18, Vite 6, Tailwind CSS v4, TanStack Query
- **DB**: Supabase (PostgreSQL + 인증)
- **패키지 매니저**: pnpm workspace

## 참고

- api-server는 사전 컴파일된 `dist/index.mjs`로 실행 (재빌드 필요 시 `pnpm --filter @workspace/api-server run build`)
- Supabase 스키마: `api-server/supabase/schema.sql` 을 Supabase Dashboard SQL Editor에서 실행

## User Preferences

# 5차 롱 눌림·시장상태 수집기 구현 보고서

## 작업 기준

- 브랜치: `agent/long-pullback-market-context-collector-20260726`
- 시작 SHA: `69aa00d5849feba085b428bf1ed9405a7b267ed9`
- 기준 브랜치 직접 수정: 없음
- 병합·PR·배포: 없음
- 실제 주문·개인계좌·API 키 사용: 없음

## 구현 내용

### Bitget 공개 시장상태 수집기

- 기본 5분 주기로 BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT 수집
- 가격, 마크가격, 지수가격, 매수·매도호가, 스프레드, 펀딩비 수집
- OI, 계정 롱숏비율, 포지션 롱숏비율, 전체 롱숏비율 수집
- OI 5분·15분·1시간 변화율 계산
- 데이터 누락·지연, 스프레드 확대, 마크/지수 괴리, 펀딩 과열, 롱 쏠림, OI 급변 시 롱 진입 차단
- 초기 OI 이력이 부족한 동안 `OI_HISTORY_INSUFFICIENT`로 진입 차단
- 일자별 `JSONL` 저장, 기본 180일 보존, 서버 재시작 시 최근 3일 이력 재적재
- 실제 수집 데이터는 Git에 커밋하지 않음

### 조회 API

- `GET /api/crypto/futures/context/status`
- `GET /api/crypto/futures/context/latest?symbol=BTCUSDT`
- `GET /api/crypto/futures/context/history?symbol=BTCUSDT&limit=500`
- `POST /api/crypto/futures/context/collect` — 관리자 수동 수집
- 모든 응답에 `mode: PUBLIC_MARKET_DATA_ONLY`, `realOrdersEnabled: false` 표시

### 5차 과거 백테스트

- 롱 전용
- 돌파 후 눌림·재지지·모멘텀 회복 확인
- `40·30·30`과 `30·30·40` 분할진입 비교
- 분할청산 `30·30·40`
- 5배, 실행별 원금 300,000원, 거래당 최대 계획원금 30,000원
- 수수료 12bp, 슬리피지 15bp 적용
- 과거 OI·롱숏비율은 생성하지 않음
- 검증기간에 공개 펀딩 이력이 없어 펀딩을 미관측 `null`로 유지하고 손익 계산에서 제외

## 검증 결과

- 프런트 빌드: 통과
  - `rm -rf stock-analyzer/dist && pnpm --filter @workspace/stock-analyzer build`
- API 서버 번들 빌드: 통과
  - `pnpm --filter @workspace/api-server build:server`
- 5차 신규 서비스·라우트 전용 TypeScript 검사: 통과
- 실제 Bitget 공개 API 수집·JSONL 저장 스모크 테스트: 통과
- Python 문법검사 및 5차 백테스트 실행: 통과
- 저장소 전체 백엔드 타입검사: 실패
  - 기존 `sec-edgar` 계열의 `FilingCounts`, `FinancialsRaw`, `getFinancials`, `FinancialRow` 불일치가 원인
  - 5차 신규 파일 전용 검사는 통과

## 5차 백테스트 결과

검증기간: 2025-11-01 ~ 2026-01-29, BTC·ETH·SOL·XRP·DOGE

| 전략 | 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---:|---:|---:|---:|---:|
| 마크·지수 롱 기준 | -19,951원 | 36 | 25.00% | 0.218 | -1.61% |
| 눌림 재지지 40·30·30 | -807원 | 1 | 0.00% | 0.000 | -0.27% |
| 눌림 재지지 30·30·40 | -605원 | 1 | 0.00% | 0.000 | -0.20% |

판정:

- 손실은 크게 제한됐지만 눌림 전략은 89일·5종목에서 거래가 단 1회라 성능을 판단할 표본이 없음
- 순수익, PF, 수익 종목 수, 최소 거래 수 기준 실패
- 실거래 불가
- 앞으로 축적되는 실제 OI·롱숏비율 데이터로 미래 섀도 검증 필요

## 기준 브랜치와 분리 상태

작업 도중 기준 브랜치는 4커밋 진행됐으며 변경 파일은 `.replit`, 정보 탭 패치 파일, `stock-analyzer/vite.config.ts`입니다. 5차 핵심 구현 파일과 직접 겹치는 파일은 없습니다. 다만 브랜치가 분기된 상태이므로 병합하지 말고, 통합 시 최신 기준 브랜치에서 새 브랜치를 만들어 5차 변경만 옮긴 뒤 다시 검증해야 합니다.

# 6차 30만원 전진 섀도 검증 구현 보고서

## 작업 기준

- 브랜치: `agent/forward-shadow-validation-stage6-20260726`
- 시작 SHA: `e88b1a011541388e1c2d1e8d59d976bf6735cf25`
- 기준 브랜치 직접 수정: 없음
- 병합·PR·배포: 없음
- 실제 주문·개인계좌·API 키 사용: 없음
- 종목상세·차트·lazy-panel 파일 수정: 없음

## 구현 내용

### 1. Bitget 공개 시장상태 수집기

- 기본 5분마다 BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT 수집
- 현재가, 마크가격, 지수가격, 매수·매도 호가, 스프레드, 펀딩비 수집
- OI, 계정 롱숏비율, 포지션 롱숏비율, 시장 롱숏비율 수집
- OI 5분·15분·1시간 변화율 계산
- 데이터 누락·지연, 스프레드 확대, 마크/지수 괴리, 펀딩 과열, 롱 쏠림, OI 급변 시 신규 롱 진입 차단
- 초기 OI 이력이 부족하면 `OI_HISTORY_INSUFFICIENT`로 신규 진입 차단
- 일자별 JSONL 저장, 기본 180일 보존, 최근 3일 재적재

### 2. 30만원 전진 섀도 엔진

- 시작 원금: 300,000원
- 레버리지: 5배
- 거래당 최대 계획 증거금: 30,000원
- 분할진입: 30%·30%·40%
- 분할청산: 30%·30%·40%
- 수수료 가정: 체결당 12bp
- 슬리피지 가정: 체결당 15bp
- 동시 포지션: 최대 1개
- 일일 가상 손실한도: 6,000원
- 누적 가상 손실한도: 15,000원
- 최대 보유시간: 48시간
- 청산 후 재진입 대기: 8시간
- 숏 신규진입: 차단
- 실제 주문: 항상 차단

### 3. 진입·관리 규칙

- 15분봉 500개로 EMA20·EMA50·ATR14·RSI14·MACD·거래량비율 계산
- 1시간·4시간 집계 추세가 모두 상승인 경우만 검토
- 최근 돌파 후 EMA20/돌파가격 부근 눌림과 재지지 확인
- RSI·MACD 회복, 과도한 추격봉·거래량 이상 차단
- 시장상태와 기술조건을 모두 통과해야 1차 가상진입
- 2차 진입은 평균단가 대비 +0.5R 이상 수익 상태에서만 허용
- 3차 진입은 평균단가 대비 +1.0R 이상 수익 상태에서만 허용
- 손실 중 물타기 금지
- 1.5R·2.5R·4R에서 30%·30%·잔여수량 분할청산
- 1차 청산 후 손절을 평균단가로, 2차 청산 후 손절을 1차 목표가로 상향
- 손절, 시장 충격, 최대 보유시간에 잔여수량 전량 가상청산
- 모든 평가에서 진입 여부와 차단 사유를 기록

### 4. API

- `GET /api/crypto/futures/context/status`
- `GET /api/crypto/futures/context/latest?symbol=BTCUSDT`
- `GET /api/crypto/futures/context/history?symbol=BTCUSDT&limit=500`
- `POST /api/crypto/futures/context/collect` — 관리자
- `GET /api/crypto/futures/forward-shadow/status`
- `GET /api/crypto/futures/forward-shadow/evaluations?limit=500`
- `GET /api/crypto/futures/forward-shadow/trades?limit=500`
- `POST /api/crypto/futures/forward-shadow/run` — 관리자
- `POST /api/crypto/futures/forward-shadow/reset` — 관리자
- 리셋 확인문구: `RESET_STAGE6_FORWARD_SHADOW_300000`
- 모든 섀도 응답: `mode: FORWARD_SHADOW`, `realOrdersEnabled: false`

## 검증 결과

- 의존성 설치: 통과
- 프런트 빌드: 통과
  - `rm -rf stock-analyzer/dist && pnpm --filter @workspace/stock-analyzer build`
- 6차 신규 서비스·라우트 전용 TypeScript 검사: 통과
- API 서버 번들 빌드: 통과
  - `pnpm --filter @workspace/api-server build:server`
- 순수 전략 계산 스모크 테스트: 통과
- 실제 Bitget BTC 공개 시장상태 수집: 통과
- JSONL 저장: 통과
- 전진 섀도 1회 평가: 통과
  - 처리 종목 1개
  - 신규 포지션 0개
  - 초기 OI 변화 이력이 부족하므로 진입하지 않은 것이 정상
  - 원금·가용자금 300,000원 유지
  - 실제 주문 비활성 유지

### 전체 백엔드 타입검사

저장소 전체 `pnpm --filter @workspace/api-server typecheck`는 실패했습니다.

기존 오류:

- `sec-edgar`의 `FilingCounts` 미내보내기
- `FinancialsRaw` 미내보내기
- `FinancialRow` 구조 불일치
- `getFinancials` 미내보내기

6차 신규 파일 전용 타입검사와 API 서버 번들은 통과했습니다.

## 기준 브랜치와 충돌 상태

작업 시작 후 기준 브랜치는 1커밋 진행됐습니다. 변경 파일은 `stock-analyzer/coin-tech-stocks-final-patch.ts` 하나이며, 6차 서버·수집기·섀도 파일과 직접 겹치지 않습니다.

현재 6차 브랜치는 시작 SHA에서 분리된 상태이므로 자동 병합하지 않았습니다. 통합 시 최신 기준 브랜치에서 새 통합 브랜치를 만들고 6차 변경만 옮긴 뒤 다시 전체 검증해야 합니다.

## 아직 실행되지 않은 항목

- 운영서버 또는 Replit에 브랜치 반영하지 않음
- 장기 OI·롱숏 데이터 누적 시작 전
- 여러 날의 미래 섀도 수익률·승률·PF·MDD 결과 없음
- 앱 화면 대시보드 연결 없음
- 런타임 폴더의 영구 디스크 유지 여부 미검증
- 실제 주문·실계좌 체결·주문실패 테스트 없음

## 판정

6차 엔진 구현과 단일 공개데이터 평가까지는 통과했습니다. 그러나 장기 미래 표본이 아직 없으므로 수익 전략 판정과 실거래 전환은 불가합니다.

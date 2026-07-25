# 신호검색기·차트 생중계 기능 백업

백업 기준 커밋: `80f709933cf74c8ae4ffa451b9dd846c7cc181cf`

이 브랜치는 다음 기능의 원본 코드를 보존하기 위한 복구용 브랜치입니다.

## 보존 대상

### 1. 신호검색기

원본 파일:

- `stock-analyzer/src/pages/scanner.tsx`

보존 기능:

- 국내·해외 시장 선택
- 조건 지표 선택 및 삭제
- 단타·스윙·중장기 프리셋
- 거래량·거래대금 임계값
- 시가총액 조건
- 이동평균선·RSI·MACD·볼린저밴드·OBV 조건
- 외국인·기관 수급 조건
- 뉴스·공시·AI 점수 조건
- `/api/market/scan` 결과 표시

주의:

`scanner.tsx`에는 자동매매와 주문 관련 코드가 함께 들어 있습니다. 최신 프로젝트로 옮길 때 파일 전체를 복사하지 말고 신호검색 UI와 검색 로직만 분리해야 합니다.

제외 대상:

- `assessAutoTradeCandidate`
- `executeAutoTradeCandidates`
- `monitorAutoTradePositions`
- `closeAutoTradePosition`
- 자동주문 상태·주문키·포지션 감시·매도 승인
- `/api/stocks/auto-trade/*`

### 2. 차트 생중계

원본 파일:

- `stock-analyzer/src/components/chart-broadcast.tsx`

보존 기능:

- 1분·3분·5분·15분·30분·1시간·4시간·1일·5일·20일 시간봉
- 실시간 자동 갱신 및 일시정지
- 종목 검색
- 캔들·거래량
- MA5·MA20·MA60·MA120
- 볼린저밴드·VWAP
- RSI·MACD·ATR
- 지지·저항선
- 매수·매도 마커

### 3. AI 차트 실시간 생중계

`chart-broadcast.tsx` 내부에 함께 보존되어 있습니다.

보존 기능:

- 새 봉 감지 피드
- ENTER·WATCH·HOLD·TAKE_PROFIT·EXIT·STOP 신호
- 상승장악형·하락장악형·망치형·유성형·도지·쌍바닥·쌍봉 감지
- 추세·거래량·RSI·MACD·ATR 종합
- 진입 기준·목표가·손절 기준
- 신뢰도 및 시장 지수 편향 반영

이 기능은 외부 생성형 AI 모델 호출이 아니라 실제 봉 데이터와 기술지표를 이용한 규칙 기반 분석엔진입니다.

## 필요한 공통 연결

- `stock-analyzer/src/lib/api.ts`
- `stock-analyzer/src/lib/auth-fetch.ts`
- `stock-analyzer/src/lib/utils.ts`
- `stock-analyzer/src/lib/asset-mode.tsx`
- `lightweight-charts`
- `@tanstack/react-query`

사용 API:

- `/api/market/scan`
- `/api/search/quotes`
- `/api/stocks/:ticker/chart`
- `/api/stocks/:ticker/candles`
- `/api/quotes`

## 복구 원칙

1. 운영 `main`에 바로 덮어쓰지 않습니다.
2. 최신 리프릿 작업본을 먼저 별도 브랜치에 백업합니다.
3. 신호검색기는 자동매매 코드를 제거한 독립 컴포넌트로 분리합니다.
4. 차트 생중계는 차트 데이터 API가 최신 프로젝트와 호환되는지 확인한 뒤 연결합니다.
5. 실제 주문·자동매매 기능은 복구 대상에 포함하지 않습니다.

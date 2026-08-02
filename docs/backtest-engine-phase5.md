# Phase 5 비용 반영 백테스트 엔진

## 목적과 안전 경계

Phase 5는 코인 선물의 과거 완료 캔들만 사용하는 독립 백테스트 기능이다. 실제 주문, 자동매매, 계좌·포지션 조회, 주문 API Key, DB 저장, WebSocket, 운영 배포와 연결하지 않는다.

모든 성공 응답은 다음 계약을 유지한다.

```json
{
  "ok": true,
  "mode": "backtest-only",
  "orderSubmitted": false,
  "result": {}
}
```

백테스트 서비스와 라우트는 주문 모듈을 import하거나 호출하지 않는다.

## 데이터 계약

Phase 2의 `NormalizedCandle` 계약을 재사용한다. 캔들은 timestamp 오름차순으로 정렬하고 중복 timestamp를 제거한다. 숫자가 유효하지 않거나 OHLC 관계가 잘못된 캔들과 미완성 캔들은 제외한다. 누락 구간은 경고만 반환하며 임의 캔들로 채우지 않는다.

과거 데이터는 Bitget 공개 `GET /api/v2/mix/market/history-candles`를 사용한다. 한 요청당 최대 200개와 90일 조회 창을 기준으로 뒤쪽 시점부터 안전하게 페이지를 이동한다. 요청 timeout은 8초이며 전체 백테스트 timeout은 25초다.

초기 상한:

- 최대 기간: 366일
- 최대 정규화 완료 캔들: 20,000개
- provider 페이지: 200개
- 동시 실행: 2개
- 요청 본문: 64 KiB
- 앱 레버리지: 10배

## 지원 전략

Phase 5 실제 지원 전략은 3개다.

### trend_pullback

- 빠른 EMA가 느린 EMA 위인 상승 추세 또는 반대인 하락 추세
- 이전 완료 봉이 빠른 EMA 허용 범위까지 조정
- 현재 완료 봉이 빠른 EMA를 재회복 또는 재이탈
- 평균 거래량 대비 설정 배수 조건
- 신호 다음 봉 시가 진입

### breakout

- 현재 신호 봉을 제외한 이전 완료 봉 N개의 최고가·최저가
- 완료 봉 종가가 경계를 돌파
- 평균 거래량 배수 조건
- 현재 봉 자기참조 금지
- 신호 다음 봉 시가 진입

### vwap_reclaim

- UTC 날짜별 세션 VWAP
- 이전 완료 봉이 VWAP 반대편에 있고 현재 완료 봉이 회복 또는 이탈
- 평균 거래량 조건
- 신호 다음 봉 시가 진입

타입에 예약된 다른 전략 이름은 이번 단계에서 실행하지 않으며 API가 `UNSUPPORTED_STRATEGY`로 거부한다. 사용자가 JavaScript나 임의 코드를 실행하는 기능은 없다.

## 공통 지표

서버 순수 함수로 다음을 제공한다.

- SMA
- EMA
- RSI
- True Range와 ATR
- UTC 세션 VWAP
- 평균 거래량
- 최근 N봉 최고가·최저가

각 인덱스 결과는 해당 인덱스까지의 데이터만 사용한다. 첫 유효값 이전과 데이터 부족 구간은 `null`이다. NaN과 Infinity는 결과에 사용하지 않는다.

## 신호와 체결 시점

봉 N 종가까지 계산한 신호의 가장 빠른 진입은 봉 N+1 시가다. 같은 봉 종가 진입은 금지한다.

롱 시장가 진입:

```text
entryFill = nextOpen × (1 + slippageRate)
```

숏 시장가 진입:

```text
entryFill = nextOpen × (1 - slippageRate)
```

청산도 포지션 방향에 불리한 슬리피지를 적용한다. 마지막 봉에서 새 신호가 발생해도 다음 봉이 없으면 진입하지 않는다.

## 손절·목표·봉 내부 정책

손절 방식:

- percent
- atr
- swing

목표 방식:

- risk_multiple
- percent

트레일링 스톱은 설정한 R 활성화 거리와 R 추적 거리를 사용한다. 반대 신호 청산 옵션과 데이터 종료 청산도 지원한다.

OHLC만으로 한 봉 내부 가격 순서를 알 수 없으므로 기본값은 `stop_first`다. 손절과 목표가가 같은 봉에서 모두 닿으면 롱·숏 모두 손절을 우선한다. `target_first`는 명시적으로 요청할 수 있지만 비보수적 옵션이며 기본값이 아니다. 적용 가정은 결과 warnings와 화면에 표시한다.

## 포지션 크기

Phase 3의 `calculateTradingRisk`를 직접 호출해 같은 수량·위험 공식을 재사용한다.

```text
maximumRiskAmount = currentEquity × riskPercent / 100
```

수량에는 진입가, 손절가, 진입·청산 수수료, 양방향 슬리피지, 예상 펀딩비, quantityStep, quantityPrecision, 최소 수량, 최소 명목, 앱 최대 레버리지, 거래소 최대 레버리지를 반영한다. 최종 내림 수량의 최대손실이 위험예산을 넘지 않는지 Phase 3 엔진이 재검증한다. 레버리지는 위험예산을 늘리지 않는다.

## 비용과 손익

모든 거래에 다음을 분리해 기록한다.

- gross PnL
- entry fee
- exit fee
- slippage cost
- funding cost
- net PnL

대표 수익률과 자산곡선은 비용 차감 후 net PnL을 사용한다.

펀딩비는 초기 단계에서 실제 거래소 펀딩 시각 대신 보유시간 기반 완전 구간 수 모델을 사용한다.

```text
intervals = floor(holdingTime / fundingInterval)
funding = notional × fundingRatePerInterval × intervals × sideDirection
```

양의 펀딩비는 롱 비용·숏 수취로 계산하고 음수는 반대로 계산한다.

## 자산곡선과 드로다운

자산곡선은 청산 완료 거래의 실현 순손익만 반영한다. 미실현 손익은 포함하지 않는다.

```text
runningPeak = max(previousPeak, equity)
drawdown = runningPeak - equity
drawdownPercent = drawdown / runningPeak × 100
```

최대 낙폭은 금액과 비율을 모두 제공한다.

## 성과 통계

- 총·연환산 수익률
- 총 거래, 승리·손실, 승률
- 평균 이익·손실·R
- 기대값
- Profit Factor
- 최대 낙폭
- 최대 연속 승리·손실
- Sharpe, Sortino, Calmar
- 총 수수료·슬리피지·펀딩비
- 롱·숏 성과
- 월별 성과
- 시장 상태별 성과

총 손실이 0이면 Profit Factor는 Infinity가 아니라 `null`과 warning을 반환한다. Sharpe와 Sortino는 UTC 일별 실현수익률, 무위험수익률 0%, 연 365일 기준이다. 일별 표본이 5개 미만이거나 분산 계산이 불가능하면 `null`과 warning을 반환한다.

## 시장 상태

거래 시점까지의 EMA20·EMA50, 빠른 EMA 기울기, ATR 최근 평균 비율을 사용해 다음으로 분류한다.

- uptrend
- downtrend
- ranging
- volatility_expansion
- insufficient

AI 확률이나 미래 정보는 사용하지 않는다.

## 인샘플·아웃오브샘플

기본 분할은 시간순 60%/20%/20%다.

- training 60%
- validation 20%
- test 20%

랜덤 셔플을 하지 않으며 경계는 겹치지 않는다. 거래는 진입 시각을 기준으로 한 구간에만 포함된다. 전체 기간에 맞춘 자동 파라미터 최적화는 구현하지 않았다.

## 워크포워드 기본형

동일한 고정 파라미터를 전체 기간의 연속 3개 시간 창에서 평가한다. 각 창은 시작·종료, 거래 수, 순손익, 최대 낙폭, 기대값을 반환한다. 자동 최적화나 다음 창으로의 파라미터 이전은 이번 범위가 아니다.

## API

```text
POST /api/backtests/run
```

기존 `requireMember` 뒤에 등록되어 승인된 로그인 회원만 접근한다. 요청 본문 크기, 기간, 예상 캔들 수, 동시 실행 수, provider timeout, 전체 timeout을 제한한다. 연결 중단 시 provider 요청을 취소한다. 오류 응답은 일반화된 코드와 메시지만 반환하고 stack trace와 인증정보를 노출하지 않는다.

## UI

```text
/backtests
```

입력:

- 종목·시간봉·기간
- 초기 자본
- 전략·롱/숏/양방향
- 위험률·레버리지
- 수수료·슬리피지·펀딩비
- 손절·목표·트레일링

결과:

- 핵심 성과 카드
- 자산·드로다운 곡선
- 학습·검증·테스트 결과
- 롱·숏, 월별, 시장 상태 및 워크포워드 결과
- 거래 목록
- 가정과 warnings

기존 `recharts`를 재사용하며 새 대형 차트 의존성을 추가하지 않는다. 기존 하단 내비게이션의 이름·순서·이동 구조는 변경하지 않는다.

## 테스트

Phase 5에는 지표, 신호, 자기참조 방지, 다음 봉 체결, 롱·숏 슬리피지, 수수료, 펀딩비 지급·수취, 손절 우선, 트레일링, 데이터 종료, Phase 3 수량 재사용, 통계, validation split, 워크포워드, API 안전 계약, 데스크톱·모바일·소형 모바일 검증을 포함한다.

성능 테스트는 1,000개, 10,000개, 최대 20,000개 완료 캔들을 실행하며 10,000개는 5초, 20,000개는 10초의 안정적인 상한만 적용한다. 실제 수치는 최종 CI 로그에 기록한다.

## 미검증 또는 제한

- 실제 거래소 체결 순서와 호가 깊이
- 거래량 기반 부분 체결 모델
- 실제 펀딩 시각 정렬
- 미실현 손익 포함 자산곡선
- 자동 파라미터 최적화
- 실제 모바일 소프트 키보드가 열린 상태의 viewport 변화
- 실제 스크린리더 수동 조작과 전문 접근성 감사
- 장기간 운영 환경의 동시 사용자 부하

위 항목은 결과를 더 좋게 보이게 하는 임의 가정으로 대체하지 않는다.

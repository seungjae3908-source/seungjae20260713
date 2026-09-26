# Phase 5 비용 반영 백테스트 엔진

## 목적과 안전 경계

Phase 5는 코인 선물의 과거 완료 캔들만 사용하는 독립 백테스트 기능이다. 실제 주문, 자동매매, 실제 계좌·포지션 조회, 주문 API Key, DB 저장, WebSocket, 운영 배포와 연결하지 않는다.

성공 응답은 다음 계약을 유지한다.

```json
{
  "ok": true,
  "mode": "backtest-only",
  "orderSubmitted": false,
  "result": {}
}
```

백테스트 서비스와 라우트는 주문 모듈을 import하거나 호출하지 않는다.

## 데이터 계약과 조회 제한

Phase 2의 `NormalizedCandle` 계약을 재사용한다. 캔들은 timestamp 오름차순으로 정렬하고 중복 timestamp를 제거한다. NaN, Infinity, 잘못된 OHLC 관계, 음수 거래량, 미완성 캔들은 제외한다. 누락 구간은 경고만 반환하며 임의 캔들로 채우지 않는다.

과거 데이터는 Bitget 공개 `GET /api/v2/mix/market/history-candles`를 사용한다. 제공자 제약에 맞춰 한 페이지 최대 200개와 최대 90일 조회 창으로 뒤쪽 시점부터 페이지를 이동한다.

초기 보호 상한:

- 최대 기간: 366일
- 최대 완료 캔들: 20,000개
- provider 요청 timeout: 8초
- 전체 API timeout: 25초
- 동시 실행: 2개
- 요청 본문: 64 KiB
- 앱 레버리지: 최대 10배

## 지원 전략

실제 실행 가능한 전략은 다음 3개다.

### `trend_pullback`

- 빠른 EMA와 느린 EMA로 추세 확인
- 이전 완료 봉이 빠른 EMA 허용 범위까지 조정
- 현재 완료 봉이 빠른 EMA를 재회복 또는 재이탈
- 평균 거래량 조건
- 신호 다음 봉 시가 진입

### `breakout`

- 현재 신호 봉을 제외한 이전 완료 봉 N개의 최고가·최저가 사용
- 완료 봉 종가가 경계를 돌파
- 평균 거래량 배수 조건
- 현재 봉 자기참조 금지
- 신호 다음 봉 시가 진입

### `vwap_reclaim`

- UTC 날짜별 세션 VWAP
- 이전 완료 봉이 VWAP 반대편에 있고 현재 완료 봉이 회복 또는 이탈
- 평균 거래량 조건
- 신호 다음 봉 시가 진입

타입에 예약된 다른 전략은 `UNSUPPORTED_STRATEGY`로 거부한다. 사용자가 JavaScript나 임의 코드를 실행하는 기능은 없다.

## 공통 지표

서버 순수 함수로 다음을 제공한다.

- SMA
- EMA
- RSI
- True Range와 ATR
- UTC 세션 VWAP
- 평균 거래량
- 최근 N봉 최고가·최저가

각 인덱스 결과는 해당 인덱스까지의 데이터만 사용한다. 첫 유효값 이전과 데이터 부족 구간은 `null`이다. NaN 또는 Infinity가 포함된 롤링 창은 `null`이며, 잘못된 값이 창을 벗어난 뒤의 정상 창은 다시 정상 계산된다.

## 신호와 체결 시점

봉 N 종가까지 계산한 신호의 가장 빠른 진입은 봉 N+1 시가다. 같은 봉 종가 진입은 금지한다.

```text
롱 진입 체결가 = 다음 봉 시가 × (1 + slippageRate)
숏 진입 체결가 = 다음 봉 시가 × (1 - slippageRate)
```

청산에도 방향에 따라 불리한 슬리피지를 적용한다. 마지막 봉에서 신호가 발생해도 다음 봉이 없으면 진입하지 않는다.

## 손절·목표·봉 내부 정책

손절 방식:

- percent
- atr
- swing

목표 방식:

- risk_multiple
- percent

트레일링 스톱, 반대 신호 청산 옵션, 데이터 종료 청산을 지원한다.

OHLC만으로 한 봉 내부 순서를 알 수 없으므로 기본 정책은 `stop_first`다. 손절과 목표가가 같은 봉에서 모두 닿으면 롱·숏 모두 손절을 우선한다. `target_first`는 명시적으로 요청할 수 있는 비보수적 옵션이며 기본값이 아니다. 적용 정책은 결과 warnings와 UI에 표시한다.

## 포지션 크기

Phase 3의 `calculateTradingRisk`를 직접 호출해 동일한 위험 공식을 재사용한다.

```text
maximumRiskAmount = currentEquity × riskPercent / 100
```

수량에는 진입가, 손절가, 진입·청산 수수료, 양방향 슬리피지, 예상 펀딩비, quantityStep, quantityPrecision, 최소 수량, 최소 명목, 앱 최대 레버리지, 거래소 최대 레버리지를 반영한다. 최종 내림 수량의 최대손실이 위험예산을 넘지 않는지 재검증한다. 레버리지는 위험예산을 늘리지 않는다.

## 비용과 펀딩비

모든 거래에 다음을 분리해 기록한다.

- gross PnL
- entry fee
- exit fee
- slippage cost
- funding cost
- net PnL

대표 수익률과 자산곡선은 비용 차감 후 net PnL을 사용한다.

펀딩비는 초기 구현에서 실제 펀딩 시각 대신 보유시간 기반 완전 구간 수 모델을 사용한다.

```text
intervals = floor(holdingTime / fundingInterval)
funding = notional × fundingRatePerInterval × intervals × sideDirection
```

양의 펀딩비는 롱 비용·숏 수취로 계산하고 음수는 반대로 계산한다.

## 자산곡선과 통계

자산곡선은 청산 완료 거래의 실현 순손익만 반영한다. 미실현 손익은 포함하지 않는다.

```text
runningPeak = max(previousPeak, equity)
drawdown = runningPeak - equity
drawdownPercent = drawdown / runningPeak × 100
```

결과 통계:

- 총·연환산 수익률
- 총 거래, 승리·손실, 승률
- 평균 이익·손실·R
- 기대값과 Profit Factor
- 최대 낙폭 금액·비율
- 최대 연속 승리·손실
- Sharpe, Sortino, Calmar
- 총 수수료·슬리피지·펀딩비
- 롱·숏 성과
- 월별 성과
- 시장 상태별 성과

총 손실이 0이면 Profit Factor는 Infinity가 아니라 `null`과 warning을 반환한다. Sharpe와 Sortino는 UTC 일별 실현수익률, 무위험수익률 0%, 연 365일 기준이다. 표본이 부족하거나 분산 계산이 불가능하면 `null`과 warning을 반환한다.

## 시장 상태

거래 시점까지의 EMA20·EMA50, 빠른 EMA 기울기, ATR 최근 평균 비율로 다음을 분류한다.

- uptrend
- downtrend
- ranging
- volatility_expansion
- insufficient

AI 확률이나 미래 정보는 사용하지 않는다.

## 학습·검증·테스트와 워크포워드

기본 분할은 시간순 60%/20%/20%다.

- training 60%
- validation 20%
- test 20%

랜덤 셔플을 하지 않으며 경계는 겹치지 않는다. 거래는 진입 시각 기준으로 한 구간에만 포함된다. 자동 파라미터 최적화는 구현하지 않았다.

워크포워드 기본형은 동일한 고정 파라미터를 연속 3개 시간 창에서 평가한다. 각 창은 시작·종료, 거래 수, 순손익, 최대 낙폭, 기대값을 반환한다.

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
- 롱·숏 성과
- 워크포워드
- 월별·시장 상태별 성과
- 거래 목록
- 가정과 warnings

기존 `recharts`를 재사용하며 새 대형 차트 의존성을 추가하지 않는다. 기존 하단 내비게이션의 이름·순서·이동 구조는 변경하지 않는다.

## 최종 검증 수치

최종 후보 CI run `30728021368`에서 다음이 성공했다.

- Phase 2: 15개
- Phase 3: 44개
- Phase 4: 30개
- Phase 5 단위·데이터·경계·성능: 81개
- API 스모크: 11개
- Playwright: 10개
- 전체 테스트: 191개
- 실패·취소·건너뜀: 0개
- 프런트 타입검사: 성공
- 백엔드 타입검사: 성공
- 프런트 프로덕션 빌드: 성공
- 백엔드 프로덕션 빌드: 성공
- 실제 Bitget 공개 네트워크 smoke: 성공, non-blocking 유지

Playwright는 1440×900, 390×844, 360×740에서 성공 결과를 검증하고, 모바일 터치, 접근 가능한 label, 긴 거래 목록, 빈 결과, 오류 결과, 자산·드로다운 차트, 경고, 가로 스크롤 없음, console error 없음, uncaught exception 없음을 확인했다.

최종 성능 측정:

| 캔들 수 | 순수 계산 시간 | heap 증감 | 거래 수 | timeout |
|---:|---:|---:|---:|---|
| 1,000 | 18.14 ms | +3,533,136 bytes | 0 | 없음 |
| 10,000 | 39.86 ms | -177,552 bytes | 0 | 없음 |
| 20,000 | 94.78 ms | +3,670,352 bytes | 0 | 없음 |

성능 fixture는 신호가 발생하지 않게 구성해 지표·순회 비용을 측정했다. heap 증감은 가비지 컬렉션 시점에 따라 음수가 될 수 있으므로 절대 메모리 사용량으로 해석하지 않는다. CI에는 마이크로초 단위 고정값이 아니라 합리적인 초 단위 상한만 적용한다.

## 미검증 또는 제한

- 실제 거래소의 봉 내부 체결 순서와 호가 깊이
- 거래량 기반 부분 체결 모델
- 실제 거래소 펀딩 시각 정렬
- 미실현 손익 포함 자산곡선
- 자동 파라미터 최적화
- 실제 모바일 소프트 키보드가 열린 상태의 viewport 변화
- 실제 스크린리더 수동 조작과 전문 접근성 감사
- 장기간 운영 환경의 동시 사용자 부하

위 항목은 결과를 더 좋게 보이게 하는 임의 가정으로 대체하지 않는다.

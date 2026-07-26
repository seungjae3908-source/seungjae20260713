# Bitget 5종목 과거 89일 하드차단·롱숏분리 4차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용한 예비 검증입니다.

- 생성: 2026-07-26T10:19:59.714275+00:00
- 검증기간: 2026-01-29T10:15:00+00:00 ~ 2026-04-28T10:15:00+00:00
- 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 각 실행 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 분할진입 40·30·30 / 분할청산 30·30·40
- 매 체결 수수료 12bp + 슬리피지 15bp
- 펀딩·마크·지수 조건은 점수 가산 없이 차단에만 사용
- 롱·숏 허용 조건 분리 / 후보 실행당 최대 8거래

## 전체 비교

| 전략 | 수익 종목 | 평균 수익률 | 15개 실행 합산손익 | 거래 | 승률 | PF | 최악 MDD | 펀딩손익 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| PRICE_ONLY_REFERENCE | 1/5 | -0.74% | -33,107원 | 142 | 29.58% | 0.649 | -4.01% | +0원 |
| HARD_VETO_SPLIT | 1/5 | -0.20% | -8,857원 | 24 | 29.17% | 0.413 | -1.23% | +0원 |
| HARD_VETO_LONG_ONLY | 2/5 | -0.09% | -3,982원 | 14 | 28.57% | 0.512 | -1.03% | +0원 |
| HARD_VETO_SHORT_ONLY | 1/5 | -0.11% | -4,874원 | 10 | 30.00% | 0.297 | -1.23% | +0원 |

## 구간별 비교

| 구간 | 전략 | 5종목 합산손익 | 거래 | 승률 | PF |
|---|---|---:|---:|---:|---:|
| FOLD_A_OLDEST | PRICE_ONLY_REFERENCE | +5,346원 | 55 | 38.18% | 1.148 |
| FOLD_A_OLDEST | HARD_VETO_SPLIT | -3,275원 | 8 | 37.50% | 0.386 |
| FOLD_A_OLDEST | HARD_VETO_LONG_ONLY | +0원 | 0 | 0.00% | - |
| FOLD_A_OLDEST | HARD_VETO_SHORT_ONLY | -3,275원 | 8 | 37.50% | 0.386 |
| FOLD_B_MIDDLE | PRICE_ONLY_REFERENCE | -24,377원 | 54 | 25.93% | 0.365 |
| FOLD_B_MIDDLE | HARD_VETO_SPLIT | -4,449원 | 12 | 25.00% | 0.420 |
| FOLD_B_MIDDLE | HARD_VETO_LONG_ONLY | -2,850원 | 10 | 30.00% | 0.531 |
| FOLD_B_MIDDLE | HARD_VETO_SHORT_ONLY | -1,599원 | 2 | 0.00% | 0.000 |
| FOLD_C_LATEST_IN_WINDOW | PRICE_ONLY_REFERENCE | -14,077원 | 33 | 21.21% | 0.293 |
| FOLD_C_LATEST_IN_WINDOW | HARD_VETO_SPLIT | -1,133원 | 4 | 25.00% | 0.457 |
| FOLD_C_LATEST_IN_WINDOW | HARD_VETO_LONG_ONLY | -1,133원 | 4 | 25.00% | 0.457 |
| FOLD_C_LATEST_IN_WINDOW | HARD_VETO_SHORT_ONLY | +0원 | 0 | 0.00% | - |

## 통과조건

- 실패: combined_net_positive
- 실패: profit_factor_at_least_1_20
- 실패: at_least_3_profitable_symbols
- 실패: at_least_30_trades
- 통과: trade_count_not_above_reference
- 통과: worst_mdd_not_below_minus_5
- 실패: oldest_fold_positive

- 가장 오래된 구간 후보전략 합산손익: -3,275원
- 최종 판정: 탈락 또는 추가 개선 필요

## 제한

- 공개 과거 OI를 제공하는 장기 시계열은 사용하지 못했습니다.
- 롱숏비율 API의 장기 보존 범위를 과거 전체 데이터라고 가정하지 않았습니다.
- 호가 깊이·청산 스트림·실제 주문실패는 포함되지 않았습니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.

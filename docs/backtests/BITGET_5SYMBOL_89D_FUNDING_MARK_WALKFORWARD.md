# Bitget 5종목 89일 펀딩·마크·지수 워크포워드 3차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용한 예비 검증입니다.

- 생성: 2026-07-26T09:56:36.525800+00:00
- 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 시장·마크·지수가격 15분봉과 과거 펀딩비 사용
- 각 실행 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 분할진입 40·30·30 / 분할청산 30·30·40
- 매 체결 수수료 12bp + 슬리피지 15bp
- 89일을 오래된 미사용 구간·중간·최근 구간으로 고정 분리

## 전체 비교

| 전략 | 수익 종목 | 평균 수익률 | 15개 실행 합산손익 | 거래 | 승률 | PF | 최악 MDD | 펀딩손익 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| PRICE_ONLY_REFERENCE | 0/5 | -0.85% | -38,105원 | 171 | 36.26% | 0.599 | -2.38% | +184원 |
| FUNDING_MARK_FILTER | 0/5 | -1.14% | -51,397원 | 252 | 36.90% | 0.639 | -4.82% | +184원 |

## 구간별 비교

| 구간 | 전략 | 5종목 합산손익 | 거래 | 승률 | PF |
|---|---|---:|---:|---:|---:|
| FOLD_A_OLDEST_HOLDOUT | PRICE_ONLY_REFERENCE | -21,235원 | 43 | 23.26% | 0.207 |
| FOLD_A_OLDEST_HOLDOUT | FUNDING_MARK_FILTER | -28,885원 | 67 | 29.85% | 0.296 |
| FOLD_B_MIDDLE | PRICE_ONLY_REFERENCE | -6,081원 | 78 | 42.31% | 0.865 |
| FOLD_B_MIDDLE | FUNDING_MARK_FILTER | +2,977원 | 107 | 44.86% | 1.050 |
| FOLD_C_RECENT | PRICE_ONLY_REFERENCE | -10,789원 | 50 | 38.00% | 0.536 |
| FOLD_C_RECENT | FUNDING_MARK_FILTER | -25,488원 | 78 | 32.05% | 0.397 |

## 통과조건

- 실패: combined_net_positive
- 실패: profit_factor_at_least_1_20
- 실패: at_least_3_profitable_symbols
- 통과: at_least_30_trades
- 통과: worst_mdd_not_below_minus_5
- 실패: oldest_holdout_positive

- 오래된 미사용 구간 후보전략 합산손익: -28,885원
- 최종 판정: 탈락 또는 추가 개선 필요

## 제한

- 펀딩손익은 거래 결과에 반영했지만 당일 중단 시점을 소급 변경하지 않습니다.
- 마크·지수 괴리는 진입 및 쇼크 필터이고, 체결 경로는 2차와 동일한 시장 캔들입니다.
- 과거 OI·롱숏비율·호가·청산 스트림과 실제 주문실패는 미포함입니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.

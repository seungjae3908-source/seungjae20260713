# Bitget 롱 눌림·재지지 5차 백테스트

> 실제 주문·계좌·API 키 없이 Bitget 공식 공개 데이터만 사용했습니다.

- 생성: 2026-07-26T11:05:58.382342+00:00
- 검증기간: 2025-11-01T11:00:00+00:00 ~ 2026-01-29T11:00:00+00:00
- 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 기본 분할청산 30·30·40
- 주 전략 분할진입 30·30·40, 비교안 40·30·30
- 마크·지수 괴리는 점수 가산 없이 차단에만 사용
- 과거 펀딩은 이 기간에 제공되지 않아 값을 만들지 않고 제외
- 숏 신규진입 금지

## 전체 비교
| 전략 | 수익 종목 | 평균 수익률 | 15개 실행 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---:|---:|---:|---:|---:|---:|---:|
| MARK_INDEX_LONG_REFERENCE | 0/5 | -0.44% | -19,951원 | 36 | 25.00% | 0.218 | -1.61% |
| PULLBACK_RETEST_40_30_30 | 0/5 | -0.02% | -807원 | 1 | 0.00% | 0.000 | -0.27% |
| PULLBACK_RETEST_30_30_40 | 0/5 | -0.01% | -605원 | 1 | 0.00% | 0.000 | -0.20% |

## 구간별 비교
| 구간 | 전략 | 5종목 합산손익 | 거래 | 승률 | PF |
|---|---|---:|---:|---:|---:|
| FOLD_A_OLDEST | MARK_INDEX_LONG_REFERENCE | -4,688원 | 5 | 0.00% | 0.000 |
| FOLD_A_OLDEST | PULLBACK_RETEST_40_30_30 | +0원 | 0 | 0.00% | - |
| FOLD_A_OLDEST | PULLBACK_RETEST_30_30_40 | +0원 | 0 | 0.00% | - |
| FOLD_B_MIDDLE | MARK_INDEX_LONG_REFERENCE | -4,884원 | 7 | 28.57% | 0.091 |
| FOLD_B_MIDDLE | PULLBACK_RETEST_40_30_30 | +0원 | 0 | 0.00% | - |
| FOLD_B_MIDDLE | PULLBACK_RETEST_30_30_40 | +0원 | 0 | 0.00% | - |
| FOLD_C_LATEST_IN_WINDOW | MARK_INDEX_LONG_REFERENCE | -10,379원 | 24 | 29.17% | 0.328 |
| FOLD_C_LATEST_IN_WINDOW | PULLBACK_RETEST_40_30_30 | -807원 | 1 | 0.00% | 0.000 |
| FOLD_C_LATEST_IN_WINDOW | PULLBACK_RETEST_30_30_40 | -605원 | 1 | 0.00% | 0.000 |

## 주 전략 통과조건
- 실패: combined_net_positive
- 실패: profit_factor_at_least_1_20
- 실패: at_least_3_profitable_symbols
- 실패: at_least_30_trades
- 통과: worst_mdd_not_below_minus_5
- 실패: oldest_fold_positive

- 오래된 구간 주 전략 합산손익: +0원
- 최종 판정: 탈락 또는 추가 데이터 필요

## 제한
- 과거 OI·롱숏비율은 만들어내지 않았습니다.
- 새 수집기가 축적한 미래 데이터로 별도 검증해야 합니다.
- 과거 모의성과는 미래 수익을 보장하지 않습니다.

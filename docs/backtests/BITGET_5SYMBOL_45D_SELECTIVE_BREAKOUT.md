# Bitget 5종목 선택적 돌파 전략 2차 백테스트

> 같은 기간을 반복 조정하는 과최적화 위험을 명시한 2차 예비 검증입니다.

- 생성: 2026-07-26T09:34:10.867331+00:00
- 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 원금: 각 독립 실행 300,000원 / 거래당 최대 30,000원 / 5배
- 보수 비용: 체결마다 수수료 12bp + 슬리피지 15bp
- 낮은 비용 시나리오는 민감도 비교일 뿐 실제 수수료 주장 아님

## 2차 개선
- BTC 4시간·1시간 방향과 개별 종목 방향 동시 일치
- 거래량 1.25배 이상인 20봉 돌파만 진입
- ADX·RSI·MACD·EMA 기울기 동시 확인
- 지나치게 큰 돌파봉은 추격진입 차단
- 진입 후 재진입 대기시간 확대
- 실제 통과 판정은 보수 비용 시나리지만 사용

## 전체 결과
| 비용 | 전략 | 수익 종목 | 평균 수익률 | 5종목 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| CONSERVATIVE | CURRENT_IMPROVED_SPLIT | 0/5 | -1.32% | -19,748원 | 67 | 32.84% | 0.426 | -2.16% |
| CONSERVATIVE | SELECTIVE_BREAKOUT_SPLIT | 0/5 | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | CURRENT_IMPROVED_SPLIT | 1/5 | -1.14% | -17,122원 | 96 | 35.42% | 0.572 | -2.42% |
| LOWER_FRICTION_SENSITIVITY | SELECTIVE_BREAKOUT_SPLIT | 0/5 | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |

## 종목별
| 비용 | 종목 | 전략 | 수익률 | 순손익 | 거래 | 승률 | PF | MDD |
|---|---|---|---:|---:|---:|---:|---:|---:|
| CONSERVATIVE | BTCUSDT | CURRENT_IMPROVED_SPLIT | -1.54% | -4,626원 | 10 | 20.00% | 0.081 | -1.54% |
| CONSERVATIVE | BTCUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| CONSERVATIVE | ETHUSDT | CURRENT_IMPROVED_SPLIT | -1.63% | -4,887원 | 17 | 35.29% | 0.411 | -1.83% |
| CONSERVATIVE | ETHUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| CONSERVATIVE | SOLUSDT | CURRENT_IMPROVED_SPLIT | -1.64% | -4,928원 | 14 | 21.43% | 0.437 | -2.16% |
| CONSERVATIVE | SOLUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| CONSERVATIVE | XRPUSDT | CURRENT_IMPROVED_SPLIT | -0.07% | -217원 | 13 | 61.54% | 0.955 | -1.02% |
| CONSERVATIVE | XRPUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| CONSERVATIVE | DOGEUSDT | CURRENT_IMPROVED_SPLIT | -1.70% | -5,090원 | 13 | 23.08% | 0.322 | -1.72% |
| CONSERVATIVE | DOGEUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | BTCUSDT | CURRENT_IMPROVED_SPLIT | -2.42% | -7,249원 | 19 | 21.05% | 0.088 | -2.42% |
| LOWER_FRICTION_SENSITIVITY | BTCUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | ETHUSDT | CURRENT_IMPROVED_SPLIT | -0.35% | -1,039원 | 24 | 45.83% | 0.877 | -1.29% |
| LOWER_FRICTION_SENSITIVITY | ETHUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | SOLUSDT | CURRENT_IMPROVED_SPLIT | -2.13% | -6,391원 | 22 | 22.73% | 0.448 | -2.34% |
| LOWER_FRICTION_SENSITIVITY | SOLUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | XRPUSDT | CURRENT_IMPROVED_SPLIT | +0.62% | +1,853원 | 16 | 62.50% | 1.398 | -0.66% |
| LOWER_FRICTION_SENSITIVITY | XRPUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |
| LOWER_FRICTION_SENSITIVITY | DOGEUSDT | CURRENT_IMPROVED_SPLIT | -1.43% | -4,296원 | 15 | 26.67% | 0.415 | -1.60% |
| LOWER_FRICTION_SENSITIVITY | DOGEUSDT | SELECTIVE_BREAKOUT_SPLIT | +0.00% | +0원 | 0 | 0.00% | - | 0.00% |

## 판정
- 보수비용 통과조건: 합산 순수익 양수, PF≥1.20, 3개 이상 종목 수익, 거래≥25, 최악 MDD≥-5%
- 결과: 탈락 또는 추가 데이터 필요

## 주의
- 이번도 같은 45일 시장기간이므로 결과가 좋아져도 실거래 근거로 쓰지 않습니다.
- 다음 개선은 점수 재조정보다 OI·펀딩·호가와 별도 기간 데이터를 추가하는 방향이어야 합니다.

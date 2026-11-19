# V6 독립 돌파→재테스트 진입전략 검증

- 개발/탐색: 2020-01-01 ~ 2024-12-31
- 독립 검증: 2025-01-01 ~ 2025-12-31
- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지
- BTC V2 채택후보는 재튜닝하지 않음. ETH V2 보류/실패만 V6 독립전략으로 재연구함.
- V6는 V1 EMA 눌림 진입신호를 사용하지 않음. 돌파→재테스트 자체가 진입신호이며 다음 봉 시가 체결을 유지함.
- V2에서 동결한 ATR period/stop/target은 실행·위험 비교를 공정하게 하기 위해 유지하고, 진입 구조만 독립적으로 변경함.
- 후보공간: lookback 3 × breakout recency 3 × retest tolerance 2 × confirmation 2 = 36개. 개발구간에서 사전 정의된 수익률 리더/성공률 리더 최대 2개만 2025에 넘김.
- 수수료·spread·slippage·latency·선물 funding은 공유 실행비용 계산기를 사용하며 수익률과 성공률을 단일 점수로 합치지 않음.

| 시장 | 종목 | 방향 | 상태 | 판정 | 2025 수익률 V2→V6 | 성공률 | PF | MDD | 거래수 | 후보수 | 선택 구조 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_SPOT | USDT-ETH | long | v6_candidate_frozen_for_holdout | adopt_candidate | 2.09% → 2.77% | 37.50% → 50.00% | 1.41 → 2.29 | 3.07% → 1.04% | 8 → 4 | 36 | lookback=20, breakout≤1bars, retest±0.5ATR, confirm=directional_body |
| CRYPTO_FUTURES | BTCUSDT | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | BTCUSDT | short | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | ETHUSDT | long | v6_candidate_frozen_for_holdout | adopt_candidate | -0.70% → 4.59% | 33.33% → 57.14% | 0.92 → 2.39 | 4.16% → 2.09% | 12 → 7 | 36 | lookback=10, breakout≤1bars, retest±0.5ATR, confirm=directional_body |
| CRYPTO_FUTURES | ETHUSDT | short | v6_research_hold | reject | 5.50% → -0.15% | 62.50% → 33.33% | 2.71 → 0.96 | 1.03% → 4.04% | 8 → 6 | 36 | lookback=20, breakout≤1bars, retest±0.25ATR, confirm=close_reclaim |

# V3 거래량·추세강도 필터 독립검증

- 개발/탐색: 2020-01-01 ~ 2024-12-31
- 독립 검증: 2025-01-01 ~ 2025-12-31
- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지
- BTC의 V2 채택후보는 재튜닝하지 않음. V2 보류·실패 케이스에만 V3 필터 탐색을 수행함.
- V3 후보공간: RVOL × 단기 거래량확장 × |EMA fast-slow|/ATR = 최대 27개. 수익률·성공률은 단일 가중점수로 합치지 않음.
- V3는 기존 V1 진입신호와 실행/비용 엔진을 재사용하며 필터는 신호시점까지의 닫힌 과거 데이터만 사용함.

| 시장 | 종목 | 방향 | 상태 | 판정 | 2025 수익률 V2→V3 | 성공률 | PF | MDD | 거래수 | 후보수 | 선택 필터 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_SPOT | USDT-ETH | long | v3_research_hold | reject | 2.09% → -4.12% | 37.50% → 0.00% | 1.41 → 0.00 | 3.07% → 4.12% | 8 → 4 | 27 | RVOL≥0.9, VolExp≥0.9, Trend/ATR≥0.8 |
| CRYPTO_FUTURES | BTCUSDT | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | BTCUSDT | short | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | ETHUSDT | long | v3_research_hold | no_candidate | -0.70% → -% | 33.33% → -% | 0.92 → - | 4.16% → -% | 12 → - | 27 | - |
| CRYPTO_FUTURES | ETHUSDT | short | v3_research_hold | no_candidate | 5.50% → -% | 62.50% → -% | 2.71 → - | 1.03% → -% | 8 → - | 27 | - |

# V5 가격구조·돌파후 재테스트·ATR 변동성 독립검증

- 개발/탐색: 2020-01-01 ~ 2024-12-31
- 독립 검증: 2025-01-01 ~ 2025-12-31
- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지
- BTC의 V2 채택후보는 재튜닝하지 않음. ETH의 V2 보류·실패 케이스에만 V5 구조 확인을 적용함.
- V5 후보공간: 구조 lookback 2단계 × 돌파 recency 3단계 × 재테스트 ATR 허용 3단계 × ATR% regime 2단계 = 최대 36개.
- Long은 이전 고점 종가돌파 후 해당 레벨 재테스트, Short는 이전 저점 종가이탈 후 해당 레벨 재테스트를 대칭 적용함.
- 수익률·성공률을 단일 점수로 합치지 않고 PF·MDD·거래수까지 독립 검증함.
- 모든 구조·변동성 필터는 신호 시점과 그 이전의 닫힌 봉만 사용하며 기존 V1 실행·비용 엔진을 재사용함.

| 시장 | 종목 | 방향 | 상태 | 판정 | 2025 수익률 V2→V5 | 성공률 | PF | MDD | 거래수 | 후보수 | 선택 구조 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_SPOT | USDT-ETH | long | v5_research_hold | no_candidate | 2.09% → -% | 37.50% → -% | 1.41 → - | 3.07% → -% | 8 → - | 36 | - |
| CRYPTO_FUTURES | BTCUSDT | long | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | BTCUSDT | short | v2_frozen_not_retested | V2 유지 | - | - | - | - | - | 0 | 동결 후보 재튜닝 안 함 |
| CRYPTO_FUTURES | ETHUSDT | long | v5_research_hold | no_candidate | -0.70% → -% | 33.33% → -% | 0.92 → - | 4.16% → -% | 12 → - | 36 | - |
| CRYPTO_FUTURES | ETHUSDT | short | v5_research_hold | no_candidate | 5.50% → -% | 62.50% → -% | 2.71 → - | 1.03% → -% | 8 → - | 36 | - |

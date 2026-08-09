# 장기 V1 실제데이터 백테스트 + V2 시장별 수식 탐색

- 사용자 요청 범위: 2020-01-01 ~ 2026-08-09
- V2 탐색 개발구간: 2020-01-01 ~ 2024-12-31
- V2 독립 검증구간: 2025-01-01 ~ 2025-12-31
- 2026 최종 홀드아웃: 잠금 유지 (V1/V2 수식 선택에 사용하지 않음)
- 초기자금: 1,000,000원
- V2는 수익률과 성공률을 하나의 가중점수로 섞지 않음. 개발구간에서 성공률 비퇴행 조건의 수익률 리더와 수익률 비퇴행 조건의 성공률 리더만 2025 검증으로 넘김.
- 현물 가격: Bitget 공개 데이터. 선물 장기 가격·펀딩: Binance Vision USD-M 월별 공개 아카이브(2020~2025, SHA-256 검증).
- 선물 결과는 Bitget 장기 이력이 부족해 Binance 가격·펀딩을 사용한 교차거래소 proxy 연구이며, Bitget의 정확한 과거 체결 재현으로 해석하지 않음.
- 비용 가정: 목표 실행거래소 Bitget의 표준 taker 연구 가정 + 고정 slippage/spread. 계정별·과거 실제 수수료와 완전히 동일하다고 간주하지 않음.

## V1 기준선 결과

| 시장 | 종목 | 방향 | 가격 데이터 | 시작금 | 최종금 | 순수익률 | 성공률 | PF | MDD | 거래수 | 데이터 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | bitget-public-v2 | 1,000,000원 | 1,009,153원 | 0.92% | 36.11% | 1.04 | 5.45% | 36 | coverage_through_asof |
| CRYPTO_SPOT | USDT-ETH | long | bitget-public-v2 | 1,000,000원 | 1,032,535원 | 3.25% | 37.50% | 1.12 | 10.91% | 40 | coverage_through_asof |
| CRYPTO_FUTURES | BTCUSDT | long | binance-vision-usdm-monthly | 1,000,000원 | 960,702원 | -3.93% | 33.33% | 0.86 | 9.67% | 39 | coverage_through_asof |
| CRYPTO_FUTURES | BTCUSDT | short | binance-vision-usdm-monthly | 1,000,000원 | 983,273원 | -1.67% | 33.33% | 0.91 | 5.08% | 27 | coverage_through_asof |
| CRYPTO_FUTURES | ETHUSDT | long | binance-vision-usdm-monthly | 1,000,000원 | 1,047,396원 | 4.74% | 40.00% | 1.17 | 10.92% | 40 | coverage_through_asof |
| CRYPTO_FUTURES | ETHUSDT | short | binance-vision-usdm-monthly | 1,000,000원 | 1,052,005원 | 5.20% | 42.31% | 1.35 | 5.93% | 26 | coverage_through_asof |

## V2 시장별 수식 탐색 — 2025 독립 검증

| 시장 | 종목 | 방향 | 상태 | 판정 | 검증 수익률 V1→V2 | 검증 성공률 V1→V2 | 검증 MDD V1→V2 | 후보수 | 선택 수식 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | v2_candidate_frozen_for_holdout | adopt_candidate | -3.53% → -0.04% | 22.22% → 35.71% | 4.37% → 3.19% | 242 | EMA 10/80, ATR 14, pullback 1%, stop 1.5ATR, target 2R |
| CRYPTO_SPOT | USDT-ETH | long | v2_research_hold | tradeoff_review | 1.68% → 2.09% | 42.86% → 37.50% | 2.06% → 3.07% | 242 | EMA 10/80, ATR 14, pullback 0.25%, stop 1.25ATR, target 2.5R |
| CRYPTO_FUTURES | BTCUSDT | long | v2_candidate_frozen_for_holdout | adopt_candidate | -2.55% → 1.28% | 25.00% → 33.33% | 3.39% → 2.10% | 485 | EMA 8/30, ATR 14, pullback 0.75%, stop 2ATR, target 3R |
| CRYPTO_FUTURES | BTCUSDT | short | v2_candidate_frozen_for_holdout | adopt_candidate | 2.78% → 4.69% | 60.00% → 60.00% | 2.01% → 1.88% | 485 | EMA 12/30, ATR 14, pullback 0.25%, stop 1.5ATR, target 3R |
| CRYPTO_FUTURES | ETHUSDT | long | v2_research_hold | reject | -0.34% → -0.70% | 33.33% → 33.33% | 2.10% → 4.16% | 485 | EMA 8/80, ATR 14, pullback 0.75%, stop 1ATR, target 2R |
| CRYPTO_FUTURES | ETHUSDT | short | v2_research_hold | reject | 7.55% → 5.50% | 83.33% → 62.50% | 1.02% → 1.03% | 485 | EMA 20/30, ATR 14, pullback 0.5%, stop 1ATR, target 2R |

## 데이터 커버리지

| 데이터셋 | 시장 | 공급자 | 상태 | 실제 시작 | 실제 종료 | 캔들 | 펀딩 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bitget-btcusdt-spot-1d | CRYPTO_SPOT | bitget-public-v2 | coverage_through_asof | 2020-01-01 | 2026-08-07 | 2,411 | - |
| bitget-ethusdt-spot-1d | CRYPTO_SPOT | bitget-public-v2 | coverage_through_asof | 2020-01-01 | 2026-08-07 | 2,411 | - |
| binance-btcusdt-futures-1d | CRYPTO_FUTURES | binance-vision-usdm-monthly | coverage_through_asof | 2020-01-01 | 2025-12-31 | 2,192 | 6,576 |
| binance-ethusdt-futures-1d | CRYPTO_FUTURES | binance-vision-usdm-monthly | coverage_through_asof | 2020-01-01 | 2025-12-31 | 2,192 | 6,576 |

## 아직 차단된 시장

| 시장 | 상태 | 이유 |
| --- | --- | --- |
| KR_STOCK | blocked_provider_not_integrated | A reproducible no-secret historical provider with delisted/universe safeguards is not integrated yet; no synthetic returns are allowed. |
| US_STOCK | blocked_provider_not_integrated | A reproducible no-secret historical provider with corporate-action and delisted/universe safeguards is not integrated yet; no synthetic returns are allowed. |

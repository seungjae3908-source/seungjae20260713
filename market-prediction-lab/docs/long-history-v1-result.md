# 장기 V1 실제데이터 백테스트

- 요청 데이터 범위: 2020-01-01 ~ 2026-08-09
- 전략 최적화용 지표 종료일: 2025-12-31
- 2026 최종 홀드아웃: 잠금 유지 (V1/V2 튜닝에 사용하지 않음)
- 초기자금: 1,000,000원
- 비용 가정: Bitget 표준 taker 기준 연구 가정 + 고정 slippage/spread. 계정별·과거 실제 수수료와 완전히 동일하다고 간주하지 않음.

## 결과

| 시장 | 종목 | 방향 | 시작금 | 최종금 | 순수익률 | 성공률 | PF | MDD | 거래수 | 데이터 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | 1,000,000원 | 1,009,153원 | 0.92% | 36.11% | 1.04 | 5.45% | 36 | partial_coverage |
| CRYPTO_SPOT | USDT-ETH | long | 1,000,000원 | 1,032,535원 | 3.25% | 37.50% | 1.12 | 10.91% | 40 | partial_coverage |

## 데이터 커버리지

| 데이터셋 | 시장 | 상태 | 실제 시작 | 실제 종료 | 캔들 | 펀딩 |
| --- | --- | --- | --- | --- | --- | --- |
| bitget-btcusdt-spot-1d | CRYPTO_SPOT | partial_coverage | 2020-01-01 | 2026-08-07 | 2,411 | - |
| bitget-ethusdt-spot-1d | CRYPTO_SPOT | partial_coverage | 2020-01-01 | 2026-08-07 | 2,411 | - |
| bitget-btcusdt-futures-1d | CRYPTO_FUTURES | partial_coverage | 2026-05-10 | 2026-08-07 | 90 | 270 |
| bitget-btcusdt-futures-1d | CRYPTO_FUTURES | blocked_collection_error | - | - | 0 | - |
| bitget-ethusdt-futures-1d | CRYPTO_FUTURES | partial_coverage | 2026-05-10 | 2026-08-07 | 90 | 270 |
| bitget-ethusdt-futures-1d | CRYPTO_FUTURES | blocked_collection_error | - | - | 0 | - |

## 아직 차단된 시장

| 시장 | 상태 | 이유 |
| --- | --- | --- |
| KR_STOCK | blocked_provider_not_integrated | A reproducible no-secret historical provider with delisted/universe safeguards is not integrated yet; no synthetic returns are allowed. |
| US_STOCK | blocked_provider_not_integrated | A reproducible no-secret historical provider with corporate-action and delisted/universe safeguards is not integrated yet; no synthetic returns are allowed. |

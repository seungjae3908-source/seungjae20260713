# 2026 최종 홀드아웃 — 동결 후보 1회 평가

- 평가 구간: 2026-01-01 ~ 2026-08-07 (UTC 일봉, 완전히 닫힌 데이터까지만)
- 초기자금: 1,000,000원 / 후보별 독립 평가
- 후보 manifest SHA-256: `475acbec2df66cea18f3d5b2b2212e739d18a3148b58db5dc6ca2dd9511d8b20`
- 2026 데이터로 후보 탐색·파라미터 수정·재튜닝: **0건**
- V2/V6 후보는 2020~2024 개발 + 2025 독립검증에서 이미 동결된 값만 사용함.
- 현물 가격은 Bitget public. 선물 가격은 기존 개발/검증과 같은 Binance Vision USD-M 정적 아카이브(월별 + 2026-08 일별, SHA-256 검증).
- 선물 funding은 Binance Vision 월별을 2026-07까지 유지하고 아직 월별 아카이브가 확정되지 않은 2026-08만 Bitget public funding을 사용함.
- Binance 거래 REST API는 GitHub Actions 지역에서 451이므로 사용하지 않으며, 정적 공개 아카이브만 사용함.
- effect=positive는 순수익>0, expectancy>0, PF>1을 동시에 뜻함. 표본 30회 미만은 promotionEvidence=false로 유지함.

| 시장 | 종목 | 방향 | 동결버전 | 데이터종료 | 시작금 | 최종금 | 순수익률 | 성공률 | PF | MDD | 거래수 | 효과 | 표본 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRYPTO_SPOT | USDT-BTC | long | V2 | 2026-08-07 | 1,000,000원 | 978,895원 | -2.11% | 0.00% | 0.00 | 2.11% | 2 | negative_or_unstable | low |
| CRYPTO_FUTURES | BTCUSDT | long | V2 | 2026-08-07 | 1,000,000원 | 970,885원 | -2.91% | 25.00% | 0.06 | 3.10% | 4 | negative_or_unstable | low |
| CRYPTO_FUTURES | BTCUSDT | short | V2 | 2026-08-07 | 1,000,000원 | 969,234원 | -3.08% | 0.00% | 0.00 | 3.08% | 4 | negative_or_unstable | low |
| CRYPTO_SPOT | USDT-ETH | long | V6 | 2026-08-07 | 1,000,000원 | 978,855원 | -2.11% | 0.00% | 0.00 | 2.11% | 2 | negative_or_unstable | low |
| CRYPTO_FUTURES | ETHUSDT | long | V6 | 2026-08-07 | 1,000,000원 | 1,027,745원 | 2.77% | 66.67% | 3.55 | 1.07% | 3 | positive | low |

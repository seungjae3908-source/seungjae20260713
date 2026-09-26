# Market Intelligence Sidecar v1

Independent, loopback-only intelligence service for Scanner quality scoring and future auto-trading confirmation.

## Market roles

- `CRYPTO_FUTURES`: order-book imbalance, microprice, OFI, CVD, absorption, liquidity-wall withdrawal, OI change, funding, long/short crowding, liquidation imbalance.
- `CRYPTO_SPOT`: order-book imbalance, microprice, OFI, CVD, absorption, liquidity-wall withdrawal.
- `KR_STOCK`: accepts normalized stock order-book/trade evidence as a soft quality layer.
- `US_STOCK`: same microstructure layer plus normalized microcap structural evidence for ATM/shelf/warrant/share-growth/cash-runway/reverse-split/short-pressure analysis.

## Scanner contract

Scanner output is a bounded adjustment and evidence payload. Optional intelligence absence is reported instead of force-removing a candidate. Only explicit safety/data failures can produce `hardBlockReason`.

## Auto-trading contract

This service never submits orders. It reports `PAPER_ONLY` until explicit forward evidence meets the versioned policy. The maximum promotion state is `ELIGIBLE_FOR_PARENT_GATE`, which still requires the parent Profit/Risk/Portfolio/Execution gates.

## Endpoints

- `GET /health`
- `GET /v1/contracts`
- `POST /v1/evaluate`
- `GET /v1/public/crypto/futures/:symbol` — Bitget UTA v3 public-only evidence
- `GET /v1/public/crypto/spot/:market` — Upbit public-only evidence, e.g. `KRW-BTC`

Default bind: `127.0.0.1:8791`.

# Bitget shadow collection

This collector is intentionally isolated from `api-server` and uses only Bitget public GET market-data endpoints.

## Safety

- No API key, signature, passphrase, account, position or order endpoint.
- No import from `api-server` or `stock-analyzer`.
- Conservative request pacing (about 6-8 requests/sec) even though the documented public limit is higher.
- Timeout, retry, 429 handling, transient maintenance-code handling and infinite-pagination protection.
- Raw normalized snapshots are written atomically and deduplicated by SHA-256.
- OI, funding, market, mark and index-price context is appended only when its content changes.
- Financial decimal source strings are preserved alongside calculation numbers.
- The collector is a manual/offline command only. It is not registered in PM2, systemd, cron or the root workspace.

## Example

```bash
cd market-prediction-lab
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol BTCUSDT --timeframe 15m --days 52
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol ETHUSDT --timeframe 1h --days 83
node scripts/collect-bitget.js --market CRYPTO_SPOT --symbol BTCUSDT --timeframe 4h --days 240
```

The initial ranges match Bitget's documented recent-candle availability. Longer history is requested through the historical endpoint in bounded pages and must pass completeness checks before training.

## Live verification

A temporary branch-only GitHub Actions job ran on 2026-07-30 KST and was deleted after completion. It performed the full standalone validation suite before contacting Bitget.

- Market: `CRYPTO_FUTURES`
- Symbol: `BTCUSDT`
- Timeframe: `15m`
- Range: recent one-day sample
- Candles: 95
- Time gaps: 0
- Zero-volume candles: 0
- Maximum interval: 900000 ms
- Futures context: OI, current funding, 100 historical funding records, market/mark/index price
- Result: pass

Only the summary and candle-file SHA-256 are committed in `docs/live-smoke-result.json`; raw live market data remains outside the repository.

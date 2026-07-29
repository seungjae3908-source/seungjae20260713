# Bitget shadow collection

This collector is intentionally isolated from `api-server` and uses only Bitget public GET market-data endpoints.

## Safety

- No API key, signature, passphrase, account, position or order endpoint.
- No import from `api-server` or `stock-analyzer`.
- Conservative request pacing (about 6-8 requests/sec) even though the documented public limit is higher.
- Timeout, retry, 429 handling, transient maintenance-code handling and infinite-pagination protection.
- Raw normalized snapshots are written atomically and deduplicated by SHA-256.
- OI, funding, market, mark and index-price context is appended only when its content changes.
- The collector is a manual/offline command only. It is not registered in PM2, systemd, cron or the root workspace.

## Example

```bash
cd market-prediction-lab
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol BTCUSDT --timeframe 15m --days 52
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol ETHUSDT --timeframe 1h --days 83
node scripts/collect-bitget.js --market CRYPTO_SPOT --symbol BTCUSDT --timeframe 4h --days 240
```

The initial ranges match Bitget's documented recent-candle availability. Longer history is requested through the historical endpoint in bounded pages and must pass completeness checks before training.

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

## Pagination rule

Bitget documents `endTime` as an exclusive boundary: the endpoint returns candles before that timestamp. The next backward-page cursor is therefore the oldest timestamp returned by the current page. Subtracting another candle interval would skip one candle at every page boundary.

The collector tests this behavior with a multi-page exclusive-end mock and asserts that every adjacent timestamp differs by exactly one timeframe interval.

## Example

```bash
cd market-prediction-lab
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol BTCUSDT --timeframe 15m --days 52
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol ETHUSDT --timeframe 1h --days 83
node scripts/collect-bitget.js --market CRYPTO_SPOT --symbol BTCUSDT --timeframe 4h --days 240
```

The initial ranges match Bitget's documented recent-candle availability. Longer history is requested through the historical endpoint in bounded pages and must pass completeness checks before training.

## Live verification

Temporary branch-only GitHub Actions jobs ran on 2026-07-30 KST and were deleted after completion. They performed the full standalone validation suite before contacting Bitget.

### One-day smoke

- Market: `CRYPTO_FUTURES`
- Symbol: `BTCUSDT`
- Timeframe: `15m`
- Candles: 95
- Time gaps: 0
- Zero-volume candles: 0
- Maximum interval: 900000 ms
- Futures context: OI, current funding, 100 historical funding records, market/mark/index price
- Result: pass

### 52-day validation

The first long-range run detected 24 missing intervals. The count matched page boundaries, leading to the exclusive-`endTime` cursor fix. After the fix:

- Candles: 4,991
- Time gaps: 0
- Duplicates: 0
- Out-of-order rows: 0
- Rejected rows: 0
- Zero-volume candles: 0
- Normalized quality: `clean`
- Training records: 1,196
- Purged walk-forward split: train 837, validation 177, test 178
- Purged at boundaries: 2 + 2 records
- Result: pass

Only summaries and candle/dataset SHA-256 values are committed in `docs/live-smoke-result.json` and `docs/btcusdt-15m-52d-result.json`; raw live market data remains outside the repository.

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

Bitget documents `endTime` as the boundary for candles before that timestamp. The next backward-page cursor is therefore the oldest timestamp returned by the current page. Subtracting another candle interval would skip one candle at every page boundary.

The collector tests this behavior with 5,000 candles across at least 25 pages and asserts that every adjacent timestamp differs by exactly one timeframe interval.

## Targeted gap repair

After the initial collection, the 52-day verifier scans every adjacent timestamp. When a real gap remains:

1. Only the missing time window and one boundary candle on each side are requested again.
2. Only candles actually returned by Bitget are merged.
3. Existing finished candles are never silently overwritten; a value conflict fails closed.
4. A second pass is allowed only when the missing-candle count decreased.
5. Unresolved timestamps are written to `gap-repair-report.json` and the dataset build stops.
6. No synthetic or interpolated candle is generated.

## Example

```bash
cd market-prediction-lab
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol BTCUSDT --timeframe 15m --days 52
node scripts/collect-bitget.js --market CRYPTO_FUTURES --symbol ETHUSDT --timeframe 1h --days 83
node scripts/collect-bitget.js --market CRYPTO_SPOT --symbol BTCUSDT --timeframe 4h --days 240
```

The initial ranges match Bitget's documented recent-candle availability. Longer history is requested through the historical endpoint in bounded pages and must pass completeness checks before training.

## Live verification

A branch-only GitHub Actions workflow performs the full standalone validation suite before contacting Bitget. It is not a deployment workflow and does not access the production API or server.

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

The first long-range run detected 24 missing intervals. The count matched page boundaries, leading to the exclusive-page cursor fix. After the fix and targeted-repair layer:

- Candles: 4,991
- Initial gaps: 0
- Gap-repair requests required: 0
- Remaining gaps: 0
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

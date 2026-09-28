import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL('../../../' + path, import.meta.url), 'utf8');
}

test('current crypto Forward observer injects exact Scanner quality selection into ranking', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');
  const cryptoStart=observer.indexOf('async function scanCryptoLane');
  const cryptoEnd=observer.indexOf('async function stockFutureBars', cryptoStart);
  assert.ok(cryptoStart>=0&&cryptoEnd>cryptoStart);
  const cryptoLane=observer.slice(cryptoStart,cryptoEnd);
  assert.ok(cryptoLane.includes('selectForwardObserverScannerBacktests({'));
  assert.ok(cryptoLane.includes('backtests: qualitySelection.backtests'));
  assert.ok(ranking.includes("if (!backtest || !passesMinimumBacktestQuality(backtest)) return 'B'"));
});

test('current Spot SWING Forward lane is aligned to canonical 4H identity', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
  assert.ok(profiles.includes("CRYPTO_SPOT: {"));
  assert.ok(profiles.includes("SWING: { primary: '4H'"));
  assert.ok(runtime.includes("FORWARD_OBSERVER_SPOT_TIMEFRAME = '4H'"));
  assert.ok(runtime.includes("id: 'SPOT_SWING_4H'"));
  assert.equal(runtime.includes('SPOT_SWING_60M'), false);
  assert.ok(metadata.includes("blockers.push('PROMOTION_TIMEFRAME_MISMATCH')"));
});

test('Forward quality remains fail-closed instead of inventing caller backtest evidence', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const consumer=await source('api-server/src/services/forward-observer-scanner-quality-consumer.service.ts');
  assert.ok(observer.includes('selectForwardObserverScannerBacktests('));
  assert.equal(observer.includes("status: 'verified'"), false);
  assert.ok(consumer.includes('datasetSnapshotHash'));
  assert.ok(consumer.includes('researchCodeSha'));
});

test('stock Scanner call itself remains independent from Forward quality injection', async()=>{
  const stock=await source('api-server/src/services/stock-signal-scanner.service.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');
  const start=stock.indexOf('const ranking = rankScannerCandidates');
  assert.ok(start>=0);
  const call=stock.slice(start,start+1400);
  assert.ok(call.includes('rankScannerCandidates({'));
  assert.equal(call.includes('backtests:'), false);
  assert.ok(ranking.includes("if (!backtest || !passesMinimumBacktestQuality(backtest)) return 'B'"));
});

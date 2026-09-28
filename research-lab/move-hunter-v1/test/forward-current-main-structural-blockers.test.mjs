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

  assert.match(cryptoLane,/selectForwardObserverScannerBacktests\\(\\{/u);
  assert.match(cryptoLane,/backtests:\\s*qualitySelection\\.backtests/u);
  assert.match(ranking,/if\\s*\\(!backtest\\s*\\|\\|\\s*!passesMinimumBacktestQuality\\(backtest\\)\\)\\s*return\\s*'B'/u);
});

test('current Spot SWING Forward lane is aligned to canonical 4H identity', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');

  assert.match(profiles,/CRYPTO_SPOT:\\s*\\{[\\s\\S]*?SWING:\\s*\\{\\s*primary:\\s*'4H'/u);
  assert.match(runtime,/FORWARD_OBSERVER_SPOT_TIMEFRAME\\s*=\\s*'4H'/u);
  assert.match(runtime,/SPOT_SWING_4H[\\s\\S]*?market:\\s*'CRYPTO_SPOT'[\\s\\S]*?timeframe:\\s*FORWARD_OBSERVER_SPOT_TIMEFRAME/u);
  assert.doesNotMatch(runtime,/SPOT_SWING_60M/u);
  assert.match(metadata,/if\\s*\\(identity\\.timeframe\\s*!==\\s*lane\\.timeframe\\)\\s*blockers\\.push\\('PROMOTION_TIMEFRAME_MISMATCH'\\)/u);
});

test('Forward quality remains fail-closed instead of inventing caller backtest evidence', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const consumer=await source('api-server/src/services/forward-observer-scanner-quality-consumer.service.ts');

  assert.match(observer,/selectForwardObserverScannerBacktests\\(/u);
  assert.doesNotMatch(observer,/backtests\\s*:\\s*\\{\\s*[A-Za-z0-9_]+\\s*:\\s*\\{\\s*status:\\s*['"]verified/u);
  assert.match(consumer,/BLOCKED_DATA|quality/u);
  assert.match(consumer,/datasetSnapshotHash|researchCodeSha/u);
});

test('stock Scanner call itself remains independent from Forward quality injection', async()=>{
  const stock=await source('api-server/src/services/stock-signal-scanner.service.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');
  const start=stock.indexOf('const ranking = rankScannerCandidates');
  assert.ok(start>=0);
  const call=stock.slice(start,start+1400);
  assert.match(call,/rankScannerCandidates\\(\\{/u);
  assert.doesNotMatch(call,/backtests\\s*:/u);
  assert.match(ranking,/if\\s*\\(!backtest\\s*\\|\\|\\s*!passesMinimumBacktestQuality\\(backtest\\)\\)\\s*return\\s*'B'/u);
});

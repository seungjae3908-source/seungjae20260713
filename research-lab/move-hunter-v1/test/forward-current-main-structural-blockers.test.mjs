import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('current crypto Forward observer ranking has no backtest input, so grade fallback remains B', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');

  const cryptoStart=observer.indexOf('async function scanCryptoLane');
  const cryptoEnd=observer.indexOf('async function stockFutureBars', cryptoStart);
  assert.ok(cryptoStart>=0&&cryptoEnd>cryptoStart);
  const cryptoLane=observer.slice(cryptoStart,cryptoEnd);

  assert.match(cryptoLane,/rankScannerCandidates\(\{[\s\S]*?cards:\s*aligned\.cards[\s\S]*?strategy:\s*'swing'[\s\S]*?limit:\s*10[\s\S]*?\}\)/u);
  assert.doesNotMatch(cryptoLane,/backtests\s*:/u);
  assert.match(ranking,/if\s*\(!backtest\s*\|\|\s*!passesMinimumBacktestQuality\(backtest\)\)\s*return\s*'B'/u);
});

test('current Spot SWING 4H profile cannot exact-match the 60m Forward observer lane', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');

  assert.match(profiles,/CRYPTO_SPOT:\s*\{[\s\S]*?SWING:\s*\{\s*primary:\s*'4H'/u);
  assert.match(runtime,/SPOT_SWING_60M[\s\S]*?market:\s*'CRYPTO_SPOT'[\s\S]*?timeframe:\s*FORWARD_OBSERVER_TIMEFRAME/u);
  assert.match(runtime,/FORWARD_OBSERVER_TIMEFRAME\s*=\s*'60m'/u);
  assert.match(metadata,/if\s*\(identity\.timeframe\s*!==\s*lane\.timeframe\)\s*blockers\.push\('PROMOTION_TIMEFRAME_MISMATCH'\)/u);
});

test('Forward remains fail-closed instead of rewriting canonical timeframe or inventing backtest evidence', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');

  assert.doesNotMatch(observer,/primaryTimeframe\s*=\s*'60m'/u);
  assert.doesNotMatch(observer,/backtests\s*:\s*\{/u);
  assert.doesNotMatch(metadata,/identity\.timeframe\s*=\s*lane\.timeframe/u);
});


test('current stock Scanner ranking also omits backtest map, making S/A structurally unreachable through this call', async()=>{
  const stock=await source('api-server/src/services/stock-signal-scanner.service.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');
  const start=stock.indexOf('const ranking = rankScannerCandidates');
  assert.ok(start>=0);
  const call=stock.slice(start,start+1400);
  assert.match(call,/rankScannerCandidates\(\{/u);
  assert.doesNotMatch(call,/backtests\s*:/u);
  assert.match(ranking,/if\s*\(!backtest\s*\|\|\s*!passesMinimumBacktestQuality\(backtest\)\)\s*return\s*'B'/u);
});

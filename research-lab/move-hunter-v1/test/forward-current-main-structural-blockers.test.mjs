import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('current crypto Forward observer consumes exact Scanner quality only through canonical selector', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const consumer=await source('api-server/src/services/forward-observer-scanner-quality-consumer.service.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');

  const cryptoStart=observer.indexOf('async function scanCryptoLane');
  const cryptoEnd=observer.indexOf('async function stockFutureBars', cryptoStart);
  assert.ok(cryptoStart>=0&&cryptoEnd>cryptoStart);
  const cryptoLane=observer.slice(cryptoStart,cryptoEnd);

  assert.match(cryptoLane,/selectForwardObserverScannerBacktests\(\{[\s\S]*?artifact:\s*scannerQuality[\s\S]*?lane[\s\S]*?researchCodeSha[\s\S]*?\}\)/u);
  assert.match(cryptoLane,/rankScannerCandidates\(\{[\s\S]*?cards:\s*aligned\.cards[\s\S]*?backtests:\s*qualitySelection\.backtests[\s\S]*?limit:\s*10[\s\S]*?\}\)/u);
  assert.match(consumer,/entry\.quality\.oos\s*!==\s*true/u);
  assert.match(consumer,/entry\.quality\.walkForward\s*!==\s*true/u);
  assert.match(consumer,/entry\.quality\.costsIncluded\s*!==\s*true/u);
  assert.match(ranking,/if\s*\(!backtest\s*\|\|\s*!passesMinimumBacktestQuality\(backtest\)\)\s*return\s*'B'/u);
});

test('current Spot SWING profile and Forward observer lane are exact-aligned at 4H', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');

  assert.match(profiles,/CRYPTO_SPOT:\s*\{[\s\S]*?SWING:\s*\{\s*primary:\s*'4H'/u);
  assert.match(runtime,/FORWARD_OBSERVER_SPOT_TIMEFRAME\s*=\s*'4H'/u);
  assert.match(runtime,/SPOT_SWING_4H[\s\S]*?market:\s*'CRYPTO_SPOT'[\s\S]*?timeframe:\s*FORWARD_OBSERVER_SPOT_TIMEFRAME/u);
  assert.match(metadata,/identity\.timeframe\s*!==\s*lane\.timeframe/u);
});

test('Forward quality bridge remains fail-closed and cannot invent quality when artifact is absent', async()=>{
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const consumer=await source('api-server/src/services/forward-observer-scanner-quality-consumer.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');

  assert.match(observer,/scannerQualityRoot[\s\S]*?readForwardObserverScannerQualityArtifact/u);
  assert.match(consumer,/if\s*\(!input\.artifact\)\s*\{[\s\S]*?status:\s*'UNAVAILABLE'[\s\S]*?backtests:\s*Object\.freeze\(\{\}\)/u);
  assert.match(consumer,/profitabilityClaimAllowed:\s*false/u);
  assert.doesNotMatch(metadata,/identity\.timeframe\s*=\s*lane\.timeframe/u);
});

test('current stock Scanner direct ranking still has no internal backtest map; Forward re-ranks only when exact quality is supplied', async()=>{
  const stock=await source('api-server/src/services/stock-signal-scanner.service.ts');
  const observer=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');

  const start=stock.indexOf('const ranking = rankScannerCandidates');
  assert.ok(start>=0);
  const call=stock.slice(start,start+1400);
  assert.match(call,/rankScannerCandidates\(\{/u);
  assert.doesNotMatch(call,/backtests\s*:/u);
  assert.match(ranking,/if\s*\(!backtest\s*\|\|\s*!passesMinimumBacktestQuality\(backtest\)\)\s*return\s*'B'/u);

  const stockStart=observer.indexOf('async function scanStockLane');
  const stockEnd=observer.indexOf('async function scanCryptoLane',stockStart);
  const stockLane=observer.slice(stockStart,stockEnd);
  assert.match(stockLane,/if\s*\(!scannerQuality\)[\s\S]*?cards:\s*sourcedCards/u);
  assert.match(stockLane,/backtests:\s*qualitySelection\.backtests/u);
});

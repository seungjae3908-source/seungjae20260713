import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('canonical Spot SWING remains 4H and swing policy supports 4H', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const quant=await source('api-server/src/services/scanner-quant-strategy.service.ts');
  assert.match(profiles,/CRYPTO_SPOT:\s*\{[\s\S]*?SWING:\s*\{\s*primary:\s*'4H'/u);
  assert.match(quant,/return\s*\['60m',\s*'4H'\]\.includes\(timeframe\)/u);
});

test('current Upbit scanner already has native 4H public candle support', async()=>{
  const crypto=await source('api-server/src/services/crypto-signal-scanner.service.ts');
  assert.match(crypto,/timeframe\s*===\s*'4H'[\s\S]*?\?\s*240/u);
  assert.match(crypto,/\/v1\/candles\/minutes\/\$\{unit\}/u);
  assert.match(crypto,/if\s*\(timeframe\s*===\s*'4H'\)\s*return\s*12\s*\*\s*60\s*\*\s*60_000/u);
});

test('current Spot Forward lane remains 60m and therefore conflicts with canonical 4H identity', async()=>{
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runner=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  assert.match(runtime,/SPOT_SWING_60M/u);
  assert.match(runtime,/FORWARD_OBSERVER_TIMEFRAME\s*=\s*'60m'/u);
  assert.match(metadata,/identity\.timeframe\s*!==\s*lane\.timeframe/u);
  assert.match(runner,/market,\s*strategyMode:\s*'swing',\s*timeframe:\s*'60m'/u);
  assert.match(runner,/candles\/minutes\/60/u);
});

test('Observer artifacts are research-SHA scoped so a future lane schema must not cross-credit old state', async()=>{
  const workflow=await source('.github/workflows/forward-recommendation-observer-cycle.yml');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
  assert.match(workflow,/forward-recommendation-observer-state-\$\{\{\s*inputs\.research_sha\s*\}\}/u);
  assert.match(workflow,/Observer research SHA mixing forbidden/u);
  assert.match(runtime,/RESEARCH_SHA_MISMATCH/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL('../../../' + path, import.meta.url), 'utf8');
}

test('canonical Spot SWING remains 4H and swing policy supports 4H', async()=>{
  const profiles=await source('api-server/src/services/scanner-strategy-profile.service.ts');
  const quant=await source('api-server/src/services/scanner-quant-strategy.service.ts');
  assert.ok(profiles.includes("CRYPTO_SPOT: {"));
  assert.ok(profiles.includes("SWING: { primary: '4H'"));
  assert.ok(quant.includes("return ['60m', '4H'].includes(timeframe)"));
});

test('current Upbit scanner has native 4H public candle support', async()=>{
  const crypto=await source('api-server/src/services/crypto-signal-scanner.service.ts');
  assert.ok(crypto.includes("timeframe === '4H'"));
  assert.ok(crypto.includes('? 240'));
  assert.ok(crypto.includes('/v1/candles/minutes/'));
});

test('current Spot Forward lane uses 4H and the runner follows lane timeframe', async()=>{
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
  const metadata=await source('api-server/src/services/forward-observer-canonical-metadata.service.ts');
  const runner=await source('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
  assert.ok(runtime.includes("FORWARD_OBSERVER_SPOT_TIMEFRAME = '4H'"));
  assert.ok(runtime.includes('SPOT_SWING_4H'));
  assert.equal(runtime.includes('SPOT_SWING_60M'), false);
  assert.ok(metadata.includes('identity.timeframe !== lane.timeframe'));
  assert.ok(runner.includes('timeframe: lane.timeframe'));
});

test('Observer artifacts remain research-SHA scoped across lane revisions', async()=>{
  const workflow=await source('.github/workflows/forward-recommendation-observer-cycle.yml');
  const runtime=await source('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
  const artifactKey='forward-recommendation-observer-state-' + '$' + '{{ inputs.research_sha }}';
  assert.ok(workflow.includes(artifactKey));
  assert.ok(workflow.includes('Observer research SHA mixing forbidden'));
  assert.ok(runtime.includes('RESEARCH_SHA_MISMATCH'));
});

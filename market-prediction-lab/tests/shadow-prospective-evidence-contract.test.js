import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const shadowUrl = new URL('../scripts/run-shadow-cycle.js', import.meta.url);

test('shadow accumulates public long-short evidence without bypassing training parity', async () => {
  const source = await readFile(shadowUrl, 'utf8');
  assert.match(source, /collectLongShortRatioHistory/);
  assert.match(source, /longShortSnapshots/);
  assert.match(source, /RESEARCH_TEMPORAL_LONG_SHORT_PERIOD/);
  assert.match(source, /openInterestTrainingParityConfirmed:\s*false/);
  assert.match(source, /longShortTrainingParityConfirmed:\s*false/);
  assert.doesNotMatch(source, /openInterestTrainingParityConfirmed:\s*true/);
  assert.doesNotMatch(source, /longShortTrainingParityConfirmed:\s*true/);
});

test('shadow reports unresolved canonical market feature sources instead of fabricating defaults', async () => {
  const source = await readFile(shadowUrl, 'utf8');
  assert.match(source, /CANONICAL_CRYPTO_BENCHMARK_SOURCE_NOT_DEFINED/);
  assert.match(source, /CANONICAL_CRYPTO_SENTIMENT_SOURCE_NOT_DEFINED/);
  assert.match(source, /defaultFeatureFallbackAllowed:\s*false/);
  assert.match(source, /syntheticFeatureFallbackAllowed:\s*false/);
  assert.match(source, /temporalEvidenceReadiness/);
});

test('shadow keeps public-only research safety while prospective evidence accumulates', async () => {
  const source = await readFile(shadowUrl, 'utf8');
  assert.match(source, /usesPublicMarketDataOnly:\s*true/);
  assert.match(source, /usesAccountOrOrderApi:\s*false/);
  assert.match(source, /actualOrders:\s*0/);
  assert.match(source, /privateAccountRequests:\s*0/);
  assert.match(source, /livePromotion:\s*false/);
});

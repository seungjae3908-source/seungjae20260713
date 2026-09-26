import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecommendationChangePercent } from './recommendation.service';

test('recommendation change percent preserves missing instead of fabricating zero', () => {
  assert.equal(normalizeRecommendationChangePercent(undefined), null);
  assert.equal(normalizeRecommendationChangePercent(null), null);
  assert.equal(normalizeRecommendationChangePercent(''), null);
  assert.equal(normalizeRecommendationChangePercent(Number.NaN), null);
  assert.equal(normalizeRecommendationChangePercent(Number.POSITIVE_INFINITY), null);
});

test('recommendation change percent preserves genuine finite values including zero', () => {
  assert.equal(normalizeRecommendationChangePercent(0), 0);
  assert.equal(normalizeRecommendationChangePercent(-1.25), -1.25);
  assert.equal(normalizeRecommendationChangePercent('2.5'), 2.5);
});

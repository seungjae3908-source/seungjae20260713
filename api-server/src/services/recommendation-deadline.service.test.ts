import assert from 'node:assert/strict';
import test from 'node:test';
import { withRecommendationDeadline } from './recommendation-deadline.ts';

test('recommendation analysis returns completed provider work without delay', async () => {
  const result = await withRecommendationDeadline(Promise.resolve('ok'), 50);
  assert.equal(result, 'ok');
});

test('recommendation analysis fails closed when one provider chain exceeds its budget', async () => {
  await assert.rejects(
    withRecommendationDeadline(new Promise(() => undefined), 5),
    /RECOMMENDATION_PROVIDER_TIMEOUT/,
  );
});

test('recommendation analysis rejects an invalid deadline', async () => {
  await assert.rejects(
    withRecommendationDeadline(Promise.resolve('ignored'), 0),
    /RECOMMENDATION_ANALYSIS_BUDGET_INVALID/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFundingRatePercent } from './futures-market-format';

test('funding rate converts decimal ratio to percent', () => {
  assert.equal(formatFundingRatePercent(0.000068), '0.0068%');
  assert.equal(formatFundingRatePercent(-0.000068), '-0.0068%');
});

test('funding rate keeps zero and hides invalid values', () => {
  assert.equal(formatFundingRatePercent(0), '0.0000%');
  assert.equal(formatFundingRatePercent(null), '확인 불가');
  assert.equal(formatFundingRatePercent(undefined), '확인 불가');
  assert.equal(formatFundingRatePercent(Number.NaN), '확인 불가');
  assert.equal(formatFundingRatePercent(Number.POSITIVE_INFINITY), '확인 불가');
});

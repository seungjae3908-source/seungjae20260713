import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeQuoteEvidenceTimestamp } from './market-data.service';

const NOW_MS = Date.parse('2026-09-10T10:00:00.000Z');

test('quote freshness keeps provider evidence time instead of request wall clock', () => {
  assert.equal(
    normalizeQuoteEvidenceTimestamp('2026-09-10T09:45:00.000Z', NOW_MS),
    '2026-09-10T09:45:00.000Z',
  );
});

test('quote freshness fails closed when provider time evidence is missing or malformed', () => {
  assert.equal(normalizeQuoteEvidenceTimestamp(undefined, NOW_MS), null);
  assert.equal(normalizeQuoteEvidenceTimestamp('', NOW_MS), null);
  assert.equal(normalizeQuoteEvidenceTimestamp('not-a-time', NOW_MS), null);
});

test('quote freshness rejects materially future provider evidence', () => {
  assert.equal(
    normalizeQuoteEvidenceTimestamp('2026-09-10T10:06:00.000Z', NOW_MS),
    null,
  );
  assert.equal(
    normalizeQuoteEvidenceTimestamp('2026-09-10T10:04:59.000Z', NOW_MS),
    '2026-09-10T10:04:59.000Z',
  );
});

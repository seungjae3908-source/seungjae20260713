import assert from 'node:assert/strict';
import test from 'node:test';
import { rssDateToIso } from './rss-date';

test('normalises RFC 822 RSS dates to UTC ISO 8601', () => {
  assert.equal(rssDateToIso('Fri, 16 Oct 2026 23:30:00 GMT'), '2026-10-16T23:30:00.000Z');
  assert.equal(rssDateToIso('Sat, 17 Oct 2026 09:00:00 +0900'), '2026-10-17T00:00:00.000Z');
  assert.equal(rssDateToIso('2026-10-17T00:00:00Z'), '2026-10-17T00:00:00.000Z');
});

test('returns null for empty or unparseable dates', () => {
  assert.equal(rssDateToIso(''), null);
  assert.equal(rssDateToIso(undefined), null);
  assert.equal(rssDateToIso('not a date'), null);
});

test('ISO output sorts chronologically where raw weekday strings did not', () => {
  const raw = ['Fri, 16 Oct 2026 01:00:00 GMT', 'Thu, 15 Oct 2026 01:00:00 GMT', 'Sat, 17 Oct 2026 01:00:00 GMT'];
  const sorted = raw.map(rssDateToIso).filter((value): value is string => value != null).sort().reverse();
  assert.deepEqual(sorted, ['2026-10-17T01:00:00.000Z', '2026-10-16T01:00:00.000Z', '2026-10-15T01:00:00.000Z']);
});

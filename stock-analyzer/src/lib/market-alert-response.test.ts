import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketAlertFeedContractError,
  parseMarketAlertFeed,
} from './market-alert-response';

const NOW = Date.parse('2026-09-09T05:40:00.000Z');
const alert = {
  id: 'KR:005930:movement',
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  kind: 'positive',
  category: '시세 변동',
  title: '삼성전자 상승 1.20%',
  importance: 'high',
  time: '2026-09-09T05:39:00.000Z',
  url: null,
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    market: 'ALL',
    positive: [alert],
    negative: [],
    alerts: [alert],
    updatedAt: '2026-09-09T05:39:30.000Z',
    ...overrides,
  };
}

test('market alert feed preserves canonical empty response', () => {
  assert.deepEqual(parseMarketAlertFeed({
    market: 'ALL',
    positive: [],
    negative: [],
    alerts: [],
    updatedAt: '2026-09-09T05:39:30.000Z',
  }, NOW), {
    market: 'ALL',
    positive: [],
    negative: [],
    alerts: [],
    updatedAt: '2026-09-09T05:39:30.000Z',
  });
});

test('market alert feed rejects missing arrays and partition drift', () => {
  assert.throws(() => parseMarketAlertFeed({ positive: [], negative: [] }, NOW), MarketAlertFeedContractError);
  assert.throws(
    () => parseMarketAlertFeed(envelope({ positive: [], negative: [] }), NOW),
    /partition mismatch/,
  );
  assert.throws(
    () => parseMarketAlertFeed(envelope({ negative: [{ ...alert, kind: 'positive' }] }), NOW),
    MarketAlertFeedContractError,
  );
});

test('market alert feed rejects missing row evidence and invalid enum values', () => {
  const missingName = { ...alert, name: undefined };
  assert.throws(
    () => parseMarketAlertFeed(envelope({ positive: [missingName], alerts: [missingName] }), NOW),
    MarketAlertFeedContractError,
  );
  const invalidImportance = { ...alert, importance: 'critical' };
  assert.throws(
    () => parseMarketAlertFeed(envelope({ positive: [invalidImportance], alerts: [invalidImportance] }), NOW),
    MarketAlertFeedContractError,
  );
});

test('market alert feed rejects stale envelope and future alert timestamps', () => {
  assert.throws(
    () => parseMarketAlertFeed(envelope({ updatedAt: '2026-09-09T05:35:00.000Z' }), NOW),
    /stale/,
  );
  const futureAlert = { ...alert, time: '2026-09-09T05:41:00.000Z' };
  assert.throws(
    () => parseMarketAlertFeed(envelope({ positive: [futureAlert], alerts: [futureAlert] }), NOW),
    /future/,
  );
});

test('market alert feed accepts bounded clock skew', () => {
  const skewed = { ...alert, time: '2026-09-09T05:40:20.000Z' };
  const parsed = parseMarketAlertFeed(envelope({
    positive: [skewed],
    alerts: [skewed],
    updatedAt: '2026-09-09T05:40:20.000Z',
  }), NOW);
  assert.equal(parsed.positive[0].time, '2026-09-09T05:40:20.000Z');
});

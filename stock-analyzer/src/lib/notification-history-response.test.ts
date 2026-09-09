import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NotificationHistoryContractError,
  parseNotificationHistory,
} from './notification-history-response';

const NOW = Date.parse('2026-09-09T05:30:00.000Z');
const rowFixture = {
  id: '11111111-1111-4111-8111-111111111111',
  notification_type: 'price_alert',
  title: '지정가 도달',
  body: '삼성전자가 지정가에 도달했습니다.',
  url: '/stock/005930',
  channel: 'web',
  read_at: null,
  created_at: '2026-09-09T05:29:30.000Z',
};

test('notification history preserves canonical empty history but rejects missing arrays', () => {
  assert.deepEqual(parseNotificationHistory({ notifications: [], count: 0 }, NOW), {
    notifications: [],
    count: 0,
  });

  assert.throws(() => parseNotificationHistory({}, NOW), NotificationHistoryContractError);
  assert.throws(
    () => parseNotificationHistory({ notifications: null, count: 0 }, NOW),
    NotificationHistoryContractError,
  );
});

test('notification history rejects count drift and missing row evidence', () => {
  assert.throws(
    () => parseNotificationHistory({ notifications: [rowFixture], count: 0 }, NOW),
    /count mismatch/,
  );
  assert.throws(
    () => parseNotificationHistory({ notifications: [{ ...rowFixture, title: undefined }], count: 1 }, NOW),
    NotificationHistoryContractError,
  );
  assert.throws(
    () => parseNotificationHistory({ notifications: [{ ...rowFixture, created_at: undefined }], count: 1 }, NOW),
    NotificationHistoryContractError,
  );
});

test('notification history rejects malformed and materially future timestamps', () => {
  assert.throws(
    () => parseNotificationHistory({ notifications: [{ ...rowFixture, created_at: 'not-a-time' }], count: 1 }, NOW),
    /valid timestamp/,
  );
  assert.throws(
    () => parseNotificationHistory({
      notifications: [{ ...rowFixture, created_at: '2026-09-09T05:31:00.000Z' }],
      count: 1,
    }, NOW),
    /in the future/,
  );
});

test('notification history accepts explicit empty title/body and bounded clock skew', () => {
  const parsed = parseNotificationHistory({
    notifications: [{
      ...rowFixture,
      title: '',
      body: '',
      created_at: '2026-09-09T05:30:20.000Z',
    }],
    count: 1,
  }, NOW);

  assert.equal(parsed.notifications[0].title, '');
  assert.equal(parsed.notifications[0].body, '');
});

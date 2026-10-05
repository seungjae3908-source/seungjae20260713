'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectProductionTradingGateCommandIdempotency,
} = require('./production-trading-gate-idempotency.cjs');

const SHA = 'a'.repeat(40);

function fixture(comments) {
  const listComments = () => undefined;
  return {
    github: {
      rest: { issues: { listComments } },
      paginate: async (fn, args) => {
        assert.equal(fn, listComments);
        assert.equal(args.issue_number, 1555);
        return comments;
      },
    },
    context: { repo: { owner: 'example', repo: 'repo' } },
  };
}

function receipt(id, status, {
  marker = '[PRODUCTION_LIVE_TRADING_GATE]',
  sha = SHA,
  createdAt = `2026-10-05T00:00:${String(id).padStart(2, '0')}.000Z`,
} = {}) {
  return {
    id,
    created_at: createdAt,
    body: [marker, `status: ${status}`, `target_sha: ${sha}`].join('\n'),
  };
}

test('same target and latest desired state is an idempotent duplicate', async () => {
  const result = await inspectProductionTradingGateCommandIdempotency({
    ...fixture([receipt(1, 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL')]),
    targetSha: SHA,
    marker: '[PRODUCTION_LIVE_TRADING_GATE]',
    desiredStatus: 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.latestCommentId, 1);
});

test('later opposite state permits a new activation on the same SHA', async () => {
  const result = await inspectProductionTradingGateCommandIdempotency({
    ...fixture([
      receipt(1, 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL'),
      receipt(2, 'DISABLED'),
    ]),
    targetSha: SHA,
    marker: '[PRODUCTION_LIVE_TRADING_GATE]',
    desiredStatus: 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.latestStatus, 'DISABLED');
});

test('later failure receipt does not hide behind an older successful desired state', async () => {
  const result = await inspectProductionTradingGateCommandIdempotency({
    ...fixture([
      receipt(1, 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL'),
      receipt(2, 'LIVE_TRADING_ACTIVATION_FAILED_ROLLED_BACK'),
    ]),
    targetSha: SHA,
    marker: '[PRODUCTION_LIVE_TRADING_GATE]',
    desiredStatus: 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.latestStatus, 'LIVE_TRADING_ACTIVATION_FAILED_ROLLED_BACK');
});

test('other SHA and other marker receipts are ignored', async () => {
  const result = await inspectProductionTradingGateCommandIdempotency({
    ...fixture([
      receipt(1, 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL', { sha: 'b'.repeat(40) }),
      receipt(2, 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL', {
        marker: '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]',
      }),
    ]),
    targetSha: SHA,
    marker: '[PRODUCTION_LIVE_TRADING_GATE]',
    desiredStatus: 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.latestStatus, null);
});

test('invalid idempotency identity fails closed', async () => {
  await assert.rejects(
    inspectProductionTradingGateCommandIdempotency({
      ...fixture([]),
      targetSha: 'bad',
      marker: '[PRODUCTION_LIVE_TRADING_GATE]',
      desiredStatus: 'ACTIVATED_SPOT_LIVE_LIMITED_MANUAL',
    }),
    /PRODUCTION_TRADING_GATE_IDEMPOTENCY_TARGET_SHA_INVALID/u,
  );
});


test('same desired state with different required parameters is not a duplicate', async () => {
  const futures = {
    id: 1,
    created_at: '2026-10-05T00:00:01.000Z',
    body: [
      '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]',
      'status: ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL',
      `target_sha: ${SHA}`,
      'max_leverage: 2',
      'margin_mode: isolated',
    ].join('\n'),
  };
  const result = await inspectProductionTradingGateCommandIdempotency({
    ...fixture([futures]),
    targetSha: SHA,
    marker: '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]',
    desiredStatus: 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL',
    requiredLines: ['max_leverage: 3', 'margin_mode: isolated'],
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.latestStatus, 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL');
});

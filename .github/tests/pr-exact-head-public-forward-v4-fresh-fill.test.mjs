import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL,
  collectBitgetForwardLiquidityObservationBatchV4,
} from '../../market-intelligence-sidecar/src/public-forward-liquidity-capture-seam-v4.mjs';
import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../../market-intelligence-sidecar/src/public-data.mjs';

const collectorCodeSha = 'a'.repeat(40);

function bookFrame({
  marketTimestampMs,
  requestStartedAtMs,
  receiveTimestampMs,
  bid = '100',
  ask = '101',
}) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    requestStartedAtMs,
    receiveTimestampMs,
    payload: {
      code: '00000',
      msg: 'success',
      data: {
        ts: String(marketTimestampMs),
        b: [[bid, '5']],
        a: [[ask, '5']],
      },
    },
  });
}

function tradesFrame({
  eventTimestampMs,
  requestStartedAtMs,
  receiveTimestampMs,
  execId,
}) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    requestStartedAtMs,
    receiveTimestampMs,
    payload: {
      code: '00000',
      msg: 'success',
      data: [{
        execId,
        execLinkId: execId,
        price: '101.5',
        size: '1',
        side: 'buy',
        ts: String(eventTimestampMs),
        isRPI: 'no',
      }],
    },
  });
}

test('v4 proposal stays inactive and preserves the frozen numeric capture parameters', () => {
  const proposal = PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL;
  assert.equal(proposal.status, 'DRAFT_PENDING_SEPARATE_HUMAN_TECHNICAL_AUTHORITY');
  assert.equal(proposal.numericPolicyChanged, false);
  assert.deepEqual(proposal.captureParameterPolicy, {
    eventObservationDelayMs: 2_000,
    postObservationDelaysMs: [1_000, 5_000],
    maxPreEventBookAgeMs: 5_000,
  });
  assert.equal(proposal.activationAllowed, false);
  assert.equal(proposal.prospectiveEconomicCreditAllowed, false);
  assert.equal(proposal.replayCredit, 0);
  assert.equal(proposal.backfillCredit, 0);
  assert.equal(proposal.syntheticCredit, 0);
  assert.equal(proposal.executionAuthority, 'NONE');
});

test('v4 uses a second public fills frame only when the first frame has no strict post-book event', async () => {
  const calls = [];
  const books = [
    bookFrame({ marketTimestampMs: 1_000, requestStartedAtMs: 900, receiveTimestampMs: 1_100 }),
    bookFrame({ marketTimestampMs: 3_200, requestStartedAtMs: 4_250, receiveTimestampMs: 4_300 }),
    bookFrame({ marketTimestampMs: 7_000, requestStartedAtMs: 8_000, receiveTimestampMs: 8_100 }),
  ];
  const trades = [
    tradesFrame({
      eventTimestampMs: 900,
      requestStartedAtMs: 3_000,
      receiveTimestampMs: 3_100,
      execId: 'stale-before-book',
    }),
    tradesFrame({
      eventTimestampMs: 3_000,
      requestStartedAtMs: 4_000,
      receiveTimestampMs: 4_200,
      execId: 'fresh-after-book',
    }),
  ];

  const batch = await collectBitgetForwardLiquidityObservationBatchV4({
    collectorCodeSha,
    fetchOrderBookFrame: async () => {
      calls.push('book');
      return books.shift();
    },
    fetchTradesFrame: async () => {
      calls.push('trades');
      return trades.shift();
    },
    sleep: async (delayMs) => calls.push(`sleep:${delayMs}`),
  });

  assert.deepEqual(calls, [
    'book',
    'sleep:2000',
    'trades',
    'sleep:2000',
    'trades',
    'sleep:1000',
    'book',
    'sleep:5000',
    'book',
  ]);
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].publicExecutionId, 'fresh-after-book');
  assert.equal(batch.v4TechnicalSelection.maxTradeFrameFetchN, 2);
  assert.equal(batch.v4TechnicalSelection.tradeFrameFetchN, 2);
  assert.equal(batch.v4TechnicalSelection.selectedTradeFrameFetchIndex, 1);
  assert.equal(batch.v4TechnicalSelection.economicCreditAllowed, false);
  assert.equal(batch.v4TechnicalSelection.outcomeInspectionUsed, false);
});

test('v4 remains fail-closed when every bounded public fills frame is older than the pre-event book', async () => {
  const books = [
    bookFrame({ marketTimestampMs: 1_000, requestStartedAtMs: 900, receiveTimestampMs: 1_100 }),
    bookFrame({ marketTimestampMs: 3_200, requestStartedAtMs: 4_250, receiveTimestampMs: 4_300 }),
    bookFrame({ marketTimestampMs: 7_000, requestStartedAtMs: 8_000, receiveTimestampMs: 8_100 }),
  ];
  let tradeFetchN = 0;

  const batch = await collectBitgetForwardLiquidityObservationBatchV4({
    collectorCodeSha,
    fetchOrderBookFrame: async () => books.shift(),
    fetchTradesFrame: async () => {
      tradeFetchN += 1;
      return tradesFrame({
        eventTimestampMs: 900,
        requestStartedAtMs: 2_000 + tradeFetchN * 1_000,
        receiveTimestampMs: 2_100 + tradeFetchN * 1_000,
        execId: `still-stale-${tradeFetchN}`,
      });
    },
    sleep: async () => undefined,
  });

  assert.equal(tradeFetchN, 2);
  assert.equal(batch.observations.length, 0);
  assert.equal(batch.droppedEvents.length, 1);
  assert.equal(batch.droppedEvents[0].reason, 'EVENT_NOT_AFTER_PRE_EVENT_BOOK');
  assert.equal(batch.v4TechnicalSelection.selectedTradeFrameFetchIndex, null);
  assert.equal(batch.v4TechnicalSelection.activationAllowed, false);
});

test('active V3 schedule and capture seam do not reference the inactive V4 proposal', () => {
  const workflow = fs.readFileSync(
    '.github/workflows/public-forward-liquidity-successor-scheduled-capture.yml',
    'utf8',
  );
  const v3Seam = fs.readFileSync(
    'market-intelligence-sidecar/src/public-forward-liquidity-successor-schedule-seam-v1.mjs',
    'utf8',
  );
  for (const source of [workflow, v3Seam]) {
    assert.doesNotMatch(source, /public-forward-liquidity-capture-seam-v4/u);
    assert.doesNotMatch(source, /collectBitgetForwardLiquidityObservationBatchV4/u);
  }
});

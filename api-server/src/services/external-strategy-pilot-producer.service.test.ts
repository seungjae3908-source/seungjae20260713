import assert from 'node:assert/strict';
import test from 'node:test';
import {
  produceUpbitTrendPullbackExternalPilot,
  type ExternalPilotAiReviewer,
} from './external-strategy-pilot-producer.service';
import type { UpbitPilotCandle, UpbitTrendPullbackPublicSnapshot } from './upbit-external-pilot-public-data.service';
import {
  externalStrategyPilotReasonsForLive,
  parseExternalStrategyPilotHandoffFile,
} from './member-auto-trading-background-worker.service';
import { validateMemberAutoTradingPaperHandoff } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const NOW = Date.parse('2026-10-13T23:37:00.000Z');
const SHA = 'a'.repeat(40);

function series(
  intervalMs: number,
  closeAt: (index: number) => number,
  volumeAt: (index: number) => number = () => 100,
): readonly UpbitPilotCandle[] {
  return Array.from({ length: 200 }, (_, index) => {
    const close = closeAt(index);
    const previousClose = index === 0 ? close : closeAt(index - 1);
    const open = (close + previousClose) / 2;
    return Object.freeze({
      time: NOW - intervalMs * (200 - index),
      open,
      high: Math.max(open, close) + 1.5,
      low: Math.min(open, close) - 1.5,
      close,
      volume: volumeAt(index),
      quoteVolume: volumeAt(index) * close,
    });
  });
}

function snapshot(overrides: Partial<UpbitTrendPullbackPublicSnapshot> = {}): UpbitTrendPullbackPublicSnapshot {
  const closes5 = Array.from({ length: 200 }, (_, index) => 10_800 + index + Math.sin(index / 3) * 7);
  closes5[194] = 10_989;
  closes5[195] = 10_986;
  closes5[196] = 10_984;
  closes5[197] = 10_987;
  closes5[198] = 10_990;
  closes5[199] = 10_998;
  const candles5m = series(5 * 60_000, (index) => closes5[index], (index) => index === 199 ? 260 : index >= 190 ? 130 : 100);
  const candles15m = series(15 * 60_000, (index) => 10_950 + index * 0.24 + Math.sin(index / 5) * 2);
  const candles60m = series(60 * 60_000, (index) => 10_000 + index * 5);
  return Object.freeze({
    schemaVersion: 'upbit-trend-pullback-public-snapshot-v1',
    symbol: 'KRW-BTC',
    fetchedAtMs: NOW,
    candles5m,
    candles15m,
    candles60m,
    orderbook: Object.freeze({
      observedAtMs: NOW - 500,
      bid: 10_997,
      ask: 10_999,
      bidSize: 20,
      askSize: 20,
      totalBidSize: 200,
      totalAskSize: 200,
      bidLevels: Object.freeze([{ price: 10_997, size: 20 }, { price: 10_996, size: 20 }]),
      askLevels: Object.freeze([{ price: 10_999, size: 20 }, { price: 11_000, size: 20 }]),
    }),
    provenance: Object.freeze(['https://api.upbit.com/v1/candles/minutes/5', 'https://api.upbit.com/v1/orderbook']),
    ...overrides,
  });
}

const passAi: ExternalPilotAiReviewer = {
  async review() {
    return Object.freeze({ status: 'PASS', provider: 'test-contract-ai', model: 'test-contract-model',
      reviewedAtMs: NOW, reason: 'CONTRACT_FIXTURE_PASS' });
  },
};

const costPolicy = Object.freeze({
  version: 'upbit-readback-cost-v1',
  commissionRate: 0.0005,
  observedAtMs: NOW - 1_000,
  provenance: 'TEST_FIXTURE_ACCOUNT_READBACK',
  quality: 'ACCOUNT_READBACK' as const,
});
test('structural fixture proves exact external envelope, risk and Worker contract without an order', async () => {
  const output = await produceUpbitTrendPullbackExternalPilot({
    serviceSha: SHA,
    snapshot: snapshot(),
    costPolicy,
    aiReviewer: passAi,
    nowMs: NOW,
  });
  assert.equal(output.observationKind, 'LIVE_PUBLIC_MARKET');
  assert.equal(output.state, 'READY', JSON.stringify(output.blockers));
  assert.equal(output.naturalCandidateCount, 1);
  assert.equal(output.riskAdmissionCount, 1);
  assert.equal(output.handoffEntryCount, 1);
  assert.equal(output.workerContractAdmissionCount, 0);
  const persisted = output.handoff as { handoff: unknown };
  const handoff = validateMemberAutoTradingPaperHandoff(persisted.handoff, NOW);
  assert.equal(handoff.entries[0].identity.strategyId, 'TREND_PULLBACK_REACCEL_V1');
  assert.equal(handoff.entries[0].identity.researchCodeSha, SHA);
  assert.equal(handoff.entries[0].safety.orderSubmitted, false);
  assert.equal(parseExternalStrategyPilotHandoffFile(output.handoff, NOW).entryCount, 1);
});

test('a natural formula candidate remains blocked when cost or AI proof is unavailable', async () => {
  const withoutCost = await produceUpbitTrendPullbackExternalPilot({
    serviceSha: SHA, snapshot: snapshot(), costPolicy: null, aiReviewer: passAi, nowMs: NOW,
  });
  assert.equal(withoutCost.state, 'BLOCKED_COST', JSON.stringify(withoutCost.metrics));
  assert.equal(withoutCost.naturalCandidateCount, 1);
  assert.equal(withoutCost.handoffEntryCount, 0);

  const withoutAi = await produceUpbitTrendPullbackExternalPilot({
    serviceSha: SHA, snapshot: snapshot(), costPolicy, aiReviewer: null, nowMs: NOW,
  });
  assert.equal(withoutAi.state, 'BLOCKED_AI', JSON.stringify(withoutAi.blockers));
  assert.equal(withoutAi.riskAdmissionCount, 1);
  assert.equal(withoutAi.handoffEntryCount, 0);
});

test('stale public orderbook is data-blocked before strategy, AI or risk', async () => {
  const stale = snapshot({ orderbook: Object.freeze({ ...snapshot().orderbook, observedAtMs: NOW - 31_000 }) });
  const output = await produceUpbitTrendPullbackExternalPilot({
    serviceSha: SHA, snapshot: stale, costPolicy, aiReviewer: passAi, nowMs: NOW,
  });
  assert.equal(output.state, 'BLOCKED_DATA');
  assert.equal(output.naturalCandidateCount, 0);
  assert.equal(output.riskAdmissionCount, 0);
  assert.equal(output.handoffEntryCount, 0);
});

test('Worker rejects structurally valid replay evidence from the external LIVE Pilot path', async () => {
  const output = await produceUpbitTrendPullbackExternalPilot({
    serviceSha: SHA, snapshot: snapshot(), costPolicy, aiReviewer: passAi, nowMs: NOW,
  });
  const persisted = output.handoff as { handoff: unknown };
  const handoff = validateMemberAutoTradingPaperHandoff(persisted.handoff, NOW);
  const entry = handoff.entries[0];
  const replayEntry = {
    ...entry,
    execution: {
      ...entry.execution,
      dataEvidence: { ...(entry.execution.dataEvidence as Record<string, unknown>), observationKind: 'HISTORICAL_REPLAY' },
    },
  };
  assert.throws(
    () => externalStrategyPilotReasonsForLive(replayEntry, NOW),
    /BACKGROUND_EXTERNAL_STRATEGY_LIVE_OBSERVATION_REQUIRED/u,
  );
});

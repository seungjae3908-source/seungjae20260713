import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAdapterInputForCard,
  explicitAdapterCostPolicy,
  selectSignalAdmittedHandoffEntries,
} from '../src/auto-trading-handoff-bridge.mjs';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const NOW = Date.UTC(2026, 9, 13, 12);
const SHA = '0123456789abcdef0123456789abcdef01234567';

function entry(market = 'CRYPTO_FUTURES', direction = 'LONG') {
  return {
    identity: {
      signalId: `signal:${market}:${direction}`, market, symbol: market === 'CRYPTO_SPOT' ? 'BTC' : market.includes('STOCK') ? 'AAPL' : 'BTCUSDT',
      timeframe: '60m', horizon: 1, direction, strategyId: 'profit-first-swing', strategyVersion: 'v1',
      parameterHash: 'params-v1', researchCodeSha: SHA, costPolicyVersion: 'cost-v1', executionAuthority: 'NONE',
    },
    profitEvidence: {
      status: 'READY', market, timeframe: '60m', direction, strategyVersion: 'v1', costPolicyId: 'cost-v1',
      expectedNetEdge: 1.2, expectedNetReturn: 0.8, riskRewardRatio: 2, sampleSize: 100, executionAuthority: 'NONE',
    },
    execution: { costPolicy: {
      version: 'cost-v1', commissionRate: .001, taxRate: 0, spreadRate: .002, slippageRate: .003,
      fundingRate: 0, latencyRate: .0001, liquidityImpactRate: .0002, partialFillImpactRate: .0003,
    } },
  };
}

function card(e = entry()) {
  const cash = e.identity.market !== 'CRYPTO_FUTURES';
  return {
    signalId: e.identity.signalId,
    assetClass: e.identity.market === 'CRYPTO_FUTURES' ? 'coin_futures' : e.identity.market === 'CRYPTO_SPOT' ? 'coin_spot' : 'stock',
    market: e.identity.market === 'KR_STOCK' ? 'KR' : e.identity.market === 'US_STOCK' ? 'US' : cash ? 'spot' : 'futures',
    symbol: e.identity.symbol,
    action: cash ? 'BUY' : e.identity.direction,
    direction: cash ? 'LONG' : e.identity.direction,
    aiValidation: { status: 'NOT_RUN', risks: [], counterEvidence: [] },
  };
}

function eligibleCard(e, nowMs) {
  return {
    ...card(e),
    price: 100,
    observedAt: new Date(nowMs - 1_000).toISOString(),
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    dataState: 'complete',
    dataQuality: { state: 'TRUSTED', strongSignalAllowed: true },
    strongSignalEligible: true,
    candidateRanking: { hardFilterPassed: true },
    signalGrade: 'A',
    riskLevel: 'LOW',
    pricePlan: { entryZone: { from: 99, to: 101 }, stopLoss: 95, targets: [110] },
    dataSources: ['fixture-public'],
  };
}

function row(e) {
  return {
    state: 'CANDIDATE', market: e.identity.market, symbol: e.identity.symbol, timeframe: e.identity.timeframe,
    direction: e.identity.direction, strategy: e.identity.strategyId.toUpperCase(),
    provenance: { paperIdentity: { ...e.identity } },
  };
}

function snapshot(rows) {
  return {
    policyVersion: 'signal-intelligence-v3.1', generatedAt: new Date(NOW).toISOString(),
    serviceSha: SHA, publicDataOnly: true, rosterBindingVersion: 1,
    safety: { executionAuthority: 'NONE', privateTradingApiAllowed: false, realOrderAllowed: false },
    lists: { krBuy: [], usBuy: [], spotBuy: [], futuresLong: rows, futuresShort: [] },
  };
}

test('canonical handoff rates are converted from decimal rates to explicit percentages', () => {
  const policy = explicitAdapterCostPolicy(entry());
  assert.equal(policy.id, 'cost-v1');
  assert.equal(policy.commissionPercent, 0.1);
  assert.equal(policy.slippagePercent, 0.3);
  assert.equal(policy.source, 'EXPLICIT_RUNTIME_POLICY');
});

test('scanner card receives evidence only on an exact signal identity join', () => {
  const candidate = entry();
  const joined = canonicalAdapterInputForCard(card(candidate), '60m', { status: 'READY', entries: [candidate] });
  assert.equal(joined.paperIdentity.signalId, candidate.identity.signalId);
  assert.equal(joined.profitEvidence.status, 'READY');
  assert.equal(joined.validationTier, 'FORWARD_VALIDATED');

  const mismatched = canonicalAdapterInputForCard(card(candidate), '15m', { status: 'READY', entries: [candidate] });
  assert.equal(mismatched.paperIdentity, undefined);
  assert.equal(mismatched.profitEvidence, undefined);
});

test('four-market candidates are admitted only when Signal V3 keeps the exact canonical identity', () => {
  const entries = [
    entry('KR_STOCK', 'BUY'), entry('US_STOCK', 'BUY'), entry('CRYPTO_SPOT', 'BUY'),
    entry('CRYPTO_FUTURES', 'LONG'), entry('CRYPTO_FUTURES', 'SHORT'),
  ];
  entries[4].identity.symbol = 'ETHUSDT';
  const lists = { krBuy: [row(entries[0])], usBuy: [row(entries[1])], spotBuy: [row(entries[2])],
    futuresLong: [row(entries[3])], futuresShort: [row(entries[4])] };
  const value = snapshot([]);
  value.lists = lists;
  const selected = selectSignalAdmittedHandoffEntries({ handoff: { status: 'READY', entries }, snapshot: value,
    expectedServiceSha: SHA, nowMs: NOW });
  assert.equal(selected.status, 'READY', JSON.stringify(selected));
  assert.equal(selected.admittedCount, 5);
  assert.deepEqual(selected.entries.map((item) => item.identity.market), [
    'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES', 'CRYPTO_FUTURES',
  ]);
});

test('no-order E2E publishes four-market scanner candidates and gates the same handoff for the worker', () => {
  const nowMs = Date.now();
  const entries = [
    entry('KR_STOCK', 'BUY'), entry('US_STOCK', 'BUY'), entry('CRYPTO_SPOT', 'BUY'),
    entry('CRYPTO_FUTURES', 'LONG'), entry('CRYPTO_FUTURES', 'SHORT'),
  ];
  entries[4].identity.symbol = 'ETHUSDT';
  const handoff = { status: 'READY', entries };
  const inputs = entries.map((item) => canonicalAdapterInputForCard(eligibleCard(item, nowMs), '60m', handoff));
  const adapted = adaptCanonicalScannerCards(inputs, { nowMs });
  const published = { ...runSignalIntelligenceV3(adapted), serviceSha: SHA, publicDataOnly: true, rosterBindingVersion: 1 };
  assert.deepEqual(Object.fromEntries(Object.entries(published.lists).map(([key, value]) => [key, value.length])), {
    krBuy: 1, usBuy: 1, spotBuy: 1, futuresLong: 1, futuresShort: 1,
  });
  const selected = selectSignalAdmittedHandoffEntries({ handoff, snapshot: published,
    expectedServiceSha: SHA, nowMs: Date.now() });
  assert.equal(selected.status, 'READY', JSON.stringify(selected));
  assert.equal(selected.admittedCount, 5);
  assert.equal(published.safety.realOrderAllowed, false);
});

test('stale snapshots and identity mutations fail closed', () => {
  const candidate = entry();
  const stale = snapshot([row(candidate)]);
  stale.generatedAt = new Date(NOW - 31 * 60_000).toISOString();
  assert.equal(selectSignalAdmittedHandoffEntries({ handoff: { status: 'READY', entries: [candidate] }, snapshot: stale,
    expectedServiceSha: SHA, nowMs: NOW }).status, 'BLOCKED_DATA');

  const wrongRelease = selectSignalAdmittedHandoffEntries({ handoff: { status: 'READY', entries: [candidate] },
    snapshot: snapshot([row(candidate)]), expectedServiceSha: 'f'.repeat(40), nowMs: NOW });
  assert.deepEqual(wrongRelease.blockers, ['SIGNAL_SERVICE_SHA_MISMATCH']);

  const mutated = row(candidate);
  mutated.provenance.paperIdentity.parameterHash = 'different';
  const rejected = selectSignalAdmittedHandoffEntries({ handoff: { status: 'READY', entries: [candidate] }, snapshot: snapshot([mutated]),
    expectedServiceSha: SHA, nowMs: NOW });
  assert.equal(rejected.status, 'READY');
  assert.equal(rejected.admittedCount, 0);
});

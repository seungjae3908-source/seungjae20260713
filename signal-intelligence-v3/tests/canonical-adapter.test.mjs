import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCanonicalScannerCard, stopDistancePercent } from '../src/canonical-adapter.mjs';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const NOW = Date.parse('2026-08-17T01:00:00Z');

function card(overrides = {}) {
  return {
    signalId: 'sig-1',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    action: 'BUY',
    direction: 'LONG',
    strategyMode: 'swing',
    price: 100,
    strongSignalEligible: true,
    signalGrade: 'A',
    riskLevel: 'LOW',
    dataState: 'complete',
    dataQuality: { state: 'TRUSTED', strongSignalAllowed: true },
    observedAt: '2026-08-17T00:59:00Z',
    expiresAt: '2026-08-17T02:00:00Z',
    dataSources: ['canonical'],
    pricePlan: { entryZone: { from: 99, to: 101 }, stopLoss: 95, targets: [110], invalidation: 95, riskReward: 2 },
    candidateRanking: { hardFilterPassed: true },
    backtestQuality: {
      status: 'verified', expectancyPercent: 1, profitFactor: 1.4, tradeCount: 80, minimumTradeCount: 50,
      maxDrawdownPercent: 8, costsIncluded: true, slippageIncluded: true,
      lookaheadGuarded: true, survivorshipGuarded: true, oos: true, walkForward: true,
    },
    ...overrides,
  };
}

test('verified canonical KR BUY becomes research candidate input without fake future promotion', () => {
  const adapted = adaptCanonicalScannerCard({ card: card(), timeframe: '1D' }, { nowMs: NOW });
  assert.equal(adapted.market, 'KR_STOCK');
  assert.equal(adapted.direction, 'BUY');
  assert.equal(adapted.validationTier, 'RESEARCH_CANDIDATE');
  assert.equal(adapted.dataStatus, 'READY');
  assert.equal(adapted.quantEligible, true);
  assert.equal(adapted.profitEligible, true);
  assert.equal(adapted.riskReady, true);
  assert.equal(adapted.evidence.source, 'VERIFIED_BACKTEST_EXPECTANCY_TO_STOP_R');
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.lists.krBuy.length, 1);
  assert.equal(snapshot.lists.krBuy[0].validationTier, 'RESEARCH_CANDIDATE');
  assert.equal(snapshot.lists.krBuy[0].utilityMode, 'NET_EDGE_ONLY_RISK_SEPARATE');
});

test('cash SELL is excluded from new-entry scanner', () => {
  const adapted = adaptCanonicalScannerCard({ card: card({ action: 'SELL', direction: 'SHORT' }) }, { nowMs: NOW });
  assert.equal(adapted, null);
});

test('futures LONG and SHORT preserve canonical direction independently', () => {
  const base = card({ assetClass: 'coin_futures', market: 'futures', symbol: 'BTCUSDT' });
  const long = adaptCanonicalScannerCard({ card: { ...base, action: 'LONG', direction: 'LONG' }, edgeEvidence: { ready: true, expectedNetEdgeR: 1.2 } }, { nowMs: NOW });
  const short = adaptCanonicalScannerCard({ card: { ...base, action: 'SHORT', direction: 'SHORT' }, edgeEvidence: { ready: true, expectedNetEdgeR: 1.0 } }, { nowMs: NOW });
  assert.equal(long.direction, 'LONG');
  assert.equal(short.direction, 'SHORT');
});

test('backtest fallback requires costs, slippage, OOS and walk-forward evidence', () => {
  const adapted = adaptCanonicalScannerCard({ card: card({ backtestQuality: { ...card().backtestQuality, costsIncluded: false } }) }, { nowMs: NOW });
  assert.equal(adapted.profitEligible, false);
});

test('stale or untrusted canonical data is blocked', () => {
  const expired = adaptCanonicalScannerCard({ card: card({ expiresAt: '2026-08-17T00:30:00Z' }) }, { nowMs: NOW });
  assert.equal(expired.dataStatus, 'BLOCKED');
  const untrusted = adaptCanonicalScannerCard({ card: card({ dataQuality: { state: 'DATA_UNTRUSTED', strongSignalAllowed: false } }) }, { nowMs: NOW });
  assert.equal(untrusted.dataStatus, 'BLOCKED');
});

test('canonical AI veto can only abstain', () => {
  const adapted = adaptCanonicalScannerCard({ card: card({ aiValidation: { status: 'VETO', risks: ['event-risk'], counterEvidence: [], missingData: [], provider: 'test', explanation: null } }) }, { nowMs: NOW });
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.rows[0].state, 'ABSTAIN');
});

test('stop distance derives from entry midpoint and stop loss', () => {
  assert.equal(stopDistancePercent(card()), 5);
});

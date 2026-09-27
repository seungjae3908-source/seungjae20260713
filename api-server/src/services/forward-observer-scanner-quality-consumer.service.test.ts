import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readForwardObserverScannerQualityArtifact,
  selectForwardObserverScannerBacktests,
  type ForwardObserverScannerQualityArtifact,
} from './forward-observer-scanner-quality-consumer.service';
import { FORWARD_OBSERVER_LANES } from './forward-recommendation-observer-runtime.service';
import { StrategyPromotionService } from './strategy-promotion.service';
import { rankScannerCandidates } from './scanner-candidate-ranking.service';
import type { ScannerSignalCard } from './scanner-signal.types';

const SHA = 'a'.repeat(40);

function quality() {
  return {
    status: 'verified' as const,
    researchFrom: '2025-01-01T00:00:00.000Z',
    researchTo: '2026-01-01T00:00:00.000Z',
    oosWinRate: 55,
    walkForwardWinRate: 54,
    expectancyPercent: 0.4,
    profitFactor: 1.2,
    maxDrawdownPercent: -12,
    tradeCount: 80,
    minimumTradeCount: 40,
    sharpe: 1.1,
    netReturnPercent: 8,
    regime: null,
    regimeScore: null,
    oosStabilityScore: null,
    costsIncluded: true,
    slippageIncluded: true,
    lookaheadGuarded: true,
    survivorshipGuarded: true,
    oos: true,
    walkForward: true,
    source: 'canonical-quality-artifact',
  };
}

function card(symbol = 'BTCUSDT', action: 'LONG' | 'SHORT' = 'LONG'): ScannerSignalCard {
  return {
    signalId: `signal-${symbol}-${action}`,
    assetClass: 'coin_futures',
    market: 'futures',
    exchange: 'BITGET',
    symbol,
    name: symbol,
    currency: 'USDT',
    assetType: 'coin',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: action,
    action,
    signalState: 'WATCHING',
    score: 85,
    confidence: 80,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 90,
    volume: 1000,
    tradingValue: 100000,
    spreadPercent: 0.05,
    volatilityPercent: 2,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: { entryZone: { from: 99, to: 100 }, invalidation: 97, stopLoss: 97, targets: [105, 108], riskReward: 1.6 },
    dataState: 'complete',
    dataSources: ['bitget-public'],
    observedAt: '2026-09-27T00:00:00.000Z',
    expiresAt: '2026-09-27T06:00:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'B',
    dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: true, issues: [] },
    quantScore: { technical: 80, trend: 82, momentum: 84, volume: 75, liquidity: 90, volatility: 70, marketRegime: 80, risk: 80 },
  };
}

function artifactFor(symbol = 'BTCUSDT', direction: 'LONG' | 'SHORT' = 'LONG'): ForwardObserverScannerQualityArtifact {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const promotion = new StrategyPromotionService({ sourceSha: SHA })
    .list({ market: lane.market, strategyHorizon: 'SWING', direction }).items[0]!;
  return {
    schemaVersion: 'forward-observer-scanner-quality-v1',
    researchCodeSha: SHA,
    entries: [{
      identity: {
        strategyId: promotion.identity.strategyId,
        strategyVersion: promotion.identity.strategyVersion,
        parameterHash: promotion.identity.parameterHash,
        researchCodeSha: SHA,
        market: lane.market,
        symbol,
        timeframe: lane.timeframe,
        direction,
        datasetSnapshotHash: 'd'.repeat(64),
      },
      quality: quality(),
      executionAuthority: 'NONE',
      automaticPromotionAuthority: false,
      profitabilityClaimAllowed: false,
    }],
    safety: {
      executionAuthority: 'NONE',
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      profitabilityClaimAllowed: false,
    },
  };
}

test('exact immutable quality artifact is read only after manifest digest and safety validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-quality-'));
  const artifact = artifactFor();
  const qualityText = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(path.join(root, 'quality.json'), qualityText, 'utf8');
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'forward-observer-scanner-quality',
    researchCodeSha: SHA,
    qualitySha256: createHash('sha256').update(qualityText).digest('hex'),
    safety: artifact.safety,
  }, null, 2)}\n`, 'utf8');
  const loaded = await readForwardObserverScannerQualityArtifact({ artifactRoot: root, researchCodeSha: SHA });
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0]?.quality.status, 'verified');
});

test('manifest digest mismatch fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-quality-'));
  const artifact = artifactFor();
  await writeFile(path.join(root, 'quality.json'), JSON.stringify(artifact), 'utf8');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'forward-observer-scanner-quality',
    researchCodeSha: SHA,
    qualitySha256: '0'.repeat(64),
    safety: artifact.safety,
  }), 'utf8');
  await assert.rejects(
    readForwardObserverScannerQualityArtifact({ artifactRoot: root, researchCodeSha: SHA }),
    /SCANNER_QUALITY_ARTIFACT_MANIFEST_INVALID/u,
  );
});

test('exact direction and Promotion identity select one verified futures quality row', () => {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const selected = selectForwardObserverScannerBacktests({
    artifact: artifactFor('BTCUSDT', 'LONG'),
    cards: [card('BTCUSDT', 'LONG')],
    lane,
    researchCodeSha: SHA,
  });
  assert.equal(selected.status, 'READY');
  assert.equal(selected.backtests.BTCUSDT?.status, 'verified');
  assert.deepEqual(selected.matchedSymbols, ['BTCUSDT']);
  assert.equal(selected.executionAuthority, 'NONE');
  assert.equal(selected.automaticPromotionAuthority, false);
});

test('opposite-side quality is never borrowed', () => {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const selected = selectForwardObserverScannerBacktests({
    artifact: artifactFor('BTCUSDT', 'LONG'),
    cards: [card('BTCUSDT', 'SHORT')],
    lane,
    researchCodeSha: SHA,
  });
  assert.equal(selected.status, 'BLOCKED_DATA');
  assert.deepEqual(selected.backtests, {});
  assert.ok(selected.blockers.some((item) => item.code === 'SCANNER_QUALITY_EXACT_ENTRY_REQUIRED'));
});

test('same-symbol mixed LONG and SHORT request fails closed for symbol-keyed ranking map', () => {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const artifact = artifactFor('BTCUSDT', 'LONG');
  const selected = selectForwardObserverScannerBacktests({
    artifact,
    cards: [card('BTCUSDT', 'LONG'), card('BTCUSDT', 'SHORT')],
    lane,
    researchCodeSha: SHA,
  });
  assert.equal(selected.status, 'BLOCKED_DATA');
  assert.deepEqual(selected.backtests, {});
  assert.ok(selected.blockers.some((item) => item.code === 'SCANNER_QUALITY_SYMBOL_DIRECTION_AMBIGUOUS'));
});

test('missing artifact preserves fail-closed unavailable state with no invented quality', () => {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const selected = selectForwardObserverScannerBacktests({
    artifact: null,
    cards: [card()],
    lane,
    researchCodeSha: SHA,
  });
  assert.equal(selected.status, 'UNAVAILABLE');
  assert.deepEqual(selected.backtests, {});
});


test('verified artifact can raise an otherwise B-only Forward ranking without changing grade thresholds', () => {
  const lane = FORWARD_OBSERVER_LANES.find((item) => item.market === 'CRYPTO_FUTURES')!;
  const candidate = card('BTCUSDT', 'LONG');
  candidate.score = 90;
  const selected = selectForwardObserverScannerBacktests({
    artifact: artifactFor('BTCUSDT', 'LONG'),
    cards: [candidate],
    lane,
    researchCodeSha: SHA,
  });
  const ranked = rankScannerCandidates({
    cards: [candidate],
    market: 'futures',
    strategy: 'swing',
    backtests: selected.backtests,
    limit: 10,
  });
  assert.equal(selected.status, 'READY');
  assert.equal(ranked.cards.length, 1);
  assert.equal(ranked.cards[0]?.signalGrade, 'S');
  assert.equal(ranked.diagnostics.backtestMissingCount, 0);
});

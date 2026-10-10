import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readScannerVerifiedGradeBacktests } from './scanner-verified-grade-evidence.service';
import { FORWARD_OBSERVER_LANES } from './forward-recommendation-observer-runtime.service';
import { StrategyPromotionService } from './strategy-promotion.service';
import { rankVerifiedScannerCandidates } from './scanner-verified-grade-evidence.service';
import { scannerBacktestLookupKey } from './forward-observer-scanner-quality-consumer.service';
import type { ScannerSignalCard, ScannerBacktestQualitySummary } from './scanner-signal.types';

const SHA = 'a'.repeat(40);

function card(): ScannerSignalCard {
  return {
    signalId: 'signal-btc-long', assetClass: 'coin_futures', market: 'futures',
    exchange: 'BITGET', symbol: 'BTCUSDT', name: 'BTC', currency: 'USDT',
    assetType: 'coin', listingStatus: 'LISTED', price: 100, changePercent: 1,
    direction: 'LONG', signalState: 'WATCHING', score: 91, confidence: 90,
    dataCompleteness: 100, riskScore: 20, riskLevel: 'LOW',
    liquidity: 90, volume: 1000, tradingValue: 200000, spreadPercent: 0.05,
    volatilityPercent: 2, matched: ['trend'], notMatched: [], unverified: [],
    evidence: [], pricePlan: { entryZone: { from: 99, to: 100 }, invalidation: 97,
      stopLoss: 97, targets: [105, 108], riskReward: 1.6 },
    dataState: 'complete', dataSources: ['bitget-public'],
    observedAt: '2026-10-09T00:00:00.000Z', expiresAt: '2026-10-09T06:00:00.000Z',
    strongSignalEligible: true, warnings: [], strategyMode: 'swing',
    signalGrade: 'B', dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: true, issues: [] },
    quantScore: { technical: 90, trend: 90, momentum: 90, volume: 88,
      liquidity: 90, volatility: 85, marketRegime: 85, risk: 90 },
  };
}
function quality(): ScannerBacktestQualitySummary {
  return {
    status: 'verified', researchFrom: '2025-01-01T00:00:00.000Z', researchTo: '2026-01-01T00:00:00.000Z',
    oosWinRate: 55, walkForwardWinRate: 54, expectancyPercent: 0.4,
    profitFactor: 1.2, maxDrawdownPercent: -12, tradeCount: 80, minimumTradeCount: 40,
    sharpe: 1.1, netReturnPercent: 8, regime: null, regimeScore: null,
    oosStabilityScore: null, costsIncluded: true, slippageIncluded: true,
    lookaheadGuarded: true, survivorshipGuarded: true, oos: true, walkForward: true,
    source: 'canonical-quality-artifact',
  };
}
test('unconfigured or wrong-timeframe quality never promotes S grade', async () => {
  const none = await readScannerVerifiedGradeBacktests({
    market: 'futures', strategyMode: 'swing', timeframe: '60m', cards: [card()],
    artifactRoot: '', researchCodeSha: '',
  });
  assert.deepEqual(none, {});
  const wrong = await readScannerVerifiedGradeBacktests({
    market: 'futures', strategyMode: 'scalping', timeframe: '5m', cards: [card()],
    artifactRoot: '/does-not-exist', researchCodeSha: SHA,
  });
  assert.deepEqual(wrong, {});
  const graded = rankVerifiedScannerCandidates({
    cards: [card()], market: 'CRYPTO_FUTURES', strategy: 'swing', backtests: none,
  });
  assert.equal(graded.cards[0]?.signalGrade, 'B');
});

test('exact immutable manifest and promotion identity produce verified, non-executable S', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-oos-quality-'));
  try {
    const lane = FORWARD_OBSERVER_LANES.find((row) => row.market === 'CRYPTO_FUTURES')!;
    const promotion = new StrategyPromotionService({ sourceSha: SHA })
      .list({ market: lane.market, strategyHorizon: 'SWING', direction: 'LONG' }).items[0]!;
    const identity = {
      strategyId: promotion.identity.strategyId,
      strategyVersion: promotion.identity.strategyVersion,
      parameterHash: promotion.identity.parameterHash,
      researchCodeSha: SHA, market: lane.market, symbol: 'BTCUSDT',
      timeframe: lane.timeframe, direction: 'LONG' as const,
      datasetSnapshotHash: 'd'.repeat(64),
    };
    const artifact = {
      schemaVersion: 'forward-observer-scanner-quality-v1' as const,
      researchCodeSha: SHA,
      entries: [{ identity, quality: quality(), executionAuthority: 'NONE' as const,
        automaticPromotionAuthority: false as const, profitabilityClaimAllowed: false as const }],
      safety: {
        executionAuthority: 'NONE' as const,
        financialMutationAllowed: false as const, liveOrderAllowed: false as const,
        privateTradingApiAllowed: false as const, profitabilityClaimAllowed: false as const,
      },
    };
    const json = JSON.stringify(artifact);
    await writeFile(path.join(root, 'quality.json'), json);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, kind: 'forward-observer-scanner-quality', researchCodeSha: SHA,
      qualitySha256: createHash('sha256').update(json).digest('hex'), safety: artifact.safety,
    }));
    const exact = await readScannerVerifiedGradeBacktests({
      market: 'futures', strategyMode: 'swing', timeframe: lane.timeframe, cards: [card()],
      artifactRoot: root, researchCodeSha: SHA,
    });
    assert.equal(exact[scannerBacktestLookupKey(card())!]?.status, 'verified');
    const ranked = rankVerifiedScannerCandidates({
      cards: [card()], market: lane.market, strategy: 'swing', backtests: exact,
    });
    assert.equal(ranked.cards[0]?.signalGrade, 'S');
    const unrelated = await readScannerVerifiedGradeBacktests({
      market: 'futures', strategyMode: 'swing', timeframe: '4H', cards: [card()],
      artifactRoot: root, researchCodeSha: SHA,
    });
    assert.deepEqual(unrelated, {});
    await writeFile(path.join(root, 'quality.json'), json.replace('"profitFactor":1.2', '"profitFactor":-8'));
    const tampered = await readScannerVerifiedGradeBacktests({
      market: 'futures', strategyMode: 'swing', timeframe: lane.timeframe, cards: [card()],
      artifactRoot: root, researchCodeSha: SHA,
    });
    assert.deepEqual(tampered, {});
  } finally { await rm(root, {recursive:true,force:true}); }
});

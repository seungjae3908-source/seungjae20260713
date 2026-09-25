import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyThemeSwingOverlay,
  inferCryptoThemeTags,
  type ScannerThemeTag,
} from './scanner-theme-swing.service';
import type { ScannerSignalCard } from './scanner-signal.types';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'signal:base',
    assetClass: 'stock',
    market: 'US',
    exchange: 'NASDAQ',
    symbol: 'AAA',
    name: 'AAA',
    currency: 'USD',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 6,
    direction: 'LONG',
    signalState: 'CANDIDATE',
    score: 86,
    confidence: 84,
    dataCompleteness: 96,
    riskScore: 28,
    riskLevel: 'LOW',
    liquidity: 100_000_000,
    volume: 1_000_000,
    tradingValue: 100_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 3,
    matched: ['breakout', 'volume_spike', 'positive_news'],
    notMatched: [],
    unverified: [],
    evidence: [
      { key: 'breakout', label: '돌파', status: 'matched', source: 'market-candles', observedAt: '2026-09-25T00:00:00.000Z', reasons: ['저항선 돌파'] },
      { key: 'news', label: '뉴스 호재', status: 'matched', source: 'news', observedAt: '2026-09-25T00:00:00.000Z', reasons: ['공개 뉴스 촉매 확인'] },
    ],
    pricePlan: { entryZone: { from: 98, to: 102 }, invalidation: 94, stopLoss: 94, targets: [112, 120], riskReward: 2 },
    dataState: 'complete',
    dataSources: ['fixture'],
    observedAt: '2026-09-25T00:00:00.000Z',
    expiresAt: '2026-09-28T00:00:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'A',
    dataQuality: { state: 'TRUSTED', score: 95, strongSignalAllowed: true, issues: [] },
    quantScore: { technical: 84, trend: 88, momentum: 82, volume: 90, liquidity: 92, volatility: 75, marketRegime: 86, risk: 80 },
    aiValidation: { status: 'PASS', provider: 'fixture', counterEvidence: [], missingData: [], risks: [], explanation: 'ok' },
    ...overrides,
  };
}

describe('scanner theme swing overlay', () => {
  const aiTag: ScannerThemeTag[] = [{ key: 'ai', label: 'AI·인공지능', source: 'CATALOG' }];

  it('keeps theme swing separate while identifying a strong leader', () => {
    const rows = [
      card({ signalId: 'leader', symbol: 'AAA', score: 90, changePercent: 9, tradingValue: 300_000_000 }),
      card({ signalId: 'peer-1', symbol: 'BBB', score: 78, changePercent: 5, tradingValue: 180_000_000 }),
      card({ signalId: 'peer-2', symbol: 'CCC', score: 72, changePercent: 2, tradingValue: 120_000_000 }),
    ];
    const output = applyThemeSwingOverlay(rows, () => aiTag);
    const leader = output.find((row) => row.signalId === 'leader')!;
    assert.equal(leader.score, 90);
    assert.equal(leader.themeSwing?.leader, true);
    assert.equal(leader.themeSwing?.themeKey, 'ai');
    assert.equal(leader.themeSwing?.memberCount, 3);
    assert.equal(leader.themeSwing?.positiveBreadthPercent, 100);
    assert.equal(leader.themeSwing?.state, 'ELIGIBLE');
    assert.equal(leader.themeSwing?.executionAuthority, 'NONE');
    assert.equal(leader.themeSwing?.orderSubmitted, false);
  });

  it('fails closed when a swing asset cannot be classified', () => {
    const [output] = applyThemeSwingOverlay([card()], () => []);
    assert.equal(output.themeSwing?.state, 'UNCLASSIFIED');
    assert.deepEqual(output.themeSwing?.blockers, ['THEME_UNCLASSIFIED']);
  });

  it('does not alter non-swing cards', () => {
    const input = card({ strategyMode: 'scalping' });
    const [output] = applyThemeSwingOverlay([input], () => aiTag);
    assert.equal(output.themeSwing, undefined);
    assert.equal(output.score, input.score);
  });

  it('classifies curated crypto themes without granting execution authority', () => {
    const tags = inferCryptoThemeTags(card({ assetClass: 'coin_futures', symbol: 'FETUSDT' }));
    assert.ok(tags.some((tag) => tag.key === 'crypto-ai-data'));
  });

  it('keeps weak breadth as watch/reject instead of eligible', () => {
    const rows = [
      card({ signalId: 'a', symbol: 'AAA', changePercent: 6 }),
      card({ signalId: 'b', symbol: 'BBB', changePercent: -7, score: 70 }),
      card({ signalId: 'c', symbol: 'CCC', changePercent: -4, score: 68 }),
    ];
    const output = applyThemeSwingOverlay(rows, () => aiTag);
    assert.notEqual(output[0].themeSwing?.state, 'ELIGIBLE');
    assert.ok(output[0].themeSwing?.blockers.includes('THEME_BREADTH_WEAK'));
  });
});

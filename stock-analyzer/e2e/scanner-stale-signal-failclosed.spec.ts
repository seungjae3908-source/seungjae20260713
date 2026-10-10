import { test, expect } from '@playwright/test';
import { createScannerStaleFallback } from '../src/lib/scanner-stale-fallback';
import type { ScannerResponse, ScannerSignalCard } from '../src/lib/signal-scanner';

function card(grade: 'S' | 'A' | 'B'): ScannerSignalCard {
  return {
    signalId: 'signal-'+grade, symbol: grade, market: 'US', name: grade,
    action: 'BUY', signalGrade: grade, signalState: 'READY_FOR_APPROVAL',
    dataState: 'complete', strongSignalEligible: true, warnings: [],
    candidateRanking: {
      rank: 1, score: 95, relativeScore: 90, watchCompletionPercent: 100,
      watchReasons: [], hardFilterPassed: true, hardFilterReasons: [],
      relative: { tradingValuePercentile: 80, momentumPercentile: 80,
        trendPercentile: 80, volumePercentile: 80, volatilityPercentile: 80 },
    },
  } as unknown as ScannerSignalCard;
}

function sample(): ScannerResponse {
  return {
    ok: true, cards: [card('S'), card('A'), card('B')],
    alerts: [{ signalId: 'signal-S' }],
    requestId: 'earlier-run', generatedAt: '2026-01-01T00:00:00.000Z',
    execution: {
      partial: false, duplicate: false, sGradeCount: 1, aGradeCount: 1, bGradeCount: 1,
    },
    universe: { source: 'krx-symbol-master', partial: false, stale: false },
    dataState: 'complete', message: 'OLD',
    orderSubmitted: false, exchangeRequestSent: false,
  } as unknown as ScannerResponse;
}

for (const [status, code] of [[409, 'SCAN_DUPLICATE_REQUEST'], [429, 'SCAN_RATE_LIMITED'], [502, 'SCAN_PROVIDER_ERROR']] as const) {
  test(`stale fallback on HTTP ${status} strips S/A authority without changing original evidence`, () => {
    const original = sample();
    const result = createScannerStaleFallback(original, { status, code, retryAfterSeconds: 12 });
    expect(result.dataState).toBe('stale');
    expect(result.execution.partial).toBe(true);
    expect(result.execution.sGradeCount).toBe(0);
    expect(result.execution.aGradeCount).toBe(0);
    expect(result.execution.bGradeCount).toBe(3);
    expect(result.alerts).toEqual([]);
    expect(result.cards).toHaveLength(3);
    for (const card of result.cards) {
      expect(card.signalGrade).toBe('B');
      expect(card.action).toBe('NONE');
      expect(card.signalState).toBe('WEAKENED');
      expect(card.dataState).toBe('stale');
      expect(card.strongSignalEligible).toBe(false);
      expect(card.candidateRanking?.watchCompletionPercent).toBeLessThan(100);
      expect(card.candidateRanking?.watchReasons.join(' ')).toContain('최신 데이터');
    }
    expect(result.generatedAt).toBe(original.generatedAt);
    expect(original.cards[0].signalGrade).toBe('S');
    expect(original.alerts).toHaveLength(1);
    expect(result.orderSubmitted).toBe(false);
    expect(result.exchangeRequestSent).toBe(false);
  });
}

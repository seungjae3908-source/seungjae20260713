import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnifiedTradeJournal } from './paper-journal-sync';
import { assertUnifiedTradeJournalSafety } from './unified-journal-safety';

function journal(overrides: Record<string, unknown> = {}): UnifiedTradeJournal {
  return {
    integrationBaseSha: 'fixture',
    generatedAt: '2026-09-25T00:00:00.000Z',
    trades: [],
    analytics: {
      sampleSize: 0, openTrades: 0, closedTrades: 0, winRate: null, profitFactor: null,
      averageReturnPercent: null, maximumConsecutiveLosses: null,
      netPnlByCurrency: [], totalCostsByCurrency: [], byMarket: [], bySource: [],
      byStrategy: [], byTimeframe: [], byGrade: [], mistakes: [], monthlyReport: [], warnings: [],
    },
    integrityIssues: [],
    toss: {
      provider: 'TOSS',
      officialSpecVersion: 'fixture',
      paidStatus: 'PAID_STATUS_UNVERIFIED',
      liveReadIntegration: 'BLOCKED_BY_FREE_STATUS_UNVERIFIED',
      contractNormalizerAvailable: true,
      executionGranularity: 'fixture',
      livePrivateRequests: 0,
      actualOrders: 0,
    },
    aiReviewStatus: 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY',
    safety: {
      finalCostDelta: '0_KRW',
      actualOrderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      privateBrokerRequests: 0,
    },
    ...overrides,
  } as unknown as UnifiedTradeJournal;
}

function liveHistory(privateProviderRequests = 5) {
  return {
    requestedRange: '30D' as const,
    effectiveDays: 30,
    rangeCapped: false,
    persisted: false as const,
    privateProviderRequests,
    truncated: false,
    providers: [
      {
        provider: 'upbit' as const,
        configured: true,
        enabled: true,
        status: 'READY' as const,
        records: 2,
        privateProviderRequests: 4,
        truncated: false,
        errorCode: null,
      },
      {
        provider: 'bitget' as const,
        configured: true,
        enabled: true,
        status: 'READY' as const,
        records: 1,
        privateProviderRequests: 1,
        truncated: false,
        errorCode: null,
      },
    ],
    safety: {
      orderRequests: 0 as const,
      cancelRequests: 0 as const,
      amendRequests: 0 as const,
      transferRequests: 0 as const,
      withdrawalRequests: 0 as const,
      credentialsReturned: false as const,
      liveTradingEnabled: false as const,
      autoTradingEnabled: false as const,
    },
  };
}

test('no live-account history still requires zero private broker reads', () => {
  assert.doesNotThrow(() => assertUnifiedTradeJournalSafety(journal()));
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      safety: { ...journal().safety, privateBrokerRequests: 1 },
    })),
    /근거 없이 private 조회/,
  );
});

test('proven read-only provider requests are accepted when every count reconciles', () => {
  const history = liveHistory(5);
  assert.doesNotThrow(() => assertUnifiedTradeJournalSafety(journal({
    liveAccountHistory: history,
    safety: { ...journal().safety, privateBrokerRequests: 5 },
  })));
});

test('Kiwoom provider evidence may use a bounded 7-day window inside a 30-day journal request', () => {
  const history = liveHistory(7) as any;
  history.providers.unshift({
    provider: 'kiwoom',
    configured: true,
    enabled: true,
    status: 'PARTIAL',
    records: 3,
    privateProviderRequests: 2,
    truncated: true,
    effectiveDays: 7,
    rangeCapped: true,
    errorCode: 'KIWOOM_HISTORY_CAPPED_7D',
  });
  assert.doesNotThrow(() => assertUnifiedTradeJournalSafety(journal({
    liveAccountHistory: history,
    safety: { ...journal().safety, privateBrokerRequests: 7 },
  })));
});

test('Kiwoom provider evidence cannot claim a window larger than the global live-history window', () => {
  const history = liveHistory(5) as any;
  history.providers.unshift({
    provider: 'kiwoom',
    configured: true,
    enabled: true,
    status: 'READY',
    records: 1,
    privateProviderRequests: 0,
    truncated: false,
    effectiveDays: 31,
    rangeCapped: false,
    errorCode: null,
  });
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: history,
      safety: { ...journal().safety, privateBrokerRequests: 5 },
    })),
    /공급자 근거/,
  );
});

test('browser rejects server safety count that disagrees with live-history evidence', () => {
  const history = liveHistory(5);
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: history,
      safety: { ...journal().safety, privateBrokerRequests: 4 },
    })),
    /조회 횟수 근거가 일치/,
  );
});

test('browser rejects provider request totals that disagree with live-history total', () => {
  const history = liveHistory(4);
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: history,
      safety: { ...journal().safety, privateBrokerRequests: 4 },
    })),
    /조회 횟수 근거가 일치/,
  );
});

test('not-configured and disabled providers cannot report private reads or records', () => {
  const history = liveHistory(5);
  history.providers[0] = {
    ...history.providers[0],
    configured: false,
    status: 'NOT_CONFIGURED',
    records: 1,
    privateProviderRequests: 4,
  };
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: history,
      safety: { ...journal().safety, privateBrokerRequests: 5 },
    })),
    /미연결·비활성 공급자/,
  );
});

test('mutation counters remain hard zero even when read-only private reads are proven', () => {
  const history = liveHistory(5);
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: history,
      safety: { ...journal().safety, privateBrokerRequests: 5, actualOrderRequests: 1 },
    })),
    /조회 전용·무주문/,
  );
});

test('live history cannot claim persistence or exceed the 30-day private-read cap', () => {
  const persisted = liveHistory(5) as any;
  persisted.persisted = true;
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: persisted,
      safety: { ...journal().safety, privateBrokerRequests: 5 },
    })),
    /거래이력의 조회 전용 안전 계약/,
  );

  const overRange = liveHistory(5) as any;
  overRange.effectiveDays = 31;
  assert.throws(
    () => assertUnifiedTradeJournalSafety(journal({
      liveAccountHistory: overRange,
      safety: { ...journal().safety, privateBrokerRequests: 5 },
    })),
    /거래이력의 조회 전용 안전 계약/,
  );
});

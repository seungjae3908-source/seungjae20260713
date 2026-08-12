import { useMemo, useState } from 'react';
import { PaperJournalSyncAnalyticsPanel } from '@/components/paper-journal-sync-analytics-panel';
import type {
  ConflictResolutionResult,
  JournalAnalytics,
  JournalConflict,
  JournalSnapshotResult,
  JournalSyncResult,
  TradingReviewDataset,
} from '@/lib/paper-journal-sync';
import { createUserPaperStorage, loadJournalSyncMetadata, saveJournalSyncMetadata } from '@/lib/paper-journal-sync-storage';
import { createLocalPaperState, savePaperState } from '@/lib/paper-trading';

const NOW = '2026-08-02T07:00:00.000Z';
const USERS = ['phase7-user-a', 'phase7-user-b'];
type Mode = 'success'|'failure'|'conflict'|'insufficient';

const conflict: JournalConflict = {
  id: 'conflict:phase7', kind: 'journal', recordId: 'journal-1', version: 2,
  serverRecord: { kind: 'journal', id: 'journal-1', version: 2, updatedAt: NOW, deletedAt: null, payload: { id: 'journal-1', note: 'server' }, createdAt: NOW, serverUpdatedAt: NOW },
  deviceRecord: { kind: 'journal', id: 'journal-1', version: 2, updatedAt: NOW, deletedAt: null, payload: { id: 'journal-1', note: 'device' } },
  differenceSummary: ['note 값이 다릅니다.'], createdAt: NOW, status: 'open',
};

function analytics(insufficient = false): JournalAnalytics {
  const sampleSize = insufficient ? 3 : 12;
  return {
    periodStart: NOW, periodEnd: NOW, sampleSize, certainty: insufficient ? 'insufficient' : 'confirmed',
    totalTrades: sampleSize, netPnl: 125.5, wins: 8, losses: 4, winRate: insufficient ? null : 66.67,
    expectancy: insufficient ? null : 10.46, averageR: insufficient ? null : 0.81, profitFactor: insufficient ? null : 1.92,
    maximumConsecutiveLosses: 2, totalCosts: 18.4, costRatioPercent: insufficient ? null : 9.2,
    stopAdherenceRate: insufficient ? null : 91.7, targetAdherenceRate: insufficient ? null : 75,
    ruleViolationRate: insufficient ? null : 8.3,
    bySide: [], bySymbol: [{ key: 'BTCUSDT', sampleSize, netPnl: 125.5, winRate: insufficient ? null : 66.67, expectancy: insufficient ? null : 10.46, averageR: insufficient ? null : 0.81, certainty: insufficient ? 'insufficient' : 'confirmed' }],
    byStrategy: [{ key: 'manual', sampleSize, netPnl: 125.5, winRate: insufficient ? null : 66.67, expectancy: insufficient ? null : 10.46, averageR: insufficient ? null : 0.81, certainty: insufficient ? 'insufficient' : 'confirmed' }],
    byHour: [], byWeekday: [], byExitReason: [], byDataStatus: [], byMarketRegime: [], byLeverageBucket: [], byRiskBucket: [],
    behaviorSignals: [{ code: insufficient ? 'BEHAVIOR_SAMPLE_INSUFFICIENT' : 'LOSS_REENTRY_WITHIN_10_MINUTES', certainty: insufficient ? 'insufficient' : 'candidate', count: insufficient ? 3 : 2, message: insufficient ? '행동 패턴 판단에는 최소 10건이 필요합니다.' : '손실 종료 후 10분 이내 동일 종목 재진입 후보가 있습니다.', evidence: [] }],
    facts: [`확정: 종료된 거래 ${sampleSize}건`], warnings: insufficient ? ['기본 통계 확정에는 최소 5건이 필요합니다.'] : [],
  };
}

function reviewDataset(): TradingReviewDataset {
  return {
    periodStart: NOW, periodEnd: NOW, sampleSize: 12, aggregateMetrics: { totalTrades: 12 }, behaviorSignals: [],
    strategyMetrics: [], symbolMetrics: [], timeMetrics: [], representativeTrades: [{ anonymizedId: '0123456789abcdef', side: 'long', strategy: 'manual', riskPercent: 0.5, rMultiple: 1.2, netPnlPercent: 0.8, exitReason: 'take_profit', ruleViolations: [] }],
    excludedFields: ['email','name','birthDate','apiKey','secret','accountNumber','originalUserNote','internalDatabaseUuid','fullOrderPayload'],
    warnings: ['현재 단계에서는 외부 AI를 호출하거나 거래기록을 전송하지 않습니다.'],
  };
}

function unifiedJournal() {
  const trade = {
    id: 'phase7-unified-trade', source: 'APP_PAPER', broker: 'APP', accountIdMasked: 'APP-****-LOCAL',
    market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', positionSide: 'LONG', currency: 'USDT', status: 'CLOSED',
    openedAt: '2026-08-02T05:00:00.000Z', closedAt: NOW, entryPrice: 100, exitPrice: 110,
    initialEntry: { orderId: 'entry-1', at: '2026-08-02T05:00:00.000Z', price: 100, quantity: 1, fees: 0.1, tax: 0 },
    additions: [], partialExits: [], finalExit: { orderId: 'exit-1', at: NOW, price: 110, quantity: 1, fees: 0.1, tax: 0 },
    totalQuantity: 1, closedQuantity: 1, remainingQuantity: 0, holdingTimeMs: 7_200_000,
    grossPnl: 10, fees: 0.2, tax: 0, netPnl: 9.8, netReturnPercent: 9.8,
    strategy: 'breakout', timeframe: '15m', stopLossPrice: 95, targetPrice: 110, ruleViolation: false, warnings: [],
    technicalSnapshot: { snapshotId: 'phase7-snapshot', contextSource: 'PRE_TRADE_SNAPSHOT', capturedAt: '2026-08-02T04:59:00.000Z', timeframe: '15m', price: 100, rsi: 56, macd: 1, macdSignal: 0.5, movingAverageFast: 99, movingAverageSlow: 97, support: 95, resistance: 110, volumeRatio: 1.4, volatilityPercent: 2, signalScore: 84, marketRegime: 'TREND', marketStructure: 'HIGHER_HIGH', signalReasons: ['trend'] },
    review: { performanceScore: 99, qualityScore: 90, grade: 'A', good: ['진입 전 기술 분석 스냅샷을 보존했습니다.'], bad: [], improvements: [], mistakes: [], deterministic: true, externalAiCalled: false },
  } as const;
  return {
    integrationBaseSha: '868734a1ef2120cdafebb4a518ba8dd0a7d40e0f', generatedAt: NOW, trades: [trade], integrityIssues: [],
    toss: { provider: 'TOSS', officialSpecVersion: '1.2.14', paidStatus: 'PAID_STATUS_UNVERIFIED', liveReadIntegration: 'BLOCKED_BY_FREE_STATUS_UNVERIFIED', contractNormalizerAvailable: true, executionGranularity: 'ORDER_CUMULATIVE_AGGREGATE_NO_FILL_ID', livePrivateRequests: 0, actualOrders: 0 },
    aiReviewStatus: 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY',
    safety: { finalCostDelta: '0_KRW', actualOrderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, privateBrokerRequests: 0 },
    analytics: { sampleSize: 1, openTrades: 0, closedTrades: 1, winRate: null, profitFactor: null, averageReturnPercent: null, maximumConsecutiveLosses: 0, netPnlByCurrency: [{ currency: 'USDT', value: 9.8 }], totalCostsByCurrency: [{ currency: 'USDT', value: 0.2 }], byMarket: [], bySource: [], byStrategy: [], byTimeframe: [], byGrade: [], mistakes: [], monthlyReport: [{ month: '2026-08', sampleSize: 1, winRate: null, averageReturnPercent: null, netPnlByCurrency: [{ currency: 'USDT', value: 9.8 }] }], warnings: ['확정 통계에는 종료 거래가 최소 5건 필요하며 부족한 지표는 N/A로 표시됩니다.'] },
  };
}

export default function Phase7JournalSyncE2EPage() {
  const [userIndex, setUserIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('success');
  const userId = USERS[userIndex];
  const paperStorage = useMemo(() => {
    const adapter = createUserPaperStorage(window.localStorage, userId, new Date(NOW));
    const loaded = adapter.getItem('seungjae.paper-trading.v1');
    if (!loaded) {
      const state = createLocalPaperState(userIndex ? 20_000 : 10_000, new Date(NOW));
      state.journal = Array.from({ length: mode === 'insufficient' ? 3 : 12 }, (_, index) => ({ id: `journal-${userIndex}-${index}` } as never));
      savePaperState(adapter, state);
    }
    if (mode === 'conflict') {
      const metadata = loadJournalSyncMetadata(window.localStorage, userId, new Date(NOW)).metadata;
      metadata.status = 'conflict'; metadata.conflicts = [conflict];
      saveJournalSyncMetadata(window.localStorage, userId, metadata);
    }
    return adapter;
  }, [mode, userId, userIndex]);

  const fakeSync = async (): Promise<JournalSyncResult> => {
    if (mode === 'failure') throw new Error('테스트 동기화 실패');
    return { ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false, idempotencyKey: 'phase7-e2e-sync', serverTime: NOW, uploaded: [], downloaded: [], unchanged: [], conflicts: mode === 'conflict' ? [conflict] : [], failed: [], warnings: [], clockSkewMs: 0 };
  };
  const fakeSnapshot = async (): Promise<JournalSnapshotResult> => ({ ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false, records: [], nextCursor: null, serverTime: NOW });
  const fakeResolve = async (_id: string, choice: 'server'|'device'|'preserve_both'): Promise<ConflictResolutionResult> => ({ ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false, conflictId: conflict.id, choice, records: choice === 'server' ? [conflict.serverRecord] : [], serverTime: NOW });

  return <main className="h-[100dvh] overflow-y-auto bg-background p-4" data-testid="phase7-e2e-page">
    <div className="mx-auto max-w-5xl space-y-3">
      <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-3">
        <label className="text-xs">시나리오<select aria-label="시나리오" className="ml-2 h-10 rounded border border-border bg-background px-2" value={mode} onChange={(event) => setMode(event.target.value as Mode)}><option value="success">success</option><option value="failure">failure</option><option value="conflict">conflict</option><option value="insufficient">insufficient</option></select></label>
        <button type="button" className="min-h-10 rounded border border-border px-3 text-sm" onClick={() => setUserIndex((value) => value ? 0 : 1)} data-testid="switch-account">계정 전환</button>
        <span data-testid="active-account" className="self-center text-xs">{userId}</span>
      </div>
      <PaperJournalSyncAnalyticsPanel
        key={`${userId}:${mode}`}
        userId={userId}
        rootStorage={window.localStorage}
        paperStorage={paperStorage}
        syncApi={fakeSync as never}
        snapshotApi={fakeSnapshot as never}
        resolveApi={fakeResolve as never}
        analyticsApi={async () => analytics(mode === 'insufficient')}
        reviewApi={async () => reviewDataset()}
        unifiedLedgerApi={async () => unifiedJournal() as never}
      />
    </div>
  </main>;
}

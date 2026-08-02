export const JOURNAL_SYNC_MODE = 'journal-sync-only' as const;
export const JOURNAL_ANALYSIS_MODE = 'analysis-only' as const;
export const MAX_SYNC_RECORDS = 500;
export const MAX_SNAPSHOT_PAGE_SIZE = 100;
export const MAX_REVIEW_REPRESENTATIVE_TRADES = 12;
export const BASIC_ANALYTICS_MIN_SAMPLE = 5;
export const BEHAVIOR_ANALYTICS_MIN_SAMPLE = 10;
export const GROUP_ANALYTICS_MIN_SAMPLE = 10;
export const DELETE_ALL_CONFIRMATION = 'DELETE MY PAPER JOURNAL';
export const CLOCK_SKEW_WARNING_MS = 5 * 60 * 1000;

export const PAPER_JOURNAL_RECORD_KINDS = [
  'account',
  'order',
  'position',
  'fill',
  'journal',
] as const;

export type PaperJournalRecordKind = typeof PAPER_JOURNAL_RECORD_KINDS[number];

export type PaperJournalSyncRecord = {
  kind: PaperJournalRecordKind;
  id: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  payload: Record<string, unknown>;
};

export type StoredPaperJournalRecord = PaperJournalSyncRecord & {
  createdAt: string;
  serverUpdatedAt: string;
};

export type PaperJournalConflict = {
  id: string;
  kind: PaperJournalRecordKind;
  recordId: string;
  version: number;
  serverRecord: StoredPaperJournalRecord;
  deviceRecord: PaperJournalSyncRecord;
  differenceSummary: string[];
  createdAt: string;
  status: 'open' | 'resolved';
};

export type PaperJournalSyncFailure = {
  kind: PaperJournalRecordKind;
  id: string;
  code: string;
  message: string;
};

export type PaperJournalSyncRequest = {
  idempotencyKey: string;
  clientTime: string;
  records: PaperJournalSyncRecord[];
};

export type PaperJournalSyncResult = {
  ok: true;
  mode: typeof JOURNAL_SYNC_MODE;
  orderSubmitted: false;
  exchangeRequestSent: false;
  idempotencyKey: string;
  serverTime: string;
  uploaded: StoredPaperJournalRecord[];
  downloaded: StoredPaperJournalRecord[];
  unchanged: Array<{ kind: PaperJournalRecordKind; id: string; version: number }>;
  conflicts: PaperJournalConflict[];
  failed: PaperJournalSyncFailure[];
  warnings: string[];
  clockSkewMs: number;
};

export type PaperJournalSnapshotResult = {
  ok: true;
  mode: typeof JOURNAL_SYNC_MODE;
  orderSubmitted: false;
  exchangeRequestSent: false;
  records: StoredPaperJournalRecord[];
  nextCursor: string | null;
  serverTime: string;
};

export type ConflictResolutionChoice = 'server' | 'device' | 'preserve_both';

export type ConflictResolutionResult = {
  ok: true;
  mode: typeof JOURNAL_SYNC_MODE;
  orderSubmitted: false;
  exchangeRequestSent: false;
  conflictId: string;
  choice: ConflictResolutionChoice;
  records: StoredPaperJournalRecord[];
  serverTime: string;
};

export type AnalysisCertainty = 'confirmed' | 'candidate' | 'insufficient';

export type AnalyticsMetricGroup = {
  key: string;
  sampleSize: number;
  netPnl: number;
  winRate: number | null;
  expectancy: number | null;
  averageR: number | null;
  certainty: AnalysisCertainty;
};

export type BehaviorSignal = {
  code: string;
  certainty: AnalysisCertainty;
  count: number;
  message: string;
  evidence: string[];
};

export type PaperJournalAnalytics = {
  periodStart: string | null;
  periodEnd: string | null;
  sampleSize: number;
  certainty: AnalysisCertainty;
  totalTrades: number;
  netPnl: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancy: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maximumConsecutiveLosses: number;
  totalCosts: number;
  costRatioPercent: number | null;
  stopAdherenceRate: number | null;
  targetAdherenceRate: number | null;
  ruleViolationRate: number | null;
  bySide: AnalyticsMetricGroup[];
  bySymbol: AnalyticsMetricGroup[];
  byStrategy: AnalyticsMetricGroup[];
  byHour: AnalyticsMetricGroup[];
  byWeekday: AnalyticsMetricGroup[];
  byExitReason: AnalyticsMetricGroup[];
  byDataStatus: AnalyticsMetricGroup[];
  byMarketRegime: AnalyticsMetricGroup[];
  byLeverageBucket: AnalyticsMetricGroup[];
  byRiskBucket: AnalyticsMetricGroup[];
  behaviorSignals: BehaviorSignal[];
  facts: string[];
  warnings: string[];
};

export type TradingReviewDataset = {
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  aggregateMetrics: Record<string, unknown>;
  behaviorSignals: BehaviorSignal[];
  strategyMetrics: AnalyticsMetricGroup[];
  symbolMetrics: AnalyticsMetricGroup[];
  timeMetrics: AnalyticsMetricGroup[];
  representativeTrades: Array<{
    anonymizedId: string;
    side: 'long' | 'short';
    strategy: string | null;
    riskPercent: number | null;
    rMultiple: number | null;
    netPnlPercent: number | null;
    exitReason: string;
    ruleViolations: string[];
  }>;
  excludedFields: string[];
  warnings: string[];
};

export type AnalysisOnlyResult<T> = {
  ok: true;
  mode: typeof JOURNAL_ANALYSIS_MODE;
  externalAiCalled: false;
  result: T;
};

export interface PaperJournalRepository {
  getRecord(userId: string, kind: PaperJournalRecordKind, id: string): Promise<StoredPaperJournalRecord | null>;
  upsertRecord(userId: string, record: PaperJournalSyncRecord, serverTime: string): Promise<StoredPaperJournalRecord>;
  listSnapshot(userId: string): Promise<StoredPaperJournalRecord[]>;
  getIdempotentResponse(userId: string, idempotencyKey: string): Promise<PaperJournalSyncResult | null>;
  saveIdempotentResponse(userId: string, idempotencyKey: string, result: PaperJournalSyncResult, serverTime: string): Promise<void>;
  saveConflict(userId: string, conflict: PaperJournalConflict): Promise<void>;
  getConflict(userId: string, conflictId: string): Promise<PaperJournalConflict | null>;
  markConflictResolved(userId: string, conflictId: string, serverTime: string): Promise<void>;
  listJournalPayloads(userId: string): Promise<Record<string, unknown>[]>;
  deleteAll(userId: string): Promise<Record<PaperJournalRecordKind | 'syncState', number>>;
}

export class PaperJournalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PaperJournalError';
  }
}

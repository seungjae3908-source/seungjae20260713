import { authorizedFetch } from '@/lib/auth-fetch';

export type ResearchJournalCandidateBinding = Readonly<{
  status: 'VERIFIED' | 'NOT_AVAILABLE' | 'MISMATCH' | 'NOT_APPLICABLE';
  reason: string;
  candidateId: string | null;
  strategyId: string | null;
  researchCodeSha: string | null;
  settlementBindingVerified: boolean;
  exitTriggerId: string | null;
  exitExecutionId: string | null;
  triggerBindingVerified: boolean;
  fullCostBindingVerified: boolean;
  fullCostEvidenceDigest: string | null;
  fullCostComponentCount: number;
  netPnlBindingVerified: boolean;
  canonicalNetPnl: number | null;
  netPnlEvidenceDigest: string | null;
}>;

export type ResearchLiveFeedbackRecord = Readonly<{
  status: 'LINEAGE_VERIFIED' | 'NOT_AVAILABLE' | 'MISMATCH';
  reason: string;
  candidateId: string | null;
  strategyId: string | null;
  researchCodeSha: string | null;
  handoffId: string | null;
  journalStatus: 'OPEN' | 'CLOSED';
  netPnlObserved: number | null;
  observationOnly: true;
  researchMutationAllowed: false;
  promotionAuthority: false;
  executionAuthority: 'NONE';
  profitabilityCredit: 0;
}>;

export type ResearchLiveFeedbackReadback = Readonly<{
  status: 'VERIFIED' | 'PARTIAL' | 'NOT_AVAILABLE';
  autoTradeCount: number;
  lineageVerifiedCount: number;
  mismatchTradeCount: number;
  unavailableTradeCount: number;
  closedObservedCount: number;
  records: readonly ResearchLiveFeedbackRecord[];
  reason: string;
}>;

export type ResearchJournalBindingReadback = Readonly<{
  status: 'VERIFIED' | 'PARTIAL' | 'NOT_AVAILABLE';
  source: 'AUTHENTICATED_PAPER_STATE' | null;
  sourceSha: string | null;
  paperTradeCount: number;
  verifiedTradeCount: number;
  mismatchTradeCount: number;
  unavailableTradeCount: number;
  trades: readonly ResearchJournalCandidateBinding[];
  liveFeedback: ResearchLiveFeedbackReadback;
  reason: string;
}>;

const BINDING_SCHEMA = 'unified-journal-canonical-research-binding-v1';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function text(value: unknown, max = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function emptyLive(reason: string): ResearchLiveFeedbackReadback {
  return Object.freeze({
    status: 'NOT_AVAILABLE',
    autoTradeCount: 0,
    lineageVerifiedCount: 0,
    mismatchTradeCount: 0,
    unavailableTradeCount: 0,
    closedObservedCount: 0,
    records: Object.freeze([]),
    reason,
  });
}

function empty(reason: string): ResearchJournalBindingReadback {
  return Object.freeze({
    status: 'NOT_AVAILABLE',
    source: null,
    sourceSha: null,
    paperTradeCount: 0,
    verifiedTradeCount: 0,
    mismatchTradeCount: 0,
    unavailableTradeCount: 0,
    trades: Object.freeze([]),
    liveFeedback: emptyLive('LIVE_RESEARCH_FEEDBACK_NOT_AVAILABLE'),
    reason,
  });
}

function parseTradeBinding(value: unknown): ResearchJournalCandidateBinding | null {
  const binding = record(value);
  if (!binding
    || binding.schemaVersion !== BINDING_SCHEMA
    || !['VERIFIED', 'NOT_AVAILABLE', 'MISMATCH', 'NOT_APPLICABLE'].includes(String(binding.status))
    || binding.executionAuthority !== 'NONE'
    || binding.profitabilityCredit !== 0
    || typeof binding.settlementBindingVerified !== 'boolean') return null;
  const status = binding.status as ResearchJournalCandidateBinding['status'];
  const triggerBindingVerified = status === 'VERIFIED'
    && binding.settlementBindingVerified === true
    && binding.triggerBindingVerified === true
    && Boolean(text(binding.exitTriggerId, 240))
    && Boolean(text(binding.exitExecutionId, 240));
  const fullCostComponentCount = count(binding.fullCostComponentCount);
  const fullCostEvidenceDigest = text(binding.fullCostEvidenceDigest, 64);
  const fullCostBindingVerified = triggerBindingVerified
    && binding.fullCostBindingVerified === true
    && fullCostComponentCount === 8
    && Boolean(fullCostEvidenceDigest && /^[0-9a-f]{64}$/u.test(fullCostEvidenceDigest));
  const canonicalNetPnl = typeof binding.canonicalNetPnl === 'number' && Number.isFinite(binding.canonicalNetPnl)
    ? binding.canonicalNetPnl
    : null;
  const netPnlEvidenceDigest = text(binding.netPnlEvidenceDigest, 64);
  const netPnlBindingVerified = fullCostBindingVerified
    && binding.netPnlBindingVerified === true
    && canonicalNetPnl != null
    && Boolean(netPnlEvidenceDigest && /^[0-9a-f]{64}$/u.test(netPnlEvidenceDigest));
  return Object.freeze({
    status,
    reason: text(binding.reason) ?? 'CANONICAL_JOURNAL_BINDING_REASON_UNAVAILABLE',
    candidateId: status === 'VERIFIED' ? text(binding.candidateId, 200) : null,
    strategyId: status === 'VERIFIED' ? text(binding.strategyId, 200) : null,
    researchCodeSha: status === 'VERIFIED' && /^[0-9a-f]{40}$/u.test(String(binding.researchCodeSha ?? ''))
      ? String(binding.researchCodeSha)
      : null,
    settlementBindingVerified: binding.settlementBindingVerified,
    exitTriggerId: triggerBindingVerified ? text(binding.exitTriggerId, 240) : null,
    exitExecutionId: triggerBindingVerified ? text(binding.exitExecutionId, 240) : null,
    triggerBindingVerified,
    fullCostBindingVerified,
    fullCostEvidenceDigest: fullCostBindingVerified ? fullCostEvidenceDigest : null,
    fullCostComponentCount: fullCostBindingVerified ? fullCostComponentCount : 0,
    netPnlBindingVerified,
    canonicalNetPnl: netPnlBindingVerified ? canonicalNetPnl : null,
    netPnlEvidenceDigest: netPnlBindingVerified ? netPnlEvidenceDigest : null,
  });
}

function parseLiveFeedback(value: unknown): ResearchLiveFeedbackReadback {
  const summary = record(value);
  if (!summary
    || summary.schemaVersion !== 'unified-journal-live-research-feedback-v1'
    || !['VERIFIED', 'PARTIAL', 'NOT_AVAILABLE'].includes(String(summary.status))
    || summary.source !== 'APP_AUTO_JOURNAL'
    || summary.observationOnly !== true
    || summary.researchMutationAllowed !== false
    || summary.promotionAuthority !== false
    || summary.executionAuthority !== 'NONE'
    || summary.profitabilityCredit !== 0) {
    return emptyLive('LIVE_RESEARCH_FEEDBACK_NOT_EXPOSED');
  }
  const records = Array.isArray(summary.records)
    ? summary.records.flatMap((raw) => {
      const row = record(raw);
      if (!row
        || !['LINEAGE_VERIFIED', 'NOT_AVAILABLE', 'MISMATCH'].includes(String(row.status))
        || row.observationOnly !== true
        || row.researchMutationAllowed !== false
        || row.promotionAuthority !== false
        || row.executionAuthority !== 'NONE'
        || row.profitabilityCredit !== 0
        || !['OPEN', 'CLOSED'].includes(String(row.journalStatus))) return [];
      return [Object.freeze({
        status: row.status as ResearchLiveFeedbackRecord['status'],
        reason: text(row.reason) ?? 'LIVE_RESEARCH_FEEDBACK_REASON_UNAVAILABLE',
        candidateId: text(row.candidateId, 200),
        strategyId: text(row.strategyId, 200),
        researchCodeSha: /^[0-9a-f]{40}$/u.test(String(row.researchCodeSha ?? '')) ? String(row.researchCodeSha) : null,
        handoffId: text(row.handoffId, 240),
        journalStatus: row.journalStatus as 'OPEN'|'CLOSED',
        netPnlObserved: typeof row.netPnlObserved === 'number' && Number.isFinite(row.netPnlObserved) ? row.netPnlObserved : null,
        observationOnly: true as const,
        researchMutationAllowed: false as const,
        promotionAuthority: false as const,
        executionAuthority: 'NONE' as const,
        profitabilityCredit: 0 as const,
      })];
    })
    : [];
  return Object.freeze({
    status: summary.status as ResearchLiveFeedbackReadback['status'],
    autoTradeCount: count(summary.autoTradeCount),
    lineageVerifiedCount: count(summary.lineageVerifiedCount),
    mismatchTradeCount: count(summary.mismatchTradeCount),
    unavailableTradeCount: count(summary.unavailableTradeCount),
    closedObservedCount: count(summary.closedObservedCount),
    records: Object.freeze(records),
    reason: 'APP_AUTO_JOURNAL_OBSERVATION_READBACK',
  });
}

export async function fetchResearchJournalBinding(signal?: AbortSignal): Promise<ResearchJournalBindingReadback> {
  const response = await authorizedFetch('/api/paper-journal/unified-ledger?range=ALL', {
    cache: 'no-store',
    signal,
  });
  const body = await response.json().catch(() => null) as unknown;
  const envelope = record(body);
  if (!response.ok || !envelope || envelope.mode !== 'analysis-only' || envelope.externalAiCalled !== false) {
    throw new Error('RESEARCH_JOURNAL_BINDING_READ_FAILED');
  }
  const result = record(envelope.result);
  if (!result) return empty('UNIFIED_JOURNAL_RESULT_UNAVAILABLE');
  const summary = record(result.canonicalResearchBinding);
  if (!summary
    || summary.schemaVersion !== BINDING_SCHEMA
    || !['VERIFIED', 'PARTIAL', 'NOT_AVAILABLE'].includes(String(summary.status))
    || summary.source !== 'AUTHENTICATED_PAPER_STATE'
    || summary.executionAuthority !== 'NONE'
    || summary.profitabilityCredit !== 0) {
    return empty('CANONICAL_JOURNAL_BINDING_NOT_EXPOSED');
  }

  const trades = Array.isArray(result.trades)
    ? result.trades.flatMap((trade) => {
      const binding = parseTradeBinding(record(trade)?.canonicalResearchBinding);
      return binding ? [binding] : [];
    })
    : [];

  return Object.freeze({
    status: summary.status as ResearchJournalBindingReadback['status'],
    source: 'AUTHENTICATED_PAPER_STATE' as const,
    sourceSha: /^[0-9a-f]{40}$/u.test(String(summary.sourceSha ?? '')) ? String(summary.sourceSha) : null,
    paperTradeCount: count(summary.paperTradeCount),
    verifiedTradeCount: count(summary.verifiedTradeCount),
    mismatchTradeCount: count(summary.mismatchTradeCount),
    unavailableTradeCount: count(summary.unavailableTradeCount),
    trades: Object.freeze(trades),
    liveFeedback: parseLiveFeedback(result.liveResearchFeedback),
    reason: 'CANONICAL_JOURNAL_BINDING_READBACK',
  });
}

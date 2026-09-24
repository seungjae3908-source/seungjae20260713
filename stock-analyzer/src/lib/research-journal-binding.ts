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
  });
}

export async function fetchResearchJournalBinding(signal?: AbortSignal): Promise<ResearchJournalBindingReadback> {
  const response = await authorizedFetch('/api/paper-journal/unified-ledger?source=APP_PAPER&range=ALL', {
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
    reason: 'CANONICAL_JOURNAL_BINDING_READBACK',
  });
}

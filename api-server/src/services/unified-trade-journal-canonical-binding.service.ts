import type { PaperJournalEntry, PaperTradingState } from './paper-trading.types';
import {
  consumeManualSameCandidateValidationReceipt,
  manualPaperEvidenceSha256,
  type ManualPaperCanonicalIdentity,
} from './manual-paper-canonical-contract.service';
import { readAuthenticatedPaperTradingState } from './paper-trading-state-publisher.service';
import type { UnifiedTradeCycle, UnifiedTradeJournalResult } from './unified-trade-journal.service';

export const UNIFIED_JOURNAL_CANONICAL_RESEARCH_BINDING_SCHEMA_VERSION =
  'unified-journal-canonical-research-binding-v1' as const;

export type CanonicalResearchBindingStatus =
  | 'VERIFIED'
  | 'NOT_AVAILABLE'
  | 'MISMATCH'
  | 'NOT_APPLICABLE';

export type CanonicalResearchJournalBinding = Readonly<{
  schemaVersion: typeof UNIFIED_JOURNAL_CANONICAL_RESEARCH_BINDING_SCHEMA_VERSION;
  status: CanonicalResearchBindingStatus;
  reason: string;
  candidateId: string | null;
  strategyId: string | null;
  parameterHash: string | null;
  researchCodeSha: string | null;
  naturalPositionId: string | null;
  paperSampleId: string | null;
  settlementId: string | null;
  settlementBindingVerified: boolean;
  executionAuthority: 'NONE';
  profitabilityCredit: 0;
}>;

export type CanonicalResearchBindingSummary = Readonly<{
  schemaVersion: typeof UNIFIED_JOURNAL_CANONICAL_RESEARCH_BINDING_SCHEMA_VERSION;
  status: 'VERIFIED' | 'PARTIAL' | 'NOT_AVAILABLE';
  source: 'AUTHENTICATED_PAPER_STATE';
  sourceSha: string | null;
  paperTradeCount: number;
  verifiedTradeCount: number;
  mismatchTradeCount: number;
  unavailableTradeCount: number;
  executionAuthority: 'NONE';
  profitabilityCredit: 0;
}>;

export type CanonicalResearchOwnerStateReadback =
  | Readonly<{ status: 'PRESENT'; sourceSha: string; state: PaperTradingState }>
  | Readonly<{ status: 'NOT_AVAILABLE'; sourceSha: string | null; reason: string }>;

export type CanonicalResearchBoundJournal = Omit<UnifiedTradeJournalResult, 'trades'> & Readonly<{
  trades: Array<UnifiedTradeCycle & Readonly<{ canonicalResearchBinding: CanonicalResearchJournalBinding }>>;
  canonicalResearchBinding: CanonicalResearchBindingSummary;
}>;

const SHA40 = /^[0-9a-f]{40}$/u;
const EPSILON = 1e-9;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeReadbackReason(cause: unknown): string {
  const value = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : cause instanceof Error
      ? cause.message
      : '';
  return /^PAPER_STATE_[A-Z0-9_]+$/u.test(value)
    ? value
    : 'PAPER_STATE_OWNER_READBACK_UNAVAILABLE';
}

function binding(
  status: CanonicalResearchBindingStatus,
  reason: string,
  lineage?: Readonly<{
    identity: ManualPaperCanonicalIdentity;
    naturalPositionId: string;
    paperSampleId: string;
    settlementId: string | null;
    settlementBindingVerified: boolean;
  }>,
): CanonicalResearchJournalBinding {
  return Object.freeze({
    schemaVersion: UNIFIED_JOURNAL_CANONICAL_RESEARCH_BINDING_SCHEMA_VERSION,
    status,
    reason,
    candidateId: lineage?.identity.candidateId ?? null,
    strategyId: lineage?.identity.strategyId ?? null,
    parameterHash: lineage?.identity.parameterHash ?? null,
    researchCodeSha: lineage?.identity.researchCodeSha ?? null,
    naturalPositionId: lineage?.naturalPositionId ?? null,
    paperSampleId: lineage?.paperSampleId ?? null,
    settlementId: lineage?.settlementId ?? null,
    settlementBindingVerified: lineage?.settlementBindingVerified ?? false,
    executionAuthority: 'NONE',
    profitabilityCredit: 0,
  });
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === 'number'
    && Number.isFinite(left)
    && typeof right === 'number'
    && Number.isFinite(right)
    && Math.abs(left - right) <= EPSILON;
}

function sameNullableTimestamp(left: string | null, right: string | null): boolean {
  if (left == null || right == null) return left === right;
  return Number.isFinite(Date.parse(left))
    && Number.isFinite(Date.parse(right))
    && Date.parse(left) === Date.parse(right);
}

function ownerJournalMatchesTrade(owner: PaperJournalEntry, trade: UnifiedTradeCycle): boolean {
  const side = owner.side === 'short' ? 'SHORT' : 'LONG';
  const status = owner.status === 'closed' ? 'CLOSED' : 'OPEN';
  return owner.tradeId === trade.id
    && owner.symbol.toUpperCase() === trade.symbol
    && side === trade.positionSide
    && status === trade.status
    && sameNumber(owner.entryPrice, trade.entryPrice)
    && sameNumber(owner.initialQuantity, trade.totalQuantity)
    && sameNumber(owner.closedQuantity, trade.closedQuantity)
    && sameNumber(owner.remainingQuantity, trade.remainingQuantity)
    && Date.parse(owner.filledAt) === Date.parse(trade.openedAt)
    && sameNullableTimestamp(owner.closedAt, trade.closedAt)
    && (trade.strategy == null || owner.strategyName === trade.strategy);
}

function validateIdentity(value: unknown): value is ManualPaperCanonicalIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return text(identity.candidateId)
    && text(identity.strategyId)
    && text(identity.parameterHash)
    && text(identity.market)
    && text(identity.symbol)
    && text(identity.timeframe)
    && (identity.side === 'LONG' || identity.side === 'SHORT')
    && typeof identity.leverage === 'number'
    && Number.isFinite(identity.leverage)
    && identity.leverage > 0
    && text(identity.parameterDigest)
    && text(identity.signalDirection)
    && identity.accountMode === 'PAPER'
    && typeof identity.researchCodeSha === 'string'
    && SHA40.test(identity.researchCodeSha);
}

function verifiedLineage(
  owner: PaperJournalEntry,
  trade: UnifiedTradeCycle,
  sourceSha: string,
  nowMs: number,
): CanonicalResearchJournalBinding {
  const lineage = owner.canonicalPaper;
  if (!lineage) return binding('NOT_AVAILABLE', 'CANONICAL_PAPER_LINEAGE_NOT_PRESENT');
  if (!validateIdentity(lineage.identity)
    || lineage.identity.researchCodeSha !== sourceSha
    || lineage.identity.symbol.toUpperCase() !== trade.symbol
    || lineage.identity.side !== trade.positionSide
    || lineage.executionAuthority !== 'NONE'
    || lineage.naturalSampleCredit !== 0
    || !text(lineage.naturalPositionId)
    || !text(lineage.paperSampleId)) {
    return binding('MISMATCH', 'CANONICAL_PAPER_OWNER_LINEAGE_MISMATCH');
  }

  const verifiedAtMs = lineage.validationReceipt.verification?.verifiedAtMs;
  if (!Number.isSafeInteger(verifiedAtMs) || verifiedAtMs > nowMs) {
    return binding('MISMATCH', 'CANONICAL_PAPER_VALIDATION_RECEIPT_INVALID');
  }
  try {
    // Persisted owner lineage is historical evidence. Re-validate that the receipt
    // was fresh at its server-owned verification time; do not make a valid old
    // trade become mismatched merely because wall-clock time advanced.
    consumeManualSameCandidateValidationReceipt(
      lineage.validationReceipt.receipt,
      lineage.validationReceipt.verification,
      lineage.identity,
      verifiedAtMs,
    );
  } catch {
    return binding('MISMATCH', 'CANONICAL_PAPER_VALIDATION_RECEIPT_INVALID');
  }

  let settlementId: string | null = null;
  let settlementBindingVerified = false;
  const settlement = lineage.settlement as Record<string, unknown> | undefined;
  if (settlement) {
    const settlementIdentity = settlement.settlementIdentity;
    const fullCost = lineage.fullCost as Record<string, unknown> | undefined;
    const identity = settlementIdentity && typeof settlementIdentity === 'object' && !Array.isArray(settlementIdentity)
      ? settlementIdentity as Record<string, unknown>
      : null;
    const candidateMatch = identity?.candidateId === lineage.identity.candidateId;
    const positionMatch = identity?.positionId === lineage.naturalPositionId;
    const entryMatch = identity?.entryId === lineage.paperSampleId;
    const storedId = text(settlement.settlementId) ? settlement.settlementId : null;
    const digestMatch = storedId != null && identity != null
      && storedId === manualPaperEvidenceSha256(identity);
    const triggerMatch = text(settlement.exitTriggerId)
      && settlement.exitTriggerId === fullCost?.exitTriggerId;
    const executionMatch = text(settlement.exitExecutionId)
      && settlement.exitExecutionId === fullCost?.exitExecutionId;
    if (candidateMatch && positionMatch && entryMatch && digestMatch && triggerMatch && executionMatch) {
      settlementId = storedId;
      settlementBindingVerified = true;
    }
  }

  return binding('VERIFIED', 'AUTHENTICATED_PAPER_STATE_IDENTITY_MATCHED', {
    identity: lineage.identity,
    naturalPositionId: lineage.naturalPositionId,
    paperSampleId: lineage.paperSampleId,
    settlementId,
    settlementBindingVerified,
  });
}

export async function readCanonicalResearchOwnerStateForJournalBinding(
  input: Readonly<{
    authenticatedAccountId: string;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
    readState?: (input: Readonly<{
      authenticatedPublisherAccountId: string;
      sourceSha: string;
      nowMs: number;
    }>) => Promise<PaperTradingState>;
  }>,
): Promise<CanonicalResearchOwnerStateReadback> {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const sourceSha = String(env.DEPLOY_SHA ?? '').trim().toLowerCase();
  if (!SHA40.test(sourceSha)) {
    return Object.freeze({
      status: 'NOT_AVAILABLE',
      sourceSha: null,
      reason: 'PAPER_STATE_EXACT_DEPLOY_SHA_UNAVAILABLE',
    });
  }
  const readState = input.readState ?? ((request) => readAuthenticatedPaperTradingState(request, { env }));
  try {
    const state = await readState({
      authenticatedPublisherAccountId: input.authenticatedAccountId,
      sourceSha,
      nowMs,
    });
    return Object.freeze({ status: 'PRESENT', sourceSha, state });
  } catch (cause) {
    return Object.freeze({
      status: 'NOT_AVAILABLE',
      sourceSha,
      reason: safeReadbackReason(cause),
    });
  }
}

export function bindCanonicalResearchToUnifiedJournal(
  journal: UnifiedTradeJournalResult,
  ownerReadback: CanonicalResearchOwnerStateReadback,
  nowMs = Date.now(),
): CanonicalResearchBoundJournal {
  const ownerJournal = ownerReadback.status === 'PRESENT' ? ownerReadback.state.journal : [];
  const boundTrades = journal.trades.map((trade) => {
    let canonicalResearchBinding: CanonicalResearchJournalBinding;
    if (trade.source !== 'APP_PAPER') {
      canonicalResearchBinding = binding('NOT_APPLICABLE', 'NON_PAPER_JOURNAL_SOURCE');
    } else if (ownerReadback.status !== 'PRESENT') {
      canonicalResearchBinding = binding('NOT_AVAILABLE', ownerReadback.reason);
    } else {
      const matches = ownerJournal.filter((entry) => entry.tradeId === trade.id);
      if (matches.length === 0) {
        canonicalResearchBinding = binding('NOT_AVAILABLE', 'AUTHENTICATED_PAPER_JOURNAL_RECORD_NOT_FOUND');
      } else if (matches.length !== 1) {
        canonicalResearchBinding = binding('MISMATCH', 'AUTHENTICATED_PAPER_JOURNAL_RECORD_AMBIGUOUS');
      } else if (!ownerJournalMatchesTrade(matches[0]!, trade)) {
        canonicalResearchBinding = binding('MISMATCH', 'SYNCED_JOURNAL_OWNER_STATE_MISMATCH');
      } else {
        canonicalResearchBinding = verifiedLineage(matches[0]!, trade, ownerReadback.sourceSha, nowMs);
      }
    }
    return Object.freeze({ ...trade, canonicalResearchBinding });
  });

  const paperBindings = boundTrades
    .filter((trade) => trade.source === 'APP_PAPER')
    .map((trade) => trade.canonicalResearchBinding);
  const verifiedTradeCount = paperBindings.filter((value) => value.status === 'VERIFIED').length;
  const mismatchTradeCount = paperBindings.filter((value) => value.status === 'MISMATCH').length;
  const unavailableTradeCount = paperBindings.filter((value) => value.status === 'NOT_AVAILABLE').length;
  const status: CanonicalResearchBindingSummary['status'] = paperBindings.length === 0
    ? 'NOT_AVAILABLE'
    : verifiedTradeCount === paperBindings.length
      ? 'VERIFIED'
      : verifiedTradeCount > 0
        ? 'PARTIAL'
        : 'NOT_AVAILABLE';

  return Object.freeze({
    ...journal,
    trades: boundTrades,
    canonicalResearchBinding: Object.freeze({
      schemaVersion: UNIFIED_JOURNAL_CANONICAL_RESEARCH_BINDING_SCHEMA_VERSION,
      status,
      source: 'AUTHENTICATED_PAPER_STATE' as const,
      sourceSha: ownerReadback.sourceSha,
      paperTradeCount: paperBindings.length,
      verifiedTradeCount,
      mismatchTradeCount,
      unavailableTradeCount,
      executionAuthority: 'NONE' as const,
      profitabilityCredit: 0 as const,
    }),
  });
}

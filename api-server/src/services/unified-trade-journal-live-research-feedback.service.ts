import type {
  UnifiedResearchLineage,
  UnifiedTradeCycle,
  UnifiedTradeJournalResult,
} from './unified-trade-journal.service';

export const UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_VERSION =
  'unified-journal-live-research-feedback-v1' as const;

export type LiveResearchFeedbackStatus =
  | 'LINEAGE_VERIFIED'
  | 'NOT_AVAILABLE'
  | 'MISMATCH'
  | 'NOT_APPLICABLE';

export type LiveResearchFeedbackRecord = Readonly<{
  schemaVersion: typeof UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_VERSION;
  tradeId: string;
  status: LiveResearchFeedbackStatus;
  reason: string;
  candidateId: string | null;
  strategyId: string | null;
  strategyVersion: string | null;
  parameterHash: string | null;
  researchCodeSha: string | null;
  costPolicyVersion: string | null;
  handoffId: string | null;
  market: UnifiedTradeCycle['market'];
  symbol: string;
  positionSide: UnifiedTradeCycle['positionSide'];
  journalStatus: UnifiedTradeCycle['status'];
  grossPnlObserved: number;
  netPnlObserved: number | null;
  netReturnPercentObserved: number | null;
  transactionCostEvidenceReady: boolean;
  observationOnly: true;
  researchMutationAllowed: false;
  promotionAuthority: false;
  executionAuthority: 'NONE';
  profitabilityCredit: 0;
}>;

export type LiveResearchFeedbackSummary = Readonly<{
  schemaVersion: typeof UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_VERSION;
  status: 'VERIFIED' | 'PARTIAL' | 'NOT_AVAILABLE';
  source: 'APP_AUTO_JOURNAL';
  autoTradeCount: number;
  lineageVerifiedCount: number;
  mismatchTradeCount: number;
  unavailableTradeCount: number;
  closedObservedCount: number;
  records: readonly LiveResearchFeedbackRecord[];
  observationOnly: true;
  researchMutationAllowed: false;
  promotionAuthority: false;
  executionAuthority: 'NONE';
  profitabilityCredit: 0;
}>;

function expectedPositionSide(direction: UnifiedResearchLineage['direction']) {
  return direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const;
}

function record(
  trade: UnifiedTradeCycle,
  status: LiveResearchFeedbackStatus,
  reason: string,
  lineage: UnifiedResearchLineage | null = null,
): LiveResearchFeedbackRecord {
  return Object.freeze({
    schemaVersion: UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_VERSION,
    tradeId: trade.id,
    status,
    reason,
    candidateId: lineage?.candidateId ?? null,
    strategyId: lineage?.strategyId ?? null,
    strategyVersion: lineage?.strategyVersion ?? null,
    parameterHash: lineage?.parameterHash ?? null,
    researchCodeSha: lineage?.researchCodeSha ?? null,
    costPolicyVersion: lineage?.costPolicyVersion ?? null,
    handoffId: lineage?.handoffId ?? null,
    market: trade.market,
    symbol: trade.symbol,
    positionSide: trade.positionSide,
    journalStatus: trade.status,
    grossPnlObserved: trade.grossPnl,
    netPnlObserved: trade.netPnl,
    netReturnPercentObserved: trade.netReturnPercent,
    transactionCostEvidenceReady: trade.costEvidence.status === 'READY',
    observationOnly: true as const,
    researchMutationAllowed: false as const,
    promotionAuthority: false as const,
    executionAuthority: 'NONE' as const,
    profitabilityCredit: 0 as const,
  });
}

function feedbackForTrade(trade: UnifiedTradeCycle): LiveResearchFeedbackRecord {
  if (trade.source !== 'APP_AUTO') {
    return record(trade, 'NOT_APPLICABLE', 'NON_AUTO_JOURNAL_SOURCE');
  }
  if (trade.researchLineage === null) {
    return record(trade, 'MISMATCH', 'APP_AUTO_RESEARCH_LINEAGE_CONFLICT');
  }
  const lineage = trade.researchLineage;
  if (!lineage) {
    return record(trade, 'NOT_AVAILABLE', 'APP_AUTO_RESEARCH_LINEAGE_NOT_PRESENT');
  }
  if (!lineage.candidateId) {
    return record(trade, 'NOT_AVAILABLE', 'APP_AUTO_CANDIDATE_ID_NOT_AVAILABLE', lineage);
  }
  if (lineage.market !== trade.market
    || lineage.symbol.toUpperCase() !== trade.symbol.toUpperCase()
    || expectedPositionSide(lineage.direction) !== trade.positionSide
    || lineage.strategyId !== trade.strategy) {
    return record(trade, 'MISMATCH', 'APP_AUTO_RESEARCH_LINEAGE_TRADE_MISMATCH', lineage);
  }
  return record(trade, 'LINEAGE_VERIFIED', 'APP_AUTO_RESEARCH_LINEAGE_MATCHED', lineage);
}

export function buildLiveAutoResearchFeedback(
  journal: Pick<UnifiedTradeJournalResult, 'trades'>,
): LiveResearchFeedbackSummary {
  const records = journal.trades
    .filter((trade) => trade.source === 'APP_AUTO')
    .map(feedbackForTrade);
  const lineageVerifiedCount = records.filter((row) => row.status === 'LINEAGE_VERIFIED').length;
  const mismatchTradeCount = records.filter((row) => row.status === 'MISMATCH').length;
  const unavailableTradeCount = records.filter((row) => row.status === 'NOT_AVAILABLE').length;
  const closedObservedCount = records.filter((row) => row.journalStatus === 'CLOSED').length;
  const status: LiveResearchFeedbackSummary['status'] = records.length === 0
    ? 'NOT_AVAILABLE'
    : lineageVerifiedCount === records.length
      ? 'VERIFIED'
      : lineageVerifiedCount > 0
        ? 'PARTIAL'
        : 'NOT_AVAILABLE';
  return Object.freeze({
    schemaVersion: UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_VERSION,
    status,
    source: 'APP_AUTO_JOURNAL' as const,
    autoTradeCount: records.length,
    lineageVerifiedCount,
    mismatchTradeCount,
    unavailableTradeCount,
    closedObservedCount,
    records: Object.freeze(records),
    observationOnly: true as const,
    researchMutationAllowed: false as const,
    promotionAuthority: false as const,
    executionAuthority: 'NONE' as const,
    profitabilityCredit: 0 as const,
  });
}

export const UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_SAFETY = Object.freeze({
  readOnly: true,
  journalObservationOnly: true,
  researchMutationAllowed: false,
  promotionAuthority: false,
  executionAuthority: 'NONE' as const,
  profitabilityCredit: 0 as const,
  liveOrderAuthority: false,
  privateTradingApiAuthority: false,
});

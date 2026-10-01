import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import type { PaperContractRules, PaperTradingState } from './paper-trading.types';
import {
  validateImmutablePaperTradingStateSnapshot,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';
import {
  sizePumpReversalPaperRisk,
  type PumpPaperAccountRiskSnapshot,
  type PumpProspectiveOpenRecord,
  type PumpPublicDepthSnapshot,
  type PumpRiskSizingResult,
} from './pump-reversal-paper-risk-sizing.service';

export const PUMP_REVERSAL_PROSPECTIVE_RISK_OWNER_VERSION =
  'pump-reversal-prospective-risk-owner-v1' as const;

type SourceContext = Readonly<{
  record: PumpProspectiveOpenRecord;
  observedAtMs: number;
  account?: PumpPaperAccountRiskSnapshot;
}>;

export type PumpReversalProspectiveRiskOwnerSources = Readonly<{
  paperStateSnapshotForRecord: (context: SourceContext) => unknown | Promise<unknown>;
  contractRulesForRecord: (context: SourceContext) => PaperContractRules | Promise<PaperContractRules>;
  publicEvidenceForRecord: (context: SourceContext) => BitgetFuturesPublicEvidence | Promise<BitgetFuturesPublicEvidence>;
  depthForRecord: (context: SourceContext) => PumpPublicDepthSnapshot | Promise<PumpPublicDepthSnapshot>;
  supplementalCostEvidenceForRecord:
    (context: SourceContext) => SupplementalExecutionCostEvidence | Promise<SupplementalExecutionCostEvidence>;
}>;

export type PumpReversalProspectiveRiskOwnerBlocked = Readonly<{
  status: 'BLOCKED';
  version: typeof PUMP_REVERSAL_PROSPECTIVE_RISK_OWNER_VERSION;
  blockers: readonly string[];
  sourceStage: 'PAPER_STATE' | 'AUTHORITATIVE_SOURCES' | 'RISK_SIZING';
  executionAuthority: 'NONE';
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function blocked(
  sourceStage: PumpReversalProspectiveRiskOwnerBlocked['sourceStage'],
  blockers: readonly string[],
): PumpReversalProspectiveRiskOwnerBlocked {
  return Object.freeze({
    status: 'BLOCKED',
    version: PUMP_REVERSAL_PROSPECTIVE_RISK_OWNER_VERSION,
    blockers: Object.freeze([...new Set(blockers)]),
    sourceStage,
    executionAuthority: 'NONE',
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

export function buildPumpPaperAccountRiskSnapshot(
  snapshotValue: PaperTradingStateSnapshot | unknown,
  nowMs = Date.now(),
): PumpPaperAccountRiskSnapshot {
  if (!positive(nowMs)) throw new Error('PUMP_RISK_OWNER_CLOCK_INVALID');
  const snapshot = validateImmutablePaperTradingStateSnapshot(snapshotValue, nowMs);
  if (snapshot.market !== 'CRYPTO_FUTURES' || snapshot.currency !== 'USDT') {
    throw new Error('PUMP_RISK_OWNER_PAPER_STATE_MARKET_MISMATCH');
  }
  const state = snapshot.state as Readonly<PaperTradingState>;
  const openPositions = state.positions.filter((position) => position.status !== 'closed');
  const openExposure = openPositions.reduce((sum, position) => sum + Number(position.notionalValue), 0);
  const sameDirectionExposure = openPositions
    .filter((position) => position.side === 'short')
    .reduce((sum, position) => sum + Number(position.notionalValue), 0);
  if (!positive(state.account.equity)
    || !finite(state.riskState.dailyRealizedPnl)
    || !finite(state.riskState.weeklyRealizedPnl)
    || !Number.isInteger(state.riskState.consecutiveLosses)
    || state.riskState.consecutiveLosses < 0
    || !nonNegative(openExposure)
    || !nonNegative(sameDirectionExposure)
    || !safeTime(snapshot.observedAtMs)) {
    throw new Error('PUMP_RISK_OWNER_PAPER_STATE_RISK_INVALID');
  }
  return Object.freeze({
    equity: state.account.equity,
    dailyRealizedPnl: state.riskState.dailyRealizedPnl,
    weeklyRealizedPnl: state.riskState.weeklyRealizedPnl,
    consecutiveLosses: state.riskState.consecutiveLosses,
    openExposure,
    sameDirectionExposure,
    observedAtMs: snapshot.observedAtMs,
  });
}

export function createPumpReversalProspectiveRiskOwner(input: Readonly<{
  sources: PumpReversalProspectiveRiskOwnerSources;
  sizeRisk?: typeof sizePumpReversalPaperRisk;
}>): (context: Readonly<{
  record: PumpProspectiveOpenRecord;
  state?: unknown;
  observedAtMs: number;
}>) => Promise<PumpRiskSizingResult | PumpReversalProspectiveRiskOwnerBlocked> {
  const sources = input?.sources;
  const sizeRisk = input?.sizeRisk ?? sizePumpReversalPaperRisk;
  if (!sources
    || typeof sources.paperStateSnapshotForRecord !== 'function'
    || typeof sources.contractRulesForRecord !== 'function'
    || typeof sources.publicEvidenceForRecord !== 'function'
    || typeof sources.depthForRecord !== 'function'
    || typeof sources.supplementalCostEvidenceForRecord !== 'function'
    || typeof sizeRisk !== 'function') {
    throw new TypeError('Pump prospective risk owner sources are required');
  }

  return async ({ record, observedAtMs }) => {
    if (!safeTime(observedAtMs) || record?.status !== 'OPEN') {
      return blocked('PAPER_STATE', ['PUMP_RISK_OWNER_OPEN_RECORD_AND_TIME_REQUIRED']);
    }
    const snapshotContext = Object.freeze({ record, observedAtMs });

    let snapshot: unknown;
    try {
      snapshot = await sources.paperStateSnapshotForRecord(snapshotContext);
    } catch {
      return blocked('PAPER_STATE', ['PUMP_RISK_OWNER_PAPER_STATE_SOURCE_FAILED']);
    }

    let account: PumpPaperAccountRiskSnapshot;
    try {
      account = buildPumpPaperAccountRiskSnapshot(snapshot, observedAtMs);
    } catch (error) {
      return blocked('PAPER_STATE', [
        error instanceof Error && /^[A-Z0-9_:-]+$/u.test(error.message)
          ? error.message
          : 'PUMP_RISK_OWNER_PAPER_STATE_INVALID',
      ]);
    }

    const context = Object.freeze({ record, observedAtMs, account });
    let contractRules: PaperContractRules;
    let publicEvidence: BitgetFuturesPublicEvidence;
    let depth: PumpPublicDepthSnapshot;
    let supplementalCostEvidence: SupplementalExecutionCostEvidence;
    try {
      [contractRules, publicEvidence, depth, supplementalCostEvidence] = await Promise.all([
        sources.contractRulesForRecord(context),
        sources.publicEvidenceForRecord(context),
        sources.depthForRecord(context),
        sources.supplementalCostEvidenceForRecord(context),
      ]);
    } catch {
      return blocked('AUTHORITATIVE_SOURCES', ['PUMP_RISK_OWNER_AUTHORITATIVE_SOURCE_FAILED']);
    }

    if (!contractRules || !publicEvidence || !depth || !supplementalCostEvidence) {
      return blocked('AUTHORITATIVE_SOURCES', ['PUMP_RISK_OWNER_AUTHORITATIVE_SOURCE_MISSING']);
    }

    try {
      return sizeRisk({
        record,
        account,
        contractRules,
        publicEvidence,
        depth,
        supplementalCostEvidence,
        nowMs: observedAtMs,
      });
    } catch {
      return blocked('RISK_SIZING', ['PUMP_RISK_OWNER_SIZING_FAILED']);
    }
  };
}

export const PUMP_REVERSAL_PROSPECTIVE_RISK_OWNER_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_PROSPECTIVE_RISK_OWNER_VERSION,
  paperStateSnapshotRequired: true,
  publicMarketEvidenceRequired: true,
  publicL2DepthRequired: true,
  supplementalCostEvidenceRequired: true,
  riskEngineReused: true,
  financialMutationAllowed: false,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
});

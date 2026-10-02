import { createHash } from 'node:crypto';
import { buildFourMarketPaperSample } from '../../../market-prediction-lab/src/four-market-paper-sampler-v1.js';
import { settleFourMarketPaperSample } from '../../../market-prediction-lab/src/four-market-paper-settlement-v1.js';
import { buildRecurringPaperSettlementRecord } from '../../../market-prediction-lab/src/recurring-paper-loop-v1.js';
import { adaptNaturalPaperSettlementFullCost, advanceNaturalPaperPositionLifecycle, NATURAL_SETTLEMENT_COST_COMPONENTS } from '../../../market-prediction-lab/src/natural-paper-position-settlement-lifecycle-v1.js';
import { validateNaturalPaperTriggerBoundSettlementEvidence } from '../../../market-prediction-lab/src/natural-paper-trigger-bound-settlement-cost-producer-v1.js';
import { PaperTradingError, positive } from './paper-trading-core.service';
import type { PaperTradingAction, PaperTradingState } from './paper-trading.types';

// External owner data is unknown until the runtime checks below have passed.
type Row = Record<string, any>;
export const MANUAL_PAPER_CANONICAL_FIELDS = Object.freeze([
  'candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage',
] as const);
export type ManualPaperCanonicalIdentity = Readonly<{
  candidateId: string; strategyId: string; parameterHash: string; market: string;
  symbol: string; timeframe: string; side: 'LONG' | 'SHORT'; leverage: number;
  parameterDigest: string; signalDirection: string; accountMode: 'PAPER'; researchCodeSha: string;
}>;
export type ManualPaperCanonicalReceiptVerification = Readonly<{
  ownerId: string; source: string; provenance: string; verifiedAtMs: number;
  readbackVerified: true; validationPassed: true; receiptSha256: string;
}>;
export type ManualPaperCanonicalCostComponent = Row & Readonly<{
  status: 'PRESENT';
  source: string;
  provenance: string;
  quality: 'OBSERVED' | 'DOCUMENTED' | 'ESTIMATED' | 'NOT_APPLICABLE';
  valuePercent: number;
  observedAtMs: number;
  policyIdentity: Row;
  identity: ManualPaperCanonicalIdentity;
  paperSampleId: string;
  positionId: string;
}>;
export type ManualPaperCanonicalFullCostComponents = Readonly<{
  commission: ManualPaperCanonicalCostComponent;
  slippage: ManualPaperCanonicalCostComponent;
  funding: ManualPaperCanonicalCostComponent;
  spread: ManualPaperCanonicalCostComponent;
  latency: ManualPaperCanonicalCostComponent;
  liquidityImpact: ManualPaperCanonicalCostComponent;
  partialFillImpact: ManualPaperCanonicalCostComponent;
  tax: ManualPaperCanonicalCostComponent;
}>;
export type ManualPaperCanonicalEntryCostEvidence = Row & Readonly<{
  status: 'PRESENT';
  fullCostReady: true;
  unknownIsZero: false;
  unavailableCostConvertedToZero: false;
  maximumAgeMs: number;
  components: ManualPaperCanonicalFullCostComponents;
}>;
export type ManualPaperCanonicalValidationReceipt = Row & Readonly<{
  identity: ManualPaperCanonicalIdentity;
  receiptId: string;
  receiptVersion: string;
  source: string;
  provenance: string;
  status: 'VALIDATED';
  observedAtMs: number;
  maximumAgeMs: number;
  synthetic: false;
  replay: false;
  backfill: false;
  historical: false;
  testOnly: false;
  datasetDigest: string;
  resultArtifactDigest: string;
}>;
export type ManualPaperCanonicalValidationReceiptEnvelope = Readonly<{
  receipt: ManualPaperCanonicalValidationReceipt;
  verification: ManualPaperCanonicalReceiptVerification;
}>;
export type ManualPaperCanonicalLineage = Readonly<{
  identity: ManualPaperCanonicalIdentity;
  naturalPositionId: string;
  paperSampleId: string;
  sample: Row;
  entryCostEvidence: ManualPaperCanonicalEntryCostEvidence;
  validationReceipt: ManualPaperCanonicalValidationReceiptEnvelope;
  settlement?: Row;
  fullCost?: Row;
  settlementBinding?: Row;
  naturalSampleCredit: 0;
  executionAuthority: 'NONE';
}>;

// Only a server-owned, authenticated read-only resolver may supply this argument.
// It is never read from the HTTP body, URL, browser preview, or persisted client claims.
export type ManualPaperCanonicalEvidence = Readonly<{
  authenticatedAccountId: string;
  paperAccountId: string;
  // Hash of the owner's read-back Paper state, not a hash of untrusted request JSON.
  paperStateSha256: string;
  candidate: unknown;
  position: unknown;
  entryCostEvidence: unknown;
  validationReceipt: unknown;
  receiptVerification: ManualPaperCanonicalReceiptVerification;
  settlement?: Readonly<{ observation: unknown; trigger: unknown }>;
}>;

function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PaperTradingError(code, 'Canonical Paper evidence가 누락되거나 동일 candidate와 일치하지 않습니다.');
}
function row(value: unknown): Row {
  requireEvidence(value && typeof value === 'object' && !Array.isArray(value), 'CANONICAL_PAPER_EVIDENCE_REQUIRED');
  return value as Row;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function manualPaperEvidenceSha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
export function assertManualPaperCanonicalIdentity(expected: ManualPaperCanonicalIdentity, actual: unknown): void {
  const value = row(actual);
  for (const key of [...MANUAL_PAPER_CANONICAL_FIELDS, 'parameterDigest', 'signalDirection', 'accountMode', 'researchCodeSha']) {
    requireEvidence(value[key] === expected[key as keyof ManualPaperCanonicalIdentity], `CANONICAL_PAPER_IDENTITY_MISMATCH_${key.toUpperCase()}`);
  }
}
export function consumeManualSameCandidateValidationReceipt(
  receiptValue: unknown, verification: ManualPaperCanonicalReceiptVerification,
  identity: ManualPaperCanonicalIdentity, nowMs: number,
): ManualPaperCanonicalValidationReceiptEnvelope {
  const receipt = row(receiptValue);
  requireEvidence(verification?.readbackVerified === true && verification.validationPassed === true
    && text(verification.ownerId) && text(verification.source) && text(verification.provenance)
    && Number.isSafeInteger(verification.verifiedAtMs) && verification.verifiedAtMs <= nowMs
    && verification.receiptSha256 === manualPaperEvidenceSha256(receipt), 'SAME_CANDIDATE_OWNER_VERIFIED_RECEIPT_REQUIRED');
  requireEvidence(text(receipt.receiptId) && text(receipt.receiptVersion) && text(receipt.source)
    && text(receipt.provenance) && receipt.status === 'VALIDATED'
    && Number.isSafeInteger(receipt.observedAtMs) && receipt.observedAtMs <= nowMs
    && positive(receipt.maximumAgeMs) && nowMs - receipt.observedAtMs <= receipt.maximumAgeMs
    && verification.verifiedAtMs >= receipt.observedAtMs,
  'SAME_CANDIDATE_VALIDATION_RECEIPT_INVALID');
  for (const flag of ['synthetic', 'replay', 'backfill', 'historical', 'testOnly']) {
    requireEvidence(receipt[flag] === false, 'SAME_CANDIDATE_GENUINE_VALIDATION_RECEIPT_REQUIRED');
  }
  assertManualPaperCanonicalIdentity(identity, receipt.identity);
  for (const digest of ['datasetDigest', 'resultArtifactDigest']) {
    requireEvidence(typeof receipt[digest] === 'string' && /^[0-9a-f]{64}$/.test(receipt[digest]), 'SAME_CANDIDATE_VALIDATION_ARTIFACT_BINDING_REQUIRED');
  }
  return structuredClone({ receipt, verification }) as ManualPaperCanonicalValidationReceiptEnvelope;
}

export function manualPaperCanonicalCandidateId(state: PaperTradingState, action: PaperTradingAction): string | null {
  if (action.type === 'place_order' && action.request?.canonicalIdentity) return action.request.canonicalIdentity.candidateId;
  if (!Array.isArray(state.orders) || !Array.isArray(state.positions)) return null;
  const records = [...state.orders, ...state.positions].filter(record => record.canonicalPaper);
  // Never route canonical positions through the legacy candle/close path, even if a client drops action metadata.
  return records[0]?.canonicalPaper?.identity.candidateId ?? null;
}

export function prepareManualPaperCanonicalEvidence(
  state: PaperTradingState, action: PaperTradingAction, evidence: ManualPaperCanonicalEvidence | undefined, nowMs: number,
): { lineage: ManualPaperCanonicalLineage; sample: Row; settlement?: Row } | null {
  const candidateId = manualPaperCanonicalCandidateId(state, action);
  if (candidateId === null && !evidence) return null;
  requireEvidence(evidence && text(evidence.authenticatedAccountId) && evidence.paperAccountId === state.account.id,
    'SERVER_OWNED_CANONICAL_PAPER_EVIDENCE_REQUIRED');
  requireEvidence(evidence.paperStateSha256 === manualPaperEvidenceSha256(state), 'CANONICAL_PAPER_OWNER_STATE_READBACK_REQUIRED');
  const candidate = row(evidence.candidate);
  const position = row(evidence.position);
  requireEvidence(candidate.sampleExecutionReady !== false && candidate.status !== 'BRIDGE_READY', 'CANONICAL_PAPER_EXECUTION_NOT_READY');
  // Rebuild through the real canonical sampler; a serialized OPEN assertion is insufficient.
  const sample = buildFourMarketPaperSample({ ...candidate, evaluatedAtMs: position.entryTimestampMs });
  requireEvidence(sample.status === 'OPEN' && sample.fill?.status === 'FILLED'
    && manualPaperEvidenceSha256(sample) === manualPaperEvidenceSha256(position.sample), 'CANONICAL_PAPER_OPEN_SAMPLE_REQUIRED');
  const direction = sample.identity.executionDirection;
  requireEvidence(['BUY', 'LONG', 'SHORT'].includes(direction), 'CANONICAL_PAPER_EXPLICIT_SIDE_REQUIRED');
  requireEvidence(!['NO_TRADE', 'SIGNAL_CONFLICT'].includes(sample.identity.signalDirection), 'CANONICAL_PAPER_SIGNAL_NOT_EXECUTABLE');
  // Cash-market Natural positions have no leverage accounting object. Preserve
  // the owner's explicit receipt identity; never manufacture a 1x fallback.
  const leverage = position.market === 'CRYPTO_FUTURES'
    ? position.accountingEvidence?.leverage : row(evidence.validationReceipt).identity?.leverage;
  requireEvidence(positive(leverage), 'CANONICAL_PAPER_LEVERAGE_PROVENANCE_REQUIRED');
  if (position.market === 'CRYPTO_FUTURES') {
    requireEvidence(candidate.execution?.dataEvidence?.leverage === leverage, 'CANONICAL_PAPER_FUTURES_LEVERAGE_MISMATCH');
  }
  const identity: ManualPaperCanonicalIdentity = Object.freeze({
    candidateId: position.candidateId, strategyId: position.strategyId, parameterHash: position.parameterHash,
    market: position.market, symbol: position.symbol, timeframe: sample.identity.timeframe,
    side: direction === 'SHORT' ? 'SHORT' : 'LONG', leverage,
    parameterDigest: position.parameterDigest, signalDirection: sample.identity.signalDirection,
    accountMode: position.accountMode, researchCodeSha: position.researchCodeSha,
  });
  for (const key of ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'signalDirection']) {
    requireEvidence(text(identity[key as keyof ManualPaperCanonicalIdentity]), 'CANONICAL_PAPER_IDENTITY_REQUIRED');
  }
  requireEvidence(identity.accountMode === 'PAPER' && identity.parameterDigest === identity.parameterHash
    && candidate.candidateId === identity.candidateId && candidate.signal?.strategyIdentity?.candidateId === identity.candidateId
    && position.lifecycle?.strategyIdentity?.parameterHash === identity.parameterHash,
  'CANONICAL_PAPER_FROZEN_IDENTITY_REQUIRED');
  requireEvidence(candidate.riskEvidence?.status === 'APPROVED' && candidate.riskEvidence.simulatedOnly === true
    && position.direction === direction && position.paperSampleId === sample.paperSampleId
    && position.positionId === manualPaperEvidenceSha256({ paperSampleId: sample.paperSampleId, entry: position.entryTimestampMs })
    && position.lifecycle?.identity?.positionId === position.positionId,
  'CANONICAL_PAPER_ADMISSION_POSITION_BINDING_REQUIRED');
  for (const key of ['candidateId', 'strategyId', 'parameterHash', 'parameterDigest', 'market', 'symbol', 'researchCodeSha', 'accountMode']) {
    requireEvidence(sample.identity[key] === identity[key as keyof ManualPaperCanonicalIdentity], 'CANONICAL_PAPER_SAMPLE_POSITION_IDENTITY_MISMATCH');
  }
  for (const key of ['candidateId', 'strategyId', 'strategyVersion', 'strategyFamily', 'parameterHash', 'parameterDigest', 'researchCodeSha', 'accountMode']) {
    requireEvidence(position.lifecycle.strategyIdentity[key] === sample.identity[key], 'CANONICAL_PAPER_FROZEN_LIFECYCLE_IDENTITY_MISMATCH');
  }
  const validationReceipt = consumeManualSameCandidateValidationReceipt(evidence.validationReceipt, evidence.receiptVerification, identity, nowMs);
  const entryCostEvidence = row(evidence.entryCostEvidence);
  requireEvidence(entryCostEvidence.status === 'PRESENT' && entryCostEvidence.fullCostReady === true
    && entryCostEvidence.unknownIsZero === false && entryCostEvidence.unavailableCostConvertedToZero === false,
  'CANONICAL_PAPER_ENTRY_FULL_COST_REQUIRED');
  for (const name of NATURAL_SETTLEMENT_COST_COMPONENTS) {
    const component = entryCostEvidence.components?.[name];
    requireEvidence(component?.status === 'PRESENT' && text(component.source) && text(component.provenance)
      && ['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE'].includes(component.quality)
      && (component.quality !== 'NOT_APPLICABLE' || component.valuePercent === 0)
      && Number.isFinite(component.valuePercent) && component.valuePercent >= 0
      && component.policyIdentity?.version === position.costPolicyVersion
      && Number.isSafeInteger(component.observedAtMs) && component.observedAtMs <= position.entryTimestampMs
      && positive(entryCostEvidence.maximumAgeMs) && position.entryTimestampMs - component.observedAtMs <= entryCostEvidence.maximumAgeMs
      && component.valuePercent / 100 === candidate.execution?.costPolicy?.[`${name}Rate`],
    `CANONICAL_PAPER_ENTRY_${name.toUpperCase()}_EVIDENCE_REQUIRED`);
    assertManualPaperCanonicalIdentity(identity, component.identity);
    requireEvidence(component.paperSampleId === sample.paperSampleId && component.positionId === position.positionId,
      'CANONICAL_PAPER_ENTRY_COST_POSITION_BINDING_REQUIRED');
  }
  const validatedEntryCostEvidence = structuredClone(entryCostEvidence) as ManualPaperCanonicalEntryCostEvidence;
  const lineage: ManualPaperCanonicalLineage = {
    identity, naturalPositionId: position.positionId, paperSampleId: sample.paperSampleId,
    sample: structuredClone(sample), entryCostEvidence: validatedEntryCostEvidence, validationReceipt,
    naturalSampleCredit: 0, executionAuthority: 'NONE',
  };
  for (const record of [...state.orders, ...state.positions, ...state.fills, ...state.journal]) {
    if (!record.canonicalPaper) continue;
    assertManualPaperCanonicalIdentity(identity, record.canonicalPaper.identity);
    requireEvidence(record.symbol === identity.symbol && record.side.toUpperCase() === identity.side
      && (!('leverage' in record) || record.leverage === identity.leverage)
      && record.canonicalPaper.executionAuthority === 'NONE' && record.canonicalPaper.naturalSampleCredit === 0,
    'CANONICAL_PAPER_ACTUAL_CONSUMER_IDENTITY_MISMATCH');
    requireEvidence(record.canonicalPaper.paperSampleId === lineage.paperSampleId
      && record.canonicalPaper.naturalPositionId === lineage.naturalPositionId
      && manualPaperEvidenceSha256(record.canonicalPaper.sample) === manualPaperEvidenceSha256(sample)
      && manualPaperEvidenceSha256(record.canonicalPaper.entryCostEvidence) === manualPaperEvidenceSha256(validatedEntryCostEvidence)
      && manualPaperEvidenceSha256(record.canonicalPaper.validationReceipt.receipt) === evidence.receiptVerification.receiptSha256,
    'CANONICAL_PAPER_PERSISTED_LINEAGE_MISMATCH');
    const storedSettlement = record.canonicalPaper.settlement;
    if (storedSettlement) {
      const expected = buildRecurringPaperSettlementRecord({
        settlement: storedSettlement, position,
        canonicalLifecycleEvidence: storedSettlement.lifecycleEvidence,
        exitReason: storedSettlement.exitReason,
        settlementRecordedAtMs: storedSettlement.settlementRecordedAtMs,
      });
      requireEvidence(storedSettlement.settlementId === expected.settlementId
        && manualPaperEvidenceSha256(storedSettlement.settlementIdentity) === manualPaperEvidenceSha256(expected.settlementIdentity)
        && storedSettlement.positionId === position.positionId && storedSettlement.entryId === sample.paperSampleId
        && storedSettlement.exitTriggerId === record.canonicalPaper.fullCost?.exitTriggerId
        && storedSettlement.exitExecutionId === record.canonicalPaper.fullCost?.exitExecutionId
        && expected.settlementIdentity.costEvidenceDigest === record.canonicalPaper.fullCost?.evidenceDigest
        && manualPaperEvidenceSha256(storedSettlement.lifecycleEvidence?.costEvidence) === manualPaperEvidenceSha256(record.canonicalPaper.fullCost),
      'CANONICAL_PAPER_SETTLEMENT_LINEAGE_MISMATCH');
      for (const key of ['candidateId', 'strategyId', 'parameterHash', 'parameterDigest', 'market', 'symbol', 'timeframe', 'accountMode', 'researchCodeSha']) {
        requireEvidence(storedSettlement[key] === identity[key as keyof ManualPaperCanonicalIdentity], 'CANONICAL_PAPER_SETTLEMENT_LINEAGE_MISMATCH');
      }
      requireEvidence(['BUY', 'LONG', 'SHORT'].includes(storedSettlement.entryDirection)
        && (storedSettlement.entryDirection === 'SHORT' ? 'SHORT' : 'LONG') === identity.side,
        'CANONICAL_PAPER_SETTLEMENT_LINEAGE_MISMATCH');
    }
  }
  if (state.processedEventIds.includes(action.eventId)) return { lineage, sample };
  if (action.type === 'place_order') {
    requireEvidence(position.entryTimestampMs === nowMs, 'CANONICAL_PAPER_CURRENT_ENTRY_CYCLE_REQUIRED');
    assertManualPaperCanonicalIdentity(identity, action.request.canonicalIdentity);
    requireEvidence(action.request.symbol === identity.symbol && action.request.side.toUpperCase() === identity.side
      && action.request.leverage === identity.leverage && action.request.orderType === 'market'
      && (action.request.quantity == null || action.request.quantity === sample.fill.filledQuantity),
    'CANONICAL_PAPER_REQUEST_IDENTITY_MISMATCH');
    return { lineage, sample };
  }
  if (action.type !== 'close_position') {
    requireEvidence(action.type === 'mark_price' || action.type === 'cancel_order', 'CANONICAL_PAPER_TRIGGER_BOUND_SETTLEMENT_REQUIRED');
    return { lineage, sample };
  }
  const manualPosition = state.positions.find(item => item.id === action.positionId);
  requireEvidence(manualPosition?.canonicalPaper && manualPosition.remainingQuantity === sample.fill.filledQuantity
    && (action.quantity == null || action.quantity === manualPosition.remainingQuantity)
    && (action.percentage == null || action.percentage === 100), 'CANONICAL_PAPER_FULL_POSITION_SETTLEMENT_REQUIRED');
  assertManualPaperCanonicalIdentity(identity, manualPosition.canonicalPaper.identity);
  requireEvidence(action.at == null || Date.parse(action.at) === nowMs, 'CANONICAL_PAPER_SERVER_TIME_REQUIRED');
  const observation = row(evidence.settlement?.observation);
  const trigger = row(evidence.settlement?.trigger);
  requireEvidence(trigger.exitTriggerId === position.lifecycle?.pendingExit?.exitTriggerId
    && manualPaperEvidenceSha256(trigger) === manualPaperEvidenceSha256(position.lifecycle.pendingExit),
  'CANONICAL_PAPER_FROZEN_EXIT_TRIGGER_REQUIRED');
  const input = { position, observation, trigger, evaluatedAtMs: nowMs };
  const settlementBinding = validateNaturalPaperTriggerBoundSettlementEvidence(input);
  const fullCost = adaptNaturalPaperSettlementFullCost(input);
  requireEvidence(settlementBinding.status === 'PRESENT' && fullCost.status === 'PRESENT' && fullCost.fullCostReady === true,
    'CANONICAL_PAPER_TRIGGER_BOUND_FULL_COST_REQUIRED');
  const exit = advanceNaturalPaperPositionLifecycle(input);
  requireEvidence(exit.status === 'EXIT_ELIGIBLE', 'CANONICAL_PAPER_FROZEN_LIFECYCLE_EXIT_REQUIRED');
  const rawSettlement = settleFourMarketPaperSample({
    ...exit.settlementInput, sample, exitTriggerId: trigger.exitTriggerId,
    exitExecutionId: settlementBinding.exitExecutionId, evaluatedAtMs: exit.evidence.exitTriggerTimestampMs,
  });
  requireEvidence(rawSettlement.status === 'SETTLED' && Number.isFinite(rawSettlement.netPnl)
    && rawSettlement.quantity === manualPosition.remainingQuantity, 'CANONICAL_PAPER_SETTLEMENT_REQUIRED');
  const settlement = buildRecurringPaperSettlementRecord({
    settlement: rawSettlement, position, canonicalLifecycleEvidence: exit.evidence,
    exitReason: exit.exitReason, settlementRecordedAtMs: nowMs,
  });
  return { sample, settlement, lineage: { ...lineage, settlement: structuredClone(settlement),
    fullCost: structuredClone(fullCost), settlementBinding: structuredClone({ validation: settlementBinding,
      trigger, triggerBoundSettlementEvidence: observation.triggerBoundSettlementEvidence, costEvidence: observation.settlementCostEvidence }) } };
}

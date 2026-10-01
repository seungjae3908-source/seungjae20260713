import { createHash } from 'node:crypto';
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import {
  createNaturalPaperAuthoritativeSettlementCostCollector,
} from '../../../market-prediction-lab/src/natural-paper-authoritative-settlement-cost-collector-v1.js';
import {
  settleFourMarketPaperSample,
} from '../../../market-prediction-lab/src/four-market-paper-settlement-v1.js';
import {
  buildPaperSimulatedExecutionEvidence,
} from './paper-simulated-execution-evidence.service';
import {
  collectAuthoritativePaperLatencyCostEvidence,
  readBitgetPublicLatencyMidpointQuote,
} from './authoritative-paper-latency-cost-evidence.service';
import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_VERSION =
  'pump-reversal-prospective-full-cost-owner-v1' as const;

const MAXIMUM_AGE_MS = 30_000;
const REQUIRED_COMPONENTS = Object.freeze([
  'commission', 'tax', 'spread', 'slippage',
  'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
] as const);

type RecordLike = Readonly<Record<string, any>>;
type FullCostContext = Readonly<{
  record: RecordLike;
  state?: unknown;
  observedAtMs: number;
}>;

type SettlementCollectorResult = Readonly<Record<string, any>>;
type SettlementCollector = (input: Readonly<{
  position: Readonly<Record<string, any>>;
  observation: Readonly<Record<string, any>>;
  exitTrigger: Readonly<Record<string, any>>;
  evaluatedAtMs: number;
}>) => Promise<SettlementCollectorResult>;

type SettlePaperSample = (input: Readonly<Record<string, any>>) => Readonly<Record<string, any>>;

export type PumpProspectiveFullCostOwnerBlocked = Readonly<{
  status: 'BLOCKED';
  version: typeof PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_VERSION;
  blockers: readonly string[];
  sourceStage: 'RECORD' | 'FULL_COST_EVIDENCE' | 'SETTLEMENT';
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
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function blocked(
  sourceStage: PumpProspectiveFullCostOwnerBlocked['sourceStage'],
  blockers: readonly string[],
): PumpProspectiveFullCostOwnerBlocked {
  return Object.freeze({
    status: 'BLOCKED',
    version: PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_VERSION,
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
function validBar(value: unknown): value is Readonly<{
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}> {
  const bar = value as Record<string, unknown> | null;
  return Boolean(bar)
    && safeTime(bar?.timestampMs)
    && positive(bar?.open)
    && positive(bar?.high)
    && positive(bar?.low)
    && positive(bar?.close)
    && Number(bar?.high) >= Number(bar?.low)
    && Number(bar?.open) <= Number(bar?.high)
    && Number(bar?.open) >= Number(bar?.low)
    && Number(bar?.close) <= Number(bar?.high)
    && Number(bar?.close) >= Number(bar?.low);
}

function validateRecord(record: RecordLike): readonly string[] {
  const blockers: string[] = [];
  const sample = record?.prospectiveExecutionSample;
  const trigger = record?.exitTrigger;
  const sizing = record?.riskSizing;
  if (record?.status !== 'EXIT_TRIGGERED') blockers.push('PUMP_FULL_COST_EXIT_TRIGGER_REQUIRED');
  if (record?.riskSizingStatus !== 'READY' || sizing?.result?.status !== 'READY') {
    blockers.push('PUMP_FULL_COST_RISK_SIZING_REQUIRED');
  }
  if (record?.prospectiveExecutionSampleStatus !== 'READY'
    || sample?.status !== 'OPEN'
    || sample?.prospectiveExecutionSampleOnly !== true
    || sample?.canonicalProfitAdmissionEligible !== false
    || sample?.profitabilityClaimAllowed !== false
    || sample?.executionAuthority !== 'NONE') {
    blockers.push('PUMP_FULL_COST_ENTRY_SAMPLE_REQUIRED');
  }
  if (record?.fullCostSettlementStatus !== 'MISSING_CANONICAL_FULL_COST') {
    blockers.push('PUMP_FULL_COST_ALREADY_SETTLED_OR_INVALID');
  }
  if (!nonEmpty(trigger?.exitTriggerId)
    || !safeTime(trigger?.triggerTimestampMs)
    || !validBar(trigger?.bar)
    || trigger.bar.timestampMs !== trigger.triggerTimestampMs) {
    blockers.push('PUMP_FULL_COST_EXIT_BAR_REQUIRED');
  }
  if (!sample?.identity
    || sample.identity.market !== 'CRYPTO_FUTURES'
    || sample.identity.symbol !== record?.observation?.symbol
    || sample.identity.executionDirection !== 'SHORT'
    || sample.identity.signalId !== record?.signal?.signalId
    || sample.recordId !== record?.recordId
    || !positive(sample?.fill?.fillPrice)
    || !positive(sample?.fill?.filledQuantity)
    || !positive(sample?.fill?.notional)
    || sample.fill.orderSubmitted !== false
    || sample.fill.exchangeRequestSent !== false) {
    blockers.push('PUMP_FULL_COST_ENTRY_LINEAGE_INVALID');
  }
  if (!nonEmpty(sample?.profitEvidence?.costPolicyId)) {
    blockers.push('PUMP_FULL_COST_POLICY_ID_REQUIRED');
  }
  return Object.freeze([...new Set(blockers)]);
}

function positionFromRecord(record: RecordLike): Readonly<Record<string, any>> {
  const sample = record.prospectiveExecutionSample;
  const identity = sample.identity;
  const snapshot = record.riskSizing.result.prospectiveEntryExecution;
  return Object.freeze({
    positionId: record.position.positionId,
    paperSampleId: sample.paperSampleId,
    signalId: identity.signalId,
    market: identity.market,
    symbol: identity.symbol,
    direction: identity.executionDirection,
    candidateId: identity.candidateId,
    strategyFamily: identity.strategyFamily,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    parameterDigest: identity.parameterDigest,
    researchCodeSha: identity.researchCodeSha,
    costPolicyVersion: sample.profitEvidence.costPolicyId,
    accountMode: identity.accountMode,
    entryTimestampMs: identity.evaluatedAtMs,
    entryFillPrice: sample.fill.fillPrice,
    quantity: sample.fill.filledQuantity,
    sample,
    settlementExecutionPolicy: Object.freeze({
      marketAdapterIdentity: snapshot.marketAdapterIdentity,
      executionPolicy: snapshot.executionPolicy,
      entryDataEvidence: snapshot.dataEvidence,
    }),
  });
}

function exitTriggerFromRecord(record: RecordLike): Readonly<Record<string, any>> {
  return Object.freeze({
    exitTriggerId: record.exitTrigger.exitTriggerId,
    triggerObservationId: record.exitTrigger.exitTriggerId,
    triggeredAtMs: record.exitTrigger.triggerTimestampMs,
    bar: Object.freeze({ ...record.exitTrigger.bar }),
    reason: record.exitTrigger.reason,
    referenceExitPrice: record.exitTrigger.referenceExitPrice,
  });
}

function validateFullCostEvidence(value: SettlementCollectorResult, position: Readonly<Record<string, any>>): readonly string[] {
  const blockers: string[] = [];
  const evidence = value?.settlementCostEvidence;
  const components = evidence?.components;
  const policy = value?.settlementInput?.exitExecution?.costPolicy;
  if (value?.status !== 'PRESENT' || value?.fullCostReady !== true) {
    blockers.push(...(Array.isArray(value?.blockers) ? value.blockers.map(String) : ['PUMP_FULL_COST_EVIDENCE_NOT_PRESENT']));
  }
  if (!evidence
    || evidence.status !== 'PRESENT'
    || evidence.fullCostReady !== true
    || evidence.unknownIsZero !== false
    || evidence.unavailableCostConvertedToZero !== false
    || evidence.costPolicyIdentity?.version !== position.costPolicyVersion
    || policy?.version !== position.costPolicyVersion) {
    blockers.push('PUMP_FULL_COST_EIGHT_COMPONENT_CONTRACT_INVALID');
  }
  const qualities = new Set(['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE']);
  for (const name of REQUIRED_COMPONENTS) {
    const component = components?.[name];
    if (!component
      || component.status !== 'PRESENT'
      || !finite(component.valuePercent)
      || component.valuePercent < 0
      || !qualities.has(component.quality)
      || !nonEmpty(component.source)
      || !nonEmpty(component.provenance)
      || component.countsAsExecutionCost !== true
      || component.unavailableIsZero !== false) {
      blockers.push(`PUMP_FULL_COST_COMPONENT_INVALID:${name}`);
    }
  }
  if (!value?.settlementInput?.exitExecution
    || !value?.settlementInput?.fundingEvidence
    || value.settlementInput.fundingEvidence.complete !== true
    || !Array.isArray(value.settlementInput.fundingEvidence.payments)) {
    blockers.push('PUMP_FULL_COST_SETTLEMENT_INPUT_INCOMPLETE');
  }
  return Object.freeze([...new Set(blockers)]);
}

export function createPumpReversalProspectiveFullCostOwner(input: Readonly<{
  supplementalCostEvidenceForRecord: (context: FullCostContext) =>
    SupplementalExecutionCostEvidence | Promise<SupplementalExecutionCostEvidence>;
  bitgetClient?: InstanceType<typeof BitgetPublicClient>;
  collectSettlementEvidence?: SettlementCollector;
  settlePaperSample?: SettlePaperSample;
  now?: () => number;
}>): (context: FullCostContext) => Promise<Readonly<Record<string, any>> | PumpProspectiveFullCostOwnerBlocked> {
  if (typeof input?.supplementalCostEvidenceForRecord !== 'function') {
    throw new TypeError('Pump Full Cost supplemental-cost owner is required');
  }
  const bitgetClient = input.bitgetClient ?? new BitgetPublicClient();
  const settlePaperSample = input.settlePaperSample ?? ((args) => settleFourMarketPaperSample(args));
  const now = input.now ?? Date.now;
  if (!bitgetClient || typeof (bitgetClient as any).get !== 'function'
    || typeof settlePaperSample !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Pump Full Cost owner dependencies are required');
  }

  return async (context) => {
    const record = context?.record;
    if (!record || !safeTime(context?.observedAtMs)) {
      return blocked('RECORD', ['PUMP_FULL_COST_RECORD_AND_TIME_REQUIRED']);
    }
    const recordBlockers = validateRecord(record);
    if (recordBlockers.length > 0) return blocked('RECORD', recordBlockers);

    const position = positionFromRecord(record);
    const exitTrigger = exitTriggerFromRecord(record);
    let evidence: SettlementCollectorResult;
    try {
      if (input.collectSettlementEvidence) {
        evidence = await input.collectSettlementEvidence({
          position,
          observation: Object.freeze({ maxAgeMs: MAXIMUM_AGE_MS }),
          exitTrigger,
          evaluatedAtMs: context.observedAtMs,
        });
      } else {
        const collector = createNaturalPaperAuthoritativeSettlementCostCollector({
          runtimePackage: {
            buildPaperSimulatedExecutionEvidence,
            collectAuthoritativePaperLatencyCostEvidence,
            readBitgetPublicLatencyMidpointQuote,
          },
          readSupplementalCostInput: async () => input.supplementalCostEvidenceForRecord(context),
          bitgetClient,
          now,
        });
        evidence = await collector({
          position,
          observation: Object.freeze({ maxAgeMs: MAXIMUM_AGE_MS }),
          exitTrigger,
          evaluatedAtMs: context.observedAtMs,
        });
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:.-]+$/u.test(error.message)
        ? error.message
        : 'PUMP_FULL_COST_EVIDENCE_COLLECTION_FAILED';
      return blocked('FULL_COST_EVIDENCE', [code]);
    }

    const evidenceBlockers = validateFullCostEvidence(evidence, position);
    if (evidenceBlockers.length > 0) return blocked('FULL_COST_EVIDENCE', evidenceBlockers);

    const settledAtMs = now();
    if (!safeTime(settledAtMs)
      || settledAtMs <= position.entryTimestampMs
      || settledAtMs < exitTrigger.triggeredAtMs) {
      return blocked('SETTLEMENT', ['PUMP_FULL_COST_SETTLEMENT_TIME_INVALID']);
    }

    let settled: Readonly<Record<string, any>>;
    try {
      settled = settlePaperSample({
        sample: position.sample,
        ...structuredClone(evidence.settlementInput),
        exitOrderType: 'MARKET',
        pathBars: [],
        evaluatedAtMs: settledAtMs,
      });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:.-]+$/u.test(error.message)
        ? error.message
        : 'PUMP_FULL_COST_SETTLEMENT_FAILED';
      return blocked('SETTLEMENT', [code]);
    }
    if (settled?.status !== 'SETTLED'
      || !finite(settled?.grossPnl)
      || !finite(settled?.grossReturnPercent)
      || !finite(settled?.netPnl)
      || !finite(settled?.netReturnPercent)
      || settled?.paperSampleId !== position.paperSampleId
      || settled?.costPolicyVersion !== position.costPolicyVersion
      || settled?.orderSubmitted !== false
      || settled?.exchangeRequestSent !== false
      || settled?.privateTradingApiAllowed !== false
      || settled?.profitabilityClaimAllowed !== false) {
      return blocked('SETTLEMENT', [
        ...(Array.isArray(settled?.blockers) ? settled.blockers.map(String) : []),
        'PUMP_FULL_COST_SETTLEMENT_RESULT_INVALID',
      ]);
    }

    const settlementId = hash({
      schemaVersion: PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_VERSION,
      recordId: record.recordId,
      paperSampleId: position.paperSampleId,
      exitTriggerId: exitTrigger.exitTriggerId,
      riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
      settledAtMs: settled.settledAtMs,
      netPnl: settled.netPnl,
      netReturnPercent: settled.netReturnPercent,
      costPolicyVersion: settled.costPolicyVersion,
    });
    return Object.freeze({
      schemaVersion: 'crypto-pump-reversal-full-cost-settlement-v1',
      status: 'SETTLED',
      settlementId,
      recordId: record.recordId,
      paperSampleId: position.paperSampleId,
      signalId: record.signal.signalId,
      candidateId: record.observation.candidateId,
      symbol: record.observation.symbol,
      direction: 'SHORT',
      exitTriggerId: exitTrigger.exitTriggerId,
      riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
      settledAtMs: settled.settledAtMs,
      grossPnl: settled.grossPnl,
      grossReturnPercent: settled.grossReturnPercent,
      netPnl: settled.netPnl,
      netReturnPercent: settled.netReturnPercent,
      entryFillPrice: settled.entryFillPrice,
      exitFillPrice: settled.exitFillPrice,
      quantity: settled.quantity,
      costPolicyVersion: settled.costPolicyVersion,
      fullCostEvidence: structuredClone(evidence.settlementCostEvidence),
      fundingEvidence: structuredClone(settled.fundingEvidence),
      economicSampleCredit: 1,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  };
}

export const PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_VERSION,
  canonicalProspectiveEntrySampleRequired: true,
  exactExitTriggerBarRequired: true,
  allEightCostComponentsRequired: true,
  canonicalSettlementEngineRequired: true,
  publicMarketDataOnly: true,
  unknownCostIsZero: false,
  fundingReceiptProfitCreditAllowed: false,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
  financialMutationAllowed: false,
});

import {
  classifyCounterfactualObservation,
  type ClassifiedCounterfactualObservation,
  type CounterfactualObservation,
} from './strategy-health-observatory.service';

export type DecisionGateState =
  | 'PASS'
  | 'VETO'
  | 'BLOCKED'
  | 'NOT_AVAILABLE'
  | 'INSUFFICIENT_EVIDENCE';

export interface DecisionGateEvidence {
  gateId: string;
  state: DecisionGateState;
  reasonCodes: readonly string[];
  evaluatedAt: string;
  order?: number;
}

export type DecisionGateAttributionStatus =
  | 'NOT_BLOCKED'
  | 'ATTRIBUTED_UNRESOLVED'
  | 'ATTRIBUTED_RESOLVED';

export interface DecisionGateAttributionShare {
  gateId: string;
  state: 'VETO' | 'BLOCKED';
  reasonCodes: readonly string[];
  attributionWeight: number;
  primary: boolean;
  avoidedLossPercent: number | null;
  missedUpsidePercent: number | null;
  netDecisionValuePercent: number | null;
}

export interface DecisionGateAttributionResult {
  contract: 'decision-gate-attribution/v1';
  signalId: string;
  decision: CounterfactualObservation['decision'];
  classification: ClassifiedCounterfactualObservation['classification'];
  reasonType: ClassifiedCounterfactualObservation['reasonType'];
  attributionStatus: DecisionGateAttributionStatus;
  blockingGateIds: readonly string[];
  primaryGateId: string | null;
  observedNetReturnPercent: number | null;
  totalAvoidedLossPercent: number | null;
  totalMissedUpsidePercent: number | null;
  totalNetDecisionValuePercent: number | null;
  shares: readonly DecisionGateAttributionShare[];
  safety: {
    executionAuthority: 'NONE';
    promotionAuthority: false;
    liveTradingAuthority: false;
    orderAllowed: false;
  };
}

export interface DecisionGateAttributionSummaryRow {
  gateId: string;
  blockedMembershipCount: number;
  unresolvedMembershipCount: number;
  primaryCount: number;
  primaryBadTradeAvoidedCount: number;
  primaryGoodTradeMissedCount: number;
  attributedResolvedSampleWeight: number;
  attributedBadTradeAvoidedWeight: number;
  attributedGoodTradeMissedWeight: number;
  decisionQualityRatePercent: number | null;
  avoidedLossPercent: number | null;
  missedUpsidePercent: number | null;
  netDecisionValuePercent: number | null;
}

export interface DecisionGateAttributionSummary {
  contract: 'decision-gate-attribution-summary/v1';
  sampleSize: number;
  blockedSampleSize: number;
  resolvedBlockedSampleSize: number;
  unresolvedBlockedSampleSize: number;
  attributedBadTradeAvoidedWeight: number;
  attributedGoodTradeMissedWeight: number;
  decisionQualityRatePercent: number | null;
  avoidedLossPercent: number | null;
  missedUpsidePercent: number | null;
  netDecisionValuePercent: number | null;
  gates: readonly DecisionGateAttributionSummaryRow[];
  safety: {
    executionAuthority: 'NONE';
    promotionAuthority: false;
    liveTradingAuthority: false;
    orderAllowed: false;
  };
}

const GATE_STATES = new Set<DecisionGateState>([
  'PASS',
  'VETO',
  'BLOCKED',
  'NOT_AVAILABLE',
  'INSUFFICIENT_EVIDENCE',
]);

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function blocking(state: DecisionGateState): state is 'VETO' | 'BLOCKED' {
  return state === 'VETO' || state === 'BLOCKED';
}

function normalizeGate(gate: DecisionGateEvidence): DecisionGateEvidence {
  const gateId = String(gate.gateId ?? '').trim();
  if (!gateId) throw new Error('gateId is required');
  if (!GATE_STATES.has(gate.state)) throw new Error(`Unsupported gate state: ${String(gate.state)}`);
  if (!Array.isArray(gate.reasonCodes) || gate.reasonCodes.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`Invalid reasonCodes for gate ${gateId}`);
  }
  const evaluatedAt = String(gate.evaluatedAt ?? '').trim();
  if (!evaluatedAt || !Number.isFinite(Date.parse(evaluatedAt))) throw new Error(`Invalid evaluatedAt for gate ${gateId}`);
  if (gate.order != null && (!Number.isInteger(gate.order) || gate.order < 0)) {
    throw new Error(`Invalid order for gate ${gateId}`);
  }
  return Object.freeze({
    gateId,
    state: gate.state,
    reasonCodes: Object.freeze(gate.reasonCodes.map((value) => value.trim())),
    evaluatedAt,
    ...(gate.order == null ? {} : { order: gate.order }),
  });
}

function orderedBlockingGates(gates: readonly DecisionGateEvidence[]): DecisionGateEvidence[] {
  const normalized = gates.map(normalizeGate);
  const seen = new Set<string>();
  for (const gate of normalized) {
    if (seen.has(gate.gateId)) throw new Error(`Duplicate gateId: ${gate.gateId}`);
    seen.add(gate.gateId);
  }
  return normalized
    .filter((gate) => blocking(gate.state))
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      || left.gateId.localeCompare(right.gateId));
}

function resolvedEconomicImpact(
  classified: ClassifiedCounterfactualObservation,
): { avoidedLossPercent: number; missedUpsidePercent: number; netDecisionValuePercent: number } | null {
  if (classified.netReturnPercent == null || !Number.isFinite(classified.netReturnPercent)) return null;
  if (classified.classification === 'BAD_TRADE_AVOIDED') {
    const avoidedLossPercent = Math.abs(classified.netReturnPercent);
    return { avoidedLossPercent, missedUpsidePercent: 0, netDecisionValuePercent: avoidedLossPercent };
  }
  if (classified.classification === 'GOOD_TRADE_MISSED') {
    const missedUpsidePercent = Math.max(0, classified.netReturnPercent);
    return { avoidedLossPercent: 0, missedUpsidePercent, netDecisionValuePercent: -missedUpsidePercent };
  }
  return null;
}

export function attributeDecisionGates(input: {
  observation: CounterfactualObservation;
  gateDecisions: readonly DecisionGateEvidence[];
  minimumMeaningfulReturnPercent: number;
}): DecisionGateAttributionResult {
  const classified = classifyCounterfactualObservation(
    input.observation,
    input.minimumMeaningfulReturnPercent,
  );
  const blockers = orderedBlockingGates(input.gateDecisions);

  if (classified.decision === 'TAKE' && blockers.length) {
    throw new Error('TAKE decision cannot contain a blocking gate');
  }

  const economic = resolvedEconomicImpact(classified);
  const primaryGateId = blockers[0]?.gateId ?? null;
  const weight = blockers.length ? 1 / blockers.length : null;
  const shares = blockers.map((gate): DecisionGateAttributionShare => Object.freeze({
    gateId: gate.gateId,
    state: gate.state as 'VETO' | 'BLOCKED',
    reasonCodes: Object.freeze([...gate.reasonCodes]),
    attributionWeight: round(weight as number, 12),
    primary: gate.gateId === primaryGateId,
    avoidedLossPercent: economic == null ? null : round(economic.avoidedLossPercent * (weight as number)),
    missedUpsidePercent: economic == null ? null : round(economic.missedUpsidePercent * (weight as number)),
    netDecisionValuePercent: economic == null ? null : round(economic.netDecisionValuePercent * (weight as number)),
  }));

  const attributionStatus: DecisionGateAttributionStatus = blockers.length === 0
    ? 'NOT_BLOCKED'
    : economic == null
      ? 'ATTRIBUTED_UNRESOLVED'
      : 'ATTRIBUTED_RESOLVED';

  return Object.freeze({
    contract: 'decision-gate-attribution/v1' as const,
    signalId: classified.signalId,
    decision: classified.decision,
    classification: classified.classification,
    reasonType: classified.reasonType,
    attributionStatus,
    blockingGateIds: Object.freeze(blockers.map((gate) => gate.gateId)),
    primaryGateId,
    observedNetReturnPercent: classified.resolved && classified.netReturnPercent != null && Number.isFinite(classified.netReturnPercent)
      ? classified.netReturnPercent
      : null,
    totalAvoidedLossPercent: economic == null ? null : round(economic.avoidedLossPercent),
    totalMissedUpsidePercent: economic == null ? null : round(economic.missedUpsidePercent),
    totalNetDecisionValuePercent: economic == null ? null : round(economic.netDecisionValuePercent),
    shares: Object.freeze(shares),
    safety: Object.freeze({
      executionAuthority: 'NONE' as const,
      promotionAuthority: false as const,
      liveTradingAuthority: false as const,
      orderAllowed: false as const,
    }),
  });
}

interface MutableSummaryRow {
  gateId: string;
  blockedMembershipCount: number;
  unresolvedMembershipCount: number;
  primaryCount: number;
  primaryBadTradeAvoidedCount: number;
  primaryGoodTradeMissedCount: number;
  attributedResolvedSampleWeight: number;
  attributedBadTradeAvoidedWeight: number;
  attributedGoodTradeMissedWeight: number;
  avoidedLossPercent: number;
  missedUpsidePercent: number;
}

function rowFor(rows: Map<string, MutableSummaryRow>, gateId: string): MutableSummaryRow {
  let row = rows.get(gateId);
  if (!row) {
    row = {
      gateId,
      blockedMembershipCount: 0,
      unresolvedMembershipCount: 0,
      primaryCount: 0,
      primaryBadTradeAvoidedCount: 0,
      primaryGoodTradeMissedCount: 0,
      attributedResolvedSampleWeight: 0,
      attributedBadTradeAvoidedWeight: 0,
      attributedGoodTradeMissedWeight: 0,
      avoidedLossPercent: 0,
      missedUpsidePercent: 0,
    };
    rows.set(gateId, row);
  }
  return row;
}

export function summarizeDecisionGateAttribution(
  results: readonly DecisionGateAttributionResult[],
): DecisionGateAttributionSummary {
  const rows = new Map<string, MutableSummaryRow>();
  let blockedSampleSize = 0;
  let resolvedBlockedSampleSize = 0;
  let unresolvedBlockedSampleSize = 0;
  let attributedBadTradeAvoidedWeight = 0;
  let attributedGoodTradeMissedWeight = 0;
  let avoidedLossPercent = 0;
  let missedUpsidePercent = 0;

  for (const result of results) {
    if (result.contract !== 'decision-gate-attribution/v1') throw new Error('Unsupported decision gate attribution contract');
    if (!result.shares.length) continue;
    blockedSampleSize += 1;
    const resolved = result.attributionStatus === 'ATTRIBUTED_RESOLVED';
    if (resolved) resolvedBlockedSampleSize += 1;
    else unresolvedBlockedSampleSize += 1;

    for (const share of result.shares) {
      const row = rowFor(rows, share.gateId);
      row.blockedMembershipCount += 1;
      if (!resolved) row.unresolvedMembershipCount += 1;
      if (share.primary) {
        row.primaryCount += 1;
        if (result.classification === 'BAD_TRADE_AVOIDED') row.primaryBadTradeAvoidedCount += 1;
        if (result.classification === 'GOOD_TRADE_MISSED') row.primaryGoodTradeMissedCount += 1;
      }
      if (!resolved) continue;
      row.attributedResolvedSampleWeight += share.attributionWeight;
      if (result.classification === 'BAD_TRADE_AVOIDED') {
        row.attributedBadTradeAvoidedWeight += share.attributionWeight;
        attributedBadTradeAvoidedWeight += share.attributionWeight;
      }
      if (result.classification === 'GOOD_TRADE_MISSED') {
        row.attributedGoodTradeMissedWeight += share.attributionWeight;
        attributedGoodTradeMissedWeight += share.attributionWeight;
      }
      row.avoidedLossPercent += share.avoidedLossPercent ?? 0;
      row.missedUpsidePercent += share.missedUpsidePercent ?? 0;
      avoidedLossPercent += share.avoidedLossPercent ?? 0;
      missedUpsidePercent += share.missedUpsidePercent ?? 0;
    }
  }

  const gateRows = [...rows.values()]
    .sort((left, right) => left.gateId.localeCompare(right.gateId))
    .map((row): DecisionGateAttributionSummaryRow => {
      const decisiveWeight = row.attributedBadTradeAvoidedWeight + row.attributedGoodTradeMissedWeight;
      return Object.freeze({
        gateId: row.gateId,
        blockedMembershipCount: row.blockedMembershipCount,
        unresolvedMembershipCount: row.unresolvedMembershipCount,
        primaryCount: row.primaryCount,
        primaryBadTradeAvoidedCount: row.primaryBadTradeAvoidedCount,
        primaryGoodTradeMissedCount: row.primaryGoodTradeMissedCount,
        attributedResolvedSampleWeight: round(row.attributedResolvedSampleWeight),
        attributedBadTradeAvoidedWeight: round(row.attributedBadTradeAvoidedWeight),
        attributedGoodTradeMissedWeight: round(row.attributedGoodTradeMissedWeight),
        decisionQualityRatePercent: decisiveWeight > 0
          ? round(row.attributedBadTradeAvoidedWeight / decisiveWeight * 100)
          : null,
        avoidedLossPercent: row.attributedResolvedSampleWeight > 0 ? round(row.avoidedLossPercent) : null,
        missedUpsidePercent: row.attributedResolvedSampleWeight > 0 ? round(row.missedUpsidePercent) : null,
        netDecisionValuePercent: row.attributedResolvedSampleWeight > 0
          ? round(row.avoidedLossPercent - row.missedUpsidePercent)
          : null,
      });
    });

  const decisiveWeight = attributedBadTradeAvoidedWeight + attributedGoodTradeMissedWeight;
  return Object.freeze({
    contract: 'decision-gate-attribution-summary/v1' as const,
    sampleSize: results.length,
    blockedSampleSize,
    resolvedBlockedSampleSize,
    unresolvedBlockedSampleSize,
    attributedBadTradeAvoidedWeight: round(attributedBadTradeAvoidedWeight),
    attributedGoodTradeMissedWeight: round(attributedGoodTradeMissedWeight),
    decisionQualityRatePercent: decisiveWeight > 0
      ? round(attributedBadTradeAvoidedWeight / decisiveWeight * 100)
      : null,
    avoidedLossPercent: resolvedBlockedSampleSize > 0 ? round(avoidedLossPercent) : null,
    missedUpsidePercent: resolvedBlockedSampleSize > 0 ? round(missedUpsidePercent) : null,
    netDecisionValuePercent: resolvedBlockedSampleSize > 0
      ? round(avoidedLossPercent - missedUpsidePercent)
      : null,
    gates: Object.freeze(gateRows),
    safety: Object.freeze({
      executionAuthority: 'NONE' as const,
      promotionAuthority: false as const,
      liveTradingAuthority: false as const,
      orderAllowed: false as const,
    }),
  });
}

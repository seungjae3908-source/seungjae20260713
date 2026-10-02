import { createHash } from 'node:crypto';
import type { MemberAutoTradingPaperHandoffEntry } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import * as naturalPaperLifecycleModule from '../../../market-prediction-lab/src/natural-paper-position-settlement-lifecycle-v1.js';

const createNaturalPaperPositionLifecycle = (
  naturalPaperLifecycleModule as unknown as {
    createNaturalPaperPositionLifecycle(input: {
      position: Record<string, unknown>;
      sample: Record<string, unknown>;
      candidate: Record<string, unknown>;
    }): Record<string, unknown>;
  }
).createNaturalPaperPositionLifecycle;
import type { TradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from './trade-automation.types';

export const MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION =
  'member-auto-trading-paper-position-bridge-v1';

type BridgeSafety = Readonly<{
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveTrading: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  economicSampleCredit: 0;
}>;

export type MemberAutoTradingPaperPositionBridge = Readonly<{
  schemaVersion: typeof MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION;
  status: 'READY' | 'BLOCKED_DATA';
  bridgeId: string | null;
  sourceTradePlanId: string;
  sourceTradeOrderId: string;
  sourceHandoffId: string;
  position: Record<string, unknown> | null;
  blockers: readonly string[];
  safety: BridgeSafety;
}>;

export type MemberAutoTradingPaperPositionPersistenceResult = Readonly<{
  status: 'PERSISTED' | 'IDEMPOTENT' | 'BLOCKED_DATA';
  bridge: MemberAutoTradingPaperPositionBridge;
  event: TradingOrderEvent | null;
  blockers: readonly string[];
}>;

const POSITION_OPEN_EVENT_REASON = 'PAPER_POSITION_LIFECYCLE_OPENED';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function deterministicUuid(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  const variant = Number.parseInt(hex[16]!, 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = hex.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
function safety(): BridgeSafety {
  return Object.freeze({
    executionAuthority: 'NONE',
    simulatedOnly: true,
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    economicSampleCredit: 0,
  });
}
function directionForPlan(plan: TradingPlan): 'BUY' | 'LONG' | 'SHORT' {
  if (plan.side === 'buy') return 'BUY';
  if (plan.side === 'long') return 'LONG';
  if (plan.side === 'short') return 'SHORT';
  throw new Error('PAPER_POSITION_BRIDGE_EXIT_SIDE_NOT_SUPPORTED');
}
function blocked(
  plan: TradingPlan,
  order: TradingOrder,
  entry: MemberAutoTradingPaperHandoffEntry,
  blockers: string[],
): MemberAutoTradingPaperPositionBridge {
  return deepFreeze({
    schemaVersion: MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
    status: 'BLOCKED_DATA' as const,
    bridgeId: null,
    sourceTradePlanId: plan.id,
    sourceTradeOrderId: order.id,
    sourceHandoffId: entry.handoffId,
    position: null,
    blockers: [...new Set(blockers)],
    safety: safety(),
  });
}

export function buildMemberAutoTradingPaperPositionBridge(input: {
  userId: string;
  plan: TradingPlan;
  order: TradingOrder;
  entry: MemberAutoTradingPaperHandoffEntry;
}): MemberAutoTradingPaperPositionBridge {
  const { userId, plan, order, entry } = input;
  const blockers: string[] = [];
  if (!nonEmpty(userId) || plan.userId !== userId || order.userId !== userId) {
    blockers.push('PAPER_POSITION_BRIDGE_USER_IDENTITY_MISMATCH');
  }
  if (order.planId !== plan.id) blockers.push('PAPER_POSITION_BRIDGE_PLAN_ORDER_MISMATCH');
  if (plan.accountMode !== 'paper') blockers.push('PAPER_POSITION_BRIDGE_PAPER_ONLY_REQUIRED');
  if (order.state !== 'FILLED') blockers.push('PAPER_POSITION_BRIDGE_FILLED_ORDER_REQUIRED');
  if (!positive(order.filledQuantity) || !positive(order.averageFillPrice)) {
    blockers.push('PAPER_POSITION_BRIDGE_FILL_EVIDENCE_REQUIRED');
  }
  if (plan.signalId !== entry.identity.signalId || plan.strategyId !== entry.identity.strategyId
    || plan.symbol.toUpperCase() !== entry.identity.symbol.toUpperCase()) {
    blockers.push('PAPER_POSITION_BRIDGE_SIGNAL_IDENTITY_MISMATCH');
  }
  if (entry.safety.executionAuthority !== 'NONE'
    || entry.safety.liveOrderAllowed !== false
    || entry.safety.privateTradingApiAllowed !== false
    || entry.safety.orderSubmitted !== false
    || entry.safety.exchangeRequestSent !== false) {
    blockers.push('PAPER_POSITION_BRIDGE_UNSAFE_HANDOFF');
  }
  if (entry.identity.executionAuthority !== 'NONE'
    || !nonEmpty(entry.identity.researchCodeSha)
    || !/^[0-9a-f]{40}$/u.test(entry.identity.researchCodeSha)) {
    blockers.push('PAPER_POSITION_BRIDGE_RESEARCH_IDENTITY_INVALID');
  }
  if (!Number.isSafeInteger(entry.identity.horizon) || entry.identity.horizon <= 0
    || !nonEmpty(entry.identity.timeframe)) {
    blockers.push('PAPER_POSITION_BRIDGE_HORIZON_INVALID');
  }
  const executionPolicy = entry.execution.executionPolicy as Record<string, unknown> | null;
  if (executionPolicy?.sameBarPolicy !== 'STOP_FIRST') {
    blockers.push('PAPER_POSITION_BRIDGE_SAME_BAR_POLICY_REQUIRED');
  }
  const snapshot = entry.signal.learningSnapshot as Record<string, unknown> | null;
  const stopLoss = Number(snapshot?.stopLoss);
  const target1 = Number(snapshot?.target1);
  if (!positive(stopLoss) || !positive(target1)) {
    blockers.push('PAPER_POSITION_BRIDGE_EXIT_PLAN_REQUIRED');
  }
  if (blockers.length > 0) return blocked(plan, order, entry, blockers);

  const direction = directionForPlan(plan);
  if (direction !== entry.identity.direction) {
    return blocked(plan, order, entry, ['PAPER_POSITION_BRIDGE_DIRECTION_MISMATCH']);
  }

  const evaluatedAtMs = Date.parse(order.updatedAt);
  if (!Number.isSafeInteger(evaluatedAtMs) || evaluatedAtMs <= 0) {
    return blocked(plan, order, entry, ['PAPER_POSITION_BRIDGE_FILL_TIME_INVALID']);
  }

  const sampleIdentity = {
    signalId: entry.identity.signalId,
    market: entry.identity.market,
    symbol: entry.identity.symbol,
    timeframe: entry.identity.timeframe,
    horizon: entry.identity.horizon,
    executionDirection: direction,
    candidateId: entry.identity.candidateId ?? null,
    strategyFamily: null,
    strategyId: entry.identity.strategyId,
    strategyVersion: entry.identity.strategyVersion,
    parameterHash: entry.identity.parameterHash,
    parameterDigest: null,
    researchCodeSha: entry.identity.researchCodeSha,
    accountMode: 'paper',
    evaluatedAtMs,
  };
  const entryEvidenceProvenance = {
    schemaVersion: 'member-auto-trading-paper-entry-provenance-v1',
    sourceHandoffId: entry.handoffId,
    sourceTradePlanId: plan.id,
    sourceTradeOrderId: order.id,
    publicDataOnly: true,
    evidenceSnapshotDigest: sha256({
      handoffId: entry.handoffId,
      riskEvidence: entry.riskEvidence,
      dataEvidence: entry.execution.dataEvidence,
      publicQuote: entry.publicQuote,
    }),
    executionAuthority: 'NONE',
  };
  const paperSampleId = sha256({
    version: MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
    signalId: entry.identity.signalId,
    tradePlanId: plan.id,
    tradeOrderId: order.id,
    fillPrice: order.averageFillPrice,
    filledQuantity: order.filledQuantity,
  });
  const sample = deepFreeze({
    paperSampleId,
    status: 'OPEN',
    identity: sampleIdentity,
    fill: {
      status: 'FILLED',
      fillPrice: order.averageFillPrice!,
      filledQuantity: order.filledQuantity,
      notional: order.averageFillPrice! * order.filledQuantity,
    },
    entryEvidenceProvenance,
  });
  const positionId = `member-auto-position:sha256:${sha256({ paperSampleId, userId })}`;
  const rawPosition = {
    positionId,
    paperSampleId,
    signalId: entry.identity.signalId,
    market: entry.identity.market,
    symbol: entry.identity.symbol,
    direction,
    candidateId: entry.identity.candidateId ?? null,
    strategyFamily: null,
    strategyId: entry.identity.strategyId,
    strategyVersion: entry.identity.strategyVersion,
    parameterHash: entry.identity.parameterHash,
    parameterDigest: null,
    researchCodeSha: entry.identity.researchCodeSha,
    costPolicyVersion: entry.identity.costPolicyVersion,
    accountMode: 'paper',
    entryFillPrice: order.averageFillPrice,
    entryTimestampMs: evaluatedAtMs,
    sample,
  };
  const candidate = {
    signal: {
      ...structuredClone(entry.signal),
      direction,
      learningSnapshot: structuredClone(entry.signal.learningSnapshot),
    },
    riskEvidence: structuredClone(entry.riskEvidence),
    execution: structuredClone(entry.execution),
    naturalEvidence: null,
    testOnly: false,
  };
  const lifecycle = createNaturalPaperPositionLifecycle({
    position: rawPosition,
    sample,
    candidate,
  });
  const position = deepFreeze({
    ...rawPosition,
    lifecycle,
    bridgeIdentity: {
      schemaVersion: MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
      bridgeId: `member-auto-position-bridge:sha256:${sha256({
        positionId,
        sourceHandoffId: entry.handoffId,
        sourceTradePlanId: plan.id,
        sourceTradeOrderId: order.id,
      })}`,
      sourceHandoffId: entry.handoffId,
      sourceTradePlanId: plan.id,
      sourceTradeOrderId: order.id,
    },
    executionAuthority: 'NONE',
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  return deepFreeze({
    schemaVersion: MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
    status: 'READY' as const,
    bridgeId: position.bridgeIdentity.bridgeId,
    sourceTradePlanId: plan.id,
    sourceTradeOrderId: order.id,
    sourceHandoffId: entry.handoffId,
    position,
    blockers: [],
    safety: safety(),
  });
}


function bridgeIdFromEvent(event: TradingOrderEvent) {
  if (event.reason !== POSITION_OPEN_EVENT_REASON || event.toState !== 'FILLED') return null;
  const value = event.metadata?.bridgeId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function persistMemberAutoTradingPaperPositionBridge(input: {
  repository: TradingRepository;
  userId: string;
  plan: TradingPlan;
  order: TradingOrder;
  entry: MemberAutoTradingPaperHandoffEntry;
  now?: Date;
}): Promise<MemberAutoTradingPaperPositionPersistenceResult> {
  const { repository, userId, plan, order, entry } = input;
  const bridge = buildMemberAutoTradingPaperPositionBridge({ userId, plan, order, entry });
  if (bridge.status !== 'READY' || !bridge.bridgeId || !bridge.position) {
    return deepFreeze({
      status: 'BLOCKED_DATA' as const,
      bridge,
      event: null,
      blockers: bridge.blockers,
    });
  }

  const current = (await repository.listEvents(userId))
    .filter((event) => event.orderId === order.id && event.reason === POSITION_OPEN_EVENT_REASON);
  const exact = current.find((event) => bridgeIdFromEvent(event) === bridge.bridgeId);
  if (exact) {
    return deepFreeze({
      status: 'IDEMPOTENT' as const,
      bridge,
      event: exact,
      blockers: [],
    });
  }
  if (current.length > 0) {
    return deepFreeze({
      status: 'BLOCKED_DATA' as const,
      bridge,
      event: null,
      blockers: ['PAPER_POSITION_BRIDGE_EVENT_CONFLICT'],
    });
  }

  const at = (input.now ?? new Date(order.updatedAt)).toISOString();
  const event: TradingOrderEvent = {
    id: deterministicUuid(`${POSITION_OPEN_EVENT_REASON}:${order.id}:${bridge.bridgeId}`),
    userId,
    orderId: order.id,
    fromState: 'FILLED',
    toState: 'FILLED',
    reason: POSITION_OPEN_EVENT_REASON,
    metadata: {
      schemaVersion: MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
      bridgeId: bridge.bridgeId,
      sourceTradePlanId: bridge.sourceTradePlanId,
      sourceTradeOrderId: bridge.sourceTradeOrderId,
      sourceHandoffId: bridge.sourceHandoffId,
      position: structuredClone(bridge.position),
      safety: structuredClone(bridge.safety),
    },
    createdAt: at,
  };

  try {
    await repository.appendEvent(event);
  } catch (error) {
    const after = (await repository.listEvents(userId))
      .find((candidate) => candidate.orderId === order.id
        && candidate.reason === POSITION_OPEN_EVENT_REASON
        && bridgeIdFromEvent(candidate) === bridge.bridgeId);
    if (!after) throw error;
    return deepFreeze({
      status: 'IDEMPOTENT' as const,
      bridge,
      event: after,
      blockers: [],
    });
  }
  return deepFreeze({
    status: 'PERSISTED' as const,
    bridge,
    event,
    blockers: [],
  });
}

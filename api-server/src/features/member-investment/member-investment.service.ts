import { createHash, randomUUID } from 'node:crypto';

import {
  MEMBER_INVESTMENT_SAFETY,
  type AutomationPolicy,
  type ExecutionMode,
  type InvestmentMarket,
  type IntentSide,
  type OrderIntent,
  type PositionSide,
} from './member-investment.contract';
import { evaluateMemberInvestmentRisk } from './member-investment-risk-gate.service';
import type { ExecutionProviderAdapter } from './member-investment.provider';
import type { MemberInvestmentRepository } from './member-investment.repository';
import type { MemberInvestmentTelegramService } from './member-investment-telegram.service';

export type AutomationPolicyInput = Omit<AutomationPolicy, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string };
export type OrderIntentInput = {
  connectionId: string;
  policyId: string;
  sourceSignalId: string;
  sourceSignalGeneratedAt: string;
  strategyId: string;
  market: InvestmentMarket;
  symbol: string;
  side: IntentSide;
  positionSide: PositionSide;
  orderType: 'MARKET' | 'LIMIT';
  requestedQuantity: number;
  requestedPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  leverage: number | null;
  expiresAt: string;
  idempotencyKey?: string;
};

function cleanText(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error(code);
  return normalized;
}

function finiteNonNegative(value: number, code: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function integerNonNegative(value: number, code: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
}

function policyMode(value: ExecutionMode) {
  if (!['SHADOW', 'PAPER', 'PREVIEW', 'LIVE'].includes(value)) throw new Error('EXECUTION_MODE_INVALID');
  if (value === 'LIVE') throw new Error('LIVE_ACTIVATION_NOT_APPROVED');
  return value;
}

function idempotencyKey(userId: string, input: OrderIntentInput) {
  const explicit = input.idempotencyKey?.trim();
  if (explicit) return explicit.slice(0, 128);
  return createHash('sha256').update(JSON.stringify([
    userId, input.connectionId, input.sourceSignalId, input.strategyId, input.market,
    input.symbol.trim().toUpperCase(), input.side, input.positionSide, input.requestedQuantity,
    input.requestedPrice, input.sourceSignalGeneratedAt,
  ])).digest('hex');
}

export class MemberInvestmentService {
  constructor(
    private readonly repository: MemberInvestmentRepository,
    private readonly gateway: ExecutionProviderAdapter,
    private readonly telegram: Pick<MemberInvestmentTelegramService, 'notifyIntent'>,
    private readonly now = () => new Date(),
  ) {}

  async overview(userId: string) {
    const data = await this.repository.getOverview(userId);
    return {
      ...data,
      safety: MEMBER_INVESTMENT_SAFETY,
      cryptoPrivateAccountRuntime: 'NOT_ACTIVATED' as const,
      providerPrivateRequests: 0 as const,
    };
  }

  async savePolicy(userId: string, input: AutomationPolicyInput) {
    const connection = await this.repository.getConnection(userId, cleanText(input.connectionId, 'CONNECTION_ID_INVALID'));
    if (!connection) throw new Error('ACCOUNT_CONNECTION_MISSING');
    const timestamp = this.now().toISOString();
    const existing = input.id ? await this.repository.getPolicy(userId, input.id) : null;
    if (input.id && existing && existing.userId !== userId) throw new Error('AUTOMATION_POLICY_OWNER_MISMATCH');
    const policy: AutomationPolicy = {
      id: input.id?.trim() || randomUUID(),
      userId,
      connectionId: connection.id,
      market: input.market,
      strategyId: cleanText(input.strategyId, 'STRATEGY_ID_INVALID'),
      strategyVersion: cleanText(input.strategyVersion, 'STRATEGY_VERSION_INVALID'),
      enabled: input.enabled === true,
      executionMode: policyMode(input.executionMode),
      allowedSymbols: [...new Set(input.allowedSymbols.map((value) => cleanText(value, 'SYMBOL_INVALID').toUpperCase()))],
      maxPositionValue: finiteNonNegative(input.maxPositionValue, 'POLICY_LIMIT_INVALID'),
      maxPositionPct: finiteNonNegative(input.maxPositionPct, 'POLICY_LIMIT_INVALID'),
      maxDailyLoss: finiteNonNegative(input.maxDailyLoss, 'POLICY_LIMIT_INVALID'),
      maxDrawdown: finiteNonNegative(input.maxDrawdown, 'POLICY_LIMIT_INVALID'),
      maxOrdersPerDay: integerNonNegative(input.maxOrdersPerDay, 'POLICY_LIMIT_INVALID'),
      maxConcurrentPositions: integerNonNegative(input.maxConcurrentPositions, 'POLICY_LIMIT_INVALID'),
      cooldownSeconds: integerNonNegative(input.cooldownSeconds, 'POLICY_LIMIT_INVALID'),
      leverageMin: finiteNonNegative(input.leverageMin, 'POLICY_LIMIT_INVALID'),
      leverageMax: finiteNonNegative(input.leverageMax, 'POLICY_LIMIT_INVALID'),
      minLiquidationBufferPct: finiteNonNegative(input.minLiquidationBufferPct, 'POLICY_LIMIT_INVALID'),
      stopLossRequired: input.stopLossRequired !== false,
      takeProfitRequired: input.takeProfitRequired !== false,
      killSwitch: input.killSwitch !== false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (policy.leverageMin > policy.leverageMax) throw new Error('POLICY_LEVERAGE_RANGE_INVALID');
    const saved = await this.repository.savePolicy(policy);
    await this.repository.appendAudit({
      userId, eventType: 'AUTOMATION_POLICY_SAVED', entityType: 'automation_policy', entityId: saved.id,
      payload: { enabled: saved.enabled, executionMode: saved.executionMode, killSwitch: saved.killSwitch }, occurredAt: timestamp,
    });
    return { policy: saved, safety: MEMBER_INVESTMENT_SAFETY };
  }

  async createIntentPreview(userId: string, input: OrderIntentInput) {
    const now = this.now();
    const key = idempotencyKey(userId, input);
    const duplicate = await this.repository.findIntentByIdempotency(userId, key);
    if (duplicate) return { intent: duplicate, preview: null, duplicate: true, safety: MEMBER_INVESTMENT_SAFETY };

    const intent: OrderIntent = {
      id: randomUUID(), userId,
      connectionId: cleanText(input.connectionId, 'CONNECTION_ID_INVALID'),
      sourceSignalId: cleanText(input.sourceSignalId, 'SOURCE_SIGNAL_ID_INVALID'),
      sourceSignalGeneratedAt: input.sourceSignalGeneratedAt,
      strategyId: cleanText(input.strategyId, 'STRATEGY_ID_INVALID'),
      market: input.market,
      symbol: cleanText(input.symbol, 'SYMBOL_INVALID').toUpperCase(),
      side: input.side, positionSide: input.positionSide, orderType: input.orderType,
      requestedQuantity: input.requestedQuantity, requestedPrice: input.requestedPrice,
      stopLoss: input.stopLoss, takeProfit: input.takeProfit, leverage: input.leverage,
      status: 'CREATED', riskDecision: 'PENDING', riskReasons: [], idempotencyKey: key,
      createdAt: now.toISOString(), expiresAt: input.expiresAt,
    };
    const [connection, snapshot, policy, metrics] = await Promise.all([
      this.repository.getConnection(userId, intent.connectionId),
      this.repository.getLatestSnapshot(userId, intent.connectionId),
      this.repository.getPolicy(userId, cleanText(input.policyId, 'POLICY_ID_INVALID')),
      this.repository.getRiskMetrics(userId, intent.connectionId, intent.symbol, now),
    ]);
    metrics.duplicateIntent = false;
    const risk = evaluateMemberInvestmentRisk({ authenticatedUserId: userId, intent, connection, snapshot, policy, metrics, now });
    intent.status = risk.status;
    intent.riskDecision = risk.decision;
    intent.riskReasons = risk.reasons;
    const saved = await this.repository.saveIntent(intent);
    let preview = null;
    if (risk.allowed && connection) {
      preview = await this.gateway.previewOrder(saved, connection.provider);
      await this.repository.savePreview(preview);
    }
    await this.repository.appendAudit({
      userId, eventType: risk.allowed ? 'EXECUTION_PREVIEW_CREATED' : 'ORDER_INTENT_RISK_BLOCKED',
      entityType: 'order_intent', entityId: saved.id,
      payload: { status: saved.status, decision: saved.riskDecision, reasons: saved.riskReasons, executionAuthority: 'NONE' },
      occurredAt: risk.checkedAt,
    });
    // Delivery is advisory and must never change the risk decision or make the API fail.
    await this.telegram.notifyIntent({ userId, intent: saved, connection, risk, now }).catch(() => undefined);
    return { intent: saved, preview, duplicate: false, risk, safety: MEMBER_INVESTMENT_SAFETY };
  }

  async listIntents(userId: string) {
    return { intents: await this.repository.listIntents(userId), safety: MEMBER_INVESTMENT_SAFETY };
  }

  async rejectRealExecution(userId: string, action: string) {
    const timestamp = this.now().toISOString();
    await this.repository.appendAudit({
      userId, eventType: 'REAL_EXECUTION_REJECTED', entityType: 'execution_gateway', entityId: action,
      payload: { reason: 'REAL_ORDER_EXECUTION_DISABLED', executionAuthority: 'NONE' }, occurredAt: timestamp,
    });
    throw new Error('REAL_ORDER_EXECUTION_DISABLED');
  }
}

import type { TradingRepository } from './trade-automation.repository';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import { tripKillSwitchForRiskFailure } from './trade-kill-switch.service';
import { evaluateRiskEnvelope } from './trade-risk-envelope.service';
import {
  isEvidenceBackedAutoStrategyId,
  RULE_PACK_PILOT_PROFILE,
} from './evidence-backed-auto-strategy-catalog.service';
import { readRulePackPilotCapitalState } from './trade-rule-pack-pilot-capital.service';
import type {
  TradingMarketSnapshot,
  TradingOrder,
  TradingPlan,
  TradingRiskDecision,
} from './trade-automation.types';

const MAX_APPROVAL_PRICE_DRIFT_PERCENT = 2;
const MAX_PROVIDER_CLOCK_OFFSET_MS = 5_000;
const MAX_RISK_EVIDENCE_AGE_MS = 30_000;
const MAX_SIGNAL_AGE_MS = 30_000;
const MAX_ESTIMATED_SLIPPAGE_PERCENT = 1;
const MAX_ESTIMATED_FEE_PERCENT = 1;
const FAST_MOVE_PERCENT = 5;
const OPEN_POSITION_STATES = new Set(['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'RECOVERY_REQUIRED']);
const MAINTAINED_SIGNAL_STATES = new Set(['condition_maintained', 'entry_ready', 'approved', 'READY_FOR_APPROVAL']);
const BROKEN_SIGNAL_STATES = new Set(['condition_broken', 'expired', 'invalidated', 'WEAKENED', 'INVALIDATED', 'EXPIRED']);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
}

function sameUtcDay(left: string, right: Date) {
  const parsed = new Date(left);
  return Number.isFinite(parsed.getTime())
    && parsed.getUTCFullYear() === right.getUTCFullYear()
    && parsed.getUTCMonth() === right.getUTCMonth()
    && parsed.getUTCDate() === right.getUTCDate();
}

function referencePrice(plan: TradingPlan) {
  const candidates = [
    plan.marketSnapshot.currentPrice,
    plan.marketSnapshot.plannedPrice,
    plan.limitPrice,
    plan.quoteAmount != null && plan.quantity != null && plan.quantity > 0
      ? plan.quoteAmount / plan.quantity
      : null,
  ];
  return candidates.find((value): value is number => finite(value) && value > 0) ?? null;
}

function targetMovePercent(plan: TradingPlan, currentPrice: number) {
  const target = plan.targetPrices.find((value) => finite(value) && value > 0);
  if (target == null || !(currentPrice > 0)) return null;
  const favorable = plan.side === 'sell' || plan.side === 'short'
    ? currentPrice - target
    : target - currentPrice;
  const percent = favorable / currentPrice * 100;
  return Number.isFinite(percent) ? percent : null;
}

function validateTimestamp(input: {
  value: string | null | undefined;
  now: Date;
  missingCode: string;
  invalidCode: string;
  staleCode: string;
  maximumAgeMs: number;
  blockCodes: string[];
}) {
  const parsed = Date.parse(input.value ?? '');
  if (!Number.isFinite(parsed)) {
    input.blockCodes.push(input.missingCode);
    return null;
  }
  if (parsed > input.now.getTime() + MAX_PROVIDER_CLOCK_OFFSET_MS) {
    input.blockCodes.push(input.invalidCode);
    return parsed;
  }
  if (input.now.getTime() - parsed > input.maximumAgeMs) input.blockCodes.push(input.staleCode);
  return parsed;
}

export type PreSubmissionRiskResult = {
  allowed: boolean;
  blockCodes: string[];
  warnings: string[];
  checkedAt: string;
  plan: TradingPlan;
  snapshot: TradingMarketSnapshot;
  priceDriftPercent: number | null;
};

export class TradePreSubmissionRiskError extends Error {
  constructor(public readonly result: PreSubmissionRiskResult) {
    super(`PRE_SUBMISSION_RISK_RECHECK_FAILED:${result.blockCodes.join(',')}`);
    this.name = 'TradePreSubmissionRiskError';
  }
}

export class TradePreSubmissionRiskService {
  constructor(private repository: TradingRepository) {}

  async evaluate(input: {
    userId: string;
    expectedPlan: TradingPlan;
    order: TradingOrder;
    snapshot: TradingMarketSnapshot;
    serverLiveEnabled: boolean;
    now?: Date;
  }): Promise<PreSubmissionRiskResult> {
    const now = input.now ?? new Date();
    const checkedAt = now.toISOString();
    const currentPlan = await this.repository.getPlan(input.userId, input.expectedPlan.id);
    const blockCodes: string[] = [];
    const warnings: string[] = [];

    if (!currentPlan) {
      throw new TradePreSubmissionRiskError({
        allowed: false,
        blockCodes: ['TRADE_PLAN_NOT_FOUND'],
        warnings,
        checkedAt,
        plan: input.expectedPlan,
        snapshot: input.snapshot,
        priceDriftPercent: null,
      });
    }

    if (currentPlan.state !== 'SUBMITTED') blockCodes.push('TRADE_PLAN_NOT_SUBMITTED');
    if (input.order.planId !== currentPlan.id) blockCodes.push('ORDER_PLAN_MISMATCH');
    if (input.order.approvedPlanVersion == null) blockCodes.push('APPROVED_PLAN_VERSION_MISSING');
    else if (input.order.approvedPlanVersion !== planVersion(currentPlan)) blockCodes.push('APPROVAL_VERSION_CHANGED');

    const policy = await this.repository.getPolicy(input.userId);
    const riskReducing = currentPlan.reduceOnly === true;
    if (!currentPlan.approvedAt) blockCodes.push('APPROVAL_MISSING');
    const approvedAt = Date.parse(currentPlan.approvedAt ?? '');
    const expiresAt = Date.parse(currentPlan.approvalExpiresAt ?? '');
    if (!Number.isFinite(approvedAt) || approvedAt > now.getTime()) blockCodes.push('APPROVAL_TIMESTAMP_INVALID');
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) blockCodes.push('APPROVAL_EXPIRED');

    const orders = await this.repository.listOrders(input.userId);
    const previousOrders = orders.filter((order) => order.id !== input.order.id);
    const dailyOrderCount = previousOrders.filter((order) =>
      order.state !== 'PLANNED' && sameUtcDay(order.createdAt, now)).length;
    const openPositionCount = Math.max(
      input.snapshot.openPositionCount,
      previousOrders.filter((order) => OPEN_POSITION_STATES.has(order.state)).length,
    );
    const snapshot: TradingMarketSnapshot = {
      ...currentPlan.marketSnapshot,
      ...input.snapshot,
      dailyOrderCount,
      openPositionCount,
    };

    if (currentPlan.accountMode === 'live'
      && !riskReducing
      && isEvidenceBackedAutoStrategyId(currentPlan.strategyId)) {
      const pilot = await readRulePackPilotCapitalState(this.repository, input.userId, now);
      if (!pilot.settlementReady) blockCodes.push('PILOT_CAPITAL_SETTLEMENT_NOT_READY');
      if (currentPlan.estimatedKrw > pilot.maxEntryKrw) blockCodes.push('PILOT_DYNAMIC_ENTRY_LIMIT');

      const accountExposure = finite(snapshot.accountExposureKrw) && snapshot.accountExposureKrw >= 0
        ? snapshot.accountExposureKrw
        : null;
      if (accountExposure == null) blockCodes.push('PILOT_PORTFOLIO_HEAT_UNAVAILABLE');
      else if (accountExposure + currentPlan.estimatedKrw > pilot.operatingCapitalKrw) {
        blockCodes.push('PILOT_PORTFOLIO_HEAT_LIMIT');
      }

      const envelopeRisk = Number(currentPlan.riskEnvelope?.maxLossKrw);
      const policyRiskPercent = policy.riskPerTradePercent[currentPlan.exchange];
      const pilotRiskPercent = Math.min(
        policyRiskPercent,
        RULE_PACK_PILOT_PROFILE.riskPerTradePercentCeiling,
      );
      const riskBudget = pilot.operatingCapitalKrw * pilotRiskPercent / 100;
      if (!finite(envelopeRisk) || envelopeRisk < 0) blockCodes.push('PILOT_RISK_ENVELOPE_REQUIRED');
      else if (envelopeRisk > riskBudget) blockCodes.push('PILOT_RISK_BUDGET_EXCEEDED');

      if (snapshot.openPositionCount >= RULE_PACK_PILOT_PROFILE.maxConcurrentLivePositions) {
        blockCodes.push('PILOT_CONCURRENT_POSITION_LIMIT');
      }
      if (pilot.dailyLosingTrades >= RULE_PACK_PILOT_PROFILE.maxDailyLosingTrades) {
        blockCodes.push('PILOT_DAILY_LOSING_TRADE_LIMIT');
      }
      if (pilot.dailyRealizedPnlKrw <= -RULE_PACK_PILOT_PROFILE.dailyLossStopKrw) {
        blockCodes.push('PILOT_DAILY_LOSS_KRW_LIMIT');
      }
      if (pilot.consecutiveLosses >= RULE_PACK_PILOT_PROFILE.maxConsecutiveLosses) {
        blockCodes.push('PILOT_CONSECUTIVE_LOSS_LIMIT');
      }

      const symbol = String(currentPlan.symbol).trim().toUpperCase().replace(/^KRW-/u, '');
      const latestLoss = pilot.latestLossBySymbol[symbol];
      if (latestLoss) {
        const lossAt = Date.parse(latestLoss.closedAt);
        if (Number.isFinite(lossAt)
          && now.getTime() - lossAt < RULE_PACK_PILOT_PROFILE.lossCooldownMinutes * 60_000) {
          blockCodes.push('PILOT_SYMBOL_LOSS_COOLDOWN');
        }
        if (latestLoss.signalId === currentPlan.signalId) blockCodes.push('PILOT_FRESH_SIGNAL_REQUIRED');
      }

      if (currentPlan.exchange === 'bitget') {
        if (currentPlan.leverage !== RULE_PACK_PILOT_PROFILE.futuresMaxLeverage) {
          blockCodes.push('PILOT_FUTURES_LEVERAGE_REQUIRED');
        }
        if (currentPlan.marginMode !== 'isolated') blockCodes.push('PILOT_FUTURES_ISOLATED_REQUIRED');
      }
    }

    const observedAt = validateTimestamp({
      value: snapshot.observedAt,
      now,
      missingCode: 'MARKET_DATA_TIMESTAMP_UNAVAILABLE',
      invalidCode: 'MARKET_DATA_FROM_FUTURE',
      staleCode: 'MARKET_DATA_STALE',
      maximumAgeMs: 30_000,
      blockCodes,
    });
    if (observedAt != null) {
      const observedDelay = Math.max(0, now.getTime() - observedAt);
      if (!finite(snapshot.dataDelayMs) || snapshot.dataDelayMs < 0) blockCodes.push('MARKET_DATA_DELAY_UNKNOWN');
      else if (Math.abs(snapshot.dataDelayMs - observedDelay) > MAX_PROVIDER_CLOCK_OFFSET_MS) {
        blockCodes.push('MARKET_DATA_DELAY_INCONSISTENT');
      }
    }
    validateTimestamp({
      value: snapshot.riskObservedAt,
      now,
      missingCode: 'RISK_EVIDENCE_TIMESTAMP_UNAVAILABLE',
      invalidCode: 'RISK_EVIDENCE_TIMESTAMP_INVALID',
      staleCode: 'RISK_EVIDENCE_STALE',
      maximumAgeMs: MAX_RISK_EVIDENCE_AGE_MS,
      blockCodes,
    });
    if (finite(snapshot.providerTimeOffsetMs)
      && Math.abs(snapshot.providerTimeOffsetMs) > MAX_PROVIDER_CLOCK_OFFSET_MS) {
      blockCodes.push('PROVIDER_CLOCK_OFFSET_TOO_LARGE');
    }
    if (currentPlan.accountMode !== 'paper' && !snapshot.source?.trim()) blockCodes.push('MARKET_DATA_SOURCE_UNAVAILABLE');
    if (snapshot.marketStatus !== 'OPEN') blockCodes.push('MARKET_NOT_OPEN');
    if (snapshot.halted) blockCodes.push('MARKET_HALTED');
    if (!riskReducing && finite(snapshot.oneMinuteMovePercent) && Math.abs(snapshot.oneMinuteMovePercent) >= FAST_MOVE_PERCENT) {
      blockCodes.push('FAST_MOVE_DETECTED');
    }

    const currentPrice = snapshot.currentPrice;
    const approvedPrice = referencePrice(currentPlan);
    let priceDriftPercent: number | null = null;
    if (!finite(currentPrice) || currentPrice <= 0) {
      if (currentPlan.accountMode === 'paper') warnings.push('모의 실행 현재가가 없어 가격 괴리 검사를 생략했습니다.');
      else blockCodes.push('CURRENT_PRICE_UNAVAILABLE');
    }
    if (approvedPrice == null) {
      if (riskReducing) warnings.push('위험축소 청산은 승인 기준가격 괴리 제한을 적용하지 않습니다.');
      else if (currentPlan.accountMode === 'paper') warnings.push('승인 기준가격이 없어 모의 실행에서 가격 괴리 검사를 생략했습니다.');
      else blockCodes.push('APPROVAL_REFERENCE_PRICE_UNAVAILABLE');
    } else if (finite(currentPrice) && currentPrice > 0) {
      priceDriftPercent = Math.abs(currentPrice - approvedPrice) / approvedPrice * 100;
      if (!riskReducing && priceDriftPercent > MAX_APPROVAL_PRICE_DRIFT_PERCENT) {
        blockCodes.push('APPROVAL_PRICE_DRIFT_EXCEEDED');
      } else if (riskReducing && priceDriftPercent > MAX_APPROVAL_PRICE_DRIFT_PERCENT) {
        warnings.push('위험축소 청산은 가격 급변 중에도 현재가·수량 검증 후 계속 진행합니다.');
      }
    }

    const signalState = snapshot.signalState;
    if (!riskReducing) {
      if (signalState && BROKEN_SIGNAL_STATES.has(signalState)) blockCodes.push('SIGNAL_CONDITION_BROKEN');
      else if (signalState && !MAINTAINED_SIGNAL_STATES.has(signalState)) blockCodes.push('SIGNAL_NOT_ENTRY_READY');
      else if (!signalState) {
        if (currentPlan.accountMode === 'paper') warnings.push('모의 실행 신호 상태를 별도 공급자가 확인하지 않았습니다.');
        else blockCodes.push('SIGNAL_STATE_UNAVAILABLE');
      }
      if (snapshot.signalObservedAt) {
        validateTimestamp({
          value: snapshot.signalObservedAt,
          now,
          missingCode: 'SIGNAL_TIMESTAMP_UNAVAILABLE',
          invalidCode: 'SIGNAL_TIMESTAMP_INVALID',
          staleCode: 'SIGNAL_STATE_STALE',
          maximumAgeMs: MAX_SIGNAL_AGE_MS,
          blockCodes,
        });
      } else if (currentPlan.accountMode !== 'paper') {
        blockCodes.push('SIGNAL_TIMESTAMP_UNAVAILABLE');
      }
    }

    const liquidity = snapshot.availableLiquidityKrw;
    if (!riskReducing) {
      if (!finite(liquidity) || liquidity < 0) {
        if (currentPlan.accountMode !== 'paper') blockCodes.push('LIQUIDITY_UNAVAILABLE');
      } else if (liquidity < currentPlan.estimatedKrw) blockCodes.push('INSUFFICIENT_ORDERBOOK_LIQUIDITY');
    }

    const slippage = snapshot.estimatedSlippagePercent;
    if (!finite(slippage) || slippage < 0) {
      if (riskReducing) warnings.push('위험축소 청산의 슬리피지 추정치가 없어도 계좌·가격·수량 검증을 우선합니다.');
      else if (currentPlan.accountMode !== 'paper') blockCodes.push('SLIPPAGE_ESTIMATE_UNAVAILABLE');
    } else if (slippage > MAX_ESTIMATED_SLIPPAGE_PERCENT) {
      if (riskReducing) warnings.push('위험축소 청산의 슬리피지가 높지만 포지션 축소를 우선합니다.');
      else blockCodes.push('ESTIMATED_SLIPPAGE_TOO_HIGH');
    }

    const fee = snapshot.estimatedFeePercent;
    if (!finite(fee) || fee < 0) {
      if (riskReducing) warnings.push('위험축소 청산의 수수료 추정치가 없어도 포지션 축소를 우선합니다.');
      else if (currentPlan.accountMode !== 'paper') blockCodes.push('FEE_ESTIMATE_UNAVAILABLE');
    } else if (fee > MAX_ESTIMATED_FEE_PERCENT) {
      if (riskReducing) warnings.push('위험축소 청산의 비용이 높지만 포지션 축소를 우선합니다.');
      else blockCodes.push('ESTIMATED_FEE_TOO_HIGH');
    }

    if (!riskReducing && finite(currentPrice) && currentPrice > 0 && finite(slippage) && finite(fee)) {
      const targetPercent = targetMovePercent(currentPlan, currentPrice);
      const roundTripCostPercent = (slippage + fee) * 2;
      if (targetPercent != null && targetPercent <= roundTripCostPercent) blockCodes.push('EXPECTED_COST_EXCEEDS_TARGET_MOVE');
    }

    const envelopeDecision = evaluateRiskEnvelope({ plan: currentPlan, snapshot, now });
    blockCodes.push(...envelopeDecision.blockCodes);

    const refreshedPlan: TradingPlan = { ...currentPlan, marketSnapshot: snapshot };
    const baseDecision: TradingRiskDecision = evaluateTradingPlan(refreshedPlan, policy, {
      emergencyStopped: policy.emergencyStopped
        || process.env.TRADING_EMERGENCY_STOP === 'true'
        || await this.repository.getGlobalEmergencyStop(),
      serverLiveEnabled: input.serverLiveEnabled,
    });
    blockCodes.push(...baseDecision.blockCodes);
    warnings.push(...baseDecision.warnings);

    const result: PreSubmissionRiskResult = {
      allowed: unique(blockCodes).length === 0,
      blockCodes: unique(blockCodes),
      warnings: unique(warnings),
      checkedAt,
      plan: refreshedPlan,
      snapshot,
      priceDriftPercent,
    };
    if (!result.allowed) {
      await tripKillSwitchForRiskFailure({
        repository: this.repository,
        userId: input.userId,
        blockCodes: result.blockCodes,
      });
      throw new TradePreSubmissionRiskError(result);
    }
    return result;
  }
}
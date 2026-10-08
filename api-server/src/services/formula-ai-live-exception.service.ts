import type { TradingPlanInput } from './trade-automation.types';
import {
  STRATEGY_RULE_PACKS,
  type StrategyRulePackId,
  type StrategyRulePackMarket,
} from './evidence-backed-auto-strategy-catalog.service';

export const FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION = 'FORMULA_AI_LIVE_EXCEPTION_V1' as const;

const DEFINITIONS = new Map(STRATEGY_RULE_PACKS.map((row) => [row.strategyId, row] as const));
const EXCEPTION_IDS = new Set<StrategyRulePackId>(STRATEGY_RULE_PACKS.map((row) => row.strategyId));

export type FormulaAiLiveExceptionDecision = Readonly<{
  policyVersion: typeof FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION;
  recognized: boolean;
  allowed: boolean;
  strategyId: string;
  market: StrategyRulePackMarket | null;
  direction: 'BUY' | 'LONG' | 'SHORT' | null;
  researchPromotionBypassed: boolean;
  bypassedResearchGates: readonly string[];
  preservedOperationalGates: readonly string[];
  blockers: readonly string[];
}>;

function marketForPlan(plan: TradingPlanInput): StrategyRulePackMarket | null {
  if (plan.exchange === 'upbit') return 'CRYPTO_SPOT';
  if (plan.exchange === 'bitget') return 'CRYPTO_FUTURES';
  if (plan.market === 'KR') return 'KR_STOCK';
  if (plan.market === 'US') return 'US_STOCK';
  return null;
}

function directionForPlan(plan: TradingPlanInput): 'BUY' | 'LONG' | 'SHORT' | null {
  if (plan.exchange === 'bitget') {
    if (plan.side === 'long') return 'LONG';
    if (plan.side === 'short') return 'SHORT';
    return null;
  }
  return plan.side === 'buy' ? 'BUY' : null;
}

function reasonSet(plan: TradingPlanInput) {
  return new Set(plan.signalReasons.map((value) => String(value).trim()).filter(Boolean));
}

function reasonWithPrefix(plan: TradingPlanInput, prefix: string) {
  return plan.signalReasons.find((value) => String(value).startsWith(prefix)) ?? null;
}

export function isFormulaAiLiveExceptionStrategyId(strategyId: string): strategyId is StrategyRulePackId {
  return EXCEPTION_IDS.has(strategyId as StrategyRulePackId);
}

export function evaluateFormulaAiLiveException(
  plan: TradingPlanInput,
  nowMs = Date.now(),
): FormulaAiLiveExceptionDecision {
  const blockers: string[] = [];
  const definition = DEFINITIONS.get(plan.strategyId as StrategyRulePackId) ?? null;
  const market = marketForPlan(plan);
  const direction = directionForPlan(plan);

  if (!definition) blockers.push('FORMULA_AI_EXCEPTION_STRATEGY_NOT_ALLOWED');
  if (plan.accountMode !== 'live') blockers.push('FORMULA_AI_EXCEPTION_LIVE_ACCOUNT_REQUIRED');
  if (!market || !definition?.markets.includes(market)) blockers.push('FORMULA_AI_EXCEPTION_MARKET_MISMATCH');
  if (!direction || !definition?.directions.includes(direction)) blockers.push('FORMULA_AI_EXCEPTION_DIRECTION_MISMATCH');

  const reasons = reasonSet(plan);
  if (!reasons.has('CANONICAL_PAPER_HANDOFF')) blockers.push('FORMULA_AI_EXCEPTION_CANONICAL_HANDOFF_REQUIRED');
  if (!reasons.has('STRATEGY_RULE_PACK:' + plan.strategyId)) blockers.push('FORMULA_AI_EXCEPTION_STRATEGY_IDENTITY_REQUIRED');
  if (!reasons.has('STRATEGY_RULE_PACK_GATE:PAPER_CANDIDATE')) blockers.push('FORMULA_AI_EXCEPTION_RULE_GATE_REQUIRED');
  if (!reasons.has('AI_REVIEW_DECISION:PASS')) blockers.push('FORMULA_AI_EXCEPTION_AI_PASS_REQUIRED');
  if (!reasons.has('AI_REVIEW_LIVE_ELIGIBLE:PASS_ONLY_ELIGIBLE')) blockers.push('FORMULA_AI_EXCEPTION_AI_LIVE_ELIGIBLE_REQUIRED');

  const digestReason = reasonWithPrefix(plan, 'AI_REVIEW_EVIDENCE:');
  const digest = digestReason ? digestReason.slice('AI_REVIEW_EVIDENCE:'.length).trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(digest)) blockers.push('FORMULA_AI_EXCEPTION_AI_EVIDENCE_DIGEST_REQUIRED');

  const expiresReason = reasonWithPrefix(plan, 'AI_REVIEW_EXPIRES:');
  const expiresAt = expiresReason ? Date.parse(expiresReason.slice('AI_REVIEW_EXPIRES:'.length).trim()) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) blockers.push('FORMULA_AI_EXCEPTION_AI_REVIEW_STALE');

  if (plan.exchange === 'bitget') {
    if (plan.marginMode !== 'isolated') blockers.push('FORMULA_AI_EXCEPTION_FUTURES_ISOLATED_REQUIRED');
    if (!Number.isInteger(plan.leverage) || Number(plan.leverage) < 2 || Number(plan.leverage) > 7) {
      blockers.push('FORMULA_AI_EXCEPTION_FUTURES_LEVERAGE_INVALID');
    }
  }

  const unique = [...new Set(blockers)].sort();
  return Object.freeze({
    policyVersion: FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION,
    recognized: definition != null,
    allowed: unique.length === 0,
    strategyId: plan.strategyId,
    market,
    direction,
    researchPromotionBypassed: unique.length === 0,
    bypassedResearchGates: Object.freeze([
      'OOS',
      'WALK_FORWARD',
      'FULL_COST',
      'STRATEGY_HEALTH',
      'PROFITABILITY_ATTESTATION',
      'PROMOTION',
    ]),
    preservedOperationalGates: Object.freeze([
      'FORMULA_RULE_EVIDENCE',
      'AI_REVIEW_PASS',
      'MARKET_DIRECTION',
      'TRADING_RISK_ENGINE',
      'PROVIDER_CONNECTION',
      'PROVIDER_CAPABILITY',
      'KILL_SWITCH',
      'DAILY_LOSS_LIMIT',
      'POSITION_LIMIT',
      'SLIPPAGE_SPREAD_LIQUIDITY',
      'BITGET_ISOLATED_MARGIN',
      'BITGET_MAX_7X',
    ]),
    blockers: Object.freeze(unique),
  });
}

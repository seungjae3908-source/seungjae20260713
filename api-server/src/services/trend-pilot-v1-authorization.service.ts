// Trend pilot v1 — live exception authorization (pure + node:crypto only).
//
// The canonical live path normally requires server profitability attestation
// from the research → Paper promotion pipeline. The owner approved (2026-10-18)
// a narrow exception (conditional on the paper-promotion record below) for ONE fixed, backtested rule set: BTC/ETH Bitget futures
// and six Upbit KRW coins, sized at 2% of equity per trade. The exception only
// applies when every condition holds; anything missing fails closed and the
// plan is evaluated by the normal gates (which block it).
//   * TREND_PILOT_LIVE_ENABLED=true and a TREND_PILOT_SIGNING_KEY (≥32 chars)
//   * a signed PAPER promotion record for the strategy (TREND_PILOT_PROMOTION_KEY +
//     TREND_PILOT_PROMOTION_RECORD_PATH): >=30 closed trades, 95% lower bound > 0,
//     >=3 symbols, >=60% win rate. Missing or failing evidence denies the exception.
//   * live account, the pilot strategy id for that exchange, a pilot symbol
//   * the member enabled that strategy id in the stored policy
//   * Bitget: 5x isolated, long/short; Upbit: KRW market buy only
//   * the member's stored policy is automatic and enabled (never a manual plan)
//   * the signal occurrence id carries an HMAC that only the server lane can make,
//     bound to strategy, exchange, symbol, side, signal id, signal bar, stop,
//     quantity and order amount (a replay with another size or id fails)
//   * TREND_PILOT_LANE_V1 is a server-only reason: the public plans API rejects it
//   * the signal bar closed less than 30 minutes before the check
// Every other risk check (max order, margin, daily loss, emergency stop, arm,
// position isolation, …) still runs; the exception only replaces research
// attestation, the per-trade risk percent cap, the stage order cap and the
// notional-based exposure percentages that cannot express a leveraged pilot.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { TREND_PILOT_SPOT_V1, TREND_PILOT_V1 } from './trend-pilot-v1.core';
import { checkTrendPilotPromotion } from './trend-pilot-v1-promotion.service';
import type { TradingPlanInput, TradingPolicy } from './trade-automation.types';

export const TREND_PILOT_LANE_REASON = 'TREND_PILOT_LANE_V1';
const OCCURRENCE_PREFIX = 'tp1';
const MAX_SIGNAL_AGE_AFTER_CLOSE_MS = 30 * 60 * 1000;
const MIN_KEY_LENGTH = 32;

export type TrendPilotOccurrence = {
  strategyId: string;
  exchange: 'bitget' | 'upbit';
  symbol: string;
  side: string;
  signalId: string;
  signalBarOpenMs: number;
  stopPrice: number;
  quantity: number | null;
  estimatedKrw: number;
};

export type TrendPilotLiveException = {
  allowed: boolean;
  blockCodes: string[];
  riskPercent: number;
  openRiskPercent: number;
  maxConcurrent: number;
  exposureDivisor: number; // Bitget measures exposure by margin (notional / leverage)
};

const DENIED: TrendPilotLiveException = Object.freeze({
  allowed: false, blockCodes: [], riskPercent: 0, openRiskPercent: 0, maxConcurrent: 0, exposureDivisor: 1,
}) as TrendPilotLiveException;

export function trendPilotLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.TREND_PILOT_LIVE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export function trendPilotSigningKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = String(env.TREND_PILOT_SIGNING_KEY ?? '').trim();
  return key.length >= MIN_KEY_LENGTH ? key : null;
}

function canonicalNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toPrecision(12);
}

function digest(occurrence: TrendPilotOccurrence, key: string): string {
  const message = [
    OCCURRENCE_PREFIX, occurrence.strategyId, occurrence.exchange, occurrence.symbol.toUpperCase(),
    occurrence.side, occurrence.signalId, String(occurrence.signalBarOpenMs), canonicalNumber(occurrence.stopPrice),
    canonicalNumber(occurrence.quantity), canonicalNumber(occurrence.estimatedKrw),
  ].join('|');
  return createHmac('sha256', key).update(message).digest('hex').slice(0, 32);
}

/** Server lane only: the signal occurrence id for an entry plan. */
export function signTrendPilotOccurrence(occurrence: TrendPilotOccurrence, key: string): string {
  if (!key || key.length < MIN_KEY_LENGTH) throw new Error('TREND_PILOT_SIGNING_KEY_REQUIRED');
  if (!Number.isSafeInteger(occurrence.signalBarOpenMs) || !(occurrence.stopPrice > 0)
    || !(occurrence.estimatedKrw > 0) || !occurrence.signalId) throw new Error('TREND_PILOT_OCCURRENCE_INVALID');
  return `${OCCURRENCE_PREFIX}:${occurrence.signalBarOpenMs}:${digest(occurrence, key)}`;
}

/** Recomputes the HMAC from the plan's own fields. */
export function verifyTrendPilotOccurrence(plan: Pick<TradingPlanInput, 'strategyId' | 'exchange' | 'symbol' | 'side' | 'stopPrice' | 'signalOccurrenceId' | 'signalId' | 'quantity' | 'estimatedKrw'>, key: string | null): number | null {
  if (!key) return null;
  const parts = String(plan.signalOccurrenceId ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== OCCURRENCE_PREFIX) return null;
  const barMs = Number(parts[1]);
  if (!Number.isSafeInteger(barMs) || barMs <= 0) return null;
  if (plan.exchange !== 'bitget' && plan.exchange !== 'upbit') return null;
  const expected = digest({
    strategyId: plan.strategyId, exchange: plan.exchange, symbol: plan.symbol, side: plan.side,
    signalId: plan.signalId, signalBarOpenMs: barMs, stopPrice: plan.stopPrice,
    quantity: plan.quantity ?? null, estimatedKrw: plan.estimatedKrw,
  }, key);
  const given = Buffer.from(parts[2], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return barMs;
}

export function evaluateTrendPilotLiveException(
  plan: TradingPlanInput,
  policy: TradingPolicy,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): TrendPilotLiveException {
  if (plan.accountMode !== 'live' || plan.reduceOnly === true) return DENIED;
  if (!plan.signalReasons?.includes(TREND_PILOT_LANE_REASON)) return DENIED;
  const blockCodes: string[] = [];
  const deny = (code: string): TrendPilotLiveException => ({ ...DENIED, blockCodes: [...blockCodes, code] });
  if (!trendPilotLiveEnabled(env)) return deny('TREND_PILOT_LIVE_DISABLED');
  if (policy.mode !== 'automatic' || policy.automaticEnabled !== true) return deny('TREND_PILOT_AUTOMATIC_POLICY_REQUIRED');
  const key = trendPilotSigningKey(env);
  if (!key) return deny('TREND_PILOT_SIGNING_KEY_REQUIRED');

  let maxConcurrent = 0;
  let exposureDivisor = 1;
  if (plan.exchange === 'bitget') {
    if (plan.strategyId !== TREND_PILOT_V1.strategyId) return deny('TREND_PILOT_STRATEGY_MISMATCH');
    if (!(TREND_PILOT_V1.symbols as readonly string[]).includes(plan.symbol.toUpperCase())) return deny('TREND_PILOT_SYMBOL_NOT_ALLOWED');
    if (plan.side !== 'long' && plan.side !== 'short') return deny('TREND_PILOT_SIDE_INVALID');
    if (plan.leverage !== TREND_PILOT_V1.leverage || plan.marginMode !== 'isolated') return deny('TREND_PILOT_LEVERAGE_MISMATCH');
    maxConcurrent = TREND_PILOT_V1.symbols.length;
    exposureDivisor = TREND_PILOT_V1.leverage;
  } else if (plan.exchange === 'upbit') {
    if (plan.strategyId !== TREND_PILOT_SPOT_V1.strategyId) return deny('TREND_PILOT_STRATEGY_MISMATCH');
    const market = plan.symbol.toUpperCase().startsWith('KRW-') ? plan.symbol.toUpperCase() : `KRW-${plan.symbol.toUpperCase()}`;
    if (!(TREND_PILOT_SPOT_V1.symbols as readonly string[]).includes(market)) return deny('TREND_PILOT_SYMBOL_NOT_ALLOWED');
    if (plan.side !== 'buy' || plan.market !== 'KRW' || plan.orderType !== 'market') return deny('TREND_PILOT_SIDE_INVALID');
    maxConcurrent = TREND_PILOT_SPOT_V1.symbols.length;
  } else {
    return deny('TREND_PILOT_EXCHANGE_NOT_ALLOWED');
  }
  if (!policy.enabledStrategies.includes(plan.strategyId)) return deny('TREND_PILOT_STRATEGY_NOT_ENABLED');
  // Owner rule: no live orders before the PAPER track record passed (>=30 closed trades after
  // costs, 95% lower bound > 0, >=3 symbols, >=60% wins). Signed record from the research side.
  const promotion = checkTrendPilotPromotion(plan.strategyId, nowMs, env);
  if (!promotion.ok) return deny(promotion.code);
  const barMs = verifyTrendPilotOccurrence(plan, key);
  if (barMs === null) return deny('TREND_PILOT_SIGNATURE_INVALID');
  const closedAtMs = barMs + TREND_PILOT_V1.intervalMs;
  if (closedAtMs > nowMs + 5_000) return deny('TREND_PILOT_SIGNAL_FROM_FUTURE');
  if (nowMs - closedAtMs > MAX_SIGNAL_AGE_AFTER_CLOSE_MS) return deny('TREND_PILOT_SIGNAL_STALE');

  const riskPercent = TREND_PILOT_V1.riskFraction * 100;
  return {
    allowed: true,
    blockCodes: [],
    riskPercent,
    // every lane position at full risk, plus 15% slack for fees and slippage
    openRiskPercent: riskPercent * maxConcurrent * 1.15,
    maxConcurrent,
    exposureDivisor,
  };
}

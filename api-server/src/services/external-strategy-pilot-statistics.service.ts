import { readFile } from 'node:fs/promises';
import type { TradingAssetClass, TradingOrder, TradingPlan } from './trade-automation.types';

const MARKETS: readonly TradingAssetClass[] = [
  'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures',
];
const WINDOW_DAYS = [1, 7, 30] as const;
const DAY_MS = 86_400_000;

export type ExternalPilotCycleObservation = Readonly<{
  schemaVersion: 'external-strategy-pilot-cycle-observation-v1';
  observedAt: string;
  serviceSha: string;
  market: TradingAssetClass;
  strategyId: string;
  monitoredSymbols: number;
  publicDataSuccesses: number;
  publicDataFailures: number;
  naturalSignals: number;
  eligibleCandidates: number;
  costPolicyBlocked: number;
  aiReviewBlocked: number;
  riskBlocked: number;
  handoffFailures: number;
  primaryReasons: readonly string[];
  observationKind: 'LIVE_PUBLIC_MARKET';
}>;

export type ExternalPilotStatisticsHistory = Readonly<{
  schemaVersion: 'external-strategy-pilot-statistics-history-v1';
  observations: readonly ExternalPilotCycleObservation[];
}>;

type WindowStatistics = Readonly<{
  days: 1 | 7 | 30;
  publicObservationAvailable: boolean;
  monitoringCycles: number;
  monitoredSymbols: number | null;
  publicDataSuccesses: number | null;
  publicDataFailures: number | null;
  naturalSignals: number | null;
  eligibleCandidates: number | null;
  costPolicyBlocked: number | null;
  aiReviewBlocked: number | null;
  riskBlocked: number | null;
  handoffFailures: number | null;
  workerAdmissions: number;
  actualLiveTrades: number;
  strategyCounts: Readonly<Record<string, number>>;
  primaryReasons: readonly string[];
}>;

export type ExternalPilotSignalStatistics = Readonly<{
  schemaVersion: 'external-strategy-pilot-signal-statistics-v1';
  naturalObservationSource: 'LIVE_PUBLIC_PRODUCER_HISTORY';
  userAdmissionSource: 'DURABLE_PLAN_ORDER_LEDGER';
  replayAndFixtureExcluded: true;
  byMarket: Readonly<Record<TradingAssetClass, Readonly<Record<'1d' | '7d' | '30d', WindowStatistics>>>>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finiteCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

/**
 * Converts one no-order public QA report into a bounded statistics row. The
 * full handoff, quote and indicator payloads are deliberately not persisted.
 * Historical replay and fixture-shaped reports are rejected rather than
 * being counted as naturally occurring signals.
 */
export function publicQaCycleObservation(value: unknown): ExternalPilotCycleObservation | null {
  const report = record(value);
  if (report?.schemaVersion !== 'upbit-external-strategy-pilot-public-qa-v1'
    || report.market !== 'CRYPTO_SPOT'
    || report.observationKind !== 'LIVE_PUBLIC_MARKET'
    || report.actualPublicData !== true) return null;
  const completedAt = String(report.completedAt ?? '');
  if (!Number.isFinite(Date.parse(completedAt))) return null;
  const rows = Array.isArray(report.rows) ? report.rows.map(record).filter((row) => row != null) : [];
  const liveRows = rows.filter((row) => row?.schemaVersion === 'external-strategy-pilot-producer-result-v1'
    && row.observationKind === 'LIVE_PUBLIC_MARKET');
  if (liveRows.length === 0) return null;
  const states = (state: string) => liveRows.filter((row) => row?.state === state).length;
  const reasons = liveRows.flatMap((row) => stringArray(row?.blockers)).slice(0, 100);
  const totals = record(report.totals);
  return Object.freeze({
    schemaVersion: 'external-strategy-pilot-cycle-observation-v1',
    observedAt: completedAt,
    serviceSha: /^[a-f0-9]{40}$/u.test(String(report.serviceSha ?? '')) ? String(report.serviceSha) : 'UNKNOWN',
    market: 'crypto_spot',
    strategyId: String(report.strategyId ?? 'UNKNOWN'),
    monitoredSymbols: Array.isArray(report.symbolsRequested) ? report.symbolsRequested.length : liveRows.length,
    publicDataSuccesses: finiteCount(totals?.providerSuccessCount ?? liveRows.length),
    publicDataFailures: finiteCount(totals?.providerFailureCount),
    naturalSignals: finiteCount(totals?.naturalCandidateCount),
    eligibleCandidates: states('READY'),
    costPolicyBlocked: states('BLOCKED_COST'),
    aiReviewBlocked: states('BLOCKED_AI'),
    riskBlocked: states('BLOCKED_RISK'),
    handoffFailures: liveRows.filter((row) => row?.state === 'READY'
      && finiteCount(row?.handoffEntryCount) === 0).length,
    primaryReasons: Object.freeze([...new Set(reasons)].sort()),
    observationKind: 'LIVE_PUBLIC_MARKET',
  });
}

export function appendPublicQaCycle(
  current: unknown,
  report: unknown,
  nowMs = Date.now(),
): ExternalPilotStatisticsHistory {
  const history = record(current);
  const existing = history?.schemaVersion === 'external-strategy-pilot-statistics-history-v1'
    && Array.isArray(history.observations) ? history.observations : [];
  const next = publicQaCycleObservation(report);
  const cutoff = nowMs - 30 * DAY_MS;
  const observations = [...existing, ...(next ? [next] : [])]
    .filter((row): row is ExternalPilotCycleObservation => {
      const item = record(row);
      return item?.schemaVersion === 'external-strategy-pilot-cycle-observation-v1'
        && item.observationKind === 'LIVE_PUBLIC_MARKET'
        && Number.isFinite(Date.parse(String(item.observedAt ?? '')))
        && Date.parse(String(item.observedAt)) >= cutoff;
    })
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .slice(-10_000);
  return Object.freeze({
    schemaVersion: 'external-strategy-pilot-statistics-history-v1',
    observations: Object.freeze(observations),
  });
}

export async function readExternalPilotStatisticsHistory(file: string | null | undefined) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const value = record(parsed);
    if (value?.schemaVersion !== 'external-strategy-pilot-statistics-history-v1'
      || !Array.isArray(value.observations)) return null;
    return appendPublicQaCycle(value, null, Date.now());
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return null;
  }
}

function externalPilotEntry(plan: TradingPlan) {
  return plan.accountMode === 'live'
    && plan.executionMode === 'automatic'
    && plan.reduceOnly !== true
    && plan.signalReasons.includes('ADMISSION_PATH:EXTERNAL_STRATEGY_PILOT');
}

function windowStatistics(input: {
  market: TradingAssetClass;
  days: 1 | 7 | 30;
  history: ExternalPilotStatisticsHistory | null;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
  nowMs: number;
}): WindowStatistics {
  const cutoff = input.nowMs - input.days * DAY_MS;
  const observed = input.history?.observations.filter((row) => row.market === input.market
    && Date.parse(row.observedAt) >= cutoff) ?? [];
  const plans = input.plans.filter((plan) => externalPilotEntry(plan)
    && Date.parse(plan.createdAt) >= cutoff
    && ((plan.exchange === 'upbit' && input.market === 'crypto_spot')
      || (plan.exchange === 'bitget' && input.market === 'crypto_futures')
      || (plan.market === 'KR' && input.market === 'domestic_stock')
      || (plan.market === 'US' && input.market === 'us_stock')));
  const planIds = new Set(plans.map((plan) => plan.id));
  const trades = input.orders.filter((order) => planIds.has(order.planId)
    && order.state === 'FILLED'
    && Date.parse(order.updatedAt) >= cutoff).length;
  const available = observed.length > 0;
  const sum = (field: keyof ExternalPilotCycleObservation) => observed.reduce((total, row) => {
    const value = row[field];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
  const maximum = (field: keyof ExternalPilotCycleObservation) => observed.reduce((largest, row) => {
    const value = row[field];
    return Math.max(largest, typeof value === 'number' ? value : 0);
  }, 0);
  const strategyCounts: Record<string, number> = {};
  for (const row of observed) strategyCounts[row.strategyId] = (strategyCounts[row.strategyId] ?? 0) + row.naturalSignals;
  for (const plan of plans) strategyCounts[plan.strategyId] = (strategyCounts[plan.strategyId] ?? 0) + 1;
  return Object.freeze({
    days: input.days,
    publicObservationAvailable: available,
    monitoringCycles: observed.length,
    monitoredSymbols: available ? maximum('monitoredSymbols') : null,
    publicDataSuccesses: available ? sum('publicDataSuccesses') : null,
    publicDataFailures: available ? sum('publicDataFailures') : null,
    naturalSignals: available ? sum('naturalSignals') : null,
    eligibleCandidates: available ? sum('eligibleCandidates') : null,
    costPolicyBlocked: available ? sum('costPolicyBlocked') : null,
    aiReviewBlocked: available ? sum('aiReviewBlocked') : null,
    riskBlocked: available ? sum('riskBlocked') : null,
    handoffFailures: available ? sum('handoffFailures') : null,
    workerAdmissions: plans.length,
    actualLiveTrades: trades,
    strategyCounts: Object.freeze(strategyCounts),
    primaryReasons: Object.freeze([...new Set(observed.flatMap((row) => row.primaryReasons))].slice(0, 20)),
  });
}

export function externalPilotSignalStatistics(input: {
  history: ExternalPilotStatisticsHistory | null;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
  nowMs?: number;
}): ExternalPilotSignalStatistics {
  const nowMs = input.nowMs ?? Date.now();
  const byMarket = Object.fromEntries(MARKETS.map((market) => [market,
    Object.fromEntries(WINDOW_DAYS.map((days) => [`${days}d`, windowStatistics({
      market, days, history: input.history, plans: input.plans, orders: input.orders, nowMs,
    })]))])) as ExternalPilotSignalStatistics['byMarket'];
  return Object.freeze({
    schemaVersion: 'external-strategy-pilot-signal-statistics-v1',
    naturalObservationSource: 'LIVE_PUBLIC_PRODUCER_HISTORY',
    userAdmissionSource: 'DURABLE_PLAN_ORDER_LEDGER',
    replayAndFixtureExcluded: true,
    byMarket,
  });
}

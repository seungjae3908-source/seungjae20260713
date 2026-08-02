import { createHash } from 'node:crypto';
import {
  BASIC_ANALYTICS_MIN_SAMPLE,
  BEHAVIOR_ANALYTICS_MIN_SAMPLE,
  GROUP_ANALYTICS_MIN_SAMPLE,
  MAX_REVIEW_REPRESENTATIVE_TRADES,
  type AnalysisCertainty,
  type AnalyticsMetricGroup,
  type BehaviorSignal,
  type PaperJournalAnalytics,
  type TradingReviewDataset,
} from './paper-journal.types';

type NormalizedTrade = {
  id: string;
  side: 'long' | 'short';
  symbol: string;
  strategy: string | null;
  filledAt: string;
  closedAt: string;
  netPnl: number;
  grossPnl: number;
  rMultiple: number | null;
  notionalValue: number | null;
  leverage: number | null;
  riskPercent: number | null;
  stopLossPrice: number | null;
  target1: number | null;
  target2: number | null;
  exitReason: string;
  dataStatus: string;
  marketRegime: string;
  costs: number;
  warnings: string[];
  ruleViolation: boolean;
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const nullableNumber = (value: unknown) => finite(value) ? value : null;
const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function normalizeTrade(payload: Record<string, unknown>): NormalizedTrade | null {
  const status = text(payload.status);
  const filledAt = validDate(payload.filledAt);
  const closedAt = validDate(payload.closedAt);
  const side = payload.side === 'long' || payload.side === 'short' ? payload.side : null;
  if (status !== 'closed' || !filledAt || !closedAt || !side || !finite(payload.netPnl)) return null;
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((item): item is string => typeof item === 'string').slice(0, 50)
    : [];
  const entryFee = finite(payload.entryFee) ? payload.entryFee : 0;
  const exitFee = finite(payload.exitFee) ? payload.exitFee : 0;
  const slippage = finite(payload.slippageCost) ? payload.slippageCost : 0;
  const funding = finite(payload.fundingCost) ? payload.fundingCost : 0;
  return {
    id: text(payload.id, text(payload.tradeId, 'unknown')),
    side,
    symbol: text(payload.symbol, 'unknown').toUpperCase(),
    strategy: text(payload.strategyName) || null,
    filledAt,
    closedAt,
    netPnl: payload.netPnl,
    grossPnl: finite(payload.grossPnl) ? payload.grossPnl : payload.netPnl + entryFee + exitFee + slippage + funding,
    rMultiple: nullableNumber(payload.rMultiple),
    notionalValue: nullableNumber(payload.notionalValue),
    leverage: nullableNumber(payload.leverage),
    riskPercent: nullableNumber(payload.riskPercent),
    stopLossPrice: nullableNumber(payload.stopLossPrice),
    target1: nullableNumber(payload.takeProfitPrice1),
    target2: nullableNumber(payload.takeProfitPrice2),
    exitReason: text(payload.exitReason, 'unknown'),
    dataStatus: text(payload.dataStatusAtEntry, 'unknown'),
    marketRegime: text(payload.marketRegimeAtEntry, 'unknown'),
    costs: entryFee + exitFee + slippage + funding,
    warnings,
    ruleViolation: payload.ruleViolation === true,
  };
}

function certainty(sampleSize: number, minimum = BASIC_ANALYTICS_MIN_SAMPLE): AnalysisCertainty {
  return sampleSize >= minimum ? 'confirmed' : 'insufficient';
}

function metricGroup(trades: NormalizedTrade[], key: string, minimum = GROUP_ANALYTICS_MIN_SAMPLE): AnalyticsMetricGroup {
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const rValues = trades.map((trade) => trade.rMultiple).filter((value): value is number => value != null);
  return {
    key,
    sampleSize: trades.length,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    winRate: trades.length >= minimum ? wins / trades.length * 100 : null,
    expectancy: trades.length >= minimum ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : null,
    averageR: trades.length >= minimum && rValues.length === trades.length
      ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length
      : null,
    certainty: certainty(trades.length, minimum),
  };
}

function grouped(
  trades: NormalizedTrade[],
  selector: (trade: NormalizedTrade) => string,
  minimum = GROUP_ANALYTICS_MIN_SAMPLE,
) {
  const map = new Map<string, NormalizedTrade[]>();
  for (const trade of trades) {
    const key = selector(trade);
    map.set(key, [...(map.get(key) ?? []), trade]);
  }
  return [...map.entries()]
    .map(([key, items]) => metricGroup(items, key, minimum))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function leverageBucket(value: number | null) {
  if (value == null) return 'unknown';
  if (value <= 2) return '1-2x';
  if (value <= 5) return '3-5x';
  return '6-10x';
}

function riskBucket(value: number | null) {
  if (value == null) return 'unknown';
  if (value <= 0.25) return '0-0.25%';
  if (value <= 0.5) return '0.26-0.50%';
  if (value <= 1) return '0.51-1.00%';
  return 'over-1%';
}

function maximumConsecutiveLosses(trades: NormalizedTrade[]) {
  let current = 0;
  let maximum = 0;
  for (const trade of [...trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))) {
    current = trade.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function behaviorSignals(trades: NormalizedTrade[]): BehaviorSignal[] {
  if (trades.length < BEHAVIOR_ANALYTICS_MIN_SAMPLE) {
    return [{
      code: 'BEHAVIOR_SAMPLE_INSUFFICIENT',
      certainty: 'insufficient',
      count: trades.length,
      message: `행동 패턴 판단에는 최소 ${BEHAVIOR_ANALYTICS_MIN_SAMPLE}건이 필요합니다.`,
      evidence: [],
    }];
  }

  const sorted = [...trades].sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  const lossReentries: string[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.netPnl < 0 && previous.symbol === current.symbol) {
      const minutes = (Date.parse(current.filledAt) - Date.parse(previous.closedAt)) / 60_000;
      if (minutes >= 0 && minutes <= 10) lossReentries.push(`${previous.id}→${current.id}:${minutes.toFixed(1)}m`);
    }
  }

  const hourly = new Map<string, string[]>();
  for (const trade of sorted) {
    const key = trade.filledAt.slice(0, 13);
    hourly.set(key, [...(hourly.get(key) ?? []), trade.id]);
  }
  const overtrading = [...hourly.entries()].filter(([, ids]) => ids.length >= 6);

  const chase = trades.filter((trade) => trade.warnings.some((warning) => /추격|chase/i.test(warning)));
  const stopWiden = trades.filter((trade) => trade.warnings.some((warning) => /손절.*확대|stop.*widen/i.test(warning)));
  const lowAfterCost = trades.filter((trade) => trade.grossPnl > 0 && trade.netPnl <= 0 && trade.costs > 0);

  return [
    {
      code: 'LOSS_REENTRY_WITHIN_10_MINUTES',
      certainty: 'candidate',
      count: lossReentries.length,
      message: lossReentries.length ? '손실 종료 후 10분 이내 동일 종목 재진입 후보가 있습니다.' : '손실 직후 재진입 후보가 발견되지 않았습니다.',
      evidence: lossReentries.slice(0, 20),
    },
    {
      code: 'OVERTRADING_HOURLY_CLUSTER',
      certainty: 'candidate',
      count: overtrading.length,
      message: overtrading.length ? '한 시간에 6건 이상 진입한 과도한 거래 빈도 후보가 있습니다.' : '과도한 시간당 거래 빈도 후보가 발견되지 않았습니다.',
      evidence: overtrading.slice(0, 20).map(([hour, ids]) => `${hour}: ${ids.length}건`),
    },
    {
      code: 'CHASE_ENTRY_WARNING',
      certainty: chase.length ? 'confirmed' : 'candidate',
      count: chase.length,
      message: chase.length ? '거래 경고에 추격 진입이 명시된 기록이 있습니다.' : '명시적인 추격 진입 경고가 없습니다.',
      evidence: chase.slice(0, 20).map((trade) => trade.id),
    },
    {
      code: 'STOP_WIDENING_WARNING',
      certainty: stopWiden.length ? 'confirmed' : 'insufficient',
      count: stopWiden.length,
      message: stopWiden.length ? '거래 경고에 손절 확대가 명시된 기록이 있습니다.' : '손절 변경 이력이 없어 손절 확대 여부는 판단할 수 없습니다.',
      evidence: stopWiden.slice(0, 20).map((trade) => trade.id),
    },
    {
      code: 'LOW_EXPECTANCY_AFTER_COST',
      certainty: 'candidate',
      count: lowAfterCost.length,
      message: lowAfterCost.length ? '총손익은 양수였지만 비용 후 순손익이 0 이하인 거래가 있습니다.' : '비용으로 기대수익이 사라진 후보가 발견되지 않았습니다.',
      evidence: lowAfterCost.slice(0, 20).map((trade) => trade.id),
    },
  ];
}

export function calculatePaperJournalAnalytics(payloads: readonly Record<string, unknown>[]): PaperJournalAnalytics {
  const trades = payloads.map(normalizeTrade).filter((trade): trade is NormalizedTrade => trade != null);
  const total = trades.length;
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalCosts = trades.reduce((sum, trade) => sum + trade.costs, 0);
  const grossMovement = trades.reduce((sum, trade) => sum + Math.abs(trade.grossPnl), 0);
  const rValues = trades.map((trade) => trade.rMultiple).filter((value): value is number => value != null);
  const stopDefined = trades.filter((trade) => trade.stopLossPrice != null);
  const stopViolation = trades.filter((trade) => trade.ruleViolation || trade.warnings.some((warning) => /손절.*없|stop.*missing/i.test(warning)));
  const targetPlanned = trades.filter((trade) => trade.target1 != null || trade.target2 != null);
  const targetExit = targetPlanned.filter((trade) => trade.exitReason === 'take_profit');
  const violations = trades.filter((trade) => trade.ruleViolation);
  const enough = total >= BASIC_ANALYTICS_MIN_SAMPLE;
  const period = [...trades].sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  const missingStop = trades.filter((trade) => trade.stopLossPrice == null).length;

  return {
    periodStart: period.at(0)?.filledAt ?? null,
    periodEnd: period.at(-1)?.closedAt ?? null,
    sampleSize: total,
    certainty: certainty(total),
    totalTrades: total,
    netPnl,
    wins: wins.length,
    losses: losses.length,
    winRate: enough ? wins.length / total * 100 : null,
    expectancy: enough ? netPnl / total : null,
    averageR: enough && rValues.length === total ? rValues.reduce((sum, value) => sum + value, 0) / total : null,
    profitFactor: enough && grossLoss > 0 ? grossProfit / grossLoss : null,
    maximumConsecutiveLosses: maximumConsecutiveLosses(trades),
    totalCosts,
    costRatioPercent: enough && grossMovement > 0 ? totalCosts / grossMovement * 100 : null,
    stopAdherenceRate: enough && stopDefined.length > 0 ? (stopDefined.length - stopViolation.length) / stopDefined.length * 100 : null,
    targetAdherenceRate: enough && targetPlanned.length > 0 ? targetExit.length / targetPlanned.length * 100 : null,
    ruleViolationRate: enough ? violations.length / total * 100 : null,
    bySide: grouped(trades, (trade) => trade.side),
    bySymbol: grouped(trades, (trade) => trade.symbol),
    byStrategy: grouped(trades, (trade) => trade.strategy ?? 'unspecified'),
    byHour: grouped(trades, (trade) => String(new Date(trade.filledAt).getUTCHours()).padStart(2, '0')),
    byWeekday: grouped(trades, (trade) => WEEKDAYS[new Date(trade.filledAt).getUTCDay()] ?? 'unknown'),
    byExitReason: grouped(trades, (trade) => trade.exitReason),
    byDataStatus: grouped(trades, (trade) => trade.dataStatus),
    byMarketRegime: grouped(trades, (trade) => trade.marketRegime),
    byLeverageBucket: grouped(trades, (trade) => leverageBucket(trade.leverage)),
    byRiskBucket: grouped(trades, (trade) => riskBucket(trade.riskPercent)),
    behaviorSignals: behaviorSignals(trades),
    facts: [
      `확정: 종료된 거래 ${total}건`,
      `확정: 손절가 없이 기록된 거래 ${missingStop}건`,
      `확정: ruleViolation=true 거래 ${violations.length}건`,
    ],
    warnings: enough ? [] : [`기본 통계 확정에는 최소 ${BASIC_ANALYTICS_MIN_SAMPLE}건이 필요합니다.`],
  };
}

function anonymizedId(id: string) {
  return createHash('sha256').update(`paper-review-v1:${id}`).digest('hex').slice(0, 16);
}

export function createTradingReviewDataset(
  payloads: readonly Record<string, unknown>[],
  analytics = calculatePaperJournalAnalytics(payloads),
): TradingReviewDataset {
  const trades = payloads.map(normalizeTrade).filter((trade): trade is NormalizedTrade => trade != null);
  const representative = [...trades]
    .sort((left, right) => Math.abs(right.rMultiple ?? 0) - Math.abs(left.rMultiple ?? 0) || left.id.localeCompare(right.id))
    .slice(0, MAX_REVIEW_REPRESENTATIVE_TRADES);
  return {
    periodStart: analytics.periodStart ?? '',
    periodEnd: analytics.periodEnd ?? '',
    sampleSize: analytics.sampleSize,
    aggregateMetrics: {
      totalTrades: analytics.totalTrades,
      netPnl: analytics.netPnl,
      winRate: analytics.winRate,
      expectancy: analytics.expectancy,
      averageR: analytics.averageR,
      profitFactor: analytics.profitFactor,
      totalCosts: analytics.totalCosts,
      costRatioPercent: analytics.costRatioPercent,
      maximumConsecutiveLosses: analytics.maximumConsecutiveLosses,
      stopAdherenceRate: analytics.stopAdherenceRate,
      targetAdherenceRate: analytics.targetAdherenceRate,
      ruleViolationRate: analytics.ruleViolationRate,
      certainty: analytics.certainty,
    },
    behaviorSignals: analytics.behaviorSignals,
    strategyMetrics: analytics.byStrategy,
    symbolMetrics: analytics.bySymbol,
    timeMetrics: [...analytics.byHour, ...analytics.byWeekday],
    representativeTrades: representative.map((trade) => ({
      anonymizedId: anonymizedId(trade.id),
      side: trade.side,
      strategy: trade.strategy,
      riskPercent: trade.riskPercent,
      rMultiple: trade.rMultiple,
      netPnlPercent: trade.notionalValue && trade.notionalValue > 0 ? trade.netPnl / trade.notionalValue * 100 : null,
      exitReason: trade.exitReason,
      ruleViolations: [
        ...(trade.ruleViolation ? ['ruleViolation'] : []),
        ...trade.warnings.filter((warning) => /위반|violation|손절.*없/i.test(warning)).slice(0, 10),
      ],
    })),
    excludedFields: [
      'email',
      'name',
      'birthDate',
      'apiKey',
      'secret',
      'accountNumber',
      'originalUserNote',
      'internalDatabaseUuid',
      'fullOrderPayload',
    ],
    warnings: [
      ...analytics.warnings,
      '현재 단계에서는 외부 AI를 호출하거나 거래기록을 전송하지 않습니다.',
      '대표 거래에는 익명화된 ID와 최소화된 성과 필드만 포함합니다.',
    ],
  };
}

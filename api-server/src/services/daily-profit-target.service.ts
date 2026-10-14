import type {
  DailyProfitTargetPolicy,
  TradingAssetClass,
} from './trade-automation.types';

export const DAILY_PROFIT_TARGET_TIME_ZONE: Readonly<Record<TradingAssetClass, string>> = Object.freeze({
  domestic_stock: 'Asia/Seoul',
  us_stock: 'America/New_York',
  crypto_spot: 'Asia/Seoul',
  crypto_futures: 'UTC',
});

export type DailyProfitTargetState = Readonly<{
  market: TradingAssetClass;
  tradingDay: string;
  timeZone: string;
  enabled: boolean;
  targetPercent: number;
  afterTargetAction: DailyProfitTargetPolicy['afterTargetAction'];
  realizedNetProfitKrw: number | null;
  unrealizedPnlKrw: number | null;
  highNetProfitKrw: number | null;
  realizedReturnPercent: number | null;
  remainingTargetPercent: number | null;
  targetReached: boolean;
  profitProtectionActive: boolean;
  compoundProfitShare: 0.5;
  reserveProfitShare: 0.5;
  strengthenedSignalRequired: boolean;
  protectionRiskBudgetKrw: number | null;
  newEntryAllowed: boolean;
  newEntryBlockReason: string | null;
  targetIsGuarantee: false;
  riskLimitsExpanded: false;
}>;

export const DAILY_PROFIT_TARGET_EVIDENCE_PREFIX = 'DAILY_PROFIT_TARGET_V1:';

export type DailyProfitTargetEvidence = Readonly<{
  market: TradingAssetClass;
  tradingDay: string;
  realizedNetProfitKrw: number;
  unrealizedPnlKrw: number;
  strengthenedSignalQualified: boolean;
  plannedRiskKrw: number;
  observedAtMs: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Exchange-local day identity. Reset is a derived boundary; it never deletes
 * cumulative settlements, reserves, or the all-time capital high-water mark. */
export function tradingDayKeyForMarket(
  market: TradingAssetClass,
  value: Date | string | number,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('DAILY_PROFIT_TARGET_CLOCK_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_PROFIT_TARGET_TIME_ZONE[market],
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function evaluateDailyProfitTarget(input: Readonly<{
  market: TradingAssetClass;
  policy: DailyProfitTargetPolicy;
  baseCapitalKrw: number;
  realizedNetProfitKrw: number | null;
  unrealizedPnlKrw: number | null;
  /** Recomputed from immutable settlement history; never reset with the day. */
  cumulativeHighNetProfitKrw: number | null;
  settlementEvidenceReady: boolean;
  strengthenedSignalQualified?: boolean;
  plannedRiskKrw?: number | null;
  now: Date | string | number;
}>): DailyProfitTargetState {
  const tradingDay = tradingDayKeyForMarket(input.market, input.now);
  const timeZone = DAILY_PROFIT_TARGET_TIME_ZONE[input.market];
  const validBase = finite(input.baseCapitalKrw) && input.baseCapitalKrw > 0;
  const realized = finite(input.realizedNetProfitKrw) ? input.realizedNetProfitKrw : null;
  const unrealized = finite(input.unrealizedPnlKrw) ? input.unrealizedPnlKrw : null;
  const high = finite(input.cumulativeHighNetProfitKrw) ? input.cumulativeHighNetProfitKrw : null;
  const targetPercent = input.policy.targetPercent;
  const evidenceReady = input.settlementEvidenceReady && validBase && realized != null
    && finite(targetPercent) && targetPercent > 0;
  const realizedReturnPercent = evidenceReady ? realized! / input.baseCapitalKrw * 100 : null;
  const remainingTargetPercent = realizedReturnPercent == null
    ? null : Math.max(0, targetPercent - realizedReturnPercent);
  // Only settled, full-cost net profit can reach the target. Unrealized PnL is
  // displayed and consumes protection budget, but never certifies achievement.
  const targetReached = input.policy.enabled && evidenceReady
    && realizedReturnPercent! >= targetPercent;
  const profitProtectionActive = targetReached
    && input.policy.afterTargetAction === 'PROFIT_PROTECTION';
  const targetKrw = validBase ? input.baseCapitalKrw * targetPercent / 100 : null;
  const givebackKrw = unrealized == null ? null : Math.max(0, -unrealized);
  // This is a smaller post-target budget, not additional leverage/capital.
  // It is limited to settled profit above the desired target and 0.25% of the
  // original lane capital. A larger target can therefore never widen risk.
  const protectionRiskBudgetKrw = profitProtectionActive && targetKrw != null
    && realized != null && givebackKrw != null
    ? round(Math.min(input.baseCapitalKrw * 0.0025,
      Math.max(0, realized - targetKrw - givebackKrw)))
    : null;

  let newEntryBlockReason: string | null = null;
  if (input.policy.enabled && !evidenceReady) {
    newEntryBlockReason = 'DAILY_PROFIT_TARGET_SETTLEMENT_EVIDENCE_REQUIRED';
  } else if (targetReached && input.policy.afterTargetAction === 'STOP_NEW_ENTRIES') {
    newEntryBlockReason = 'DAILY_PROFIT_TARGET_REACHED_STOP_NEW_ENTRIES';
  } else if (profitProtectionActive) {
    if (unrealized == null) {
      newEntryBlockReason = 'DAILY_PROFIT_TARGET_UNREALIZED_EVIDENCE_REQUIRED';
    } else if (input.strengthenedSignalQualified !== true) {
      newEntryBlockReason = 'DAILY_PROFIT_TARGET_STRENGTHENED_SIGNAL_REQUIRED';
    } else if (!(finite(input.plannedRiskKrw) && input.plannedRiskKrw > 0)) {
      newEntryBlockReason = 'DAILY_PROFIT_TARGET_PLANNED_RISK_REQUIRED';
    } else if (!(protectionRiskBudgetKrw != null
      && input.plannedRiskKrw <= protectionRiskBudgetKrw)) {
      newEntryBlockReason = 'DAILY_PROFIT_TARGET_PROTECTION_RISK_BUDGET_EXCEEDED';
    }
  }

  const currentNet = realized != null && unrealized != null ? realized + unrealized : null;
  const highNetProfitKrw = high == null ? currentNet
    : currentNet == null ? high : Math.max(high, currentNet);
  return Object.freeze({
    market: input.market,
    tradingDay,
    timeZone,
    enabled: input.policy.enabled,
    targetPercent,
    afterTargetAction: input.policy.afterTargetAction,
    realizedNetProfitKrw: realized == null ? null : round(realized),
    unrealizedPnlKrw: unrealized == null ? null : round(unrealized),
    highNetProfitKrw: highNetProfitKrw == null ? null : round(highNetProfitKrw),
    realizedReturnPercent: realizedReturnPercent == null ? null : round(realizedReturnPercent),
    remainingTargetPercent: remainingTargetPercent == null ? null : round(remainingTargetPercent),
    targetReached,
    profitProtectionActive,
    compoundProfitShare: 0.5,
    reserveProfitShare: 0.5,
    strengthenedSignalRequired: profitProtectionActive,
    protectionRiskBudgetKrw,
    newEntryAllowed: newEntryBlockReason == null,
    newEntryBlockReason,
    targetIsGuarantee: false,
    riskLimitsExpanded: false,
  });
}

export function dailyProfitTargetEvidenceReason(value: DailyProfitTargetEvidence): string {
  if (!finite(value.realizedNetProfitKrw) || !finite(value.unrealizedPnlKrw)
    || !finite(value.plannedRiskKrw) || value.plannedRiskKrw <= 0
    || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0
    || value.tradingDay !== tradingDayKeyForMarket(value.market, value.observedAtMs)) {
    throw new Error('DAILY_PROFIT_TARGET_EVIDENCE_INVALID');
  }
  return DAILY_PROFIT_TARGET_EVIDENCE_PREFIX
    + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function parseDailyProfitTargetEvidenceReason(
  reasons: readonly string[],
  nowMs: number,
): DailyProfitTargetEvidence {
  const rows = reasons.filter((reason) => reason.startsWith(DAILY_PROFIT_TARGET_EVIDENCE_PREFIX));
  if (rows.length !== 1 || !Number.isSafeInteger(nowMs)) {
    throw new Error('DAILY_PROFIT_TARGET_EVIDENCE_REQUIRED');
  }
  try {
    const decoded = JSON.parse(Buffer.from(
      rows[0]!.slice(DAILY_PROFIT_TARGET_EVIDENCE_PREFIX.length), 'base64url',
    ).toString('utf8')) as DailyProfitTargetEvidence;
    const keys = Object.keys(decoded);
    if (keys.length !== 7 || !keys.every((key) => [
      'market', 'tradingDay', 'realizedNetProfitKrw', 'unrealizedPnlKrw',
      'strengthenedSignalQualified', 'plannedRiskKrw', 'observedAtMs',
    ].includes(key)) || !Object.hasOwn(DAILY_PROFIT_TARGET_TIME_ZONE, decoded.market)
      || typeof decoded.strengthenedSignalQualified !== 'boolean'
      || !finite(decoded.realizedNetProfitKrw) || !finite(decoded.unrealizedPnlKrw)
      || !finite(decoded.plannedRiskKrw) || decoded.plannedRiskKrw <= 0
      || !Number.isSafeInteger(decoded.observedAtMs)
      || decoded.observedAtMs > nowMs + 5_000 || nowMs - decoded.observedAtMs > 90_000
      || decoded.tradingDay !== tradingDayKeyForMarket(decoded.market, decoded.observedAtMs)) {
      throw new Error('DAILY_PROFIT_TARGET_EVIDENCE_INVALID');
    }
    return Object.freeze(decoded);
  } catch (error) {
    if (error instanceof Error && error.message === 'DAILY_PROFIT_TARGET_EVIDENCE_INVALID') throw error;
    throw new Error('DAILY_PROFIT_TARGET_EVIDENCE_INVALID');
  }
}

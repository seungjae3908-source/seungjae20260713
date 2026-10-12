import { hasCapability, type MemberAccessProfile } from '../../../packages/member-access/src/index.js';
import type { AccountProvider } from '../features/account-readonly/account-readonly.contract';
import type { MemberAutoTradingBackgroundSource } from './member-auto-trading-background-worker.service';
import { liveAllFourConnectionVerificationReady, liveProviderSnapshotReadyForAutomaticWarmup } from './member-auto-trading-background-worker.service';
import { canonicalAutomaticLivePositions } from './automatic-live-position-isolation.service';
import type { TradingRepository } from './trade-automation.repository';
import { createDefaultStrategyPromotionService } from './strategy-promotion.service';
import { canonicalAiReviewEvidenceValid } from './member-auto-trading-ai-review-evidence.service';
import { isFormulaAiLiveExceptionStrategyId } from './formula-ai-live-exception.service';

export type PreactivationCheck = Readonly<{ id: string; status: 'PASS' | 'BLOCKED'; codes: readonly string[] }>;
const providers: readonly AccountProvider[] = ['toss', 'kiwoom', 'upbit', 'bitget'];
function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Z][A-Z0-9_]{0,120}$/u.test(code) ? code : 'PREACTIVATION_EVIDENCE_UNAVAILABLE';
}

/** GET-only rehearsal: no execution service, order builder, Paper DB, Telegram,
 * resume/update/claim RPC or authority mutation is reachable from this function.
 * Collect independent failures, not just the first failing provider. */
export async function auditAutomaticLivePreactivation(input: {
  userId: string; profile: MemberAccessProfile; repository: TradingRepository;
  source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'>;
  nowMs?: number; targetSha: string;
  producerCapability?: Readonly<{ targetSha: string; scannerConnected: boolean; aiReviewConnected: boolean;
    markets: readonly string[]; intervalMs: number }>;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const checks: PreactivationCheck[] = [];
  const check = async (id: string, collect: () => Promise<readonly string[]> | readonly string[]) => {
    try {
      const codes = [...new Set(await collect())];
      checks.push({ id, status: codes.length ? 'BLOCKED' : 'PASS', codes });
    } catch (error) { checks.push({ id, status: 'BLOCKED', codes: [safeCode(error)] }); }
  };
  const settled = await Promise.allSettled([
    input.repository.getPolicy(input.userId), input.repository.getConnections(input.userId),
    input.repository.listPlans(input.userId), input.repository.listOrders(input.userId),
    input.repository.getGlobalEmergencyStop(), input.source.readHandoff(nowMs),
  ]);
  const value = <T>(index: number): T => {
    const result = settled[index]!;
    if (result.status === 'rejected') throw result.reason;
    return result.value as T;
  };
  const policy = () => value<Awaited<ReturnType<TradingRepository['getPolicy']>>>(0);
  const plans = () => value<Awaited<ReturnType<TradingRepository['listPlans']>>>(2);
  const orders = () => value<Awaited<ReturnType<TradingRepository['listOrders']>>>(3);
  const handoff = () => value<Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>>(5);
  await check('EXACT_DEPLOY_SHA', () => /^[a-f0-9]{40}$/u.test(input.targetSha) ? [] : ['PREACTIVATION_DEPLOY_SHA_INVALID']);
  await check('MEMBER_CAPABILITY', () => hasCapability(input.profile, 'canAccessAutoTrading')
    && hasCapability(input.profile, 'canPlaceOrders') && hasCapability(input.profile, 'canAccessFutures')
    ? [] : ['PREACTIVATION_MEMBER_EXECUTION_CAPABILITY_REQUIRED']);
  await check('GLOBAL_AND_MEMBER_STOP', () => value<boolean>(4) || process.env.TRADING_EMERGENCY_STOP === 'true'
    || policy().emergencyStopped || policy().newEntriesStopped ? ['PREACTIVATION_STOP_ACTIVE'] : []);
  await check('FOUR_MARKET_POLICY', () => {
    const p = policy();
    const markets = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
    return p.mode === 'automatic' && p.automaticEnabled && markets.every((m) => p.marketEnabled[m])
      && providers.every((provider) => p.exchangeEnabled[provider]) && p.stockBrokerByMarket?.us_stock === 'kiwoom'
      ? [] : ['PREACTIVATION_FOUR_MARKET_POLICY_INCOMPLETE'];
  });
  await check('OWNER_APPROVED_POLICY_ALIGNMENT', () => {
    const p = policy();
    const admin = hasCapability(input.profile, 'canManageMembers');
    const baseline = admin ? 1_000_000 : 500_000;
    const codes: string[] = [];
    if (p.totalCapitalKrw !== baseline * 4 || p.maxOrderKrw !== baseline
      || ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'].some((market) =>
        p.maxAssetClassKrw[market as keyof typeof p.maxAssetClassKrw] !== baseline)) codes.push('PREACTIVATION_PER_MARKET_BASELINE_DRIFT');
    if (p.dailyLossLimitPercent !== 3) codes.push('PREACTIVATION_DAILY_LOSS_POLICY_DRIFT');
    if (p.maxDailyOrders !== 0) codes.push('PREACTIVATION_DAILY_ENTRY_COUNT_POLICY_DRIFT');
    if (!Number.isInteger(p.bitgetLeverage) || p.bitgetLeverage < 2 || p.bitgetLeverage > (admin ? 7 : 3)) {
      codes.push('PREACTIVATION_ROLE_LEVERAGE_POLICY_DRIFT');
    }
    if (p.pilotStage === 'limited-50') codes.push('PREACTIVATION_OLD_50000_STAGE_CAP');
    return codes;
  });
  await check('FOUR_PROVIDER_CREDENTIALS', () => liveAllFourConnectionVerificationReady(policy(), value(1), nowMs)
    ? [] : ['PREACTIVATION_PROVIDER_CREDENTIALS_NOT_FRESH_VERIFIED']);
  await check('SIGNAL_FRESHNESS_AND_SHA', () => {
    const h = handoff();
    if (!h) return ['PREACTIVATION_HANDOFF_MISSING'];
    if (h.status !== 'READY') return ['PREACTIVATION_HANDOFF_BLOCKED'];
    if (h.evaluatedAtMs > nowMs || nowMs - h.evaluatedAtMs > 30 * 60_000) return ['PREACTIVATION_HANDOFF_STALE'];
    return h.entries.some((e) => e.identity.researchCodeSha !== input.targetSha)
      ? ['PREACTIVATION_HANDOFF_SHA_MISMATCH'] : [];
  });
  await check('GENUINE_SCANNER_AND_AI_CONNECTION', () => {
    const producer = input.producerCapability;
    return producer?.targetSha === input.targetSha && producer.scannerConnected === true && producer.aiReviewConnected === true
      && producer.intervalMs > 0 && producer.intervalMs <= 15 * 60_000
      && ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'].every((m) => producer.markets.includes(m))
      ? [] : ['PREACTIVATION_SCANNER_AI_PRODUCER_BINDING_NOT_PROVEN'];
  });
  await check('STRATEGY_ALLOWLIST_SERVER_LINKAGE', () => {
    const p = policy();
    if (!p.enabledStrategies.length) return ['PREACTIVATION_STRATEGY_ALLOWLIST_EMPTY'];
    const promotion = createDefaultStrategyPromotionService();
    const missing = p.enabledStrategies.some((id) => p.pilotStage === 'formula-ai-exception'
      ? !isFormulaAiLiveExceptionStrategyId(id) : promotion.get(id)?.promotionEligible !== true);
    return missing ? ['PREACTIVATION_STRATEGY_EXECUTION_EVIDENCE_MISSING'] : [];
  });
  await check('CURRENT_AI_EVIDENCE', () => {
    if (policy().pilotStage !== 'formula-ai-exception') return [];
    return handoff()?.entries.some((entry) => !canonicalAiReviewEvidenceValid(entry.aiReviewEvidence, entry.identity, entry.evaluatedAtMs)
      || Number(entry.aiReviewEvidence?.expiresAtMs) <= nowMs)
      ? ['PREACTIVATION_SIGNAL_AI_REVIEW_INVALID'] : [];
  });
  await check('CANONICAL_OWNERSHIP_AND_DUPLICATES', () => {
    canonicalAutomaticLivePositions(plans(), orders());
    const seen = new Set<string>();
    for (const row of orders()) {
      const key = `${row.exchange}:${row.clientOrderId}`;
      if (seen.has(key)) return ['PREACTIVATION_DUPLICATE_CLIENT_ORDER_ID'];
      seen.add(key);
    }
    const keys = plans().map((p) => p.idempotencyKey);
    return new Set(keys).size === keys.length ? [] : ['PREACTIVATION_DUPLICATE_IDEMPOTENCY_KEY'];
  });
  await check('LIVE_PENDING_AND_RECOVERY', () => {
    const liveIds = new Set(plans().filter((p) => p.accountMode === 'live').map((p) => p.id));
    return orders().some((o) => liveIds.has(o.planId)
      && ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'].includes(o.state))
      ? ['PREACTIVATION_LIVE_ORDER_RECONCILIATION_REQUIRED'] : [];
  });
  await Promise.all(providers.map((provider) => check(`ACCOUNT_${provider.toUpperCase()}`, async () => {
    const snapshot = await input.source.readLiveAccountSnapshot(input.userId, provider);
    const owned = canonicalAutomaticLivePositions(plans(), orders());
    return liveProviderSnapshotReadyForAutomaticWarmup(snapshot, owned, policy().bitgetLeverage)
      ? [] : ['PREACTIVATION_ACCOUNT_POSITION_OR_OPEN_ORDER_BLOCKED'];
  })));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 'automatic-live-preactivation-audit-v1', targetSha: input.targetSha,
    scope: 'MEMBER_ACCOUNT_AND_SIGNAL_READONLY_REHEARSAL',
    // This endpoint cannot attest GitHub receipts, distributed budget claims,
    // market calendars, native protection readback or post-arm runtime. Never
    // treat a successful subset as overall Production activation readiness.
    activationReady: false,
    additionalRequiredControls: ['MAIN_PRODUCTION_IDENTITY', 'REQUIRED_CI_AND_STAGING',
      'FRESH_QA_ARTIFACTS', 'EXACT_MANUAL_RECEIPTS', 'NO_GATE_CONFLICT',
      'FRESH_MARKET_SESSION', 'ATOMIC_AGGREGATE_BUDGET', 'NATIVE_FUTURES_PROTECTION',
      'RECOVERY_WORKER_HEALTH', 'PM2_PERSISTENCE_AND_ROLLBACK', 'POST_ARM_HEALTH'],
    generatedAt: new Date(nowMs).toISOString(), ready: checks.every((item) => item.status === 'PASS'), checks,
    paperOutOfScope: true, telegramOutOfScope: true, orderRequests: 0, cancelRequests: 0,
    amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    liveTradingAuthorityGrantedByAudit: false, autoTradingAuthorityGrantedByAudit: false } as const;
}

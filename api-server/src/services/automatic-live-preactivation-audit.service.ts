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
// Letter casing is not sanitization: provider exceptions can contain uppercase
// API keys. Preserve only known internal causes; never return arbitrary text.
const SAFE_AUDIT_ERRORS = new Set([
  'ACCOUNT_NOT_CONFIGURED', 'CREDENTIALS_UNAVAILABLE', 'ACCOUNT_READONLY_USER_SCOPE_MISMATCH',
  'ACCOUNT_READONLY_CREDENTIAL_STORAGE_UNAVAILABLE', 'AUTH_REVOKED', 'AUTH_FAILED',
  'TOSS_AUTH_FAILED', 'TOSS_TOKEN_AUTH_FAILED', 'TOSS_ACCOUNT_API_AUTH_FAILED', 'TOSS_IP_NOT_ALLOWED',
  'UPBIT_AUTH_FAILED', 'UPBIT_IP_NOT_ALLOWED', 'UPBIT_PERMISSION_DENIED',
  'BITGET_AUTH_FAILED', 'BITGET_IP_NOT_ALLOWED', 'BITGET_PERMISSION_DENIED', 'BITGET_TIMESTAMP_REJECTED',
  'KIWOOM_AUTH_OR_IP_REJECTED', 'RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE',
  'HANDOFF_ENTRY_STALE', 'TRADE_HISTORY_BOUND_EXCEEDED', 'TRADE_HISTORY_CURSOR_INVALID',
  'TRADE_HISTORY_CHANGED_DURING_READ', 'USER_SCOPE_MISMATCH',
  'AUTOMATIC_LIVE_ATOMIC_BUDGET_GUARD_NOT_READY',
  'BACKGROUND_LIVE_OWNERSHIP_HISTORY_INCOMPLETE', 'BACKGROUND_LIVE_CANONICAL_OWNERSHIP_AMBIGUOUS',
  'BACKGROUND_LIVE_CANONICAL_PLAN_MISSING', 'BACKGROUND_LIVE_CANONICAL_FILL_RECONCILIATION_REQUIRED',
  'BACKGROUND_LIVE_CANONICAL_EXIT_PARENT_MISMATCH', 'BACKGROUND_LIVE_CANONICAL_EXIT_DIRECTION_INVALID',
  'BACKGROUND_LIVE_CANONICAL_EXIT_QUANTITY_DRIFT', 'BACKGROUND_LIVE_ACCOUNT_SNAPSHOT_NOT_FRESH',
  'BACKGROUND_LIVE_PROVIDER_POSITIONS_UNAVAILABLE', 'BACKGROUND_LIVE_OPEN_ORDERS_UNRECONCILED',
  'BITGET_NATIVE_PROTECTION_RUNTIME_PROOF_REQUIRED', 'BITGET_NATIVE_PROTECTION_CREDENTIAL_REQUIRED',
  'BITGET_NATIVE_CLOSE_RECONCILIATION_REQUIRED',
]);
function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : '';
  return SAFE_AUDIT_ERRORS.has(code)
    || /^(?:BITGET|UPBIT|KIWOOM|TOSS)_(?:AUTH_FAILED|AUTH_OR_IP_REJECTED|TIMEOUT|CONFLICT|RATE_LIMITED|UNAVAILABLE|NETWORK_ERROR|HTTP_[1-5]\d{2})$/u.test(code)
    ? code : 'PREACTIVATION_EVIDENCE_UNAVAILABLE';
}

type LifecyclePhase = 'release' | 'activation' | 'preflight' | 'execution' | 'runtime' | 'all';
type LifecycleControl = Readonly<{ id: string; phase: LifecyclePhase; observedBy?: readonly string[] }>;
const LIFECYCLE_CONTROLS: readonly LifecycleControl[] = [
  { id: 'MAIN_PRODUCTION_IDENTITY', phase: 'release' },
  { id: 'REQUIRED_CI_AND_STAGING', phase: 'release' },
  { id: 'FRESH_QA_ARTIFACTS', phase: 'release' },
  { id: 'EXACT_MANUAL_RECEIPTS', phase: 'activation' },
  { id: 'NO_GATE_CONFLICT', phase: 'activation' },
  { id: 'OWNER_POLICY', phase: 'preflight', observedBy: ['FOUR_MARKET_POLICY', 'OWNER_APPROVED_POLICY_ALIGNMENT'] },
  { id: 'MEMBER_AND_GLOBAL_STOPS', phase: 'preflight', observedBy: ['MEMBER_CAPABILITY', 'GLOBAL_AND_MEMBER_STOP'] },
  { id: 'FOUR_PROVIDER_CREDENTIALS', phase: 'preflight', observedBy: ['FOUR_PROVIDER_CREDENTIALS', ...providers.map((p) => `ACCOUNT_${p.toUpperCase()}`)] },
  { id: 'SCANNER_PRODUCER_CONNECTED', phase: 'preflight', observedBy: ['GENUINE_SCANNER_AND_AI_CONNECTION'] },
  { id: 'AI_PRODUCER_CONNECTED', phase: 'preflight', observedBy: ['GENUINE_SCANNER_AND_AI_CONNECTION', 'CURRENT_AI_EVIDENCE'] },
  { id: 'STRATEGY_EXECUTION_LINKAGE', phase: 'preflight', observedBy: ['STRATEGY_ALLOWLIST_SERVER_LINKAGE'] },
  { id: 'FRESH_SIGNAL_SHA', phase: 'preflight', observedBy: ['SIGNAL_FRESHNESS_AND_SHA', 'CURRENT_AI_EVIDENCE'] },
  { id: 'COMPLETE_CANONICAL_HISTORY', phase: 'preflight', observedBy: ['CANONICAL_OWNERSHIP_AND_DUPLICATES'] },
  { id: 'MANUAL_AUTO_ASSET_ISOLATION', phase: 'preflight', observedBy: ['CANONICAL_OWNERSHIP_AND_DUPLICATES', ...providers.map((p) => `ACCOUNT_${p.toUpperCase()}`)] },
  { id: 'OPEN_ORPHAN_STALE_ORDERS', phase: 'preflight', observedBy: ['LIVE_PENDING_AND_RECOVERY', ...providers.map((p) => `ACCOUNT_${p.toUpperCase()}`)] },
  // Current policy/positions do not prove future submission or recovery behavior.
  { id: 'DIRECTION_LEVERAGE_MARGIN', phase: 'preflight', observedBy: ['OWNER_APPROVED_POLICY_ALIGNMENT', ...providers.map((p) => `ACCOUNT_${p.toUpperCase()}`)] },
  { id: 'FRESH_MARKET_SESSION', phase: 'execution' },
  { id: 'PROVIDER_PRECISION_AND_RISK', phase: 'execution' },
  { id: 'ATOMIC_AGGREGATE_BUDGET', phase: 'execution' },
  { id: 'SUBMISSION_IDEMPOTENCY', phase: 'execution' },
  { id: 'NATIVE_FUTURES_PROTECTION', phase: 'execution' },
  { id: 'EXISTING_POSITION_EXIT_INDEPENDENCE', phase: 'runtime' },
  { id: 'RECOVERY_WORKER_HEALTH', phase: 'runtime' },
  { id: 'PM2_PERSISTENCE_AND_ROLLBACK', phase: 'runtime' },
  { id: 'POST_ARM_HEALTH', phase: 'runtime' },
  { id: 'ZERO_QA_FINANCIAL_MUTATION', phase: 'all' },
];

/** Phase-aware coverage, not an activation certificate. Report every remaining
 * control at once; account reads cannot certify deployment, DB race, future
 * exchange fills, recovery, saved PM2 flags or post-human-arm health. */
export function automaticLiveLifecycleCoverage(checks: readonly PreactivationCheck[]) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const controls = LIFECYCLE_CONTROLS.map((control) => {
    const evidence = control.observedBy?.map((id) => byId.get(id));
    const observed = evidence?.length && evidence.every((check) => check !== undefined);
    const codes = [...new Set((evidence ?? []).flatMap((check) => check?.codes ?? []))];
    const status = !observed ? 'NOT_OBSERVED' : evidence!.every((check) => check!.status === 'PASS') ? 'PASS' : 'BLOCKED';
    return { id: control.id, phase: control.phase, status, codes,
      observationScope: observed ? 'CURRENT_MEMBER_ACCOUNT_AND_SIGNAL' : 'SEPARATE_OPERATIONAL_EVIDENCE_REQUIRED' };
  });
  return { schemaVersion: 'automatic-live-lifecycle-coverage-v1', controls,
    unobservedControlIds: controls.filter((control) => control.status === 'NOT_OBSERVED').map((control) => control.id),
    blockedControlIds: controls.filter((control) => control.status === 'BLOCKED').map((control) => control.id),
    activationReady: false, humanFinancialActivationRequired: true,
    liveTradingAuthorityGranted: false, autoTradingAuthorityGranted: false } as const;
}

/** GET-only rehearsal: no execution service, order builder, Paper DB, Telegram,
 * resume/update/claim RPC or authority mutation is reachable from this function.
 * Collect independent failures, not just the first failing provider. */
export async function auditAutomaticLivePreactivation(input: {
  userId: string; profile: MemberAccessProfile; repository: TradingRepository;
  source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot' | 'auditNativeFuturesProtection'>;
  nowMs?: number; targetSha: string;
  producerCapability?: Readonly<{ targetSha: string; scannerConnected: boolean; aiReviewConnected: boolean;
    markets: readonly string[]; intervalMs: number }>;
}) {
  // Never let NaN/Infinity/negative caller clocks bypass stale evidence by
  // making both timestamp comparisons false. Keep output JSON valid while
  // preserving an explicit fail-closed code in the signal and AI checks.
  const requestedNowMs = input.nowMs ?? Date.now();
  const clockValid = Number.isSafeInteger(requestedNowMs) && requestedNowMs > 0;
  const nowMs = clockValid ? requestedNowMs : Date.now();
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
  await check('ATOMIC_BUDGET_GUARD_INSTALLED', async () => {
    if (!input.repository.readAutomaticLiveBudgetGuard) return ['AUTOMATIC_LIVE_ATOMIC_BUDGET_GUARD_NOT_READY'];
    const guard = await input.repository.readAutomaticLiveBudgetGuard();
    return guard.ready && guard.version === 'automatic-live-atomic-budget-v3' ? [] : ['AUTOMATIC_LIVE_ATOMIC_BUDGET_GUARD_NOT_READY'];
  });
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
    // An empty READY transport can prove heartbeat availability but has zero
    // candidate SHA identities. A real first entry needs separately issued
    // source and AI evidence; do not promote an empty array's .some(false).
    if (!clockValid) return ['PREACTIVATION_CLOCK_INVALID'];
    const h = handoff();
    if (!h) return ['PREACTIVATION_HANDOFF_MISSING'];
    if (h.status !== 'READY') return ['PREACTIVATION_HANDOFF_BLOCKED'];
    if (!Number.isSafeInteger(h.evaluatedAtMs) || h.evaluatedAtMs <= 0
      || h.evaluatedAtMs > nowMs || nowMs - h.evaluatedAtMs > 30 * 60_000) {
      return ['PREACTIVATION_HANDOFF_STALE'];
    }
    if (!Array.isArray(h.entries) || !Number.isSafeInteger(h.entryCount)
      || h.entryCount !== h.entries.length) {
      return ['PREACTIVATION_HANDOFF_IDENTITY_COUNT_INVALID'];
    }
    if (h.entries.length === 0) return ['PREACTIVATION_HANDOFF_CANDIDATE_IDENTITY_MISSING'];
    return h.entries.some((entry) => entry?.identity?.researchCodeSha !== input.targetSha)
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
    if (!clockValid) return ['PREACTIVATION_CLOCK_INVALID'];
    const current = handoff();
    // Optional chaining on a missing handoff (or an empty READY transport)
    // previously returned PASS without a single actual AI review. A live
    // formula exception may never use absence of observations as approval.
    if (!current || current.status !== 'READY' || current.entries.length === 0) {
      return ['PREACTIVATION_SIGNAL_AI_REVIEW_MISSING'];
    }
    return current.entries.some((entry) => !canonicalAiReviewEvidenceValid(entry.aiReviewEvidence, entry.identity, entry.evaluatedAtMs)
      || Number(entry.aiReviewEvidence?.expiresAtMs) <= nowMs)
      ? ['PREACTIVATION_SIGNAL_AI_REVIEW_INVALID'] : [];
  });
  await check('CANONICAL_OWNERSHIP_AND_DUPLICATES', () => {
    canonicalAutomaticLivePositions(plans(), orders());
    const byId = new Map(plans().map((p) => [p.id, p]));
    const seen = new Set<string>();
    for (const row of orders()) {
      const parent = byId.get(row.planId);
      // An unknown parent is not proof that this is a harmless Paper order.
      if (!parent) return ['PREACTIVATION_ORDER_PARENT_UNRESOLVED'];
      if (parent.accountMode === 'paper') continue;
      if (parent.accountMode !== 'live' || parent.userId !== row.userId || parent.exchange !== row.exchange) {
        return ['PREACTIVATION_LIVE_ORDER_LINEAGE_INVALID'];
      }
      const key = `${row.exchange}:${row.clientOrderId}`;
      if (seen.has(key)) return ['PREACTIVATION_DUPLICATE_CLIENT_ORDER_ID'];
      seen.add(key);
    }
    const keys = plans().filter((p) => p.accountMode === 'live').map((p) => p.idempotencyKey);
    return new Set(keys).size === keys.length ? [] : ['PREACTIVATION_DUPLICATE_IDEMPOTENCY_KEY'];
  });
  await check('LIVE_PENDING_AND_RECOVERY', () => {
    const byId = new Map(plans().map((p) => [p.id, p]));
    if (orders().some((o) => !byId.has(o.planId))) return ['PREACTIVATION_ORDER_PARENT_UNRESOLVED'];
    return orders().some((o) => byId.get(o.planId)?.accountMode !== 'paper'
      && ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'].includes(o.state))
      ? ['PREACTIVATION_LIVE_ORDER_RECONCILIATION_REQUIRED'] : [];
  });
  await check('NATIVE_FUTURES_PROTECTION_READBACK', async () => {
    // A wired reader and actual readback are required. No-position success
    // proves only that no current AUTO futures needs protection; it cannot
    // attest future submission/triggered-close correctness or grant authority.
    if (!input.source.auditNativeFuturesProtection) return ['BITGET_NATIVE_PROTECTION_RUNTIME_PROOF_REQUIRED'];
    return await input.source.auditNativeFuturesProtection(input.userId, plans(), orders()) === true
      ? [] : ['BITGET_NATIVE_PROTECTION_RUNTIME_PROOF_REQUIRED'];
  });
  await Promise.all(providers.map((provider) => check(`ACCOUNT_${provider.toUpperCase()}`, async () => {
    const snapshot = await input.source.readLiveAccountSnapshot(input.userId, provider);
    const owned = canonicalAutomaticLivePositions(plans(), orders());
    return liveProviderSnapshotReadyForAutomaticWarmup(snapshot, owned, policy().bitgetLeverage)
      ? [] : ['PREACTIVATION_ACCOUNT_POSITION_OR_OPEN_ORDER_BLOCKED'];
  })));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 'automatic-live-preactivation-audit-v1', targetSha: input.targetSha,
    lifecycleCoverage: automaticLiveLifecycleCoverage(checks),
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

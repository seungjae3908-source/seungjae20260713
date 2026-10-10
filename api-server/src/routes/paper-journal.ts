import { createHash } from 'node:crypto';
import { Router, type IRouter, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { calculatePaperJournalAnalytics, createTradingReviewDataset } from '../services/paper-journal-analytics.service';
import { createSupabasePaperJournalRepository } from '../services/paper-journal-supabase.repository';
import { createSupabaseTradingRepository, type TradingRepository } from '../services/trade-automation.repository';
import {
  PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
  type TradingOrder,
  type TradingPlan,
  type TradingPolicy,
} from '../services/trade-automation.types';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { enforceMemberTradingPolicy } from '../services/trade-automation-policy-guard.service';
import { automaticLiveExecutionEnabled } from '../services/trade-automation.service';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  adminFourMarketPaperCapitalReadback,
  memberFourMarketPaperCapitalReadback,
} from '../services/admin-four-market-paper-readback.service';
import {
  ADMIN_FOUR_PAPER_MARKETS, ADMIN_MARKET_INITIAL_KRW, ADMIN_WALLET_CONFIRMATION,
  adminPaperWalletId, buildAdminFourMarketPaperBootstrap,
  buildMemberFourMarketPaperBootstrap, inspectAdminFourMarketPaperWallets,
  inspectMemberFourMarketPaperWallets, isAdminPaperWalletId,
  isMemberPaperWalletId, isProtectedFourMarketPaperWalletId,
  MEMBER_MARKET_INITIAL_KRW, MEMBER_WALLET_CONFIRMATION,
  type FourMarketPaperWalletRole,
} from '../services/admin-four-market-paper-capital.service';
import {
  AUTOMATIC_PAPER_ACCOUNT_ID,
  AUTOMATIC_PAPER_INITIAL_KRW,
  AUTOMATIC_PAPER_LEGACY_ACCOUNT_IDS,
  automaticPaperWalletBootstrapReadiness,
  automaticPaperLegacyEpochIsolationReadiness,
  isAutomaticPaperAccountId,
} from '../services/member-auto-trading-background-worker.service';
import { readTradeAutomationJournalPayloads } from '../services/trade-automation-unified-journal-adapter';
import {
  deleteAllPaperJournalData,
  getPaperJournalSnapshot,
  resolvePaperJournalConflict,
  syncPaperJournal,
} from '../services/paper-journal-sync.service';
import {
  JOURNAL_ANALYSIS_MODE,
  PaperJournalError,
  type AiProviderCallState,
  type PaperJournalRepository,
  type StoredPaperJournalRecord,
} from '../services/paper-journal.types';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import {
  readAccountJournalHistory,
  type AccountJournalHistoryResult,
} from '../features/account-readonly/account-readonly.journal-history';
import { buildAiReviewDataset, generateTradingAiReview, previewAiReview } from '../services/trading-ai-review.service';
import { configuredTradingReviewProvider, type TradingReviewProvider } from '../services/trading-review-provider';
import { registerCanonicalPortfolioAdvisorRoute } from './paper-journal-portfolio-advisor';
import {
  JOURNAL_COST_SAFETY,
  TOSS_LIVE_READ_INTEGRATION,
  TRADE_MARKETS,
  TRADE_RANGES,
  TRADE_SOURCES,
  buildUnifiedTradeJournal,
  normalizeTossOrderContract,
  tossJournalIntegrationStatus,
  type TossOrderContract,
  type TradeMarket,
  type TradeRange,
  type TradeSource,
  type UnifiedJournalFilters,
} from '../services/unified-trade-journal.service';
import {
  bindCanonicalResearchToUnifiedJournal,
  readCanonicalResearchOwnerStateForJournalBinding,
} from '../services/unified-trade-journal-canonical-binding.service';
import {
  PaperJournalSignalPerformanceRepository,
  buildSignalPerformanceReadModel,
  type PerformanceQuery,
  type PersistentPerformanceSource,
} from '../services/signal-performance-persistence.service';

const MAX_REQUEST_BYTES = 512 * 1024;

type PaperJournalDependencies = {
  repositoryFactory: (request: AuthenticatedRequest) => PaperJournalRepository;
  now: () => Date;
  reviewProvider: TradingReviewProvider | null;
  allowTossContractPreview: boolean;
  accountHistoryReader: typeof readAccountJournalHistory;
  automationJournalReader: (request: AuthenticatedRequest, ownerId: string) => Promise<Record<string, unknown>[]>;
  automaticPaperHistoryReader: (
    request: AuthenticatedRequest, ownerId: string,
  ) => Promise<{
    orders: Awaited<ReturnType<TradingRepository['listOrders']>>;
    plans: Awaited<ReturnType<TradingRepository['listPlans']>>;
  }>;
  adminPolicyReader: (request: AuthenticatedRequest, ownerId: string) => Promise<TradingPolicy>;
  adminPolicyWriter: (request: AuthenticatedRequest, ownerId: string, policy: TradingPolicy) => Promise<void>;
  adminRlsGuardReader: (request: AuthenticatedRequest) => Promise<boolean>;
  fourMarketRlsGuardReader: (request: AuthenticatedRequest) => Promise<boolean>;
  adminFourMarketInsert: (
    request: AuthenticatedRequest, ownerId: string,
    records: ReturnType<typeof buildAdminFourMarketPaperBootstrap>,
  ) => Promise<StoredPaperJournalRecord[]>;
  fourMarketInsert: (
    request: AuthenticatedRequest, ownerId: string,
    role: FourMarketPaperWalletRole,
    records: ReturnType<typeof buildAdminFourMarketPaperBootstrap>,
  ) => Promise<StoredPaperJournalRecord[]>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Server-owned preflight for a one-time 1M automatic Paper wallet.
 * The same evidence controls preview and write; no settlement history is
 * rewritten, and a previously inserted/tombstoned wallet cannot be refilled.
 */
function automaticPaperWalletStartDecision(
  records: readonly StoredPaperJournalRecord[],
  orders: readonly TradingOrder[],
  plans: readonly TradingPlan[],
  nowMs: number,
) {
  const bootstrap = automaticPaperWalletBootstrapReadiness(orders, plans);
  const walletPreviouslyRecorded = records.some((row) =>
    row.kind === 'account' && row.id === AUTOMATIC_PAPER_ACCOUNT_ID);
  const legacyWallets = records.filter((row) => row.kind === 'account'
    && AUTOMATIC_PAPER_LEGACY_ACCOUNT_IDS.some((id) => id === row.id));
  const legacyWalletOnly = legacyWallets.length === 1
    && records.every((row) => row.kind === 'account' && isAutomaticPaperAccountId(row.id))
    && orders.length === 0 && plans.length === 0;
  const freshReady = !walletPreviouslyRecorded
    && records.length === 0 && bootstrap.safeToInitialize;
  const isolation = automaticPaperLegacyEpochIsolationReadiness(orders, plans, records, nowMs);
  const isolatedReady = !walletPreviouslyRecorded && !freshReady
    && (legacyWalletOnly || isolation.safeToIsolate);
  const state = walletPreviouslyRecorded
    ? 'ALREADY_EXISTS' as const
    : freshReady
      ? 'READY_FRESH' as const
      : isolatedReady
        ? 'READY_ISOLATE_LEGACY' as const
        : 'BLOCKED' as const;
  const blockers = walletPreviouslyRecorded
    ? ['AUTOMATIC_PAPER_WALLET_ALREADY_EXISTS']
    : freshReady || isolatedReady
      ? [] as string[]
      : [...new Set([...bootstrap.blockers, ...isolation.blockers])];
  return {
    state,
    safeToPrepare: freshReady || isolatedReady,
    requiresHistoryPreservationConfirmation: isolatedReady,
    blockers,
    historical: {
      automaticPaperPlanCount: bootstrap.automaticPaperPlanCount,
      executedAutomaticPaperOrderCount: bootstrap.executedAutomaticPaperOrderCount,
      missingFilledQuantityEvidence: bootstrap.missingFilledQuantityEvidence,
      missingFeeEvidence: bootstrap.missingFeeEvidence,
      legacyPlanCount: isolation.legacyPlanCount,
      legacyOrderCount: isolation.legacyOrderCount,
        legacyJournalCount: isolation.legacyJournalCount,
        legacyWalletCount: legacyWallets.length,
    },
  };
}

function requestSize(request: Request) {
  const declared = Number(request.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return declared;
  try {
    return Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8');
  } catch {
    return MAX_REQUEST_BYTES + 1;
  }
}

function syncEnvelope(payload: Record<string, unknown> = {}) {
  return {
    mode: 'journal-sync-only' as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    ...payload,
  };
}

function analysisEnvelope(payload: Record<string, unknown> = {}) {
  return {
    mode: JOURNAL_ANALYSIS_MODE,
    externalAiCalled: false as const,
    ...payload,
  };
}

function defaultRepositoryFactory(request: AuthenticatedRequest) {
  if (!request.member?.id || !request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  return createSupabasePaperJournalRepository(request.accessToken, request.member.id);
}

function filterPeriod(payloads: Record<string, unknown>[], start: unknown, end: unknown) {
  const startMs = typeof start === 'string' && Number.isFinite(Date.parse(start)) ? Date.parse(start) : null;
  const endMs = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? Date.parse(end) : null;
  return payloads.filter((payload) => {
    const value = typeof payload.closedAt === 'string' ? payload.closedAt : payload.filledAt;
    const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestamp)) return false;
    return (startMs == null || timestamp >= startMs) && (endMs == null || timestamp <= endMs);
  });
}

function queryText(value: unknown, maximum = 80) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
}

function unifiedFilters(query: Request['query']): UnifiedJournalFilters {
  const range = queryText(query.range, 10) ?? '30D';
  const market = queryText(query.market, 30) ?? 'ALL';
  const source = queryText(query.source, 30) ?? 'ALL';
  const grade = queryText(query.grade, 5) ?? 'ALL';
  if (!TRADE_RANGES.includes(range as TradeRange)) throw new PaperJournalError('INVALID_JOURNAL_RANGE', '매매일지 조회 기간을 확인하세요.');
  if (market !== 'ALL' && !TRADE_MARKETS.includes(market as TradeMarket)) throw new PaperJournalError('INVALID_JOURNAL_MARKET', '매매일지 시장 필터를 확인하세요.');
  if (source !== 'ALL' && !TRADE_SOURCES.includes(source as TradeSource)) throw new PaperJournalError('INVALID_JOURNAL_SOURCE', '매매일지 출처 필터를 확인하세요.');
  if (!['ALL', 'A', 'B', 'C', 'D'].includes(grade)) throw new PaperJournalError('INVALID_JOURNAL_GRADE', '매매 품질 등급 필터를 확인하세요.');
  return {
    range: range as TradeRange,
    market: market as TradeMarket | 'ALL',
    source: source as TradeSource | 'ALL',
    strategy: queryText(query.strategy),
    timeframe: queryText(query.timeframe, 20),
    grade: grade as UnifiedJournalFilters['grade'],
  };
}

function importedHistoryRecord(payload: Record<string, unknown>, observedAt: Date) {
  const sourceTime = typeof payload.closedAt === 'string' && Number.isFinite(Date.parse(payload.closedAt))
    ? new Date(payload.closedAt).toISOString()
    : typeof payload.filledAt === 'string' && Number.isFinite(Date.parse(payload.filledAt))
      ? new Date(payload.filledAt).toISOString()
      : typeof payload.orderedAt === 'string' && Number.isFinite(Date.parse(payload.orderedAt))
        ? new Date(payload.orderedAt).toISOString()
        : observedAt.toISOString();
  const identity = [
    String(payload.source ?? ''),
    String(payload.broker ?? ''),
    String(payload.brokerOrderId ?? payload.tradeId ?? payload.id ?? ''),
    String(payload.fillId ?? ''),
    String(payload.symbol ?? ''),
    String(payload.positionSide ?? payload.side ?? ''),
    sourceTime,
  ].join('|');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  const persistedPayload = {
    ...payload,
    observedAt: sourceTime,
    warnings: Array.isArray(payload.warnings)
      ? [...new Set([
          ...payload.warnings.filter((item): item is string => (
            typeof item === 'string' && item !== 'REAL_ACCOUNT_HISTORY_NOT_PERSISTED'
          )),
          'BROKER_HISTORY_IMPORTED_PERSISTENTLY',
        ])]
      : ['BROKER_HISTORY_IMPORTED_PERSISTENTLY'],
  };
  return {
    kind: 'journal' as const,
    id: `broker-import:${digest}`,
    version: 1,
    updatedAt: sourceTime,
    deletedAt: null,
    payload: persistedPayload,
  };
}

function importBatchKey(recordIds: readonly string[], index: number) {
  const digest = createHash('sha256').update(recordIds.join('|')).digest('hex').slice(0, 24);
  return `broker-import-${index}-${digest}`;
}

function containsForbiddenContractField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenContractField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    /(?:user_?id|account_?number|access_?token|refresh_?token|client_?secret|api_?key|secret_?key|authorization|cookie)/i.test(key)
      || containsForbiddenContractField(nested)
  ));
}

export function createPaperJournalRouter(
  dependencies: Partial<PaperJournalDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const repositoryFactory = dependencies.repositoryFactory ?? defaultRepositoryFactory;
  const now = dependencies.now ?? (() => new Date());
  const reviewProvider = dependencies.reviewProvider === undefined ? configuredTradingReviewProvider() : dependencies.reviewProvider;
  const allowTossContractPreview = dependencies.allowTossContractPreview === true;
  const accountHistoryReader = dependencies.accountHistoryReader ?? readAccountJournalHistory;
  const automationJournalReader = dependencies.automationJournalReader ?? (async (request, ownerId) => (
    request.accessToken
      ? readTradeAutomationJournalPayloads(createSupabaseTradingRepository(request.accessToken, ownerId), ownerId)
      : []
  ));

  const automaticPaperHistoryReader = dependencies.automaticPaperHistoryReader
    ?? (async (request: AuthenticatedRequest, ownerId: string) => {
      if (!request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      const canonical = createSupabaseTradingRepository(request.accessToken, ownerId);
      const [orders, plans] = await Promise.all([
        canonical.listOrders(ownerId), canonical.listPlans(ownerId),
      ]);
      return { orders, plans };
    });

  const adminPolicyReader = dependencies.adminPolicyReader
    ?? (async (request: AuthenticatedRequest, userId: string) => {
      if (!request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      return createSupabaseTradingRepository(
        request.accessToken, userId, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
      ).getPolicy(userId);
    });
  const adminPolicyWriter = dependencies.adminPolicyWriter
    ?? (async (request: AuthenticatedRequest, userId: string, policy: TradingPolicy) => {
      if (!request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      await createSupabaseTradingRepository(
        request.accessToken, userId, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
      ).savePolicy(userId, policy);
    });
  const adminRlsGuardReader = dependencies.adminRlsGuardReader
    ?? (async (request: AuthenticatedRequest) => {
      if (!request.accessToken) return false;
      const { data, error } = await getUserSupabase(request.accessToken)
        .rpc('admin_four_paper_wallet_rls_guard_ready');
      return !error && data === true;
    });
  const requireAdminRlsGuard = async (request: AuthenticatedRequest) => {
    if (await adminRlsGuardReader(request) !== true) {
      throw new PaperJournalError('ADMIN_PAPER_DATABASE_WALLET_GUARD_REQUIRED',
        '시장별 가상계좌의 데이터베이스 보호가 확인되지 않았습니다.', 409);
    }
  };
  const fourMarketRlsGuardReader = dependencies.fourMarketRlsGuardReader
    ?? (async (request: AuthenticatedRequest) => {
      if (!request.accessToken) return false;
      const { data, error } = await getUserSupabase(request.accessToken)
        .rpc('four_market_paper_wallet_rls_guard_ready');
      return !error && data === true;
    });
  const requireFourMarketRlsGuard = async (request: AuthenticatedRequest) => {
    if (await fourMarketRlsGuardReader(request) !== true) {
      throw new PaperJournalError('PAPER_FOUR_MARKET_DATABASE_GUARD_REQUIRED',
        '4시장 자동모의계좌의 데이터베이스 보호가 확인되지 않았습니다.', 409);
    }
  };
  
  const adminFourMarketInsert = dependencies.adminFourMarketInsert
    ?? (async (request: AuthenticatedRequest, userId: string,
      records: ReturnType<typeof buildAdminFourMarketPaperBootstrap>) => {
      if (!request.accessToken || !request.member?.id || userId !== request.member.id
        || !hasCapability(request.member, 'canManageMembers')) {
        throw new PaperJournalError('CAPABILITY_REQUIRED', '관리자 권한이 필요합니다.', 403);
      }
      // RLS denies direct authenticated V2 wallet inserts and amendments.
      // Only this authenticated/confirmed exact-owner server operation may
      // use a privileged client. Never fall back to an anon connection.
      if (!hasSupabaseServerKey()) throw new PaperJournalError(
        'ADMIN_PAPER_PRIVILEGED_INSERT_NOT_CONFIGURED',
        '보호된 모의계좌 저장 권한이 준비되지 않았습니다.', 503);
      // One PostgreSQL INSERT for all four records: insert-only, no upsert.
      const { data, error } = await getSupabase()
        .from('paper_accounts').insert(records.map((row) => ({
          user_id: userId, id: row.id, payload: row.payload,
          version: 1, deleted_at: null, updated_at: now().toISOString(),
        }))).select('id,payload,version,deleted_at,created_at,updated_at');
      if (error?.code === '23505') {
        throw new PaperJournalError('ADMIN_PAPER_WALLET_ALREADY_EXISTS',
          '기존 시장별 모의계좌는 덮어쓸 수 없습니다.', 409);
      }
      if (error || !Array.isArray(data) || data.length !== ADMIN_FOUR_PAPER_MARKETS.length) {
        throw new PaperJournalError('ADMIN_PAPER_ATOMIC_INSERT_UNVERIFIED',
          '4시장 계좌를 한 번에 준비하지 못했습니다.', 503);
      }
      return data.map((r) => ({
        kind: 'account' as const, id: r.id, payload: r.payload,
        version: r.version, updatedAt: r.updated_at,
        deletedAt: r.deleted_at, createdAt: r.created_at,
        serverUpdatedAt: r.updated_at,
      }));
    });

  const fourMarketInsert = dependencies.fourMarketInsert
    ?? (async (request: AuthenticatedRequest, userId: string,
      role: FourMarketPaperWalletRole,
      records: ReturnType<typeof buildAdminFourMarketPaperBootstrap>) => {
      const isAdmin = Boolean(request.member && hasCapability(request.member, 'canManageMembers'));
      if (!request.accessToken || !request.member?.id || userId !== request.member.id
        || !hasCapability(request.member, 'canAccessAutoTrading')
        || !hasCapability(request.member, 'canAccessJournalSync')
        || (role === 'admin') !== isAdmin) {
        throw new PaperJournalError('CAPABILITY_REQUIRED',
          '본인 역할에 맞는 자동모의계좌 권한이 필요합니다.', 403);
      }
      const correctNamespace = records.length === ADMIN_FOUR_PAPER_MARKETS.length
        && records.every((row) => role === 'admin'
          ? isAdminPaperWalletId(row.id) : isMemberPaperWalletId(row.id));
      if (!correctNamespace) throw new PaperJournalError(
        'PAPER_FOUR_MARKET_WALLET_ROLE_MISMATCH',
        '역할과 시장별 모의계좌 구성이 일치하지 않습니다.', 409,
      );
      if (!hasSupabaseServerKey()) throw new PaperJournalError(
        'PAPER_FOUR_MARKET_PRIVILEGED_INSERT_NOT_CONFIGURED',
        '보호된 자동모의계좌 저장 권한이 준비되지 않았습니다.', 503,
      );
      const insertedAt = now().toISOString();
      const { data, error } = await getSupabase()
        .from('paper_accounts').insert(records.map((row) => ({
          user_id: userId, id: row.id, payload: row.payload,
          version: 1, deleted_at: null, updated_at: insertedAt,
        }))).select('id,payload,version,deleted_at,created_at,updated_at');
      if (error?.code === '23505') throw new PaperJournalError(
        'PAPER_FOUR_MARKET_WALLETS_ALREADY_CREATED',
        '기존 4시장 자동모의계좌는 덮어쓸 수 없습니다.', 409,
      );
      if (error || !Array.isArray(data) || data.length !== ADMIN_FOUR_PAPER_MARKETS.length) {
        throw new PaperJournalError('PAPER_FOUR_MARKET_ATOMIC_INSERT_UNVERIFIED',
          '4시장 자동모의계좌를 한 번에 준비하지 못했습니다.', 503);
      }
      return data.map((row) => ({
        kind: 'account' as const, id: row.id, payload: row.payload,
        version: row.version, updatedAt: row.updated_at,
        deletedAt: row.deleted_at, createdAt: row.created_at,
        serverUpdatedAt: row.updated_at,
      }));
    });

  function requireAdminPaperScope(request: AuthenticatedRequest) {
    const userId = request.member?.id ?? '';
    if (!userId || !request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
    if (!request.member || !hasCapability(request.member, 'canManageMembers')
      || !hasCapability(request.member, 'canAccessJournalSync')) {
      throw new PaperJournalError('CAPABILITY_REQUIRED', '관리자 모의자금 설정 권한이 없습니다.', 403);
    }
    return userId;
  }
  function requireFourMarketPaperScope(request: AuthenticatedRequest) {
    const userId = request.member?.id ?? '';
    if (!userId || !request.accessToken) {
      throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
    }
    if (!request.member || !hasCapability(request.member, 'canAccessAutoTrading')
      || !hasCapability(request.member, 'canAccessJournalSync')) {
      throw new PaperJournalError('CAPABILITY_REQUIRED',
        '4시장 자동모의매매 계좌 권한이 없습니다.', 403);
    }
    return {
      userId,
      role: hasCapability(request.member, 'canManageMembers')
        ? 'admin' as const : 'member' as const,
    };
  }
  function adminAutomaticLiveGateOff() {
    // A provider capability disabled today is NOT proof that the shared
    // background worker cannot arm later using the stored AUTO flags.
    return process.env.AUTO_TRADING !== 'true'
      && process.env.LIVE_AUTOMATIC_TRADING_ENABLED !== 'true'
      && process.env.MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED !== 'true'
      && (['toss', 'kiwoom', 'upbit', 'bitget'] as const).every(
        (provider) => !automaticLiveExecutionEnabled(provider));
  }
  function adminWalletCreationDecision(
    records: readonly StoredPaperJournalRecord[],
    orders: Awaited<ReturnType<TradingRepository['listOrders']>>,
    plans: Awaited<ReturnType<TradingRepository['listPlans']>>,
    policy: TradingPolicy, timestampMs: number,
  ) {
    const current = inspectAdminFourMarketPaperWallets(records, timestampMs);
    const walletRecords = records.filter((row) => row.kind === 'account' && isAdminPaperWalletId(row.id));
    const legacyAccounts = records.filter((row) => row.kind === 'account' && !isAdminPaperWalletId(row.id));
    const legacy = automaticPaperLegacyEpochIsolationReadiness(orders, plans, records, timestampMs);
    const fresh = records.length === 0 && orders.length === 0 && plans.length === 0;
    const blockers: string[] = [];
    if (walletRecords.length) blockers.push(current.ready
      ? 'ADMIN_PAPER_WALLETS_ALREADY_CREATED' : 'ADMIN_PAPER_PARTIAL_WALLET_SET_BLOCKED');
    if (legacyAccounts.length) blockers.push('ADMIN_PAPER_EXISTING_ACCOUNT_REQUIRES_SEPARATE_RECONCILIATION');
    if (!walletRecords.length && !fresh && !legacy.safeToIsolate) blockers.push(...legacy.blockers);
    if (policy.totalCapitalKrw < ADMIN_MARKET_INITIAL_KRW) blockers.push('ADMIN_PAPER_POLICY_1M_REQUIRED');
    if (policy.automaticEnabled || policy.mode === 'automatic') {
      blockers.push('ADMIN_PAPER_MEMBER_AUTO_MUST_BE_OFF');
    }
    if (!adminAutomaticLiveGateOff()) blockers.push('ADMIN_PAPER_REAL_AUTO_GATE_MUST_BE_OFF');
    return {
      ...current,
      canCreate: blockers.length === 0,
      creationBlockers: [...new Set(blockers)],
      requiresLegacyHistoryConfirmation: !fresh && legacy.safeToIsolate,
      historical: {
        plans: plans.length, orders: orders.length,
        journalRows: records.filter((row) => row.kind === 'journal').length,
        historyPreserved: true,
      },
    };
  }

  function fourMarketWalletCreationDecision(
    role: FourMarketPaperWalletRole,
    records: readonly StoredPaperJournalRecord[],
    orders: readonly TradingOrder[],
    plans: readonly TradingPlan[],
    policy: TradingPolicy,
    timestampMs: number,
  ) {
    const current = role === 'admin'
      ? inspectAdminFourMarketPaperWallets(records, timestampMs)
      : inspectMemberFourMarketPaperWallets(records, timestampMs);
    const ownsRoleWallet = role === 'admin' ? isAdminPaperWalletId : isMemberPaperWalletId;
    const walletRecords = records.filter((row) => row.kind === 'account' && ownsRoleWallet(row.id));
    const oppositeRoleWallets = records.filter((row) => row.kind === 'account'
      && isProtectedFourMarketPaperWalletId(row.id) && !ownsRoleWallet(row.id));
    const legacyWallets = records.filter((row) => row.kind === 'account'
      && isAutomaticPaperAccountId(row.id));
    const otherLegacyRows = records.filter((row) => row.kind !== 'account');
    const fresh = records.length === 0 && orders.length === 0 && plans.length === 0;
    const legacyWalletOnly = legacyWallets.length <= 1 && otherLegacyRows.length === 0
      && orders.length === 0 && plans.length === 0;
    const isolation = automaticPaperLegacyEpochIsolationReadiness(
      orders, plans, records.filter((row) => row.kind === 'journal'), timestampMs,
    );
    const historyIsolated = !fresh && !legacyWalletOnly && isolation.safeToIsolate;
    const blockers: string[] = [];
    if (walletRecords.length) blockers.push(current.ready
      ? 'PAPER_FOUR_MARKET_WALLETS_ALREADY_CREATED'
      : 'PAPER_FOUR_MARKET_PARTIAL_WALLET_SET_BLOCKED');
    if (oppositeRoleWallets.length) blockers.push('PAPER_FOUR_MARKET_ROLE_WALLET_CONFLICT');
    if (legacyWallets.length > 1) blockers.push('PAPER_LEGACY_WALLET_DUPLICATE');
    if (!walletRecords.length && !fresh && !legacyWalletOnly && !historyIsolated) {
      blockers.push(...isolation.blockers);
    }
    if (!Number.isFinite(policy.totalCapitalKrw)
      || policy.totalCapitalKrw < PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW) {
      blockers.push('PAPER_MEMBER_POLICY_BASELINE_REQUIRED');
    }
    if (policy.automaticEnabled || policy.mode === 'automatic') {
      blockers.push('PAPER_MEMBER_AUTO_MUST_BE_OFF');
    }
    if (!adminAutomaticLiveGateOff()) blockers.push('PAPER_REAL_AUTO_GATE_MUST_BE_OFF');
    return {
      ...current,
      role,
      canCreate: blockers.length === 0,
      creationBlockers: [...new Set(blockers)],
      historyPreserved: true as const,
      historical: {
        plans: plans.length,
        orders: orders.length,
        journalRows: records.filter((row) => row.kind === 'journal').length,
        legacyWallets: legacyWallets.length,
      },
    };
  }

  const accountHistoryProviders = (request: AuthenticatedRequest) => {
    if (!request.member) return [] as Array<'toss' | 'kiwoom' | 'upbit' | 'bitget'>;
    const providers: Array<'toss' | 'kiwoom' | 'upbit' | 'bitget'> = ['toss', 'kiwoom'];
    if (hasCapability(request.member, 'canAccessSpot')) providers.push('upbit');
    if (hasCapability(request.member, 'canAccessFutures')) providers.push('bitget');
    return providers;
  };

  const historySummary = (history: AccountJournalHistoryResult) => ({
    requestedRange: history.requestedRange,
    effectiveDays: history.effectiveDays,
    rangeCapped: history.rangeCapped,
    persisted: history.persisted,
    privateProviderRequests: history.privateProviderRequests,
    providers: history.providers,
    realizedEvidence: history.realizedEvidence,
    truncated: history.truncated,
    safety: history.safety,
  });

  const requireAiReview = (request: AuthenticatedRequest) => {
    if (!request.member || !hasCapability(request.member, 'canAccessAiTradingReview')) throw new PaperJournalError('CAPABILITY_REQUIRED', 'AI 거래 복기는 준회원 이상 사용할 수 있습니다.', request.member ? 403 : 401);
    return request.member.id;
  };

  registerCanonicalPortfolioAdvisorRoute(router, {
    repositoryFactory,
    now,
    requirePortfolioAdvisor: requireAiReview,
  });

  router.get('/paper-journal/four-market/status', async (request: AuthenticatedRequest, response) => {
    try {
      const scope = requireFourMarketPaperScope(request);
      const [records, history, policy, rlsGuardReady] = await Promise.all([
        repositoryFactory(request).listSnapshot(scope.userId),
        automaticPaperHistoryReader(request, scope.userId),
        adminPolicyReader(request, scope.userId),
        fourMarketRlsGuardReader(request),
      ]);
      const assessment = fourMarketWalletCreationDecision(
        scope.role, records, history.orders, history.plans, policy, now().getTime(),
      );
      const capitalReadback = scope.role === 'admin'
        ? adminFourMarketPaperCapitalReadback({
            ownerId: scope.userId, records, plans: history.plans,
            orders: history.orders, nowMs: now().getTime(),
          })
        : memberFourMarketPaperCapitalReadback({
            ownerId: scope.userId, records, plans: history.plans,
            orders: history.orders, nowMs: now().getTime(),
          });
      const creationBlockers = rlsGuardReady ? assessment.creationBlockers
        : [...new Set([
            ...assessment.creationBlockers,
            'PAPER_FOUR_MARKET_DATABASE_GUARD_REQUIRED',
          ])];
      return response.json({
        ok: true,
        mode: 'four-market-paper-readiness-only',
        readOnlyProbe: true,
        ownerScope: 'SELF',
        ...assessment,
        rlsGuardReady,
        canCreate: assessment.canCreate && rlsGuardReady,
        creationBlockers,
        perMarketInitialKrw: scope.role === 'admin'
          ? ADMIN_MARKET_INITIAL_KRW : MEMBER_MARKET_INITIAL_KRW,
        totalInitialKrw: 4 * (scope.role === 'admin'
          ? ADMIN_MARKET_INITIAL_KRW : MEMBER_MARKET_INITIAL_KRW),
        marketCapital: capitalReadback.marketReadback,
        financialMutationCount: 0,
        privateProviderRequests: 0,
        orderSubmitted: false,
        exchangeRequestSent: false,
        liveTradingAuthorityGranted: false,
        autoTradingAuthorityGranted: false,
        transferAuthorityGranted: false,
        withdrawalAuthorityGranted: false,
      });
    } catch (error) {
      return handleError(response, error, 'PAPER_FOUR_MARKET_STATUS_UNAVAILABLE',
        '4시장 자동모의계좌 상태를 확인하지 못했습니다.', syncEnvelope);
    }
  });

  router.post('/paper-journal/four-market/bootstrap', async (request: AuthenticatedRequest, response) => {
    try {
      if (requestSize(request) > MAX_REQUEST_BYTES) {
        throw new PaperJournalError('REQUEST_TOO_LARGE', '요청 크기 제한을 초과했습니다.', 413);
      }
      const scope = requireFourMarketPaperScope(request);
      await requireFourMarketRlsGuard(request);
      const expectedConfirmation = scope.role === 'admin'
        ? ADMIN_WALLET_CONFIRMATION : MEMBER_WALLET_CONFIRMATION;
      if (request.body?.confirmation !== expectedConfirmation) {
        throw new PaperJournalError('PAPER_FOUR_MARKET_CONFIRMATION_REQUIRED',
          '기존 기록을 보존하며 4시장 자동모의계좌를 만드는 확인이 필요합니다.', 409);
      }
      const [records, history, policy] = await Promise.all([
        repositoryFactory(request).listSnapshot(scope.userId),
        automaticPaperHistoryReader(request, scope.userId),
        adminPolicyReader(request, scope.userId),
      ]);
      const readiness = fourMarketWalletCreationDecision(
        scope.role, records, history.orders, history.plans, policy, now().getTime(),
      );
      if (!readiness.canCreate) throw new PaperJournalError(
        readiness.creationBlockers[0] ?? 'PAPER_FOUR_MARKET_BOOTSTRAP_BLOCKED',
        '4시장 자동모의계좌 안전조건을 만족하지 않았습니다.', 409,
      );
      const seed = scope.role === 'admin'
        ? buildAdminFourMarketPaperBootstrap(now())
        : buildMemberFourMarketPaperBootstrap(now());
      const inserted = await fourMarketInsert(request, scope.userId, scope.role, seed);
      const proof = scope.role === 'admin'
        ? inspectAdminFourMarketPaperWallets([...records, ...inserted], now().getTime())
        : inspectMemberFourMarketPaperWallets([...records, ...inserted], now().getTime());
      if (!proof.ready) throw new PaperJournalError(
        'PAPER_FOUR_MARKET_ATOMIC_INSERT_UNVERIFIED',
        '시장별 자동모의계좌 저장 검증이 완료되지 않았습니다.', 503,
      );
      return response.json({
        ok: true,
        ownerScope: 'SELF',
        ...proof,
        preservedHistoricOrders: readiness.historical.orders,
        preservedHistoricJournalRows: readiness.historical.journalRows,
        preservedLegacyWallets: readiness.historical.legacyWallets,
        orderSubmitted: false,
        exchangeRequestSent: false,
        privateProviderRequests: 0,
        liveTradingAuthorityGranted: false,
        autoTradingAuthorityGranted: false,
        transferAuthorityGranted: false,
        withdrawalAuthorityGranted: false,
        automaticWithdrawalEnabled: false,
      });
    } catch (error) {
      return handleError(response, error, 'PAPER_FOUR_MARKET_BOOTSTRAP_FAILED',
        '4시장 자동모의계좌를 생성하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/admin-four-market/status', async (request: AuthenticatedRequest, response) => {
    try {
      const owner = requireAdminPaperScope(request);
      const [records, history, policy, rlsGuardReady] = await Promise.all([
        repositoryFactory(request).listSnapshot(owner),
        automaticPaperHistoryReader(request, owner),
        adminPolicyReader(request, owner),
        adminRlsGuardReader(request),
      ]);
      const assessment = adminWalletCreationDecision(
        records, history.orders, history.plans, policy, now().getTime());
      const capitalReadback = adminFourMarketPaperCapitalReadback({
        ownerId: owner, records, plans: history.plans, orders: history.orders,
        nowMs: now().getTime(),
      });
      const creationBlockers = rlsGuardReady ? assessment.creationBlockers
        : [...new Set([...assessment.creationBlockers, 'ADMIN_PAPER_DATABASE_WALLET_GUARD_REQUIRED'])];
      return response.json({
        ok: true, readOnlyProbe: true, ownerScope: 'SELF', administratorOnly: true,
        ...assessment, rlsGuardReady, canCreate: assessment.canCreate && rlsGuardReady,
        creationBlockers,
        marketCapital: capitalReadback.marketReadback,
        marketCapitalComputedFrom: 'CANONICAL_CURRENT_EPOCH_SETTLEMENT_ONLY',
        policy: {
          totalCapitalKrw: policy.totalCapitalKrw,
          maxOrderKrw: policy.maxOrderKrw,
          bitgetLeverage: policy.bitgetLeverage,
        },
        financialMutationCount: 0, privateProviderRequests: 0, orderSubmitted: false,
        exchangeRequestSent: false, liveTradingAuthorityGranted: false,
      });
    } catch (error) {
      return handleError(response, error, 'ADMIN_PAPER_STATUS_UNAVAILABLE',
        '관리자 모의계좌를 확인하지 못했습니다.', syncEnvelope);
    }
  });

  router.post('/paper-journal/admin-four-market/prepare-policy', async (request: AuthenticatedRequest, response) => {
    try {
      if (requestSize(request) > MAX_REQUEST_BYTES) throw new PaperJournalError('REQUEST_TOO_LARGE','요청 크기 제한을 초과했습니다.',413);
      const owner = requireAdminPaperScope(request);
      if (request.body?.confirmation !== 'SET_ADMIN_FOUR_MARKETS_1M_PAPER_POLICY') {
        throw new PaperJournalError('ADMIN_PAPER_POLICY_CONFIRMATION_REQUIRED','관리자 전용 정책 변경 확인이 필요합니다.',409);
      }
      if (!adminAutomaticLiveGateOff()) {
        throw new PaperJournalError('ADMIN_PAPER_REAL_AUTO_GATE_MUST_BE_OFF','실자동매매 상태에서는 자본 정책을 변경할 수 없습니다.',409);
      }
      await requireAdminRlsGuard(request);
      const [records, history, policyBefore] = await Promise.all([
        repositoryFactory(request).listSnapshot(owner),
        automaticPaperHistoryReader(request, owner),
        adminPolicyReader(request, owner),
      ]);
      const preflight = adminWalletCreationDecision(
        records, history.orders, history.plans, policyBefore, now().getTime(),
      );
      const unsafe = preflight.creationBlockers.filter(
        (code) => code !== 'ADMIN_PAPER_POLICY_1M_REQUIRED');
      if (unsafe.length) {
        throw new PaperJournalError(unsafe[0]!, 
          '기존 자동매매를 중지하고 이력·계좌 상태를 확인한 후 자본을 변경할 수 있습니다.', 409);
      }
      // Raise only the named Paper budgeting dimension. Never implicitly
      // raise maxOrder, leverage, drawdown or other Live order ceilings.
      const candidate = normalizeTradingPolicy({
        ...policyBefore,
        totalCapitalKrw: Math.max(ADMIN_MARKET_INITIAL_KRW, policyBefore.totalCapitalKrw),
      }, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW);
      const safe = enforceMemberTradingPolicy(candidate, policyBefore);
      if (safe.totalCapitalKrw !== policyBefore.totalCapitalKrw) {
        await adminPolicyWriter(request, owner, safe);
      }
      return response.json({
        ok: true, ownerScope: 'SELF', administratorOnly: true,
        savedPolicyCapitalKrw: safe.totalCapitalKrw,
        perMarketVirtualInitialKrw: ADMIN_MARKET_INITIAL_KRW,
        marketCount: ADMIN_FOUR_PAPER_MARKETS.length,
        riskLimitsIncreasedByThisRequest: false,
        automaticTradingEnabledByThisRequest: false,
        liveTradingEnabledByThisRequest: false, orderSubmitted: false,
        exchangeRequestSent: false, privateProviderRequests: 0,
      });
    } catch (error) {
      return handleError(response, error, 'ADMIN_PAPER_POLICY_PREPARATION_FAILED',
        '관리자 모의자본 정책을 준비하지 못했습니다.', syncEnvelope);
    }
  });

  router.post('/paper-journal/admin-four-market/bootstrap', async (request: AuthenticatedRequest, response) => {
    try {
      if (requestSize(request) > MAX_REQUEST_BYTES) throw new PaperJournalError('REQUEST_TOO_LARGE','요청 크기 제한을 초과했습니다.',413);
      const owner = requireAdminPaperScope(request);
      await requireAdminRlsGuard(request);
      if (request.body?.confirmation !== ADMIN_WALLET_CONFIRMATION) {
        throw new PaperJournalError('ADMIN_FOUR_MARKET_CONFIRMATION_REQUIRED',
          '기존 기록을 보존하며 4시장 모의계좌를 만드는 확인이 필요합니다.',409);
      }
      const [records, history, policy] = await Promise.all([
        repositoryFactory(request).listSnapshot(owner),
        automaticPaperHistoryReader(request, owner),
        adminPolicyReader(request, owner),
      ]);
      const readiness = adminWalletCreationDecision(
        records, history.orders, history.plans, policy, now().getTime());
      if (!readiness.canCreate) {
        throw new PaperJournalError(readiness.creationBlockers[0] ?? 'ADMIN_PAPER_BOOTSTRAP_BLOCKED',
          '4시장 모의계좌 안전조건을 만족하지 않았습니다.',409);
      }
      const inserted = await adminFourMarketInsert(
        request, owner, buildAdminFourMarketPaperBootstrap(now()));
      const proof = inspectAdminFourMarketPaperWallets(
        [...records, ...inserted], now().getTime());
      if (!proof.ready) throw new PaperJournalError('ADMIN_PAPER_ATOMIC_INSERT_UNVERIFIED',
        '시장별 모의계좌 저장 검증이 완료되지 않았습니다.',503);
      return response.json({
        ok: true, administratorOnly: true, ownerScope: 'SELF',
        ...proof, preservedHistoricOrders: readiness.historical.orders,
        preservedHistoricJournalRows: readiness.historical.journalRows,
        orderSubmitted: false, exchangeRequestSent: false,
        liveTradingAuthorityGranted: false, privateProviderRequests: 0,
        automaticWithdrawalEnabled: false,
      });
    } catch (error) {
      return handleError(response, error, 'ADMIN_FOUR_MARKET_BOOTSTRAP_FAILED',
        '관리자 4시장 모의계좌를 생성하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/automatic-wallet-readiness', async (request: AuthenticatedRequest, response) => {
    try {
      const userId = request.member?.id ?? '';
      if (!userId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      if (!request.member || !hasCapability(request.member, 'canAccessAutoTrading')
        || !hasCapability(request.member, 'canAccessJournalSync')) {
        throw new PaperJournalError('CAPABILITY_REQUIRED',
          '자동모의매매 계좌 준비 권한이 없습니다.', 403);
      }
      const [records, canonical] = await Promise.all([
        repositoryFactory(request).listSnapshot(userId),
        automaticPaperHistoryReader(request, userId),
      ]);
      const decision = automaticPaperWalletStartDecision(
        records, canonical.orders, canonical.plans, now().getTime(),
      );
      return response.json({
        ok: true,
        mode: 'paper-wallet-readiness-only',
        readOnlyProbe: true,
        walletId: AUTOMATIC_PAPER_ACCOUNT_ID,
        initialCapitalKrw: AUTOMATIC_PAPER_INITIAL_KRW,
        ...decision,
        financialMutationCount: 0,
        privateProviderRequests: 0,
        orderSubmitted: false,
        exchangeRequestSent: false,
      });
    } catch (cause) {
      return handleError(response, cause, 'AUTOMATIC_PAPER_WALLET_READINESS_UNAVAILABLE',
        '모의계좌 사전검증을 완료하지 못했습니다.', syncEnvelope);
    }
  });

  router.post('/paper-journal/sync', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '동기화 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const userId = request.member?.id ?? '';
      const repository = repositoryFactory(request);
      const body = isObject(request.body) ? request.body : null;
      const submitted = body && Array.isArray(body.records) ? body.records : [];
      if (submitted.some((item) => isObject(item)
        && item.kind === 'account'
        && typeof item.id === 'string'
        && isProtectedFourMarketPaperWalletId(item.id))) {
        throw new PaperJournalError('PAPER_FOUR_MARKET_WALLET_SERVER_ONLY',
          '4시장 자동모의자본은 일반 동기화로 생성·변경할 수 없습니다.',403);
      }
      const walletRecords = submitted.filter((item) => isObject(item)
        && item.kind === 'account' && item.id === AUTOMATIC_PAPER_ACCOUNT_ID);
      if (submitted.some((item) => isObject(item)
        && item.kind === 'account'
        && AUTOMATIC_PAPER_LEGACY_ACCOUNT_IDS.some((id) => id === item.id))) {
        throw new PaperJournalError('AUTOMATIC_PAPER_LEGACY_WALLET_IMMUTABLE',
          '기존 50만원 자동모의계좌는 과거 기록으로 보존되며 변경할 수 없습니다.', 409);
      }
      if (walletRecords.length && request.member
        && hasCapability(request.member, 'canManageMembers')) {
        throw new PaperJournalError('ADMIN_PAPER_USE_FOUR_MARKET_WALLETS',
          '관리자는 4시장 독립 가상계좌 경로를 사용해야 합니다.',409);
      }
      if (walletRecords.length > 0) {
        if (!userId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
        if (!request.member || !hasCapability(request.member, 'canAccessAutoTrading')) {
          throw new PaperJournalError('CAPABILITY_REQUIRED',
            '자동모의매매 가상계좌 준비 권한이 없습니다.', 403);
        }
        const wallet = walletRecords[0] as Record<string, unknown>;
        const payload = isObject(wallet.payload) ? wallet.payload : null;
        // Client-owned local Paper accounts cannot set the baseline for the
        // automatic worker. Only a fresh, exact 1M zero-exposure wallet is
        // allowed, never a reset or a mixed-account sync request.
        if (walletRecords.length !== 1 || submitted.length !== 1
          || wallet.version !== 1 || wallet.deletedAt !== null
          || payload?.id !== AUTOMATIC_PAPER_ACCOUNT_ID
          || payload?.initialBalance !== AUTOMATIC_PAPER_INITIAL_KRW
          || payload?.equity !== AUTOMATIC_PAPER_INITIAL_KRW
          || payload?.cashBalance !== AUTOMATIC_PAPER_INITIAL_KRW
          || payload?.availableMargin !== AUTOMATIC_PAPER_INITIAL_KRW
          || payload?.usedMargin !== 0
          || payload?.realizedPnl !== 0 || payload?.unrealizedPnl !== 0) {
          throw new PaperJournalError('AUTOMATIC_PAPER_WALLET_BASELINE_INVALID',
            '자동모의매매 가상계좌는 100만원 초기 상태로 한 번만 준비할 수 있습니다.', 409);
        }
        const [existingPaper, canonical] = await Promise.all([
          repository.listSnapshot(userId),
          automaticPaperHistoryReader(request, userId),
        ]);
        const decision = automaticPaperWalletStartDecision(
          existingPaper, canonical.orders, canonical.plans, now().getTime(),
        );
        if (decision.state === 'ALREADY_EXISTS') {
          throw new PaperJournalError('AUTOMATIC_PAPER_WALLET_ALREADY_EXISTS',
            '자동모의매매 가상계좌는 다시 생성할 수 없습니다.', 409);
        }
        // The read-only preflight and this write share exact server-side
        // evidence. A stale UI or reordered client request cannot waive it.
        const newEpochApproved = body?.legacyEpochConfirmation ===
          'START_NEW_1M_PAPER_EPOCH_PRESERVE_HISTORY';
        if (!decision.safeToPrepare
          || (decision.requiresHistoryPreservationConfirmation && !newEpochApproved)
          || (!decision.requiresHistoryPreservationConfirmation && newEpochApproved)) {
          throw new PaperJournalError('AUTOMATIC_PAPER_WALLET_HISTORY_RECONCILIATION_REQUIRED',
            '기존 모의거래 체결·일지·계좌를 보존하기 위해 새 원금 설정을 차단했습니다.', 409);
        }
      }
      const result = await syncPaperJournal(repository, userId, request.body, now());
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_SYNC_FAILED', '거래일지를 동기화하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/snapshot', async (request: AuthenticatedRequest, response) => {
    try {
      const result = await getPaperJournalSnapshot(
        repositoryFactory(request),
        request.member?.id ?? '',
        request.query.cursor,
        request.query.limit,
        now(),
      );
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_SNAPSHOT_FAILED', '거래일지 snapshot을 불러오지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/signal-performance', async (request: AuthenticatedRequest, response) => {
    try {
      const ownerId = request.member?.id ?? '';
      if (!ownerId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      const source = queryText(request.query.source, 30);
      const allowedSources: PersistentPerformanceSource[] = ['BACKTEST', 'OOS', 'WALK_FORWARD', 'FINAL_HOLDOUT', 'PAPER', 'SHADOW', 'LIVE_RECOMMENDATION'];
      if (!source || !allowedSources.includes(source as PersistentPerformanceSource)) throw new PaperJournalError('INVALID_PERFORMANCE_SOURCE', '성과 출처를 확인하세요.');
      const minimumText = queryText(request.query.minimumSampleSize, 8);
      const minimumSampleSize = minimumText == null ? undefined : Number(minimumText);
      if (minimumSampleSize != null && (!Number.isInteger(minimumSampleSize) || minimumSampleSize <= 0)) throw new PaperJournalError('INVALID_MINIMUM_SAMPLE_SIZE', '최소 표본 수를 확인하세요.');
      const query: PerformanceQuery = {
        source: source as PersistentPerformanceSource | undefined,
        market: queryText(request.query.market, 30) as PerformanceQuery['market'],
        symbol: queryText(request.query.symbol) ?? undefined,
        strategyMode: queryText(request.query.strategyMode, 20) as PerformanceQuery['strategyMode'],
        strategyFamily: queryText(request.query.strategyFamily) ?? undefined,
        strategyVersion: queryText(request.query.strategyVersion) ?? undefined,
        parameterHash: queryText(request.query.parameterHash) ?? undefined,
        direction: queryText(request.query.direction, 10) as PerformanceQuery['direction'],
        timeframe: queryText(request.query.timeframe, 20) ?? undefined,
        regime: queryText(request.query.regime, 30) ?? undefined,
        researchCodeSha: queryText(request.query.researchCodeSha, 40) ?? undefined,
        minimumSampleSize,
      };
      const repository = new PaperJournalSignalPerformanceRepository(repositoryFactory(request), ownerId);
      const result = await buildSignalPerformanceReadModel(repository, ownerId, query);
      return response.json(analysisEnvelope({ ok: true, result, profitabilityClaimAllowed: false }));
    } catch (cause) {
      return handleError(response, cause, 'SIGNAL_PERFORMANCE_READ_FAILED', '신호 성과를 불러오지 못했습니다.', analysisEnvelope);
    }
  });

  router.get('/signal-performance/:signalId', async (request: AuthenticatedRequest, response) => {
    try {
      const ownerId = request.member?.id ?? '';
      if (!ownerId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      const signalId = queryText(request.params.signalId, 160);
      if (!signalId) throw new PaperJournalError('SIGNAL_ID_REQUIRED', '신호 ID를 확인하세요.');
      const repository = new PaperJournalSignalPerformanceRepository(repositoryFactory(request), ownerId);
      const event = await repository.getSignal(ownerId, signalId);
      if (!event) throw new PaperJournalError('SIGNAL_PERFORMANCE_NOT_FOUND', '저장된 신호 성과가 없습니다.', 404);
      const outcomes = (await repository.listOutcomes(ownerId)).filter((row) => row.signalId === signalId);
      return response.json(analysisEnvelope({ ok: true, result: { event, outcomes }, profitabilityClaimAllowed: false }));
    } catch (cause) {
      return handleError(response, cause, 'SIGNAL_PERFORMANCE_DETAIL_FAILED', '신호 성과 상세를 불러오지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/conflicts/:id/resolve', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '충돌 해결 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const choice = isObject(request.body) ? request.body.choice : null;
      const result = await resolvePaperJournalConflict(
        repositoryFactory(request),
        request.member?.id ?? '',
        request.params.id,
        choice,
        now(),
      );
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'CONFLICT_RESOLUTION_FAILED', '동기화 충돌을 해결하지 못했습니다.', syncEnvelope);
    }
  });

  router.delete('/paper-journal/all', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '삭제 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const confirmation = isObject(request.body) ? request.body.confirmation : null;
      const userId = request.member?.id ?? '';
      const current = await repositoryFactory(request).listSnapshot(userId);
      if (current.some((row) => row.kind === 'account' && isAdminPaperWalletId(row.id))) {
        throw new PaperJournalError('ADMIN_PAPER_CAMPAIGN_DELETE_FORBIDDEN',
          '관리자 4시장 모의거래 계좌와 이력을 일괄 삭제할 수 없습니다.',409);
      }
      const result = await deleteAllPaperJournalData(repositoryFactory(request), userId, confirmation);
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_DELETE_FAILED', '서버 거래일지를 삭제하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/analytics', async (request: AuthenticatedRequest, response) => {
    try {
      const payloads = filterPeriod(
        await repositoryFactory(request).listJournalPayloads(request.member?.id ?? ''),
        request.query.start,
        request.query.end,
      );
      return response.json(analysisEnvelope({ ok: true, result: calculatePaperJournalAnalytics(payloads) }));
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_ANALYTICS_FAILED', '거래 분석을 처리하지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/import-account-history', async (request: AuthenticatedRequest, response) => {
    try {
      const ownerId = request.member?.id ?? '';
      if (!ownerId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
      const range = queryText(isObject(request.body) ? request.body.range : null, 10) ?? '30D';
      if (!TRADE_RANGES.includes(range as TradeRange)) {
        throw new PaperJournalError('INVALID_JOURNAL_RANGE', '가져올 거래내역 기간을 확인하세요.');
      }
      const observedAt = now();
      const history = await accountHistoryReader({
        userId: ownerId,
        range: range as TradeRange,
        providers: accountHistoryProviders(request),
        now: observedAt,
      });
      const repository = repositoryFactory(request);
      const records = history.payloads.map((payload) => importedHistoryRecord(payload, observedAt));
      let imported = 0;
      let unchanged = 0;
      let conflicts = 0;
      let failed = 0;
      const batchSize = 500;
      for (let offset = 0, batchIndex = 0; offset < records.length; offset += batchSize, batchIndex += 1) {
        const batch = records.slice(offset, offset + batchSize);
        const result = await syncPaperJournal(repository, ownerId, {
          idempotencyKey: importBatchKey(batch.map((record) => record.id), batchIndex),
          clientTime: observedAt.toISOString(),
          records: batch,
        }, observedAt);
        imported += result.uploaded.length;
        unchanged += result.unchanged.length;
        conflicts += result.conflicts.length;
        failed += result.failed.length;
      }
      return response.json(syncEnvelope({
        ok: true,
        requestedRange: range,
        imported,
        unchanged,
        conflicts,
        failed,
        providerHistory: historySummary(history),
        persisted: true,
      }));
    } catch (cause) {
      return handleError(response, cause, 'ACCOUNT_HISTORY_IMPORT_FAILED', '기존 거래내역을 가져오지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/unified-ledger/status', (_request: AuthenticatedRequest, response) => response.json(analysisEnvelope({
    ok: true,
    result: {
      toss: tossJournalIntegrationStatus(),
      safety: JOURNAL_COST_SAFETY,
    },
  })));

  router.get('/paper-journal/unified-ledger', async (request: AuthenticatedRequest, response) => {
    try {
      const ownerId = request.member?.id ?? '';
      const filters = unifiedFilters(request.query);
      const observedAt = now();
      const [storedPayloads, liveHistory, automationPayloads] = await Promise.all([
        repositoryFactory(request).listJournalPayloads(ownerId),
        accountHistoryReader({
          userId: ownerId,
          range: filters.range ?? '30D',
          providers: accountHistoryProviders(request),
          now: observedAt,
        }),
        automationJournalReader(request, ownerId),
      ]);
      const knownBrokerOrderIds = new Set(
        [...storedPayloads, ...automationPayloads]
          .map((payload) => String(payload.brokerOrderId ?? ''))
          .filter(Boolean),
      );
      const externalHistoryPayloads = liveHistory.payloads.filter(
        (payload) => !knownBrokerOrderIds.has(String(payload.brokerOrderId ?? '')),
      );
      const journal = buildUnifiedTradeJournal(
        [...storedPayloads, ...automationPayloads, ...externalHistoryPayloads],
        filters,
        observedAt,
      );
      const ownerReadback = await readCanonicalResearchOwnerStateForJournalBinding({
        authenticatedAccountId: ownerId,
        nowMs: observedAt.getTime(),
      });
      const bound = bindCanonicalResearchToUnifiedJournal(journal, ownerReadback, observedAt.getTime());
      return response.json(analysisEnvelope({
        ok: true,
        result: {
          ...bound,
          liveAccountHistory: historySummary(liveHistory),
          safety: {
            ...bound.safety,
            privateBrokerRequests: liveHistory.privateProviderRequests,
          },
        },
      }));
    } catch (cause) {
      return handleError(response, cause, 'UNIFIED_JOURNAL_FAILED', '통합 매매일지를 처리하지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/unified-ledger/toss-contract-preview', (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown> = {}) => analysisEnvelope({
      tossLiveReadIntegration: TOSS_LIVE_READ_INTEGRATION,
      safety: JOURNAL_COST_SAFETY,
      ...payload,
    });
    if (!allowTossContractPreview) {
      return response.status(503).json(envelope({ ok: false, code: TOSS_LIVE_READ_INTEGRATION, message: 'Toss API 유료 여부 확인 전에는 실계좌 주문 조회를 실행하지 않습니다.' }));
    }
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: 'Toss 계약 검증 요청이 너무 큽니다.' }));
    try {
      const body = isObject(request.body) ? request.body : {};
      if (containsForbiddenContractField(body)) throw new PaperJournalError('SENSITIVE_TOSS_INPUT_FORBIDDEN', 'Secret, 전체 계좌번호 또는 사용자 식별자는 계약 검증에 포함할 수 없습니다.');
      if (!Array.isArray(body.orders) || body.orders.length > 100) throw new PaperJournalError('INVALID_TOSS_CONTRACT_FIXTURES', 'Toss 계약 fixture는 최대 100건까지 허용됩니다.');
      const alias = queryText(body.accountAlias, 80);
      if (!alias) throw new PaperJournalError('TOSS_ACCOUNT_ALIAS_REQUIRED', '실계좌번호가 아닌 테스트용 계좌 별칭이 필요합니다.');
      const records = body.orders.map((order) => normalizeTossOrderContract(order as TossOrderContract, alias, now().toISOString()));
      return response.json(envelope({ ok: true, records, privateBrokerRequests: 0, stored: false }));
    } catch (cause) {
      return handleError(response, cause, 'TOSS_CONTRACT_PREVIEW_FAILED', 'Toss 주문 계약 fixture를 검증하지 못했습니다.', envelope);
    }
  });

  router.post('/paper-journal/review-dataset', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(analysisEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '복기 데이터 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body) throw new PaperJournalError('CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.');
      const payloads = filterPeriod(
        await repositoryFactory(request).listJournalPayloads(request.member?.id ?? ''),
        body.periodStart,
        body.periodEnd,
      );
      const analytics = calculatePaperJournalAnalytics(payloads);
      return response.json(analysisEnvelope({ ok: true, result: createTradingReviewDataset(payloads, analytics) }));
    } catch (cause) {
      return handleError(response, cause, 'REVIEW_DATASET_FAILED', '복기용 구조화 데이터를 만들지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/ai-review/preview', async (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown>) => ({ mode: 'ai-review-preview', externalAiCalled: false, providerCall: { attempted: false, completed: false, reused: false }, rateLimitScope: 'process', orderSubmitted: false, exchangeRequestSent: false, ...payload });
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 크기가 제한을 초과했습니다.' } }));
    try {
      const userId = requireAiReview(request); const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body) throw new PaperJournalError('CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.');
      const dataset = buildAiReviewDataset(await repositoryFactory(request).listJournalPayloads(userId), body.periodStart, body.periodEnd, now());
      return response.json(envelope({ ok: true, result: previewAiReview(dataset) }));
    } catch (cause) { return handleAiError(response, cause, envelope); }
  });

  router.post('/paper-journal/ai-review/generate', async (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown>) => ({ mode: 'ai-review-only', externalAiCalled: false, providerCall: { attempted: false, completed: false, reused: false }, rateLimitScope: 'process', orderSubmitted: false, exchangeRequestSent: false, ...payload });
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 크기가 제한을 초과했습니다.' } }));
    try {
      const userId = requireAiReview(request); const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body || 'dataset' in body) throw new PaperJournalError('CLIENT_DATASET_FORBIDDEN', '분석 데이터는 서버에서 생성합니다.');
      const dataset = buildAiReviewDataset(await repositoryFactory(request).listJournalPayloads(userId), body.periodStart, body.periodEnd, now());
      const outcome = await generateTradingAiReview({ userId, consent: body.consent === true, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '', locale: typeof body.locale === 'string' ? body.locale.slice(0, 12) : 'ko-KR', reviewStyle: body.reviewStyle === 'detailed' ? 'detailed' : 'concise', dataset, provider: reviewProvider, now: now() });
      return response.json({ ...envelope({ ok: true, result: outcome.review }), externalAiCalled: outcome.providerCall.attempted, providerCall: outcome.providerCall, rateLimitScope: outcome.rateLimitScope });
    } catch (cause) { return handleAiError(response, cause, envelope); }
  });

  return router;
}

function handleAiError(response: Response, cause: unknown, envelope: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const error = cause instanceof PaperJournalError ? cause : new PaperJournalError('AI_REVIEW_FAILED', 'AI 거래 복기를 처리하지 못했습니다.', 500);
  const providerCall: AiProviderCallState = error.providerCall ?? { attempted: false, completed: false, reused: false };
  return response.status(error.statusCode).json({ ...envelope({ ok: false, error: { code: error.code, message: error.message } }), externalAiCalled: providerCall.attempted, providerCall, rateLimitScope: 'process' });
}

function handleError(
  response: Response,
  cause: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  envelope: (payload?: Record<string, unknown>) => Record<string, unknown>,
) {
  if (cause instanceof PaperJournalError) {
    return response.status(cause.statusCode).json(envelope({ ok: false, code: cause.code, message: cause.message }));
  }
  return response.status(500).json(envelope({ ok: false, code: fallbackCode, message: fallbackMessage }));
}

export default createPaperJournalRouter();

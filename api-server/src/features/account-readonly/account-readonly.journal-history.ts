import { createHash } from 'node:crypto';
import {
  prepareBitgetHistoryPositions,
  prepareUpbitClosedOrders,
  prepareUpbitOrderByUuid,
  type BitgetCredentials,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from '../../services/trade-exchange-adapters.service';
import { decryptTradingCredentials } from '../../services/trade-credential-vault.service';
import type { TradeRange } from '../../services/unified-trade-journal.service';
import { AccountReadonlyError } from './account-readonly.errors';
import {
  createAccountReadonlyCredentialRepository,
  type AccountReadonlyCredentialRepository,
} from './account-readonly.repository';
import { accountReadFlags } from './account-readonly.route';
import { readKiwoomJournalHistory } from './account-readonly.kiwoom-journal-history';
import { KiwoomReadonlyProvider, type KiwoomReadonlyCredentials } from './providers/kiwoom-readonly.provider';

export type HistoryProvider = 'kiwoom' | 'upbit' | 'bitget';
type HttpHistoryProvider = 'upbit' | 'bitget';
type RepositoryFactory = (userId: string) => AccountReadonlyCredentialRepository;
type CredentialDecryptor = (payload: string) => Record<string, string>;

export type AccountJournalHistoryProviderStatus = {
  provider: HistoryProvider;
  configured: boolean | null;
  enabled: boolean;
  status: 'READY' | 'PARTIAL' | 'NOT_CONFIGURED' | 'DISABLED' | 'UNAVAILABLE';
  records: number;
  privateProviderRequests: number;
  truncated: boolean;
  effectiveDays?: number;
  rangeCapped?: boolean;
  errorCode: string | null;
};

export type AccountJournalHistoryResult = {
  payloads: Record<string, unknown>[];
  requestedRange: TradeRange;
  effectiveDays: number;
  rangeCapped: boolean;
  persisted: false;
  privateProviderRequests: number;
  providers: AccountJournalHistoryProviderStatus[];
  truncated: boolean;
  safety: {
    orderRequests: 0;
    cancelRequests: 0;
    amendRequests: 0;
    transferRequests: 0;
    withdrawalRequests: 0;
    credentialsReturned: false;
    liveTradingEnabled: false;
    autoTradingEnabled: false;
  };
};

export type AccountJournalHistoryOptions = {
  repositoryFactory?: RepositoryFactory;
  decryptCredentials?: CredentialDecryptor;
  fetchImpl?: typeof fetch;
  flags?: Partial<Record<HistoryProvider, boolean>>;
  providerTimeoutMs?: number;
  maxUpbitOrders?: number;
  maxBitgetPages?: number;
  maxKiwoomDays?: number;
  kiwoomProvider?: Pick<KiwoomReadonlyProvider, 'journalFillRows'>;
};

const DAY_MS = 86_400_000;
const UPBIT_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_UPBIT_ORDERS = 60;
const DEFAULT_MAX_BITGET_PAGES = 5;
const DEFAULT_MAX_KIWOOM_DAYS = 7;

const TARGETS: Record<HttpHistoryProvider, { origin: string; paths: ReadonlySet<string> }> = {
  upbit: {
    origin: 'https://api.upbit.com',
    paths: new Set(['/v1/orders/closed', '/v1/order']),
  },
  bitget: {
    origin: 'https://api.bitget.com',
    paths: new Set(['/api/v2/mix/position/history-position']),
  },
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function isoFromMillis(value: unknown): string | null {
  const parsed = numeric(value);
  if (parsed == null || parsed < 0) return null;
  const date = new Date(parsed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoString(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function maskedVaultReference(provider: HistoryProvider, userId: string) {
  const digest = createHash('sha256').update(`${provider}:${userId}`).digest('hex').slice(0, 10);
  return `${provider.toUpperCase()}-****-${digest}`;
}

function historyDays(range: TradeRange) {
  if (range === 'TODAY') return { days: 1, capped: false };
  if (range === '7D') return { days: 7, capped: false };
  if (range === '30D') return { days: 30, capped: false };
  return { days: 30, capped: true };
}

function normalizedTimeout(value: number | undefined) {
  if (value == null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('ACCOUNT_JOURNAL_HISTORY_TIMEOUT_INVALID');
  return Math.min(60_000, Math.max(1_000, Math.trunc(value)));
}

async function upbitFailureName(response: Response) {
  try {
    const body: unknown = await response.clone().json();
    const root = objectRecord(body);
    const error = objectRecord(root?.error);
    return typeof error?.name === 'string' ? error.name : '';
  } catch {
    return '';
  }
}

async function classifyHttpFailure(provider: HttpHistoryProvider, response: Response) {
  if (response.status === 429 || (provider === 'upbit' && response.status === 418)) {
    return new AccountReadonlyError('RATE_LIMITED', true);
  }
  if (response.status >= 500) return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);
  if (provider === 'upbit') {
    const name = await upbitFailureName(response);
    if (response.status === 401) {
      if (name === 'no_authorization_ip') return new AccountReadonlyError('UPBIT_IP_NOT_ALLOWED');
      return new AccountReadonlyError('UPBIT_AUTH_FAILED');
    }
    if (response.status === 403) return new AccountReadonlyError('UPBIT_PERMISSION_DENIED');
    return new AccountReadonlyError('UPBIT_REQUEST_REJECTED');
  }
  if (response.status === 401) return new AccountReadonlyError('BITGET_AUTH_FAILED');
  if (response.status === 403) return new AccountReadonlyError('BITGET_PERMISSION_DENIED');
  return new AccountReadonlyError('BITGET_REQUEST_REJECTED');
}

async function executeGet(
  provider: HttpHistoryProvider,
  request: PreparedExchangeRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  counter: { value: number },
): Promise<unknown> {
  const target = TARGETS[provider];
  if (request.method !== 'GET' || request.body !== null || !target.paths.has(request.path)) {
    throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
  }
  const url = new URL(request.path, target.origin);
  if (request.query) url.search = request.query;
  if (url.origin !== target.origin || !target.paths.has(url.pathname)) {
    throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
  }

  counter.value += 1;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: request.headers,
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
    throw cause;
  }
  if (!response.ok) throw await classifyHttpFailure(provider, response);
  try {
    return await response.json();
  } catch {
    throw new AccountReadonlyError('PROVIDER_RESPONSE_INVALID');
  }
}

async function loadCredentials(
  userId: string,
  provider: HistoryProvider,
  repositoryFactory: RepositoryFactory,
  decryptCredentials: CredentialDecryptor,
) {
  const repository = repositoryFactory(userId);
  const row = await repository.get(userId, provider);
  if (!row?.configured) return { configured: false as const, credentials: null };
  if (!row.encryptedCredentials) throw new AccountReadonlyError('CREDENTIALS_UNAVAILABLE');
  try {
    return { configured: true as const, credentials: decryptCredentials(row.encryptedCredentials) };
  } catch {
    throw new AccountReadonlyError('CREDENTIALS_UNAVAILABLE');
  }
}

function requiredCredential(raw: Record<string, string>, key: string) {
  const value = String(raw[key] ?? '').trim();
  if (!value) throw new AccountReadonlyError('CREDENTIALS_UNAVAILABLE');
  return value;
}

function providerFailureCode(cause: unknown) {
  if (cause instanceof AccountReadonlyError) return cause.code;
  return 'PROVIDER_UNAVAILABLE';
}

function upbitQuoteCurrency(market: string): 'KRW' | 'USDT' | null {
  const quote = market.split('-')[0]?.toUpperCase();
  return quote === 'KRW' || quote === 'USDT' ? quote : null;
}

function upbitBaseSymbol(market: string) {
  const parts = market.toUpperCase().split('-');
  return parts.length === 2 && parts[1] ? parts[1] : null;
}

function buildUpbitPayload(detail: Record<string, unknown>, userId: string, observedAt: string) {
  const uuid = requiredText(detail.uuid);
  const market = requiredText(detail.market);
  const side = detail.side === 'bid' ? 'BUY' : detail.side === 'ask' ? 'SELL' : null;
  const state = detail.state === 'done' ? 'FILLED' : detail.state === 'cancel' ? 'CANCELED' : null;
  const orderedAt = isoString(detail.created_at);
  const executedVolume = positive(detail.executed_volume);
  const remainingVolume = nonNegative(detail.remaining_volume);
  const originalVolume = positive(detail.volume);
  const paidFee = nonNegative(detail.paid_fee);
  const trades = Array.isArray(detail.trades) ? detail.trades : [];
  if (!uuid || !market || !side || !state || !orderedAt || executedVolume == null || trades.length === 0) return null;

  let tradeVolume = 0;
  let tradeFunds = 0;
  let filledAt: string | null = null;
  for (const raw of trades) {
    const trade = objectRecord(raw);
    if (!trade) return null;
    const volume = positive(trade.volume);
    const price = positive(trade.price);
    const at = isoString(trade.created_at);
    if (volume == null || price == null || !at) return null;
    tradeVolume += volume;
    tradeFunds += nonNegative(trade.funds) ?? price * volume;
    if (filledAt == null || Date.parse(at) > Date.parse(filledAt)) filledAt = at;
  }
  const tolerance = Math.max(1e-10, executedVolume * 1e-8);
  if (Math.abs(tradeVolume - executedVolume) > tolerance || !filledAt) return null;

  const currency = upbitQuoteCurrency(market);
  const symbol = upbitBaseSymbol(market);
  if (!currency || !symbol) return null;
  const quantity = originalVolume ?? executedVolume + (remainingVolume ?? 0);
  if (!(quantity > 0) || executedVolume > quantity + tolerance) return null;

  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'UPBIT_API',
    broker: 'UPBIT',
    accountIdMasked: maskedVaultReference('upbit', userId),
    market: 'CRYPTO_SPOT',
    symbol,
    side,
    positionSide: 'LONG',
    positionEffect: side === 'BUY' ? 'OPEN' : 'CLOSE',
    clientOrderId: requiredText(detail.identifier),
    brokerOrderId: uuid,
    fillId: null,
    orderedAt,
    filledAt,
    observedAt,
    quantity,
    filledQuantity: executedVolume,
    remainingQuantity: Math.max(0, quantity - executedVolume),
    averageFillPrice: tradeFunds / tradeVolume,
    fees: paidFee,
    tax: null,
    currency,
    status: state,
    strategy: null,
    timeframe: null,
    stopLossPrice: null,
    targetPrice: null,
    ruleViolation: false,
    warnings: [
      'UPBIT_CLOSED_ORDER_AGGREGATED_FROM_DETAIL_TRADES',
      'UPBIT_TAX_EVIDENCE_NOT_AVAILABLE',
      'REAL_ACCOUNT_HISTORY_NOT_PERSISTED',
    ],
  } as Record<string, unknown>;
}

async function readUpbit(
  raw: Record<string, string>,
  userId: string,
  startMs: number,
  endMs: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  counter: { value: number },
  maxOrders: number,
) {
  const credentials: UpbitCredentials = {
    accessKey: requiredCredential(raw, 'accessKey'),
    secretKey: requiredCredential(raw, 'secretKey'),
  };
  const byUuid = new Map<string, Record<string, unknown>>();
  let truncated = false;

  for (let windowStart = startMs; windowStart < endMs; windowStart += UPBIT_WINDOW_MS) {
    const windowEnd = Math.min(endMs, windowStart + UPBIT_WINDOW_MS - 1);
    const value = await executeGet(
      'upbit',
      prepareUpbitClosedOrders(credentials, windowStart, windowEnd),
      fetchImpl,
      signal,
      counter,
    );
    if (!Array.isArray(value)) throw new AccountReadonlyError('UPBIT_HISTORY_RESPONSE_INVALID');
    if (value.length >= 1000) truncated = true;
    for (const rawOrder of value) {
      const order = objectRecord(rawOrder);
      const uuid = requiredText(order?.uuid);
      if (order && uuid && positive(order.executed_volume) != null) byUuid.set(uuid, order);
    }
  }

  const candidates = [...byUuid.values()]
    .sort((left, right) => Date.parse(String(left.created_at ?? 0)) - Date.parse(String(right.created_at ?? 0)));
  if (candidates.length > maxOrders) truncated = true;
  const selected = candidates.slice(-maxOrders);
  const payloads: Record<string, unknown>[] = [];
  let normalizationFailures = 0;

  for (let index = 0; index < selected.length; index += 3) {
    const batch = selected.slice(index, index + 3);
    const results = await Promise.allSettled(batch.map(async (order) => {
      const uuid = requiredText(order.uuid);
      if (!uuid) return null;
      const detail = await executeGet(
        'upbit',
        prepareUpbitOrderByUuid(credentials, uuid),
        fetchImpl,
        signal,
        counter,
      );
      const record = objectRecord(detail);
      return record ? buildUpbitPayload(record, userId, new Date(endMs).toISOString()) : null;
    }));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) payloads.push(result.value);
      else normalizationFailures += 1;
    }
  }

  if (normalizationFailures > 0) truncated = true;
  return { payloads, truncated, normalizationFailures };
}

function signedFee(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed == null ? null : Math.abs(parsed);
}

function buildBitgetPayload(row: Record<string, unknown>, userId: string) {
  const positionId = requiredText(row.positionId);
  const symbol = requiredText(row.symbol)?.toUpperCase();
  const holdSide = row.holdSide === 'long' ? 'LONG' : row.holdSide === 'short' ? 'SHORT' : null;
  const entryPrice = positive(row.openAvgPrice);
  const exitPrice = positive(row.closeAvgPrice);
  const openedAt = isoFromMillis(row.ctime);
  const closedAt = isoFromMillis(row.utime);
  const opened = positive(row.openTotalPos);
  const closed = positive(row.closeTotalPos);
  const pnl = numeric(row.pnl);
  const netProfit = numeric(row.netProfit);
  const funding = numeric(row.totalFunding);
  const openFee = signedFee(row.openFee);
  const closeFee = signedFee(row.closeFee);
  if (!positionId || !symbol || !holdSide || entryPrice == null || exitPrice == null || !openedAt || !closedAt
    || opened == null || closed == null || pnl == null) return null;
  const tolerance = Math.max(1e-10, opened * 1e-8);
  if (Math.abs(opened - closed) > tolerance) return null;

  return {
    recordType: 'provider_trade_cycle',
    tradeId: `BITGET:${positionId}`,
    source: 'BITGET_API',
    broker: 'BITGET',
    accountIdMasked: maskedVaultReference('bitget', userId),
    market: 'CRYPTO_FUTURES',
    symbol,
    positionSide: holdSide,
    currency: 'USDT',
    status: 'closed',
    filledAt: openedAt,
    closedAt,
    entryPrice,
    exitPrice,
    initialQuantity: opened,
    closedQuantity: closed,
    remainingQuantity: 0,
    grossPnl: pnl,
    fees: openFee != null && closeFee != null ? openFee + closeFee : null,
    entryFee: openFee,
    exitFee: closeFee,
    tax: null,
    providerReportedNetPnl: netProfit,
    providerReportedNetPnlBasis: 'BITGET_HISTORY_POSITION',
    providerFunding: funding,
    warnings: [
      'BITGET_PROVIDER_REPORTED_NET_PNL_NOT_USED_FOR_ANALYTICS',
      'BITGET_FUNDING_RETAINED_AS_PROVENANCE_ONLY',
      'REAL_ACCOUNT_HISTORY_NOT_PERSISTED',
    ],
  } as Record<string, unknown>;
}

async function readBitget(
  raw: Record<string, string>,
  userId: string,
  startMs: number,
  endMs: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  counter: { value: number },
  maxPages: number,
) {
  const credentials: BitgetCredentials = {
    apiKey: requiredCredential(raw, 'apiKey'),
    secretKey: requiredCredential(raw, 'secretKey'),
    passphrase: requiredCredential(raw, 'passphrase'),
  };
  const rows = new Map<string, Record<string, unknown>>();
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await executeGet(
      'bitget',
      prepareBitgetHistoryPositions(credentials, startMs, endMs, cursor),
      fetchImpl,
      signal,
      counter,
    );
    const envelope = objectRecord(response);
    const code = envelope?.code == null ? '' : String(envelope.code);
    if (!envelope || code !== '00000') throw new AccountReadonlyError('BITGET_HISTORY_RESPONSE_INVALID');
    const data = objectRecord(envelope.data);
    if (!data || !Array.isArray(data.list)) throw new AccountReadonlyError('BITGET_HISTORY_RESPONSE_INVALID');
    for (const rawRow of data.list) {
      const row = objectRecord(rawRow);
      const id = requiredText(row?.positionId);
      if (row && id) rows.set(id, row);
    }
    const endId = requiredText(data.endId);
    if (data.list.length < 100 || !endId) {
      cursor = undefined;
      break;
    }
    cursor = endId;
    if (page === maxPages - 1) truncated = true;
  }

  const payloads: Record<string, unknown>[] = [];
  let normalizationFailures = 0;
  for (const row of rows.values()) {
    const payload = buildBitgetPayload(row, userId);
    if (payload) payloads.push(payload);
    else normalizationFailures += 1;
  }
  if (normalizationFailures > 0) truncated = true;
  return { payloads, truncated, normalizationFailures };
}

export function createAccountJournalHistoryReader(options: AccountJournalHistoryOptions = {}) {
  const repositoryFactory = options.repositoryFactory ?? createAccountReadonlyCredentialRepository;
  const decryptCredentials = options.decryptCredentials ?? decryptTradingCredentials;
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultFlags = accountReadFlags();
  const flags = {
    kiwoom: options.flags?.kiwoom ?? defaultFlags.kiwoom,
    upbit: options.flags?.upbit ?? defaultFlags.upbit,
    bitget: options.flags?.bitget ?? defaultFlags.bitget,
  };
  const timeoutMs = normalizedTimeout(options.providerTimeoutMs);
  const maxUpbitOrders = Math.max(1, Math.min(200, Math.trunc(options.maxUpbitOrders ?? DEFAULT_MAX_UPBIT_ORDERS)));
  const maxBitgetPages = Math.max(1, Math.min(10, Math.trunc(options.maxBitgetPages ?? DEFAULT_MAX_BITGET_PAGES)));
  const maxKiwoomDays = Math.max(1, Math.min(7, Math.trunc(options.maxKiwoomDays ?? DEFAULT_MAX_KIWOOM_DAYS)));
  const kiwoomProvider = options.kiwoomProvider ?? new KiwoomReadonlyProvider(fetchImpl);

  return async function readAccountJournalHistory(input: {
    userId: string;
    range: TradeRange;
    providers: readonly HistoryProvider[];
    now?: Date;
  }): Promise<AccountJournalHistoryResult> {
    const now = input.now ?? new Date();
    const userId = input.userId.trim();
    const { days, capped } = historyDays(input.range);
    const endMs = now.getTime();
    const startMs = endMs - days * DAY_MS;
    const payloads: Record<string, unknown>[] = [];
    const providers: AccountJournalHistoryProviderStatus[] = [];
    let privateProviderRequests = 0;
    let anyTruncated = capped;

    for (const provider of [...new Set(input.providers)]) {
      const counter = { value: 0 };
      const providerEffectiveDays = provider === 'kiwoom' ? Math.min(days, maxKiwoomDays) : days;
      const providerRangeCapped = provider === 'kiwoom' ? days > providerEffectiveDays : capped;
      if (!flags[provider]) {
        providers.push({
          provider, configured: null, enabled: false, status: 'DISABLED', records: 0,
          privateProviderRequests: 0, truncated: false, effectiveDays: providerEffectiveDays,
          rangeCapped: providerRangeCapped, errorCode: 'ACCOUNT_READ_DISABLED',
        });
        continue;
      }

      try {
        const loaded = await loadCredentials(userId, provider, repositoryFactory, decryptCredentials);
        if (!loaded.configured || !loaded.credentials) {
          providers.push({
            provider, configured: false, enabled: true, status: 'NOT_CONFIGURED', records: 0,
            privateProviderRequests: 0, truncated: false, effectiveDays: providerEffectiveDays,
            rangeCapped: providerRangeCapped, errorCode: null,
          });
          continue;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('PROVIDER_TIMEOUT')), timeoutMs);
        try {
          const result = provider === 'upbit'
            ? await readUpbit(loaded.credentials, userId, startMs, endMs, fetchImpl, controller.signal, counter, maxUpbitOrders)
            : provider === 'bitget'
              ? await readBitget(loaded.credentials, userId, startMs, endMs, fetchImpl, controller.signal, counter, maxBitgetPages)
              : await readKiwoomJournalHistory({
                  provider: kiwoomProvider,
                  credentials: {
                    appKey: requiredCredential(loaded.credentials, 'appKey'),
                    appSecret: requiredCredential(loaded.credentials, 'appSecret'),
                  } satisfies KiwoomReadonlyCredentials,
                  userId,
                  requestedDays: days,
                  endMs,
                  signal: controller.signal,
                  maxDays: maxKiwoomDays,
                });
          if (provider === 'kiwoom') counter.value = result.privateProviderRequests;
          payloads.push(...result.payloads);
          anyTruncated ||= result.truncated;
          providers.push({
            provider,
            configured: true,
            enabled: true,
            status: result.truncated ? 'PARTIAL' : 'READY',
            records: result.payloads.length,
            privateProviderRequests: counter.value,
            truncated: result.truncated,
            effectiveDays: provider === 'kiwoom' ? result.effectiveDays : providerEffectiveDays,
            rangeCapped: provider === 'kiwoom' ? result.rangeCapped : providerRangeCapped,
            errorCode: result.normalizationFailures > 0
              ? 'HISTORY_NORMALIZATION_PARTIAL'
              : provider === 'kiwoom' && result.rangeCapped
                ? 'KIWOOM_HISTORY_CAPPED_7D'
                : null,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (cause) {
        providers.push({
          provider, configured: true, enabled: true, status: 'UNAVAILABLE', records: 0,
          privateProviderRequests: counter.value, truncated: false, effectiveDays: providerEffectiveDays,
          rangeCapped: providerRangeCapped, errorCode: providerFailureCode(cause),
        });
      }
      privateProviderRequests += counter.value;
    }

    return {
      payloads,
      requestedRange: input.range,
      effectiveDays: days,
      rangeCapped: capped,
      persisted: false,
      privateProviderRequests,
      providers,
      truncated: anyTruncated,
      safety: {
        orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
        credentialsReturned: false, liveTradingEnabled: false, autoTradingEnabled: false,
      },
    };
  };
}

export const readAccountJournalHistory = createAccountJournalHistoryReader();

import {
  prepareBitgetFillHistory,
  prepareBitgetOrderHistory,
  prepareKiwoomAccountNumber,
  prepareKiwoomToken,
  prepareTossAccounts,
  prepareTossOrderHistory,
  prepareTossToken,
  prepareUpbitClosedOrders,
  prepareUpbitOrderQueryByUuid,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type TossCredentials,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import {
  normalizeBitgetJournalFills,
  normalizeUpbitJournalOrders,
  type BrokerJournalNormalizationIssue,
} from './broker-journal-normalizer.service';
import {
  assertKiwoomJournalReadRequest,
  prepareKiwoomDomesticFillHistory,
  prepareKiwoomUsDailyFillHistory,
} from './kiwoom-journal-read.service';
import {
  normalizeKiwoomDomesticFills,
  normalizeKiwoomUsDailyFills,
} from './kiwoom-journal-normalizer.service';
import {
  normalizeTossOrderContract,
  type TossOrderContract,
  type UnifiedTradeOrder,
} from './unified-trade-journal.service';

const TOSS_BASE = 'https://openapi.tossinvest.com';
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const DAY_MS = 86_400_000;

type RecordValue = Record<string, unknown>;

export type BrokerJournalImportCredentials = {
  toss?: { clientId: string; clientSecret: string } | null;
  upbit?: UpbitCredentials | null;
  bitget?: BitgetCredentials | null;
  kiwoom?: { credentials: KiwoomCredentials; baseUrl: string } | null;
  /** @deprecated compatibility flag until every caller supplies the user-owned vault credentials. */
  kiwoomConfigured?: boolean;
};

export type BrokerJournalReadExecutor = (
  provider: 'TOSS' | 'UPBIT' | 'BITGET',
  baseUrl: string,
  request: PreparedExchangeRequest,
) => Promise<unknown>;

export type KiwoomJournalReadExecutor = (
  baseUrl: string,
  request: PreparedExchangeRequest,
) => Promise<unknown>;

type ProviderImportStatus = {
  configured: boolean;
  importedRecords: number;
  authenticationRequests: number;
  privateReadRequests: number;
  issues: BrokerJournalNormalizationIssue[];
  error: string | null;
};

export type BrokerJournalImportResult = {
  records: UnifiedTradeOrder[];
  providers: {
    toss: ProviderImportStatus;
    upbit: ProviderImportStatus;
    bitget: ProviderImportStatus;
    kiwoom: ProviderImportStatus;
  };
  safety: {
    actualOrderRequests: 0;
    cancelRequests: 0;
    amendRequests: 0;
    transferRequests: 0;
    withdrawalRequests: 0;
    privateMutationRequests: 0;
  };
  importedAt: string;
};

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/401|403|AUTH|TOKEN|CREDENTIAL/i.test(message)) return 'BROKER_JOURNAL_AUTH_FAILED';
  if (/429|RATE/i.test(message)) return 'BROKER_JOURNAL_RATE_LIMITED';
  if (/AbortError|TIMEOUT/i.test(message)) return 'BROKER_JOURNAL_TIMEOUT';
  return 'BROKER_JOURNAL_READ_FAILED';
}

function emptyStatus(configured: boolean): ProviderImportStatus {
  return { configured, importedRecords: 0, authenticationRequests: 0, privateReadRequests: 0, issues: [], error: null };
}

export function assertBrokerJournalReadRequest(provider: 'TOSS' | 'UPBIT' | 'BITGET', request: PreparedExchangeRequest) {
  const tossAuth = provider === 'TOSS' && request.method === 'POST' && request.path === '/oauth2/token';
  const read = request.method === 'GET' && request.body === null;
  if (!tossAuth && !read) throw new Error('BROKER_JOURNAL_MUTATION_FORBIDDEN');
  if (/(?:place|cancel|modify|withdraw|transfer|deposit)/i.test(request.path)) throw new Error('BROKER_JOURNAL_MUTATION_FORBIDDEN');
}

function kstDate(value: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

async function importToss(
  credentials: BrokerJournalImportCredentials['toss'],
  execute: BrokerJournalReadExecutor,
  now: Date,
) {
  const status = emptyStatus(Boolean(credentials?.clientId && credentials?.clientSecret));
  if (!status.configured || !credentials) return { records: [] as UnifiedTradeOrder[], status };
  try {
    const tokenRequest = prepareTossToken(credentials);
    assertBrokerJournalReadRequest('TOSS', tokenRequest);
    status.authenticationRequests += 1;
    const tokenPayload = record(await execute('TOSS', TOSS_BASE, tokenRequest));
    const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token.trim() : '';
    if (!accessToken) throw new Error('TOSS_TOKEN_FAILED');
    const authorized = { ...credentials, accessToken } satisfies TossCredentials;
    const accountsRequest = prepareTossAccounts(authorized);
    assertBrokerJournalReadRequest('TOSS', accountsRequest);
    status.privateReadRequests += 1;
    const accountsPayload = record(await execute('TOSS', TOSS_BASE, accountsRequest));
    const accounts = rows(accountsPayload.result).slice(0, 10);
    const from = new Date(now.getTime() - 30 * DAY_MS);
    const records: UnifiedTradeOrder[] = [];
    for (const account of accounts) {
      const accountSeq = String(account.accountSeq ?? '').trim();
      if (!accountSeq) {
        status.issues.push({ provider: 'TOSS', code: 'TOSS_ACCOUNT_REFERENCE_INVALID', reference: null });
        continue;
      }
      const request = prepareTossOrderHistory(authorized, accountSeq, {
        status: 'CLOSED', from: kstDate(from), to: kstDate(now), limit: 100,
      });
      assertBrokerJournalReadRequest('TOSS', request);
      status.privateReadRequests += 1;
      const payload = record(await execute('TOSS', TOSS_BASE, request));
      const orders = rows(record(payload.result).orders);
      for (const order of orders) {
        try {
          records.push(normalizeTossOrderContract(order as TossOrderContract, accountSeq, now.toISOString()));
        } catch {
          status.issues.push({ provider: 'TOSS', code: 'TOSS_ORDER_CONTRACT_INVALID', reference: typeof order.orderId === 'string' ? order.orderId : null });
        }
      }
    }
    status.importedRecords = records.length;
    return { records, status };
  } catch (error) {
    status.error = safeError(error);
    return { records: [] as UnifiedTradeOrder[], status };
  }
}

async function importUpbit(credentials: UpbitCredentials | null | undefined, execute: BrokerJournalReadExecutor, now: Date) {
  const status = emptyStatus(Boolean(credentials?.accessKey && credentials?.secretKey));
  if (!status.configured || !credentials) return { records: [] as UnifiedTradeOrder[], status };
  try {
    const startTimeMs = now.getTime() - 7 * DAY_MS;
    const request = prepareUpbitClosedOrders(credentials, { startTimeMs, endTimeMs: now.getTime(), limit: 20, orderBy: 'asc' });
    assertBrokerJournalReadRequest('UPBIT', request);
    status.privateReadRequests += 1;
    const listed = rows(await execute('UPBIT', UPBIT_BASE, request));
    const detailed: RecordValue[] = [];
    for (const order of listed) {
      if ((Number(order.executed_volume) || 0) <= 0) continue;
      if (Array.isArray(order.trades) && order.trades.length > 0) {
        detailed.push(order);
        continue;
      }
      const uuid = typeof order.uuid === 'string' ? order.uuid.trim() : '';
      if (!uuid) continue;
      const detailRequest = prepareUpbitOrderQueryByUuid(credentials, uuid);
      assertBrokerJournalReadRequest('UPBIT', detailRequest);
      status.privateReadRequests += 1;
      detailed.push(record(await execute('UPBIT', UPBIT_BASE, detailRequest)));
    }
    const normalized = normalizeUpbitJournalOrders(detailed, credentials.accessKey, now.toISOString());
    status.importedRecords = normalized.records.length;
    status.issues.push(...normalized.issues);
    return { records: normalized.records, status };
  } catch (error) {
    status.error = safeError(error);
    return { records: [] as UnifiedTradeOrder[], status };
  }
}

async function importBitget(credentials: BitgetCredentials | null | undefined, execute: BrokerJournalReadExecutor, now: Date) {
  const status = emptyStatus(Boolean(credentials?.apiKey && credentials?.secretKey && credentials?.passphrase));
  if (!status.configured || !credentials) return { records: [] as UnifiedTradeOrder[], status };
  try {
    const startTimeMs = now.getTime() - 7 * DAY_MS;
    const request = prepareBitgetOrderHistory(credentials, { startTimeMs, endTimeMs: now.getTime(), limit: 20 });
    assertBrokerJournalReadRequest('BITGET', request);
    status.privateReadRequests += 1;
    const ordersPayload = record(await execute('BITGET', BITGET_BASE, request));
    const orders = rows(record(ordersPayload.data).entrustedList);
    const fillList: RecordValue[] = [];
    for (const order of orders) {
      const orderId = typeof order.orderId === 'string' ? order.orderId.trim() : '';
      if (!orderId || (Number(order.baseVolume) || 0) <= 0) continue;
      const fillRequest = prepareBitgetFillHistory(credentials, { orderId, startTimeMs, endTimeMs: now.getTime(), limit: 100 });
      assertBrokerJournalReadRequest('BITGET', fillRequest);
      status.privateReadRequests += 1;
      const payload = record(await execute('BITGET', BITGET_BASE, fillRequest));
      fillList.push(...rows(record(payload.data).fillList));
    }
    const normalized = normalizeBitgetJournalFills(ordersPayload, { data: { fillList } }, credentials.apiKey, now.toISOString());
    status.importedRecords = normalized.records.length;
    status.issues.push(...normalized.issues);
    return { records: normalized.records, status };
  } catch (error) {
    status.error = safeError(error);
    return { records: [] as UnifiedTradeOrder[], status };
  }
}

async function importKiwoom(
  connection: BrokerJournalImportCredentials['kiwoom'],
  execute: KiwoomJournalReadExecutor | undefined,
  now: Date,
) {
  const credentials = connection?.credentials;
  const configured = Boolean(connection?.baseUrl?.trim() && credentials?.appKey && credentials?.secretKey);
  const status = emptyStatus(configured);
  if (!configured || !connection || !credentials) return { records: [] as UnifiedTradeOrder[], status };
  if (!execute) {
    status.error = 'KIWOOM_JOURNAL_READ_EXECUTOR_REQUIRED';
    return { records: [] as UnifiedTradeOrder[], status };
  }

  try {
    const tokenRequest = prepareKiwoomToken(credentials);
    if (tokenRequest.method !== 'POST' || tokenRequest.path !== '/oauth2/token') throw new Error('KIWOOM_JOURNAL_AUTH_CONTRACT_INVALID');
    status.authenticationRequests += 1;
    const tokenPayload = record(await execute(connection.baseUrl, tokenRequest));
    const accessToken = typeof tokenPayload.token === 'string' ? tokenPayload.token.trim() : '';
    const tokenCode = tokenPayload.return_code == null || tokenPayload.return_code === '' ? 0 : Number(tokenPayload.return_code);
    if (!accessToken || !Number.isFinite(tokenCode) || tokenCode !== 0) throw new Error('KIWOOM_TOKEN_FAILED');
    const authorized = { ...credentials, accessToken } satisfies KiwoomCredentials;

    const accountRequest = prepareKiwoomAccountNumber(authorized);
    assertKiwoomJournalReadRequest(accountRequest);
    status.privateReadRequests += 1;
    const accountPayload = record(await execute(connection.baseUrl, accountRequest));
    const accountReference = typeof accountPayload.acctNo === 'string' && accountPayload.acctNo.trim()
      ? accountPayload.acctNo.trim()
      : 'ACCOUNT_UNAVAILABLE';

    const domesticRequest = prepareKiwoomDomesticFillHistory(authorized);
    assertKiwoomJournalReadRequest(domesticRequest);
    status.privateReadRequests += 1;
    const domesticPayload = await execute(connection.baseUrl, domesticRequest);
    const domestic = normalizeKiwoomDomesticFills(domesticPayload, accountReference, now, now.toISOString());

    const usPayloads = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const queryDate = new Date(now.getTime() - index * DAY_MS);
      const request = prepareKiwoomUsDailyFillHistory(authorized, queryDate);
      assertKiwoomJournalReadRequest(request);
      status.privateReadRequests += 1;
      return { queryDate, payload: await execute(connection.baseUrl, request) };
    }));
    const usRecords: UnifiedTradeOrder[] = [];
    const usIssues: BrokerJournalNormalizationIssue[] = [];
    for (const item of usPayloads) {
      const normalized = normalizeKiwoomUsDailyFills(item.payload, accountReference, item.queryDate, now.toISOString());
      usRecords.push(...normalized.records);
      usIssues.push(...normalized.issues);
    }

    const records = [...domestic.records, ...usRecords];
    status.importedRecords = records.length;
    status.issues.push(...domestic.issues, ...usIssues);
    return { records, status };
  } catch (error) {
    status.error = safeError(error);
    return { records: [] as UnifiedTradeOrder[], status };
  }
}

export async function importBrokerJournal(
  credentials: BrokerJournalImportCredentials,
  execute: BrokerJournalReadExecutor,
  now = new Date(),
  executeKiwoom?: KiwoomJournalReadExecutor,
): Promise<BrokerJournalImportResult> {
  const [toss, upbit, bitget, kiwoomRead] = await Promise.all([
    importToss(credentials.toss, execute, now),
    importUpbit(credentials.upbit, execute, now),
    importBitget(credentials.bitget, execute, now),
    importKiwoom(credentials.kiwoom, executeKiwoom, now),
  ]);
  const kiwoom = kiwoomRead.status;
  if (!credentials.kiwoom && credentials.kiwoomConfigured === true) {
    kiwoom.configured = true;
    kiwoom.error = 'KIWOOM_JOURNAL_HISTORY_OFFICIAL_CONTRACT_REQUIRED';
    kiwoom.issues.push({ provider: 'KIWOOM', code: kiwoom.error, reference: null });
  }
  return {
    records: [...toss.records, ...kiwoomRead.records, ...upbit.records, ...bitget.records],
    providers: { toss: toss.status, upbit: upbit.status, bitget: bitget.status, kiwoom },
    safety: {
      actualOrderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      privateMutationRequests: 0,
    },
    importedAt: now.toISOString(),
  };
}

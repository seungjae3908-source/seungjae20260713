import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  prepareBitgetAccount,
  prepareBitgetPositions,
  prepareKiwoomAccountNumber,
  prepareKiwoomDomesticAccount,
  prepareKiwoomToken,
  prepareKiwoomUsAccount,
  prepareTossAccounts,
  prepareTossHoldings,
  prepareTossToken,
  prepareUpbitAccounts,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type TossCredentials,
  type UpbitCredentials,
} from '../services/trade-exchange-adapters.service';
import {
  validateKiwoomReadResponse,
  type KiwoomReadApiId,
} from '../services/kiwoom-readonly-response.service';
import { createSupabaseTradingRepository } from '../services/trade-automation.repository';
import { decryptTradingCredentials } from '../services/trade-credential-vault.service';
import type { BrokerConnectionProvider } from '../services/trade-automation.types';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const TOSS_BASE = 'https://openapi.tossinvest.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const KIWOOM_REAL_BASE = process.env.KIWOOM_BASE_URL?.trim() || 'http://158.247.235.32:3000/kiwoom';
const KIWOOM_MOCK_BASE = 'https://mockapi.kiwoom.com';
const REQUEST_TIMEOUT_MS = 12_000;
const KIWOOM_READ_API_IDS = new Set<KiwoomReadApiId>(['ka00001', 'kt00018', 'ust21070']);

type JsonRecord = Record<string, unknown>;
type CredentialSourceName = 'vault' | 'environment' | 'none';
type CredentialState = {
  source: CredentialSourceName;
  credentials: JsonRecord | null;
  vaultError: string | null;
};

type CredentialStates = Record<BrokerConnectionProvider, CredentialState>;

function finite(value: unknown): number | null {
  const normalized = typeof value === 'string' ? value.replace(/[,+%₩$]/g, '').trim() : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function maskAccount(value: unknown): string | null {
  const account = stringValue(value).replace(/\s+/g, '');
  if (!account) return null;
  if (account.length <= 4) return '*'.repeat(account.length);
  return `${account.slice(0, 2)}${'*'.repeat(Math.max(4, account.length - 4))}${account.slice(-2)}`;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'ACCOUNT_CONNECTION_FAILED';
  const message = error.message.trim();
  if (!message) return 'ACCOUNT_CONNECTION_FAILED';
  if (/NOT_CONFIGURED/i.test(message)) return message.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 120);
  if (/시간이 초과|AbortError|timeout/i.test(message)) return 'ACCOUNT_CONNECTION_TIMEOUT';
  if (/401|403|인증|token|authorization/i.test(message)) return 'ACCOUNT_AUTH_FAILED';
  if (/MASTER_KEY|CREDENTIAL_PAYLOAD|CREDENTIAL_STORAGE/i.test(message)) return 'ACCOUNT_CREDENTIAL_VAULT_UNAVAILABLE';
  return 'ACCOUNT_CONNECTION_FAILED';
}

async function fetchPrepared<T>(baseUrl: string, request: PreparedExchangeRequest, extraHeaders: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const query = request.query ? `?${request.query}` : '';
  try {
    const response = await fetch(`${baseUrl}${request.path}${query}`, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
        ...request.headers,
        ...extraHeaders,
      },
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPreparedReadOnly<T>(baseUrl: string, request: PreparedExchangeRequest): Promise<T> {
  if (request.method !== 'GET' || request.body !== null) {
    throw new Error('ACCOUNT_READONLY_REQUEST_REQUIRED');
  }
  return fetchPrepared<T>(baseUrl, request);
}

function kiwoomMode(): 'mock' | 'real' {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === 'mock' ? 'mock' : 'real';
}

function kiwoomBaseUrl(): string {
  return kiwoomMode() === 'mock' ? KIWOOM_MOCK_BASE : KIWOOM_REAL_BASE;
}

function kiwoomInfrastructureConfigured(): boolean {
  return kiwoomMode() === 'mock' || Boolean(process.env.KIWOOM_PROXY_KEY?.trim());
}

function kiwoomProxyHeaders(): Record<string, string> {
  if (kiwoomMode() === 'mock') return {};
  const proxyKey = process.env.KIWOOM_PROXY_KEY?.trim();
  if (!proxyKey) throw new Error('KIWOOM_PROXY_KEY_NOT_CONFIGURED');
  return { 'x-proxy-key': proxyKey };
}

function kiwoomReadApiId(value: unknown): KiwoomReadApiId | null {
  if (value === 'ka00001' || value === 'kt00018' || value === 'ust21070') return value;
  return null;
}

async function fetchPreparedKiwoom<T>(request: PreparedExchangeRequest): Promise<T> {
  const apiId = kiwoomReadApiId(request.headers['api-id']);
  const tokenRequest = request.method === 'POST' && request.path === '/oauth2/token';
  const accountRequest = request.method === 'POST'
    && (request.path === '/api/dostk/acnt' || request.path === '/api/us/acnt')
    && apiId !== null
    && KIWOOM_READ_API_IDS.has(apiId);
  if (!tokenRequest && !accountRequest) {
    throw new Error('ACCOUNT_READONLY_REQUEST_REQUIRED');
  }
  const payload = await fetchPrepared<unknown>(kiwoomBaseUrl(), request, kiwoomProxyHeaders());
  if (accountRequest && apiId) return validateKiwoomReadResponse(apiId, payload) as T;
  return payload as T;
}

async function credentialStates(req: AuthenticatedRequest): Promise<CredentialStates> {
  const exchanges: BrokerConnectionProvider[] = ['toss', 'kiwoom', 'upbit', 'bitget'];
  const fallback = Object.fromEntries(exchanges.map((exchange) => [exchange, {
    source: 'none', credentials: null, vaultError: null,
  } satisfies CredentialState])) as CredentialStates;

  if (!req.member?.id || !req.accessToken) return fallback;

  try {
    const repository = createSupabaseTradingRepository(req.accessToken, req.member.id);
    const rows = await Promise.all(exchanges.map(async (exchange) => {
      try {
        const connection = await repository.getConnection(req.member!.id, exchange);
        if (!connection?.configured || !connection.encryptedCredentials) return [exchange, fallback[exchange]] as const;
        const credentials = decryptTradingCredentials(connection.encryptedCredentials);
        return [exchange, { source: 'vault', credentials, vaultError: null } satisfies CredentialState] as const;
      } catch (error) {
        return [exchange, { ...fallback[exchange], vaultError: errorCode(error) }] as const;
      }
    }));
    return Object.fromEntries(rows) as CredentialStates;
  } catch (error) {
    const vaultError = errorCode(error);
    return Object.fromEntries(exchanges.map((exchange) => [exchange, { ...fallback[exchange], vaultError }])) as CredentialStates;
  }
}

function nestedRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function tossHolding(accountId: string, row: JsonRecord) {
  const marketValue = nestedRecord(row.marketValue);
  const profitLoss = nestedRecord(row.profitLoss);
  return {
    provider: 'toss',
    accountId,
    market: stringValue(row.marketCountry) === 'US' ? 'US_STOCK' : 'KR_STOCK',
    symbol: stringValue(row.symbol),
    name: stringValue(row.name),
    quantity: finite(row.quantity),
    averagePrice: finite(row.averagePurchasePrice),
    currentPrice: finite(row.lastPrice),
    evaluationAmount: finite(marketValue.amount),
    profitLoss: finite(profitLoss.amount),
    profitRate: finite(profitLoss.rate),
    currency: stringValue(row.currency),
  };
}

async function readToss(state: CredentialState) {
  const clientId = stringValue(state.credentials?.clientId);
  const clientSecret = stringValue(state.credentials?.clientSecret);
  if (!clientId || !clientSecret) {
    return {
      provider: 'toss', configured: false, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError,
      connectionState: 'WAITING_FOR_TOSS_API_ACCESS', accounts: [], holdings: [],
      error: 'TOSS_API_ACCESS_REQUIRED',
    };
  }
  try {
    const tokenPayload = await fetchPrepared<JsonRecord>(TOSS_BASE, prepareTossToken({ clientId, clientSecret }));
    const accessToken = stringValue(tokenPayload.access_token);
    if (!accessToken) throw new Error('TOSS_TOKEN_FAILED');
    const credentials = { clientId, clientSecret, accessToken } satisfies TossCredentials;
    const accountPayload = await fetchPreparedReadOnly<JsonRecord>(TOSS_BASE, prepareTossAccounts(credentials));
    const accountRows = Array.isArray(accountPayload.result)
      ? accountPayload.result.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const snapshots = await Promise.allSettled(accountRows.map(async (account) => {
      const accountId = String(account.accountSeq ?? '').trim();
      if (!accountId) throw new Error('TOSS_ACCOUNT_ID_MISSING');
      const payload = await fetchPreparedReadOnly<JsonRecord>(TOSS_BASE, prepareTossHoldings(credentials, accountId));
      const result = nestedRecord(payload.result);
      const items = Array.isArray(result.items)
        ? result.items.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
      return items.map((row) => tossHolding(accountId, row));
    }));
    const holdings = snapshots.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    return {
      provider: 'toss', configured: true, connected: true, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, connectionState: 'CONNECTED_READ_ONLY',
      accounts: accountRows.map((row) => ({
        accountId: String(row.accountSeq ?? '').trim(), accountMasked: maskAccount(row.accountNo),
        accountType: stringValue(row.accountType),
      })),
      holdingCount: holdings.length, holdings,
      error: snapshots.some((result) => result.status === 'rejected') ? 'TOSS_HOLDINGS_PARTIAL' : null,
    };
  } catch (error) {
    return {
      provider: 'toss', configured: true, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, connectionState: 'PROVIDER_DOWN',
      accounts: [], holdings: [], error: errorCode(error),
    };
  }
}

function firstArray(record: JsonRecord): JsonRecord[] {
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    }
  }
  return [];
}

function normalizeKiwoomHolding(row: JsonRecord) {
  return {
    symbol: stringValue(row.stk_cd ?? row.symbol ?? row.ticker),
    name: stringValue(row.stk_nm ?? row.name),
    quantity: finite(row.rmnd_qty ?? row.qty ?? row.hld_qty ?? row.hold_qty),
    averagePrice: finite(row.pur_pric ?? row.avg_prc ?? row.buy_uv ?? row.avgPrice),
    currentPrice: finite(row.cur_prc ?? row.curPrice),
    evaluationAmount: finite(row.evlt_amt ?? row.evltAmount),
    profitLoss: finite(row.evltv_prft ?? row.pl_amt ?? row.profitLoss),
    profitRate: finite(row.prft_rt ?? row.pl_rt ?? row.profitRate),
    currency: stringValue(row.crnc_cd ?? row.currency),
  };
}

async function readKiwoom(state: CredentialState) {
  const appKey = stringValue(state.credentials?.appKey);
  const secretKey = stringValue(state.credentials?.secretKey);
  const configured = Boolean(appKey && secretKey && kiwoomInfrastructureConfigured());
  if (!configured) {
    return {
      provider: 'kiwoom', configured: false, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError,
      error: 'KIWOOM_NOT_CONFIGURED',
    };
  }

  try {
    const baseCredentials = { appKey, secretKey } satisfies KiwoomCredentials;
    const tokenPayload = await fetchPreparedKiwoom<JsonRecord>(prepareKiwoomToken(baseCredentials));
    const accessToken = stringValue(tokenPayload.token);
    const tokenCode = tokenPayload.return_code == null || tokenPayload.return_code === ''
      ? 0
      : Number(tokenPayload.return_code);
    if (!accessToken || !Number.isFinite(tokenCode) || tokenCode !== 0) {
      throw new Error('KIWOOM_TOKEN_FAILED');
    }
    const credentials = { appKey, secretKey, accessToken } satisfies KiwoomCredentials;
    const [accountNumber, domestic, us] = await Promise.allSettled([
      fetchPreparedKiwoom<JsonRecord>(prepareKiwoomAccountNumber(credentials)),
      fetchPreparedKiwoom<JsonRecord>(prepareKiwoomDomesticAccount(credentials)),
      fetchPreparedKiwoom<JsonRecord>(prepareKiwoomUsAccount(credentials)),
    ]);

    const accountData = accountNumber.status === 'fulfilled' ? accountNumber.value : {};
    const domesticData = domestic.status === 'fulfilled' ? domestic.value : {};
    const usData = us.status === 'fulfilled' ? us.value : {};
    const domesticRows = Array.isArray(domesticData.acnt_evlt_remn_indv_tot)
      ? domesticData.acnt_evlt_remn_indv_tot.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const usRows = firstArray(usData);

    return {
      provider: 'kiwoom', configured: true,
      connected: accountNumber.status === 'fulfilled' && (domestic.status === 'fulfilled' || us.status === 'fulfilled'),
      readOnly: true, mode: kiwoomMode(), credentialSource: state.source, vaultError: state.vaultError,
      accountMasked: maskAccount(accountData.acctNo ?? accountData.acctno ?? accountData.accountNo),
      kr: {
        ok: domestic.status === 'fulfilled',
        totalEvaluationAmount: finite(domesticData.tot_evlt_amt),
        totalProfitLoss: finite(domesticData.tot_evlt_pl),
        totalProfitRate: finite(domesticData.tot_prft_rt),
        estimatedAssets: finite(domesticData.prsm_dpst_aset_amt),
        holdingCount: domesticRows.length,
        holdings: domesticRows.map(normalizeKiwoomHolding),
        error: domestic.status === 'rejected' ? errorCode(domestic.reason) : null,
      },
      us: {
        ok: us.status === 'fulfilled',
        holdingCount: usRows.length,
        holdings: usRows.map(normalizeKiwoomHolding),
        error: us.status === 'rejected' ? errorCode(us.reason) : null,
      },
      error: accountNumber.status === 'rejected' ? errorCode(accountNumber.reason) : null,
    };
  } catch (error) {
    return {
      provider: 'kiwoom', configured: true, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, error: errorCode(error),
    };
  }
}

async function readUpbit(state: CredentialState) {
  const accessKey = stringValue(state.credentials?.accessKey);
  const secretKey = stringValue(state.credentials?.secretKey);
  const configured = Boolean(accessKey && secretKey);
  if (!configured) {
    return {
      provider: 'upbit', configured: false, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, error: 'UPBIT_NOT_CONFIGURED',
    };
  }
  try {
    const request = prepareUpbitAccounts({ accessKey, secretKey } satisfies UpbitCredentials);
    const rows = await fetchPreparedReadOnly<JsonRecord[]>(UPBIT_BASE, request);
    const assets = Array.isArray(rows) ? rows.map((row) => ({
      currency: stringValue(row.currency),
      balance: finite(row.balance),
      locked: finite(row.locked),
      averageBuyPrice: finite(row.avg_buy_price),
      unitCurrency: stringValue(row.unit_currency),
    })) : [];
    return {
      provider: 'upbit', configured: true, connected: true, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, assetCount: assets.length, assets, error: null,
    };
  } catch (error) {
    return {
      provider: 'upbit', configured: true, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, error: errorCode(error),
    };
  }
}

async function readBitget(state: CredentialState) {
  const apiKey = stringValue(state.credentials?.apiKey);
  const secretKey = stringValue(state.credentials?.secretKey);
  const passphrase = stringValue(state.credentials?.passphrase);
  const configured = Boolean(apiKey && secretKey && passphrase);
  if (!configured) {
    return {
      provider: 'bitget', configured: false, connected: false, readOnly: true,
      credentialSource: state.source, vaultError: state.vaultError, error: 'BITGET_NOT_CONFIGURED',
    };
  }

  const credentials = { apiKey, secretKey, passphrase } satisfies BitgetCredentials;
  const timestamp = Date.now().toString();
  const accountRequest = prepareBitgetAccount(credentials, timestamp);
  const positionRequest = prepareBitgetPositions(credentials, timestamp);
  const [accounts, positions] = await Promise.allSettled([
    fetchPreparedReadOnly<JsonRecord>(BITGET_BASE, accountRequest),
    fetchPreparedReadOnly<JsonRecord>(BITGET_BASE, positionRequest),
  ]);
  const accountPayload = accounts.status === 'fulfilled' ? accounts.value : {};
  const positionPayload = positions.status === 'fulfilled' ? positions.value : {};
  const accountRows = Array.isArray(accountPayload.data)
    ? accountPayload.data.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const positionRows = Array.isArray(positionPayload.data)
    ? positionPayload.data.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return {
    provider: 'bitget', configured: true,
    connected: accounts.status === 'fulfilled' && positions.status === 'fulfilled'
      && String(accountPayload.code ?? '') === '00000'
      && String(positionPayload.code ?? '') === '00000',
    readOnly: true, credentialSource: state.source, vaultError: state.vaultError, productType: BITGET_PRODUCT_TYPE,
    accounts: accountRows.map((row) => ({
      marginCoin: stringValue(row.marginCoin), available: finite(row.available), locked: finite(row.locked),
      accountEquity: finite(row.accountEquity), unrealizedPL: finite(row.unrealizedPL),
    })),
    positions: positionRows.map((row) => ({
      symbol: stringValue(row.symbol), marginCoin: stringValue(row.marginCoin), side: stringValue(row.holdSide),
      total: finite(row.total), available: finite(row.available), leverage: finite(row.leverage),
      averageOpenPrice: finite(row.openPriceAvg), markPrice: finite(row.markPrice), unrealizedPL: finite(row.unrealizedPL),
      liquidationPrice: finite(row.liquidationPrice),
    })),
    error: accounts.status === 'rejected'
      ? errorCode(accounts.reason)
      : positions.status === 'rejected'
        ? errorCode(positions.reason)
        : String(accountPayload.code ?? '') !== '00000' || String(positionPayload.code ?? '') !== '00000'
          ? 'ACCOUNT_AUTH_FAILED'
          : null,
  };
}

export async function memberAccountConnectionStatus(req: AuthenticatedRequest) {
  const states = await credentialStates(req);
  return {
    ok: true,
    readOnly: true,
    mutationsAllowed: false,
    credentialsReturned: false,
    providers: {
      toss: {
        configured: Boolean(states.toss.credentials), credentialSource: states.toss.source,
        vaultError: states.toss.vaultError,
        connectionState: states.toss.credentials ? 'CONFIGURED' : 'WAITING_FOR_TOSS_API_ACCESS',
      },
      kiwoom: {
        configured: Boolean(states.kiwoom.credentials && kiwoomInfrastructureConfigured()),
        credentialSource: states.kiwoom.source,
        vaultError: states.kiwoom.vaultError,
        mode: kiwoomMode(),
      },
      upbit: {
        configured: Boolean(states.upbit.credentials),
        credentialSource: states.upbit.source,
        vaultError: states.upbit.vaultError,
      },
      bitget: {
        configured: Boolean(states.bitget.credentials),
        credentialSource: states.bitget.source,
        vaultError: states.bitget.vaultError,
      },
    },
    checkedAt: new Date().toISOString(),
  };
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json(await memberAccountConnectionStatus(req));
});

export async function memberAccountConnectionSnapshot(req: AuthenticatedRequest) {
  const states = await credentialStates(req);
  const [toss, kiwoom, upbit, bitget] = await Promise.all([
    readToss(states.toss),
    readKiwoom(states.kiwoom),
    readUpbit(states.upbit),
    readBitget(states.bitget),
  ]);
  return {
    ok: true,
    readOnly: true,
    mutationsAllowed: false,
    credentialsReturned: false,
    providers: { toss, kiwoom, upbit, bitget },
    checkedAt: new Date().toISOString(),
  };
}

router.get('/snapshot', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json(await memberAccountConnectionSnapshot(req));
});

export default router;

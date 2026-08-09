import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  prepareBitgetAccount,
  prepareBitgetPositions,
  prepareKiwoomAccountNumber,
  prepareKiwoomDomesticAccount,
  prepareKiwoomToken,
  prepareKiwoomUsAccount,
  prepareUpbitAccounts,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from '../services/trade-exchange-adapters.service';
import { createSupabaseTradingRepository } from '../services/trade-automation.repository';
import { decryptTradingCredentials } from '../services/trade-credential-vault.service';
import type { TradingExchange } from '../services/trade-automation.types';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const KIWOOM_REAL_BASE = process.env.KIWOOM_BASE_URL?.trim() || 'http://158.247.235.32:3000/kiwoom';
const KIWOOM_MOCK_BASE = 'https://mockapi.kiwoom.com';
const REQUEST_TIMEOUT_MS = 12_000;
const KIWOOM_READ_API_IDS = new Set(['ka00001', 'kt00018', 'ust21070']);

type JsonRecord = Record<string, unknown>;
type CredentialSourceName = 'vault' | 'environment' | 'none';
type CredentialState = {
  source: CredentialSourceName;
  credentials: JsonRecord | null;
  vaultError: string | null;
};

type CredentialStates = Record<TradingExchange, CredentialState>;

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

async function fetchPreparedKiwoom<T>(request: PreparedExchangeRequest): Promise<T> {
  const apiId = request.headers['api-id'];
  const tokenRequest = request.method === 'POST' && request.path === '/oauth2/token';
  const accountRequest = request.method === 'POST'
    && (request.path === '/api/dostk/acnt' || request.path === '/api/us/acnt')
    && typeof apiId === 'string'
    && KIWOOM_READ_API_IDS.has(apiId);
  if (!tokenRequest && !accountRequest) {
    throw new Error('ACCOUNT_READONLY_REQUEST_REQUIRED');
  }
  return fetchPrepared<T>(kiwoomBaseUrl(), request, kiwoomProxyHeaders());
}

function environmentCredentials(exchange: TradingExchange): JsonRecord | null {
  if (exchange === 'kiwoom') {
    const appKey = process.env.KIWOOM_APP_KEY?.trim() ?? '';
    const secretKey = process.env.KIWOOM_APP_SECRET?.trim() ?? '';
    return appKey && secretKey ? { appKey, secretKey } : null;
  }
  if (exchange === 'upbit') {
    const accessKey = process.env.UPBIT_ACCESS_KEY?.trim() ?? '';
    const secretKey = process.env.UPBIT_SECRET_KEY?.trim() ?? '';
    return accessKey && secretKey ? { accessKey, secretKey } : null;
  }
  const apiKey = process.env.BITGET_API_KEY?.trim() ?? '';
  const secretKey = process.env.BITGET_SECRET_KEY?.trim() ?? '';
  const passphrase = process.env.BITGET_PASSPHRASE?.trim() ?? '';
  return apiKey && secretKey && passphrase ? { apiKey, secretKey, passphrase } : null;
}

async function credentialStates(req: AuthenticatedRequest): Promise<CredentialStates> {
  const exchanges: TradingExchange[] = ['kiwoom', 'upbit', 'bitget'];
  const fallback = Object.fromEntries(exchanges.map((exchange) => {
    const credentials = environmentCredentials(exchange);
    return [exchange, {
      source: credentials ? 'environment' : 'none',
      credentials,
      vaultError: null,
    } satisfies CredentialState];
  })) as CredentialStates;

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

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const states = await credentialStates(req);
  return res.json({
    ok: true,
    readOnly: true,
    mutationsAllowed: false,
    credentialsReturned: false,
    providers: {
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
  });
});

router.get('/snapshot', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const states = await credentialStates(req);
  const [kiwoom, upbit, bitget] = await Promise.all([
    readKiwoom(states.kiwoom),
    readUpbit(states.upbit),
    readBitget(states.bitget),
  ]);
  return res.json({
    ok: true,
    readOnly: true,
    mutationsAllowed: false,
    credentialsReturned: false,
    providers: { kiwoom, upbit, bitget },
    checkedAt: new Date().toISOString(),
  });
});

export default router;

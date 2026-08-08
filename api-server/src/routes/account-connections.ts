import { createHmac, randomUUID } from 'node:crypto';
import { Router, type IRouter } from 'express';
import {
  getKiwoomStatus,
  isKiwoomConfigured,
  kiwoomRequest,
} from '../providers/kiwoom';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const REQUEST_TIMEOUT_MS = 12_000;

type JsonRecord = Record<string, unknown>;

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

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
  return 'ACCOUNT_CONNECTION_FAILED';
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/1.0', ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function upbitAuthorization(): string {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? '').trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? '').trim();
  if (!accessKey || !secretKey) throw new Error('UPBIT_PRIVATE_KEYS_NOT_CONFIGURED');
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ access_key: accessKey, nonce: randomUUID() }));
  const signature = base64Url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest());
  return `Bearer ${header}.${payload}.${signature}`;
}

function bitgetHeaders(requestPath: string, query = ''): Record<string, string> {
  const apiKey = String(process.env.BITGET_API_KEY ?? '').trim();
  const secret = String(process.env.BITGET_SECRET_KEY ?? '').trim();
  const passphrase = String(process.env.BITGET_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) throw new Error('BITGET_PRIVATE_KEYS_NOT_CONFIGURED');
  const timestamp = Date.now().toString();
  const queryPart = query ? `?${query}` : '';
  const signature = createHmac('sha256', secret).update(`${timestamp}GET${requestPath}${queryPart}`).digest('base64');
  return { 'ACCESS-KEY': apiKey, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': passphrase, 'Content-Type': 'application/json', locale: 'en-US' };
}

function firstArray(record: JsonRecord): JsonRecord[] {
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
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

async function readKiwoom() {
  const configured = isKiwoomConfigured();
  if (!configured) return { provider: 'kiwoom', configured: false, connected: false, readOnly: true, error: 'KIWOOM_NOT_CONFIGURED' };

  const [accountNumber, domestic, us] = await Promise.allSettled([
    kiwoomRequest({ apiId: 'ka00001', path: '/api/dostk/acnt', body: {} }),
    kiwoomRequest({ apiId: 'kt00018', path: '/api/dostk/acnt', body: { qry_tp: '1', dmst_stex_tp: 'KRX' } }),
    kiwoomRequest({ apiId: 'ust21070', path: '/api/us/acnt', body: {} }),
  ]);

  const accountData = accountNumber.status === 'fulfilled' ? accountNumber.value.data as JsonRecord : {};
  const domesticData = domestic.status === 'fulfilled' ? domestic.value.data as JsonRecord : {};
  const usData = us.status === 'fulfilled' ? us.value.data as JsonRecord : {};
  const domesticRows = Array.isArray(domesticData.acnt_evlt_remn_indv_tot) ? domesticData.acnt_evlt_remn_indv_tot.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  const usRows = firstArray(usData);

  return {
    provider: 'kiwoom', configured: true,
    connected: accountNumber.status === 'fulfilled' && (domestic.status === 'fulfilled' || us.status === 'fulfilled'),
    readOnly: true, mode: getKiwoomStatus().mode,
    accountMasked: maskAccount(accountData.acctno ?? accountData.acctNo ?? accountData.accountNo),
    kr: { ok: domestic.status === 'fulfilled', totalEvaluationAmount: finite(domesticData.tot_evlt_amt), totalProfitLoss: finite(domesticData.tot_evlt_pl), totalProfitRate: finite(domesticData.tot_prft_rt), estimatedAssets: finite(domesticData.prsm_dpst_aset_amt), holdingCount: domesticRows.length, holdings: domesticRows.map(normalizeKiwoomHolding), error: domestic.status === 'rejected' ? errorCode(domestic.reason) : null },
    us: { ok: us.status === 'fulfilled', holdingCount: usRows.length, holdings: usRows.map(normalizeKiwoomHolding), error: us.status === 'rejected' ? errorCode(us.reason) : null },
    error: accountNumber.status === 'rejected' ? errorCode(accountNumber.reason) : null,
  };
}

async function readUpbit() {
  const configured = Boolean(process.env.UPBIT_ACCESS_KEY?.trim() && process.env.UPBIT_SECRET_KEY?.trim());
  if (!configured) return { provider: 'upbit', configured: false, connected: false, readOnly: true, error: 'UPBIT_NOT_CONFIGURED' };
  try {
    const rows = await fetchJson<JsonRecord[]>(`${UPBIT_BASE}/v1/accounts`, { Authorization: upbitAuthorization() });
    const assets = Array.isArray(rows) ? rows.map((row) => ({ currency: stringValue(row.currency), balance: finite(row.balance), locked: finite(row.locked), averageBuyPrice: finite(row.avg_buy_price), unitCurrency: stringValue(row.unit_currency) })) : [];
    return { provider: 'upbit', configured: true, connected: true, readOnly: true, assetCount: assets.length, assets, error: null };
  } catch (error) {
    return { provider: 'upbit', configured: true, connected: false, readOnly: true, error: errorCode(error) };
  }
}

async function readBitget() {
  const configured = Boolean(process.env.BITGET_API_KEY?.trim() && process.env.BITGET_SECRET_KEY?.trim() && process.env.BITGET_PASSPHRASE?.trim());
  if (!configured) return { provider: 'bitget', configured: false, connected: false, readOnly: true, error: 'BITGET_NOT_CONFIGURED' };
  const accountPath = '/api/v2/mix/account/accounts';
  const positionPath = '/api/v2/mix/position/all-position';
  const query = new URLSearchParams({ productType: BITGET_PRODUCT_TYPE }).toString();
  const [accounts, positions] = await Promise.allSettled([
    fetchJson<JsonRecord>(`${BITGET_BASE}${accountPath}?${query}`, bitgetHeaders(accountPath, query)),
    fetchJson<JsonRecord>(`${BITGET_BASE}${positionPath}?${query}`, bitgetHeaders(positionPath, query)),
  ]);
  const accountPayload = accounts.status === 'fulfilled' ? accounts.value : {};
  const positionPayload = positions.status === 'fulfilled' ? positions.value : {};
  const accountRows = Array.isArray(accountPayload.data) ? accountPayload.data.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  const positionRows = Array.isArray(positionPayload.data) ? positionPayload.data.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  return {
    provider: 'bitget', configured: true,
    connected: accounts.status === 'fulfilled' && positions.status === 'fulfilled' && String(accountPayload.code ?? '') === '00000' && String(positionPayload.code ?? '') === '00000',
    readOnly: true, productType: BITGET_PRODUCT_TYPE,
    accounts: accountRows.map((row) => ({ marginCoin: stringValue(row.marginCoin), available: finite(row.available), locked: finite(row.locked), accountEquity: finite(row.accountEquity), unrealizedPL: finite(row.unrealizedPL) })),
    positions: positionRows.map((row) => ({ symbol: stringValue(row.symbol), marginCoin: stringValue(row.marginCoin), side: stringValue(row.holdSide), total: finite(row.total), available: finite(row.available), leverage: finite(row.leverage), averageOpenPrice: finite(row.openPriceAvg), markPrice: finite(row.markPrice), unrealizedPL: finite(row.unrealizedPL), liquidationPrice: finite(row.liquidationPrice) })),
    error: accounts.status === 'rejected' ? errorCode(accounts.reason) : positions.status === 'rejected' ? errorCode(positions.reason) : null,
  };
}

router.get('/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json({ ok: true, readOnly: true, mutationsAllowed: false, providers: { kiwoom: { configured: isKiwoomConfigured(), ...getKiwoomStatus() }, upbit: { configured: Boolean(process.env.UPBIT_ACCESS_KEY?.trim() && process.env.UPBIT_SECRET_KEY?.trim()) }, bitget: { configured: Boolean(process.env.BITGET_API_KEY?.trim() && process.env.BITGET_SECRET_KEY?.trim() && process.env.BITGET_PASSPHRASE?.trim()) } }, checkedAt: new Date().toISOString() });
});

router.get('/snapshot', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const [kiwoom, upbit, bitget] = await Promise.all([readKiwoom(), readUpbit(), readBitget()]);
  return res.json({ ok: true, readOnly: true, mutationsAllowed: false, providers: { kiwoom, upbit, bitget }, checkedAt: new Date().toISOString() });
});

export default router;

import { createHash } from 'node:crypto';
import { nullableNumber, emptySnapshot, type CanonicalAccountSnapshot, type CanonicalReadonlyOrder } from '../account-readonly.contract';
import { AccountReadonlyError } from '../account-readonly.errors';

export type KiwoomReadonlyCredentials = {
  appKey: string;
  appSecret: string;
};

type Row = Record<string, unknown>;
type KiwoomPage = { body: Row; contYn: string | null; nextKey: string | null };
type TokenRecord = { token: string; expiresAtMs: number };

const KIWOOM_REAL_ORIGIN = 'https://api.kiwoom.com';
const KIWOOM_TOKEN_PATH = '/oauth2/token';
const KIWOOM_ACCOUNT_PATH = '/api/dostk/acnt';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_READONLY_PAGES = 10;
const KIWOOM_NO_DATA_CODE = 20;
const KIWOOM_RATE_LIMIT_CODES = new Set([1700, 1701, 1702]);
const KIWOOM_AUTH_CODES = new Set([
  8001, 8002, 8003, 8005, 8006, 8009, 8010, 8011, 8012, 8015, 8016,
  8030, 8031, 8040, 8050, 8103,
]);

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown, code: string): Row[] {
  if (!Array.isArray(value) || !value.every(record)) throw new AccountReadonlyError(code);
  return value;
}

function normalizeReturnCode(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function embeddedReturnCode(value: unknown) {
  const match = /\[(\d{3,5}):|CODE=(\d{3,5})/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

function classifyPayloadFailure(payload: Row) {
  const topLevel = normalizeReturnCode(payload.return_code);
  if (topLevel === null) return new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
  const embedded = embeddedReturnCode(payload.return_msg);
  const effective = KIWOOM_RATE_LIMIT_CODES.has(topLevel) || KIWOOM_AUTH_CODES.has(topLevel)
    ? topLevel
    : embedded ?? topLevel;
  if (KIWOOM_RATE_LIMIT_CODES.has(effective)) return new AccountReadonlyError('RATE_LIMITED', true);
  if (KIWOOM_AUTH_CODES.has(effective)) return new AccountReadonlyError('KIWOOM_AUTH_OR_IP_REJECTED');
  return new AccountReadonlyError('KIWOOM_REQUEST_REJECTED');
}

function safeJson(response: Response, code: string) {
  return response.json().catch(() => {
    throw new AccountReadonlyError(code);
  });
}

function classifyHttpFailure(response: Response) {
  if (response.status === 401 || response.status === 403) {
    return new AccountReadonlyError('KIWOOM_AUTH_OR_IP_REJECTED');
  }
  if (response.status === 429) return new AccountReadonlyError('RATE_LIMITED', true);
  if (response.status >= 500) return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);
  return new AccountReadonlyError('KIWOOM_REQUEST_REJECTED');
}

function parseExpiresAt(value: unknown) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) {
    throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const timestamp = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  if (!Number.isFinite(timestamp)) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
  return timestamp;
}

function credentialFingerprint(credentials: KiwoomReadonlyCredentials) {
  return createHash('sha256')
    .update(credentials.appKey)
    .update('\0')
    .update(credentials.appSecret)
    .digest('hex');
}

function normalizeSymbol(value: unknown) {
  if (typeof value !== 'string') throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_INVALID');
  const raw = value.trim().toUpperCase();
  const symbol = /^A\d{6}$/.test(raw) ? raw.slice(1) : raw;
  if (!/^\d{6}$/.test(symbol)) throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_INVALID');
  return symbol;
}

function nonNegative(value: unknown, code: string) {
  const number = nullableNumber(value);
  if (number === null || number < 0) throw new AccountReadonlyError(code);
  return number;
}

function absoluteNumberOrNull(value: unknown) {
  const number = nullableNumber(value);
  return number === null ? null : Math.abs(number);
}

function side(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (normalized === '1') return 'SELL';
  if (normalized === '2') return 'BUY';
  return null;
}

export class KiwoomReadonlyProvider {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly tokenInflight = new Map<string, Promise<TokenRecord>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => Date.now(),
  ) {}

  private async requestToken(credentials: KiwoomReadonlyCredentials, signal?: AbortSignal): Promise<TokenRecord> {
    const response = await this.fetchImpl(new URL(KIWOOM_TOKEN_PATH, KIWOOM_REAL_ORIGIN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: credentials.appKey,
        secretkey: credentials.appSecret,
      }),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw classifyHttpFailure(response);
    const body = await safeJson(response, 'KIWOOM_TOKEN_RESPONSE_INVALID');
    if (!record(body)) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    const returnCode = normalizeReturnCode(body.return_code);
    if (returnCode === null) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    if (returnCode !== 0) throw classifyPayloadFailure(body);
    if (typeof body.token !== 'string' || !body.token.trim()) {
      throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    }
    const recordValue = { token: body.token.trim(), expiresAtMs: parseExpiresAt(body.expires_dt) };
    if (recordValue.expiresAtMs <= this.now() + TOKEN_REFRESH_SKEW_MS) {
      throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    }
    return recordValue;
  }

  private async token(credentials: KiwoomReadonlyCredentials, signal?: AbortSignal) {
    const key = credentialFingerprint(credentials);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAtMs > this.now() + TOKEN_REFRESH_SKEW_MS) return cached.token;

    const active = this.tokenInflight.get(key);
    if (active) return (await active).token;

    const pending = this.requestToken(credentials, signal);
    this.tokenInflight.set(key, pending);
    try {
      const issued = await pending;
      this.tokens.set(key, issued);
      return issued.token;
    } finally {
      this.tokenInflight.delete(key);
    }
  }

  private async page(
    token: string,
    apiId: 'kt00018' | 'ka10075',
    body: Readonly<Record<string, string>>,
    continuation: { contYn: string; nextKey: string } | null,
    signal?: AbortSignal,
  ): Promise<KiwoomPage> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': apiId,
    };
    if (continuation) {
      headers['cont-yn'] = continuation.contYn;
      headers['next-key'] = continuation.nextKey;
    }

    const response = await this.fetchImpl(new URL(KIWOOM_ACCOUNT_PATH, KIWOOM_REAL_ORIGIN), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw classifyHttpFailure(response);
    const payload = await safeJson(response, 'KIWOOM_ACCOUNT_RESPONSE_INVALID');
    if (!record(payload)) throw new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
    const returnCode = normalizeReturnCode(payload.return_code);
    if (returnCode === null) throw new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
    if (returnCode !== 0 && returnCode !== KIWOOM_NO_DATA_CODE) throw classifyPayloadFailure(payload);
    const contYn = returnCode === KIWOOM_NO_DATA_CODE ? 'N' : response.headers.get('cont-yn');
    const nextKey = returnCode === KIWOOM_NO_DATA_CODE ? null : response.headers.get('next-key');
    return { body: payload, contYn, nextKey };
  }

  private async collect(
    token: string,
    apiId: 'kt00018' | 'ka10075',
    body: Readonly<Record<string, string>>,
    listKey: 'acnt_evlt_remn_indv_tot' | 'oso',
    signal?: AbortSignal,
  ) {
    const result: Row[] = [];
    let continuation: { contYn: string; nextKey: string } | null = null;
    let firstBody: Row | null = null;

    for (let pageIndex = 0; pageIndex < MAX_READONLY_PAGES; pageIndex += 1) {
      const page = await this.page(token, apiId, body, continuation, signal);
      firstBody ??= page.body;
      if (normalizeReturnCode(page.body.return_code) === KIWOOM_NO_DATA_CODE) {
        return { rows: result, firstBody };
      }
      result.push(...rows(page.body[listKey], 'KIWOOM_ACCOUNT_RESPONSE_INVALID'));
      if (page.contYn !== 'Y') return { rows: result, firstBody };
      if (!page.nextKey) throw new AccountReadonlyError('KIWOOM_CONTINUATION_INVALID');
      continuation = { contYn: 'Y', nextKey: page.nextKey };
    }
    throw new AccountReadonlyError('KIWOOM_CONTINUATION_LIMIT_REACHED');
  }

  async snapshot(
    credentials: KiwoomReadonlyCredentials,
    signal?: AbortSignal,
    now = new Date(),
  ): Promise<CanonicalAccountSnapshot> {
    const token = await this.token(credentials, signal);

    // Official read-only domestic account endpoints. No /api/dostk/ordr request
    // can be produced by this provider.
    const [holdings, open] = await Promise.all([
      this.collect(token, 'kt00018', { qry_tp: '1', dmst_stex_tp: 'KRX' }, 'acnt_evlt_remn_indv_tot', signal),
      this.collect(token, 'ka10075', { all_stk_tp: '0', trde_tp: '0', stex_tp: '0' }, 'oso', signal),
    ]);

    const positions = holdings.rows.map((row) => {
      const quantity = nonNegative(row.rmnd_qty, 'KIWOOM_POSITION_QUANTITY_INVALID');
      const availableQuantity = nonNegative(row.trde_able_qty, 'KIWOOM_POSITION_AVAILABLE_QUANTITY_INVALID');
      return {
        market: 'KR',
        symbol: normalizeSymbol(row.stk_cd),
        quantity,
        availableQuantity,
        averageEntryPrice: absoluteNumberOrNull(row.pur_pric),
        currentPrice: absoluteNumberOrNull(row.cur_prc),
        marketValue: absoluteNumberOrNull(row.evlt_amt),
        unrealizedPnl: nullableNumber(row.evltv_prft),
        unrealizedPnlPercent: nullableNumber(row.prft_rt),
        leverage: null,
        liquidationPrice: null,
        marginMode: null,
        side: null,
      };
    });
    if (new Set(positions.map((row) => row.symbol)).size !== positions.length) {
      throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_DUPLICATE');
    }

    const openOrders: CanonicalReadonlyOrder[] = open.rows.map((row) => ({
      id: typeof row.ord_no === 'string' && row.ord_no.trim() ? row.ord_no.trim() : null,
      market: 'KR',
      symbol: normalizeSymbol(row.stk_cd),
      side: side(row.trde_tp),
      price: absoluteNumberOrNull(row.ord_pric),
      quantity: nullableNumber(row.ord_qty),
      remainingQuantity: nullableNumber(row.oso_qty),
      status: typeof row.ord_stt === 'string' && row.ord_stt.trim() ? row.ord_stt.trim() : null,
    }));

    const checkedAt = now.toISOString();
    return {
      ...emptySnapshot('kiwoom', 'CONNECTED', checkedAt),
      connected: true,
      accounts: [{ market: 'KR', accountRef: null, currency: 'KRW', buyingPower: null }],
      balances: null,
      positions,
      openOrders,
      lastGoodAt: checkedAt,
    };
  }
}

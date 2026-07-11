/**
 * Kiwoom REST API provider.
 *
 * Required Replit Secrets:
 * - KIWOOM_APP_KEY
 * - KIWOOM_APP_SECRET
 * - KIWOOM_MODE=real | mock
 *
 * The provider intentionally keeps all credentials on the API server.
 */

const REAL_BASE_URL = 'https://api.kiwoom.com';
const MOCK_BASE_URL = 'https://mockapi.kiwoom.com';
const REQUEST_TIMEOUT_MS = 15_000;

export type KiwoomMarket = 'KR' | 'US';
export type KiwoomRankingType =
  | 'volume'
  | 'tradingValue'
  | 'gainers'
  | 'losers';

export interface KiwoomApiResponse {
  return_code?: number | string;
  return_msg?: string;
  [key: string]: unknown;
}

export interface KiwoomRankingRow {
  ticker: string;
  name: string;
  market: KiwoomMarket;
  currency: 'KRW' | 'USD';
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  tradingValue: number | null;
  rank: number;
  reason: string;
  provider: 'kiwoom';
  raw: Record<string, unknown>;
}

interface TokenResponse extends KiwoomApiResponse {
  expires_dt?: string;
  token_type?: string;
  token?: string;
}

interface RequestOptions {
  apiId: string;
  path: string;
  body: Record<string, unknown>;
  contYn?: string;
  nextKey?: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

function baseUrl(): string {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === 'mock'
    ? MOCK_BASE_URL
    : REAL_BASE_URL;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 등록되지 않았습니다.`);
  }
  return value;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/[,+%₩$]/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function absoluteNumber(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed == null ? null : Math.abs(parsed);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `키움 API가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}: ${text.slice(0, 240)}`,
    );
  }
}

function returnCode(data: Record<string, unknown>): number {
  const raw = data.return_code;
  if (raw == null || raw === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : -1;
}

function returnMessage(data: Record<string, unknown>): string {
  return typeof data.return_msg === 'string' && data.return_msg.trim()
    ? data.return_msg
    : '알 수 없는 키움 API 오류';
}

export function clearKiwoomTokenCache(): void {
  tokenCache = null;
}

export function isKiwoomConfigured(): boolean {
  return Boolean(
    process.env.KIWOOM_APP_KEY?.trim() &&
      process.env.KIWOOM_APP_SECRET?.trim(),
  );
}

export function getKiwoomStatus() {
  return {
    provider: 'kiwoom',
    mode:
      process.env.KIWOOM_MODE?.trim().toLowerCase() === 'mock'
        ? 'mock'
        : 'real',
    baseUrl: baseUrl(),
    appKeyRegistered: Boolean(process.env.KIWOOM_APP_KEY?.trim()),
    appSecretRegistered: Boolean(process.env.KIWOOM_APP_SECRET?.trim()),
    tokenCached: Boolean(
      tokenCache && Date.now() < tokenCache.expiresAt - 60_000,
    ),
  };
}

export async function getKiwoomToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: requireEnv('KIWOOM_APP_KEY'),
        secretkey: requireEnv('KIWOOM_APP_SECRET'),
      }),
      signal: controller.signal,
    });

    const result = (await readJson(response)) as TokenResponse;

    if (!response.ok || returnCode(result) !== 0 || !result.token) {
      throw new Error(
        `키움 토큰 발급 실패: ${returnMessage(result)} (HTTP ${response.status})`,
      );
    }

    tokenCache = {
      token: result.token,
      // Official token lifetime is 24 hours. Cache for 23 hours defensively.
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
    };

    return result.token;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('키움 토큰 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function kiwoomRequest<
  T extends KiwoomApiResponse = KiwoomApiResponse,
>({ apiId, path, body, contYn, nextKey }: RequestOptions): Promise<{
  data: T;
  contYn: string | null;
  nextKey: string | null;
}> {
  const token = await getKiwoomToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    authorization: `Bearer ${token}`,
    'api-id': apiId,
  };

  if (contYn) headers['cont-yn'] = contYn;
  if (nextKey) headers['next-key'] = nextKey;

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const result = (await readJson(response)) as T;

    if (!response.ok || returnCode(result) !== 0) {
      if (response.status === 401 || response.status === 403) {
        clearKiwoomTokenCache();
      }

      throw new Error(
        `키움 ${apiId} 요청 실패: ${returnMessage(result)} (HTTP ${response.status})`,
      );
    }

    return {
      data: result,
      contYn: response.headers.get('cont-yn'),
      nextKey: response.headers.get('next-key'),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`키움 ${apiId} 요청 시간이 초과되었습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getKiwoomDomesticOrderbook(
  ticker: string,
): Promise<KiwoomApiResponse> {
  const normalizedTicker = ticker.trim().toUpperCase();

  if (!/^[0-9]{6}(?:_(?:NX|AL))?$/.test(normalizedTicker)) {
    throw new Error(`잘못된 국내 종목코드입니다: ${normalizedTicker}`);
  }

  const result = await kiwoomRequest({
    apiId: 'ka10004',
    path: '/api/dostk/mrkcond',
    body: { stk_cd: normalizedTicker },
  });

  return result.data;
}

function domesticRankingRequest(type: KiwoomRankingType): RequestOptions {
  const common = {
    mrkt_tp: '000',
    mang_stk_incls: '0',
    stex_tp: '1',
  };

  if (type === 'volume') {
    return {
      apiId: 'ka10030',
      path: '/api/dostk/rkinfo',
      body: {
        ...common,
        sort_tp: '1',
        crd_tp: '0',
        trde_qty_tp: '0',
        pric_tp: '0',
        trde_prica_tp: '0',
        mrkt_open_tp: '0',
      },
    };
  }

  if (type === 'tradingValue') {
    return {
      apiId: 'ka10032',
      path: '/api/dostk/rkinfo',
      body: common,
    };
  }

  return {
    apiId: 'ka10027',
    path: '/api/dostk/rkinfo',
    body: {
      ...common,
      sort_tp: type === 'losers' ? '2' : '1',
      trde_qty_cnd: '0000',
      stk_cnd: '0',
      crd_cnd: '0',
      updown_incls: '1',
      pric_cnd: '0',
      trde_prica_cnd: '0',
    },
  };
}

function usRankingRequest(type: KiwoomRankingType): RequestOptions {
  const apiId =
    type === 'volume'
      ? 'usa20530'
      : type === 'tradingValue'
        ? 'usa20540'
        : 'usa20910';

  return {
    apiId,
    path: '/api/us/rkinfo',
    body: {
      // 000 = all supported US exchanges in Kiwoom ranking screens.
      excd: '000',
      // Stock/industry rows, not ETF-only rows.
      item_tp: '1',
      sort_tp: type === 'losers' ? '2' : '1',
    },
  };
}

function objectRows(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
  }
  if (!value || typeof value !== 'object') return [];

  const entries = Object.entries(value as Record<string, unknown>);
  const direct = entries
    .filter(([, nested]) => Array.isArray(nested))
    .sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length);

  for (const [, nested] of direct) {
    const rows = objectRows(nested, depth + 1);
    if (rows.length > 0) return rows;
  }

  for (const [, nested] of entries) {
    const rows = objectRows(nested, depth + 1);
    if (rows.length > 0) return rows;
  }

  return [];
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return undefined;
}

function normalizeRankingRows(
  data: Record<string, unknown>,
  market: KiwoomMarket,
  type: KiwoomRankingType,
  limit: number,
): KiwoomRankingRow[] {
  const rows = objectRows(data);
  const result: KiwoomRankingRow[] = [];

  for (const row of rows) {
    const tickerRaw = pick(row, [
      'stk_cd',
      'stk_code',
      'symbol',
      'symb',
      'ticker',
      'ovrs_pdno',
      'eng_stk_cd',
      'code',
    ]);
    const ticker = String(tickerRaw ?? '').trim().toUpperCase();
    if (!ticker) continue;

    const name = String(
      pick(row, [
        'stk_nm',
        'stk_name',
        'name',
        'kor_nm',
        'eng_nm',
        'ovrs_item_name',
      ]) ?? ticker,
    ).trim();

    const price = absoluteNumber(
      pick(row, ['cur_prc', 'now_pric', 'last', 'price', 'ovrs_nmix_prpr']),
    );
    const changePercent = toNumber(
      pick(row, [
        'flu_rt',
        'chg_rt',
        'change_rate',
        'changePercent',
        'prdy_ctrt',
        'rate',
      ]),
    );
    const volume = absoluteNumber(
      pick(row, ['trde_qty', 'volume', 'acml_vol', 'acml_volum', 'tvol']),
    );
    const tradingValue = absoluteNumber(
      pick(row, ['trde_prica', 'trading_value', 'acml_tr_pbmn', 'amount']),
    );

    result.push({
      ticker,
      name,
      market,
      currency: market === 'KR' ? 'KRW' : 'USD',
      price,
      changePercent,
      volume,
      tradingValue,
      rank: result.length + 1,
      reason:
        type === 'volume'
          ? '키움증권 거래량 상위 종목입니다.'
          : type === 'tradingValue'
            ? '키움증권 거래대금 상위 종목입니다.'
            : type === 'gainers'
              ? '키움증권 등락률 기준 급상승 종목입니다.'
              : '키움증권 등락률 기준 급하락 종목입니다.',
      provider: 'kiwoom',
      raw: row,
    });

    if (result.length >= limit) break;
  }

  return result;
}

export async function getKiwoomRankings(
  market: KiwoomMarket,
  type: KiwoomRankingType,
  limit = 30,
): Promise<KiwoomRankingRow[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit || 30)));
  const request =
    market === 'KR' ? domesticRankingRequest(type) : usRankingRequest(type);
  const response = await kiwoomRequest(request);

  const rows = normalizeRankingRows(
    response.data as Record<string, unknown>,
    market,
    type,
    safeLimit,
  );

  if (rows.length === 0) {
    throw new Error(
      `키움 ${request.apiId} 응답에서 종목 목록을 찾지 못했습니다. API 원문은 /api/kiwoom/raw-ranking에서 확인할 수 있습니다.`,
    );
  }

  return rows;
}

export type StockFlowMarket = 'KR' | 'US';

export type StockFlowSectionStatus =
  | 'READY'
  | 'NOT_CONNECTED'
  | 'UNAVAILABLE'
  | 'NOT_APPLICABLE'
  | 'NOT_INFERRED';

export interface StockFlowSourceRef {
  provider: 'FINRA' | 'KRX';
  dataset: string;
  asOf: string | null;
  url: string;
}

export interface StockFlowEvidence {
  schemaVersion: 'scanner-stock-flow-evidence-v1';
  market: StockFlowMarket;
  symbol: string;
  status: 'READY' | 'PARTIAL' | 'NOT_CONNECTED' | 'UNAVAILABLE';
  observedAt: string;
  shortSale: {
    status: StockFlowSectionStatus;
    tradeDate: string | null;
    shortVolume: number | null;
    shortExemptVolume: number | null;
    totalVolume: number | null;
    shortVolumeRatioPercent: number | null;
  };
  shortInterest: {
    status: StockFlowSectionStatus;
    settlementDate: string | null;
    currentShortPosition: number | null;
    previousShortPosition: number | null;
    changePercent: number | null;
    averageDailyVolume: number | null;
    daysToCover: number | null;
  };
  institutional: {
    status: StockFlowSectionStatus;
    asOf: string | null;
    note: string;
  };
  foreignFlow: {
    status: StockFlowSectionStatus;
    asOf: string | null;
    note: string;
  };
  shortCover: {
    status: 'NOT_INFERRED';
    note: string;
  };
  sources: StockFlowSourceRef[];
  warnings: string[];
  safety: {
    evidenceOnly: true;
    scoreImpact: 0;
    rankImpact: 0;
    directionImpact: 0;
    executionAuthority: 'NONE';
    orderAllowed: false;
  };
}

export class StockFlowEvidenceError extends Error {
  constructor(
    public readonly code: 'STOCK_FLOW_INVALID_SYMBOL' | 'STOCK_FLOW_PROVIDER_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'StockFlowEvidenceError';
  }
}

export type FinraApiCredentials = {
  clientId: string;
  clientSecret: string;
};

type FinraRegShoRow = {
  tradeReportDate?: unknown;
  securitiesInformationProcessorSymbolIdentifier?: unknown;
  shortParQuantity?: unknown;
  shortExemptParQuantity?: unknown;
  totalParQuantity?: unknown;
  marketCode?: unknown;
  reportingFacilityCode?: unknown;
};

type FinraShortInterestRow = {
  settlementDate?: unknown;
  symbolCode?: unknown;
  currentShortPositionQuantity?: unknown;
  previousShortPositionQuantity?: unknown;
  averageDailyVolumeQuantity?: unknown;
  daysToCoverQuantity?: unknown;
  changePercent?: unknown;
};

const FINRA_FIP_TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials';
const FINRA_REG_SHO_URL = 'https://api.finra.org/data/group/otcMarket/name/regShoDaily';
const FINRA_SHORT_INTEREST_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const FINRA_DOCS_URL = 'https://developer.finra.org/docs';
const KRX_DATA_URL = 'https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA002.jsp';

let finraTokenCache: { clientId: string; accessToken: string; expiresAt: number } | null = null;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeUsSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(normalized)) {
    throw new StockFlowEvidenceError('STOCK_FLOW_INVALID_SYMBOL', '미국 주식 심볼 형식이 올바르지 않습니다.');
  }
  return normalized;
}

function normalizeKrSymbol(symbol: string): string {
  const normalized = symbol.trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new StockFlowEvidenceError('STOCK_FLOW_INVALID_SYMBOL', '국내 주식 종목코드는 6자리여야 합니다.');
  }
  return normalized;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safety() {
  return {
    evidenceOnly: true as const,
    scoreImpact: 0 as const,
    rankImpact: 0 as const,
    directionImpact: 0 as const,
    executionAuthority: 'NONE' as const,
    orderAllowed: false as const,
  };
}

function finraSources(shortDate: string | null = null, interestDate: string | null = null): StockFlowSourceRef[] {
  return [
    { provider: 'FINRA', dataset: 'Reg SHO Daily Short Sale Volume', asOf: shortDate, url: FINRA_DOCS_URL },
    { provider: 'FINRA', dataset: 'Consolidated Short Interest', asOf: interestDate, url: FINRA_DOCS_URL },
  ];
}

function krNotConnected(symbol: string, now: Date): StockFlowEvidence {
  return {
    schemaVersion: 'scanner-stock-flow-evidence-v1',
    market: 'KR',
    symbol,
    status: 'NOT_CONNECTED',
    observedAt: now.toISOString(),
    shortSale: {
      status: 'NOT_CONNECTED',
      tradeDate: null,
      shortVolume: null,
      shortExemptVolume: null,
      totalVolume: null,
      shortVolumeRatioPercent: null,
    },
    shortInterest: {
      status: 'NOT_CONNECTED',
      settlementDate: null,
      currentShortPosition: null,
      previousShortPosition: null,
      changePercent: null,
      averageDailyVolume: null,
      daysToCover: null,
    },
    institutional: {
      status: 'NOT_CONNECTED',
      asOf: null,
      note: 'KRX 공식 투자자/회원사 수급 데이터는 승인된 API 인증키 또는 데이터 공급 계약 연결이 필요합니다.',
    },
    foreignFlow: {
      status: 'NOT_CONNECTED',
      asOf: null,
      note: 'KRX 공식 외국인 거래 데이터는 승인된 API 인증키 또는 데이터 공급 계약 연결이 필요합니다.',
    },
    shortCover: {
      status: 'NOT_INFERRED',
      note: '공매도/수급 원자료 없이 숏커버를 추정하지 않습니다.',
    },
    sources: [{ provider: 'KRX', dataset: 'KRX official stock market data feed', asOf: null, url: KRX_DATA_URL }],
    warnings: ['KRX 공식 수급 데이터 provider가 현재 앱에 연결되지 않았습니다.'],
    safety: safety(),
  };
}

function usNotConnected(symbol: string, now: Date): StockFlowEvidence {
  return {
    schemaVersion: 'scanner-stock-flow-evidence-v1',
    market: 'US',
    symbol,
    status: 'NOT_CONNECTED',
    observedAt: now.toISOString(),
    shortSale: {
      status: 'NOT_CONNECTED',
      tradeDate: null,
      shortVolume: null,
      shortExemptVolume: null,
      totalVolume: null,
      shortVolumeRatioPercent: null,
    },
    shortInterest: {
      status: 'NOT_CONNECTED',
      settlementDate: null,
      currentShortPosition: null,
      previousShortPosition: null,
      changePercent: null,
      averageDailyVolume: null,
      daysToCover: null,
    },
    institutional: {
      status: 'NOT_CONNECTED',
      asOf: null,
      note: 'SEC Form 13F는 분기 point-in-time ingest가 별도로 필요하며 현재 Scanner 런타임에 연결하지 않았습니다.',
    },
    foreignFlow: {
      status: 'NOT_APPLICABLE',
      asOf: null,
      note: '미국 시장에서 국내식 외국인 순매수 지표를 임의 변환하지 않습니다.',
    },
    shortCover: {
      status: 'NOT_INFERRED',
      note: 'Short sale volume과 short interest만으로 숏커버를 단정하지 않습니다.',
    },
    sources: finraSources(),
    warnings: ['FINRA Production Query API OAuth 자격증명이 현재 런타임에 연결되지 않았습니다.'],
    safety: safety(),
  };
}

function usUnavailable(symbol: string, now: Date, warning: string): StockFlowEvidence {
  return {
    ...usNotConnected(symbol, now),
    status: 'UNAVAILABLE',
    shortSale: {
      status: 'UNAVAILABLE',
      tradeDate: null,
      shortVolume: null,
      shortExemptVolume: null,
      totalVolume: null,
      shortVolumeRatioPercent: null,
    },
    shortInterest: {
      status: 'UNAVAILABLE',
      settlementDate: null,
      currentShortPosition: null,
      previousShortPosition: null,
      changePercent: null,
      averageDailyVolume: null,
      daysToCover: null,
    },
    warnings: [warning],
  };
}

function resolveFinraCredentials(explicit: FinraApiCredentials | null | undefined): FinraApiCredentials | null {
  if (explicit === null) return null;
  if (explicit !== undefined) {
    const clientId = explicit.clientId.trim();
    const clientSecret = explicit.clientSecret.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  const clientId = process.env.FINRA_API_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.FINRA_API_CLIENT_SECRET?.trim() ?? '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function getFinraAccessToken(
  credentials: FinraApiCredentials,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<string> {
  if (
    finraTokenCache
    && finraTokenCache.clientId === credentials.clientId
    && finraTokenCache.expiresAt - 60_000 > nowMs
  ) {
    return finraTokenCache.accessToken;
  }

  let response: Response;
  try {
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, 'utf8').toString('base64');
    response = await fetchImpl(FINRA_FIP_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${basic}`,
      },
    });
  } catch {
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', 'FINRA OAuth 토큰을 발급받지 못했습니다.');
  }

  if (!response.ok) {
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', `FINRA OAuth 응답 오류 HTTP_${response.status}`);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', 'FINRA OAuth 응답 형식이 올바르지 않습니다.');
  }
  const row = body as Record<string, unknown>;
  const accessToken = typeof row.access_token === 'string' ? row.access_token.trim() : '';
  const expiresInSeconds = Number(row.expires_in);
  if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', 'FINRA OAuth 토큰 정보가 누락됐습니다.');
  }

  finraTokenCache = {
    clientId: credentials.clientId,
    accessToken,
    expiresAt: nowMs + Math.min(expiresInSeconds, 43_200) * 1_000,
  };
  return accessToken;
}

async function finraPost<T>(
  url: string,
  payload: Record<string, unknown>,
  accessToken: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<T[]> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': 'seungjae-stock-flow-evidence/1.0',
      },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', 'FINRA 공식 데이터를 불러오지 못했습니다.');
  }
  if (response.status === 204) return [];
  if (!response.ok) {
    throw new StockFlowEvidenceError(
      'STOCK_FLOW_PROVIDER_ERROR',
      `FINRA 공식 데이터 응답 오류 HTTP_${response.status}`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new StockFlowEvidenceError('STOCK_FLOW_PROVIDER_ERROR', 'FINRA 공식 데이터 형식이 올바르지 않습니다.');
  }
  return body as T[];
}

function aggregateLatestRegSho(rows: FinraRegShoRow[], symbol: string) {
  const normalizedRows = rows
    .filter((row) => String(row.securitiesInformationProcessorSymbolIdentifier ?? '').trim().toUpperCase() === symbol)
    .map((row) => ({
      tradeDate: isoDate(row.tradeReportDate),
      shortVolume: finite(row.shortParQuantity),
      shortExemptVolume: finite(row.shortExemptParQuantity),
      totalVolume: finite(row.totalParQuantity),
    }))
    .filter((row) => row.tradeDate !== null);
  const latestDate = normalizedRows.map((row) => row.tradeDate!).sort().at(-1) ?? null;
  if (!latestDate) return null;
  const latest = normalizedRows.filter((row) => row.tradeDate === latestDate);
  const shortVolume = latest.reduce((sum, row) => sum + Math.max(0, row.shortVolume ?? 0), 0);
  const shortExemptVolume = latest.reduce((sum, row) => sum + Math.max(0, row.shortExemptVolume ?? 0), 0);
  const totalVolume = latest.reduce((sum, row) => sum + Math.max(0, row.totalVolume ?? 0), 0);
  return {
    tradeDate: latestDate,
    shortVolume,
    shortExemptVolume,
    totalVolume,
    shortVolumeRatioPercent: totalVolume > 0 ? round(shortVolume / totalVolume * 100, 2) : null,
  };
}

function latestShortInterest(rows: FinraShortInterestRow[], symbol: string) {
  const latest = rows
    .filter((row) => String(row.symbolCode ?? '').trim().toUpperCase() === symbol)
    .map((row) => ({
      settlementDate: isoDate(row.settlementDate),
      currentShortPosition: finite(row.currentShortPositionQuantity),
      previousShortPosition: finite(row.previousShortPositionQuantity),
      averageDailyVolume: finite(row.averageDailyVolumeQuantity),
      daysToCover: finite(row.daysToCoverQuantity),
      changePercent: finite(row.changePercent),
    }))
    .filter((row) => row.settlementDate !== null)
    .sort((left, right) => left.settlementDate!.localeCompare(right.settlementDate!))
    .at(-1);
  return latest ?? null;
}

export async function loadStockFlowEvidence(
  input: { market: StockFlowMarket; symbol: string },
  dependencies: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    finraCredentials?: FinraApiCredentials | null;
  } = {},
): Promise<StockFlowEvidence> {
  const now = dependencies.now?.() ?? new Date();
  if (input.market === 'KR') return krNotConnected(normalizeKrSymbol(input.symbol), now);

  const symbol = normalizeUsSymbol(input.symbol);
  const credentials = resolveFinraCredentials(dependencies.finraCredentials);
  if (!credentials) return usNotConnected(symbol, now);

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let accessToken: string;
  try {
    accessToken = await getFinraAccessToken(credentials, fetchImpl, now.getTime());
  } catch {
    return usUnavailable(symbol, now, 'FINRA OAuth 인증 또는 토큰 발급에 실패했습니다.');
  }

  const requestFields = [
    'tradeReportDate',
    'securitiesInformationProcessorSymbolIdentifier',
    'shortParQuantity',
    'shortExemptParQuantity',
    'totalParQuantity',
  ];
  const [regSho, shortInterest] = await Promise.allSettled([
    finraPost<FinraRegShoRow>(FINRA_REG_SHO_URL, {
      limit: 5000,
      fields: requestFields,
      compareFilters: [{
        compareType: 'equal',
        fieldName: 'securitiesInformationProcessorSymbolIdentifier',
        fieldValue: symbol,
      }],
    }, accessToken, fetchImpl),
    finraPost<FinraShortInterestRow>(FINRA_SHORT_INTEREST_URL, {
      limit: 5000,
      fields: [
        'settlementDate',
        'symbolCode',
        'currentShortPositionQuantity',
        'previousShortPositionQuantity',
        'averageDailyVolumeQuantity',
        'daysToCoverQuantity',
        'changePercent',
      ],
      compareFilters: [{
        compareType: 'equal',
        fieldName: 'symbolCode',
        fieldValue: symbol,
      }],
    }, accessToken, fetchImpl),
  ]);

  const regShoValue = regSho.status === 'fulfilled' ? aggregateLatestRegSho(regSho.value, symbol) : null;
  const shortInterestValue = shortInterest.status === 'fulfilled' ? latestShortInterest(shortInterest.value, symbol) : null;
  const readyCount = Number(Boolean(regShoValue)) + Number(Boolean(shortInterestValue));
  const status = readyCount === 2 ? 'READY' : readyCount === 1 ? 'PARTIAL' : 'UNAVAILABLE';
  const warnings: string[] = [];
  if (!regShoValue) warnings.push('FINRA Reg SHO 일별 공매도 거래량을 확인하지 못했습니다.');
  if (!shortInterestValue) warnings.push('FINRA Consolidated Short Interest를 확인하지 못했습니다.');

  return {
    schemaVersion: 'scanner-stock-flow-evidence-v1',
    market: 'US',
    symbol,
    status,
    observedAt: now.toISOString(),
    shortSale: regShoValue ? {
      status: 'READY',
      ...regShoValue,
    } : {
      status: 'UNAVAILABLE',
      tradeDate: null,
      shortVolume: null,
      shortExemptVolume: null,
      totalVolume: null,
      shortVolumeRatioPercent: null,
    },
    shortInterest: shortInterestValue ? {
      status: 'READY',
      ...shortInterestValue,
    } : {
      status: 'UNAVAILABLE',
      settlementDate: null,
      currentShortPosition: null,
      previousShortPosition: null,
      changePercent: null,
      averageDailyVolume: null,
      daysToCover: null,
    },
    institutional: {
      status: 'NOT_CONNECTED',
      asOf: null,
      note: 'SEC Form 13F는 분기 데이터로 별도 point-in-time ingest가 필요하며 현재 Scanner 런타임에 연결하지 않았습니다.',
    },
    foreignFlow: {
      status: 'NOT_APPLICABLE',
      asOf: null,
      note: '미국 시장에서 국내식 외국인 순매수 지표를 임의 변환하지 않습니다.',
    },
    shortCover: {
      status: 'NOT_INFERRED',
      note: 'Short sale volume과 short interest만으로 숏커버를 단정하지 않습니다. 검증된 모델이 생기기 전까지 evidence-only로 유지합니다.',
    },
    sources: finraSources(regShoValue?.tradeDate ?? null, shortInterestValue?.settlementDate ?? null),
    warnings,
    safety: safety(),
  };
}

export function resetStockFlowProviderStateForTests(): void {
  finraTokenCache = null;
}

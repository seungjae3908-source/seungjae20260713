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

const FINRA_DAILY_FILE_ROOT = 'https://cdn.finra.org/equity/regsho/daily';
const FINRA_DAILY_FILES_PAGE = 'https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data/daily-short-sale-volume-files';
const KRX_DATA_URL = 'https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA002.jsp';
const MAX_FINRA_BUSINESS_DATES = 7;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function newYorkDateParts(now: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
  };
}

function candidateFinraTradeDates(now: Date): string[] {
  const ny = newYorkDateParts(now);
  const cursor = new Date(Date.UTC(ny.year, ny.month - 1, ny.day));
  const result: string[] = [];
  for (let offset = 0; offset < 14 && result.length < MAX_FINRA_BUSINESS_DATES; offset += 1) {
    const dayOfWeek = cursor.getUTCDay();
    const sameNyDate = offset === 0;
    const publishedToday = ny.hour >= 18;
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && (!sameNyDate || publishedToday)) {
      const year = String(cursor.getUTCFullYear());
      const month = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      const day = String(cursor.getUTCDate()).padStart(2, '0');
      result.push(`${year}${month}${day}`);
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return result;
}

function compactDateToIso(value: string): string | null {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : null;
}

function parseFinraDailyRow(
  text: string,
  symbol: string,
): {
  tradeDate: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  shortVolumeRatioPercent: number | null;
} | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith('Total Rows:')) continue;
    const [date, rowSymbol, shortRaw, shortExemptRaw, totalRaw] = line.split('|');
    if (String(rowSymbol ?? '').trim().toUpperCase() !== symbol) continue;
    const tradeDate = compactDateToIso(String(date ?? '').trim());
    const shortVolume = finite(shortRaw);
    const shortExemptVolume = finite(shortExemptRaw);
    const totalVolume = finite(totalRaw);
    if (tradeDate == null || shortVolume == null || shortExemptVolume == null || totalVolume == null) return null;
    if (shortVolume < 0 || shortExemptVolume < 0 || totalVolume <= 0) return null;
    return {
      tradeDate,
      shortVolume,
      shortExemptVolume,
      totalVolume,
      shortVolumeRatioPercent: round(shortVolume / totalVolume * 100, 2),
    };
  }
  return null;
}

async function loadLatestFinraDailyShortVolume(
  symbol: string,
  now: Date,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ row: NonNullable<ReturnType<typeof parseFinraDailyRow>>; sourceUrl: string } | null> {
  for (const date of candidateFinraTradeDates(now)) {
    const sourceUrl = `${FINRA_DAILY_FILE_ROOT}/CNMSshvol${date}.txt`;
    let response: Response;
    try {
      response = await fetchImpl(sourceUrl, {
        method: 'GET',
        signal,
        headers: {
          accept: 'text/plain',
          'user-agent': 'seungjae-stock-flow-evidence/1.0',
        },
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      continue;
    }
    if (!response.ok) continue;
    const row = parseFinraDailyRow(await response.text(), symbol);
    if (row) return { row, sourceUrl };
  }
  return null;
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

function usEvidence(
  symbol: string,
  now: Date,
  daily: Awaited<ReturnType<typeof loadLatestFinraDailyShortVolume>>,
): StockFlowEvidence {
  const shortReady = daily !== null;
  return {
    schemaVersion: 'scanner-stock-flow-evidence-v1',
    market: 'US',
    symbol,
    status: shortReady ? 'PARTIAL' : 'UNAVAILABLE',
    observedAt: now.toISOString(),
    shortSale: shortReady ? {
      status: 'READY',
      ...daily.row,
    } : {
      status: 'UNAVAILABLE',
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
      note: 'FINRA 일별 Short Sale Volume은 Short Interest 포지션이 아니며, 이 데이터만으로 숏커버를 단정하지 않습니다.',
    },
    sources: [{
      provider: 'FINRA',
      dataset: 'Consolidated NMS Daily Short Sale Volume',
      asOf: daily?.row.tradeDate ?? null,
      url: daily?.sourceUrl ?? FINRA_DAILY_FILES_PAGE,
    }],
    warnings: [
      ...(shortReady ? [] : ['최근 FINRA Consolidated NMS Daily Short Sale Volume 파일에서 종목 근거를 확인하지 못했습니다.']),
      'FINRA Daily Short Sale Volume은 off-exchange 공개거래 기반이며 거래소 체결 전체를 포함하지 않습니다.',
      '상장주식 Short Interest는 상장 거래소별 공식 데이터 provider가 연결되기 전까지 미연결로 유지합니다.',
    ],
    safety: safety(),
  };
}

export async function loadStockFlowEvidence(
  input: { market: StockFlowMarket; symbol: string },
  dependencies: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    signal?: AbortSignal;
  } = {},
): Promise<StockFlowEvidence> {
  const now = dependencies.now?.() ?? new Date();
  if (input.market === 'KR') return krNotConnected(normalizeKrSymbol(input.symbol), now);

  const symbol = normalizeUsSymbol(input.symbol);
  const daily = await loadLatestFinraDailyShortVolume(
    symbol,
    now,
    dependencies.fetchImpl ?? fetch,
    dependencies.signal,
  );
  return usEvidence(symbol, now, daily);
}

export function stockFlowCandidateTradeDatesForTests(now: Date): string[] {
  return candidateFinraTradeDates(now);
}

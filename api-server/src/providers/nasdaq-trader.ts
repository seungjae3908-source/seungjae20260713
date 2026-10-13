import { classifyAssetType, type AssetType } from '../data/asset-type';

export const NASDAQ_DIRECTORY_URLS = Object.freeze([
  'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
  'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
] as const);
const MAX_SOURCE_AGE_MS = 7 * 24 * 60 * 60_000;
const SOURCE_TIMEOUT_MS = 8_000;
const MAX_DIRECTORY_CHARACTERS = 8_000_000;

export interface NasdaqDirectoryEntry {
  ticker: string;
  name: string;
  market: 'US';
  currency: 'USD';
  assetType: AssetType;
  exchange: 'NASDAQ' | 'NYSE' | 'AMEX' | 'US';
  listingStatus: 'LISTED';
  source: 'nasdaq-trader-public-directory';
  rawType: string;
  sourceAsOf: string;
}
export interface NasdaqDirectorySnapshot {
  entries: NasdaqDirectoryEntry[];
  rawTotalCount: number;
  exclusionReasons: Record<string, number>;
  sourceAsOf: string;
}

// The official footer is an America/New_York wall clock, not UTC or the
// request's completion time. It proves source timeliness, not PIT history.
function footerTimestamp(line: string, nowMs: number): number {
  const match = /^File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):?(\d{2})(?:\|.*)?$/.exec(line);
  if (!match) throw new Error('NASDAQ_DIRECTORY_FOOTER_INVALID');
  const [, month, day, year, hour, minute] = match;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const date = new Date(wall);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59) {
    throw new Error('NASDAQ_DIRECTORY_FOOTER_INVALID');
  }
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let at = wall;
  for (let i = 0; i < 3; i++) {
    const parts = new Map(formatter.formatToParts(new Date(at)).map(p => [p.type, p.value]));
    const observedWall = Date.UTC(Number(parts.get('year')), Number(parts.get('month')) - 1,
      Number(parts.get('day')), Number(parts.get('hour')), Number(parts.get('minute')));
    const correction = wall - observedWall;
    at += correction;
    if (correction === 0) break;
    if (i === 2) throw new Error('NASDAQ_DIRECTORY_FOOTER_INVALID');
  }
  if (!Number.isFinite(nowMs) || at > nowMs + 5 * 60_000 || nowMs - at > MAX_SOURCE_AGE_MS) {
    throw new Error('NASDAQ_DIRECTORY_SOURCE_STALE_OR_FUTURE');
  }
  return at;
}

export function parseNasdaqDirectoryPair(nasdaqText: string, otherText: string, nowMs = Date.now()): NasdaqDirectorySnapshot {
  const entries: NasdaqDirectoryEntry[] = [];
  const exclusionReasons: Record<string, number> = {};
  const exclude = (reason: string) => { exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1; };
  let rawTotalCount = 0;
  const sourceTimes: number[] = [];
  for (const [index, text] of [nasdaqText, otherText].entries()) {
    if (typeof text !== 'string' || text.length > MAX_DIRECTORY_CHARACTERS) throw new Error('NASDAQ_DIRECTORY_BAD_RESPONSE');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim().length > 0);
    const headers = lines[0]?.split('|') ?? [];
    const symbolHeader = index === 0 ? 'Symbol' : 'ACT Symbol';
    const required = [symbolHeader, 'Security Name', 'Test Issue', 'ETF', ...(index === 0 ? ['Financial Status'] : ['Exchange'])];
    if (lines.length < 3 || new Set(headers).size !== headers.length || required.some(h => !headers.includes(h))) {
      throw new Error('NASDAQ_DIRECTORY_SCHEMA_INVALID');
    }
    const footers = lines.filter(line => line.startsWith('File Creation Time'));
    if (footers.length !== 1 || lines.at(-1) !== footers[0]) throw new Error('NASDAQ_DIRECTORY_FOOTER_INVALID');
    const sourceAt = footerTimestamp(footers[0], nowMs);
    sourceTimes.push(sourceAt);
    for (const line of lines.slice(1, -1)) {
      const cells = line.split('|');
      if (cells.length !== headers.length) throw new Error('NASDAQ_DIRECTORY_ROW_INVALID');
      const row = Object.fromEntries(headers.map((h, i) => [h, cells[i].trim()]));
      if (!['Y', 'N'].includes(row['Test Issue']) || !['Y', 'N'].includes(row.ETF)) {
        throw new Error('NASDAQ_DIRECTORY_ROW_INVALID');
      }
      rawTotalCount++;
      if (row['Test Issue'] === 'Y') { exclude('TEST_ISSUE'); continue; }
      const ticker = row[symbolHeader].toUpperCase().replace(/\$/g, '-');
      const name = row['Security Name'];
      if (!ticker || ticker.length > 15 || !/^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker)) {
        exclude('SYMBOL_UNSUPPORTED'); continue;
      }
      if (!name) throw new Error('NASDAQ_DIRECTORY_ROW_INVALID');
      if (/\b(?:WARRANTS?|RIGHTS?|UNITS?)\b/i.test(name)) { exclude('UNSUPPORTED_SECURITY_TYPE'); continue; }
      entries.push({ ticker, name, market: 'US', currency: 'USD',
        assetType: row.ETF === 'Y' ? 'ETF' : classifyAssetType(name, 'US'),
        exchange: index === 0 ? 'NASDAQ' : row.Exchange === 'N' ? 'NYSE' : ['A', 'P', 'Z'].includes(row.Exchange) ? 'AMEX' : 'US',
        listingStatus: 'LISTED', source: 'nasdaq-trader-public-directory',
        // Listing is not permission to trade. Preserve financial-status facts;
        // the downstream scanner still applies independent risk/data gates.
        rawType: `NASDAQ_DIRECTORY;ETF=${row.ETF};FINANCIAL_STATUS=${row['Financial Status'] ?? 'UNKNOWN'}`,
        sourceAsOf: new Date(sourceAt).toISOString() });
    }
  }
  const unique = new Map<string, NasdaqDirectoryEntry>();
  for (const entry of entries) {
    if (unique.has(entry.ticker)) { exclude('DUPLICATE_SYMBOL'); continue; }
    unique.set(entry.ticker, entry);
  }
  return { entries: [...unique.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    rawTotalCount, exclusionReasons, sourceAsOf: new Date(Math.min(...sourceTimes)).toISOString() };
}

export async function fetchNasdaqDirectoryPair(parent?: AbortSignal): Promise<NasdaqDirectorySnapshot> {
  if (parent?.aborted) throw parent.reason ?? new Error('US_UNIVERSE_ABORTED');
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error('US_UNIVERSE_ABORTED'));
  parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('NASDAQ_DIRECTORY_TIMEOUT')), SOURCE_TIMEOUT_MS);
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
  });
  try {
    const texts = await Promise.race([Promise.all(NASDAQ_DIRECTORY_URLS.map(async url => {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/plain' } });
      if (!response.ok) throw new Error(`NASDAQ_DIRECTORY_HTTP_${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_DIRECTORY_CHARACTERS) throw new Error('NASDAQ_DIRECTORY_TOO_LARGE');
      return response.text();
    })), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    const snapshot = parseNasdaqDirectoryPair(texts[0], texts[1]);
    // Anomaly guards only. A large current directory is NOT all-history/PIT
    // coverage, provider candle support, or a profitability/ordering approval.
    if (snapshot.entries.filter(e => e.exchange === 'NASDAQ').length < 100
      || snapshot.entries.filter(e => e.exchange !== 'NASDAQ').length < 100
      || snapshot.entries.length < 1_000) throw new Error('NASDAQ_DIRECTORY_PAIR_INCOMPLETE');
    return snapshot;
  } finally { clearTimeout(timeout); removeAbort(); parent?.removeEventListener('abort', abort); controller.abort(); }
}

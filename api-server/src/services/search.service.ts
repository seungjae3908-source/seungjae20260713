import {
  MarketDataService,
  type QuoteRow,
  type SearchResult,
} from './market-data.service';
import {
  LastGoodCache,
  OperationTimeoutError,
  SingleFlight,
  mapWithConcurrency,
  withTimeout,
} from '../lib/async-control';

export interface StableSearchResponse<T> {
  results: T[];
  updatedAt: string;
  partial: boolean;
  source: 'live' | 'partial-live' | 'last-good' | 'catalog';
  warnings: string[];
}

const searchFlights = new SingleFlight<string, StableSearchResponse<SearchResult>>();
const quoteFlights = new SingleFlight<string, StableSearchResponse<QuoteRow>>();
const searchLastGood = new LastGoodCache<
  string,
  StableSearchResponse<SearchResult>
>({
  maximumEntries: 200,
  defaultMaxAgeMs: 30 * 60_000,
});
const quoteLastGood = new LastGoodCache<
  string,
  StableSearchResponse<QuoteRow>
>({
  maximumEntries: 200,
  defaultMaxAgeMs: 30 * 60_000,
});
const quoteProgress = new Map<string, QuoteRow[]>();

const LAST_GOOD_MAX_AGE_MS = 30 * 60_000;

function boundedEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizedQuery(value: string): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

function boundedLimit(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function uniqueQuoteRows(rows: QuoteRow[]): QuoteRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.market}:${row.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(row.price) && row.price > 0;
  });
}

function warningFor(error: unknown, timeoutCode: string, errorCode: string) {
  return error instanceof OperationTimeoutError ? timeoutCode : errorCode;
}

function sourceForSearchResult(
  partial: boolean,
  warnings: readonly string[],
): StableSearchResponse<SearchResult>['source'] {
  if (!partial) return 'live';
  if (warnings.some((warning) => warning.includes('LAST_GOOD'))) {
    return 'last-good';
  }
  if (warnings.some((warning) => warning.includes('CATALOG_FALLBACK'))) {
    return 'catalog';
  }
  return 'partial-live';
}

async function loadSearch(
  query: string,
  limit: number,
  key: string,
): Promise<StableSearchResponse<SearchResult>> {
  const result = await MarketDataService.searchWithMeta(query, limit);
  const response: StableSearchResponse<SearchResult> = {
    results: result.results,
    updatedAt: new Date().toISOString(),
    partial: result.partial,
    source: sourceForSearchResult(result.partial, result.warnings),
    warnings: result.warnings,
  };
  if (!result.partial) {
    searchLastGood.set(key, response);
  }
  return response;
}

async function searchSymbols(
  rawQuery: string,
  requestedLimit = 80,
): Promise<StableSearchResponse<SearchResult>> {
  const query = normalizedQuery(rawQuery);
  const limit = boundedLimit(requestedLimit, 80, 500);
  const key = `${query.toLocaleLowerCase('ko-KR')}:${limit}`;
  const timeoutMs = boundedEnv('SEARCH_TIMEOUT_MS', 3_000, 500, 10_000);
  const pending = searchFlights.run(key, () => loadSearch(query, limit, key));

  try {
    return await withTimeout(pending, timeoutMs, 'market search');
  } catch (error) {
    const warning = warningFor(
      error,
      'SEARCH_TIMEOUT',
      'SEARCH_PROVIDER_ERROR',
    );
    const cached = searchLastGood.get(key, LAST_GOOD_MAX_AGE_MS);
    if (cached) {
      return {
        ...cached.value,
        partial: true,
        source: 'last-good',
        warnings: Array.from(new Set([...cached.value.warnings, warning])),
      };
    }

    return {
      results: MarketDataService.searchLocal(query, limit),
      updatedAt: new Date().toISOString(),
      partial: true,
      source: 'catalog',
      warnings: [warning, 'LOCAL_CATALOG_FALLBACK'],
    };
  }
}

async function loadQuotes(
  key: string,
  symbols: StableSearchResponse<SearchResult>,
): Promise<StableSearchResponse<QuoteRow>> {
  const maxMatches = boundedEnv('SEARCH_QUOTES_MAX', 40, 10, 100);
  const concurrency = boundedEnv('SEARCH_QUOTES_CONCURRENCY', 6, 1, 12);
  const quoteTimeoutMs = boundedEnv(
    'SEARCH_QUOTE_TIMEOUT_MS',
    1_800,
    300,
    5_000,
  );
  const tickers = Array.from(
    new Set(symbols.results.slice(0, maxMatches).map((item) => item.ticker)),
  );
  const collected: QuoteRow[] = [];
  quoteProgress.set(key, collected);

  try {
    const settled = await mapWithConcurrency(
      tickers,
      concurrency,
      async (ticker) => {
        const row = await withTimeout(
          MarketDataService.getQuoteRow(ticker),
          quoteTimeoutMs,
          `quote ${ticker}`,
        );
        if (row) collected.push(row);
        return row;
      },
    );
    const failed = settled.filter(
      (item) => item.status === 'rejected' || item.value == null,
    ).length;
    const rows = uniqueQuoteRows(collected);
    if (tickers.length > 0 && rows.length === 0) {
      throw new Error(`QUOTE_PROVIDER_UNAVAILABLE:${failed}`);
    }
    const partial = symbols.partial || failed > 0;
    const warnings = [
      ...symbols.warnings,
      ...(failed > 0 ? [`QUOTE_PARTIAL_FAILURE:${failed}`] : []),
    ];
    const response: StableSearchResponse<QuoteRow> = {
      results: rows,
      updatedAt: new Date().toISOString(),
      partial,
      source: partial ? 'partial-live' : 'live',
      warnings,
    };
    if (rows.length > 0 || tickers.length === 0) {
      quoteLastGood.set(key, response);
    }
    return response;
  } finally {
    quoteProgress.delete(key);
  }
}

async function searchQuotes(
  rawQuery: string,
  requestedLimit = 100,
): Promise<StableSearchResponse<QuoteRow>> {
  const query = normalizedQuery(rawQuery);
  const limit = boundedLimit(requestedLimit, 100, 100);
  const key = `${query.toLocaleLowerCase('ko-KR')}:${limit}`;
  const timeoutMs = boundedEnv(
    'SEARCH_QUOTES_TIMEOUT_MS',
    5_000,
    1_000,
    15_000,
  );
  const startedAt = Date.now();
  const symbols = await searchSymbols(query, limit);
  const pending = quoteFlights.run(key, () => loadQuotes(key, symbols));
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));

  try {
    return await withTimeout(pending, remainingMs, 'quote search');
  } catch (error) {
    const warning = warningFor(
      error,
      'QUOTE_SEARCH_TIMEOUT',
      'QUOTE_SEARCH_PROVIDER_ERROR',
    );
    const partialRows = uniqueQuoteRows([...(quoteProgress.get(key) ?? [])]);
    if (partialRows.length > 0) {
      return {
        results: partialRows,
        updatedAt: new Date().toISOString(),
        partial: true,
        source: 'partial-live',
        warnings: Array.from(new Set([...symbols.warnings, warning])),
      };
    }

    const cached = quoteLastGood.get(key, LAST_GOOD_MAX_AGE_MS);
    if (cached) {
      return {
        ...cached.value,
        partial: true,
        source: 'last-good',
        warnings: Array.from(new Set([...cached.value.warnings, warning])),
      };
    }

    return {
      results: [],
      updatedAt: new Date().toISOString(),
      partial: true,
      source: 'catalog',
      warnings: Array.from(
        new Set([...symbols.warnings, warning, 'NO_QUOTE_FALLBACK_AVAILABLE']),
      ),
    };
  }
}

export const SearchService = {
  searchSymbols,
  searchQuotes,
  getDiagnostics: () => ({
    searchFlights: searchFlights.size,
    quoteFlights: quoteFlights.size,
    searchLastGood: searchLastGood.size,
    quoteLastGood: quoteLastGood.size,
    quoteProgress: quoteProgress.size,
  }),
};

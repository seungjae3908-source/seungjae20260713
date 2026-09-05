import { Router, type IRouter } from 'express';
import {
  collectStockNewsDisclosureIntelligence,
  type StockNewsDisclosureIntelligenceInput,
  type StockNewsDisclosureIntelligenceOptions,
  type StockNewsDisclosureIntelligenceResult,
} from '../services/news-disclosure-market-intelligence.service';

type Collector = (
  input: StockNewsDisclosureIntelligenceInput,
  options?: StockNewsDisclosureIntelligenceOptions,
) => Promise<StockNewsDisclosureIntelligenceResult>;

type Dependencies = {
  collect?: Collector;
  now?: () => number;
};

type CacheEntry = {
  expiresAt: number;
  value: StockNewsDisclosureIntelligenceResult;
};

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const completed = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<StockNewsDisclosureIntelligenceResult>>();

function marketValue(value: unknown): 'KR' | 'US' | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === 'KR' || normalized === 'US' ? normalized : null;
}

function tickerValue(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '').slice(0, 40);
}

function safeResult(result: StockNewsDisclosureIntelligenceResult): boolean {
  return result.safety.publicEvidenceOnly === true
    && result.safety.generatedFactsAllowed === false
    && result.safety.executionAuthority === 'NONE'
    && result.safety.orderAllowed === false;
}

function prune(now: number): void {
  for (const [key, entry] of completed) {
    if (entry.expiresAt <= now) completed.delete(key);
  }
  while (completed.size > MAX_CACHE_ENTRIES) {
    const oldest = completed.keys().next().value as string | undefined;
    if (!oldest) break;
    completed.delete(oldest);
  }
}

async function load(
  key: string,
  input: StockNewsDisclosureIntelligenceInput,
  collect: Collector,
  now: () => number,
): Promise<{ result: StockNewsDisclosureIntelligenceResult; cache: 'HIT' | 'MISS' | 'IN_FLIGHT_REUSE' }> {
  const current = now();
  prune(current);
  const cached = completed.get(key);
  if (cached && cached.expiresAt > current) return { result: cached.value, cache: 'HIT' };

  const existing = inFlight.get(key);
  if (existing) return { result: await existing, cache: 'IN_FLIGHT_REUSE' };

  const shared = collect(input)
    .then((result) => {
      if (!safeResult(result)) throw new Error('MARKET_INTELLIGENCE_UNSAFE_RESPONSE');
      completed.set(key, { value: result, expiresAt: now() + CACHE_TTL_MS });
      prune(now());
      return result;
    })
    .finally(() => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    });
  inFlight.set(key, shared);
  return { result: await shared, cache: 'MISS' };
}

export function clearChartMarketIntelligenceCacheForTests(): void {
  completed.clear();
  inFlight.clear();
}

export function createMarketIntelligenceNewsDisclosureRouter(dependencies: Dependencies = {}): IRouter {
  const router: IRouter = Router();
  const collect = dependencies.collect ?? collectStockNewsDisclosureIntelligence;
  const now = dependencies.now ?? Date.now;

  router.get('/market-intelligence/news-disclosure', async (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=30');
    const market = marketValue(req.query.market);
    const ticker = tickerValue(req.query.ticker);
    if (!market) return res.status(400).json({ ok: false, error: 'MARKET_REQUIRED' });
    if (!ticker) return res.status(400).json({ ok: false, error: 'TICKER_REQUIRED' });

    const key = `${market}:${ticker}:CHART:v1`;
    try {
      const loaded = await load(key, {
        ticker,
        market,
        analysisScope: 'CHART',
        maxEvents: 5,
        maxAiEvents: 1,
      }, collect, now);
      return res.json({
        ok: true,
        available: loaded.result.status !== 'NOT_AVAILABLE',
        cache: loaded.cache,
        result: loaded.result,
        chartPolicy: {
          evidenceOnly: true,
          scoreImpact: 0,
          probabilityImpact: 0,
          sentimentIsPriceDirection: false,
          executionAuthority: 'NONE',
          orderAllowed: false,
          maxAiEvents: 1,
          serverCacheTtlMs: CACHE_TTL_MS,
        },
      });
    } catch (error) {
      console.error('market intelligence chart evidence route failed:', error);
      return res.status(502).json({
        ok: false,
        available: false,
        error: 'MARKET_INTELLIGENCE_NEWS_DISCLOSURE_UNAVAILABLE',
        result: null,
        chartPolicy: {
          evidenceOnly: true,
          scoreImpact: 0,
          probabilityImpact: 0,
          sentimentIsPriceDirection: false,
          executionAuthority: 'NONE',
          orderAllowed: false,
          maxAiEvents: 1,
        },
      });
    }
  });

  return router;
}

export default createMarketIntelligenceNewsDisclosureRouter();

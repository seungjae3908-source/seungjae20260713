import fs from 'node:fs';
import path from 'node:path';
import { Router, type IRouter } from 'express';
import * as naver from '../providers/naver';
import * as yahoo from '../providers/yahoo';
import {
  clearApiResilienceCache,
  getApiResilienceSnapshot,
  resilientCall,
} from '../lib/api-resilience';

const router: IRouter = Router();

function normalizeTicker(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function isKrTicker(ticker: string) {
  return /^\d{6}$/.test(ticker);
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }

  return {
    message: String(error),
  };
}

function safeRead(filePath: string) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');

    return {
      exists: true,
      path: filePath,
      length: text.length,
      hasOldStooqMarker: text.includes('STOOQ_HTTP_'),
      hasNewYahooMarker: text.includes('YAHOO_PROVIDER_MARKER_20260711'),
      hasYahooChartHttpMarker: text.includes('YAHOO_CHART_HTTP_'),
      first300: text.slice(0, 300),
    };
  } catch (error) {
    return {
      exists: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validQuote(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const price = Number(row.price ?? row.currentPrice ?? row.regularMarketPrice ?? 0);
  return Number.isFinite(price) && price > 0;
}

async function testOneTicker(ticker: string) {
  const clean = normalizeTicker(ticker);

  const result: any = {
    ticker: clean,
    marketGuess: isKrTicker(clean) ? 'KR' : 'US',
    naver: null,
    yahoo: null,
  };

  if (isKrTicker(clean)) {
    try {
      const response = await resilientCall({
        provider: 'naver',
        key: `debug-quote:${clean}`,
        operation: () => naver.getQuote(clean),
        timeoutMs: 5_000,
        retries: 1,
        cacheTtlMs: 3_000,
        staleTtlMs: 60_000,
        validate: validQuote,
      });

      result.naver = {
        ok: true,
        source: response.source,
        isStale: response.isStale,
        fetchedAt: response.fetchedAt,
        staleAgeMs: response.staleAgeMs,
        quote: response.value,
      };
    } catch (error) {
      result.naver = {
        ok: false,
        error: errorToJson(error),
      };
    }
  } else {
    result.naver = {
      ok: false,
      skipped: 'NAVER_ONLY_FOR_KR_TICKER',
    };
  }

  try {
    const response = await resilientCall({
      provider: 'yahoo',
      key: `debug-quote:${clean}`,
      operation: () => yahoo.getQuote(clean),
      timeoutMs: 5_000,
      retries: 1,
      cacheTtlMs: 3_000,
      staleTtlMs: 60_000,
      validate: validQuote,
    });

    result.yahoo = {
      ok: true,
      source: response.source,
      isStale: response.isStale,
      fetchedAt: response.fetchedAt,
      staleAgeMs: response.staleAgeMs,
      quote: response.value,
    };
  } catch (error) {
    result.yahoo = {
      ok: false,
      error: errorToJson(error),
    };
  }

  return result;
}

// GET /api/debug/provider?tickers=005930,000660,NVDA,AAPL
router.get('/provider', async (req, res) => {
  const raw = String(req.query.tickers ?? req.query.ticker ?? '005930,NVDA');
  const tickers = raw
    .split(',')
    .map((ticker) => normalizeTicker(ticker))
    .filter(Boolean)
    .slice(0, 20);

  const results = await Promise.all(tickers.map((ticker) => testOneTicker(ticker)));

  res.json({
    ok: true,
    testedAt: new Date().toISOString(),
    cwd: process.cwd(),
    results,
    resilience: getApiResilienceSnapshot(),
  });
});

// GET /api/debug/resilience
router.get('/resilience', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    ...getApiResilienceSnapshot(),
  });
});

// POST /api/debug/resilience/cache/clear?provider=naver
router.post('/resilience/cache/clear', (req, res) => {
  const provider = String(req.query.provider ?? '').trim() || undefined;
  const removed = clearApiResilienceCache(provider);
  res.json({
    ok: true,
    provider: provider ?? 'all',
    removed,
    clearedAt: new Date().toISOString(),
  });
});

// GET /api/debug/source-check
router.get('/source-check', (_req, res) => {
  const cwd = process.cwd();

  const sourceYahooPath = path.resolve(cwd, 'src/providers/yahoo.ts');
  const sourceNaverPath = path.resolve(cwd, 'src/providers/naver.ts');
  const sourceMarketPath = path.resolve(cwd, 'src/routes/market.ts');
  const sourceProviderDebugPath = path.resolve(cwd, 'src/routes/provider-debug.ts');
  const sourceIndexPath = path.resolve(cwd, 'src/routes/index.ts');
  const distPath = path.resolve(cwd, 'dist/index.mjs');
  const packagePath = path.resolve(cwd, 'package.json');

  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    cwd,
    files: {
      packageJson: safeRead(packagePath),
      sourceYahoo: safeRead(sourceYahooPath),
      sourceNaver: safeRead(sourceNaverPath),
      sourceMarket: safeRead(sourceMarketPath),
      sourceProviderDebug: safeRead(sourceProviderDebugPath),
      sourceIndex: safeRead(sourceIndexPath),
      distIndex: safeRead(distPath),
    },
  });
});

export default router;

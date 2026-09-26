import fs from 'node:fs';
import path from 'node:path';
import { Router, type IRouter } from 'express';
import * as naver from '../providers/naver';
import * as yahoo from '../providers/yahoo';

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
      const naverQuote = await naver.getQuote(clean);

      result.naver = {
        ok: true,
        quote: naverQuote,
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
    const yahooQuote = await yahoo.getQuote(clean);

    result.yahoo = {
      ok: true,
      quote: yahooQuote,
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
    .filter(Boolean);

  const results = await Promise.all(tickers.map((ticker) => testOneTicker(ticker)));

  res.json({
    ok: true,
    testedAt: new Date().toISOString(),
    cwd: process.cwd(),
    results,
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
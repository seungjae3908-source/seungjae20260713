import type { Plugin } from 'vite';

function patchBottomNav(source: string): string {
  let code = source;

  code = code.replace(
    "  { label: '해외 증시현황', href: '/analysis/us?from=info' },\n];",
    "  { label: '해외 증시현황', href: '/analysis/us?from=info' },\n  { label: '코인 증시현황', href: '/analysis/coin?from=info' },\n];",
  );

  code = code.replace(
    `    if (href.startsWith('/stock-info?')) {
      window.location.assign(href);
      return;
    }`,
    `    if (href.startsWith('/stock-info?')) {
      navigate(href, { replace: true });
      return;
    }`,
  );

  return code;
}

function patchStockInfo(source: string): string {
  let code = source;

  if (!code.includes('function infoArrayRows(')) {
    code = code.replace(
      'function finite(value: unknown): number | null {',
      `function infoArrayRows(value: unknown, keys: string[] = []): AnyObj[] {
\tif (Array.isArray(value)) return value as AnyObj[];
\tif (!value || typeof value !== 'object') return [];
\tconst record = value as AnyObj;
\tfor (const key of keys) {
\t\tif (Array.isArray(record[key])) return record[key] as AnyObj[];
\t}
\tfor (const key of ['items', 'rows', 'data', 'markets', 'tickers']) {
\t\tif (Array.isArray(record[key])) return record[key] as AnyObj[];
\t}
\treturn [];
}

function finite(value: unknown): number | null {`,
    );
  }

  code = code.replaceAll(
    'window.location.assign(`/stock-info?${params.toString()}`);',
    'navigate(`/stock-info?${params.toString()}`, { replace: true });',
  );
  code = code.replace(
    'window.location.assign(`${basePath}?${next.toString()}`);',
    'navigate(`${basePath}?${next.toString()}`, { replace: true });',
  );

  code = code.replace(
    '<CoinInfo key={`coin:${coinMarket}`} nowMs={nowMs} basePath="/stock-info" />',
    '<CoinInfo key={`coin:${coinMarket}:${location}`} nowMs={nowMs} basePath="/stock-info" />',
  );
  code = code.replace(
    '<main key={`stock:${market}`} className="space-y-4 px-4 pb-28 pt-4">',
    '<main key={`stock:${market}:${location}`} className="space-y-4 px-4 pb-28 pt-4">',
  );

  code = code.replace(
    /const marketNames = new Map<string, AnyObj>\([\s\S]*?const futureRows = \(futuresTickers\.data\?\.tickers \?\? \[\]\) as AnyObj\[\];/,
    `const spotMarketRows = infoArrayRows(spotMarkets.data, ['markets']);
\tconst spotTickerRows = infoArrayRows(spotTickers.data, ['tickers']);
\tconst futuresRows = infoArrayRows(futuresTickers.data, ['tickers']);
\tconst marketNames = new Map<string, AnyObj>(
\t\tspotMarketRows.map((item): [string, AnyObj] => [String(item.symbol), item]),
\t);
\tconst spotRows = spotTickerRows.map((item) => ({ ...item, ...(marketNames.get(String(item.symbol)) ?? {}) }));
\tconst futureRows = futuresRows;`,
  );

  code = code.replace(
    'items={coinSpecialFeed.data?.items ?? []}',
    "items={infoArrayRows(coinSpecialFeed.data, ['items']) as SpecialFeedItem[]}",
  );

  return code;
}

function patchMarketAnalysis(source: string): string {
  return source.replace(
    /\s*<span className="mt-1 block text-center text-\[10px\] font-bold text-muted-foreground">\s*눌러서 상세 보기\s*<\/span>/g,
    '',
  );
}

function patchPortfolioChild(source: string): string {
  let code = source;

  code = code.replace(
    'className="grid grid-cols-[40px_1fr_40px] items-center gap-3"',
    'className="relative flex min-h-[58px] items-center justify-center px-12 text-center"',
  );
  code = code.replace(
    'className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"',
    'className="absolute left-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"',
  );
  code = code.replace(
    '<div className="text-center">',
    '<div className="min-w-0 text-center">',
  );
  code = code.replace(
    '<h1 className="text-lg font-extrabold">',
    '<h1 className="whitespace-nowrap text-center text-lg font-extrabold">',
  );
  code = code.replace(
    'className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"',
    'className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"',
  );

  return code;
}

export function infoTabFinalScopePatch(): Plugin {
  return {
    name: 'info-tab-final-scope-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/components/bottom-nav.tsx')) code = patchBottomNav(code);
      if (normalized.endsWith('/src/pages/stock-info.tsx')) code = patchStockInfo(code);
      if (normalized.endsWith('/src/pages/market-analysis.tsx')) code = patchMarketAnalysis(code);
      if (
        normalized.endsWith('/src/pages/portfolio-cash.tsx') ||
        normalized.endsWith('/src/pages/portfolio-simulate.tsx') ||
        normalized.endsWith('/src/pages/portfolio-plan.tsx')
      ) code = patchPortfolioChild(code);

      return code === source ? null : { code, map: null };
    },
  };
}

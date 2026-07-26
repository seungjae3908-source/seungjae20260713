import type { Plugin } from 'vite';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function centerSimpleHeader(source: string, title: string): string {
  const titlePattern = new RegExp(`<h1 className="[^"]*">\\s*${escapeRegExp(title)}\\s*<\\/h1>`);
  const titleMatch = titlePattern.exec(source);
  if (!titleMatch) return source;

  const titleIndex = titleMatch.index;
  const start = source.lastIndexOf('<header', titleIndex);
  const close = source.indexOf('</header>', titleIndex);
  if (start < 0 || close < 0) return source;

  const end = close + '</header>'.length;
  let segment = source.slice(start, end);

  segment = segment.replace(
    /<header className="[^"]*">/,
    '<header className="relative flex min-h-[58px] w-full items-center justify-center px-12 text-center">',
  );

  let controlIndex = 0;
  segment = segment.replace(/className="[^"]*h-9 w-9[^"]*"/g, (match) => {
    const replacement = controlIndex === 0
      ? 'className="absolute left-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"'
      : controlIndex === 1
        ? 'className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"'
        : match;
    controlIndex += 1;
    return replacement;
  });

  segment = segment.replace(
    '<span className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card" />',
    '<span aria-hidden="true" className="absolute right-0 top-1/2 h-9 w-9 -translate-y-1/2" />',
  );

  segment = segment.replace(
    /<div className="(?:min-w-0\s+)?text-center">/,
    '<div className="min-w-0 text-center">',
  );
  segment = segment.replace(
    titlePattern,
    `<h1 className="whitespace-nowrap text-center text-lg font-extrabold">${title}</h1>`,
  );

  return source.slice(0, start) + segment + source.slice(end);
}

function patchStockDetailTitle(source: string): string {
  const titleIndex = source.indexOf('{companyName');
  if (titleIndex < 0) return source;
  const headerStart = source.lastIndexOf('<header', titleIndex);
  const headerEnd = source.indexOf('</header>', titleIndex);
  if (headerStart < 0 || headerEnd < 0) return source;

  let segment = source.slice(headerStart, headerEnd + '</header>'.length);
  segment = segment.replace(
    /<div className="min-w-0(?:\s+text-center)?">/,
    '<div className="absolute left-1/2 top-[30px] w-[calc(100%_-_184px)] -translate-x-1/2 -translate-y-1/2 text-center">',
  );
  segment = segment.replace(
    /<div className="flex min-w-0(?:\s+flex-wrap)? items-center(?:\s+justify-center)? gap-[^"]*">/,
    '<div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5">',
  );
  segment = segment.replace(
    /<h1 className="[^"]*">\{companyName(?:\s*\|\|\s*ticker)?\}<\/h1>/,
    '<h1 className="max-w-full break-keep text-center text-lg font-extrabold leading-tight">{companyName || ticker}</h1>',
  );
  segment = segment.replace(
    /<p className="mt-0\.5 text-\[11px\] font-bold text-muted-foreground">/,
    '<p className="mt-0.5 text-center text-[11px] font-bold text-muted-foreground">',
  );

  return source.slice(0, headerStart) + segment + source.slice(headerEnd + '</header>'.length);
}

function patchStockInfo(source: string): string {
  let code = source;

  code = code.replace(
    "const candles = (coinMarket === 'spot' ? spotCandles.data?.candles : futuresCandles.data?.candles) as AnyObj[] | undefined;",
    "const candles = infoArrayRows(coinMarket === 'spot' ? spotCandles.data : futuresCandles.data, ['candles']);",
  );
  code = code.replace(
    "((orderbook.data?.units ?? []) as AnyObj[]).slice(0, 15)",
    "infoArrayRows(orderbook.data, ['units']).slice(0, 15)",
  );

  return code;
}

function patchStocks(source: string): string {
  let code = source.replace(
    '`/market/movers?market=${mode.stockMarket}&_ts=${Date.now()}`',
    '`/market/movers?market=${mode.stockMarket}&limit=100&_ts=${Date.now()}`',
  );

  code = code.replace(
    `\t\tconst source =
\t\t\tcategory === 'volume'
\t\t\t\t? movers.data?.volume
\t\t\t\t: category === 'tradingValue'
\t\t\t\t\t? movers.data?.popular
\t\t\t\t\t: category === 'gainers'
\t\t\t\t\t\t? movers.data?.gainers
\t\t\t\t\t\t: category === 'losers'
\t\t\t\t\t\t\t? movers.data?.losers
\t\t\t\t\t\t\t: [
\t\t\t\t\t\t\t\t\t...((movers.data?.popular ?? []) as AnyObj[]),
\t\t\t\t\t\t\t\t\t...((movers.data?.volume ?? []) as AnyObj[]),
\t\t\t\t\t\t\t\t\t...((movers.data?.gainers ?? []) as AnyObj[]),
\t\t\t\t\t\t\t\t];`,
    `\t\tconst source =
\t\t\tcategory === 'marketCap'
\t\t\t\t? movers.data?.marketCap
\t\t\t\t: category === 'volume'
\t\t\t\t\t? movers.data?.volume
\t\t\t\t\t: category === 'tradingValue'
\t\t\t\t\t\t? movers.data?.popular
\t\t\t\t\t\t: category === 'gainers'
\t\t\t\t\t\t\t? movers.data?.gainers
\t\t\t\t\t\t\t: movers.data?.losers;`,
  );

  return code;
}

export function coinTechStocksFinalPatch(): Plugin {
  return {
    name: 'coin-tech-stocks-final-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/pages/stock-info.tsx')) code = patchStockInfo(code);
      if (normalized.endsWith('/src/pages/signal-scan.tsx')) code = centerSimpleHeader(code, '신호검색');
      if (normalized.endsWith('/src/pages/chart-relay.tsx')) code = centerSimpleHeader(code, '차트중계');
      if (normalized.endsWith('/src/pages/auto-trade.tsx')) code = centerSimpleHeader(code, '자동매매');
      if (normalized.endsWith('/src/pages/stocks.tsx')) code = patchStocks(code);
      if (normalized.endsWith('/src/pages/detail.tsx')) code = patchStockDetailTitle(code);

      return code === source ? null : { code, map: null };
    },
  };
}

import type { Plugin } from 'vite';

const MARKER = 'requested-current-batch-v1';

function patchApp(source: string): string {
  let code = source;

  if (!code.includes("const AssetEvaluationPage = lazy")) {
    code = code.replace(
      "const PortfolioPage = lazy(() => import('@/pages/portfolio'));",
      "const PortfolioPage = lazy(() => import('@/pages/portfolio'));\nconst AssetEvaluationPage = lazy(() => import('@/pages/asset-evaluation'));\nconst WatchlistAssetsPage = lazy(() => import('@/pages/watchlist-assets'));",
    );
  }

  if (!code.includes('function AdvancedAssetEvaluationPage()')) {
    code = code.replace(
      'function AdvancedPortfolioCashPage() {',
      `function AdvancedAssetEvaluationPage() {
\treturn (
\t\t<FeatureGate feature="advancedAnalysis">
\t\t\t<AssetEvaluationPage />
\t\t</FeatureGate>
\t);
}

function GatedWatchlistAssetsPage() {
\treturn (
\t\t<FeatureGate feature="watchlist">
\t\t\t<WatchlistAssetsPage />
\t\t</FeatureGate>
\t);
}

function AdvancedPortfolioCashPage() {`,
    );
  }

  if (!code.includes('path="/portfolio/summary"')) {
    code = code.replace(
      '<Route path="/watchlist" component={GatedWatchlistPage} />',
      '<Route path="/watchlist/assets" component={GatedWatchlistAssetsPage} />\n\t\t\t\t<Route path="/watchlist" component={GatedWatchlistPage} />',
    );
    code = code.replace(
      '<Route path="/portfolio/cash" component={AdvancedPortfolioCashPage} />',
      '<Route path="/portfolio/summary" component={AdvancedAssetEvaluationPage} />\n\t\t\t\t<Route path="/portfolio/cash" component={AdvancedPortfolioCashPage} />',
    );
  }

  if (!code.includes('requested-center-text')) {
    code = code.replace(
      '<AppBackground />',
      `<AppBackground />
\t\t\t<style>{\`.requested-center-text :where(h1,h2,h3,h4,p,span,label,button,input,textarea,select,th,td){text-align:center!important}.requested-center-text input,.requested-center-text textarea{justify-content:center}.requested-center-text [class*="text-left"]{text-align:center!important}\`}</style>`,
    );
    code = code.replace(
      'className="relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background"',
      'className="requested-center-text relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background"',
    );
  }

  return code;
}

function patchStockInfo(source: string): string {
  let code = source;

  code = code.replace(
    "const ticker = String(params.get('ticker') ?? '').toUpperCase();\n\treturn { asset, market, ticker };",
    "const coinMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';\n\tconst ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').toUpperCase();\n\treturn { asset, market, ticker, coinMarket };",
  );

  code = code.replace(
    "setWatchlisted(isInWatchlist(next.ticker));\n\t}, [location]);",
    "setWatchlisted(isInWatchlist(next.ticker));\n\t\tif (next.asset === 'coin') appMode.setCoinMarket(next.coinMarket);\n\t}, [location]);",
  );

  if (!code.includes('specialFeedIdentity')) {
    code = code.replace(
      'function groupUnique<T extends AnyObj>',
      `function specialFeedIdentity(item: SpecialFeedItem): string {
\treturn [item.kind, item.ticker, normalizeTitle(item.title), item.url ?? ''].join('|');
}

function groupUnique<T extends AnyObj>`,
    );
  }

  code = code.replace(
    'return [...items]\n\t\t\t.filter',
    'return Array.from(new Map(items.map((item) => [specialFeedIdentity(item), item])).values())\n\t\t\t.filter',
  );

  code = code.replace(
    'const pageCount = Math.max(1, Math.ceil(filteredItems.length / 10));',
    'const pageCount = Math.max(1, Math.ceil(filteredItems.length / 5));',
  );
  code = code.replace(
    'const modalItems = filteredItems.slice((page - 1) * 10, page * 10);',
    'const modalItems = filteredItems.slice((page - 1) * 5, page * 5);',
  );
  code = code.replace(
    'const visibleItems = filteredItems.slice(0, 10);',
    'const visibleItems = filteredItems.slice(0, 5);',
  );
  code = code.replace(
    'onClick={() => onFilter(key)}',
    'onClick={() => { onFilter(key); setPage(1); setMoreOpen(true); }}',
  );
  code = code.replace(
    'filteredItems.length > 10',
    'filteredItems.length > 5',
  );
  code = code.replace(
    '페이지당 10개',
    '페이지당 5개',
  );

  return code;
}

function patchLearn(source: string): string {
  return source
    .replace(
      'grid w-full grid-cols-[72px_minmax(0,1fr)_24px] items-center gap-3 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm transition active:scale-[0.99]',
      'grid w-full grid-cols-[48px_minmax(0,1fr)_20px] items-center gap-2 rounded-2xl border border-card-border bg-card p-3 text-center shadow-sm transition active:scale-[0.99]',
    )
    .replace('flex h-14 w-14 items-center justify-center rounded-2xl', 'flex h-10 w-10 items-center justify-center rounded-xl')
    .replace('<Icon className="h-7 w-7" />', '<Icon className="h-5 w-5" />')
    .replace('<p className="text-lg font-extrabold">{topic.title}</p>', '<p className="text-base font-extrabold">{topic.title}</p>')
    .replace('mt-1 break-keep text-sm font-semibold leading-relaxed', 'mt-1 break-keep text-xs font-semibold leading-relaxed');
}

function patchAutoTrade(source: string): string {
  let code = source.replace("  const [symbol, setSymbol] = useState('');\n", '');
  code = code.replace(
    /\n\s*<div className="mt-3">\s*<label[^>]*>\s*종목\s*<\/label>\s*<input[\s\S]*?value=\{symbol\}[\s\S]*?<\/div>/,
    '',
  );
  return code;
}

function patchPortfolio(source: string, normalized: string): string {
  let code = source;

  if (normalized.endsWith('/src/pages/portfolio.tsx')) {
    code = code.replace(
      "return `${Math.round(\n\t\tvalue,\n\t).toLocaleString()}원`;",
      "const scaled = value / 10_000;\n\tconst digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;\n\treturn `${scaled.toLocaleString('ko-KR', { maximumFractionDigits: digits })}만원`;",
    );
    code = code.replace(
      "return `${Math.round(value).toLocaleString()}원`;",
      "const scaled = value / 10_000;\n\tconst digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;\n\treturn `${scaled.toLocaleString('ko-KR', { maximumFractionDigits: digits })}만원`;",
    );
    code = code.replace(
      'value={`${Math.round(summary.krValue).toLocaleString()}원`}',
      'value={krw(summary.krValue)}',
    );
  }

  if (normalized.endsWith('/src/pages/portfolio-cash.tsx')) {
    code = code.replace(
      "if (currency === 'KRW') return `${Math.round(value).toLocaleString()}원`;",
      "if (currency === 'KRW') { const scaled = value / 10_000; return `${scaled.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2 })}만원`; }",
    );
    code = code.replace("KRW: '원화 (KRW)'", "KRW: '만원 (KRW)'");
  }

  if (normalized.endsWith('/src/pages/portfolio-simulate.tsx')) {
    code = code.replace(
      "if (market === 'KR') return `${Math.round(value).toLocaleString()}원`;",
      "if (market === 'KR') { const scaled = value / 10_000; return `${scaled.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2 })}만원`; }",
    );
  }

  if (normalized.endsWith('/src/pages/portfolio-plan.tsx')) {
    code = code.replace(
      "return `${Math.round(value).toLocaleString()}원`;",
      "const scaled = value / 10_000;\n\treturn `${scaled.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2 })}만원`;",
    );
    code = code.replaceAll('(원)', '(만원)');
  }

  return code;
}

export function currentRequestBatchPatch(): Plugin {
  return {
    name: MARKER,
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/App.tsx')) code = patchApp(code);
      if (normalized.endsWith('/src/pages/stock-info.tsx')) code = patchStockInfo(code);
      if (normalized.endsWith('/src/pages/learn.tsx')) code = patchLearn(code);
      if (normalized.endsWith('/src/pages/auto-trade.tsx')) code = patchAutoTrade(code);
      if (normalized.includes('/src/pages/portfolio')) code = patchPortfolio(code, normalized);

      return code === source ? null : { code, map: null };
    },
  };
}

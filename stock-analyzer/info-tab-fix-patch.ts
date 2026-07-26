import type { Plugin } from 'vite';

function patchBottomNav(source: string): string {
  let code = source;

  code = code.replace(
    "  | 'marketAnalysis'\n  | 'chartRelay'",
    "  | 'marketAnalysis'\n  | 'study'\n  | 'chartRelay'",
  );

  code = code.replace(
    "  { label: '공부', href: '/learn' },",
    "  { label: '공부', step: 'study' },",
  );
  code = code.replace(
    "  { label: '포트폴리오', href: '/portfolio/summary?asset=all&source=portfolio' },",
    "  { label: '포트폴리오', href: '/portfolio?from=info' },",
  );

  if (!code.includes('const STUDY_ITEMS: PopupItem[]')) {
    code = code.replace(
      "const MARKET_ANALYSIS_ITEMS: PopupItem[] = [",
      `const STUDY_ITEMS: PopupItem[] = [
  { label: '캔들·추세', href: '/learn?group=candle&from=info' },
  { label: '차트지표', href: '/learn?group=indicator&from=info' },
  { label: '매매신호', href: '/learn?group=signal&from=info' },
  { label: '재무제표', href: '/learn?group=financial&from=info' },
  { label: '가치지표', href: '/learn?group=value&from=info' },
];

const MARKET_ANALYSIS_ITEMS: PopupItem[] = [`,
    );
  }

  code = code.replace(
    "  { label: '국내 증시현황', href: '/analysis/KR' },\n  { label: '해외 증시현황', href: '/analysis/US' },",
    "  { label: '국내 증시현황', href: '/analysis/kr?from=info' },\n  { label: '해외 증시현황', href: '/analysis/us?from=info' },",
  );

  code = code.replace(
    "  if (step === 'marketAnalysis') return '증시현황';\n  return '정보 선택';",
    "  if (step === 'marketAnalysis') return '증시현황';\n  if (step === 'study') return '공부';\n  return '정보 선택';",
  );

  code = code.replace(
    "      if (step === 'marketAnalysis') return MARKET_ANALYSIS_ITEMS;\n      return INFO_MAIN_ITEMS;",
    "      if (step === 'marketAnalysis') return MARKET_ANALYSIS_ITEMS;\n      if (step === 'study') return STUDY_ITEMS;\n      return INFO_MAIN_ITEMS;",
  );

  code = code.replace(
    `  const goBack = () => {
    closePopup();
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate('/search', { replace: true });
  };`,
    `  const goBack = () => {
    closePopup();
    const current = splitLocation(location);
    const params = new URLSearchParams(current.query);
    if (params.get('from') === 'info' || params.get('source') === 'info') {
      navigate('/stock-info?asset=stock&market=KR&focused=1', { replace: true });
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate('/stock-info?asset=stock&market=KR&focused=1', { replace: true });
  };`,
  );

  return code;
}

function patchStockInfo(source: string): string {
  let code = source;

  if (!code.includes("const [coinMarket, setCoinMarket] = useState<CoinMarketTab>(initial.coinMarket);")) {
    code = code.replace(
      "\tconst [market, setMarket] = useState<MarketTab>(initial.market);",
      "\tconst [market, setMarket] = useState<MarketTab>(initial.market);\n\tconst [coinMarket, setCoinMarket] = useState<CoinMarketTab>(initial.coinMarket);",
    );
  }

  code = code.replace(
    "\t\tsetMarket(next.market);\n\t\tsetTicker(next.ticker);",
    "\t\tsetMarket(next.market);\n\t\tsetCoinMarket(next.coinMarket);\n\t\tsetTicker(next.ticker);",
  );

  code = code.replace(
    /\tfunction updateSelection\([\s\S]*?\n\t}\n\n\tconst search = useQuery\(/,
    `\tfunction updateSelection(next: Partial<{ asset: AssetTab; market: MarketTab; coinMarket: CoinMarketTab; ticker: string }>) {
\t\tconst nextAsset = next.asset ?? asset;
\t\tconst nextMarket = next.market ?? market;
\t\tconst nextCoinMarket = next.coinMarket ?? coinMarket;
\t\tconst assetChanged = nextAsset !== asset;
\t\tconst subMarketChanged = nextAsset === 'stock'
\t\t\t? nextMarket !== market
\t\t\t: nextCoinMarket !== coinMarket;
\t\tconst nextTicker = String(next.ticker ?? (assetChanged || subMarketChanged ? '' : ticker)).toUpperCase();

\t\tsetAsset(nextAsset);
\t\tsetMarket(nextMarket);
\t\tsetCoinMarket(nextCoinMarket);
\t\tsetTicker(nextTicker);
\t\tsetSearchText('');
\t\tsetWatchlisted(isInWatchlist(nextTicker));

\t\tappMode.setAsset(nextAsset);
\t\tif (nextAsset === 'stock') {
\t\t\tappMode.setStockMarket(nextMarket);
\t\t\tconst params = new URLSearchParams({ asset: 'stock', market: nextMarket, focused: '1' });
\t\t\tif (nextTicker) params.set('ticker', nextTicker);
\t\t\tnavigate(\`/stock-info?\${params.toString()}\`, { replace: true });
\t\t\treturn;
\t\t}

\t\tappMode.setCoinMarket(nextCoinMarket);
\t\tconst params = new URLSearchParams({ asset: 'coin', coinMarket: nextCoinMarket, focused: '1' });
\t\tif (nextTicker) params.set('symbol', nextTicker);
\t\tnavigate(\`/stock-info?\${params.toString()}\`, { replace: true });
\t}

\tconst search = useQuery(`,
  );

  code = code.replace(
    `\t\t\t\t{asset === 'stock' && (
\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">
\t\t\t\t\t\t<Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>
\t\t\t\t\t\t<Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>해외</Tab>
\t\t\t\t\t</div>
\t\t\t\t)}`,
    `\t\t\t\t{asset === 'stock' ? (
\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">
\t\t\t\t\t\t<Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>
\t\t\t\t\t\t<Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>해외</Tab>
\t\t\t\t\t</div>
\t\t\t\t) : (
\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">
\t\t\t\t\t\t<Tab active={coinMarket === 'spot'} onClick={() => updateSelection({ coinMarket: 'spot' })}>현물</Tab>
\t\t\t\t\t\t<Tab active={coinMarket === 'futures'} onClick={() => updateSelection({ coinMarket: 'futures' })}>선물</Tab>
\t\t\t\t\t</div>
\t\t\t\t)}`,
  );

  code = code
    .replace("navigate('/analysis/kr')", "navigate('/analysis/kr?from=info')")
    .replace("navigate('/analysis/us')", "navigate('/analysis/us?from=info')")
    .replace("navigate('/analysis/coin')", "navigate('/analysis/coin?from=info')")
    .replace("navigate('/portfolio')", "navigate('/portfolio?from=info')");

  code = code.replace(
    '<CoinInfo nowMs={nowMs} />',
    '<CoinInfo key={`coin:${coinMarket}`} nowMs={nowMs} basePath="/stock-info" />',
  );
  code = code.replace(
    '<main className="space-y-4 px-4 pb-28 pt-4">',
    '<main key={`stock:${market}`} className="space-y-4 px-4 pb-28 pt-4">',
  );

  code = code.replace(
    `\t\t\t\t<div className="grid grid-cols-2 gap-2">
\t\t\t\t\t<Tab active={coinMarket === 'spot'} onClick={() => changeCoin('spot')}>현물 · 업비트</Tab>
\t\t\t\t\t<Tab active={coinMarket === 'futures'} onClick={() => changeCoin('futures')}>선물 · 비트겟</Tab>
\t\t\t\t</div>
`,
    '',
  );

  return code;
}

function patchLearn(source: string): string {
  let code = source;

  if (!code.includes('function groupFromUrl()')) {
    code = code.replace(
      `function topicFromUrl() {
  return new URLSearchParams(window.location.search).get('topic');
}`,
      `function topicFromUrl() {
  return new URLSearchParams(window.location.search).get('topic');
}

function groupFromUrl(): StudyGroup | null {
  const value = new URLSearchParams(window.location.search).get('group');
  if (value === 'candle') return '캔들·추세';
  if (value === 'indicator') return '차트 지표';
  if (value === 'signal') return '매매 신호';
  if (value === 'financial') return '재무제표';
  if (value === 'value') return '가치 지표';
  return null;
}`,
    );
  }

  if (!code.includes('const requestedGroup = groupFromUrl();')) {
    code = code.replace(
      `  const [, navigate] = useLocation();
  const listRef = useRef<HTMLElement | null>(null);`,
      `  const [, navigate] = useLocation();
  const requestedGroup = groupFromUrl();
  const listRef = useRef<HTMLElement | null>(null);`,
    );
  }

  code = code.replace(
    '<h1 className="text-2xl font-extrabold">공부</h1>',
    '<h1 className="text-2xl font-extrabold">{requestedGroup ?? \'공부\'}</h1>',
  );
  code = code.replace(
    '{GROUPS.map((group) => {',
    '{GROUPS.filter((group) => !requestedGroup || group === requestedGroup).map((group) => {',
  );

  return code;
}

function patchMarketAnalysis(source: string): string {
  return source
    .replace(
      "const match = path.split('?')[0].match(/^\\/analysis\\/([a-z]+)/);",
      "const match = path.split('?')[0].match(/^\\/analysis\\/([a-zA-Z]+)/);",
    )
    .replace(
      "onClick={() => navigate('/stock-info')}",
      "onClick={() => navigate('/stock-info?asset=stock&market=KR&focused=1', { replace: true })}",
    );
}

function patchPortfolio(source: string): string {
  let code = source;
  if (code.includes('portfolio-info-entry-mode')) return code;

  code = code.replace(
    `\tconst assetMode = useAssetMode();`,
    `\tconst assetMode = useAssetMode();
\t// portfolio-info-entry-mode: 정보 메뉴에서 들어오면 이전 코인 상태를 이어받지 않고
\t// 원래의 전체 포트폴리오 기능(요약·현금·시뮬레이션·적립식·종목관리)을 표시한다.
\tuseEffect(() => {
\t\tconst params = new URLSearchParams(window.location.search);
\t\tif (params.get('from') !== 'info') return;
\t\tassetMode.setAsset('stock');
\t\tassetMode.setStockMarket('KR');
\t\t// eslint-disable-next-line react-hooks/exhaustive-deps
\t}, []);`,
  );

  return code;
}

export function infoTabFixPatch(): Plugin {
  return {
    name: 'info-tab-fix-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/components/bottom-nav.tsx')) code = patchBottomNav(code);
      if (normalized.endsWith('/src/pages/stock-info.tsx')) code = patchStockInfo(code);
      if (normalized.endsWith('/src/pages/learn.tsx')) code = patchLearn(code);
      if (normalized.endsWith('/src/pages/market-analysis.tsx')) code = patchMarketAnalysis(code);
      if (normalized.endsWith('/src/pages/portfolio.tsx')) code = patchPortfolio(code);

      return code === source ? null : { code, map: null };
    },
  };
}

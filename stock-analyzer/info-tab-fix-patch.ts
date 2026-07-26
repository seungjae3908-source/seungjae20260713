import type { Plugin } from 'vite';

function replaceBetween(source: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return source;
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchBottomNav(source: string): string {
  let code = source;

  if (!code.includes("  | 'study'")) {
    code = code.replace(
      "  | 'marketAnalysis'\n",
      "  | 'marketAnalysis'\n  | 'study'\n",
    );
  }

  code = code.replace(
    "  { label: '공부', href: '/learn' },",
    "  { label: '공부', step: 'study' },",
  );
  code = code.replace(
    /  \{ label: '포트폴리오', href: '[^']+'(?:, feature: 'portfolio')? \},/,
    "  { label: '포트폴리오', href: '/portfolio?from=info', feature: 'portfolio' },",
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
    `  const moveToPage = (href: string) => {
    closePopup();
    navigate(href);
  };`,
    `  const moveToPage = (href: string) => {
    closePopup();
    // 정보의 주식·코인은 같은 pathname에서 query만 바뀌므로
    // 완전한 새 화면으로 다시 열어 이전 자산 상태가 남지 않게 한다.
    if (href.startsWith('/stock-info?')) {
      window.location.assign(href);
      return;
    }
    navigate(href);
  };`,
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

  code = code.replace(
    "const ticker = String(params.get('ticker') ?? '').toUpperCase();\n\treturn { asset, market, ticker };",
    "const coinMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';\n\tconst ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').toUpperCase();\n\treturn { asset, market, ticker, coinMarket };",
  );

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
\t\t\twindow.location.assign(\`/stock-info?\${params.toString()}\`);
\t\t\treturn;
\t\t}

\t\tappMode.setCoinMarket(nextCoinMarket);
\t\tconst params = new URLSearchParams({ asset: 'coin', coinMarket: nextCoinMarket, focused: '1' });
\t\tif (nextTicker) params.set('symbol', nextTicker);
\t\twindow.location.assign(\`/stock-info?\${params.toString()}\`);
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

  code = code.replace(
    'navigate(`${basePath}?${next.toString()}`, { replace: true });',
    'window.location.assign(`${basePath}?${next.toString()}`);',
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

const PORTFOLIO_SUMMARY_COMPONENT = `function PortfolioSummaryCard({
\tsummary,
\tfxRate,
\tfxUpdatedAt,
\tcashMissing,
\tloading,
\tonRefresh,
}: {
\tsummary: ExtendedSummary;
\tfxRate: number | null;
\tfxUpdatedAt: string | null;
\tcashMissing: boolean;
\tloading: boolean;
\tonRefresh: () => void;
}) {
\tconst [open, setOpen] = useState(false);
\treturn (
\t\t<>
\t\t\t<button
\t\t\t\ttype="button"
\t\t\t\tonClick={() => setOpen(true)}
\t\t\t\tclassName="w-full rounded-3xl border border-card-border bg-card p-5 text-center shadow-sm"
\t\t\t>
\t\t\t\t<p className="text-center text-base font-black">포트폴리오 요약</p>
\t\t\t\t<p className="mt-2 text-center text-2xl font-black text-primary">{krw(summary.totalValueKrw)}</p>
\t\t\t\t<p className="mt-1 text-center text-[10px] font-bold text-muted-foreground">눌러서 전체 요약 보기</p>
\t\t\t</button>

\t\t\t{open && (
\t\t\t\t<div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="포트폴리오 요약">
\t\t\t\t\t<button type="button" aria-label="팝업 닫기" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/70" />
\t\t\t\t\t<section className="relative z-10 flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
\t\t\t\t\t\t<header className="relative flex min-h-[58px] items-center justify-center border-b border-card-border px-14 text-center">
\t\t\t\t\t\t\t<h2 className="text-center text-base font-black">포트폴리오 요약</h2>
\t\t\t\t\t\t\t<button type="button" onClick={onRefresh} disabled={loading} aria-label="새로고침" className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-secondary disabled:opacity-50">
\t\t\t\t\t\t\t\t<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t\t<button type="button" onClick={() => setOpen(false)} aria-label="닫기" className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-secondary text-xl font-black">×</button>
\t\t\t\t\t\t</header>
\t\t\t\t\t\t<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 text-center">
\t\t\t\t\t\t\t<p className="text-center text-[10px] font-bold text-muted-foreground">적용 환율(USD/KRW) {fxRate != null ? fxRate.toLocaleString() : '산출 불가'} · {formatKstTime(fxUpdatedAt)}</p>
\t\t\t\t\t\t\t<div className="mt-3 rounded-2xl bg-muted/60 p-4 text-center">
\t\t\t\t\t\t\t\t<p className="text-center text-[11px] font-bold text-muted-foreground">총자산(현금 포함, 원화 환산)</p>
\t\t\t\t\t\t\t\t<p className="mt-1 text-center text-2xl font-black">{krw(summary.totalValueKrw)}</p>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<div className="mt-3 grid grid-cols-2 gap-2 text-center">
\t\t\t\t\t\t\t\t<SummaryCell label="주식 평가 (국내 KRW)" value={krw(summary.krValue)} />
\t\t\t\t\t\t\t\t<SummaryCell label="주식 평가 (해외 USD)" value={\`$\${summary.usValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}\`} />
\t\t\t\t\t\t\t\t<SummaryCell label="주식 평가 (통합·원화)" value={krw(summary.stockValueKrw)} />
\t\t\t\t\t\t\t\t<SummaryCell label="코인 평가" value={summary.hasCoin ? \`\${summary.coinValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT\` : '보유 없음'} />
\t\t\t\t\t\t\t\t<SummaryCell label="전체 투자 원금(원화)" value={krw(summary.totalCostKrw)} />
\t\t\t\t\t\t\t\t<SummaryCell label="총손익(원화)" value={krw(summary.profitKrw)} tone={summary.profitKrw == null ? undefined : summary.profitKrw >= 0 ? 'up' : 'down'} />
\t\t\t\t\t\t\t\t<SummaryCell label="총수익률" value={pct(summary.rate)} tone={summary.rate == null ? undefined : summary.rate >= 0 ? 'up' : 'down'} />
\t\t\t\t\t\t\t\t<SummaryCell label="잔여 현금(원화)" value={krw(summary.cashKrw)} />
\t\t\t\t\t\t\t\t<SummaryCell label="추가 투자 가능(원화)" value={krw(summary.investableKrw)} />
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<div className="mt-3 rounded-2xl bg-muted/60 p-3 text-center">
\t\t\t\t\t\t\t\t<p className="text-center text-[11px] font-black">자산 비중</p>
\t\t\t\t\t\t\t\t{summary.weights ? (
\t\t\t\t\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-1 text-center text-[11px] font-bold">
\t\t\t\t\t\t\t\t\t\t<span>현금 {pct(summary.weights.cash)}</span><span>국내 {pct(summary.weights.kr)}</span><span>해외 {pct(summary.weights.us)}</span><span>코인 {pct(summary.weights.coin)}</span>
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t) : <p className="mt-1 text-center text-[11px] font-bold text-muted-foreground">환율 미확보 등으로 비중 산출 불가</p>}
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t{cashMissing && <p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">현금 설정 테이블이 없어 잔여 현금은 0으로 표시됩니다.</p>}
\t\t\t\t\t\t</div>
\t\t\t\t\t</section>
\t\t\t\t</div>
\t\t\t)}
\t\t</>
\t);
}

`;

const PORTFOLIO_NAV_CARD = `function NavCard({
\ttitle,
\tdesc,
\tonClick,
}: {
\ttitle: string;
\tdesc: string;
\tonClick: () => void;
}) {
\treturn (
\t\t<button
\t\t\ttype="button"
\t\t\tonClick={onClick}
\t\t\tclassName="grid w-full grid-cols-[24px_minmax(0,1fr)_24px] items-center gap-2 rounded-2xl border border-card-border bg-card p-4 text-center shadow-sm active:bg-muted"
\t\t>
\t\t\t<span aria-hidden="true" />
\t\t\t<span className="min-w-0 text-center">
\t\t\t\t<span className="block text-center text-sm font-black">{title}</span>
\t\t\t\t<span className="mt-1 block break-keep text-center text-[11px] font-semibold text-muted-foreground">{desc}</span>
\t\t\t</span>
\t\t\t<span className="flex justify-center text-muted-foreground">›</span>
\t\t</button>
\t);
}

`;

function patchPortfolio(source: string): string {
  let code = source;

  if (!code.includes('portfolio-info-entry-mode')) {
    code = code.replace(
      `\tconst assetMode = useAssetMode();`,
      `\tconst assetMode = useAssetMode();
\tconst infoEntry = new URLSearchParams(window.location.search).get('from') === 'info';
\t// portfolio-info-entry-mode: 정보 메뉴에서 들어오면 기존 포트폴리오 전체 기능을 표시한다.
\tuseEffect(() => {
\t\tif (!infoEntry) return;
\t\tassetMode.setAsset('stock');
\t\tassetMode.setStockMarket('KR');
\t\t// eslint-disable-next-line react-hooks/exhaustive-deps
\t}, []);`,
    );
  }

  code = code.replace(
    '<AssetSwitch className="mt-3" />',
    '{!infoEntry && <AssetSwitch className="mt-3" />}',
  );
  code = code.replace(
    "{assetMode.asset === 'coin' ? (",
    "{!infoEntry && assetMode.asset === 'coin' ? (",
  );

  code = code
    .replace("onClick={() => navigate('/portfolio/cash')}", "onClick={() => navigate('/portfolio/cash?from=info')}")
    .replace("onClick={() => navigate('/portfolio/simulate')}", "onClick={() => navigate('/portfolio/simulate?from=info')}")
    .replace("onClick={() => navigate('/portfolio/plan')}", "onClick={() => navigate('/portfolio/plan?from=info')}");

  code = replaceBetween(code, 'function PortfolioSummaryCard(', 'function SummaryCell(', PORTFOLIO_SUMMARY_COMPONENT);
  code = replaceBetween(code, 'function NavCard(', 'function HoldingValue(', PORTFOLIO_NAV_CARD);

  return code;
}

function patchPortfolioChild(source: string): string {
  return source.replace(
    "onClick={() => navigate('/portfolio')}",
    "onClick={() => navigate(new URLSearchParams(window.location.search).get('from') === 'info' ? '/portfolio?from=info' : '/portfolio')}",
  );
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
      if (
        normalized.endsWith('/src/pages/portfolio-cash.tsx') ||
        normalized.endsWith('/src/pages/portfolio-simulate.tsx') ||
        normalized.endsWith('/src/pages/portfolio-plan.tsx')
      ) code = patchPortfolioChild(code);

      return code === source ? null : { code, map: null };
    },
  };
}

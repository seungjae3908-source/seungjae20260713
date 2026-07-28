import type { Plugin } from 'vite';

function replaceRequired(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[requested-ui-fixes-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchApp(source: string): string {
  // App.tsx에 최종 UI가 이미 소스화된 경우 빌드 시 중복 패치를 하지 않는다.
  if (
    source.includes('function GlobalBackButton()') &&
    source.includes('<GlobalBackButton />')
  ) {
    return source;
  }

  let code = source;

  code = replaceRequired(
    code,
    `import { QueryClient, QueryClientProvider } from '@tanstack/react-query';`,
    `import { QueryClient, QueryClientProvider } from '@tanstack/react-query';\nimport { ArrowLeft } from 'lucide-react';`,
    'global back icon import',
  );

  code = replaceRequired(
    code,
    `function AppShell({ children }: { children: ReactNode }) {`,
    `function GlobalBackButton() {
\tconst [location, navigate] = useLocation();
\tconst hidden =
\t\tlocation === '/' ||
\t\tlocation === '/home' ||
\t\tlocation.startsWith('/search');

\tif (hidden) return null;

\treturn (
\t\t<button
\t\t\ttype="button"
\t\t\taria-label="공통 뒤로가기"
\t\t\tonClick={() => {
\t\t\t\tif (window.history.length > 1) window.history.back();
\t\t\t\telse navigate('/home', { replace: true });
\t\t\t}}
\t\t\tclassName="absolute left-3 top-3 z-[90] flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card shadow-sm"
\t\t>
\t\t\t<ArrowLeft className="h-4 w-4" />
\t\t</button>
\t);
}

function AppShell({ children }: { children: ReactNode }) {`,
    'global back component',
  );

  code = replaceRequired(
    code,
    `\t\t\t<div className="relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background">\n\t\t\t\t<OfflineBanner />`,
    `\t\t\t<div className="relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background">\n\t\t\t\t<GlobalBackButton />\n\t\t\t\t<OfflineBanner />`,
    'global back placement',
  );

  return code;
}

function patchStockInfo(source: string): string {
  let code = source;

  code = replaceRequired(
    code,
    `\t\t\t\t\t<SpecialFeedPanel\n\t\t\t\t\t\tasset="stock"\n\t\t\t\t\t\tmarket={market}`,
    `\t\t\t\t\t<SpecialFeedPanel\n\t\t\t\t\t\tasset="stock"\n\t\t\t\t\t\tmarket={market}\n\t\t\t\t\t\tselectedTicker={ticker}`,
    'selected ticker feed prop',
  );

  code = replaceRequired(
    code,
    `function SpecialFeedPanel({\n\tasset,\n\tmarket,\n\tfilter,`,
    `function SpecialFeedPanel({\n\tasset,\n\tmarket,\n\tselectedTicker,\n\tfilter,`,
    'selected ticker feed argument',
  );

  code = replaceRequired(
    code,
    `\tasset: AssetTab;\n\tmarket: SpecialFeedMarket;\n\tfilter: SpecialFeedFilter;`,
    `\tasset: AssetTab;\n\tmarket: SpecialFeedMarket;\n\tselectedTicker?: string;\n\tfilter: SpecialFeedFilter;`,
    'selected ticker feed type',
  );

  code = replaceRequired(
    code,
    `\t\treturn [...items]\n\t\t\t.filter((item) => {`,
    `\t\treturn [...items]\n\t\t\t.filter((item) =>\n\t\t\t\t!selectedTicker ||\n\t\t\t\titem.ticker.trim().toUpperCase() === selectedTicker.trim().toUpperCase(),\n\t\t\t)\n\t\t\t.filter((item) => {`,
    'selected ticker feed filter',
  );

  code = replaceRequired(
    code,
    `\t}, [filter, items, nowMs, view]);`,
    `\t}, [filter, items, nowMs, selectedTicker, view]);`,
    'selected ticker feed memo dependency',
  );

  code = replaceRequired(
    code,
    `\t}, [asset, filter, market, view]);`,
    `\t}, [asset, filter, market, selectedTicker, view]);`,
    'selected ticker feed page reset',
  );

  return code;
}

function patchDetail(source: string): string {
  let code = source;

  code = code
    .replaceAll('stock-detail-core-v15', 'stock-detail-core-v16')
    .replaceAll('stock-detail-identity-v15', 'stock-detail-identity-v16')
    .replaceAll('stock-detail-advanced-v15', 'stock-detail-advanced-v16');

  code = replaceRequired(
    code,
    `      [\`/api/stocks/\${upper}/filings\`, \`/api/stocks/\${upper}/disclosures\`],`,
    `      [
        \`/api/stocks/\${upper}/disclosures?all=1\`,
        \`/api/stocks/\${upper}/filings?all=1\`,
        \`/api/stocks/\${upper}/disclosures\`,
        \`/api/stocks/\${upper}/filings\`,
      ],`,
    'detail disclosure endpoints',
  );

  const newsEndpointsWithAll = `    tryJson<AnyObj>(
      [\`/api/stocks/\${upper}/news?all=1\`, \`/api/stocks/\${upper}/news\`],
      {},
    ),`;

  if (!code.includes(newsEndpointsWithAll)) {
    const newsEndpointCandidates = [
      `    tryJson<AnyObj>([\`/api/stocks/\${upper}/news\`], {}),`,
      `    tryJson<AnyObj>(
      [\`/api/stocks/\${upper}/news\`],
      {},
    ),`,
    ];
    const currentNewsEndpoints = newsEndpointCandidates.find((candidate) =>
      code.includes(candidate),
    );

    if (!currentNewsEndpoints) {
      throw new Error(
        '[requested-ui-fixes-patch] detail news endpoints 위치를 찾지 못했습니다.',
      );
    }

    code = code.replace(currentNewsEndpoints, newsEndpointsWithAll);
  }

  if (!code.includes('  let specialFeedRaw: AnyObj = {};')) {
    code = replaceRequired(
      code,
      `  const filings = collectFilings(filingsRaw);
  return {
    financials: normalizeObject(financialRaw, ["financials", "data"]),
    risk: normalizeObject(riskRaw, ["risk", "analysis", "data"]),
    filings: filings.length ? filings : collectFilings(riskRaw),
    news: collectNews(newsRaw),
  };`,
    `  let filings = collectFilings(filingsRaw);
  let news = collectNews(newsRaw);
  let specialFeedRaw: AnyObj = {};

  if (filings.length === 0 || news.length === 0) {
    const market = /^\\d{6}$/.test(upper) ? 'KR' : 'US';
    specialFeedRaw = await tryJson<AnyObj>(
      [\`/api/stocks/special-feed?asset=stock&market=\${market}&limit=2000\`],
      {},
    );
    const matchingItems = (Array.isArray(specialFeedRaw?.items)
      ? specialFeedRaw.items
      : []
    ).filter(
      (item: AnyObj) =>
        String(item?.ticker ?? '').trim().toUpperCase() === upper,
    );

    if (filings.length === 0) {
      filings = matchingItems.filter(
        (item: AnyObj) => String(item?.kind ?? '') === 'disclosure',
      );
    }
    if (news.length === 0) {
      news = matchingItems.filter(
        (item: AnyObj) => String(item?.kind ?? '') === 'news',
      );
    }
  }

  if (filings.length === 0) {
    filings = [
      {
        title: '공시 제공 상태',
        report_nm: '공시 제공 상태',
        summary:
          firstText(filingsRaw?.summary, filingsRaw?.message, specialFeedRaw?.message) ??
          (/^\\d{6}$/.test(upper)
            ? 'DART 공시 제공처 연결을 확인하고 있습니다.'
            : 'SEC EDGAR 공시 제공처 연결을 확인하고 있습니다.'),
        source: /^\\d{6}$/.test(upper) ? 'DART' : 'SEC EDGAR',
        date: new Date().toISOString(),
        statusOnly: true,
      },
    ];
  }

  if (news.length === 0) {
    news = [
      {
        title: '뉴스 제공 상태',
        summary:
          firstText(newsRaw?.summary, newsRaw?.message, specialFeedRaw?.message) ??
          '뉴스 제공처 연결이 지연되어 관련 기사를 다시 확인하고 있습니다.',
        source: '뉴스 제공처',
        date: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        statusOnly: true,
      },
    ];
  }

  return {
    financials: normalizeObject(financialRaw, ["financials", "data"]),
    risk: normalizeObject(riskRaw, ["risk", "analysis", "data"]),
    filings,
    news,
  };`,
      'detail provider fallback content',
    );
  }

  return code;
}

function patchHome(source: string): string {
  let code = source;

  code = replaceRequired(
    code,
    `function finite(value: unknown): number | null {\n  const number = Number(value);\n  return Number.isFinite(number) ? number : null;\n}`,
    `function finite(value: unknown): number | null {\n  const number = Number(value);\n  return Number.isFinite(number) ? number : null;\n}\n\nfunction issueSimpleAnalysis(issue: NewsIssue): string {\n  const source = \`\${issue.title} \${issue.summary}\`.toLowerCase();\n  const positive = /상승|개선|증가|성장|호재|수주|계약|승인|흑자|완화|인하|돌파/.test(source);\n  const negative = /하락|악화|감소|악재|적자|규제|소송|위험|우려|인상|침체|급락/.test(source);\n\n  if (positive && !negative) {\n    return '관련 업종의 투자심리와 수급에 긍정적으로 작용할 가능성이 있습니다. 실제 가격 반응과 거래량을 함께 확인하세요.';\n  }\n  if (negative && !positive) {\n    return '관련 종목의 변동성과 하방 위험을 키울 수 있습니다. 장중 반응보다 종가와 후속 보도를 확인하세요.';\n  }\n  return '시장 방향을 단독으로 결정하기보다 지수 흐름·환율·수급과 함께 확인해야 하는 중립 이슈입니다.';\n}`,
    'home issue simple analysis helper',
  );

  code = replaceRequired(
    code,
    `                          <p className="line-clamp-2 text-xs font-black leading-5">\n                            {issue.summary}\n                          </p>\n                          <p className="mt-1 text-[9px] font-bold text-muted-foreground">\n                            {issue.source}\n                          </p>`,
    `                          <p className="line-clamp-2 text-xs font-black leading-5">\n                            {issue.title || issue.summary}\n                          </p>\n                          {issue.summary && issue.summary !== issue.title && (\n                            <p className="mt-1 line-clamp-2 text-[10px] font-semibold leading-4 text-muted-foreground">\n                              {issue.summary}\n                            </p>\n                          )}\n                          <p className="mt-2 rounded-xl bg-secondary/70 px-2.5 py-2 text-center text-[10px] font-bold leading-4 text-muted-foreground">\n                            간단 분석 · {issueSimpleAnalysis(issue)}\n                          </p>\n                          <p className="mt-1 text-center text-[9px] font-bold text-muted-foreground">\n                            {issue.source}\n                          </p>`,
    'home issue analysis display',
  );

  return code;
}

function patchScanner(source: string): string {
  // The final scanner source intentionally omits duplicate admin/chart panels.
  return source;
}

function patchPortfolioPlan(source: string): string {
  let code = source;

  code = replaceRequired(
    code,
    `\tconst [monthly, setMonthly] = useState('');`,
    `\tconst [monthly, setMonthly] = useState('100');`,
    'portfolio monthly default ten-thousand units',
  );

  code = replaceRequired(
    code,
    `\t\tconst m = Number(monthly || '0');`,
    `\t\tconst m = Number(monthly || '0') * 10_000;`,
    'portfolio monthly ten-thousand conversion',
  );

  code = code
    .replace('월 투자금(원)', '월 투자금(만원)')
    .replaceAll(
      `<h2 className="text-sm font-black">`,
      `<h2 className="text-center text-sm font-black">`,
    )
    .replaceAll(
      `className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"`,
      `className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-center text-sm font-bold outline-none focus:border-primary"`,
    )
    .replace(
      `className="rounded-xl bg-secondary/60 p-2.5"`,
      `className="flex min-h-[72px] flex-col items-center justify-center rounded-xl bg-secondary/60 p-2.5 text-center"`,
    )
    .replace(
      `className="rounded-lg bg-background p-1.5"`,
      `className="flex min-h-[64px] flex-col items-center justify-center rounded-lg bg-background p-1.5 text-center"`,
    );

  return code;
}

export function requestedUiFixesPatch(): Plugin {
  return {
    name: 'requested-ui-fixes-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (normalized.endsWith('/src/App.tsx')) {
        return { code: patchApp(source), map: null };
      }
      if (normalized.endsWith('/src/pages/stock-info.tsx')) {
        return { code: patchStockInfo(source), map: null };
      }
      if (normalized.endsWith('/src/pages/detail.tsx')) {
        return { code: patchDetail(source), map: null };
      }
      if (normalized.endsWith('/src/pages/home.tsx')) {
        return { code: patchHome(source), map: null };
      }
      if (normalized.endsWith('/src/pages/scanner.tsx')) {
        return { code: patchScanner(source), map: null };
      }
      if (normalized.endsWith('/src/pages/portfolio-plan.tsx')) {
        return { code: patchPortfolioPlan(source), map: null };
      }
      return null;
    },
  };
}

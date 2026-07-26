import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    if (label === 'stocks focused header') return source;
    throw new Error(`[focused-page-layout-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchStocksPage(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    "import { useMemo, useState } from 'react';",
    "import { useEffect, useMemo, useState } from 'react';",
    'stocks react import',
  );

  code = replaceOnce(
    code,
    `\tconst [, navigate] = useLocation();\n\tconst mode = useAssetMode();`,
    `\tconst [location, navigate] = useLocation();\n\tconst mode = useAssetMode();\n\n\tconst focusedParams = useMemo(() => {\n\t\tconst locationQuery = location.includes('?')\n\t\t\t? location.split('?')[1] ?? ''\n\t\t\t: '';\n\t\tconst browserQuery =\n\t\t\ttypeof window !== 'undefined'\n\t\t\t\t? window.location.search.replace(/^\\?/, '')\n\t\t\t\t: '';\n\t\treturn new URLSearchParams(locationQuery || browserQuery);\n\t}, [location]);\n\n\tconst focusedAsset = focusedParams.get('asset');\n\tconst focusedMarket = focusedParams.get('market') === 'US' ? 'US' : 'KR';\n\tconst focusedCoinMarket =\n\t\tfocusedParams.get('coinMarket') === 'futures' ? 'futures' : 'spot';\n\tconst focusedPage = focusedAsset === 'stock' || focusedAsset === 'coin';\n\tconst focusedTitle =\n\t\tfocusedAsset === 'coin'\n\t\t\t? focusedCoinMarket === 'futures'\n\t\t\t\t? '코인 선물'\n\t\t\t\t: '코인 현물'\n\t\t\t: focusedMarket === 'US'\n\t\t\t\t? '해외주식'\n\t\t\t\t: '국내주식';\n\n\tuseEffect(() => {\n\t\tif (!focusedPage) return;\n\n\t\tif (focusedAsset === 'coin') {\n\t\t\tmode.setAsset('coin');\n\t\t\tmode.setCoinMarket(focusedCoinMarket);\n\t\t\treturn;\n\t\t}\n\n\t\tmode.setAsset('stock');\n\t\tmode.setStockMarket(focusedMarket);\n\t\t// URL이 바뀔 때만 선택 시장을 동기화한다.\n\t\t// eslint-disable-next-line react-hooks/exhaustive-deps\n\t}, [location]);`,
    'stocks focused route state',
  );

  code = replaceOnce(
    code,
    `\t\t\t<header className="border-b border-card-border px-4 pb-3 pt-4">\n\t\t\t\t<h1 className="text-center text-xl font-extrabold">\n\t\t\t\t\t종목\n\t\t\t\t</h1>\n\n\t\t\t\t<AssetSwitch className="mt-3" />\n\n\t\t\t\t<div className="mt-3 grid grid-cols-3 gap-2">\n\t\t\t\t\t{CATEGORIES.map((item) => (\n\t\t\t\t\t\t<button\n\t\t\t\t\t\t\tkey={item.key}\n\t\t\t\t\t\t\ttype="button"\n\t\t\t\t\t\t\tonClick={() => openCategory(item.key)}\n\t\t\t\t\t\t\tclassName="rounded-xl border border-card-border bg-card px-2 py-2.5 text-center text-[11px] font-black"\n\t\t\t\t\t\t>\n\t\t\t\t\t\t\t{item.label}\n\t\t\t\t\t\t</button>\n\t\t\t\t\t))}\n\t\t\t\t</div>\n\n\t\t\t\t<SearchField\n\t\t\t\t\tvalue={query}\n\t\t\t\t\tonChange={setQuery}\n\t\t\t\t\tclassName="mt-3"\n\t\t\t\t\tariaLabel={\n\t\t\t\t\t\tisStock ? '종목 검색' : '코인 검색'\n\t\t\t\t\t}\n\t\t\t\t/>\n\t\t\t</header>`,
    `\t\t\t<header className="border-b border-card-border px-4 pb-3 pt-4">\n\t\t\t\t<h1 className="text-center text-xl font-extrabold">\n\t\t\t\t\t{focusedPage ? focusedTitle : '종목'}\n\t\t\t\t</h1>\n\n\t\t\t\t{!focusedPage && <AssetSwitch className="mt-3" />}\n\n\t\t\t\t<SearchField\n\t\t\t\t\tvalue={query}\n\t\t\t\t\tonChange={setQuery}\n\t\t\t\t\tclassName="mt-3"\n\t\t\t\t\tariaLabel={\n\t\t\t\t\t\tisStock ? '종목 검색' : '코인 검색'\n\t\t\t\t\t}\n\t\t\t\t/>\n\n\t\t\t\t<div className="mt-3 grid grid-cols-3 gap-2">\n\t\t\t\t\t{CATEGORIES.map((item) => (\n\t\t\t\t\t\t<button\n\t\t\t\t\t\t\tkey={item.key}\n\t\t\t\t\t\t\ttype="button"\n\t\t\t\t\t\t\tonClick={() => openCategory(item.key)}\n\t\t\t\t\t\t\tclassName="rounded-xl border border-card-border bg-card px-2 py-2.5 text-center text-[11px] font-black"\n\t\t\t\t\t\t>\n\t\t\t\t\t\t\t{item.label}\n\t\t\t\t\t\t</button>\n\t\t\t\t\t))}\n\t\t\t\t</div>\n\t\t\t</header>`,
    'stocks focused header',
  );

  code = replaceOnce(
    code,
    `\t\t\t<main className="space-y-3 px-4 pb-28 pt-4">`,
    `\t\t\t<main\n\t\t\t\tclassName={cn(\n\t\t\t\t\t'space-y-3 px-4 pt-4',\n\t\t\t\t\tfocusedPage ? 'pb-8' : 'pb-28',\n\t\t\t\t)}\n\t\t\t>`,
    'stocks focused body padding',
  );

  return code;
}

function patchStockInfoPage(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `\tconst initial = queryState(location);\n\tconst [asset, setAsset] = useState<AssetTab>(initial.asset);`,
    `\tconst initial = queryState(location);\n\tconst focusedParams = useMemo(() => {\n\t\tconst locationQuery = location.includes('?')\n\t\t\t? location.split('?')[1] ?? ''\n\t\t\t: '';\n\t\tconst browserQuery =\n\t\t\ttypeof window !== 'undefined'\n\t\t\t\t? window.location.search.replace(/^\\?/, '')\n\t\t\t\t: '';\n\t\treturn new URLSearchParams(locationQuery || browserQuery);\n\t}, [location]);\n\tconst focusedInfo =\n\t\tfocusedParams.get('asset') === 'stock' ||\n\t\tfocusedParams.get('asset') === 'coin';\n\tconst focusedCoinMarket =\n\t\tfocusedParams.get('coinMarket') === 'futures' ? 'futures' : 'spot';\n\tconst focusedInfoTitle =\n\t\tfocusedParams.get('asset') === 'coin'\n\t\t\t? focusedCoinMarket === 'futures'\n\t\t\t\t? '코인 선물 정보'\n\t\t\t\t: '코인 현물 정보'\n\t\t\t: focusedParams.get('market') === 'US'\n\t\t\t\t? '해외주식 정보'\n\t\t\t\t: '국내주식 정보';\n\tconst [asset, setAsset] = useState<AssetTab>(initial.asset);`,
    'stock info focused state',
  );

  code = replaceOnce(
    code,
    `\tuseEffect(() => {\n\t\tconst next = queryState(location);\n\t\tsetAsset(next.asset);\n\t\tsetMarket(next.market);\n\t\tsetTicker(next.ticker);\n\t\tsetWatchlisted(isInWatchlist(next.ticker));\n\t}, [location]);`,
    `\tuseEffect(() => {\n\t\tconst next = queryState(location);\n\t\tsetAsset(next.asset);\n\t\tsetMarket(next.market);\n\t\tsetTicker(next.ticker);\n\t\tsetWatchlisted(isInWatchlist(next.ticker));\n\n\t\tif (focusedInfo) {\n\t\t\tappMode.setAsset(next.asset);\n\t\t\tif (next.asset === 'stock') {\n\t\t\t\tappMode.setStockMarket(next.market);\n\t\t\t} else {\n\t\t\t\tappMode.setCoinMarket(focusedCoinMarket);\n\t\t\t}\n\t\t}\n\t\t// URL이 바뀔 때만 선택 정보 시장을 동기화한다.\n\t\t// eslint-disable-next-line react-hooks/exhaustive-deps\n\t}, [location]);`,
    'stock info route sync',
  );

  code = replaceOnce(
    code,
    `\t\t\t<header className="border-b border-card-border px-4 pb-3 pt-4">\n\t\t\t\t<h1 className="mb-3 text-center text-xl font-extrabold">정보</h1>\n\n\t\t\t\t<div className="grid grid-cols-2 gap-2">\n\t\t\t\t\t<Tab active onClick={() => undefined}>정보</Tab>\n\t\t\t\t\t<Tab active={false} onClick={() => navigate('/learn')}>공부</Tab>\n\t\t\t\t</div>\n\n\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">\n\t\t\t\t\t<Tab active={asset === 'stock'} onClick={() => updateSelection({ asset: 'stock' })}>주식</Tab>\n\t\t\t\t\t<Tab active={asset === 'coin'} onClick={() => updateSelection({ asset: 'coin' })}>코인</Tab>\n\t\t\t\t</div>\n\t\t\t\t{asset === 'stock' && (\n\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">\n\t\t\t\t\t\t<Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>\n\t\t\t\t\t\t<Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>해외</Tab>\n\t\t\t\t\t</div>\n\t\t\t\t)}\n\n\t\t\t\t<div className="mt-3 grid grid-cols-2 gap-2">\n\t\t\t\t\t<AnalysisEntry label="국내시장" onClick={() => navigate('/analysis/kr')} />\n\t\t\t\t\t<AnalysisEntry label="해외시장" onClick={() => navigate('/analysis/us')} />\n\t\t\t\t\t<AnalysisEntry label="코인시장" onClick={() => navigate('/analysis/coin')} />\n\t\t\t\t\t<AnalysisEntry label="포트폴리오" onClick={() => navigate('/portfolio')} />\n\t\t\t\t</div>\n\t\t\t</header>`,
    `\t\t\t<header className="border-b border-card-border px-4 pb-3 pt-4">\n\t\t\t\t<h1 className="text-center text-xl font-extrabold">\n\t\t\t\t\t{focusedInfo ? focusedInfoTitle : '정보'}\n\t\t\t\t</h1>\n\n\t\t\t\t{!focusedInfo && (\n\t\t\t\t\t<>\n\t\t\t\t\t\t<div className="mt-3 grid grid-cols-2 gap-2">\n\t\t\t\t\t\t\t<Tab active onClick={() => undefined}>정보</Tab>\n\t\t\t\t\t\t\t<Tab active={false} onClick={() => navigate('/learn')}>공부</Tab>\n\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">\n\t\t\t\t\t\t\t<Tab active={asset === 'stock'} onClick={() => updateSelection({ asset: 'stock' })}>주식</Tab>\n\t\t\t\t\t\t\t<Tab active={asset === 'coin'} onClick={() => updateSelection({ asset: 'coin' })}>코인</Tab>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t{asset === 'stock' && (\n\t\t\t\t\t\t\t<div className="mt-2 grid grid-cols-2 gap-2">\n\t\t\t\t\t\t\t\t<Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>\n\t\t\t\t\t\t\t\t<Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>해외</Tab>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t)}\n\n\t\t\t\t\t\t<div className="mt-3 grid grid-cols-2 gap-2">\n\t\t\t\t\t\t\t<AnalysisEntry label="국내시장" onClick={() => navigate('/analysis/kr')} />\n\t\t\t\t\t\t\t<AnalysisEntry label="해외시장" onClick={() => navigate('/analysis/us')} />\n\t\t\t\t\t\t\t<AnalysisEntry label="코인시장" onClick={() => navigate('/analysis/coin')} />\n\t\t\t\t\t\t\t<AnalysisEntry label="포트폴리오" onClick={() => navigate('/portfolio')} />\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</>\n\t\t\t\t)}\n\t\t\t</header>`,
    'stock info focused header',
  );

  code = replaceOnce(
    code,
    `\t\t\t\t<main className="space-y-4 px-4 pb-28 pt-4">`,
    `\t\t\t\t<main\n\t\t\t\t\tclassName={cn(\n\t\t\t\t\t\t'space-y-4 px-4 pt-4',\n\t\t\t\t\t\tfocusedInfo ? 'pb-8' : 'pb-28',\n\t\t\t\t\t)}\n\t\t\t\t>`,
    'stock info focused body padding',
  );

  return code;
}

function patchBottomNav(source: string): string {
  return source.replace(
    `{ label: '실시간 차트 분석', href: '/tech/chart-relay' },`,
    `{ label: '차트중계', href: '/tech/chart-relay' },`,
  );
}

export function focusedPageLayoutPatch(): Plugin {
  return {
    name: 'focused-page-layout-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/stocks.tsx')) {
        return { code: patchStocksPage(source), map: null };
      }

      if (normalized.endsWith('/src/pages/stock-info.tsx')) {
        return { code: patchStockInfoPage(source), map: null };
      }

      if (normalized.endsWith('/src/components/bottom-nav.tsx')) {
        return { code: patchBottomNav(source), map: null };
      }

      return null;
    },
  };
}

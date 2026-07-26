import type { Plugin } from 'vite';

function patchChartRelay(source: string): string {
  let code = source;

  if (!code.includes("@/components/unified-asset-search")) {
    code = code.replace(
      "import { BottomNav } from '@/components/bottom-nav';",
      "import { BottomNav } from '@/components/bottom-nav';\nimport { UnifiedAssetSearch } from '@/components/unified-asset-search';",
    );
  }

  const searchBlock = /\s*\{\/\* 종목 입력 \*\/\}\s*<div className="relative mt-3">[\s\S]*?<\/div>\s*(?=<p className="mt-1\.5 text-center)/;
  if (searchBlock.test(code)) {
    code = code.replace(
      searchBlock,
      `
        {/* 실제 종목명·티커 통합 검색 */}
        <UnifiedAssetSearch
          asset={asset}
          value={symbolInput}
          onChange={setSymbolInput}
          onSelect={(result) => {
            setSymbol(result.symbol);
            setSymbolInput('');
            setActiveSignalId(null);
            setModalSignal(null);
          }}
          className="mt-3"
        />
        `,
    );
  }

  return code;
}

function patchSignalScan(source: string): string {
  let code = source;

  if (!code.includes("@/components/unified-asset-search")) {
    code = code.replace(
      "import { BottomNav } from '@/components/bottom-nav';",
      "import { BottomNav } from '@/components/bottom-nav';\nimport { UnifiedAssetSearch } from '@/components/unified-asset-search';",
    );
  }

  if (!code.includes("const [assetSearch, setAssetSearch]")) {
    code = code.replace(
      `  const [selected, setSelected] =
    useState<Candidate | null>(null);`,
      `  const [selected, setSelected] =
    useState<Candidate | null>(null);
  const [assetSearch, setAssetSearch] = useState('');`,
    );
  }

  code = code.replace(
    `  const selectMarket = (next: ScanMarket) => {
    setSelected(null);
    setMarketMenu(null);`,
    `  const selectMarket = (next: ScanMarket) => {
    setSelected(null);
    setAssetSearch('');
    setMarketMenu(null);`,
  );

  const marker = `        </div>

        <div className="mt-3 grid grid-cols-4 gap-1">`;
  if (code.includes(marker) && !code.includes('신호를 확인할 종목 검색')) {
    code = code.replace(
      marker,
      `        </div>

        <UnifiedAssetSearch
          asset={marketToChartAsset(market)}
          value={assetSearch}
          onChange={setAssetSearch}
          onSelect={(result) => {
            const params = new URLSearchParams({
              asset: result.asset,
              symbol: result.symbol,
              interval: '5m',
              tab: 'live',
            });
            navigate(\`/tech/chart-relay?\${params.toString()}\`);
          }}
          className="mt-3"
          placeholder="신호를 확인할 종목 검색"
        />

        <div className="mt-3 grid grid-cols-4 gap-1">`,
    );
  }

  return code;
}

function patchStocks(source: string): string {
  let code = source;

  code = code.replace(
    "import { useMemo, useState } from 'react';",
    "import { useEffect, useMemo, useState } from 'react';",
  );

  if (!code.includes('const [debouncedQuery, setDebouncedQuery]')) {
    code = code.replace(
      "\tconst [query, setQuery] = useState('');",
      "\tconst [query, setQuery] = useState('');\n\tconst [debouncedQuery, setDebouncedQuery] = useState('');",
    );
  }

  if (!code.includes('setDebouncedQuery(query.trim())')) {
    code = code.replace(
      `\tconst trimmed = query.trim();
\tconst searching = trimmed.length > 0;`,
      `\tuseEffect(() => {
\t\tconst timer = window.setTimeout(() => {
\t\t\tsetDebouncedQuery(query.trim());
\t\t}, 250);
\t\treturn () => window.clearTimeout(timer);
\t}, [query]);

\tconst trimmed = query.trim();
\tconst searchTerm = debouncedQuery.trim();
\tconst searching = trimmed.length > 0;`,
    );
  }

  code = code.replace(
    "queryKey: ['stocks-directory', mode.stockMarket, trimmed]",
    "queryKey: ['stocks-directory', mode.stockMarket, searchTerm]",
  );
  code = code.replace(
    'queryFn: () => api.searchRows(trimmed),',
    "queryFn: () => apiGet<{ results: QuoteRow[] }>(`/search/quotes?q=${encodeURIComponent(searchTerm)}&market=${mode.stockMarket}&limit=30`, { timeoutMs: 20_000 }),",
  );
  code = code.replace(
    'enabled: isStock && searching,',
    'enabled: isStock && searchTerm.length > 0,',
  );
  code = code.replace(
    `\t\tstaleTime: 0,
\t\trefetchInterval: 5_000,
\t\trefetchOnMount: true,
\t\trefetchOnWindowFocus: true,
\t\trefetchOnReconnect: true,`,
    `\t\tstaleTime: 30_000,
\t\tretry: 1,
\t\trefetchOnMount: false,
\t\trefetchOnWindowFocus: false,
\t\trefetchOnReconnect: true,`,
  );

  return code;
}

function patchApi(source: string): string {
  return source.replace(
    "apiGet<{ results: SearchResult[] }>(`/search?q=${enc(q)}`)",
    "apiGet<{ results: SearchResult[] }>(`/search/quotes?q=${enc(q)}&market=ALL&limit=30&enrich=0`)",
  );
}

export function unifiedSearchIntegrationPatch(): Plugin {
  return {
    name: 'unified-search-integration-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/pages/chart-relay.tsx')) {
        code = patchChartRelay(code);
      } else if (normalized.endsWith('/src/pages/signal-scan.tsx')) {
        code = patchSignalScan(code);
      } else if (normalized.endsWith('/src/pages/stocks.tsx')) {
        code = patchStocks(code);
      } else if (normalized.endsWith('/src/lib/api.ts')) {
        code = patchApi(code);
      }

      return code === source ? null : { code, map: null };
    },
  };
}

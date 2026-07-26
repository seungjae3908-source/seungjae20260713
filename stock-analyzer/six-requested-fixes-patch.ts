import type { Plugin } from 'vite';

function replaceRange(
  source: string,
  startMarker: string,
  endMarker: string,
  transform: (segment: string) => string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return source;
  return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}

function patchStocks(source: string): string {
  let code = source;

  code = replaceRange(
    code,
    `\tconst stockRows = useQuery({`,
    `\tconst recommendations = useQuery({`,
    (segment) =>
      segment.replace(
        /\t\tstaleTime: 0,\n\t\trefetchInterval: 5_000,\n\t\trefetchOnMount: true,\n\t\trefetchOnWindowFocus: true,\n\t\trefetchOnReconnect: true,?/,
        `\t\tstaleTime: 60_000,\n\t\tgcTime: 10 * 60_000,\n\t\tplaceholderData: (previous) => previous,\n\t\trefetchOnMount: false,\n\t\trefetchOnWindowFocus: false,\n\t\trefetchOnReconnect: true,`,
      ),
  );

  code = replaceRange(
    code,
    `\tconst recommendations = useQuery({`,
    `\tconst movers = useQuery({`,
    (segment) => segment.replace(`\t\tenabled: isStock,`, `\t\tenabled: isStock && !searching,`),
  );

  code = replaceRange(
    code,
    `\tconst movers = useQuery({`,
    `\tconst spotMarkets = useQuery({`,
    (segment) => segment.replace(`\t\tenabled: isStock,`, `\t\tenabled: isStock && !searching,`),
  );

  return code;
}

function patchSignalScan(source: string): string {
  return replaceRange(
    source,
    `  const query = useQuery({`,
    `  const groups = useMemo<ScanGroup[]>(() => {`,
    (segment) =>
      segment.replace(
        `    refetchInterval: 60_000,`,
        `    staleTime: 5 * 60_000,\n    gcTime: 15 * 60_000,\n    placeholderData: (previous) => previous,\n    refetchInterval: 5 * 60_000,\n    refetchOnMount: false,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: true,`,
      ),
  );
}

function patchDetail(source: string): string {
  let code = source;

  code = code.replace(
    /enabled:\s*Boolean\(\s*ticker\s*&&\s*permissions\.canUseAdvancedAnalysis\s*&&\s*coreDetail\.data,?\s*\),/,
    `enabled: Boolean(ticker && permissions.canUseAdvancedAnalysis),`,
  );

  code = code.replace(
    `  const source = market === "KR" ? "DART" : "SEC EDGAR";\n  const sorted = sortContentNewest(filings);\n  const historySorted = sortContentNewest(history ?? filings);`,
    `  const source = market === "KR" ? "DART" : "SEC EDGAR";\n  const liveFilings = useQuery<AnyObj>({\n    queryKey: ["stock-detail-filings-live", ticker],\n    queryFn: async () => {\n      const [filingResponse, disclosureResponse] = await Promise.all([\n        tryJson<AnyObj>([\`/api/stocks/\${ticker}/filings\`], {}),\n        tryJson<AnyObj>([\`/api/stocks/\${ticker}/disclosures\`], {}),\n      ]);\n      let loaded = [\n        ...collectFilings(filingResponse),\n        ...collectFilings(disclosureResponse),\n      ];\n      if (!loaded.length) {\n        const feed = await tryJson<AnyObj>(\n          [\`/api/stocks/special-feed?asset=stock&market=\${market}&limit=2000\`],\n          {},\n        );\n        loaded = (Array.isArray(feed?.items) ? feed.items : []).filter(\n          (item: AnyObj) =>\n            String(item?.ticker ?? "").trim().toUpperCase() === ticker &&\n            String(item?.kind ?? "") === "disclosure",\n        );\n      }\n      return { filings: loaded };\n    },\n    enabled: Boolean(ticker),\n    staleTime: 60_000,\n    gcTime: 10 * 60_000,\n    retry: false,\n    refetchOnWindowFocus: false,\n  });\n  const refreshedFilings = collectFilings(liveFilings.data ?? {});\n  const resolvedFilings = refreshedFilings.length ? refreshedFilings : filings;\n  const sorted = sortContentNewest(resolvedFilings);\n  const historySorted = sortContentNewest(history ?? resolvedFilings);`,
  );

  code = code.replace(
    `  const sorted = sortContentNewest(news);\n  const historySorted = sortContentNewest(history ?? news);`,
    `  const liveNews = useQuery<AnyObj>({\n    queryKey: ["stock-detail-news-live", ticker],\n    queryFn: async () => {\n      const direct = await tryJson<AnyObj>([\`/api/stocks/\${ticker}/news\`], {});\n      let loaded = collectNews(direct);\n      if (!loaded.length) {\n        const market = /^\\d{6}$/.test(ticker) ? "KR" : "US";\n        const feed = await tryJson<AnyObj>(\n          [\`/api/stocks/special-feed?asset=stock&market=\${market}&limit=2000\`],\n          {},\n        );\n        loaded = (Array.isArray(feed?.items) ? feed.items : []).filter(\n          (item: AnyObj) =>\n            String(item?.ticker ?? "").trim().toUpperCase() === ticker &&\n            String(item?.kind ?? "") === "news",\n        );\n      }\n      return { news: loaded };\n    },\n    enabled: Boolean(ticker),\n    staleTime: 60_000,\n    gcTime: 10 * 60_000,\n    retry: false,\n    refetchOnWindowFocus: false,\n  });\n  const refreshedNews = collectNews(liveNews.data ?? {});\n  const resolvedNews = refreshedNews.length ? refreshedNews : news;\n  const sorted = sortContentNewest(resolvedNews);\n  const historySorted = sortContentNewest(history ?? resolvedNews);`,
  );

  return code;
}

export function sixRequestedFixesPatch(): Plugin {
  return {
    name: 'six-requested-fixes-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (normalized.endsWith('/src/pages/stocks.tsx')) {
        const code = patchStocks(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/signal-scan.tsx')) {
        const code = patchSignalScan(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/detail.tsx')) {
        const code = patchDetail(source);
        return code === source ? null : { code, map: null };
      }
      return null;
    },
  };
}

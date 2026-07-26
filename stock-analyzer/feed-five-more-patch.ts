import type { Plugin } from 'vite';

function patchStockInfo(source: string): string {
  let code = source;

  code = code.replace(
    "setWatchlisted(isInWatchlist(next.ticker));\n\t\tif (next.asset === 'coin') appMode.setCoinMarket(next.coinMarket);\n\t}, [location]);",
    "setWatchlisted(isInWatchlist(next.ticker));\n\t\tappMode.setAsset(next.asset);\n\t\tif (next.asset === 'stock') appMode.setStockMarket(next.market);\n\t\telse appMode.setCoinMarket(next.coinMarket);\n\t}, [location]);",
  );

  code = code.replace(
    'const modalItems = filteredItems.slice((page - 1) * 5, page * 5);',
    'const modalItems = filteredItems.slice(0, page * 5);',
  );

  code = code.replace(
    `\t\t\t\t\t\t<div className="flex items-center justify-between border-t border-card-border px-3 py-3">
\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\ttype="button"
\t\t\t\t\t\t\t\tonClick={() => setPage((value) => Math.max(1, value - 1))}
\t\t\t\t\t\t\t\tdisabled={page <= 1}
\t\t\t\t\t\t\t\tclassName="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-black disabled:opacity-40"
\t\t\t\t\t\t\t>
\t\t\t\t\t\t\t\t<ChevronLeft className="h-4 w-4" />
\t\t\t\t\t\t\t\t이전
\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t\t<span className="text-xs font-black">{page} / {pageCount}</span>
\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\ttype="button"
\t\t\t\t\t\t\t\tonClick={() => setPage((value) => Math.min(pageCount, value + 1))}
\t\t\t\t\t\t\t\tdisabled={page >= pageCount}
\t\t\t\t\t\t\t\tclassName="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-black disabled:opacity-40"
\t\t\t\t\t\t\t>
\t\t\t\t\t\t\t\t다음
\t\t\t\t\t\t\t\t<ChevronRight className="h-4 w-4" />
\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t</div>`,
    `\t\t\t\t\t\t<div className="flex items-center justify-between border-t border-card-border px-3 py-3">
\t\t\t\t\t\t\t<span className="text-xs font-black">{modalItems.length} / {filteredItems.length}건</span>
\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\ttype="button"
\t\t\t\t\t\t\t\tonClick={() => setPage((value) => Math.min(pageCount, value + 1))}
\t\t\t\t\t\t\t\tdisabled={page >= pageCount}
\t\t\t\t\t\t\t\tclassName="inline-flex items-center gap-1 rounded-xl border border-card-border px-4 py-2 text-xs font-black text-primary disabled:opacity-40"
\t\t\t\t\t\t\t>
\t\t\t\t\t\t\t\t더보기
\t\t\t\t\t\t\t\t<ChevronDown className="h-4 w-4" />
\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t</div>`,
  );

  return code;
}

export function feedFiveMorePatch(): Plugin {
  return {
    name: 'feed-five-more-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/stock-info.tsx')) return null;
      const code = patchStockInfo(source);
      return code === source ? null : { code, map: null };
    },
  };
}

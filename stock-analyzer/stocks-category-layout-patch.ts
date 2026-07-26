import type { Plugin } from 'vite';

function patchStocks(source: string): string {
  let code = source;
  const categoryStart = code.indexOf(
    `\n\t\t\t\t<div className="mt-3 grid grid-cols-3 gap-2">\n\t\t\t\t\t{CATEGORIES.map`,
  );
  const searchStart = code.indexOf(`\n\t\t\t\t<SearchField`, categoryStart);

  if (categoryStart < 0 || searchStart < 0) {
    throw new Error('[stocks-category-layout-patch] 기존 분류 버튼 위치를 찾지 못했습니다.');
  }

  code = code.slice(0, categoryStart) + '\n' + code.slice(searchStart);

  const mainMarker = `\t\t\t<main className="space-y-3 px-4 pb-28 pt-4">`;
  if (!code.includes(mainMarker)) {
    throw new Error('[stocks-category-layout-patch] 종목 본문 위치를 찾지 못했습니다.');
  }

  const categoryBlock = `${mainMarker}
\t\t\t\t<section className="rounded-3xl border border-card-border bg-card p-3 shadow-sm">
\t\t\t\t\t<div className="grid grid-cols-1 gap-2">
\t\t\t\t\t\t{CATEGORIES.map((item) => (
\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\tkey={item.key}
\t\t\t\t\t\t\t\ttype="button"
\t\t\t\t\t\t\t\tonClick={() => openCategory(item.key)}
\t\t\t\t\t\t\t\tclassName="flex min-h-12 w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4 py-3 text-center text-sm font-black"
\t\t\t\t\t\t\t>
\t\t\t\t\t\t\t\t{item.label}
\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t))}
\t\t\t\t\t</div>
\t\t\t\t</section>`;

  return code.replace(mainMarker, categoryBlock);
}

export function stocksCategoryLayoutPatch(): Plugin {
  return {
    name: 'stocks-category-layout-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/stocks.tsx')) return null;
      return { code: patchStocks(source), map: null };
    },
  };
}

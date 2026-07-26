import type { Plugin } from 'vite';

const APPLIED_MARKER = 'data-stocks-category-layout="vertical"';

function patchStocks(source: string): string {
  if (source.includes(APPLIED_MARKER)) return source;

  const categoryPattern = /\n[ \t]*<div className="[^"]*grid[^"]*">[ \t\r\n]*\{CATEGORIES\.map\(\(item\) => \([\s\S]*?\)\)\}[ \t\r\n]*<\/div>[ \t\r\n]*/;
  const categoryMatch = source.match(categoryPattern);

  // 다른 선행 패치가 이미 분류 영역을 옮겼다면 빌드를 막지 않는다.
  if (!categoryMatch) return source;

  let code = source.replace(categoryPattern, '\n');
  const headerClose = code.indexOf('</header>');

  // 페이지 구조가 달라진 경우에도 앱 전체 빌드를 중단하지 않는다.
  if (headerClose < 0) return source;

  const categoryBlock = `
        <section
          data-stocks-category-layout="vertical"
          className="mt-3 rounded-3xl border border-card-border bg-card p-3 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-2">
            {CATEGORIES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => openCategory(item.key)}
                className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4 py-3 text-center text-sm font-black"
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      `;

  code = code.slice(0, headerClose) + categoryBlock + code.slice(headerClose);
  return code;
}

export function stocksCategoryLayoutPatch(): Plugin {
  return {
    name: 'stocks-category-layout-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/stocks.tsx')) return null;
      const code = patchStocks(source);
      return code === source ? null : { code, map: null };
    },
  };
}

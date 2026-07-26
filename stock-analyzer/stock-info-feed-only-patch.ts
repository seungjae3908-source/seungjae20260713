import type { Plugin } from 'vite';

export function stockInfoFeedOnlyPatch(): Plugin {
  return {
    name: 'stock-info-feed-only-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/stock-info.tsx')) return null;

      let code = source;
      const detailMarker = `\t\t\t\t\t{ticker && (`;
      if (code.includes(detailMarker)) {
        code = code.replace(detailMarker, `\t\t\t\t\t{false && ticker && (`);
      }

      code = code.replaceAll(
        `enabled: asset === 'stock' && Boolean(ticker),`,
        `enabled: false,`,
      );

      return code === source ? null : { code, map: null };
    },
  };
}

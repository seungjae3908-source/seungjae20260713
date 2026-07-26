import type { Plugin } from 'vite';

export function newPagesTypeSafetyPatch(): Plugin {
  return {
    name: 'new-pages-type-safety-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/pages/asset-evaluation.tsx')) {
        code = code.replace(
          'quoteMap = new Map(quotes.map((quote: AnyObj) => [String(quote.ticker ?? quote.symbol ?? \'\').toUpperCase(), quote]));',
          'quoteMap = new Map<string, AnyObj>(quotes.map((quote: AnyObj): [string, AnyObj] => [String(quote.ticker ?? quote.symbol ?? \'\').toUpperCase(), quote]));',
        );
        code = code.replace(
          `const spotPriceMap = new Map(
      ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row) => [`,
          `const spotPriceMap = new Map<string, AnyObj>(
      ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row): [string, AnyObj] => [`,
        );
      }

      if (normalized.endsWith('/src/pages/watchlist-assets.tsx')) {
        code = code.replace(
          `return new Map(rows.map((row) => [`,
          `return new Map<string, AnyObj>(rows.map((row): [string, AnyObj] => [`,
        );
      }

      return code === source ? null : { code, map: null };
    },
  };
}

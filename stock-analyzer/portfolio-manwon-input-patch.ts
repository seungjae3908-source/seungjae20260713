import type { Plugin } from 'vite';

export function portfolioManwonInputPatch(): Plugin {
  return {
    name: 'portfolio-manwon-input-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      let code = source;

      if (normalized.endsWith('/src/pages/portfolio-plan.tsx')) {
        code = code.replace(
          "const m = Number(monthly || '0');",
          "const m = Number(monthly || '0') * 10_000;",
        );
      }

      if (normalized.endsWith('/src/pages/portfolio-cash.tsx')) {
        code = code.replace("KRW: '만원 (KRW)'", "KRW: '원화 (KRW)'");
      }

      return code === source ? null : { code, map: null };
    },
  };
}

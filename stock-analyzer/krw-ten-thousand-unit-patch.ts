import type { Plugin } from 'vite';

function patchStockDisplay(source: string): string {
  let code = source;

  const marker = `export function formatAppPrice(value: unknown, currency: string) {`;
  if (!code.includes('function formatKrwTenThousands(')) {
    if (!code.includes(marker)) {
      throw new Error('[krw-ten-thousand-unit-patch] 가격 표시 함수 위치를 찾지 못했습니다.');
    }
    code = code.replace(
      marker,
      `function formatKrwTenThousands(value: number): string {
  const scaled = value / 10_000;
  const absolute = Math.abs(scaled);
  const maximumFractionDigits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return \`${'${scaled.toLocaleString(\'ko-KR\', { maximumFractionDigits })}'}만원\`;
}

${marker}`,
    );
  }

  code = code.replace(
    `return \`${'${Math.round(n * USD_KRW).toLocaleString()}'}원\`;`,
    `return formatKrwTenThousands(n * USD_KRW);`,
  );
  code = code.replace(
    `return \`${'${Math.round(n).toLocaleString()}'}원\`;`,
    `return formatKrwTenThousands(n);`,
  );

  return code;
}

export function krwTenThousandUnitPatch(): Plugin {
  return {
    name: 'krw-ten-thousand-unit-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/lib/stock-display.ts')) return null;
      const code = patchStockDisplay(source);
      return code === source ? null : { code, map: null };
    },
  };
}

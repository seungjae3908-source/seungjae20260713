import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[chart-relay-auto-order-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchChartRelay(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `import { DetailedSignalAnalysisWorkspace, PriceLevelAlertMonitor } from '@/components/chart-relay-price-alerts';`,
    `import { DetailedSignalAnalysisWorkspace, PriceLevelAlertMonitor } from '@/components/chart-relay-price-alerts';\nimport { ChartRelayAutoOrderApproval } from '@/components/chart-relay-auto-order-approval';`,
    'auto order import',
  );

  code = replaceOnce(
    code,
    `            <PriceLevelAlertMonitor\n              plan={displayPlan}\n              candles={candles}\n              asset={asset}\n              symbol={symbol}\n              interval={interval}\n              settings={settings}\n            />`,
    `            <PriceLevelAlertMonitor\n              plan={displayPlan}\n              candles={candles}\n              asset={asset}\n              symbol={symbol}\n              interval={interval}\n              settings={settings}\n            />\n\n            <ChartRelayAutoOrderApproval\n              plan={displayPlan}\n              candles={candles}\n              asset={asset}\n              symbol={symbol}\n              interval={interval}\n            />`,
    'auto order monitor insertion',
  );

  return code;
}

export function chartRelayAutoOrderPatch(): Plugin {
  return {
    name: 'chart-relay-auto-order-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/chart-relay.tsx')) return null;
      return { code: patchChartRelay(source), map: null };
    },
  };
}

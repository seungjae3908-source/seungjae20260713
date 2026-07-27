import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[chart-relay-focused-market-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchEnhancements(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `function finite(value: unknown): number | null {\n  const parsed = Number(value);\n  return Number.isFinite(parsed) ? parsed : null;\n}`,
    `function finite(value: unknown): number | null {\n  const parsed = Number(value);\n  return Number.isFinite(parsed) ? parsed : null;\n}\n\nfunction positive(value: unknown): number | null {\n  const parsed = finite(value);\n  return parsed != null && parsed > 0 ? parsed : null;\n}`,
    'positive price helper',
  );

  code = replaceOnce(
    code,
    `  const serverTarget = finite(rawPlan?.target);\n  const serverStop = finite(rawPlan?.stop);\n  const serverBuyLevels = Array.isArray(rawPlan?.buyLevels)\n    ? rawPlan.buyLevels.map(finite)\n    : [];\n  const serverSellLevels = Array.isArray(rawPlan?.sellLevels)\n    ? rawPlan.sellLevels.map(finite)\n    : [];`,
    `  const serverTarget = positive(rawPlan?.target);\n  const serverStop = positive(rawPlan?.stop);\n  const serverBuyLevels = Array.isArray(rawPlan?.buyLevels)\n    ? rawPlan.buyLevels.map(positive)\n    : [];\n  const serverSellLevels = Array.isArray(rawPlan?.sellLevels)\n    ? rawPlan.sellLevels.map(positive)\n    : [];`,
    'ignore zero server prices',
  );

  return code;
}

function moveStrategyAfterAnalysis(code: string): string {
  const strategyStart = code.indexOf('            <ChartRelayStrategyPanel');
  if (strategyStart < 0) return code;

  const historyStart = code.indexOf('            {historyError', strategyStart);
  if (historyStart < 0) return code;

  const strategyBlock = code.slice(strategyStart, historyStart);
  let next = code.slice(0, strategyStart) + code.slice(historyStart);

  const analysisStart = next.indexOf('            <ChartAnalysisTabs');
  if (analysisStart < 0) return code;
  const analysisEndMarker = '            />';
  const analysisEnd = next.indexOf(analysisEndMarker, analysisStart);
  if (analysisEnd < 0) return code;

  const insertAt = analysisEnd + analysisEndMarker.length;
  next = next.slice(0, insertAt) + '\n\n' + strategyBlock.trimEnd() + next.slice(insertAt);
  return next;
}

function patchChartRelay(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `import { buildDisplayPlan, PlanLevelsPanel } from '@/components/chart-relay-enhancements';`,
    `import { buildDisplayPlan } from '@/components/chart-relay-enhancements';\nimport { ChartRelayStrategyPanel } from '@/components/chart-relay-strategy-panel';`,
    'strategy component import',
  );

  code = code.replaceAll('<PlanLevelsPanel', '<ChartRelayStrategyPanel');

  code = replaceOnce(
    code,
    `  const isCoin = asset === 'coinSpot' || asset === 'coinFutures';`,
    `  const isCoin = asset === 'coinSpot' || asset === 'coinFutures';\n  const focusedRelay =\n    typeof window !== 'undefined' &&\n    new URLSearchParams(window.location.search).get('focused') === '1';\n  const relayAssetLabel =\n    asset === 'stockKR'\n      ? '국내주식'\n      : asset === 'stockUS'\n        ? '해외주식'\n        : asset === 'coinSpot'\n          ? '코인 현물'\n          : '코인 선물';`,
    'focused relay title state',
  );

  code = replaceOnce(
    code,
    `<div className="mx-auto max-w-md px-4 pb-28 pt-4">`,
    `<div className={cn('mx-auto max-w-md px-4 pt-4', focusedRelay ? 'pb-8' : 'pb-28')}>`,
    'focused relay padding',
  );

  code = replaceOnce(
    code,
    `<h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">차트중계</h1>\n            <p className="mt-1 break-keep text-center text-[11px] font-bold leading-4 text-muted-foreground">실시간 차트·신호 분석 (표시 전용)</p>`,
    `<h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">{relayAssetLabel} 차트중계</h1>\n            <p className="mt-1 break-keep text-center text-[11px] font-bold leading-4 text-muted-foreground">실시간 차트중계 · 실시간 AI분석</p>`,
    'dynamic relay page title',
  );

  // The inbox layout may already hide the in-page market switch in source.
  // Keep that final state; otherwise apply focused-route hiding to the legacy layout.
  code = code.replace(
    `<div className="relative mt-3 grid grid-cols-2 gap-2">\n          {ASSET_GROUPS.map((group) => {`,
    `<div className={cn('relative mt-3 grid grid-cols-2 gap-2', focusedRelay && 'hidden')}>\n          {ASSET_GROUPS.map((group) => {`,
  );

  code = replaceOnce(
    code,
    `onClick={() =>\n              navigate(\n                \`/tech/chart-broadcast?asset=\${encodeURIComponent(asset)}&symbol=\${encodeURIComponent(symbol)}&interval=\${encodeURIComponent(interval)}\`,\n              )\n            }`,
    `onClick={() =>\n              navigate(\n                isCoin\n                  ? \`/stock-info?asset=coin&coinMarket=\${asset === 'coinFutures' ? 'futures' : 'spot'}&symbol=\${encodeURIComponent(symbol)}\`\n                  : \`/stock-info?asset=stock&market=\${asset === 'stockUS' ? 'US' : 'KR'}&ticker=\${encodeURIComponent(symbol)}\`,\n              )\n            }`,
    'information button navigation',
  );

  code = replaceOnce(
    code,
    `            분석 화면 보기`,
    `            {isCoin ? '코인 정보' : '주식 정보'}`,
    'information button label',
  );

  code = code.replace('            실시간 차트 분석', '            실시간 차트중계');
  code = code.replace('            실시간 신호 분석', '            실시간 AI분석');

  code = code.replace(
    `<div className="flex min-h-[38px] items-center border-b border-card-border px-2 py-1.5">\n        <p className="shrink-0 text-[10px] font-black">거래량 아래 보조지표</p>\n      </div>\n      {enabled.length > 0 ? (`,
    `{enabled.length > 0 ? (`,
  );

  code = code.replace(
    `className="flex min-h-[38px] items-center gap-1 overflow-x-auto px-2 py-1.5"`,
    `className="flex min-h-[38px] items-center justify-center gap-1 overflow-x-auto px-2 py-1.5 text-center"`,
  );

  code = code.replace(
    `className="flex min-h-[38px] flex-wrap content-center gap-2 overflow-hidden border-b border-card-border px-2 py-1.5"`,
    `className="flex min-h-[38px] flex-wrap content-center justify-center gap-2 overflow-hidden border-b border-card-border px-2 py-1.5 text-center"`,
  );

  code = code.replace(
    `<div className="border-b border-card-border p-3">\n        <h2 className="text-sm font-black">차트 분석 의견</h2>`,
    `<div className="border-b border-card-border p-3 text-center">\n        <h2 className="text-sm font-black">분석 의견</h2>`,
  );

  code = moveStrategyAfterAnalysis(code);

  return code;
}

export function chartRelayFocusedMarketPatch(): Plugin {
  return {
    name: 'chart-relay-focused-market-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/chart-relay.tsx')) {
        return { code: patchChartRelay(source), map: null };
      }

      if (normalized.endsWith('/src/components/chart-relay-enhancements.tsx')) {
        return { code: patchEnhancements(source), map: null };
      }

      return null;
    },
  };
}

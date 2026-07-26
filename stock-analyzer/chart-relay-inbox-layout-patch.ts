import type { Plugin } from 'vite';

function replaceBlock(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
  label: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`[chart-relay-inbox-layout-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchChartRelay(source: string): string {
  let code = source;

  code = code.replace(
    `import { InstrumentAlertButton } from '@/components/instrument-alert-modal';`,
    `import { InstrumentAlertButton } from '@/components/instrument-alert-modal';\nimport { ChartRelayMessageInboxButton } from '@/components/chart-relay-message-inbox';\nimport { addChartRelayMessage } from '@/lib/chart-relay-message-store';\nimport { displayStockName, isInWatchlist } from '@/lib/stock-display';`,
  );

  code = code.replace(
    `  const [topBanners, setTopBanners] = useState<TopSignalBanner[]>([]);`,
    `  const [topBanners, setTopBanners] = useState<TopSignalBanner[]>([]);\n\n  useEffect(() => {\n    if (topBanners.length === 0) return;\n    if (!isInWatchlist(symbol, asset)) {\n      setTopBanners([]);\n      return;\n    }\n\n    topBanners.forEach((banner) => {\n      addChartRelayMessage({\n        id: \`signal:\${asset}:\${symbol}:\${banner.id}\`,\n        kind: 'signal',\n        symbol,\n        asset,\n        title: banner.title,\n        summary: \`\${banner.direction} · \${formatPrice(banner.price, asset)} · 중요도 \${banner.importance}\`,\n        price: banner.price,\n        occurredAt: banner.occurredAt,\n      });\n    });\n    setTopBanners([]);\n  }, [asset, symbol, topBanners]);`,
  );

  code = replaceBlock(
    code,
    `        {topBanners.length > 0 && (`,
    `        {/* 자산 선택 */}`,
    ``,
    '상단 알림 배너 제거',
  );

  code = replaceBlock(
    code,
    `        {/* 자산 선택 */}`,
    `        {/* 종목 입력 */}`,
    `        {/* 종목 입력 */}`,
    '주식 코인 선택 탭 제거',
  );

  code = code.replace(
    /\s*<p className="mt-1\.5 text-center text-\[11px\] font-bold text-muted-foreground">[\s\S]*?<\/p>\s*<div className="mt-2 grid grid-cols-3 gap-2">/,
    `\n        <div className="mt-2 flex items-center justify-center gap-2 text-center">\n          <span className="text-sm font-black text-foreground">\n            {displayStockName(symbol, symbol)}\n          </span>\n          <span\n            className={cn(\n              'text-xs font-black',\n              latestBarChangePercent == null\n                ? 'text-muted-foreground'\n                : latestBarChangePercent >= 0\n                  ? 'text-red-500'\n                  : 'text-blue-500',\n            )}\n          >\n            {latestBarChangePercent == null\n              ? '등락률 없음'\n              : \`\${latestBarChangePercent >= 0 ? '+' : ''}\${latestBarChangePercent.toFixed(2)}%\`}\n          </span>\n        </div>\n        <div className="mt-2 grid grid-cols-3 gap-2">`,
  );

  code = code.replace(
    /\s*<button\n\s*type="button"\n\s*onClick=\{\(\) =>[\s\S]*?\n\s*className="h-10 rounded-xl border border-card-border bg-card px-2 text-xs font-black"\n\s*>[\s\S]*?<\/button>\n\s*<\/div>/,
    `\n          <ChartRelayMessageInboxButton />\n        </div>`,
  );

  return code;
}

function patchPriceAlerts(source: string): string {
  let code = source;

  code = code.replace(
    `import { cn } from '@/lib/utils';`,
    `import { cn } from '@/lib/utils';\nimport { isInWatchlist } from '@/lib/stock-display';\nimport { addChartRelayMessage } from '@/lib/chart-relay-message-store';`,
  );

  code = code.replace(
    `      writeLastAlert(symbol, interval, level, now);\n\n      const nextAlert: ReachedAlert = {`,
    `      writeLastAlert(symbol, interval, level, now);\n      if (!isInWatchlist(symbol, asset)) continue;\n\n      addChartRelayMessage({\n        id: \`price:\${asset}:\${symbol}:\${interval}:\${level.key}:\${level.price}:\${now}\`,\n        kind: 'price',\n        symbol,\n        asset,\n        title: level.label,\n        summary: \`기준 \${formatPrice(level.price, asset)} · 현재 \${formatPrice(currentPrice, asset)}\`,\n        price: level.price,\n        occurredAt: new Date(now).toISOString(),\n      });\n\n      const nextAlert: ReachedAlert = {`,
  );

  code = code.replace(
    `{alerts.length > 0 && (`,
    `{false && alerts.length > 0 && (`,
  );

  return code;
}

export function chartRelayInboxLayoutPatch(): Plugin {
  return {
    name: 'chart-relay-inbox-layout-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/chart-relay.tsx')) {
        return { code: patchChartRelay(source), map: null };
      }

      if (normalized.endsWith('/src/components/chart-relay-price-alerts.tsx')) {
        return { code: patchPriceAlerts(source), map: null };
      }

      return null;
    },
  };
}

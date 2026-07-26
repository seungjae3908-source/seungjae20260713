import type { Plugin } from 'vite';

function replaceRequired(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[chart-relay-inbox-layout-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchChartRelay(source: string): string {
  let code = source;

  code = replaceRequired(
    code,
    `import { InstrumentAlertButton } from '@/components/instrument-alert-modal';`,
    `import { ChartRelayMessageInboxButton } from '@/components/chart-relay-message-inbox';\nimport { addChartRelayMessage } from '@/lib/chart-relay-message-store';\nimport { displayStockName, isInWatchlist } from '@/lib/stock-display';`,
    '메시지함 import',
  );

  code = replaceRequired(
    code,
    `  const [topBanners, setTopBanners] = useState<TopSignalBanner[]>([]);`,
    `  const [topBanners, setTopBanners] = useState<TopSignalBanner[]>([]);\n\n  useEffect(() => {\n    if (topBanners.length === 0) return;\n    if (!isInWatchlist(symbol, asset)) {\n      setTopBanners([]);\n      return;\n    }\n\n    topBanners.forEach((banner) => {\n      addChartRelayMessage({\n        id: \`signal:\${asset}:\${symbol}:\${banner.id}\`,\n        kind: 'signal',\n        symbol,\n        asset,\n        title: banner.title,\n        summary: \`\${banner.direction} · \${formatPrice(banner.price, asset)} · 중요도 \${banner.importance}\`,\n        price: banner.price,\n        occurredAt: banner.occurredAt,\n      });\n    });\n    setTopBanners([]);\n  }, [asset, symbol, topBanners]);`,
    '상단 알림 메시지함 저장',
  );

  code = code.replace(
    `{topBanners.length > 0 && (`,
    `{false && topBanners.length > 0 && (`,
  );

  code = code.replace(
    `<div className={cn('relative mt-3 grid grid-cols-2 gap-2', focusedRelay && 'hidden')}>`,
    `<div className="hidden">`,
  );
  code = code.replace(
    `<div className="relative mt-3 grid grid-cols-2 gap-2">`,
    `<div className="hidden">`,
  );

  const statusBlock = `        <p className="mt-1.5 text-center text-[11px] font-bold text-muted-foreground">\n          현재 종목: <span className="font-black text-foreground">{symbol || '해당 종목 없음'}</span>\n          {' · '}실시간: <span title={realtime.error ?? undefined}>{realtimeLabel}</span>\n          {latestPrice != null && (\n            <>\n              {' · '}\n              <span className="font-black text-foreground">{formatPrice(latestPrice, asset)}</span>\n              {latestBarChangePercent != null\n                ? \` · 직전 봉 대비 \${latestBarChangePercent >= 0 ? '+' : ''}\${latestBarChangePercent.toFixed(2)}%\`\n                : ''}\n            </>\n          )}\n        </p>`;

  const compactStatus = `        <div className="mt-2 flex items-center justify-center gap-2 text-center">\n          <span className="text-sm font-black text-foreground">\n            {displayStockName(symbol, symbol)}\n          </span>\n          <span\n            className={cn(\n              'text-xs font-black',\n              latestBarChangePercent == null\n                ? 'text-muted-foreground'\n                : latestBarChangePercent >= 0\n                  ? 'text-red-500'\n                  : 'text-blue-500',\n            )}\n          >\n            {latestBarChangePercent == null\n              ? '등락률 없음'\n              : \`\${latestBarChangePercent >= 0 ? '+' : ''}\${latestBarChangePercent.toFixed(2)}%\`}\n          </span>\n        </div>`;

  if (code.includes(statusBlock)) {
    code = code.replace(statusBlock, compactStatus);
  } else if (!code.includes('displayStockName(symbol, symbol)')) {
    throw new Error(
      '[chart-relay-inbox-layout-patch] 현재 종목 상태 문구 축약 위치를 찾지 못했습니다.',
    );
  }

  const alertButton = `          <InstrumentAlertButton\n            symbol={symbol}\n            name={symbol}\n            assetType={asset}\n            market={watchMarket}\n            currency={watchCurrency}\n            currentPrice={latestPrice}\n            className="flex h-10 items-center justify-center gap-1 rounded-xl border border-card-border bg-card text-xs font-black"\n          />`;

  code = replaceRequired(
    code,
    alertButton,
    `          <ChartRelayMessageInboxButton />`,
    '알림 버튼을 메시지함으로 교체',
  );

  return code;
}

function patchPriceAlerts(source: string): string {
  let code = source;

  code = replaceRequired(
    code,
    `import { cn } from '@/lib/utils';`,
    `import { cn } from '@/lib/utils';\nimport { isInWatchlist } from '@/lib/stock-display';\nimport { addChartRelayMessage } from '@/lib/chart-relay-message-store';`,
    '가격 알림 메시지함 import',
  );

  code = replaceRequired(
    code,
    `      writeLastAlert(symbol, interval, level, now);\n\n      const nextAlert: ReachedAlert = {`,
    `      writeLastAlert(symbol, interval, level, now);\n      if (!isInWatchlist(symbol, asset)) continue;\n\n      addChartRelayMessage({\n        id: \`price:\${asset}:\${symbol}:\${interval}:\${level.key}:\${level.price}:\${now}\`,\n        kind: 'price',\n        symbol,\n        asset,\n        title: level.label,\n        summary: \`기준 \${formatPrice(level.price, asset)} · 현재 \${formatPrice(currentPrice, asset)}\`,\n        price: level.price,\n        occurredAt: new Date(now).toISOString(),\n      });\n\n      const nextAlert: ReachedAlert = {`,
    '가격 도달 메시지함 저장',
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

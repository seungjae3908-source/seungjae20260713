import type { Plugin } from 'vite';

function ensureReactHook(source: string, hook: string): string {
  return source.replace(
    /import \{([^}]*)\} from ['"]react['"];?/,
    (full, hooks: string) => {
      if (hooks.split(',').map((item) => item.trim()).includes(hook)) return full;
      return `import { ${hook},${hooks} } from 'react';`;
    },
  );
}

function replaceSectionTags(segment: string): string {
  return segment
    .replace(/<SectionCard\b/g, '<PopupSectionCard')
    .replace(/<\/SectionCard>/g, '</PopupSectionCard>')
    .replace(/<CollapsibleSection\b/g, '<PopupSectionCard')
    .replace(/<\/CollapsibleSection>/g, '</PopupSectionCard>');
}

function ensurePopupSectionCard(source: string): string {
  if (source.includes('function PopupSectionCard(')) return source;
  const marker = 'function inferCompanyBusiness(';
  if (!source.includes(marker)) return source;

  const component = `function PopupSectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="flex min-h-[72px] w-full flex-col items-center justify-center rounded-2xl border border-card-border bg-card px-4 py-3 text-center shadow-sm"
      >
        <span className="break-keep text-base font-extrabold leading-6">{title}</span>
        {subtitle ? (
          <span className="mt-1 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </button>

      {modalOpen ? (
        <Modal title={title} subtitle={subtitle} onClose={() => setModalOpen(false)}>
          {actions ? <div className="mb-3 flex items-center justify-center">{actions}</div> : null}
          <div className="text-center">{children}</div>
        </Modal>
      ) : null}
    </>
  );
}

`;

  return source.replace(marker, `${component}${marker}`);
}

function patchSettings(source: string): string {
  return source
    .replaceAll('h-[112px]', 'h-[64px]')
    .replaceAll('h-[76px]', 'h-[64px]')
    .replaceAll('rounded-3xl border border-card-border bg-card/90 px-5 py-4', 'rounded-2xl border border-card-border bg-card/90 px-4 py-2')
    .replaceAll('rounded-3xl border border-primary/40 bg-primary/10 px-5 py-4', 'rounded-2xl border border-primary/40 bg-primary/10 px-4 py-2');
}

function patchDetail(source: string): string {
  let code = source
    .replaceAll('stock-detail-core-v16', 'stock-detail-core-v17')
    .replaceAll('stock-detail-identity-v16', 'stock-detail-identity-v17')
    .replaceAll('stock-detail-advanced-v16', 'stock-detail-advanced-v17')
    .replace(
      'const timeout = window.setTimeout(() => controller.abort(), 15_000);',
      'const timeout = window.setTimeout(() => controller.abort(), 8_000);',
    )
    .replace(
      `      [
        \`/api/stocks/\${upper}/disclosures?all=1\`,
        \`/api/stocks/\${upper}/filings?all=1\`,
        \`/api/stocks/\${upper}/disclosures\`,
        \`/api/stocks/\${upper}/filings\`,
      ],`,
      `      [\`/api/stocks/\${upper}/filings\`, \`/api/stocks/\${upper}/disclosures\`],`,
    )
    .replace(
      `[\`/api/stocks/\${upper}/news?all=1\`, \`/api/stocks/\${upper}/news\`]`,
      `[\`/api/stocks/\${upper}/news\`]`,
    )
    .replace('limit=2000', 'limit=500')
    .replace(
      `    enabled: Boolean(
      ticker && permissions.canUseAdvancedAnalysis && coreDetail.data,
    ),`,
      `    enabled: Boolean(ticker && permissions.canUseAdvancedAnalysis),`,
    );

  code = ensurePopupSectionCard(code);

  const chartStart = code.indexOf('function ChartTab(');
  const chartEndCandidates = [
    code.indexOf('function FinancialTab(', chartStart + 1),
    code.indexOf('function FilingTab(', chartStart + 1),
    code.indexOf('function NewsTab(', chartStart + 1),
  ].filter((index) => index > chartStart);
  const chartEnd = chartEndCandidates.length ? Math.min(...chartEndCandidates) : -1;

  if (chartStart >= 0 && chartEnd > chartStart) {
    code =
      replaceSectionTags(code.slice(0, chartStart)) +
      code.slice(chartStart, chartEnd) +
      replaceSectionTags(code.slice(chartEnd));
  }

  code = code
    .replace(
      'grid grid-cols-[36px_minmax(0,1fr)_auto_36px_36px] items-center gap-2',
      'grid grid-cols-[36px_minmax(0,1fr)_36px_36px] items-center gap-2',
    )
    .replace('<div className="min-w-0">', '<div className="min-w-0 text-center">')
    .replace(
      '<div className="flex min-w-0 items-center gap-2">',
      '<div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5">',
    )
    .replace(
      '<h1 className="truncate text-lg font-extrabold">{companyName}</h1>',
      '<h1 className="max-w-full break-keep text-center text-lg font-extrabold leading-tight">{companyName || ticker}</h1>',
    )
    .replace(
      `<p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
              {ticker}
            </p>`,
      `<div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] font-bold text-muted-foreground">
              <span>{ticker}</span>
              <span>{formatAppPrice(data?.quote?.price, currency)}</span>
              <span className={changePositive ? "text-positive" : "text-destructive"}>
                {formatAppPercent(data?.quote?.changePercent)}
              </span>
            </div>`,
    )
    .replace(
      /\n\s*<div className="shrink-0 text-right">[\s\S]*?<\/div>\n\n\s*<button\n\s*type="button"\n\s*aria-label="알림 설정"/,
      `

          <button
            type="button"
            aria-label="알림 설정"`,
    );

  return code;
}

function patchStocks(source: string): string {
  let code = ensureReactHook(source, 'useDeferredValue');

  code = code
    .replace(
      `\tconst trimmed = query.trim();
\tconst searching = trimmed.length > 0;`,
      `\tconst trimmed = query.trim();
\tconst deferredTrimmed = useDeferredValue(trimmed);
\tconst searching = deferredTrimmed.length > 0;`,
    )
    .replace(
      `queryKey: ['stocks-directory', mode.stockMarket, trimmed],`,
      `queryKey: ['stocks-directory', mode.stockMarket, deferredTrimmed],`,
    )
    .replace('queryFn: () => api.searchRows(trimmed),', 'queryFn: () => api.searchRows(deferredTrimmed),')
    .replace(
      `\t\tstaleTime: 0,
\t\trefetchInterval: 5_000,
\t\trefetchOnMount: true,
\t\trefetchOnWindowFocus: true,
\t\trefetchOnReconnect: true,`,
      `\t\tstaleTime: 2 * 60_000,
\t\tgcTime: 15 * 60_000,
\t\trefetchOnMount: false,
\t\trefetchOnWindowFocus: false,
\t\trefetchOnReconnect: true,
\t\tretry: 1,
\t\tplaceholderData: (previous: unknown) => previous,`,
    )
    .replaceAll(
      `\t\tstaleTime: 0,
\t\trefetchInterval: 5_000,
\t\trefetchOnMount: true,
\t\trefetchOnWindowFocus: true,
\t\trefetchOnReconnect: true,`,
      `\t\tstaleTime: 30_000,
\t\tgcTime: 10 * 60_000,
\t\trefetchInterval: 60_000,
\t\trefetchOnMount: false,
\t\trefetchOnWindowFocus: false,
\t\trefetchOnReconnect: true,
\t\tretry: 1,`,
    );

  return code;
}

function patchSignalScan(source: string): string {
  return source
    .replace(
      `    enabled: !futuresLocked,
    refetchInterval: 60_000,
  });`,
      `    enabled: !futuresLocked,
    staleTime: 5 * 60_000,
    gcTime: 20 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (previous: ScanResponse | undefined) => previous,
  });`,
    )
    .replace(
      'className="mx-auto max-w-md px-4 pb-28 pt-4"',
      'className="w-full min-w-0 px-4 pb-28 pt-4"',
    )
    .replace(
      'className="grid grid-cols-[40px_1fr_40px] items-center gap-3"',
      'className="grid w-full grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-3"',
    )
    .replace('<div className="text-center">', '<div className="min-w-0 text-center">')
    .replace('<h1 className="text-lg font-extrabold">신호검색</h1>', '<h1 className="whitespace-nowrap text-lg font-extrabold">신호검색</h1>');
}

function patchScanner(source: string): string {
  return source
    .replace(
      `    enabled: selected.length > 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });`,
      `    enabled: selected.length > 0,
    staleTime: 2 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
    placeholderData: (previous: unknown) => previous,
  });`,
    )
    .replace(
      'className="h-full overflow-y-auto overscroll-contain bg-background"',
      'className="h-full w-full min-w-0 overflow-y-auto overscroll-contain bg-background"',
    )
    .replace(
      'className="border-b border-card-border px-4 pb-3 pt-4"',
      'className="w-full min-w-0 border-b border-card-border px-4 pb-3 pt-4"',
    )
    .replace(
      'className="mb-3 flex items-center justify-between gap-3"',
      'className="mb-3 grid w-full grid-cols-[minmax(0,1fr)_40px] items-center gap-3"',
    )
    .replace(
      '<h1 className="text-xl font-extrabold">도구</h1>',
      '<h1 className="min-w-0 text-center text-xl font-extrabold">도구</h1>',
    )
    .replace(
      '<main className="space-y-4 p-4 pb-24">',
      '<main className="w-full min-w-0 space-y-4 p-4 pb-24">',
    );
}

function patchTech(source: string): string {
  return source
    .replace(
      'className="mx-auto max-w-md px-4 pb-28 pt-6"',
      'className="w-full min-w-0 px-4 pb-28 pt-6"',
    )
    .replace(
      'className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-4 text-left"',
      'className="flex w-full min-w-0 items-center gap-3 rounded-2xl border border-card-border bg-card p-4 text-left"',
    );
}

export function requestedSixFixesPatch(): Plugin {
  return {
    name: 'requested-six-fixes-patch',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/more.tsx')) {
        const code = patchSettings(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/detail.tsx')) {
        const code = patchDetail(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/stocks.tsx')) {
        const code = patchStocks(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/signal-scan.tsx')) {
        const code = patchSignalScan(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/scanner.tsx')) {
        const code = patchScanner(source);
        return code === source ? null : { code, map: null };
      }
      if (normalized.endsWith('/src/pages/tech.tsx')) {
        const code = patchTech(source);
        return code === source ? null : { code, map: null };
      }

      return null;
    },
  };
}

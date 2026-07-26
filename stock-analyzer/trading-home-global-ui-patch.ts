import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
) {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[trading-home-global-ui-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchCurrency(source: string) {
  let code = source;
  code = code.replace(
    `return \`$\${(n / USD_KRW).toLocaleString(undefined, {\n      maximumFractionDigits: 2,\n    })}\`;`,
    `return \`\${(n / USD_KRW).toLocaleString(undefined, {\n      maximumFractionDigits: 2,\n    })}달러\`;`,
  );
  code = code.replace(
    `return \`$\${n.toLocaleString(undefined, {\n      maximumFractionDigits: n >= 100 ? 2 : 4,\n    })}\`;`,
    `return \`\${n.toLocaleString(undefined, {\n      maximumFractionDigits: n >= 100 ? 2 : 4,\n    })}달러\`;`,
  );
  return code;
}

function patchCoinSpotTools(source: string) {
  let code = source;
  code = replaceOnce(
    code,
    `import { cn } from '@/lib/utils';`,
    `import { cn } from '@/lib/utils';\nimport { useMemberPermissions } from '@/lib/permissions';\nimport { AutoTradeJournalModal, UsdKrwCalculator } from '@/components/auto-trade-extras';\nimport { CoinSpotRealOrder } from '@/components/coin-spot-real-order';`,
    'coin spot extra imports',
  );

  code = replaceOnce(
    code,
    `  const assetMode = useAssetMode();`,
    `  const assetMode = useAssetMode();\n  const permissions = useMemberPermissions();`,
    'coin spot permissions',
  );

  code = replaceOnce(
    code,
    `  const [explanation, setExplanation] = useState<{ title: string; body: string } | null>(null);`,
    `  const [explanation, setExplanation] = useState<{ title: string; body: string } | null>(null);\n  const [journalOpen, setJournalOpen] = useState(false);`,
    'coin spot journal state',
  );

  code = code.replace(
    `          ] as const).map(([key, label]) => (`,
    `          ] as const).filter(([key]) => key !== 'auto' || permissions.canUseAutoTrading).map(([key, label]) => (`,
  );
  code = code.replace(
    `{viewMode === 'auto' && (`,
    `{viewMode === 'auto' && permissions.canUseAutoTrading && (`,
  );

  code = replaceOnce(
    code,
    `            <UnifiedSectionCard\n              title="실제 보유 포지션"`,
    `            <CoinSpotRealOrder\n              symbol={symbol}\n              currentPrice={finite(selected?.price)}\n              availableAsset={\n                spotPositions.find((position) => position.symbol === symbol)?.balance ?? 0\n              }\n              onExecuted={() => {\n                void accounts.refetch();\n                void spotJournal.refetch();\n              }}\n            />\n\n            <UnifiedSectionCard\n              title="실제 보유 포지션"`,
    'coin spot order panel',
  );

  code = replaceOnce(
    code,
    `              <div className="flex justify-end"><button type="button" onClick={() => void accounts.refetch()} disabled={accounts.isFetching} className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black disabled:opacity-50">{accounts.isFetching ? '갱신 중' : '새로고침'}</button></div>`,
    `              <div className="flex justify-end"><button type="button" onClick={() => void accounts.refetch()} disabled={accounts.isFetching} className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black disabled:opacity-50">{accounts.isFetching ? '갱신 중' : '새로고침'}</button></div>\n              <UsdKrwCalculator className="mt-3" />`,
    'coin spot dollar calculator',
  );

  const journalStart = code.indexOf(
    `            <UnifiedSectionCard\n              title="자동매매 매매일지"`,
  );
  if (journalStart < 0) {
    throw new Error('[trading-home-global-ui-patch] 코인 현물 매매일지 위치를 찾지 못했습니다.');
  }
  const journalEndMarker = '            </UnifiedSectionCard>';
  const journalEnd = code.indexOf(journalEndMarker, journalStart);
  if (journalEnd < 0) {
    throw new Error('[trading-home-global-ui-patch] 코인 현물 매매일지 끝을 찾지 못했습니다.');
  }
  const replacement = `            <button\n              type="button"\n              onClick={() => setJournalOpen(true)}\n              className="w-full rounded-3xl border border-primary/40 bg-primary/10 px-4 py-4 text-center text-sm font-black text-primary"\n            >\n              자동매매 매매일지 보기 ({journalEntries.length}건)\n            </button>\n\n            <AutoTradeJournalModal\n              open={journalOpen}\n              onClose={() => setJournalOpen(false)}\n              entries={journalEntries}\n              kind="spot"\n              loading={spotJournal.isFetching}\n              error={spotJournal.isError}\n              onRefresh={() => void spotJournal.refetch()}\n            />`;
  code =
    code.slice(0, journalStart) +
    replacement +
    code.slice(journalEnd + journalEndMarker.length);

  return code;
}

function patchScanner(source: string) {
  let code = source;
  code = replaceOnce(
    code,
    `import { cn } from "@/lib/utils";`,
    `import { cn } from "@/lib/utils";\nimport { AutoTradeJournalModal, UsdKrwCalculator } from '@/components/auto-trade-extras';`,
    'scanner extra imports',
  );
  code = replaceOnce(
    code,
    `  const [candidateListOpen, setCandidateListOpen] = useState(false);`,
    `  const [candidateListOpen, setCandidateListOpen] = useState(false);\n  const [journalOpen, setJournalOpen] = useState(false);`,
    'scanner journal state',
  );

  code = replaceOnce(
    code,
    `      </div>\n\n          <div className="mt-2 grid grid-cols-2 gap-2">`,
    `      </div>\n\n          <UsdKrwCalculator className="mt-3" />\n\n          <div className="mt-2 grid grid-cols-2 gap-2">`,
    'scanner dollar calculator',
  );

  const journalStart = code.indexOf(
    `          <div className="mt-5 border-t border-card-border pt-4">`,
  );
  if (journalStart < 0) {
    throw new Error('[trading-home-global-ui-patch] 주식 매매일지 위치를 찾지 못했습니다.');
  }
  code =
    code.slice(0, journalStart) +
    `          <button\n            type="button"\n            onClick={() => setJournalOpen(true)}\n            className="mt-5 w-full rounded-2xl border border-primary/40 bg-primary/10 px-4 py-4 text-center text-sm font-extrabold text-primary"\n          >\n            자동매매 매매일지 보기 ({tradeJournal.data?.length ?? 0}건)\n          </button>\n\n          <div className="hidden mt-5 border-t border-card-border pt-4">` +
    code.slice(journalStart + `          <div className="mt-5 border-t border-card-border pt-4">`.length);

  code = replaceOnce(
    code,
    `        {candidateListOpen && (`,
    `        <AutoTradeJournalModal\n          open={journalOpen}\n          onClose={() => setJournalOpen(false)}\n          entries={tradeJournal.data ?? []}\n          kind="stock"\n          loading={tradeJournal.isFetching}\n          error={tradeJournal.isError}\n          onRefresh={() => void tradeJournal.refetch()}\n        />\n\n        {candidateListOpen && (`,
    'scanner journal modal',
  );
  return code;
}

function patchPortfolio(source: string) {
  let code = source;
  code = replaceOnce(
    code,
    `import { toKrw, weightPercent } from '@/lib/portfolio-calc';`,
    `import { toKrw, weightPercent } from '@/lib/portfolio-calc';\nimport { PortfolioPlannerModals } from '@/components/portfolio-planner-modals';`,
    'portfolio planner import',
  );

  const summaryStart = code.indexOf('<PortfolioSummaryCard');
  const navStart = code.indexOf(
    '<div className="grid grid-cols-1 gap-2">',
    summaryStart,
  );
  if (summaryStart < 0 || navStart < 0) {
    throw new Error('[trading-home-global-ui-patch] 포트폴리오 계획 삽입 위치를 찾지 못했습니다.');
  }
  code =
    code.slice(0, navStart) +
    '<PortfolioPlannerModals />\n\n\t\t\t\t\t\t\t' +
    code.slice(navStart);
  return code;
}

function patchSettings(source: string) {
  return source
    .replace(
      'className="flex min-h-screen flex-col bg-background"',
      'className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-background"',
    )
    .replace(
      'className="flex-1 space-y-5 overflow-y-auto px-5 py-5 pb-28"',
      'className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5 pb-[calc(7rem+env(safe-area-inset-bottom))]"',
    );
}

const globalUiScript = `
function removeBackButtons() {
  document.querySelectorAll('button, a').forEach((element) => {
    const label = (element.getAttribute('aria-label') || '').trim();
    const text = (element.textContent || '').replace(/\\s+/g, ' ').trim();
    if (
      label === '이전 화면' ||
      label === '뒤로가기' ||
      text === '이전' ||
      text === '이전 화면' ||
      text === '뒤로가기'
    ) {
      element.remove();
    }
  });
}
new MutationObserver(removeBackButtons).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
removeBackButtons();
`;

export function tradingHomeGlobalUiPatch(): Plugin {
  return {
    name: 'trading-home-global-ui-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (normalized.endsWith('/src/lib/stock-display.ts')) {
        return { code: patchCurrency(source), map: null };
      }
      if (normalized.endsWith('/src/components/coin-spot-tools.tsx')) {
        return { code: patchCoinSpotTools(source), map: null };
      }
      if (normalized.endsWith('/src/pages/scanner.tsx')) {
        return { code: patchScanner(source), map: null };
      }
      if (normalized.endsWith('/src/pages/portfolio.tsx')) {
        return { code: patchPortfolio(source), map: null };
      }
      if (normalized.endsWith('/src/pages/more.tsx')) {
        return { code: patchSettings(source), map: null };
      }
      return null;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', id: 'global-back-button-cleanup' },
          children: globalUiScript,
          injectTo: 'body',
        },
      ];
    },
  };
}

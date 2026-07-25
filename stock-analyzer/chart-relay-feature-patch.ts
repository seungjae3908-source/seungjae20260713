import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[chart-relay-feature-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchRelayChartLibrary(source: string): string {
  return replaceOnce(
    source,
    `  chart.subscribeClick((param: any) => {\n    for (const [series, explanation] of lineExplanations) {\n      if (param?.seriesData?.has?.(series)) {\n        showExplanationModal(explanation);\n        return;\n      }\n    }\n\n    if (!param?.point || !mainCandleSeries || priceLines.length === 0) return;`,
    `  chart.subscribeClick((param: any) => {\n    const hoveredSeries = param?.hoveredSeries;\n    if (hoveredSeries && lineExplanations.has(hoveredSeries)) {\n      showExplanationModal(lineExplanations.get(hoveredSeries)!);\n      return;\n    }\n\n    if (!param?.point || !mainCandleSeries || priceLines.length === 0) return;`,
    'indicator click hit test',
  );
}

function patchChartRelay(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    "import { InstrumentAlertButton } from '@/components/instrument-alert-modal';",
    "import { InstrumentAlertButton } from '@/components/instrument-alert-modal';\nimport { buildDisplayPlan, PlanLevelsPanel, SignalAnalysisWorkspace } from '@/components/chart-relay-enhancements';",
    'enhancement import',
  );

  code = replaceOnce(
    code,
    `  buyLevels: boolean;\n  sellLevels: boolean;`,
    `  buyLevels: boolean;\n  buyLevel1: boolean;\n  buyLevel2: boolean;\n  buyLevel3: boolean;\n  sellLevels: boolean;\n  sellLevel1: boolean;\n  sellLevel2: boolean;\n  sellLevel3: boolean;`,
    'individual level setting types',
  );

  code = replaceOnce(
    code,
    `  buyLevels: true,\n  sellLevels: true,`,
    `  buyLevels: true,\n  buyLevel1: true,\n  buyLevel2: true,\n  buyLevel3: true,\n  sellLevels: true,\n  sellLevel1: true,\n  sellLevel2: true,\n  sellLevel3: true,`,
    'individual level defaults',
  );

  code = replaceOnce(
    code,
    `  { key: 'buyLevels', label: '분할매수' },\n  { key: 'sellLevels', label: '분할매도' },`,
    `  { key: 'buyLevels', label: '분할매수 전체' },\n  { key: 'buyLevel1', label: '1차 분할매수' },\n  { key: 'buyLevel2', label: '2차 분할매수' },\n  { key: 'buyLevel3', label: '3차 분할매수' },\n  { key: 'sellLevels', label: '분할매도 전체' },\n  { key: 'sellLevel1', label: '1차 분할매도' },\n  { key: 'sellLevel2', label: '2차 분할매도' },\n  { key: 'sellLevel3', label: '3차 분할매도' },`,
    'individual level labels',
  );

  code = replaceOnce(
    code,
    `    buyLevels: value,\n    sellLevels: value,`,
    `    buyLevels: value,\n    buyLevel1: value,\n    buyLevel2: value,\n    buyLevel3: value,\n    sellLevels: value,\n    sellLevel1: value,\n    sellLevel2: value,\n    sellLevel3: value,`,
    'settingsWithValue individual levels',
  );

  code = replaceOnce(
    code,
    `      'liveSignal', 'volumeSignal', 'indicatorSignal', 'highlight', 'target', 'stop', 'buyLevels',\n      'sellLevels', 'ai',`,
    `      'liveSignal', 'volumeSignal', 'indicatorSignal', 'highlight', 'target', 'stop',\n      'buyLevels', 'buyLevel1', 'buyLevel2', 'buyLevel3',\n      'sellLevels', 'sellLevel1', 'sellLevel2', 'sellLevel3', 'ai',`,
    'analysis setting key list',
  );

  const oldPricePlan = `    if (tab === 'ai' && settings.ai && plan) {\n      const candidates: Array<{ price: number | null; color: string; title: string; on: boolean }> = [\n        { price: plan.target, color: '#f97316', title: '목표가', on: settings.target },\n        { price: plan.stop, color: '#0ea5e9', title: '손절가', on: settings.stop },\n        ...plan.buyLevels.slice(0, 3).map((price, index) => ({\n          price,\n          color: '#ef4444',\n          title: \`${'${index + 1}'}차 매수\`,\n          on: settings.buyLevels,\n        })),\n        ...plan.sellLevels.slice(0, 3).map((price, index) => ({\n          price,\n          color: '#3b82f6',\n          title: \`${'${index + 1}'}차 매도\`,\n          on: settings.sellLevels,\n        })),\n      ];`;

  const newPricePlan = `    if (tab === 'live' && plan) {\n      const candidates: Array<{ price: number | null; color: string; title: string; on: boolean }> = [\n        { price: plan.target, color: '#f97316', title: '목표가', on: settings.target },\n        { price: plan.buyLevels[0] ?? null, color: '#ef4444', title: '1차 분할매수', on: settings.buyLevels && settings.buyLevel1 },\n        { price: plan.buyLevels[1] ?? null, color: '#ef4444', title: '2차 분할매수', on: settings.buyLevels && settings.buyLevel2 },\n        { price: plan.buyLevels[2] ?? null, color: '#ef4444', title: '3차 분할매수', on: settings.buyLevels && settings.buyLevel3 },\n        { price: plan.sellLevels[0] ?? null, color: '#3b82f6', title: '1차 분할매도', on: settings.sellLevels && settings.sellLevel1 },\n        { price: plan.sellLevels[1] ?? null, color: '#3b82f6', title: '2차 분할매도', on: settings.sellLevels && settings.sellLevel2 },\n        { price: plan.sellLevels[2] ?? null, color: '#3b82f6', title: '3차 분할매도', on: settings.sellLevels && settings.sellLevel3 },\n        { price: plan.stop, color: '#0ea5e9', title: '손절가', on: settings.stop },\n      ];`;

  code = replaceOnce(code, oldPricePlan, newPricePlan, 'live chart plan price lines');

  code = replaceOnce(
    code,
    `  }, [activeSignalId, candles, signals]);`,
    `  }, [\n    activeSignalId,\n    candles,\n    plan,\n    settings.buyLevel1,\n    settings.buyLevel2,\n    settings.buyLevel3,\n    settings.buyLevels,\n    settings.sellLevel1,\n    settings.sellLevel2,\n    settings.sellLevel3,\n    settings.sellLevels,\n    settings.stop,\n    settings.target,\n    signals,\n    tab,\n  ]);`,
    'price line effect dependencies',
  );

  code = replaceOnce(
    code,
    `  const latestPrice = latestCandle?.close ?? null;`,
    `  const latestPrice = latestCandle?.close ?? null;\n  const displayPlan = useMemo(\n    () => buildDisplayPlan(plan, candles, symbol),\n    [candles, plan, symbol],\n  );`,
    'fallback display plan',
  );

  code = replaceOnce(
    code,
    `        ) : (\n          <>\n            {/* 차트 영역 */}`,
    `        ) : tab === 'live' ? (\n          <>\n            {/* 차트 영역 */}`,
    'dedicated tab body start',
  );

  code = replaceOnce(
    code,
    `            </section>\n            {historyError && (`,
    `            </section>\n\n            <PlanLevelsPanel\n              plan={displayPlan}\n              asset={asset}\n              settings={settings}\n            />\n\n            {historyError && (`,
    'plan levels panel insertion',
  );

  const bodyStart = code.indexOf('{/* 본문 */}');
  const modalStart = code.indexOf('{modalSignal &&', bodyStart);
  if (bodyStart < 0 || modalStart < 0) {
    throw new Error('[chart-relay-feature-patch] 본문 또는 모달 경계를 찾지 못했습니다.');
  }
  const beforeModal = code.slice(bodyStart, modalStart);
  const bodyClose = `          </>\n        )}\n`;
  const bodyCloseIndex = beforeModal.lastIndexOf(bodyClose);
  if (bodyCloseIndex < 0 && !beforeModal.includes('<SignalAnalysisWorkspace')) {
    throw new Error('[chart-relay-feature-patch] 차트 본문 닫힘 위치를 찾지 못했습니다.');
  }
  if (bodyCloseIndex >= 0) {
    const absoluteIndex = bodyStart + bodyCloseIndex;
    const replacement = `          </>\n        ) : (\n          <SignalAnalysisWorkspace\n            query={signalsQuery}\n            signals={signals}\n            activeSignalId={activeSignalId}\n            onSelect={selectSignal}\n            plan={displayPlan}\n            asset={asset}\n            symbol={symbol}\n            interval={interval}\n          />\n        )}\n`;
    code = code.slice(0, absoluteIndex) + replacement + code.slice(absoluteIndex + bodyClose.length);
  }

  code = code.replaceAll('plan={plan}', 'plan={displayPlan}');

  code = code.replace(
    /className="fixed inset-0 z-\[(?:90|95)\] flex items-end justify-center/g,
    (value) => value.replace('items-end', 'items-center'),
  );

  return code;
}

const globalPopupScript = `
const CENTERED_POPUP_SELECTOR =
  '.fixed.inset-0[class*="bg-black"], .fixed.inset-0[class*="backdrop"]';

function ensurePopupCloseButton(overlay) {
  if (!(overlay instanceof HTMLElement)) return;
  if (overlay.dataset.popupCloseChecked === 'true') return;
  overlay.style.alignItems = 'center';

  const panel = Array.from(overlay.children).find(
    (child) => child instanceof HTMLElement && child !== overlay,
  );
  if (!(panel instanceof HTMLElement)) return;
  overlay.dataset.popupCloseChecked = 'true';
  if (panel.querySelector('[aria-label*="닫기"], [data-popup-close-button]')) return;

  if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.popupCloseButton = 'true';
  button.setAttribute('aria-label', '닫기');
  button.textContent = '×';
  Object.assign(button.style, {
    position: 'absolute',
    top: '10px',
    right: '10px',
    zIndex: '5',
    width: '36px',
    height: '36px',
    borderRadius: '9999px',
    border: '1px solid rgba(148,163,184,.35)',
    background: 'rgba(15,23,42,.92)',
    color: '#f8fafc',
    fontSize: '24px',
    lineHeight: '30px',
    fontWeight: '800',
    cursor: 'pointer',
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    overlay.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
    );
  });
  panel.appendChild(button);
}

function scanCenteredPopups() {
  document.querySelectorAll(CENTERED_POPUP_SELECTOR).forEach(ensurePopupCloseButton);
}

new MutationObserver(scanCenteredPopups).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
scanCenteredPopups();
`;

export function chartRelayFeaturePatch(): Plugin {
  return {
    name: 'chart-relay-feature-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (normalized.endsWith('/src/lib/lightweight-charts-relay-patch.ts')) {
        return { code: patchRelayChartLibrary(source), map: null };
      }
      if (!normalized.endsWith('/src/pages/chart-relay.tsx')) return null;
      return {
        code: patchChartRelay(source),
        map: null,
      };
    },
    transformIndexHtml() {
      return [
        {
          tag: 'style',
          attrs: { id: 'global-centered-popup-style' },
          children: `
.fixed.inset-0.flex.items-end.justify-center,
.fixed.inset-0.flex.items-start.justify-center {
  align-items: center !important;
}
.fixed.inset-0[class*="bg-black"] > [class*="max-h"],
.fixed.inset-0[class*="backdrop"] > [class*="max-h"] {
  max-height: min(88vh, 760px) !important;
}
`,
          injectTo: 'head',
        },
        {
          tag: 'script',
          attrs: { type: 'module', id: 'global-popup-close-guard' },
          children: globalPopupScript,
          injectTo: 'body',
        },
      ];
    },
  };
}

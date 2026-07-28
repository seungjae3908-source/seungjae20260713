import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[membership-ui-routing-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchApp(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `function GatedAutoTradePage() {\n\treturn (\n\t\t<FeatureGate feature="aiRealtimeChart">\n\t\t\t<AutoTradePage />\n\t\t</FeatureGate>\n\t);\n}`,
    `function GatedAutoTradePage() {\n\treturn (\n\t\t<FeatureGate feature="autoTrading">\n\t\t\t<ScannerPage />\n\t\t</FeatureGate>\n\t);\n}`,
    'admin auto trade route',
  );

  code = replaceOnce(
    code,
    `\t\t\t\t<Route path="/coins/futures">\n\t\t\t\t\t{() => <MarketRouteRedirect to="/stocks?asset=coin&coinMarket=futures" />}\n\t\t\t\t</Route>`,
    `\t\t\t\t<Route path="/coins/futures">\n\t\t\t\t\t{() => (\n\t\t\t\t\t\t<FeatureGate feature="futures">\n\t\t\t\t\t\t\t<MarketRouteRedirect to="/stocks?asset=coin&coinMarket=futures" />\n\t\t\t\t\t\t</FeatureGate>\n\t\t\t\t\t)}\n\t\t\t\t</Route>`,
    'futures route gate',
  );

  code = code.replaceAll(
    `<FeatureGate feature="advancedAnalysis">\n\t\t\t<Portfolio`,
    `<FeatureGate feature="portfolio">\n\t\t\t<Portfolio`,
  );

  code = code.replace(
    `\t// 관심종목 서버 동기화·자동 백업은 정회원 이상 전용 API를 사용하므로\n\t// 준회원에게는 실행하지 않는다 (불필요한 403 방지).\n\tuseEffect(() => {\n\t\tif (auth.isFullMember) ensureWatchlistSync();\n\t}, [auth.isFullMember]);`,
    `\t// 승인된 준회원 이상은 관심종목 동기화와 설정 백업을 사용합니다.\n\tuseEffect(() => {\n\t\tif (auth.isApproved) ensureWatchlistSync();\n\t}, [auth.isApproved]);`,
  );
  code = code.replace(
    `{auth.isFullMember && <AutoBackupSync />}`,
    `{auth.isApproved && <AutoBackupSync />}`,
  );

  return code;
}

function patchBottomNav(source: string): string {
  // 현재 bottom-nav.tsx에는 운영 라우팅이 이미 소스로 반영되어 있다.
  // 과거 문자열 치환 패치를 다시 적용하면 소스 형태 차이로 빌드가 중단되므로 그대로 사용한다.
  return source;
}

function patchSignalScan(source: string): string {
  if (source.includes('data-signal-market-grid="direct"')) return source;
  let code = source;

  code = replaceOnce(
    code,
    `  const market = routeMarket ?? stateMarket;\n  const isFutures = market === 'futures';`,
    `  const market = routeMarket ?? stateMarket;\n  const marketTitle =\n    market === 'kr'\n      ? '국내주식'\n      : market === 'us'\n        ? '해외주식'\n        : market === 'spot'\n          ? '코인 현물'\n          : '코인 선물';\n  const isFutures = market === 'futures';`,
    'signal scan market title',
  );

  code = replaceOnce(
    code,
    `<h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">신호검색</h1>`,
    `<h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">{marketTitle} 신호검색</h1>`,
    'signal scan dynamic heading',
  );

  code = replaceOnce(
    code,
    `<div className="relative mt-3 grid grid-cols-2 gap-2">\n          {MARKET_GROUPS.map((group) => {`,
    `<div className={cn('relative mt-3 grid grid-cols-2 gap-2', routeMarket && 'hidden')}>\n          {MARKET_GROUPS.map((group) => {`,
    'hide signal market tabs on focused route',
  );

  return code;
}

function patchScanner(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `  // 최초 진입 시에는 항상 가장 왼쪽 탭(조건검색)이 선택된다.\n  // 자동매매 설정·후보 화면은 사용자가 '자동매매' 버튼을 직접 눌렀을 때만 표시한다.\n  const [viewMode, setViewMode] = useState<ScannerViewMode>("condition");`,
    `  const dedicatedAutoRoute =\n    location.startsWith('/tech/auto-trade') || location.startsWith('/auto-trading');\n  const [viewMode, setViewMode] = useState<ScannerViewMode>(\n    dedicatedAutoRoute ? 'auto' : 'condition',\n  );`,
    'dedicated auto route initial tab',
  );

  code = replaceOnce(
    code,
    `  // 라우트가 바뀌어 새로 진입하면 다시 왼쪽 탭(조건검색)부터 시작한다.\n  useEffect(() => {\n    setViewMode("condition");\n  }, [location]);`,
    `  useEffect(() => {\n    setViewMode(dedicatedAutoRoute ? 'auto' : 'condition');\n  }, [dedicatedAutoRoute, location]);`,
    'dedicated auto route sync',
  );

  code = code.replace(
    `<h1 className="text-xl font-extrabold">도구</h1>`,
    `<h1 className="text-xl font-extrabold">{dedicatedAutoRoute ? '자동매매' : '도구'}</h1>`,
  );
  code = code.replace(
    `<div className="mb-2 grid grid-cols-3 gap-2">`,
    `<div className={cn('mb-2 grid grid-cols-3 gap-2', dedicatedAutoRoute && 'hidden')}>`,
  );
  code = code.replace(
    `<div className="mb-2 grid grid-cols-2 gap-2">`,
    `<div className={cn('mb-2 grid grid-cols-2 gap-2', dedicatedAutoRoute && 'hidden')}>`,
  );
  code = code.replace(
    `<div className="grid grid-cols-2 gap-2">\n          {MARKET_OPTIONS.map((item) => (`,
    `<div className={cn('grid grid-cols-2 gap-2', dedicatedAutoRoute && 'hidden')}>\n          {MARKET_OPTIONS.map((item) => (`,
  );

  return code;
}

function patchChartRelay(source: string): string {
  return replaceOnce(
    source,
    `                ) : (\n                  <RelayChart\n                    candles={candles}\n                    timeVisible={timeVisible}\n                    settings={settings}\n                    signals={signals}\n                    activeSignalId={activeSignalId}\n                    plan={plan}\n                    position={chartPosition}\n                    asset={asset}\n                    interval={interval}\n                    tab={tab}\n                    sourceKey={sourceKey}\n                    canLoadOlder={Boolean(historyCursor)}\n                    isLoadingOlder={isLoadingOlder}\n                    onLoadOlder={requestLoadOlder}\n                    onSignalSelect={selectSignal}\n                    onOpenSettings={() => openSettingsPanel('menu')}\n                  />\n                )}`,
    `                ) : (\n                  <>\n                    <div className="border-b border-card-border bg-background/70 px-3 py-2 text-center">\n                      <p className="truncate text-sm font-black">{symbol}</p>\n                      {latestBarChangePercent != null && (\n                        <p className={cn(\n                          'mt-0.5 text-[10px] font-black',\n                          latestBarChangePercent >= 0 ? 'text-red-500' : 'text-blue-500',\n                        )}>\n                          {latestBarChangePercent >= 0 ? '+' : ''}{latestBarChangePercent.toFixed(2)}%\n                        </p>\n                      )}\n                    </div>\n                    <RelayChart\n                      candles={candles}\n                      timeVisible={timeVisible}\n                      settings={settings}\n                      signals={signals}\n                      activeSignalId={activeSignalId}\n                      plan={plan}\n                      position={chartPosition}\n                      asset={asset}\n                      interval={interval}\n                      tab={tab}\n                      sourceKey={sourceKey}\n                      canLoadOlder={Boolean(historyCursor)}\n                      isLoadingOlder={isLoadingOlder}\n                      onLoadOlder={requestLoadOlder}\n                      onSignalSelect={selectSignal}\n                      onOpenSettings={() => openSettingsPanel('menu')}\n                    />\n                  </>\n                )}`,
    'chart symbol above controls',
  );
}

function patchMore(source: string): string {
  return replaceOnce(
    source,
    `{auth.isAdmin ? <AiRepairCenter /> : null}`,
    `{auth.isAdmin ? (\n          <>\n            <AiRepairCenter />\n            <button\n              type="button"\n              onClick={() => navigate('/admin')}\n              className="w-full rounded-3xl border border-primary/40 bg-primary/10 px-5 py-4 text-center text-base font-black text-primary"\n            >\n              회원관리\n            </button>\n          </>\n        ) : null}`,
    'admin member management entry',
  );
}

export function membershipUiRoutingPatch(): Plugin {
  return {
    name: 'membership-ui-routing-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/App.tsx')) {
        return { code: patchApp(source), map: null };
      }
      if (normalized.endsWith('/src/components/bottom-nav.tsx')) {
        return { code: patchBottomNav(source), map: null };
      }
      if (normalized.endsWith('/src/pages/signal-scan.tsx')) {
        return { code: patchSignalScan(source), map: null };
      }
      if (normalized.endsWith('/src/pages/scanner.tsx')) {
        return { code: patchScanner(source), map: null };
      }
      if (normalized.endsWith('/src/pages/chart-relay.tsx')) {
        return { code: patchChartRelay(source), map: null };
      }
      if (normalized.endsWith('/src/pages/more.tsx')) {
        return { code: patchMore(source), map: null };
      }

      return null;
    },
  };
}

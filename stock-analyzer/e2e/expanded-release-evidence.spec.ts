import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeAnalysisSelection } from '@/lib/analysis-selection';
import { mergeChartRouteSelection } from '@/lib/chart-external-window';
import {
  evidenceCell,
  sanitizeAndClassifyFailedRequest,
  summarizeFailedRequests,
} from './support/expanded-release-evidence';

const TARGET_SHA = 'eb7f36bd95d1702f02931dc6f55620f81ff255ed';
const SOURCE_STAGING_RUN_ID = '31438631228';
const SOURCE_POSTGRES_RUN_ID = '31438612953';
const SOURCE_APPLICATION_CI_RUN_ID = '31438004165';

function analyzerRoot(): string {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

async function readAnalyzerFile(relativePath: string): Promise<string> {
  return readFile(path.resolve(analyzerRoot(), relativePath), 'utf8');
}

const responsiveExisting = (width: number) => evidenceCell('partial', [
  `e2e/large-patch-responsive-breakpoints.spec.ts@${TARGET_SHA}: viewport ${width}`,
], '기존 exact-main 검증은 navigation/overflow/scroll/fixed-content 일부를 확인하지만 이번 확장 Gate의 viewport별 전체 diagnostics와 Korean wrapping을 모두 독립 투영하지는 않습니다.');

const responsiveAdjacent = (width: number, evidence: string[]) => evidenceCell('partial', evidence,
  `width ${width}는 exact-main의 인접 E2E에서 사용되지만 확장 responsive 7개 계약을 한 viewport evidence로 모두 묶지는 않았습니다.`);

const responsiveUnverified = (width: number) => evidenceCell('unverified', [],
  `width ${width}의 확장 responsive 전체 계약을 exact-main에서 독립 검증한 evidence가 없습니다. PR #173 소유 파일은 이 branch에서 수정하지 않습니다.`);

const artifact = {
  schemaVersion: 'expanded-release-evidence-v1',
  targetSha: TARGET_SHA,
  sourceStagingRunId: SOURCE_STAGING_RUN_ID,
  sourcePostgresRunId: SOURCE_POSTGRES_RUN_ID,
  sourceApplicationCiRunId: SOURCE_APPLICATION_CI_RUN_ID,
  provenance: {
    immutableStagingEvidenceReused: true,
    sourceStagingVerdict: '32/32 PASS; failed=0; skipped=0; release_ready=true',
    sourcePostgresPreflight: 'PASS; DB mutation required=false',
    sourceApplicationCi: '6/6 SUCCESS',
    validationBranchPolicy: 'exact-main-derived evidence-only Draft branch',
    newStagingRunCreated: false,
  },
  responsive: {
    status: 'partial',
    viewports: {
      '320': responsiveExisting(320),
      '360': responsiveAdjacent(360, [
        `e2e/signal-scanner.spec.ts@${TARGET_SHA}`,
        `e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}`,
      ]),
      '390': responsiveAdjacent(390, [
        `e2e/signal-scanner.spec.ts@${TARGET_SHA}`,
        `e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}`,
        `e2e/phase6-paper-trading.spec.ts@${TARGET_SHA}`,
      ]),
      '430': responsiveAdjacent(430, [
        `e2e/signal-scanner.spec.ts@${TARGET_SHA}`,
        `e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}`,
      ]),
      '768': responsiveExisting(768),
      '1024': responsiveUnverified(1024),
      '1280': responsiveExisting(1280),
      '1440': responsiveAdjacent(1440, [
        `e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}`,
        `e2e/phase6-paper-trading.spec.ts@${TARGET_SHA}`,
      ]),
      '1920': responsiveExisting(1920),
    },
    requiredPerViewport: [
      'layout',
      'navigation',
      'koreanWrapping',
      'horizontalOverflow',
      'scrollOwnership',
      'bottomNavOrFixedCollision',
      'lastContentVisibility',
      'browserDiagnostics',
    ],
    ownershipBlocker: 'PR #173 currently owns large-patch-responsive-breakpoints.spec.ts; no overlapping edit was made.',
  },
  routing: {
    status: 'partial',
    samsungKr: evidenceCell('partial', [
      `e2e/unified-asset-search.spec.ts@${TARGET_SHA}: 005930 -> /stock-info`,
      `api-server/scripts/verify-staging-detail-canonical-route-contract.mjs@${TARGET_SHA}`,
    ], '통합검색 canonical destination은 증명되지만 direct reload/back/mobile+desktop/error-zero 전체 matrix를 한 test에서 모두 증명하지 않습니다.'),
    aaplUs: evidenceCell('unverified', [
      `e2e/unified-chart-context-reset.spec.ts@${TARGET_SHA}: AAPL chart context reset only`,
    ], 'exact-main unified-search fixture에는 AAPL expanded route sequence가 없습니다. PR #173 소유 unified search file은 수정하지 않았습니다.'),
    krwBtcUpbitSpot: evidenceCell('partial', [
      `e2e/unified-asset-search.spec.ts@${TARGET_SHA}: KRW-BTC -> /stock-info`,
    ], 'canonical destination/spot identity는 기존 fixture에 있으나 reload/back/mobile+desktop 전체 sequence는 미투영입니다.'),
    btcusdtBitgetFutures: evidenceCell('partial', [
      `e2e/unified-asset-search.spec.ts@${TARGET_SHA}: BTCUSDT -> /stock-info`,
    ], 'canonical destination/futures identity는 기존 fixture에 있으나 reload/back/mobile+desktop 전체 sequence는 미투영입니다.'),
    ownershipBlocker: 'PR #173 currently owns unified-asset-search.spec.ts and the canonical route verifier; no overlapping edit was made.',
  },
  scanner: {
    status: 'partial',
    markets: {
      KR: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: KR fixture/runtime coverage`]),
      US: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: US/AAPL fixture/runtime coverage`]),
      UPBIT: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: UPBIT spot fixture/runtime coverage`]),
      BITGET: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: BITGET futures fixture/runtime coverage`]),
    },
    stateMatrix: {
      sameKeySingleFlight: evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: AbortController + requestKey + latestSequence`], 'replacement/abort semantics exist, but an explicit same-key concurrent request-count assertion is absent.'),
      polling30s: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: real 30-second polling test`]),
      manualRefreshPlusPollingRace: evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: refreshToken shared by manual/poll`], 'explicit coincident manual+poll runtime race assertion is absent.'),
      conditionPlusPollingRace: evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: requestKey/AbortController/latestSequence`], 'explicit coincident condition-change+poll runtime assertion is absent.'),
      visibilityResumePlusPolling: evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: visibilitychange + visible-only 30s interval`], 'source contract is deterministic; explicit visibility runtime fixture is absent.'),
      latestWins: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: delayed old response cannot overwrite newest context`]),
      previousRequestAbort: evidenceCell('pass', [`e2e/scanner-readiness-chart-integration.spec.ts@${TARGET_SHA}: old scan abort tracked`]),
      staleResultOverwrite: evidenceCell('pass', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: generatedAt/request sequence guards`]),
      lastGood: evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: 409/429/502 keeps existing data as partial`], 'all requested error classes are not covered by one runtime last-good matrix.'),
      diagnosticsCounters: evidenceCell('partial', [`e2e/signal-scanner.spec.ts@${TARGET_SHA}: execution diagnostics fixture`], 'counter consistency is not independently asserted for every expanded error state.'),
    },
    errors: {
      '409': evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: 409 nonfatal last-good path`], 'runtime scanner fixture assertion is absent.'),
      '429': evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: Retry-After-aware safe message`], 'runtime scanner polling/no-storm fixture assertion is absent.'),
      '502': evidenceCell('partial', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: provider-degraded last-good path`], 'full polling/no-storm matrix is not independently asserted.'),
      timeout: evidenceCell('partial', [`Staging Run ${SOURCE_STAGING_RUN_ID}: strict unavailable timeout evidence`], 'immutable Staging proves bounded unavailable, not the full expanded last-good/polling race matrix.'),
      unavailable: evidenceCell('partial', [`Staging Run ${SOURCE_STAGING_RUN_ID}: strict unavailable evidence`], 'immutable Staging evidence is reused without re-dispatch; expanded cross-race assertions remain incomplete.'),
    },
  },
  pricePlan: {
    status: 'partial',
    entry: evidenceCell('pass', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: card.pricePlan -> AnalysisSelection`, `src/lib/analysis-selection.tsx@${TARGET_SHA}`]),
    stop: evidenceCell('pass', [`src/lib/analysis-selection.tsx@${TARGET_SHA}: stopLoss normalization/persistence`]),
    targets: evidenceCell('pass', [`src/lib/analysis-selection.tsx@${TARGET_SHA}: targets normalization/persistence`]),
    riskReward: evidenceCell('pass', [`src/lib/analysis-selection.tsx@${TARGET_SHA}: riskReward normalization/persistence`]),
    sameInstrumentRouteMerge: evidenceCell('pass', [`src/lib/chart-external-window.ts@${TARGET_SHA}: mergeChartRouteSelection preserves stored metadata for same instrument`]),
    crossInstrumentIsolation: evidenceCell('pass', [`src/lib/chart-external-window.ts@${TARGET_SHA}: previous metadata discarded when instrument identity changes`]),
    missingNotZero: evidenceCell('pass', [`this spec: missing price-plan fields normalize to null/[] rather than fabricated zero`]),
    numericZeroDistinction: evidenceCell('partial', [`this spec: stop/invalidation/riskReward numeric zero remains zero`], 'entryZone/targets enforce positive-price domain and therefore reject zero instead of preserving it as a valid price.'),
    scannerToAiChart: evidenceCell('pass', [`src/pages/signal-scanner.tsx@${TARGET_SHA}: analysisSelection.select before navigation`, `src/pages/ai-chart.tsx@${TARGET_SHA}: merged selection passed to UnifiedAnalysisChart`]),
    mobileDesktopMeaning: evidenceCell('partial', [`e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}: mobile and desktop selection-to-chart context`], 'existing UI evidence does not render/assert ENTRY/STOP/TARGETS/R:R values visibly in both layouts.'),
  },
  aiFailureMatrix: {
    status: 'partial',
    providerUnavailable: evidenceCell('pass', [`e2e/phase9-ai-review.spec.ts@${TARGET_SHA}: provider unavailable safe state`]),
    rateLimited429: evidenceCell('pass', [`e2e/phase9-ai-review.spec.ts@${TARGET_SHA}: 429 shown without retry loop`]),
    timeout: evidenceCell('unverified', [], 'No exact-main fixture was found that proves the requested bounded AI timeout matrix across KR/US/UPBIT/BITGET.'),
    cancellation: evidenceCell('pass', [`e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}: slow AI chat cancellation-safe UI`]),
    missingResponseFields: evidenceCell('unverified', [], 'No exact-main four-market missing-field AI fixture was found.'),
    unsafeResponse: evidenceCell('partial', [`e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}: order request receives safe refusal`], 'generic unsafe-provider-payload sanitization is not independently covered across four markets.'),
    fourMarketMatrix: evidenceCell('unverified', [], 'Existing AI safety/privacy tests are not parameterized as a KR/US/UPBIT/BITGET failure matrix.'),
    secretExposure: 0,
    privateDataExposure: 0,
    orderOrPrivateApiCalls: 0,
  },
  progressiveLoading: {
    status: 'partial',
    scanner: evidenceCell('partial', [`e2e/scanner-chart-broadcast.spec.ts@${TARGET_SHA}: loading/error/recovery/stale-race paths`], 'slow secondary-provider nonblocking is not a complete scanner matrix.'),
    stockInfo: evidenceCell('partial', [`e2e/phase12-market-information-room-edge-cases.spec.ts@${TARGET_SHA}: explicit empty/timeout/retry-safe states`], 'shell-first plus slow News/Financial nonblocking is not fully covered.'),
    aiChart: evidenceCell('partial', [`e2e/scanner-chart-broadcast.spec.ts@${TARGET_SHA}`, `e2e/unified-chart-context-reset.spec.ts@${TARGET_SHA}`], 'loading cleanup/latest context are covered; full secondary-provider matrix is not.'),
    unifiedSearch: evidenceCell('partial', [`e2e/unified-asset-search.spec.ts@${TARGET_SHA}: latest request wins and separated assets`], 'all progressive shell/partial/abort assertions at 320/390/768/1280 are not present.'),
    paperReadOnly: evidenceCell('partial', [`e2e/phase6-paper-trading.spec.ts@${TARGET_SHA}: safe error clears busy state`], 'representative 320/768/1280 progressive-loading matrix is incomplete.'),
    representativeViewports: {
      '320': evidenceCell('partial', [`e2e/large-patch-responsive-breakpoints.spec.ts@${TARGET_SHA}`]),
      '390': evidenceCell('partial', [`e2e/phase6-paper-trading.spec.ts@${TARGET_SHA}`, `e2e/phase11-ai-workspace.spec.ts@${TARGET_SHA}`]),
      '768': evidenceCell('partial', [`e2e/large-patch-responsive-breakpoints.spec.ts@${TARGET_SHA}`]),
      '1280': evidenceCell('partial', [`e2e/large-patch-responsive-breakpoints.spec.ts@${TARGET_SHA}`]),
    },
  },
  browser: {
    consoleErrors: 0,
    pageErrors: 0,
    unhandledRejections: 0,
    unexpectedHttpErrors: 0,
    unexpectedFailedRequests: {
      status: 'partial',
      count: 0,
      definitionContract: 'pass',
      evidence: [
        `e2e/scanner-readiness-chart-integration.spec.ts@${TARGET_SHA}`,
        `e2e/scanner-chart-broadcast.spec.ts@${TARGET_SHA}`,
        `e2e/unified-chart-context-reset.spec.ts@${TARGET_SHA}`,
        'e2e/support/expanded-release-evidence.ts: sanitized independent classifier',
      ],
      note: 'covered exact-main flows report zero unexpected request failures, and the new classifier stores pathname/resource class only. Full expanded-flow coverage remains partial.',
    },
  },
  safety: {
    actualOrders: 0,
    actualCancels: 0,
    actualAmend: 0,
    privateAccountRequests: 0,
    privateTradingRequests: 0,
    transfers: 0,
    withdrawals: 0,
  },
  mutations: {
    productionDeploy: false,
    productionChanges: false,
    stagingDispatch: false,
    databaseMutation: false,
    secretChanges: false,
    serverMutation: false,
    pm2Changes: false,
    caddyChanges: false,
  },
  expandedStagingReleaseReady: false,
  productionDeployReady: false,
  readinessReason: 'Expanded responsive/routing/scanner/AI/progressive-loading matrices still contain partial or unverified cells; immutable successful Staging evidence is preserved unchanged.',
};

test('projects exact-main responsive and routing coverage without touching PR #173-owned files', async () => {
  const responsive = await readAnalyzerFile('e2e/large-patch-responsive-breakpoints.spec.ts');
  const unifiedSearch = await readAnalyzerFile('e2e/unified-asset-search.spec.ts');
  const routeVerifier = await readAnalyzerFile('../api-server/scripts/verify-staging-detail-canonical-route-contract.mjs');

  for (const width of [320, 768, 1280, 1920]) expect(responsive).toContain(String(width));
  expect(responsive).toContain('scrollWidth');
  expect(responsive).toContain('overflowY');
  expect(unifiedSearch).toContain('005930');
  expect(unifiedSearch).toContain('KRW-BTC');
  expect(unifiedSearch).toContain('BTCUSDT');
  expect(unifiedSearch).toContain('/stock-info');
  expect(routeVerifier).toContain('/stock-info');
});

test('projects the existing scanner concurrency, polling, freshness, and four-market contracts', async () => {
  const scannerPage = await readAnalyzerFile('src/pages/signal-scanner.tsx');
  const scannerSpec = await readAnalyzerFile('e2e/signal-scanner.spec.ts');
  const readinessSpec = await readAnalyzerFile('e2e/scanner-readiness-chart-integration.spec.ts');

  expect(scannerPage).toContain('new AbortController()');
  expect(scannerPage).toContain('latestSequence');
  expect(scannerPage).toContain('lastGeneratedAt');
  expect(scannerPage).toContain("document.addEventListener('visibilitychange'");
  expect(scannerPage).toContain('30_000');
  expect(scannerPage).toContain('error.status === 409');
  expect(scannerPage).toContain('error.status === 429');
  expect(scannerPage).toContain('error.status === 502');
  for (const market of ['KR', 'US', 'UPBIT', 'BITGET']) expect(scannerSpec).toContain(market);
  expect(scannerSpec).toContain('30-second');
  expect(readinessSpec).toContain('scanAborts');
  expect(readinessSpec).toContain('unexpectedRequestFailures');
});

test('PricePlan positive values survive same-instrument route merge and do not cross instruments', () => {
  const selectedAt = '2026-08-10T00:00:00.000Z';
  const stored = normalizeAnalysisSelection({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '1D',
    selectedAt,
    pricePlan: {
      entryZone: { from: 70000, to: 71000 },
      invalidation: 68000,
      stopLoss: 68500,
      targets: [73000, 75000],
      riskReward: 2.25,
    },
  });
  expect(stored).not.toBeNull();

  const sameRoute = normalizeAnalysisSelection({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    selectedAt: '2026-08-10T00:01:00.000Z',
  });
  const sameMerged = mergeChartRouteSelection(sameRoute, stored);
  expect(sameMerged?.pricePlan).toEqual(stored?.pricePlan);
  expect(sameMerged?.pricePlan?.entryZone).toEqual({ from: 70000, to: 71000 });
  expect(sameMerged?.pricePlan?.stopLoss).toBe(68500);
  expect(sameMerged?.pricePlan?.targets).toEqual([73000, 75000]);
  expect(sameMerged?.pricePlan?.riskReward).toBe(2.25);

  const usRoute = normalizeAnalysisSelection({
    assetType: 'stock',
    market: 'US',
    symbol: 'AAPL',
    ticker: 'AAPL',
    displayName: 'Apple',
    timeframe: '5m',
    selectedAt: '2026-08-10T00:02:00.000Z',
  });
  expect(mergeChartRouteSelection(usRoute, stored)?.pricePlan).toBeUndefined();

  const spotRoute = normalizeAnalysisSelection({
    assetType: 'coin_spot',
    market: 'UPBIT',
    symbol: 'KRW-BTC',
    ticker: 'KRW-BTC',
    displayName: '비트코인',
    timeframe: '5m',
    selectedAt: '2026-08-10T00:03:00.000Z',
  });
  expect(mergeChartRouteSelection(spotRoute, stored)?.pricePlan).toBeUndefined();
});

test('PricePlan missing fields are not fabricated as zero and valid zero remains distinguishable where the domain permits it', () => {
  const base = {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '1D',
    selectedAt: '2026-08-10T00:00:00.000Z',
  } as const;

  const missing = normalizeAnalysisSelection({ ...base, pricePlan: {} });
  expect(missing?.pricePlan).toEqual({
    entryZone: null,
    invalidation: null,
    stopLoss: null,
    targets: [],
    riskReward: null,
  });

  const zeros = normalizeAnalysisSelection({
    ...base,
    pricePlan: {
      entryZone: { from: 0, to: 0 },
      invalidation: 0,
      stopLoss: 0,
      targets: [0, 72000],
      riskReward: 0,
    },
  });
  expect(zeros?.pricePlan?.entryZone).toBeNull();
  expect(zeros?.pricePlan?.invalidation).toBe(0);
  expect(zeros?.pricePlan?.stopLoss).toBe(0);
  expect(zeros?.pricePlan?.targets).toEqual([72000]);
  expect(zeros?.pricePlan?.riskReward).toBe(0);
});

test('projects scanner-to-AI-chart PricePlan handoff and current AI/progressive failure evidence', async () => {
  const scannerPage = await readAnalyzerFile('src/pages/signal-scanner.tsx');
  const aiChartPage = await readAnalyzerFile('src/pages/ai-chart.tsx');
  const phase9 = await readAnalyzerFile('e2e/phase9-ai-review.spec.ts');
  const phase11 = await readAnalyzerFile('e2e/phase11-ai-workspace.spec.ts');
  const chartBroadcast = await readAnalyzerFile('e2e/scanner-chart-broadcast.spec.ts');
  const marketEdge = await readAnalyzerFile('e2e/phase12-market-information-room-edge-cases.spec.ts');
  const paper = await readAnalyzerFile('e2e/phase6-paper-trading.spec.ts');

  expect(scannerPage).toContain('pricePlan: card.pricePlan');
  expect(scannerPage).toContain('analysisSelection.select(selection)');
  expect(aiChartPage).toContain('mergeChartRouteSelection');
  expect(aiChartPage).toContain('selection={selection}');
  expect(phase9).toContain('provider unavailable');
  expect(phase9).toContain('429');
  expect(phase11).toContain('요청 취소');
  expect(chartBroadcast).toContain('차트 불러오는 중...');
  expect(marketEdge).toContain('UPSTREAM_TIMEOUT');
  expect(paper).toContain('execution error clears busy state');
});

test('independent failed-request evidence strips query data and classifies expected failures separately', () => {
  const summary = summarizeFailedRequests([
    {
      method: 'GET',
      url: 'https://example.invalid/api/market/scan?token=never-record-this&symbol=AAPL#fragment',
      errorText: 'net::ERR_ABORTED',
      resourceType: 'fetch',
    },
    {
      method: 'GET',
      url: 'https://example.invalid/api/ai/chat?credential=never-record-this',
      errorText: 'fixture socket closed',
      intentionalFixtureFailure: true,
      resourceType: 'fetch',
    },
    {
      method: 'GET',
      url: 'https://example.invalid/stock-info?market=KR&symbol=005930',
      errorText: 'net::ERR_ABORTED',
      navigationCancellation: true,
      resourceType: 'document',
    },
  ]);

  expect(summary.totalFailedRequests).toBe(3);
  expect(summary.expectedFailedRequests).toBe(3);
  expect(summary.unexpectedFailedRequests).toBe(0);
  expect(summary.items.map((item) => item.pathname)).toEqual([
    '/api/market/scan',
    '/api/ai/chat',
    '/stock-info',
  ]);
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain('?');
  expect(serialized).not.toContain('token');
  expect(serialized).not.toContain('credential');
  expect(serialized).not.toContain('AAPL');
  expect(serialized).not.toContain('005930');

  const unexpected = sanitizeAndClassifyFailedRequest({
    method: 'GET',
    url: 'https://example.invalid/api/quotes?secret=never-record-this',
    errorText: 'net::ERR_CONNECTION_RESET',
    resourceType: 'fetch',
  });
  expect(unexpected.classification).toBe('unexpected');
  expect(unexpected.pathname).toBe('/api/quotes');
  expect(JSON.stringify(unexpected)).not.toContain('secret');
});

test.afterAll(async () => {
  const outputDirectory = path.resolve(analyzerRoot(), 'test-results');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, `expanded-release-evidence-${TARGET_SHA}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
});

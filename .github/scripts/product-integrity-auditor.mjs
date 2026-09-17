import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTION_STATUS,
  DEFAULT_EDGES,
  buildAudit,
  collectTextFiles,
  evaluateProbe,
} from './connection-graph-auditor.mjs';

export const INTEGRITY_STATUS = Object.freeze({
  PROVEN: 'PROVEN',
  PARTIAL: 'PARTIAL',
  MISSING: 'MISSING',
  UNKNOWN: 'UNKNOWN',
  REVIEW: 'REVIEW',
});

export const EVIDENCE_LEVEL = Object.freeze({
  NOT_PROVEN: 'NOT_PROVEN',
  STATIC_PROVEN: 'STATIC_PROVEN',
  CONTRACT_PROVEN: 'CONTRACT_PROVEN',
  RUNTIME_PROVEN: 'RUNTIME_PROVEN',
  E2E_PROVEN: 'E2E_PROVEN',
  PRODUCTION_PROVEN: 'PRODUCTION_PROVEN',
});

export const PRODUCT_EDGES = [
  {
    id: 'PI001',
    from: 'Research Center Workspace',
    to: 'AI Research Copilot',
    severity: 'P2',
    lane: 'ai-research',
    required: [
      {
        id: 'research-workspace-copilot-mount',
        paths: ['stock-analyzer/src/pages/research-center-workspace.tsx'],
        allOf: ['ResearchCopilotPanel', "value: 'copilot'", 'AI Research Copilot'],
      },
      {
        id: 'research-copilot-component',
        paths: ['stock-analyzer/src/components/research-copilot-panel.tsx'],
        anyOf: ['research', 'Research', 'copilot', 'Copilot'],
      },
    ],
  },
  {
    id: 'PI002',
    from: 'Research Center',
    to: 'Canonical Research Pipeline',
    severity: 'P1',
    lane: 'research-pipeline',
    required: [
      {
        id: 'research-overview-consumer',
        paths: ['stock-analyzer/src/pages/research-center.tsx'],
        allOf: ['fetchResearchCenterOverview', 'buildResearchPipeline'],
      },
      {
        id: 'research-pipeline-stages',
        paths: ['stock-analyzer/src/lib/research-center-product.ts'],
        allOf: ['backtest', 'oos', 'purged-walk-forward', 'final-holdout', 'shadow', 'paper', 'settlement', 'profitability', 'strategy-health', 'promotion', 'champion'],
      },
    ],
  },
  {
    id: 'PI003',
    from: 'Research Pipeline',
    to: 'Backtest / Shadow / Paper / Settlement Evidence',
    severity: 'P1',
    lane: 'research-pipeline',
    required: [
      {
        id: 'research-stage-truth-model',
        paths: ['stock-analyzer/src/lib/research-center-product.ts'],
        allOf: ['EvidenceAvailability', 'MISSING', 'ZERO_MEASURED', 'WRONG_SHA'],
      },
      {
        id: 'research-canonical-overview-service',
        paths: ['stock-analyzer/src/lib/research-center.ts'],
        anyOf: ['fetchResearchCenterOverview', 'ResearchCenterOverview'],
      },
      {
        id: 'strategy-promotion-source',
        paths: ['stock-analyzer/src/lib/strategy-promotion.ts'],
        anyOf: ['StrategyPromotionResponse', 'strategyId'],
      },
    ],
  },
  {
    id: 'PI004',
    from: 'Authenticated Session',
    to: 'Protected Product Routes',
    severity: 'P1',
    lane: 'auth-product',
    required: [
      {
        id: 'auth-provider',
        paths: ['stock-analyzer/src/App.tsx'],
        allOf: ['AuthProvider', 'CapabilityGate'],
      },
      {
        id: 'member-capability-contract',
        paths: ['packages/member-access/src/index.js', 'packages/member-access/src/index.d.ts'],
        anyOf: ['MemberCapability', 'canAccessPaperTrading', 'canAccessBacktests'],
      },
    ],
  },
  {
    id: 'PI005',
    from: 'Portfolio Holdings',
    to: 'Chart Overlay',
    severity: 'P2',
    lane: 'portfolio-analysis',
    required: [
      {
        id: 'portfolio-overlay-producer',
        paths: ['stock-analyzer/src/pages/portfolio.tsx'],
        allOf: ['syncPortfolioChartOverlays', 'average_price'],
      },
      {
        id: 'portfolio-overlay-contract',
        paths: ['stock-analyzer/src/lib/portfolio-overlay.ts'],
        anyOf: ['overlay', 'average', 'purchase'],
      },
      {
        id: 'ai-chart-overlay-consumer',
        paths: ['stock-analyzer/src/pages/ai-chart.tsx'],
        anyOf: ['portfolio', 'averagePrice', 'average_price', 'overlay'],
      },
    ],
  },
  {
    id: 'PI006',
    from: 'In-app Alerts',
    to: 'Telegram Delivery',
    severity: 'P2',
    lane: 'notifications',
    required: [
      {
        id: 'in-app-alert-center',
        paths: ['stock-analyzer/src/pages/alerts.tsx'],
        anyOf: ['alert', 'notification', '알림'],
      },
      {
        id: 'telegram-member-outbox-consumer',
        paths: ['api-server/src/services/personal-telegram-alert.service.ts'],
        allOf: ['getTelegramConnection', 'enqueueDelivery', 'evaluateTelegramAlertPolicy'],
      },
    ],
  },
];

// These edges prove concrete read paths only, never activation or observed stage success.
PRODUCT_EDGES.push(
  { id: 'PI007', from: 'Research Center Workspace', to: 'Video Intelligence runtime reader', severity: 'P2', lane: 'ai-research', required: [
    { id: 'video-workspace-mount', paths: ['stock-analyzer/src/pages/research-center-workspace.tsx'], allOf: ['<ResearchVideoPanel'] },
    { id: 'video-runtime-ui-reader', paths: ['stock-analyzer/src/components/research-video-panel.tsx'], allOf: ['authorizedFetch', '/api/admin/research/video'] },
  ] },
  { id: 'PI008', from: 'Research DSL', to: 'Canonical Strategy Candidate / Bundle', severity: 'P1', lane: 'research-pipeline', required: [
    { id: 'research-canonical-resolver', paths: ['api-server/src/services/research-bundle.service.ts'], allOf: ['resolveCanonicalStrategyIdentity(strategy)', 'result.strategyIdentityDigest', 'result.bundleDigest = hash(source)'] },
    { id: 'research-bundle-persistence-reader', paths: ['api-server/src/services/research-bundle-file-store.service.ts'], allOf: ['readCanonicalBundle(dslDigest)', 'completion.json', 'publishOnce'] },
    { id: 'research-bundle-ui-consumer', paths: ['stock-analyzer/src/components/research-copilot-panel.tsx'], allOf: ['validation.bundle.strategyIdentityDigest', 'validation.bundle.bundleDigest'] },
  ] },
  { id: 'PI009', from: 'Canonical Research Candidate', to: 'Backtest durable result', severity: 'P1', lane: 'research-pipeline', required: [
    { id: 'research-backtest-server-actions', paths: ['api-server/src/routes/research-copilot.ts'], allOf: ["router.post('/submit-backtest'", "router.post('/read-backtest'", 'bundles.readback'] },
    { id: 'research-backtest-publication-contract', paths: ['api-server/src/services/research-bundle.service.ts'], allOf: ['DURABLE_RESULT_READBACK_MISMATCH', 'saved.resultArtifactDigest !== hash(publication.artifact)'] },
    { id: 'research-backtest-client-consumer', paths: ['stock-analyzer/src/lib/research-copilot.ts'], allOf: ['submitResearchBacktest', 'readResearchBacktest', 'matchesBundle(value, bundle)'] },
  ] },
  { id: 'PI010', from: 'Published Research Candidate', to: 'Forward / Shadow / Natural Paper / Settlement same-candidate readback', severity: 'P1', lane: 'research-stage-readback', required: [
    { id: 'same-candidate-server-owned-reader', paths: ['api-server/src/routes/research-copilot.ts'], allOf: ["router.post('/prewire-same-candidate'", 'sameCandidateRuntimeReader(publication)', 'validateResearchSameCandidatePrewire(publication, runtimeStages)'] },
    { id: 'same-candidate-stored-stage-reader', paths: ['api-server/src/services/research-same-candidate-prewire.service.ts'], allOf: ['readShadowProof(stateRoot, resolved.anchor)', 'readPaperNaturalResult(stateRoot)', "paperProof('FORWARD'", "paperProof('PAPER'", "paperProof('SETTLEMENT'", 'validateRuntimeProof'] },
    { id: 'same-candidate-client-request', paths: ['stock-analyzer/src/lib/research-copilot.ts'], allOf: ["request('/prewire-same-candidate'", 'validResearchSameCandidate(value, bundle)', 'researchReadback'] },
    { id: 'same-candidate-identity-bound-ui', paths: ['stock-analyzer/src/components/research-copilot-panel.tsx'], allOf: ['readResearchSameCandidate(JSON.parse(dsl), bundle, signal)', '<ResearchSameCandidatePreview'] },
  ] },
  { id: 'PI011', from: 'Portfolio canonical journal', to: 'AI Advisor analysis', severity: 'P1', lane: 'portfolio-analysis', required: [
    { id: 'portfolio-ai-ui-mount', paths: ['stock-analyzer/src/pages/portfolio-v2.tsx'], allOf: ['<PortfolioAiDiagnosis'] },
    { id: 'portfolio-ai-request', paths: ['stock-analyzer/src/components/portfolio-ai-diagnosis.tsx'], allOf: ['/api/paper-journal/portfolio-advisor/query', 'authorizedFetch'] },
    { id: 'portfolio-advisor-route-registration', paths: ['api-server/src/routes/paper-journal.ts'], allOf: ['registerCanonicalPortfolioAdvisorRoute(router'] },
    { id: 'portfolio-advisor-canonical-consumer', paths: ['api-server/src/routes/paper-journal-portfolio-advisor.ts'], allOf: ["router.post('/paper-journal/portfolio-advisor/query'", 'clientPortfolioStateKey', 'queryInvestmentCopilot(snapshot, body.message)'] },
  ] },
  { id: 'PI012', from: 'Scanner Event', to: 'Telegram routing / member holdings alerts', severity: 'P2', lane: 'notifications', required: [
    { id: 'scanner-route-delivery-call', paths: ['api-server/src/routes/crypto-signal-scan.ts', 'api-server/src/routes/bounded-market-scan.ts'], allOf: ['void deliverScannerTelegramAlerts('] },
    { id: 'scanner-freshness-and-routing', paths: ['api-server/src/services/scanner-telegram-delivery.service.ts'], allOf: ['evaluateTelegramSignalFreshness', 'fanoutMemberHoldingScannerAlert', 'markTelegramSignalAnnounced', 'sendTelegramAlert'] },
    { id: 'telegram-worker-startup', paths: ['api-server/src/index.ts'], allOf: ['startUserTelegramDeliveryWorker();', 'startSignalIntelligenceTelegramSubscriber();'] },
  ] },
  { id: 'PI013', from: 'Telegram member routing / preferences', to: 'Persistent outbox delivery', severity: 'P2', lane: 'notifications', required: [
    { id: 'member-policy-outbox', paths: ['api-server/src/services/personal-telegram-alert.service.ts'], allOf: ['input.event.userId !== userId', 'getTelegramConnection(userId)', 'getPolicy', 'enqueueDelivery'] },
    { id: 'outbox-worker-consumer', paths: ['api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts'], allOf: ['listDue', 'processDelivery(item.userId, item.id, now)', 'sendTelegramAlert'] },
  ] },
  { id: 'PI014', from: 'Member Watchlist / Holdings', to: 'Personal Telegram alerts', severity: 'P2', lane: 'notifications', required: [
    { id: 'watchlist-alert-producer', paths: ['api-server/src/services/member-watchlist-telegram-producer.service.ts'], allOf: ['deliverPersonalTelegramAlert', 'userId'] },
    { id: 'holdings-member-eligibility', paths: ['api-server/src/services/member-holdings-telegram-producer.service.ts'], allOf: ['deliverPersonalTelegramAlert', "hasCapability(profile, 'canConnectPersonalTelegram')"] },
    { id: 'watchlist-subscriber-call', paths: ['api-server/src/services/signal-intelligence-telegram-subscriber.service.ts'], allOf: ['deliverMemberWatchlistTelegramForSignal'] },
  ] },
);

export const DEFAULT_CAPABILITIES = [
  ['CAP001', 'Stock Scanner', 'P1', ['stock-analyzer/src/pages/scanner.tsx']],
  ['CAP002', 'Signal Scanner', 'P1', ['stock-analyzer/src/pages/signal-scanner.tsx']],
  ['CAP003', 'AI Chart', 'P1', ['stock-analyzer/src/pages/ai-chart.tsx']],
  ['CAP004', 'AI Chat', 'P2', ['stock-analyzer/src/pages/ai-chat.tsx']],
  ['CAP005', 'Research Center Workspace', 'P1', ['stock-analyzer/src/pages/research-center-workspace.tsx']],
  ['CAP006', 'Research Center Canonical Evidence', 'P1', ['stock-analyzer/src/pages/research-center.tsx', 'stock-analyzer/src/lib/research-center-product.ts']],
  ['CAP007', 'AI Research Copilot', 'P2', ['stock-analyzer/src/components/research-copilot-panel.tsx']],
  ['CAP008', 'Research Video', 'P2', ['stock-analyzer/src/components/research-video-panel.tsx']],
  ['CAP009', 'Backtester', 'P1', ['stock-analyzer/src/pages/backtests.tsx', 'stock-analyzer/src/components/backtest-research-panel.tsx']],
  ['CAP010', 'Strategy Promotion', 'P1', ['stock-analyzer/src/pages/strategy-promotion.tsx', 'stock-analyzer/src/lib/strategy-promotion.ts']],
  ['CAP011', 'Paper Trading', 'P1', ['stock-analyzer/src/pages/paper-trading.tsx', 'stock-analyzer/src/components/paper-trading-panel.tsx']],
  ['CAP012', 'Auto Trading UI', 'P1', ['stock-analyzer/src/pages/auto-trading.tsx']],
  ['CAP013', 'Portfolio', 'P1', ['stock-analyzer/src/pages/portfolio-v2.tsx']],
  ['CAP014', 'Position / Holdings', 'P1', ['stock-analyzer/src/pages/portfolio.tsx']],
  ['CAP015', 'Broker Read-only Accounts', 'P1', ['stock-analyzer/src/components/brokerage-account-connections.tsx']],
  ['CAP016', 'Account', 'P1', ['stock-analyzer/src/pages/account.tsx']],
  ['CAP017', 'Alerts', 'P2', ['stock-analyzer/src/pages/alerts.tsx']],
  ['CAP018', 'Watchlist', 'P2', ['stock-analyzer/src/pages/watchlist.tsx']],
  ['CAP019', 'Recommendations', 'P2', ['stock-analyzer/src/pages/recommendations.tsx']],
  ['CAP020', 'Market Overview', 'P2', ['stock-analyzer/src/pages/market-overview.tsx']],
  ['CAP021', 'Market Information', 'P2', ['stock-analyzer/src/pages/market-information.tsx']],
  ['CAP022', 'Technical Workspace', 'P1', ['stock-analyzer/src/pages/technical-workspace.tsx']],
  ['CAP023', 'Admin', 'P1', ['stock-analyzer/src/pages/admin.tsx']],
  ['CAP024', 'Agent Hub', 'P2', ['stock-analyzer/src/pages/agent-hub-control.tsx']],
  ['CAP025', 'Member Access Contract', 'P1', ['packages/member-access/src/index.js', 'packages/member-access/src/index.d.ts']],
  ['CAP026', 'Forward / OOS Evidence', 'P1', ['.github/workflows/public-forward-liquidity-calibration-oos-validation.yml']],
  ['CAP027', 'Shadow Evidence', 'P1', ['stock-analyzer/src/lib/research-center-product.ts']],
  ['CAP028', 'Settlement Evidence', 'P1', ['.github/workflows/four-market-paper-settlement-validation.yml']],
  ['CAP029', 'Full Cost Evidence', 'P1', ['stock-analyzer/src/lib/research-center-product.ts']],
  ['CAP030', 'Full Staging Gate', 'RELEASE_GATE', ['.github/workflows/staging-readiness.yml']],
].map(([id, name, severity, paths]) => ({
  id,
  name,
  severity,
  presence: [{ id: `${id.toLowerCase()}-presence`, paths }],
}));

DEFAULT_CAPABILITIES.push({
  id: 'CAP031',
  name: 'Telegram Delivery',
  severity: 'P2',
  presence: [{ id: 'telegram-sender', paths: ['api-server/src/services/telegram-notification.service.ts'], allOf: ['sendTelegramAlert', 'sendMessage'] }],
});

export const IDENTITY_CONTRACTS = [
  {
    id: 'ID001',
    name: 'Scanner → AI analysis selection',
    severity: 'P1',
    sourcePaths: ['stock-analyzer/src/pages/scanner.tsx', 'stock-analyzer/src/pages/signal-scanner.tsx'],
    destinationPaths: ['stock-analyzer/src/pages/ai-chart.tsx', 'stock-analyzer/src/pages/ai-chat.tsx'],
    dimensions: ['market', 'ticker', 'timeframe', 'action'],
    required: [{ id: 'ai-chat-backend-timeframe', paths: ['api-server/src/services/ai-chat.service.ts'], allOf: ['row.timeframe'] }],
    transport: {
      paths: ['stock-analyzer/src/pages/scanner.tsx', 'stock-analyzer/src/lib/analysis-selection.tsx'],
      allOf: ['analysisSelection', 'timeframe'],
    },
  },
  {
    id: 'ID002',
    name: 'Backtest → Paper same-candidate identity',
    severity: 'P1',
    sourcePaths: ['api-server/src/services/backtest-paper-handoff.service.ts'],
    destinationPaths: ['stock-analyzer/src/components/backtest-paper-candidate-preview.tsx'],
    dimensions: ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage', 'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'],
    required: [{ id: 'same-strategy-paper-consumer', paths: ['api-server/src/services/paper-trading.types.ts'], allOf: ['candidateId', 'strategyId', 'parameterHash', 'exitPolicyRef'] }],
    transport: {
      paths: ['packages/strategy-hypothesis/src/backtest-paper-handoff.js'],
      allOf: ['URLSearchParams', 'backtestCandidate', 'INVALID_BACKTEST_PAPER_HANDOFF'],
    },
  },
  {
    id: 'ID003',
    name: 'Scanner → Paper approval identity',
    severity: 'P1',
    sourcePaths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
    destinationPaths: ['api-server/src/routes/trade-automation.ts'],
    dimensions: ['market', 'symbol', 'side', 'accountMode'],
    transport: {
      paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
      allOf: ['/api/trade-automation/scanner/plans', "accountMode: 'paper'"],
    },
  },
];

export const GOLDEN_JOURNEYS = [
  { id: 'GJ001', name: 'Scanner → AI Chart → AI Chat', edgeIds: ['CG001', 'CG002'] },
  { id: 'GJ002', name: 'KR Scanner → Paper → Settlement → Full Cost → OOS', edgeIds: ['CG003', 'CG008', 'CG009', 'CG010', 'CG011', 'CG012', 'CG013'] },
  { id: 'GJ003', name: 'US Scanner → Paper → Settlement → Full Cost → OOS', edgeIds: ['CG004', 'CG008', 'CG009', 'CG010', 'CG011', 'CG012', 'CG013'] },
  { id: 'GJ004', name: 'Crypto Spot Scanner → Paper → Settlement → OOS', edgeIds: ['CG005', 'CG008', 'CG009', 'CG010', 'CG013'] },
  { id: 'GJ005', name: 'Crypto Futures LONG/SHORT → Paper → Settlement → OOS', edgeIds: ['CG006', 'CG008', 'CG009', 'CG010', 'CG013'] },
  { id: 'GJ006', name: 'Backtest → Same Candidate Paper → Settlement → OOS', edgeIds: ['CG007', 'CG008', 'CG009', 'CG010', 'CG013'] },
  { id: 'GJ007', name: 'Read-only Accounts → Portfolio → Chart Overlay', edgeIds: ['CG015', 'PI005'] },
  { id: 'GJ008', name: 'Research Center → Canonical Research Evidence', edgeIds: ['PI001', 'PI002', 'PI003'] },
  { id: 'GJ009', name: 'Authenticated Candidate → Full Staging', edgeIds: ['PI004', 'CG016'] },
  { id: 'GJ010', name: 'In-app Alerts → Telegram', edgeIds: ['CG014', 'PI006'] },
  { id: 'GJ011', name: 'Research → Candidate → Backtest → Forward / Shadow / Paper evidence readback', edgeIds: ['PI008', 'PI009', 'PI010'] },
  { id: 'GJ012', name: 'Portfolio → AI Analysis', edgeIds: ['CG015', 'PI011'] },
  { id: 'GJ013', name: 'Scanner → Alert → Telegram / Member routing', edgeIds: ['CG014', 'PI012', 'PI013', 'PI014'] },
];

function combineSource(files, paths) {
  let unavailable = 0;
  const chunks = [];
  for (const file of paths) {
    const content = files.get(file);
    if (typeof content === 'string') chunks.push(content);
    else unavailable += 1;
  }
  return { text: chunks.join('\n'), unavailable, total: paths.length };
}

export function evaluateCapability(files, capability) {
  const presence = capability.presence.map((probe) => evaluateProbe(files, probe));
  const contracts = (capability.contracts ?? []).map((probe) => evaluateProbe(files, probe));
  const presenceProven = presence.filter((probe) => probe.state === CONNECTION_STATUS.PROVEN).length;
  const presenceUnknown = presence.filter((probe) => probe.state === CONNECTION_STATUS.UNKNOWN).length;
  const contractsProven = contracts.filter((probe) => probe.state === CONNECTION_STATUS.PROVEN).length;
  let status = INTEGRITY_STATUS.MISSING;
  let evidenceLevel = EVIDENCE_LEVEL.NOT_PROVEN;
  if (presenceProven === presence.length) {
    if (!contracts.length || contractsProven === contracts.length) {
      status = INTEGRITY_STATUS.PROVEN;
      evidenceLevel = EVIDENCE_LEVEL.STATIC_PROVEN;
    } else {
      status = INTEGRITY_STATUS.PARTIAL;
      evidenceLevel = EVIDENCE_LEVEL.STATIC_PROVEN;
    }
  } else if (presenceProven > 0) {
    status = INTEGRITY_STATUS.PARTIAL;
    evidenceLevel = EVIDENCE_LEVEL.STATIC_PROVEN;
  } else if (presenceUnknown > 0) {
    status = INTEGRITY_STATUS.UNKNOWN;
  }
  return { ...capability, status, evidenceLevel, presence, contracts };
}

export function findOrphanPages(files) {
  const pagePrefix = 'stock-analyzer/src/pages/';
  const pages = [...files.keys()].filter((file) => file.startsWith(pagePrefix) && /\.(?:tsx|jsx)$/u.test(file));
  return pages.flatMap((file) => {
    const stem = path.basename(file).replace(/\.(?:tsx|jsx)$/u, '');
    if (stem === 'not-found') return [];
    const tokens = [`@/pages/${stem}`, `./${stem}`, `../pages/${stem}`];
    const referencedBy = [...files.entries()]
      .filter(([candidate, content]) => candidate !== file && candidate.startsWith('stock-analyzer/src/')
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(candidate)
        && /\.[jt]sx?$/u.test(candidate) && typeof content === 'string' && tokens.some((token) => content.includes(token)))
      .map(([candidate]) => candidate);
    if (referencedBy.length) return [];
    return [{
      file,
      status: INTEGRITY_STATUS.REVIEW,
      severity: 'P2',
      reason: 'NO_STATIC_IMPORT_REFERENCE_FOUND',
      note: 'Review candidate only; dynamic routing or intentional legacy retention may be valid.',
    }];
  });
}

export function evaluateIdentityContract(files, contract) {
  const source = combineSource(files, contract.sourcePaths);
  const destination = combineSource(files, contract.destinationPaths);
  const dimensions = contract.dimensions.map((dimension) => {
    const sourceHas = source.text.includes(dimension);
    const destinationHas = destination.text.includes(dimension);
    return {
      dimension,
      source: sourceHas,
      destination: destinationHas,
      status: sourceHas && destinationHas
        ? INTEGRITY_STATUS.PROVEN
        : sourceHas || destinationHas
          ? INTEGRITY_STATUS.PARTIAL
          : INTEGRITY_STATUS.MISSING,
    };
  });
  const transport = evaluateProbe(files, { id: `${contract.id.toLowerCase()}-transport`, ...contract.transport });
  const required = (contract.required ?? []).map(probe => evaluateProbe(files, probe));
  let status;
  if (source.unavailable === source.total || destination.unavailable === destination.total) status = INTEGRITY_STATUS.UNKNOWN;
  else if (dimensions.every((item) => item.status === INTEGRITY_STATUS.PROVEN) && transport.state === CONNECTION_STATUS.PROVEN && required.every(probe => probe.state === CONNECTION_STATUS.PROVEN)) status = INTEGRITY_STATUS.PROVEN;
  else if (dimensions.some((item) => item.status !== INTEGRITY_STATUS.MISSING) || transport.state === CONNECTION_STATUS.PROVEN) status = INTEGRITY_STATUS.PARTIAL;
  else status = INTEGRITY_STATUS.MISSING;
  return {
    ...contract,
    status,
    evidenceLevel: status === INTEGRITY_STATUS.PROVEN ? EVIDENCE_LEVEL.STATIC_PROVEN : EVIDENCE_LEVEL.NOT_PROVEN,
    dimensions,
    transport,
    required,
  };
}

export function evaluateJourney(graph, journey) {
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const edges = journey.edgeIds.map((id) => byId.get(id)).filter(Boolean);
  const unresolved = journey.edgeIds.filter((id) => !byId.has(id));
  let status = INTEGRITY_STATUS.UNKNOWN;
  if (unresolved.length === 0 && edges.every((edge) => edge.status === CONNECTION_STATUS.PROVEN)) status = INTEGRITY_STATUS.PROVEN;
  else if (edges.some((edge) => edge.status === CONNECTION_STATUS.MISSING)) status = INTEGRITY_STATUS.MISSING;
  else if (edges.some((edge) => edge.status === CONNECTION_STATUS.PARTIAL)) status = INTEGRITY_STATUS.PARTIAL;
  return {
    ...journey,
    status,
    evidenceLevel: status === INTEGRITY_STATUS.PROVEN ? EVIDENCE_LEVEL.STATIC_PROVEN : EVIDENCE_LEVEL.NOT_PROVEN,
    runtimeEvidence: EVIDENCE_LEVEL.NOT_PROVEN,
    e2eEvidence: EVIDENCE_LEVEL.NOT_PROVEN,
    productionEvidence: EVIDENCE_LEVEL.NOT_PROVEN,
    unresolved,
    edges: edges.map((edge) => ({ id: edge.id, status: edge.status })),
  };
}

const LEDGER_CONTEXT = Object.freeze({
  CG003: ['REAL_PRODUCT_GAP', 'KR composer calls an absent /scanner/plans backend route; frontend URL text was a false-positive connection proof.', 'Implement a server-revalidated Paper-only seam before enabling the UI; do not forward to generic live-capable /plans.'],
  CG004: ['INTENTIONAL_SAFETY_BLOCK', 'US adapter blocker is explicit; no verified US Paper route/provider/side/risk semantics exists.', 'Keep the US blocker until a verified Paper-only adapter contract exists. Do not delete it to pass audit.'],
  CG005: ['REAL_PRODUCT_GAP', 'Signal Scanner mounts the composer, but the composer supports KR only and its scanner backend route is absent.', 'Preserve existing admission workflows; connect an independently verified Spot Paper-only server consumer.'],
  CG006: ['REAL_PRODUCT_GAP', 'Futures UI action exists, but KR-only composer drops explicit LONG/SHORT and has no server scanner route.', 'Preserve LONG/SHORT separately and reject NO_TRADE/SIGNAL_CONFLICT at the server boundary before Paper admission.'],
  CG007: ['REAL_PRODUCT_GAP', 'Backtest result references now reach isolated Paper preview, but the manual Paper engine has no canonical same-strategy consumer.', 'Implement canonical strategy execution with the same policies; never credit reference preview or manual orders as Natural Paper.'],
  CG011: ['REAL_PRODUCT_GAP', 'Manual Paper fee/slippage/funding bookkeeping is not the eight-component canonical Full Cost contract.', 'Keep costs separated; integrate measured tax/latency/liquidity/partial-fill evidence without inventing zero values.'],
  CG012: ['REAL_PRODUCT_GAP', 'Manual Paper Net PnL does not preserve all eight canonical Full Cost components.', 'Preserve full measured cost lineage before claiming canonical full-cost Net PnL.'],
  CG013: ['INTENTIONAL_SAFETY_BLOCK', 'Manual Paper journal and canonical Genuine OOS workflows are independent; no same-candidate validation receipt joins them.', 'Do not grant manual/replay/backfilled results Genuine OOS credit; obtain genuine candidate-bound validation evidence.'],
  ID001: ['REAL_PRODUCT_GAP', 'Shared selection retains timeframe/action, but AI Chat sends market/symbol only and its backend context omits timeframe.', 'Carry and validate selection scope through the real backend request and public data consumer; reject stale replies.'],
  ID002: ['REAL_PRODUCT_GAP', 'All reference dimensions and strict URL import are present; canonical Paper execution still does not carry candidate identity.', 'Keep REFERENCE_ONLY until the real Paper strategy consumer and position/settlement lineage preserve canonical identity.'],
  ID003: ['REAL_PRODUCT_GAP', 'Scanner composer payload omits side; scanner backend route does not exist.', 'Connect explicit validated direction to a Paper-only server seam, without default BUY/LONG.'],
});

function ledgerEntry(id, severity, area, wiringStatus, reason, evidenceLevel, details = {}) {
  const key = id.replace(/^EL-/u, '');
  const context = LEDGER_CONTEXT[key];
  return {
    id, severity, area, domain: details.domain ?? 'product-integrity',
    producer: details.producer ?? area, consumer: details.consumer ?? 'UNVERIFIED_CONSUMER',
    status: 'OPEN', wiringStatus, reason, evidenceLevel,
    classification: context?.[0] ?? (wiringStatus === INTEGRITY_STATUS.UNKNOWN ? null : 'REAL_PRODUCT_GAP'),
    currentProof: details.currentProof ?? [],
    rootCause: context?.[1] ?? 'Declared static/identity consumer probes are incomplete. Review source before declaring a runtime defect.',
    owner: '#1085 integration/auditor; preserve existing domain owners',
    repair: context?.[2] ?? 'Repair the verified connection or document a separately proven authority/data blocker; static absence alone does not prove blocking.',
    tests: ['.github/tests/connection-graph-auditor.test.mjs', '.github/tests/product-integrity-auditor.test.mjs'],
    remainingRuntimeProof: 'NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.',
  };
}

export function buildErrorLedger(graph, capabilities, identities) {
  const entries = [];
  for (const edge of graph.edges) {
    if (!['P0', 'P1'].includes(edge.severity) || edge.status === CONNECTION_STATUS.PROVEN) continue;
    const gaps = edge.required.filter((probe) => probe.state !== CONNECTION_STATUS.PROVEN).map((probe) => `${probe.id}:${probe.state}`);
    const blockers = edge.blockers.filter((probe) => probe.matched).map((probe) => `${probe.id}:BLOCKER_PRESENT`);
    entries.push(ledgerEntry(`EL-${edge.id}`, edge.severity, `${edge.from} → ${edge.to}`, edge.status, [...gaps, ...blockers].join(', ') || 'NON_PROVEN_EDGE', EVIDENCE_LEVEL.NOT_PROVEN, {
      domain: edge.lane, producer: edge.from, consumer: edge.to,
      currentProof: [...edge.required, ...edge.blockers].map(probe => ({ id: probe.id, state: probe.state, matchedFiles: probe.matchedFiles ?? [] })),
    }));
  }
  for (const capability of capabilities) {
    if (!['P0', 'P1'].includes(capability.severity) || capability.status === INTEGRITY_STATUS.PROVEN) continue;
    entries.push(ledgerEntry(`EL-${capability.id}`, capability.severity, capability.name, capability.status, 'CAPABILITY_STATIC_OR_CONTRACT_EVIDENCE_INCOMPLETE', capability.evidenceLevel));
  }
  for (const identity of identities) {
    if (identity.status === INTEGRITY_STATUS.PROVEN) continue;
    const gaps = identity.dimensions.filter((item) => item.status !== INTEGRITY_STATUS.PROVEN).map((item) => `${item.dimension}:${item.status}`);
    if (identity.transport.state !== CONNECTION_STATUS.PROVEN) gaps.push(`transport:${identity.transport.state}`);
    for (const probe of identity.required ?? []) if (probe.state !== CONNECTION_STATUS.PROVEN) gaps.push(`${probe.id}:${probe.state}`);
    entries.push(ledgerEntry(`EL-${identity.id}`, identity.severity, identity.name, identity.status, gaps.join(', '), identity.evidenceLevel, {
      domain: 'identity-continuity', producer: identity.sourcePaths?.join(', '), consumer: identity.destinationPaths?.join(', '),
      currentProof: { dimensions: identity.dimensions, transport: identity.transport, required: identity.required ?? [] },
    }));
  }
  return entries;
}

export function buildProductIntegrityAudit(files) {
  const graph = buildAudit(files, [...DEFAULT_EDGES, ...PRODUCT_EDGES]);
  const capabilities = DEFAULT_CAPABILITIES.map((capability) => evaluateCapability(files, capability));
  const identities = IDENTITY_CONTRACTS.map((contract) => evaluateIdentityContract(files, contract));
  const orphanPages = findOrphanPages(files);
  const journeys = GOLDEN_JOURNEYS.map((journey) => evaluateJourney(graph, journey));
  const errorLedger = buildErrorLedger(graph, capabilities, identities);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    semantics: {
      staticProofCeiling: EVIDENCE_LEVEL.STATIC_PROVEN,
      runtimeRule: 'Runtime, E2E, staging, production, and profitability evidence are never inferred from static source presence.',
      missingRule: 'MISSING != ZERO',
      unknownRule: 'UNKNOWN != SUCCESS',
      economicLaneRule: 'Manual Paper bookkeeping, reference handoff, and Natural Paper/Genuine OOS evidence are not interchangeable.',
      ledgerRule: 'Non-proven source probes stay OPEN; blocked/closed status requires separate explicit evidence, never inferred from a blocker token.',
    },
    graph,
    capabilities,
    identities,
    orphanPages,
    journeys,
    errorLedger,
    counts: {
      capabilities: capabilities.length,
      capabilityProven: capabilities.filter((item) => item.status === INTEGRITY_STATUS.PROVEN).length,
      orphanCandidates: orphanPages.length,
      identityContracts: identities.length,
      identityProven: identities.filter((item) => item.status === INTEGRITY_STATUS.PROVEN).length,
      goldenJourneys: journeys.length,
      goldenJourneyStaticProven: journeys.filter((item) => item.status === INTEGRITY_STATUS.PROVEN).length,
      p0Open: errorLedger.filter((item) => item.severity === 'P0').length,
      p1Open: errorLedger.filter((item) => item.severity === 'P1').length,
    },
  };
}

export function renderProductIntegrityMarkdown(audit) {
  const lines = [
    '# Product Integrity Audit',
    '',
    `Generated: ${audit.generatedAt}`,
    '',
    '> STATIC/CONTRACT proof is not runtime, E2E, staging, production, or profitability proof.',
    '> MISSING != ZERO. UNKNOWN != SUCCESS.',
    '',
    `Capabilities: ${audit.counts.capabilityProven}/${audit.counts.capabilities} statically proven`,
    `Identity contracts: ${audit.counts.identityProven}/${audit.counts.identityContracts} statically proven (executed contract proof tracked separately)`,
    `Golden journeys: ${audit.counts.goldenJourneyStaticProven}/${audit.counts.goldenJourneys} statically proven`,
    `Open P0/P1 ledger: ${audit.counts.p0Open}/${audit.counts.p1Open}`,
    '',
    '## Capability Inventory',
    '',
    '| ID | Capability | Severity | Status | Evidence level |',
    '|---|---|---|---|---|',
  ];
  for (const item of audit.capabilities) lines.push(`| ${item.id} | ${item.name} | ${item.severity} | ${item.status} | ${item.evidenceLevel} |`);
  lines.push('', '## Identity Continuity', '', '| ID | Contract | Status | Evidence level |', '|---|---|---|---|');
  for (const item of audit.identities) lines.push(`| ${item.id} | ${item.name} | ${item.status} | ${item.evidenceLevel} |`);
  lines.push('', '## Golden Journey Matrix', '', '| ID | Journey | Static status | Runtime | E2E | Production |', '|---|---|---|---|---|---|');
  for (const item of audit.journeys) lines.push(`| ${item.id} | ${item.name} | ${item.status} | ${item.runtimeEvidence} | ${item.e2eEvidence} | ${item.productionEvidence} |`);
  lines.push('', '## Orphan Page Candidates', '');
  if (!audit.orphanPages.length) lines.push('None detected by static import scan.');
  else for (const item of audit.orphanPages) lines.push(`- ${item.file} — ${item.reason} (${item.note})`);
  lines.push('', '## Error Ledger — P0/P1 only', '', '| ID | Severity | Area | Status | Evidence | Reason |', '|---|---|---|---|---|---|');
  if (!audit.errorLedger.length) lines.push('| - | - | - | - | - | No open P0/P1 static/contract gaps |');
  else for (const item of audit.errorLedger) lines.push(`| ${item.id} | ${item.severity} | ${item.area} | ${item.status} | ${item.evidenceLevel} | ${item.reason.replaceAll('|', '\\|')} |`);
  for (const item of audit.errorLedger) {
    lines.push('', `### ${item.id}`, '',
      `- Severity / Domain: ${item.severity} / ${item.domain ?? 'UNCLASSIFIED'}`,
      `- Producer: ${item.producer ?? 'UNKNOWN'}`,
      `- Consumer: ${item.consumer ?? 'UNKNOWN'}`,
      `- Status / Wiring / Classification: ${item.status} / ${item.wiringStatus ?? 'UNKNOWN'} / ${item.classification ?? 'SOURCE_REVIEW_REQUIRED'}`,
      `- Evidence Level: ${item.evidenceLevel}`,
      `- Current Proof: ${JSON.stringify(item.currentProof ?? [])}`,
      `- Root Cause: ${item.rootCause ?? item.reason}`,
      `- Owner: ${item.owner ?? 'OWNER_REVIEW_REQUIRED'}`,
      `- Repair: ${item.repair ?? 'NOT_IMPLEMENTED'}`,
      `- Tests: ${(item.tests ?? []).join(', ')}`,
      `- Remaining Runtime Proof: ${item.remainingRuntimeProof ?? 'NOT_PROVEN'}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { jsonOutput: null, markdownOutput: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json-output') options.jsonOutput = argv[++index] ?? null;
    else if (arg === '--markdown-output') options.markdownOutput = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function writeOutput(file, content) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = await collectTextFiles(process.cwd());
  const audit = buildProductIntegrityAudit(files);
  const json = `${JSON.stringify(audit, null, 2)}\n`;
  const markdown = renderProductIntegrityMarkdown(audit);
  await writeOutput(options.jsonOutput, json);
  await writeOutput(options.markdownOutput, markdown);
  process.stdout.write(markdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[PRODUCT_INTEGRITY_AUDIT_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

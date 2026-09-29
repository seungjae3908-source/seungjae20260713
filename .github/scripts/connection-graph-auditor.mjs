import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONNECTION_STATUS = Object.freeze({
  PROVEN: 'PROVEN',
  PARTIAL: 'PARTIAL',
  MISSING: 'MISSING',
  UNKNOWN: 'UNKNOWN',
});

const TEXT_FILE = /\.(?:cjs|js|json|jsx|md|mjs|ts|tsx|yaml|yml)$/u;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

export const DEFAULT_EDGES = [
  {
    id: 'CG001',
    from: 'Stock Scanner',
    to: 'AI Chart',
    severity: 'P1',
    lane: 'analysis-selection',
    required: [
      {
        id: 'scanner-selection-write',
        paths: ['stock-analyzer/src/pages/scanner.tsx'],
        allOf: ['analysisSelection.select(next)', 'selectionQuery(next)', 'timeframe'],
      },
      {
        id: 'scanner-chart-navigation',
        paths: ['stock-analyzer/src/pages/scanner.tsx'],
        allOf: ['/ai-chart?', 'onAnalyze'],
      },
      {
        id: 'shared-analysis-selection-contract',
        paths: ['stock-analyzer/src/lib/analysis-selection.tsx'],
        allOf: ['AnalysisSelection', 'timeframe', 'selectedAt'],
      },
    ],
  },
  {
    id: 'CG002',
    from: 'AI Chart',
    to: 'AI Chat',
    severity: 'P2',
    lane: 'analysis-selection',
    required: [
      {
        id: 'ai-chart-selection-consumer',
        paths: ['stock-analyzer/src/pages/ai-chart.tsx'],
        anyOf: ['useAnalysisSelection', 'analysisSelection'],
      },
      {
        id: 'ai-chat-selection-consumer',
        paths: ['stock-analyzer/src/pages/ai-chat.tsx'],
        anyOf: ['useAnalysisSelection', 'analysisSelection'],
      },
      {
        id: 'ai-chat-request-timeframe',
        paths: ['stock-analyzer/src/lib/ai-chat-selection.ts'],
        allOf: ['timeframe: selection.timeframe'],
      },
      {
        id: 'ai-chat-backend-timeframe-consumer',
        paths: ['api-server/src/services/ai-chat.service.ts'],
        allOf: ['row.timeframe', 'row.action', 'selection: context', 'publicQuestionPayload(message, publicContext'],
      },
      {
        id: 'shared-analysis-selection-storage',
        paths: ['stock-analyzer/src/lib/analysis-selection.tsx'],
        anyOf: ['localStorage', 'sessionStorage'],
      },
    ],
  },
  {
    id: 'CG003',
    from: 'Stock Scanner KR',
    to: 'Approval Paper Plan',
    severity: 'P1',
    lane: 'scanner-paper',
    required: [
      {
        id: 'kr-paper-composer-contract',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        allOf: ["selection.market === 'KR'", "/api/trade-automation/scanner/plans", "accountMode: 'paper'", "adapter: 'paper'"],
      },
      {
        id: 'composer-mounted-outside-definition',
        pathPrefix: 'stock-analyzer/src/',
        excludePaths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        anyOf: ['<ScannerApprovalComposer', 'ScannerApprovalComposer('],
      },
      {
        id: 'scanner-paper-server-route',
        paths: ['api-server/src/routes/scanner-paper-plans.ts'],
        allOf: ["router.post('/scanner/plans'", "requireCapability('canAccessPaperTrading')", 'registry.resolveScanner('],
      },
    ],
  },
  {
    id: 'CG004',
    from: 'Stock Scanner US',
    to: 'Approval Paper Plan',
    severity: 'P1',
    lane: 'scanner-paper',
    terminalBlocker: true,
    required: [
      {
        id: 'us-paper-composer-contract',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        anyOf: ['US_ORDER_ADAPTER_AVAILABLE', '미국 Paper 지원', "supportedMarkets.includes('US')"],
      },
      {
        id: 'scanner-paper-endpoint',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        allOf: ['/api/trade-automation/scanner/plans', "accountMode: 'paper'"],
      },
    ],
    blockers: [
      {
        id: 'explicit-us-adapter-block',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        anyOf: ['US_ORDER_ADAPTER_NOT_AVAILABLE', '미국주식 주문 어댑터가 검증되기 전까지'],
      },
    ],
  },
  {
    id: 'CG005',
    from: 'Crypto Spot Scanner',
    to: 'Approval Paper Plan',
    severity: 'P1',
    lane: 'scanner-paper',
    required: [
      {
        id: 'crypto-workspace-paper-handoff',
        paths: ['stock-analyzer/src/pages/signal-scanner.tsx'],
        allOf: ['<ScannerApprovalComposer', 'selectionFor', 'onOrderPreparation'],
      },
      {
        id: 'spot-paper-supported-composer',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        allOf: ["selection.market === 'UPBIT'", "accountMode: 'paper'"],
      },
      {
        id: 'scanner-paper-server-route',
        paths: ['api-server/src/routes/scanner-paper-plans.ts'],
        allOf: ["router.post('/scanner/plans'", "requireCapability('canAccessPaperTrading')", 'registry.resolveScanner('],
      },
      {
        id: 'scanner-paper-bridge-contract',
        paths: ['.github/workflows/scanner-paper-bridge.yml'],
        anyOf: ['paper', 'scanner'],
      },
    ],
  },
  {
    id: 'CG006',
    from: 'Crypto Futures LONG/SHORT Scanner',
    to: 'Approval Paper Plan',
    severity: 'P1',
    lane: 'scanner-paper',
    required: [
      {
        id: 'futures-ui-paper-handoff',
        paths: ['stock-analyzer/src/pages/signal-scanner.tsx'],
        allOf: ['<ScannerApprovalComposer', 'LONG', 'SHORT', 'onOrderPreparation'],
      },
      {
        id: 'futures-paper-supported-composer',
        paths: ['stock-analyzer/src/components/scanner-approval-composer.tsx'],
        allOf: ["selection.market === 'BITGET'", "accountMode: 'paper'"],
      },
      {
        id: 'scanner-paper-server-route',
        paths: ['api-server/src/routes/scanner-paper-plans.ts'],
        allOf: ["router.post('/scanner/plans'", "requireCapability('canAccessPaperTrading')", 'registry.resolveScanner('],
      },
      {
        id: 'futures-paper-admission-contract',
        paths: ['.github/workflows/scanner-crypto-futures-paper-admission-composer.yml'],
        allOf: ['paper', 'scanner'],
      },
      {
        id: 'direction-paper-validation',
        paths: ['.github/workflows/signal-direction-paper-bridge-validation.yml'],
        anyOf: ['LONG', 'SHORT', 'direction'],
      },
    ],
  },
  {
    id: 'CG007',
    from: 'Backtest Result',
    to: 'Paper Trading Candidate',
    severity: 'P1',
    lane: 'candidate-identity',
    required: [
      {
        id: 'backtest-paper-navigation',
        paths: ['stock-analyzer/src/pages/backtests.tsx'],
        allOf: ['href="/paper-trading"', '모의매매'],
      },
      {
        id: 'backtest-identity-export',
        paths: ['api-server/src/services/backtest-paper-handoff.service.ts'],
        allOf: ['candidateId', 'parameterHash', 'strategyId', 'strategyCandidateId', 'resolveCanonicalStrategyIdentity'],
      },
      {
        id: 'paper-identity-import',
        paths: ['stock-analyzer/src/pages/paper-trading.tsx'],
        allOf: ['readBacktestPaperHandoff(search)', 'imported.active ? <BacktestPaperCandidatePreview'],
      },
      {
        id: 'identity-dimensions',
        paths: ['packages/strategy-hypothesis/src/backtest-paper-handoff.d.ts'],
        allOf: ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage', 'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'],
      },
      {
        id: 'result-bound-url-handoff',
        paths: ['stock-analyzer/src/components/backtest-research-panel.tsx'],
        allOf: ['result.paperHandoffs.map', 'backtestPaperHandoffPath(handoff, result.paperHandoffRunId)'],
      },
      {
        id: 'canonical-strategy-paper-execution-consumer',
        paths: ['api-server/src/services/paper-trading.types.ts'],
        allOf: ['candidateId', 'strategyId', 'parameterHash', 'exitPolicyRef'],
      },
    ],
  },
  {
    id: 'CG008',
    from: 'Paper Trading',
    to: 'Position',
    severity: 'P1',
    lane: 'economic-loop',
    required: [
      {
        id: 'paper-position-ui',
        paths: ['stock-analyzer/src/components/paper-trading-panel.tsx'],
        anyOf: ['position', 'positions', '포지션'],
      },
      {
        id: 'paper-position-contract',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['createPositionFromOrder', 'state.positions.push(position)'],
      },
    ],
  },
  {
    id: 'CG009',
    from: 'Position',
    to: 'Exit',
    severity: 'P1',
    lane: 'economic-loop',
    required: [
      {
        id: 'paper-exit-semantics',
        paths: ['stock-analyzer/src/components/paper-trading-panel.tsx'],
        anyOf: ['closePosition', 'close position', '청산', 'stopLoss', 'takeProfit'],
      },
      {
        id: 'server-exit-contract',
        paths: ['api-server/src/services/paper-trading-candle.service.ts'],
        allOf: ['closePosition', 'closePositionInternal'],
      },
    ],
  },
  {
    id: 'CG010',
    from: 'Exit',
    to: 'Settlement',
    severity: 'P1',
    lane: 'economic-loop',
    required: [
      {
        id: 'four-market-settlement-validation',
        paths: ['.github/workflows/four-market-paper-settlement-validation.yml'],
        allOf: ['paper', 'settlement'],
      },
      {
        id: 'settlement-runtime-contract',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['upsertJournal(state, position, order, fill, reason)', 'netPnl: netForJournal'],
      },
    ],
  },
  {
    id: 'CG011',
    from: 'Settlement',
    to: 'Full Cost',
    severity: 'P1',
    lane: 'profitability-evidence',
    required: [
      {
        id: 'settlement-profitability-gate',
        paths: ['.github/workflows/prediction-lab-settlement-profitability-evidence-gate.yml'],
        allOf: ['settlement', 'profit'],
      },
      {
        id: 'cost-evidence-contract',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['entryFeeAllocation', 'exitFee', 'entrySlippageAllocation', 'exitSlippage', 'funding'],
      },
      {
        id: 'manual-paper-full-eight-component-cost-contract',
        paths: ['api-server/src/services/paper-trading.types.ts'],
        allOf: ['latency', 'liquidityImpact', 'partialFillImpact', 'tax'],
      },
    ],
  },
  {
    id: 'CG012',
    from: 'Full Cost',
    to: 'Net PnL',
    severity: 'P1',
    lane: 'profitability-evidence',
    required: [
      {
        id: 'full-cost-source',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['entryFeeAllocation', 'exitFee', 'exitSlippage', 'funding'],
      },
      {
        id: 'net-pnl-source',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['netPnl: netForJournal', 'upsertJournal'],
      },
      {
        id: 'full-cost-components-preserved',
        paths: ['api-server/src/services/paper-trading.types.ts'],
        allOf: ['latency', 'liquidityImpact', 'partialFillImpact', 'tax'],
      },
    ],
  },
  {
    id: 'CG013',
    from: 'Net PnL',
    to: 'Validation / Genuine OOS',
    severity: 'P1',
    lane: 'profitability-evidence',
    required: [
      {
        id: 'oos-validation-workflow',
        paths: ['.github/workflows/public-forward-liquidity-calibration-oos-validation.yml'],
        anyOf: ['OOS', 'oos'],
      },
      {
        id: 'final-holdout-workflow',
        paths: ['.github/workflows/prediction-lab-final-holdout.yml'],
        anyOf: ['holdout', 'OOS', 'oos'],
      },
      {
        id: 'net-pnl-evidence-source',
        paths: ['api-server/src/services/paper-trading-position.service.ts'],
        allOf: ['netPnl: netForJournal'],
      },
      {
        id: 'same-candidate-manual-paper-validation-consumer',
        paths: ['api-server/src/services/paper-trading.types.ts'],
        allOf: ['candidateId', 'parameterHash', 'validationReceipt'],
      },
    ],
  },
  {
    id: 'CG014',
    from: 'Crypto Scanner',
    to: 'In-app Alerts',
    severity: 'P2',
    lane: 'notifications',
    required: [
      {
        id: 'crypto-alert-source',
        paths: ['stock-analyzer/src/pages/signal-scanner.tsx'],
        allOf: ['data.alerts.map', 'alertTitle(alert)'],
      },
      {
        id: 'alert-center-crypto-consumer',
        paths: ['stock-analyzer/src/pages/alerts.tsx'],
        allOf: ['/notifications/history?limit=200', 'parseNotificationHistory'],
      },
      {
        id: 'scanner-alert-central-history-producer',
        paths: ['api-server/src/services/scanner-telegram-delivery.service.ts'],
        allOf: ['deliverMemberNotification', 'runScannerInAppNotification', 'memberId'],
      },
      {
        id: 'notification-history-canonical-writer',
        paths: ['api-server/src/services/notification.service.ts'],
        allOf: ["from('notification_history')", 'member_id: input.memberId'],
      },
    ],
  },
  {
    id: 'CG015',
    from: 'Broker Read-only Accounts',
    to: 'Portfolio',
    severity: 'P1',
    lane: 'account-portfolio',
    required: [
      {
        id: 'broker-readonly-ui',
        paths: ['stock-analyzer/src/components/brokerage-account-connections.tsx'],
        allOf: ['read', 'only'],
      },
      {
        id: 'portfolio-source',
        paths: ['stock-analyzer/src/pages/portfolio.tsx', 'stock-analyzer/src/pages/portfolio-v2.tsx'],
        anyOf: ['portfolio', 'position', 'positions'],
      },
      {
        id: 'readonly-response-contract',
        paths: ['stock-analyzer/src/lib/account-readonly-response.ts'],
        allOf: ['UNAVAILABLE', 'requireAccountReadonlySnapshotResponse', 'readOnly', 'orderRequests !== 0', 'credentialsReturned !== false'],
      },
      {
        id: 'readonly-response-enforced-consumer',
        paths: ['stock-analyzer/src/lib/auth-fetch.ts'],
        allOf: ['requireAccountReadonlySnapshotResponse(path, method', 'response.clone().json()'],
      },
    ],
  },
  {
    id: 'CG016',
    from: 'Current Main Candidate',
    to: 'Authenticated Full Staging Journey',
    severity: 'RELEASE_GATE',
    lane: 'release-validation',
    required: [
      {
        id: 'full-staging-four-account-gate',
        paths: ['.github/workflows/staging-readiness.yml'],
        allOf: ['run_full_validation', 'STAGING_PENDING_EMAIL', 'STAGING_ASSOCIATE_EMAIL', 'STAGING_REGULAR_EMAIL', 'STAGING_ADMIN_EMAIL'],
      },
      {
        id: 'staging-verdict-contract',
        paths: ['.github/workflows/staging-readiness.yml', 'api-server/scripts/verify-staging-verdict.mjs'],
        allOf: ['release_ready', 'failed', 'skipped'],
      },
    ],
  },
];

// Every Scanner lane must prove the server's canonical identity/admission consumer,
// not just a mounted button, frontend URL or an unrelated workflow.
for (const edge of DEFAULT_EDGES.filter(item => ['CG003', 'CG004', 'CG005', 'CG006'].includes(item.id))) {
  edge.required.push({
    id: 'scanner-paper-route-mounted',
    paths: ['api-server/src/routes/trade-automation.ts'],
    allOf: ['router.use(createScannerPaperPlansRouter())'],
  }, {
    id: 'scanner-server-source-canonical-identity',
    paths: ['api-server/src/services/product-paper-source-registry.service.ts'],
    allOf: ['assertPaperApprovalEnvelope', "this.read('SCANNER'", 'resolveScannerCanonicalPaperIdentity(', 'SCANNER_DIRECTION_MISMATCH', 'SCANNER_TIMEFRAME_MISMATCH', 'SERVER_LEVERAGE_PROVENANCE_REQUIRED'],
  });
  edge.required.push({
    id: 'scanner-canonical-paper-server-consumer',
    paths: ['api-server/src/routes/scanner-paper-plans.ts'],
    allOf: ["router.post('/scanner/plans'", 'registry.resolveScanner(', 'resolveCanonicalPaperAdmissionBridgeCandidate(', 'runRecurringPaperCycle('],
  });
}
const backtestPaperEdge = DEFAULT_EDGES.find(item => item.id === 'CG007');
backtestPaperEdge.required.push({
  id: 'backtest-server-run-reference-validation',
  paths: ['api-server/src/routes/backtests.ts'],
  allOf: ["router.post('/backtests/paper/validate'", 'requireAdmin', 'sourceRegistry.resolveBacktest(', 'sourceRegistry.captureBacktest('],
});
backtestPaperEdge.required.push({
  id: 'same-candidate-paper-position-consumer',
  paths: ['api-server/src/services/paper-trading-position.service.ts'],
  allOf: ['createPositionFromOrder', 'candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage'],
});
backtestPaperEdge.required.push({
  id: 'accepted-backtest-paper-execution-route',
  paths: ['api-server/src/routes/paper-trading.ts'],
  allOf: ['backtestCandidate', 'resolveCanonicalStrategyIdentity(', 'applyPaperTradingAction', 'evaluate('],
});

// Owner-delegated consumers are useful diagnostic context, not closure evidence.
// Keep every required probe unchanged: a typed consumer cannot originate genuine
// cost measurements, persisted readback or an immutable validation receipt.
const manualContractPath = 'api-server/src/services/manual-paper-canonical-contract.service.ts';
DEFAULT_EDGES.find(edge => edge.id === 'CG011').observations = [{
  id: 'owner-delegated-full-cost-consumer', paths: [manualContractPath],
  allOf: ['prepareManualPaperCanonicalEvidence(', 'entryCostEvidence.components',
    'validateNaturalPaperTriggerBoundSettlementEvidence(input)', 'adaptNaturalPaperSettlementFullCost(input)'],
}];
DEFAULT_EDGES.find(edge => edge.id === 'CG012').observations = [{
  id: 'owner-canonical-net-pnl-forwarding',
  paths: ['api-server/src/services/paper-trading-position.service.ts'],
  allOf: ['canonical?.settlement?.netPnl', 'position.canonicalPaper = structuredClone(canonical.lineage)',
    'netPnl: netForJournal', 'upsertJournal(state, position, order, fill, reason)'],
}];
DEFAULT_EDGES.find(edge => edge.id === 'CG013').observations = [{
  id: 'owner-delegated-validation-receipt-consumer', paths: [manualContractPath],
  allOf: ['consumeManualSameCandidateValidationReceipt(', 'receiptSha256',
    'readbackVerified', 'assertManualPaperCanonicalIdentity(identity, receipt.identity)'],
}];

function slash(value) {
  return value.split(path.sep).join('/');
}

export async function collectTextFiles(root) {
  const files = new Map();

  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(relativeDirectory, entry.name));
        continue;
      }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
      const relativePath = slash(path.join(relativeDirectory, entry.name));
      try {
        files.set(relativePath, await readFile(path.join(root, relativePath), 'utf8'));
      } catch {
        files.set(relativePath, null);
      }
    }
  }

  await visit('');
  return files;
}

function candidateFiles(files, probe) {
  const excluded = new Set(probe.excludePaths ?? []);
  if (probe.paths?.length) {
    return probe.paths
      .filter((file) => !excluded.has(file))
      .map((file) => [file, files.has(file) ? files.get(file) : undefined]);
  }
  return [...files.entries()].filter(([file]) => {
    if (excluded.has(file)) return false;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) return false;
    if (file.startsWith('docs/') || file.endsWith('.md')) return false;
    if (probe.pathPrefix && !file.startsWith(probe.pathPrefix)) return false;
    if (probe.pathIncludes && !file.includes(probe.pathIncludes)) return false;
    return true;
  });
}

export function evaluateProbe(files, probe) {
  const candidates = candidateFiles(files, probe);
  if (!candidates.length || candidates.every(([, content]) => content === undefined || content === null)) {
    return {
      id: probe.id,
      state: CONNECTION_STATUS.UNKNOWN,
      matched: false,
      matchedFiles: [],
      reason: 'SOURCE_UNAVAILABLE',
    };
  }

  const readable = candidates.filter(([, content]) => typeof content === 'string');
  const matchedFiles = [];
  for (const [file, content] of readable) {
    const allOf = probe.allOf ?? [];
    const anyOf = probe.anyOf ?? [];
    const allMatched = allOf.every((token) => content.includes(token));
    const anyMatched = anyOf.length === 0 || anyOf.some((token) => content.includes(token));
    if (allMatched && anyMatched) matchedFiles.push(file);
  }

  return {
    id: probe.id,
    state: matchedFiles.length ? CONNECTION_STATUS.PROVEN : CONNECTION_STATUS.MISSING,
    matched: matchedFiles.length > 0,
    matchedFiles,
    reason: matchedFiles.length ? 'STATIC_EVIDENCE_PRESENT' : 'STATIC_EVIDENCE_NOT_FOUND',
  };
}

export function evaluateEdge(files, edge) {
  const required = edge.required.map((probe) => evaluateProbe(files, probe));
  const blockers = (edge.blockers ?? []).map((probe) => evaluateProbe(files, probe));
  const observations = (edge.observations ?? []).map((probe) => evaluateProbe(files, probe));
  const blockerMatched = blockers.some((probe) => probe.matched);
  const provenCount = required.filter((probe) => probe.state === CONNECTION_STATUS.PROVEN).length;
  const unknownCount = required.filter((probe) => probe.state === CONNECTION_STATUS.UNKNOWN).length;

  let status;
  if (edge.terminalBlocker && blockerMatched) {
    status = CONNECTION_STATUS.MISSING;
  } else if (provenCount === required.length && !blockerMatched) {
    status = CONNECTION_STATUS.PROVEN;
  } else if (provenCount > 0 || blockerMatched) {
    status = CONNECTION_STATUS.PARTIAL;
  } else if (unknownCount > 0) {
    status = CONNECTION_STATUS.UNKNOWN;
  } else {
    status = CONNECTION_STATUS.MISSING;
  }

  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    severity: edge.severity,
    lane: edge.lane,
    status,
    scope: 'STATIC_WIRING_EVIDENCE_ONLY',
    required,
    blockers,
    observations,
  };
}

export function buildAudit(files, edges = DEFAULT_EDGES) {
  const results = edges.map((edge) => evaluateEdge(files, edge));
  const counts = Object.fromEntries(Object.values(CONNECTION_STATUS).map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    semantics: {
      PROVEN: 'All declared static wiring probes were found. Runtime success is not implied.',
      PARTIAL: 'Some static wiring evidence exists, but the declared connection is incomplete or blocked.',
      MISSING: 'Readable sources exist but required static wiring evidence is missing or explicitly blocked.',
      UNKNOWN: 'Evidence could not be read or located. UNKNOWN is never treated as zero or success.',
    },
    counts,
    edges: results,
  };
}

export function renderMarkdown(audit) {
  const lines = [
    '# Connection Graph Audit',
    '',
    `Generated: ${audit.generatedAt}`,
    '',
    '> Static wiring audit only. PROVEN does not mean runtime, staging, profitability, or production proof.',
    '> MISSING != ZERO. UNKNOWN != SUCCESS.',
    '',
    '| ID | From | To | Severity | Lane | Status |',
    '|---|---|---|---|---|---|',
  ];
  for (const edge of audit.edges) {
    lines.push(`| ${edge.id} | ${edge.from} | ${edge.to} | ${edge.severity} | ${edge.lane} | ${edge.status} |`);
  }
  lines.push('', '## Evidence detail', '');
  for (const edge of audit.edges) {
    lines.push(`### ${edge.id} — ${edge.from} → ${edge.to}`, '', `Status: **${edge.status}**`, '');
    for (const probe of edge.required) {
      lines.push(`- required \`${probe.id}\`: ${probe.state} — ${probe.matchedFiles.join(', ') || probe.reason}`);
    }
    for (const probe of edge.blockers) {
      lines.push(`- blocker \`${probe.id}\`: ${probe.matched ? 'PRESENT' : probe.state} — ${probe.matchedFiles.join(', ') || probe.reason}`);
    }
    for (const probe of edge.observations ?? []) {
      lines.push(`- non-closure observation \`${probe.id}\`: ${probe.state} — ${probe.matchedFiles.join(', ') || probe.reason}; not issuer, persisted readback or runtime proof`);
    }
    lines.push('');
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
  const root = process.cwd();
  const files = await collectTextFiles(root);
  const audit = buildAudit(files);
  const json = `${JSON.stringify(audit, null, 2)}\n`;
  const markdown = renderMarkdown(audit);
  await writeOutput(options.jsonOutput, json);
  await writeOutput(options.markdownOutput, markdown);
  process.stdout.write(markdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[CONNECTION_GRAPH_AUDIT_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

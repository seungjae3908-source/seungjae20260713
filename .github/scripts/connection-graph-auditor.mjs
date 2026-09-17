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
        paths: ['api-server/src/routes/trade-automation.ts'],
        allOf: ["router.post('/scanner/plans'", 'assertPaperApprovalEnvelope'],
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
        paths: ['api-server/src/routes/trade-automation.ts'],
        allOf: ["router.post('/scanner/plans'", 'assertPaperApprovalEnvelope'],
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
        paths: ['api-server/src/routes/trade-automation.ts'],
        allOf: ["router.post('/scanner/plans'", 'assertPaperApprovalEnvelope'],
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
        paths: ['stock-analyzer/src/components/backtest-research-panel.tsx', 'stock-analyzer/src/lib/backtest.ts'],
        allOf: ['candidateId', 'parameterHash', 'strategyId'],
      },
      {
        id: 'paper-identity-import',
        paths: ['stock-analyzer/src/components/paper-trading-panel.tsx', 'stock-analyzer/src/pages/paper-trading.tsx'],
        allOf: ['candidateId', 'parameterHash', 'strategyId'],
      },
      {
        id: 'identity-dimensions',
        paths: ['stock-analyzer/src/components/backtest-research-panel.tsx', 'stock-analyzer/src/components/paper-trading-panel.tsx'],
        allOf: ['symbol', 'timeframe', 'side', 'strategy', 'leverage'],
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
        pathPrefix: 'api-server/',
        allOf: ['paper', 'position'],
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
        pathPrefix: 'api-server/',
        allOf: ['position', 'exit'],
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
        pathPrefix: 'api-server/',
        allOf: ['settlement', 'paper'],
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
        pathPrefix: 'api-server/',
        anyOf: ['FULL_COST_READY', 'fullCost', 'full_cost'],
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
        pathPrefix: 'api-server/',
        anyOf: ['FULL_COST_READY', 'fullCost', 'full_cost'],
      },
      {
        id: 'net-pnl-source',
        pathPrefix: 'api-server/',
        anyOf: ['netPnl', 'net_pnl', 'NET_PNL'],
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
        pathPrefix: 'api-server/',
        anyOf: ['netPnl', 'net_pnl', 'NET_PNL'],
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
        paths: ['stock-analyzer/src/components/crypto-trading-workspace.tsx'],
        anyOf: ['alert', 'notification', '알림'],
      },
      {
        id: 'alert-center-crypto-consumer',
        paths: ['stock-analyzer/src/pages/alerts.tsx', 'stock-analyzer/src/components/unified-notification-settings.tsx'],
        anyOf: ['crypto', 'coin', 'futures', 'CRYPTO'],
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

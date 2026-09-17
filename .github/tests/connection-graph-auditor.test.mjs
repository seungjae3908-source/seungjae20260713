import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_STATUS,
  DEFAULT_EDGES,
  buildAudit,
  evaluateEdge,
  evaluateProbe,
  renderMarkdown,
} from '../scripts/connection-graph-auditor.mjs';

test('probe is PROVEN only when declared static evidence is present', () => {
  const files = new Map([['a.ts', 'alpha beta gamma']]);
  const result = evaluateProbe(files, { id: 'p', paths: ['a.ts'], allOf: ['alpha', 'beta'] });
  assert.equal(result.state, CONNECTION_STATUS.PROVEN);
  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedFiles, ['a.ts']);
});

test('readable missing evidence is MISSING rather than UNKNOWN or success', () => {
  const files = new Map([['a.ts', 'alpha']]);
  const result = evaluateProbe(files, { id: 'p', paths: ['a.ts'], allOf: ['alpha', 'missing-token'] });
  assert.equal(result.state, CONNECTION_STATUS.MISSING);
  assert.equal(result.matched, false);
});

test('unavailable source is UNKNOWN and is never coerced to zero or success', () => {
  const files = new Map([['a.ts', 'alpha']]);
  const result = evaluateProbe(files, { id: 'p', paths: ['does-not-exist.ts'], anyOf: ['anything'] });
  assert.equal(result.state, CONNECTION_STATUS.UNKNOWN);
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'SOURCE_UNAVAILABLE');
});

test('edge becomes PARTIAL when only some required probes are proven', () => {
  const files = new Map([
    ['source.ts', 'source connected'],
    ['target.ts', 'target without identity'],
  ]);
  const result = evaluateEdge(files, {
    id: 'edge', from: 'A', to: 'B', severity: 'P1', lane: 'test',
    required: [
      { id: 'source', paths: ['source.ts'], allOf: ['connected'] },
      { id: 'identity', paths: ['target.ts'], allOf: ['candidateId'] },
    ],
  });
  assert.equal(result.status, CONNECTION_STATUS.PARTIAL);
});

test('edge becomes MISSING when readable required evidence is absent', () => {
  const files = new Map([['source.ts', 'nothing useful here']]);
  const result = evaluateEdge(files, {
    id: 'edge', from: 'A', to: 'B', severity: 'P1', lane: 'test',
    required: [{ id: 'source', paths: ['source.ts'], allOf: ['required-token'] }],
  });
  assert.equal(result.status, CONNECTION_STATUS.MISSING);
});

test('terminal blocker forces MISSING even when another probe is proven', () => {
  const files = new Map([['source.ts', 'endpoint PRESENT_EXPLICIT_BLOCK']]);
  const result = evaluateEdge(files, {
    id: 'edge', from: 'A', to: 'B', severity: 'P1', lane: 'test', terminalBlocker: true,
    required: [{ id: 'endpoint', paths: ['source.ts'], allOf: ['endpoint'] }],
    blockers: [{ id: 'block', paths: ['source.ts'], allOf: ['PRESENT_EXPLICIT_BLOCK'] }],
  });
  assert.equal(result.status, CONNECTION_STATUS.MISSING);
  assert.equal(result.blockers[0].matched, true);
});

test('audit count and markdown keep fail-closed semantics visible', () => {
  const files = new Map([['a.ts', 'ok']]);
  const audit = buildAudit(files, [
    { id: 'one', from: 'A', to: 'B', severity: 'P1', lane: 'x', required: [{ id: 'p', paths: ['a.ts'], allOf: ['ok'] }] },
    { id: 'two', from: 'B', to: 'C', severity: 'P1', lane: 'x', required: [{ id: 'p', paths: ['a.ts'], allOf: ['missing'] }] },
    { id: 'three', from: 'C', to: 'D', severity: 'P1', lane: 'x', required: [{ id: 'p', paths: ['unknown.ts'], allOf: ['x'] }] },
  ]);
  assert.equal(audit.counts.PROVEN, 1);
  assert.equal(audit.counts.MISSING, 1);
  assert.equal(audit.counts.UNKNOWN, 1);
  const markdown = renderMarkdown(audit);
  assert.match(markdown, /MISSING != ZERO/u);
  assert.match(markdown, /UNKNOWN != SUCCESS/u);
  assert.match(markdown, /Static wiring audit only/u);
});

test('default graph ids are unique and core repair lanes are represented', () => {
  const ids = DEFAULT_EDGES.map((edge) => edge.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const lane of ['analysis-selection', 'scanner-paper', 'candidate-identity', 'economic-loop', 'profitability-evidence', 'notifications', 'account-portfolio', 'release-validation']) {
    assert.ok(DEFAULT_EDGES.some((edge) => edge.lane === lane), `missing lane ${lane}`);
  }
});

test('frontend endpoint text cannot prove KR scanner backend connection', () => {
  const files = new Map([
    ['stock-analyzer/src/components/scanner-approval-composer.tsx', "selection.market === 'KR' /api/trade-automation/scanner/plans accountMode: 'paper' adapter: 'paper'"],
    ['stock-analyzer/src/pages/signal-scanner.tsx', '<ScannerApprovalComposer'],
    ['api-server/src/routes/trade-automation.ts', "router.post('/plans', handler)"],
  ]);
  const result = evaluateEdge(files, DEFAULT_EDGES.find((edge) => edge.id === 'CG003'));
  assert.equal(result.status, CONNECTION_STATUS.PARTIAL);
  assert.equal(result.required.find((probe) => probe.id === 'scanner-paper-server-route').state, CONNECTION_STATUS.MISSING);
});

test('uppercase canonical readonly contract and its consumer are recognized', () => {
  const files = new Map([
    ['stock-analyzer/src/components/brokerage-account-connections.tsx', 'read only'],
    ['stock-analyzer/src/pages/portfolio.tsx', 'positions'],
    ['stock-analyzer/src/lib/account-readonly-response.ts', 'UNAVAILABLE requireAccountReadonlySnapshotResponse readOnly orderRequests !== 0 credentialsReturned !== false'],
    ['stock-analyzer/src/lib/auth-fetch.ts', 'requireAccountReadonlySnapshotResponse(path, method response.clone().json()'],
  ]);
  assert.equal(evaluateEdge(files, DEFAULT_EDGES.find((edge) => edge.id === 'CG015')).status, CONNECTION_STATUS.PROVEN);
});

test('tests and documentation cannot prove executable prefix consumers', () => {
  const files = new Map([
    ['api-server/src/consumer.test.ts', 'candidateId paper position'],
    ['api-server/docs/consumer.md', 'candidateId paper position'],
    ['api-server/src/consumer.ts', 'export const referenceOnly = true'],
  ]);
  assert.equal(evaluateProbe(files, { id: 'consumer', pathPrefix: 'api-server/', allOf: ['candidateId', 'paper', 'position'] }).state, 'MISSING');
});

test('generic Natural Paper workflow tokens cannot prove manual Full Cost or OOS continuity', () => {
  const files = new Map([
    ['api-server/src/services/unrelated-natural-paper.ts', 'FULL_COST_READY fullCost netPnl validationReceipt candidateId parameterHash'],
    ['api-server/src/services/paper-trading.types.ts', 'PaperJournalEntry netPnl entryFee exitFee fundingCost'],
    ['api-server/src/services/paper-trading-position.service.ts', 'entryFeeAllocation exitFee entrySlippageAllocation exitSlippage funding netPnl: netForJournal'],
    ['.github/workflows/prediction-lab-settlement-profitability-evidence-gate.yml', 'settlement profit'],
    ['.github/workflows/public-forward-liquidity-calibration-oos-validation.yml', 'OOS'],
    ['.github/workflows/prediction-lab-final-holdout.yml', 'holdout OOS'],
  ]);
  for (const id of ['CG011', 'CG013']) assert.equal(evaluateEdge(files, DEFAULT_EDGES.find(edge => edge.id === id)).status, 'PARTIAL', id);
});

test('every Scanner market requires canonical server identity and Paper consumer beyond a UI button', () => {
  for (const id of ['CG003', 'CG004', 'CG005', 'CG006']) {
    const edge = DEFAULT_EDGES.find(item => item.id === id);
    const files = new Map(edge.required.flatMap(probe => (probe.paths ?? []).map(file => [file, [...(probe.allOf ?? []), ...(probe.anyOf ?? [])].join(' ')])));
    files.set('api-server/src/routes/trade-automation.ts', "router.post('/scanner/plans' assertPaperApprovalEnvelope accountMode paper");
    const result = evaluateEdge(files, edge);
    assert.notEqual(result.status, 'PROVEN', id);
    assert.equal(result.required.find(probe => probe.id === 'scanner-canonical-paper-server-consumer').state, 'MISSING', id);
  }
});

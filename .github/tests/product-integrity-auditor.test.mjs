import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_LEVEL,
  INTEGRITY_STATUS,
  buildErrorLedger,
  evaluateCapability,
  evaluateIdentityContract,
  evaluateJourney,
  findOrphanPages,
  renderProductIntegrityMarkdown,
} from '../scripts/product-integrity-auditor.mjs';

test('static capability proof never upgrades itself to runtime or E2E proof', () => {
  const files = new Map([['feature.ts', 'export const feature = true;']]);
  const result = evaluateCapability(files, {
    id: 'CAP',
    name: 'Feature',
    severity: 'P1',
    presence: [{ id: 'present', paths: ['feature.ts'] }],
  });
  assert.equal(result.status, INTEGRITY_STATUS.PROVEN);
  assert.equal(result.evidenceLevel, EVIDENCE_LEVEL.STATIC_PROVEN);
  assert.notEqual(result.evidenceLevel, EVIDENCE_LEVEL.RUNTIME_PROVEN);
  assert.notEqual(result.evidenceLevel, EVIDENCE_LEVEL.E2E_PROVEN);
});

test('contract proof ceiling remains CONTRACT_PROVEN', () => {
  const files = new Map([['feature.ts', 'feature contract token']]);
  const result = evaluateCapability(files, {
    id: 'CAP',
    name: 'Feature',
    severity: 'P1',
    presence: [{ id: 'present', paths: ['feature.ts'] }],
    contracts: [{ id: 'contract', paths: ['feature.ts'], allOf: ['contract', 'token'] }],
  });
  assert.equal(result.status, INTEGRITY_STATUS.PROVEN);
  assert.equal(result.evidenceLevel, EVIDENCE_LEVEL.CONTRACT_PROVEN);
});

test('global capability probe reports readable absence as MISSING', () => {
  const files = new Map([
    ['a.ts', 'alerts notifications'],
    ['b.ts', 'portfolio chart'],
  ]);
  const result = evaluateCapability(files, {
    id: 'TELEGRAM',
    name: 'Telegram',
    severity: 'P2',
    presence: [{ id: 'telegram-token', anyOf: ['telegram', 'Telegram', 'TELEGRAM'] }],
  });
  assert.equal(result.status, INTEGRITY_STATUS.MISSING);
  assert.equal(result.evidenceLevel, EVIDENCE_LEVEL.NOT_PROVEN);
});

test('orphan detector accepts a routed root page and its child page', () => {
  const files = new Map([
    ['stock-analyzer/src/App.tsx', "const Workspace = lazy(() => import('@/pages/workspace'));"],
    ['stock-analyzer/src/pages/workspace.tsx', "import Expert from './expert';"],
    ['stock-analyzer/src/pages/expert.tsx', 'export default function Expert() {}'],
    ['stock-analyzer/src/pages/orphan.tsx', 'export default function Orphan() {}'],
  ]);
  const orphans = findOrphanPages(files);
  assert.deepEqual(orphans.map((item) => item.file), ['stock-analyzer/src/pages/orphan.tsx']);
});

test('identity continuity is PARTIAL when dimensions exist but transport is missing', () => {
  const files = new Map([
    ['source.ts', 'candidateId strategyId parameterHash symbol timeframe side leverage'],
    ['destination.ts', 'candidateId strategyId parameterHash symbol timeframe side leverage'],
    ['transport.ts', 'plain href only'],
  ]);
  const result = evaluateIdentityContract(files, {
    id: 'ID',
    name: 'Same candidate',
    severity: 'P1',
    sourcePaths: ['source.ts'],
    destinationPaths: ['destination.ts'],
    dimensions: ['candidateId', 'strategyId', 'parameterHash', 'symbol', 'timeframe', 'side', 'leverage'],
    transport: { paths: ['transport.ts'], anyOf: ['candidateId', 'URLSearchParams'] },
  });
  assert.equal(result.status, INTEGRITY_STATUS.PARTIAL);
  assert.equal(result.transport.state, 'MISSING');
});

test('golden journey does not claim runtime/E2E/production proof from static edges', () => {
  const graph = {
    edges: [
      { id: 'A', status: 'PROVEN' },
      { id: 'B', status: 'PROVEN' },
    ],
  };
  const result = evaluateJourney(graph, { id: 'GJ', name: 'Journey', edgeIds: ['A', 'B'] });
  assert.equal(result.status, INTEGRITY_STATUS.PROVEN);
  assert.equal(result.evidenceLevel, EVIDENCE_LEVEL.STATIC_PROVEN);
  assert.equal(result.runtimeEvidence, EVIDENCE_LEVEL.NOT_PROVEN);
  assert.equal(result.e2eEvidence, EVIDENCE_LEVEL.NOT_PROVEN);
  assert.equal(result.productionEvidence, EVIDENCE_LEVEL.NOT_PROVEN);
});

test('P1 non-proven graph edges are emitted into the Error Ledger', () => {
  const graph = {
    edges: [
      {
        id: 'CGX', from: 'A', to: 'B', severity: 'P1', status: 'PARTIAL',
        required: [{ id: 'identity', state: 'MISSING' }], blockers: [],
      },
      {
        id: 'CGY', from: 'B', to: 'C', severity: 'P2', status: 'MISSING',
        required: [{ id: 'optional', state: 'MISSING' }], blockers: [],
      },
    ],
  };
  const ledger = buildErrorLedger(graph, [], []);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].id, 'EL-CGX');
  assert.equal(ledger[0].severity, 'P1');
});

test('markdown keeps fail-closed proof boundaries visible', () => {
  const markdown = renderProductIntegrityMarkdown({
    generatedAt: '2026-09-17T00:00:00.000Z',
    counts: {
      capabilityProven: 1, capabilities: 1,
      identityProven: 0, identityContracts: 1,
      goldenJourneyStaticProven: 0, goldenJourneys: 1,
      p0Open: 0, p1Open: 1,
    },
    capabilities: [{ id: 'C', name: 'Cap', severity: 'P1', status: 'PROVEN', evidenceLevel: 'STATIC_PROVEN' }],
    identities: [{ id: 'I', name: 'Identity', status: 'PARTIAL', evidenceLevel: 'NOT_PROVEN' }],
    journeys: [{ id: 'G', name: 'Journey', status: 'PARTIAL', runtimeEvidence: 'NOT_PROVEN', e2eEvidence: 'NOT_PROVEN', productionEvidence: 'NOT_PROVEN' }],
    orphanPages: [],
    errorLedger: [{ id: 'EL-I', severity: 'P1', area: 'Identity', status: 'PARTIAL', evidenceLevel: 'NOT_PROVEN', reason: 'transport:MISSING' }],
  });
  assert.match(markdown, /MISSING != ZERO/u);
  assert.match(markdown, /UNKNOWN != SUCCESS/u);
  assert.match(markdown, /not runtime, E2E, staging, production, or profitability proof/u);
});

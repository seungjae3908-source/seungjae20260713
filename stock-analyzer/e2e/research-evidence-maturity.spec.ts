import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  FULL_COST_KEYS,
  buildFullCostRows,
  classifySha,
  isFullCostReady,
  mapResearchProductStatus,
  metricAvailability,
} from '../src/lib/research-center-product';
import {
  RESEARCH_CENTER_READONLY_CONTRACT,
  sanitizeResearchCenterOverview,
} from '../../api-server/src/services/research-center-readonly-contract.service';

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

test('Research Center V2 source preserves the complete fail-closed maturity ladder', () => {
  const analyzer = analyzerDirectory();
  const product = fs.readFileSync(path.join(analyzer, 'src/lib/research-center-product.ts'), 'utf8');
  const page = fs.readFileSync(path.join(analyzer, 'src/pages/research-center.tsx'), 'utf8');
  const api = fs.readFileSync(path.resolve(analyzer, '../api-server/src/services/research-center-readonly-contract.service.ts'), 'utf8');
  const adminRoute = fs.readFileSync(path.resolve(analyzer, '../api-server/src/routes/admin.ts'), 'utf8');

  const orderedStages = [
    'external,',
    "promotionStageCard(promotion, 'backtest'",
    "promotionStageCard(promotion, 'oos'",
    "promotionStageCard(promotion, 'purged-walk-forward'",
    "promotionStageCard(promotion, 'final-holdout'",
    'shadowCard,',
    'paperCard,',
    'settlementCard,',
    "key: 'profitability'",
    "key: 'strategy-health'",
    "key: 'promotion'",
    "key: 'champion'",
  ];
  const pipelineBuilder = product.indexOf('export function buildResearchPipeline');
  let previous = product.indexOf('return [', pipelineBuilder);
  for (const key of orderedStages) {
    const index = product.indexOf(key, previous + 1);
    expect(index, `${key} should exist in pipeline order`).toBeGreaterThan(previous);
    previous = index;
  }

  for (const key of ['commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact']) {
    expect(product).toContain(`'${key}'`);
  }
  for (const tab of ['연구 현황', 'AI 분석실', '검증 리포트', '모의매매']) expect(page).toContain(`label: '${tab}'`);

  expect(product).toContain("return value === 0 ? 'ZERO_MEASURED' : 'PRESENT'");
  expect(product).toContain("'현재 검증된 Champion 없음'");
  expect(product).toContain("? 'WRONG_SHA'");
  expect(product).toContain("if (evidence?.fullCostReady !== true) return false");
  expect(page).toContain('unavailable 비용을 0으로 바꾸지 않습니다');
  expect(page).toContain('아직 검증되지 않음');
  expect(page).toContain('실주문 비활성');
  expect(page).toContain('LIVE_TRADING=false');
  expect(page).toContain('executionAuthority=NONE');
  expect(page).toContain('data-testid="paper-candidate-performance"');
  expect(page).toContain('candidateMatchedN');
  expect(page).toContain('effective independent N');
  expect(page).toContain("const factory = overview.factory;");
  expect(page).toContain("const liquidity = overview.research.liquidityIndependence;");
  expect(page).toContain('label="Research runtime SHA" value={runtimeSha}');
  expect(page).toContain('label="Workflow run ID" value={liquidity?.upstreamIngestRunId');
  expect(page).toContain('label="Artifact ID" value={liquidity?.upstreamIngestArtifactId');
  expect(page).toContain('label="Canonical receipt" value={liquidity?.reportDigest');
  expect(page).toContain('label="Research SHA binding" value={researchShaBinding}');
  expect(page).toContain('label="FIRST_ZERO" value={firstZero}');
  expect(page).not.toContain('label="FIRST_ZERO" value="미수집"');
  expect(page).toContain('UNKNOWN/BLOCKED');
  expect(page).toContain('TRAIN_DIAGNOSTIC_ONLY=');
  expect(page).toContain('NET_ALPHA_PROVEN=');
  expect(page).toContain('후보 증거가 없으면 일반 Paper ledger 수를 빌려오지 않습니다');
  expect(api).toContain('sanitizeCandidatePerformance');
  expect(page).not.toContain("label: '한눈에 보기'");
  expect(page).not.toContain("label: 'AI 토론'");
  expect(page).not.toContain("label: '상세 증거'");

  expect(api).toContain('Unknown upstream fields are intentionally dropped');
  expect(api).toContain("methods: Object.freeze(['GET'])");
  expect(api).toContain("executionAuthority: 'NONE'");
  expect(api).not.toContain('...payload');
  expect(adminRoute).toContain('router.use(requireAuthenticated, requireAdmin)');
  expect(adminRoute).toContain("router.get('/research/overview'");
  expect(adminRoute).not.toMatch(/router\.(?:post|put|patch|delete)\('\/research\/overview'/);
});

test('CASE F Full Cost complete requires eight explicit canonical components', () => {
  const components = Object.fromEntries(FULL_COST_KEYS.map((key) => [key, {
    status: 'PRESENT',
    valuePercent: key === 'tax' ? 0 : 0.01,
    quality: key === 'tax' ? 'NOT_APPLICABLE' : 'OBSERVED',
  }]));
  const evidence = { fullCostReady: true, components };
  expect(buildFullCostRows(evidence)).toHaveLength(8);
  expect(isFullCostReady(evidence)).toBe(true);
  expect(metricAvailability(null)).toBe('MISSING');
  expect(metricAvailability(0)).toBe('ZERO_MEASURED');
  expect(mapResearchProductStatus('STALE')).toBe('stale');
  expect(classifySha('1'.repeat(40), '2'.repeat(40))).toBe('WRONG_SHA');

  const independentStates = {
    fullCostReady: false,
    components: Object.fromEntries(FULL_COST_KEYS.map((key, index) => [key, {
      state: index === 0 ? 'MEASURED' : index === 1 ? 'MODELED' : index === 2 ? 'BLOCKED_DATA' : 'UNKNOWN',
      valuePercent: index < 2 ? 0.01 : null,
      provenance: index < 2 ? 'canonical-cost-owner-v1' : null,
    }])),
  };
  const rows = buildFullCostRows(independentStates);
  expect(rows[0]?.state).toBe('measured');
  expect(rows[1]?.state).toBe('modeled');
  expect(rows[2]?.state).toBe('insufficient');
  expect(rows[3]?.state).toBe('unmeasured');
  expect(isFullCostReady(independentStates)).toBe(false);
});

test('read-only Research API allowlist drops private fields and rejects invalid evidence', () => {
  const overview = {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: 1_800_000_000_000,
    state: { present: true, latestCycleAt: 1_799_999_999_000 },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: true,
      forbiddenAuthorityObserved: false,
    },
    research: {
      status: 'collecting',
      failedTasks: 0,
      blockedDataTasks: 0,
      cycles: [{
        profile: 'forward', present: true, status: 'success', cycleId: 'cycle-1', researchSha: '1'.repeat(40),
        generatedAt: 1_799_999_999_000, concurrency: 1, taskCount: 1, successCount: 1, blockedDataCount: 0, failedCount: 0,
        tasks: [{ id: 'canonical-task', status: 'success', durationMs: 15, startedAt: null, endedAt: null, timedOut: false }],
      }],
    },
    paper: {
      runtime: {
        present: true, status: 'not_started', cycleId: null, scheduleActive: false, allProvidersReady: null,
        publicForwardEvidenceAccumulating: null, paperTradeOutcomeAccumulating: null,
        privateRequestCount: 0, financialMutationCount: 0, orderCount: 0,
        liveTrading: false, orderAuthority: false, safetyEvidenceComplete: true, lanes: [],
      },
      ledger: { present: true, cycleCount: 1, sampleCount: 0, positionCount: 0, settlementCount: 0 },
    },
    shadow: { groups: [], records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null } },
    profitability: { proven: false, status: 'evidence_collection', note: 'Evidence only.' },
    accessToken: 'ghp_should-never-leak',
    stateRoot: '/var/lib/private-research',
    accountId: 'private-account-id',
  };
  const sanitized = sanitizeResearchCenterOverview(overview);
  expect(sanitized).not.toBeNull();
  const serialized = JSON.stringify(sanitized);
  expect(serialized).not.toContain('ghp_should-never-leak');
  expect(serialized).not.toContain('/var/lib/private-research');
  expect(serialized).not.toContain('private-account-id');
  expect(RESEARCH_CENTER_READONLY_CONTRACT.methods).toEqual(['GET']);
  expect(RESEARCH_CENTER_READONLY_CONTRACT.executionAuthority).toBe('NONE');

  const candidate = (sanitized?.paper as { candidatePerformance: { status: string; candidateMatchedN: number | null } }).candidatePerformance;
  expect(candidate.status).toBe('MISSING');
  expect(candidate.candidateMatchedN).toBeNull();

  expect(sanitizeResearchCenterOverview({ ...overview, safety: { ...overview.safety, liveTrading: true } })).toBeNull();
  const malformedSha = structuredClone(overview);
  malformedSha.research.cycles[0]!.researchSha = 'wrong-sha';
  expect(sanitizeResearchCenterOverview(malformedSha)).toBeNull();
});

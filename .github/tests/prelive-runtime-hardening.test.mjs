import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('pre-live gates use exact Required CI and a real workflow_dispatch Production deploy', async () => {
  const pre = await read('.github/scripts/production-preactivation-prerequisites.cjs');
  const automatic = await read('.github/workflows/production-automatic-trading-gate.yml');
  const spot = await read('.github/workflows/production-live-trading-gate.yml');
  const futures = await read('.github/workflows/production-futures-live-trading-gate.yml');

  assert.match(pre, /evaluateProductionCiProvenance/);
  assert.match(pre, /run[.]event === 'workflow_dispatch'/);
  assert.match(pre, /run[.]path === '[.]github\/workflows\/production-deploy[.]yml'/);
  assert.match(automatic, /const ciRunId = release[.]requiredCiRunId/);
  assert.match(automatic, /const productionCompletedAt = Date[.]parse\(release[.]productionDeployCompletedAt\)/);
  assert.doesNotMatch(automatic, /const ciRunId = release[.]postMergeProvenanceRunId/);
  assert.match(spot, /required_ci_run_id/);
  assert.match(futures, /required_ci_run_id/);
});

test('Paper activation commands route through the current rollover release-control issue', async () => {
  const paper = await read('.github/workflows/paper-forward-schedule-no-deploy-activation.yml');
  const natural = await read('.github/workflows/natural-paper-outcome-schedule-activation.yml');
  const diagnostics = await read('.github/workflows/paper-forward-no-deploy-readonly-diagnostics.yml');
  for (const source of [paper, natural, diagnostics]) {
    assert.match(source, /github[.]event[.]issue[.]number == 1555/);
    assert.match(source, /Staging Readiness Control — Rollover 2026-10-02/);
    assert.doesNotMatch(source, /github[.]event[.]issue[.]number == 23/);
  }
  assert.match(paper, /PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH/);
  assert.match(paper, /RESEARCH_SUPPLEMENTAL_COST_EVIDENCE_MISSING/);
  assert.doesNotMatch(paper, /issue_number:\s*23/u);
  assert.doesNotMatch(diagnostics, /issue_number:\s*23/u);
});

test('Research Production activation includes core, AI review, and video discovery timers without live authority', async () => {
  const activation = await read('research-production/deploy/activate-server.sh');
  for (const timer of [
    'research-production-fast-historical.timer',
    'research-production-long-history.timer',
    'research-production-forward.timer',
    'research-production-ai-review.timer',
    'research-production-video-discovery.timer',
  ]) assert.match(activation, new RegExp(timer.replaceAll('.', '[.]')));
  assert.match(activation, /install-ai-research-units[.]sh/);
  assert.match(activation, /systemctl start research-production-ai-review[.]service/);
  assert.match(activation, /RESEARCH_AI_PROVIDER_NOT_READY/);
  assert.doesNotMatch(activation, /LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true/);
});

test('Backtester UI and API share the same 7x futures leverage cap', async () => {
  const panel = await read('stock-analyzer/src/components/backtest-research-panel.tsx');
  const engine = await read('api-server/src/services/backtest-engine.service.ts');
  assert.match(panel, /label="레버리지"[\s\S]{0,300}max="7"/u);
  assert.doesNotMatch(panel, /label="레버리지"[\s\S]{0,300}max="10"/u);
  assert.match(engine, /maximumLeverage: 7/);
});

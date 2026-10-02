import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../api-server/node_modules/esbuild/lib/main.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

test('rendered Paper/Research references preserve identity and grant no execution or evidence credit', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paper-reference-ui-'));
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  try {
    const outfile = path.join(directory, 'render.cjs');
    await build({
      stdin: { contents: `
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Router } from 'wouter';
        import { BacktestPaperCandidatePreview } from './src/components/backtest-paper-candidate-preview';
        import { ResearchSameCandidatePreview } from './src/components/research-same-candidate-preview';
        import { validResearchSameCandidate } from './src/lib/research-same-candidate';
        export const render = (imported) => renderToStaticMarkup(<Router ssrPath="/paper-trading"><BacktestPaperCandidatePreview imported={imported} /></Router>);
        export const renderResearch = (result) => renderToStaticMarkup(<ResearchSameCandidatePreview result={result} />);
        export { validResearchSameCandidate };
      `, loader: 'tsx', resolveDir: path.resolve('stock-analyzer') },
      outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node20',
    });
    const { render, renderResearch, validResearchSameCandidate } = createRequire(import.meta.url)(outfile);
    const invalid = render({ active: true, handoff: null, error: 'INVALID_BACKTEST_PAPER_HANDOFF' });
    assert.match(invalid, /INVALID_BACKTEST_PAPER_HANDOFF/u);
    assert.doesNotMatch(invalid, /paper-order-form|BTCUSDT|모의주문/u);
    const missing = render({ active: true, error: null, handoff: {
      candidateId: null, strategyId: null, parameterHash: null, market: 'CRYPTO_FUTURES', symbol: 'ETHUSDT',
      timeframe: null, side: null, leverage: null, riskPolicyRef: null, costPolicyRef: null, exitPolicyRef: null,
      blockers: ['CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE'],
    } });
    for (const field of ['candidateId', 'strategyId', 'parameterHash', 'timeframe', 'side', 'leverage']) {
      assert.match(missing, new RegExp(`data-testid="paper-candidate-${field}">MISSING<`, 'u'));
    }
    assert.match(missing, /REFERENCE_ONLY/u); assert.match(missing, /evidenceCredit=0/u);
    assert.match(missing, /ETHUSDT/u); assert.doesNotMatch(missing, /paper-order-form|BTCUSDT/u);
    await t.test('Research readback rejects another artifact, strategy, stage status or authority', () => {
      const bundle = {
        publicationStatus: 'READBACK_VERIFIED', backtestCompleted: true, bundleDigest: 'a'.repeat(64),
        resultArtifactDigest: 'b'.repeat(64), strategyIdentityDigest: 'c'.repeat(64), modelIdentityDigest: 'd'.repeat(64), featureOrderDigest: 'e'.repeat(64),
        receipt: { datasetIdentity: 'public-dataset', datasetDigest: 'f'.repeat(64), preprocessingVersion: 'v1', riskPolicyId: 'risk-v1', riskPolicyVersion: 'v1', costPolicyIdentity: 'cost-v1', researchCodeSha: '1'.repeat(40) },
      };
      const waiting = {
        schemaVersion: 'research-same-candidate-prewire-v1', status: 'PREWIRED_WAITING_EVIDENCE',
        identityAnchor: { identityAnchorSchemaVersion: 'research-same-candidate-identity-anchor-v1', researchBundleDigest: bundle.bundleDigest,
          resultArtifactDigest: bundle.resultArtifactDigest, strategyIdentityDigest: bundle.strategyIdentityDigest, modelIdentityDigest: bundle.modelIdentityDigest,
          featureOrderDigest: bundle.featureOrderDigest, ...bundle.receipt }, identityAnchorDigest: '2'.repeat(64),
        stages: Object.fromEntries(['FORWARD', 'SHADOW', 'PAPER', 'SETTLEMENT'].map(stage => [stage, { stage, status: 'MISSING_EVIDENCE', matched: false, blockers: [`${stage}_RUNTIME_EVIDENCE_MISSING`] }])),
        allIdentityStagesMatched: false, blockers: ['PAPER_RUNTIME_EVIDENCE_MISSING'], evidenceCredit: 0, profitabilityProven: false, champion: null,
        executionAuthority: 'NONE', liveTrading: false, privateTradingApiAllowed: false, orderSubmitted: false, productionMutationAllowed: false,
      };
      assert.equal(validResearchSameCandidate(waiting, bundle), true);
      for (const key of ['resultArtifactDigest', 'strategyIdentityDigest', 'datasetIdentity', 'researchCodeSha']) {
        assert.equal(validResearchSameCandidate({ ...waiting, identityAnchor: { ...waiting.identityAnchor, [key]: 'wrong' } }, bundle), false, key);
      }
      for (const [key, value] of [['evidenceCredit', 1], ['evidenceCredit', '0'], ['executionAuthority', 'ORDER'], ['privateTradingApiAllowed', true], ['profitabilityProven', true], ['allIdentityStagesMatched', true], ['status', 'PREWIRED_IDENTITY_MATCHED']]) {
        assert.equal(validResearchSameCandidate({ ...waiting, [key]: value }, bundle), false, key);
      }
      assert.equal(validResearchSameCandidate({ ...waiting, stages: { ...waiting.stages, PAPER: { ...waiting.stages.PAPER, matched: true } } }, bundle), false);
      const blocked = { ...waiting, identityAnchor: null, identityAnchorDigest: null, status: 'BLOCKED_DATA' };
      assert.equal(validResearchSameCandidate(blocked, bundle), true);
      assert.equal(validResearchSameCandidate({ ...blocked, stages: { ...blocked.stages, PAPER: { stage: 'PAPER', matched: true, status: 'IDENTITY_MATCHED', blockers: [] } } }, bundle), false);
      const html = renderResearch(waiting);
      assert.match(html, /PREWIRED_WAITING_EVIDENCE/u); assert.match(html, /PAPER_RUNTIME_EVIDENCE_MISSING/u);
      assert.match(html, /evidenceCredit=0/u); assert.match(html, /executionAuthority=NONE/u);
      assert.doesNotMatch(html, /<button|paper-order-form|BTCUSDT/u);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

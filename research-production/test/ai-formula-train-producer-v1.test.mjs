import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compiledMomentumFormula, compiledFuturesMomentumFormula } from '../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import {
  ingestFormulaProducedTrainInputsV1,
  processFormulaAutoBacktestQueueV1,
} from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import { RESEARCH_AI_WORKER_SAFETY } from '../src/research-ai-review-worker.mjs';
import {
  AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1,
  AI_FORMULA_TRAIN_FEEDBACK_CONTRACT_V1,
  buildAiFormulaTrainFeedbackV1,
  digestAiFormulaTrainValueV1,
  prepareAiFormulaTrainProposalsV1,
} from '../src/ai-formula-train-producer-v1.mjs';

const SHA = 'a'.repeat(40);
const EVIDENCE = 'b'.repeat(64);
const NOW = Date.UTC(2026, 9, 12, 10, 23);
const AI_ID = 'ResearchRvolA';

function ai({role = 'PROPOSER', disposition = 'RESEARCH_PROPOSAL_ONLY'} = {}) {
  return {
    schemaVersion: 'research-production-ai-review-v1',
    status: 'READY', observedAt: NOW - 60_000, researchSha: SHA,
    profile: role === 'PROPOSER' ? 'fast-historical' : 'forward',
    sourceCycleId: 'real-cycle-exact-sha',
    evidenceDigest: EVIDENCE, provider: 'gemini', model: 'gemini-3.1-flash-lite',
    role, evidenceCredit: 0, profitabilityProven: false, champion: null,
    safety: RESEARCH_AI_WORKER_SAFETY,
    review: {
      summary: 'Hypothesis for safe research only.', findings: ['Data gaps remain unknown'],
      hypotheses: [{
        hypothesisId: AI_ID, thesis: 'Test a bounded volume-momentum hypothesis',
        requiredEvidence: ['TRAIN original bars with provenance'],
        falsification: 'Reject if independent evaluation does not survive',
        intendedRegime: 'trend', independenceRationale: 'Existing findings require new data',
      }],
      risks: ['Independent holdout not yet tested'], disposition,
    },
  };
}

function rows() {
  const base = Date.UTC(2020, 0, 1);
  return Array.from({ length: 180 }, (_, i) => {
    const mid = 100 + 0.08 * i + 1.5 * Math.sin(i / 5);
    return {
      timestamp: base + i * 15 * 60_000,
      open: mid, high: mid + 1.2, low: mid - 1,
      close: mid + (i % 7 === 0 ? 0.8 : 0.2),
      volume: i % 12 === 0 ? 2600 : 1000 + (i % 10) * 20,
    };
  });
}

function binding({ formula = compiledMomentumFormula().formula, candles = rows() } = {}) {
  return {
    aiHypothesisId: AI_ID,
    reviewEvidenceDigest: EVIDENCE,
    sourceCycleId: 'real-cycle-exact-sha',
    formulaCandidate: formula,
    dataset: {
      datasetIdentity: formula.provenance.datasetIdentity,
      datasetRole: 'TRAIN',
      market: formula.market, timeframe: formula.timeframe, direction: formula.direction,
      candleCount: candles.length,
      availableFields: [...formula.availableDataFields],
      backtestInput: {
        market: formula.market, symbol: formula.market === 'US_STOCK' ? 'AAPL' : 'BTCUSDT',
        timeframe: formula.timeframe,
        side: formula.direction === 'SHORT' ? 'short' : 'long',
        candles, initialCapital: 10_000,
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
        costModel: {
          entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0,
          slippageRate: 0.0005, spreadRate: 0.0002,
          latencyBars: 0, latencyDriftRate: 0,
        },
      },
      period: {
        startTime: candles[0].timestamp,
        endTime: candles.at(-1).timestamp,
        includeFinalHoldout: false,
      },
    },
  };
}

function sourceVerifier(args) {
  return {
    status: 'VERIFIED_TRAIN_SOURCE',
    researchSha: args.researchSha,
    aiEvidenceDigest: args.aiEvidenceDigest,
    hypothesisId: args.hypothesisId,
    datasetIdentity: args.dataset.datasetIdentity,
    datasetDigest: args.datasetDigest,
    datasetRole: 'TRAIN',
    reviewIdentityDigest: args.reviewIdentityDigest,
    reviewedAssociationDigest: args.reviewedAssociationDigest,
    formulaCandidateId: args.formulaCandidate.candidateId,
    formulaHash: args.formulaCandidate.formulaHash,
    formulaReviewedForAiHypothesis: true,
    sourceRightsVerified: true,
    sourceProvenanceVerified: true,
    observedAtMs: NOW - 120_000,
  };
}

function options(extra = {}) {
  return {
    researchSha: SHA, aiReviewArtifact: ai(), approvedBindings: [binding()],
    verifyOriginalSource: sourceVerifier, now: NOW, ...extra,
  };
}

async function inTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-train-seam-'));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('valid independent PROPOSER evidence produces bounded, zero-authority TRAIN previews with zero filesystem writes', async () => {
  const result = await prepareAiFormulaTrainProposalsV1(options());
  assert.equal(result.contract, AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1);
  assert.equal(result.aiRole, 'PROPOSER');
  assert.equal(result.eligibleForTrainCount, 1);
  assert.equal(result.staged, 0);
  assert.equal(result.proposals[0].state, 'READY_TRAIN_ONLY');
  assert.match(result.proposals[0].itemDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.readOnlyPreview, true);
  for (const key of ['externalSourceIndependentlyAttested', 'independentOosVerified',
    'fullCostVerified', 'profitabilityProven', 'paperDispatchAllowed', 'realOrderAllowed',
    'privateTradingApiAllowed']) assert.equal(result[key], false, key);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.requiresReviewedSourceCallback, true);
});

test('approved 1-candidate bounded TRAIN producer feeds existing canonical queue, then remains HOLD without OOS and cannot order', async () => inTemp(async root => {
  const args = options({
    stage: true, stateRoot: root,
    env: { RESEARCH_AI_FORMULA_TRAIN_STAGE_ENABLED: 'true' },
  });
  const first = await prepareAiFormulaTrainProposalsV1(args);
  assert.equal(first.proposals[0].state, 'STAGED_TRAIN_ONLY');
  const outbox = join(root, 'formula-backtest', 'producer-outbox');
  const names = await readdir(outbox);
  assert.equal(names.length, 1);
  assert.equal(names[0], first.proposals[0].itemDigest + '.json');
  const recorded = JSON.parse(await readFile(join(outbox, names[0]), 'utf8'));
  assert.equal(recorded.itemDigest, first.proposals[0].itemDigest);
  assert.equal(recorded.researchCodeSha, SHA);
  assert.equal((await lstat(join(outbox, names[0]))).mode & 0o077, 0);
  const again = await prepareAiFormulaTrainProposalsV1({ ...args, now: NOW + 2 * 60_000 });
  assert.equal(again.proposals[0].state, 'ALREADY_STAGED_TRAIN_ONLY');
  assert.equal(again.proposals[0].itemDigest, first.proposals[0].itemDigest);
  assert.equal((await readdir(outbox)).length, 1);

  const imported = await ingestFormulaProducedTrainInputsV1({ stateRoot: root, researchCodeSha: SHA });
  assert.equal(imported.imported, 1);
  assert.equal(imported.upstreamPublicDataAttested, false);
  assert.equal(imported.paperDispatchAllowed, false);

  const summary = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha: SHA });
  assert.equal(summary.inboxCount, 1);
  assert.equal(summary.counts.PASS, 0);
  assert.equal(summary.counts.HOLD, 1);
  assert.equal(summary.paperRegisteredCount, 0);
  assert.equal(summary.executionAuthority, 'NONE');
  assert.equal(summary.genuineResearchProducerVerified, false);
  assert.equal(summary.automationReadiness, 'BLOCKED_DATA_OOS_NOT_ATTESTED');
  const feedback = buildAiFormulaTrainFeedbackV1({ researchSha: SHA, queueSummary: summary });
  assert.equal(feedback.contract, AI_FORMULA_TRAIN_FEEDBACK_CONTRACT_V1);
  assert.equal(feedback.rows[0].state, 'HOLD');
  assert.equal(feedback.automaticPromotion, false);
  assert.equal(feedback.automaticFormulaMutation, false);
  assert.equal(feedback.executionAuthority, 'NONE');
}));

test('the first real activated forward CRITIC does not mint formulas; no data binding is not a success', async () => {
  const critic = await prepareAiFormulaTrainProposalsV1(options({ aiReviewArtifact: ai({ role: 'CRITIC' }) }));
  assert.equal(critic.eligibleForTrainCount, 0);
  assert.equal(critic.proposals[0].state, 'HOLD_REVIEW_ONLY');
  const noData = await prepareAiFormulaTrainProposalsV1(options({ approvedBindings: [] }));
  assert.equal(noData.eligibleForTrainCount, 0);
  assert.equal(noData.proposals[0].state, 'HOLD_NO_APPROVED_FORMULA_OR_TRAIN_DATA');
  const noAuthority = await prepareAiFormulaTrainProposalsV1(options({ verifyOriginalSource: null }));
  assert.equal(noAuthority.proposals[0].state, 'HOLD_ORIGINAL_DATA_UNVERIFIED');
  const needsReview = await prepareAiFormulaTrainProposalsV1(options({ aiReviewArtifact: ai({ disposition: 'NEEDS_REVIEW' }) }));
  assert.equal(needsReview.eligibleForTrainCount, 0);
});

test('no staging without explicit operator gate and protected app roots cannot be used as an outbox', async () => inTemp(async root => {
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({
    stage: true, stateRoot: root, env: {},
  })), /AI_FORMULA_STAGING_DISABLED/u);
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({
    stage: true, stateRoot: '/var/lib/stock-app/formula',
    env: { RESEARCH_AI_FORMULA_TRAIN_STAGE_ENABLED: 'true' },
  })), /AI_FORMULA_APP_STORAGE_FORBIDDEN/u);
}));

test('rejects forged AI authority, mismatched SHA, fake binding, future bars, and untrusted OOS payload', async () => {
  const forged = ai(); forged.safety = { ...forged.safety, executionAuthority: 'LIVE' };
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ aiReviewArtifact: forged })), /AI_FORMULA_REVIEW_PROOF_INVALID/u);
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ researchSha: 'c'.repeat(40) })), /AI_FORMULA_REVIEW_PROOF_INVALID/u);
  const crossed = binding(); crossed.reviewEvidenceDigest = 'c'.repeat(64);
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ approvedBindings: [crossed] })), /AI_FORMULA_BINDING_INVALID/u);
  const fake = binding(); fake.formulaCandidate = { ...fake.formulaCandidate, formulaHash: '0'.repeat(64) };
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ approvedBindings: [fake] })), /FORMULA_HASH_MISMATCH/u);
  const future = rows(); future[future.length - 1] = { ...future.at(-1), timestamp: NOW + 86_400_000 };
  const futureBinding = binding({ candles: future });
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ approvedBindings: [futureBinding] })), /FORMULA_QUEUE_PERIOD_INVALID_OR_FUTURE|FORMULA_QUEUE_CANDLE_TIME_INVALID_OR_FUTURE/u);
  const leaked = binding(); leaked.dataset.stageEvidence = { oos: { status: 'PASS' } };
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({ approvedBindings: [leaked] })), /FORMULA_QUEUE_UNATTESTED_STAGE_EVIDENCE_FORBIDDEN/u);
});

test('rejects unverified source digest, out-of-window proof, duplicate identities and invalid source rights', async () => {
  for (const override of [
    { datasetDigest: '0'.repeat(64) },
    { observedAtMs: NOW + 86_400_000 },
    { observedAtMs: NOW - 1000 }, // source fetched after AI review: future-looking association
    { formulaCandidateId: 'not-the-reviewed-formula' },
    { formulaHash: 'c'.repeat(64) },
    { reviewedAssociationDigest: 'c'.repeat(64) },
    { formulaReviewedForAiHypothesis: false },
    { reviewIdentityDigest: 'c'.repeat(64) },
    { sourceRightsVerified: false }
    { sourceProvenanceVerified: false },
    { datasetRole: 'OOS' },
    { researchSha: 'e'.repeat(40) },
  ]) {
    const result = await prepareAiFormulaTrainProposalsV1(options({
      verifyOriginalSource: async args => ({ ...sourceVerifier(args), ...override }),
    }));
    assert.equal(result.proposals[0].state, 'HOLD_ORIGINAL_DATA_UNVERIFIED');
  }
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({
    approvedBindings: [binding(), binding()],
  })), /AI_FORMULA_DIRECTION_OR_DUPLICATE_INVALID/u);
});

test('retains futures SHORT-only market policy without introducing stock/spot SHORT authority', async () => {
  const future = compiledFuturesMomentumFormula({ direction: 'SHORT' }).formula;
  const result = await prepareAiFormulaTrainProposalsV1(options({
    approvedBindings: [binding({ formula: future })],
  }));
  assert.equal(result.eligibleForTrainCount, 1);
  assert.equal(result.proposals[0].state, 'READY_TRAIN_ONLY');
  const fakeStockShort = binding({ formula: future });
  fakeStockShort.formulaCandidate = { ...future, market: 'US_STOCK' };
  await assert.rejects(prepareAiFormulaTrainProposalsV1(options({
    approvedBindings: [fakeStockShort],
  })), /FORMULA_HASH_MISMATCH|STRATEGY_DIRECTION_MARKET_INCOMPATIBLE/u);
});

test('symlinked producer directory remains a hard safety error, and failure does not write any queue item', async () => inTemp(async root => {
  const parent = join(root, 'formula-backtest');
  const external = await mkdtemp(join(tmpdir(), 'research-ai-seam-external-'));
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(parent, { mode: 0o700 }));
    await symlink(external, join(parent, 'producer-outbox'), 'dir');
    await assert.rejects(prepareAiFormulaTrainProposalsV1(options({
      stage: true, stateRoot: root,
      env: { RESEARCH_AI_FORMULA_TRAIN_STAGE_ENABLED: 'true' },
    })), /AI_FORMULA_PRIVATE_DIRECTORY_UNSAFE/u);
    assert.equal((await readdir(external)).length, 0);
  } finally { await rm(external, { recursive: true, force: true }); }
}));

test('TRAIN-only feedback cannot be transformed into automatic promotions or forged PASS', () => {
  const itemDigest = digestAiFormulaTrainValueV1({ test: 'bounded' });
  const summary = {
    contract: 'research-formula-auto-backtest-summary/v1',
    executionAuthority: 'NONE', liveTrading: false, autoTrading: false, realOrder: false,
    paperOrderAuthorityGranted: false, canonicalFutureSignalVerified: false,
    oosAndSettlementVerified: false, paperRegisteredCount: 0, counts: { PASS: 0 },
    rows: [{ itemDigest, state: 'RESERVE', blockers: ['MISSING_CANONICAL_CALLBACK'] }],
  };
  const fb = buildAiFormulaTrainFeedbackV1({ researchSha: SHA, queueSummary: summary });
  assert.equal(fb.rows[0].nextStep, 'REVIEW_RESEARCH_HYPOTHESIS');
  assert.equal(fb.adviceOnly, true);
  assert.equal(fb.orderAuthority, false);
  assert.throws(() => buildAiFormulaTrainFeedbackV1({
    researchSha: SHA, queueSummary: { ...summary, paperOrderAuthorityGranted: true },
  }), /AI_FORMULA_FEEDBACK_UNTRUSTED/u);
  assert.throws(() => buildAiFormulaTrainFeedbackV1({
    researchSha: SHA, queueSummary: { ...summary, rows: [{ itemDigest, state: 'HOLD', blockers: ['secret=x'] }] },
  }), /AI_FORMULA_FEEDBACK_BLOCKER_INVALID/u);
});

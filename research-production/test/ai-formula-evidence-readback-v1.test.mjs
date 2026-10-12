import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runResearchAiReviewScan } from '../src/research-ai-review-worker.mjs';
import { compiledMomentumFormula } from '../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import { prepareAiFormulaTrainProposalsV1 } from '../src/ai-formula-train-producer-v1.mjs';
import { previewAiFormulaNextIterationV1 } from '../src/ai-formula-iteration-review-v1.mjs';
import {
  AI_FORMULA_READBACK_CONTRACT_V1,
  inspectAiFormulaResearchEvidenceV1,
} from '../src/ai-formula-evidence-readback-v1.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.UTC(2026, 9, 12, 12, 35);
const CYCLE_TIME = NOW - 10 * 60_000;
const SECRET = 'TEST_ONLY_NEVER_STORE_AI_PROVIDER_KEY';

async function privateFolder(root, name) {
  await mkdir(join(root, name), { recursive: true, mode: 0o700 });
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}

function cycle(profile) {
  return {
    schemaVersion: 'research-production-cycle-v1',
    cycleId: 'TEST_ONLY_' + profile,
    profile, researchSha: SHA,
    generatedAt: CYCLE_TIME,
    status: 'complete',
    results: [
      { id: profile + '-first', status: 'success', timedOut: false },
      { id: profile + '-second', status: 'blocked_data', timedOut: false },
    ],
    liveTrading: false, privateApi: false, orderAuthority: false,
  };
}

const REPLY = JSON.stringify({
  summary: 'Research evidence needs verified review.',
  findings: ['Source continuity should be independently checked.'],
  hypotheses: [{
    hypothesisId: 'BoundedVolume',
    thesis: 'A bounded source-aware volume model may be worth researching.',
    requiredEvidence: ['Independent licensed TRAIN bars and verified market membership'],
    falsification: 'Reject if source gaps invalidate the finding.',
    intendedRegime: 'Trends with verified liquidity',
    independenceRationale: 'Holdout is reserved for a separate evaluator.',
  }],
  risks: ['Sources are incomplete until independently verified.'],
  disposition: 'RESEARCH_PROPOSAL_ONLY',
});

async function fixture(profiles, fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-readback-provenance-'));
  try {
    await privateFolder(root, 'latest');
    for (const profile of profiles) await privateJson(join(root, 'latest', profile + '.json'), cycle(profile));
    const input = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA,
      env: {
        RESEARCH_AI_FREE_TIER_CONFIRMED: 'true',
        AI_CHAT_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET,
      },
      verifyGitHead: false,
      preflight: async ({ researchSha }) => ({ researchSha, stateRoot: resolve(root) }),
      invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: REPLY }),
      now: () => NOW,
    };
    const scan = await runResearchAiReviewScan(input);
    return await fn({ root, scan });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function probe(root, extra = {}) {
  return inspectAiFormulaResearchEvidenceV1({ stateRoot: root, researchSha: SHA, now: NOW, ...extra });
}

test('genuine forward-only CRITIC remains WAITING, not self-developing formula readiness', async () => {
  await fixture(['forward'], async ({ root, scan }) => {
    assert.equal(scan.reviews.length, 1);
    assert.equal(scan.reviews[0].role, 'CRITIC');
    const before = await stat(join(root, 'ai-review', 'latest.json'));
    const report = await probe(root);
    assert.equal(report.contract, AI_FORMULA_READBACK_CONTRACT_V1);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].status, 'VERIFIED_AI_REVIEW');
    assert.equal(report.rows[0].role, 'CRITIC');
    assert.equal(report.counts.CRITIC, 1);
    assert.equal(report.counts.PROPOSAL_ONLY, 0);
    assert.equal(report.status, 'WAITING_HISTORICAL_PROPOSER_EVIDENCE');
    assert.equal(report.automaticFormulaGeneration, false);
    assert.equal(report.canonicalFormulaBound, false);
    assert.equal(report.originalTrainSourceVerified, false);
    assert.equal(report.paperAdmissionAllowed, false);
    assert.equal(report.externalProviderCalls, 0);
    assert.equal(report.storageMutationCount, 0);
    assert.equal(report.executionAuthority, 'NONE');
    const after = await stat(join(root, 'ai-review', 'latest.json'));
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual((await readdir(root)).sort(), ['ai-review', 'latest']);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  });
});

test('both historical PROPOSER reviews can be verified against genuine canonical cycles but cannot run formulas without a separately approved source', async () => {
  await fixture(['forward', 'fast-historical', 'long-history'], async ({ root, scan }) => {
    assert.equal(scan.status, 'COMPLETE');
    const report = await probe(root);
    assert.equal(report.counts.CRITIC, 1);
    assert.equal(report.counts.PROPOSER, 2);
    assert.equal(report.counts.PROPOSAL_ONLY, 2);
    assert.equal(report.historicalProposerReady, true);
    assert.equal(report.status, 'REVIEWED_PROPOSAL_AWAITING_APPROVED_FORMULA_AND_TRAIN_SOURCE');
    assert.equal(report.blockerCodes.length, 0);
    assert.equal(report.rows.length, 3);
    assert.equal(report.rows.every((r) => r.status === 'VERIFIED_AI_REVIEW'), true);
    assert.equal(report.originalTrainSourceVerified, false);
    assert.equal(report.independentOosVerified, false);
    assert.equal(report.fullCostVerified, false);
    assert.equal(report.executionAuthority, 'NONE');
  });
});

test('rewritten canonical cycle identity cannot inherit an AI review from the prior immutable cycle', async () => {
  await fixture(['fast-historical'], async ({ root }) => {
    const path = join(root, 'latest', 'fast-historical.json');
    const modified = JSON.parse(await readFile(path, 'utf8'));
    modified.results[0].id = 'different-cycle-task';
    await privateJson(path, modified);
    const report = await probe(root);
    assert.equal(report.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(report.blockerCodes, ['CURRENT_CYCLE_AI_DIGEST_MISMATCH']);
    assert.equal(report.rows[0].status, 'CYCLE_REVIEW_DIGEST_MISMATCH');
    assert.equal(report.counts.PROPOSER, 0);
  });
});

test('AI artifact role, source-cycle identity and pinned model cannot be forged', async () => {
  for (const mutate of [
    (a) => { a.role = 'CRITIC'; },
    (a) => { a.sourceCycleId = 'another-cycle'; },
    (a) => { a.model = 'UNAPPROVED'; },
    (a) => { a.observedAt = CYCLE_TIME - 60_000; },
  ]) {
    await fixture(['fast-historical'], async ({ root, scan }) => {
      const path = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
      const artifact = JSON.parse(await readFile(path, 'utf8'));
      mutate(artifact);
      await privateJson(path, artifact);
      const report = await probe(root);
      assert.equal(report.status, 'BLOCKED_EVIDENCE');
      assert.deepEqual(report.blockerCodes, ['AI_ARTIFACT_PROVENANCE_MISMATCH']);
      assert.equal(report.counts.PROPOSER, 0);
    });
  }
});

test('additional AI authority fails even when scan digest and cycle remain exact', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const path = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    artifact.safety.orderAllowed = true;
    await privateJson(path, artifact);
    const report = await probe(root);
    assert.equal(report.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(report.blockerCodes, ['AI_ARTIFACT_REVIEW_INVALID']);
    assert.equal(report.rows[0].status, 'INVALID_AI_REVIEW');
  });
});

test('symlink source file and malformed provider snapshot fail closed, never following private arbitrary paths', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    await writeFile(latest, '{ "unfinished":', { mode: 0o600 });
    await assert.rejects(probe(root), /AI_FORMULA_READBACK_JSON_INVALID/);
    const copied = JSON.parse(JSON.stringify(scan));
    await privateJson(latest, copied);
    const review = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
    const external = join(root, 'test-secret.txt');
    await writeFile(external, SECRET);
    await unlink(review);
    await symlink(external, review);
    await assert.rejects(probe(root), /AI_FORMULA_READBACK_FILE_UNSAFE|ELOOP/);
  });
});

test('stale-release AI snapshots and outdated historical cycles never appear eligible', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    await privateJson(latest, { ...scan, researchSha: 'b'.repeat(40) });
    const stale = await probe(root);
    assert.equal(stale.scanStatus, 'STALE_RELEASE');
    assert.equal(stale.historicalProposerReady, false);
    assert.deepEqual(stale.blockerCodes, ['AI_SCAN_STALE_RELEASE']);
    await privateJson(latest, scan);
    const c = join(root, 'latest', 'fast-historical.json');
    await privateJson(c, { ...cycle('fast-historical'), researchSha: 'b'.repeat(40) });
    const staleCycle = await probe(root);
    assert.equal(staleCycle.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(staleCycle.blockerCodes, ['CURRENT_CYCLE_STALE_RELEASE']);
  });
});

test('scan duplicate review, unsupported policy and future scan timestamps are strict failures', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    for (const corrupt of [
      { ...scan, reviews: [scan.reviews[0], scan.reviews[0]] },
      { ...scan, safety: { ...scan.safety, paidFallback: true } },
      { ...scan, observedAt: NOW + 60_000 },
      { ...scan, evidenceCredit: 1 },
    ]) {
      await privateJson(latest, corrupt);
      await assert.rejects(probe(root), /AI_FORMULA_READBACK_SCAN_REVIEW_INVALID|AI_FORMULA_READBACK_SCAN_INVALID/);
    }
  });
});

test('missing AI scan produces bounded truthful blocker and never writes a new directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-readback-missing-'));
  try {
    const report = await probe(root);
    assert.equal(report.scanStatus, 'MISSING');
    assert.equal(report.historicalProposerReady, false);
    assert.deepEqual(report.blockerCodes, ['AI_SCAN_NOT_YET_RECORDED']);
    assert.equal(report.storageMutationCount, 0);
    assert.equal((await readdir(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private app storage and malformed SHA are refused before reading any files', async () => {
  await assert.rejects(probe('/var/lib/stock-app/data'), /AI_FORMULA_READBACK_APP_STORAGE_FORBIDDEN/);
  await assert.rejects(probe('/tmp', { researchSha: 'x'.repeat(40) }), /AI_FORMULA_READBACK_SHA_REQUIRED/);
});


// The next-iteration pipeline is a local research simulation. No real
// exchange requests, source rights, OOS returns, AI provider or order occurs.
function syntheticCandlesForTrain() {
  const base = Date.UTC(2020, 0, 1);
  return Array.from({ length: 180 }, (_, i) => {
    const mid = 100 + 0.08 * i + Math.sin(i / 5);
    return { timestamp: base + i * 15 * 60_000,
      open: mid, high: mid + 1.1, low: mid - 1.0,
      close: mid + (i % 8 === 0 ? 0.7 : 0.2),
      volume: i % 12 === 0 ? 2600 : 1000 + i % 9 * 20 };
  });
}
function syntheticApprovedFormulaBinding(aiArtifact) {
  const formula = compiledMomentumFormula().formula;
  const candles = syntheticCandlesForTrain();
  return {
    aiHypothesisId: 'BoundedVolume',
    reviewEvidenceDigest: aiArtifact.evidenceDigest,
    sourceCycleId: aiArtifact.sourceCycleId,
    formulaCandidate: formula,
    dataset: {
      datasetIdentity: formula.provenance.datasetIdentity,
      datasetRole: 'TRAIN', market: formula.market,
      timeframe: formula.timeframe, direction: formula.direction,
      candleCount: candles.length, availableFields: [...formula.availableDataFields],
      backtestInput: {
        market: formula.market, symbol: 'AAPL', timeframe: formula.timeframe,
        side: 'long', candles,
        initialCapital: 10_000,
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
        costModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0,
          slippageRate: 0.0005, spreadRate: 0.0002, latencyBars: 0, latencyDriftRate: 0 },
      },
      period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp,
        includeFinalHoldout: false },
    },
  };
}
function mockIndependentlyReviewedTrainSource(args) {
  return {
    status: 'VERIFIED_TRAIN_SOURCE', researchSha: args.researchSha,
    aiEvidenceDigest: args.aiEvidenceDigest, hypothesisId: args.hypothesisId,
    datasetIdentity: args.dataset.datasetIdentity, datasetDigest: args.datasetDigest,
    datasetRole: 'TRAIN', reviewIdentityDigest: args.reviewIdentityDigest,
    reviewedAssociationDigest: args.reviewedAssociationDigest,
    formulaCandidateId: args.formulaCandidate.candidateId,
    formulaHash: args.formulaCandidate.formulaHash,
    formulaReviewedForAiHypothesis: true, sourceRightsVerified: true,
    sourceProvenanceVerified: true, observedAtMs: NOW - 120_000,
  };
}
function mockCanonicalQueueSummary(digest, state = 'HOLD') {
  return {
    contract: 'research-formula-auto-backtest-summary/v1',
    researchCodeSha: SHA,
    liveTrading: false, autoTrading: false, realOrder: false,
    executionAuthority: 'NONE', paperOrderAuthorityGranted: false,
    canonicalFutureSignalVerified: false, oosAndSettlementVerified: false,
    paperRegisteredCount: 0, counts: { PASS: 0, HOLD: state === 'HOLD' ? 1 : 0,
      RESERVE: state === 'RESERVE' ? 1 : 0, EXCLUDE: state === 'EXCLUDE' ? 1 : 0 },
    rows: [{ itemDigest: digest, state,
      blockers: [state === 'HOLD' ? 'MISSING_CANONICAL_CALLBACK'
        : state === 'RESERVE' ? 'INSUFFICIENT_TRADE_SAMPLES' : 'FORMULA_INVALID'] }],
  };
}
async function readHistoricalArtifact(root, scan) {
  const info = scan.reviews.find((r) => r.profile === 'fast-historical');
  return JSON.parse(await readFile(join(root,'ai-review','reviews',info.evidenceDigest+'.json'),'utf8'));
}
async function syntheticIterationInput(root, scan) {
  const aiReviewArtifact = await readHistoricalArtifact(root, scan);
  const approvedBindings = [syntheticApprovedFormulaBinding(aiReviewArtifact)];
  const proposals = await prepareAiFormulaTrainProposalsV1({
    researchSha: SHA, aiReviewArtifact, approvedBindings,
    verifyOriginalSource: mockIndependentlyReviewedTrainSource, now: NOW, stage: false,
  });
  assert.equal(proposals.eligibleForTrainCount, 1);
  const digest = proposals.proposals[0].itemDigest;
  const base = {
    stateRoot: root, researchSha: SHA, now: NOW,
    aiReviewArtifact, approvedBindings,
    verifyOriginalSource: mockIndependentlyReviewedTrainSource,
  };
  return { base, digest };
}

test('next-cycle planner preserves forward-only CRITIC as waiting, never calls a model or mutates a trade', async () => {
  await fixture(['forward'], async ({root,scan}) => {
    const forwardArtifact = JSON.parse(await readFile(join(root, 'ai-review', 'reviews',
      scan.reviews[0].evidenceDigest + '.json'),'utf8'));
    let calls = 0;
    const report = await previewAiFormulaNextIterationV1({
      stateRoot: root, researchSha: SHA, now: NOW, aiReviewArtifact: forwardArtifact,
      requestFreeAi: true, invoke: async () => { calls++; throw new Error('UNREACHABLE'); },
    });
    assert.equal(report.status, 'WAITING_HISTORICAL_AI_PROPOSER');
    assert.equal(calls,0);
    assert.equal(report.providerInvocations,0);
    assert.equal(report.executionAuthority,'NONE');
    assert.equal(report.generatedCanonicalFormulaCount,0);
  });
});

test('next-cycle planner blocks unreviewed original data or unbound AI formula without provider calls', async () => {
  await fixture(['fast-historical'], async ({root,scan}) => {
    const aiReviewArtifact = await readHistoricalArtifact(root,scan);
    const noFormula=await previewAiFormulaNextIterationV1({
      stateRoot:root,researchSha:SHA,now:NOW,aiReviewArtifact,
    });
    assert.equal(noFormula.status,'WAITING_APPROVED_CANONICAL_FORMULA_AND_SOURCE');
    const noSource=await previewAiFormulaNextIterationV1({
      stateRoot:root,researchSha:SHA,now:NOW,aiReviewArtifact,
      approvedBindings:[syntheticApprovedFormulaBinding(aiReviewArtifact)],
    });
    assert.equal(noSource.status,'WAITING_APPROVED_CANONICAL_FORMULA_AND_SOURCE');
    assert.equal(noSource.proposedTrainCount,0);
    assert.equal(noSource.generatedCanonicalFormulaCount,0);
  });
});

test('source-bound advisory waits for the canonical TRAIN result rather than fabricating a fail or PASS', async () => {
  await fixture(['fast-historical'], async ({root,scan}) => {
    const {base,digest}=await syntheticIterationInput(root,scan);
    const waiting=await previewAiFormulaNextIterationV1(base);
    assert.equal(waiting.status,'WAITING_CANONICAL_TRAIN_BACKTEST');
    assert.equal(waiting.proposedTrainCount,1);
    assert.equal(waiting.executionAuthority,'NONE');
    const unrelated=mockCanonicalQueueSummary('f'.repeat(64),'RESERVE');
    const missing=await previewAiFormulaNextIterationV1({...base,queueSummary:unrelated});
    assert.equal(missing.status,'WAITING_CANONICAL_TRAIN_BACKTEST');
    assert.equal(missing.missingTrainResultCount,1);
    assert.equal(missing.providerInvocations,0);
    assert.notEqual(digest,'f'.repeat(64));
  });
});

test('TRAIN HOLD prevents repeated model retuning even if an owner mistakenly requests it', async () => {
  await fixture(['fast-historical'], async ({root,scan}) => {
    const {base,digest}=await syntheticIterationInput(root,scan);
    let called=0;
    const result=await previewAiFormulaNextIterationV1({
      ...base,queueSummary:mockCanonicalQueueSummary(digest,'HOLD'),
      requestFreeAi:true,env:{RESEARCH_AI_ITERATION_FREE_REVIEW_ENABLED:'true'},
      invoke:async()=>{called++;throw Error('UNEXPECTED');},
    });
    assert.equal(result.status,'BLOCKED_INDEPENDENT_EVIDENCE');
    assert.equal(result.reason,'TRAIN_ONLY_HOLD_NO_RETUNING');
    assert.equal(called,0);
    assert.equal(result.providerInvocations,0);
    assert.equal(result.fullCostVerified,false);
  });
});

test('qualified TRAIN RESERVE becomes one bounded free-AI qualitative research hypothesis and never a formula', async () => {
  await fixture(['fast-historical'],async({root,scan})=>{
    const {base,digest}=await syntheticIterationInput(root,scan);
    const queueSummary=mockCanonicalQueueSummary(digest,'RESERVE');
    const noCall=await previewAiFormulaNextIterationV1({...base,queueSummary});
    assert.equal(noCall.status,'READY_FOR_OPTIONAL_FREE_AI_CRITIQUE');
    assert.equal(noCall.providerInvocations,0);
    const disabled=await previewAiFormulaNextIterationV1({...base,queueSummary,requestFreeAi:true});
    assert.equal(disabled.status,'FREE_AI_REVIEW_DISABLED');
    let n=0;
    const cfg={
      RESEARCH_AI_ITERATION_FREE_REVIEW_ENABLED:'true',
      RESEARCH_AI_FREE_TIER_CONFIRMED:'true',
      AI_CHAT_PROVIDER:'gemini',
      GEMINI_API_KEY:'TEST_ONLY_GEMINI',
    };
    const invoke=async({policy,prompt})=>{
      n++;assert.equal(policy.provider,'gemini');
      assert.match(prompt,/INSUFFICIENT_TRADE_SAMPLES/u);
      assert.doesNotMatch(prompt,/TEST_ONLY_GEMINI/u);
      return {provider:policy.provider,model:policy.model,answer:REPLY};
    };
    const reviewed=await previewAiFormulaNextIterationV1({
      ...base,queueSummary,requestFreeAi:true,env:cfg,invoke,
    });
    assert.equal(n,1);
    assert.equal(reviewed.status,'QUALITATIVE_HYPOTHESIS_REVISION_PROPOSED');
    assert.equal(reviewed.providerInvocations,1);
    assert.equal(reviewed.modelProvider,'gemini');
    assert.equal(reviewed.advisoryReview.hypothesisCount,1);
    assert.equal(reviewed.generatedCanonicalFormulaCount,0);
    assert.equal(reviewed.mutatedFormulaCount,0);
    assert.equal(reviewed.approvedStrategyCount,0);
    assert.equal(reviewed.paperAdmissionAllowed,false);
    assert.equal(reviewed.orderCount,0);
    const again=await previewAiFormulaNextIterationV1({...base,queueSummary});
    assert.equal(again.inputDigest,noCall.inputDigest);
    assert.equal(again.providerInvocations,0);
  });
});

test('wrong release, tampered AI response and provider model mismatch stop next-loop research', async () => {
  await fixture(['fast-historical'],async({root,scan})=>{
    const {base,digest}=await syntheticIterationInput(root,scan);
    const queueSummary=mockCanonicalQueueSummary(digest,'RESERVE');
    await assert.rejects(previewAiFormulaNextIterationV1({
      ...base,aiReviewArtifact:{...base.aiReviewArtifact,
        review:{...base.aiReviewArtifact.review,summary:'Different instruction'}},
    }),/AI_ITERATION_REVIEW_CONTENT_OR_PROVENANCE_MISMATCH/u);
    await assert.rejects(previewAiFormulaNextIterationV1({
      ...base,queueSummary:{...queueSummary,researchCodeSha:'c'.repeat(40)},
    }),/AI_ITERATION_TRAIN_RELEASE_MISMATCH/u);
    await assert.rejects(previewAiFormulaNextIterationV1({
      ...base,stage:true,
    }),/AI_ITERATION_UNSUPPORTED_OR_UNSAFE_OPTION/u);
    const cfg={
      RESEARCH_AI_ITERATION_FREE_REVIEW_ENABLED:'true',
      RESEARCH_AI_FREE_TIER_CONFIRMED:'true',
      AI_CHAT_PROVIDER:'gemini', GEMINI_API_KEY:'TEST_ONLY_GEMINI',
    };
    await assert.rejects(previewAiFormulaNextIterationV1({
      ...base,queueSummary,requestFreeAi:true,env:cfg,
      invoke:async({policy})=>({answer:REPLY,model:'wrong-model',provider:policy.provider}),
    }),/AI_ITERATION_PROVIDER_IDENTITY_MISMATCH/u);
  });
});

test('a provider timeout is bounded as unavailable and never converted to a successful study', async()=>{
  await fixture(['fast-historical'],async({root,scan})=>{
    const {base,digest}=await syntheticIterationInput(root,scan);
    const result=await previewAiFormulaNextIterationV1({
      ...base,queueSummary:mockCanonicalQueueSummary(digest,'EXCLUDE'),
      requestFreeAi:true,
      env:{RESEARCH_AI_ITERATION_FREE_REVIEW_ENABLED:'true',
        RESEARCH_AI_FREE_TIER_CONFIRMED:'true',AI_CHAT_PROVIDER:'gemini',GEMINI_API_KEY:'TEST_ONLY_GEMINI'},
      invoke:async()=>{throw Error('FREE_AI_TIMEOUT');},
    });
    assert.equal(result.status,'FREE_AI_REVIEW_UNAVAILABLE');
    assert.equal(result.providerInvocations,1);
    assert.equal(result.providerFailure,'FREE_AI_TIMEOUT');
    assert.equal(result.automaticFormulaGeneration,undefined);
    assert.equal(result.generatedCanonicalFormulaCount,0);
  });
});

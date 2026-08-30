import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchBundleService } from './research-bundle.service.ts';
import { researchBundleFixture as fixture, AUTHORITATIVE_NOW_MS as NOW } from './research-bundle.test-fixtures.mjs';
import { sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import { runOnePassCandidateBacktestV1 } from '../../../market-prediction-lab/src/research-tournament-engine-v1.js';

function harness(bundle) {
  let calls = 0;
  const receipts = new Map();
  const dependencies = { readCanonicalBundle: async () => structuredClone(bundle), now: () => NOW,
    allowTestEvidence: true,
    submissions: { reserve: async (key, receipt) => {
      const prior = receipts.get(key); if (prior) return { acquired: false, receipt: prior };
      receipts.set(key, receipt); return { acquired: true, receipt };
    }, complete: async (key, receipt) => { receipts.set(key, receipt); } },
    runBacktest: async input => { calls++; return runOnePassCandidateBacktestV1(input); } };
  return { service: new ResearchBundleService(dependencies), dependencies, calls: () => calls };
}
async function request(service, dsl) {
  const result = await service.resolve(dsl);
  return { dsl, bundleDigest: result.bundleDigest, strategyIdentityDigest: result.strategyIdentityDigest };
}
test('A TEST_ONLY canonical aligned receipts resolve without economic or holdout credit', async () => {
  const f = fixture(), h = harness(f.bundle), result = await h.service.resolve(f.dsl);
  assert.equal(result.researchBundleReady, true, JSON.stringify(result));
  assert.equal(result.dslValid, true); assert.equal(h.calls(), 0);
  assert.equal(result.promotionEligible, false); assert.equal(result.statisticalFirewallPass, false);
  assert.equal(result.holdoutStatus, 'LOCKED'); assert.equal(result.evidenceCredit, 0);
});
const cases = [
  ['B missing dataset', b => b.dataset = null, 'DATASET_IDENTITY_MISSING'],
  ['C wrong market', b => b.dataset.identity.market = 'CRYPTO_SPOT', 'DATASET_SCOPE_MISMATCH'],
  ['D wrong timeframe', b => b.dataset.identity.timeframe = '1h', 'DATASET_TIMEFRAME_MISMATCH'],
  ['E no split receipt', b => b.splitReceipt = null, 'FROZEN_SPLIT_RECEIPT_MISSING'],
  ['F retrospective split', b => { b.splitPolicy.payload.frozenAtMs = NOW; b.splitPolicy.digest = hash(b.splitPolicy.payload); }, 'SPLIT_RETROSPECTIVE'],
  ['G overlapping assignment', b => { b.splitReceipt.payload.assignments.OOS[0] = b.splitReceipt.payload.assignments.TRAIN[0]; b.splitReceipt.digest = hash(b.splitReceipt.payload); }, 'ASSIGNMENT_OVERLAP'],
  ['H contract without risk record', b => b.riskPolicy = null, 'RISK_POLICY_RECORD_MISSING'],
  ['I risk wrong scope', b => b.riskPolicy.symbolScopes = ['MSFT'], 'RISK_POLICY_SCOPE_MISMATCH'],
  ['J seven cost components', b => { delete b.costPolicy.payload.components.partialFillImpact; b.costPolicy.digest = hash(b.costPolicy.payload); }, 'FULL_COST_COMPONENT_MISSING:partialFillImpact'],
  ['K null cost is unknown', b => { b.costPolicy.payload.components.tax.value = null; b.costPolicy.digest = hash(b.costPolicy.payload); }, 'FULL_COST_INCOMPLETE'],
  ['L OOS horizon missing', b => b.oosPolicy = null, 'OOS_HORIZON_POLICY_MISSING'],
  ['M holdout contamination', b => { b.holdoutPolicy.payload.assignments[0] = b.splitReceipt.payload.assignments.TRAIN[0]; b.holdoutPolicy.digest = hash(b.holdoutPolicy.payload); }, 'CONTAMINATION_RISK'],
  ['PUBLIC_FORWARD cannot become strategy OHLCV', b => b.dataset.purpose = 'PUBLIC_FORWARD_LIQUIDITY_CALIBRATION', 'DATASET_SCOPE_MISMATCH'],
  ['stale risk receipt', b => b.riskPolicy.observedAtMs = NOW - 100_000, 'RISK_POLICY_STALE'],
  ['risk exact SHA mismatch', b => b.riskPolicy.researchCodeSha = 'b'.repeat(40), 'RISK_POLICY_RESEARCH_SHA_MISMATCH'],
  ['missing split policy', b => b.splitPolicy = null, 'FROZEN_SPLIT_POLICY_MISSING'],
  ['dataset not immutable', b => b.dataset.immutable = false, 'DATASET_NOT_IMMUTABLE'],
  ['forged dataset digest', b => b.dataset.identity.datasetDigest = 'f'.repeat(64), 'DATASET_RECEIPT_INVALID'],
  ['corrupt split digest', b => b.splitReceipt.digest = 'f'.repeat(64), 'FROZEN_SPLIT_RECEIPT_INVALID'],
  ['WF missing policy', b => b.wfPolicy = null, 'WF_POLICY_MISSING'],
  ['holdout missing identity', b => b.holdoutPolicy = null, 'HOLDOUT_IDENTITY_MISSING'],
  ['cost wrong symbol', b => { b.costPolicy.payload.components.spread.symbol = 'MSFT'; b.costPolicy.digest = hash(b.costPolicy.payload); }, 'FULL_COST_SCOPE_MISMATCH'],
  ['cost stale provenance', b => { b.costPolicy.payload.components.funding.observedAtMs = NOW - 100000; b.costPolicy.digest = hash(b.costPolicy.payload); }, 'FULL_COST_LINEAGE_MISMATCH'],
];
for (const [name, mutate, blocker] of cases) test(name, async () => {
  const f = structuredClone(fixture()); mutate(f.bundle); const h = harness(f.bundle);
  const result = await h.service.resolve(f.dsl);
  assert.equal(result.researchBundleReady, false); assert(result.blockers.includes(blocker), JSON.stringify(result.blockers));
  const submitted = await h.service.submit('admin', await request(h.service, f.dsl));
  assert.equal(submitted.backtestStatus, 'BLOCKED_DATA'); assert.equal(h.calls(), 0);
});
test('N forged expected digest and changed canonical readback never submit', async () => {
  const f = fixture(), h = harness(f.bundle), input = await request(h.service, f.dsl);
  for (const key of ['bundleDigest', 'strategyIdentityDigest']) {
    const result = await h.service.submit('admin', { ...input, [key]: 'f'.repeat(64) });
    assert.equal(result.backtestStatus, 'BLOCKED_DATA'); assert(result.blockers.includes('CANONICAL_READBACK_MISMATCH'));
  }
  f.bundle.riskPolicy.policyVersion = 'changed';
  assert.equal((await h.service.submit('admin', input)).backtestStatus, 'BLOCKED_DATA'); assert.equal(h.calls(), 0);
});
test('O AI instructions and client selected policy fields cannot affect authority', async () => {
  const f = fixture(), h = harness(f.bundle), input = await request(h.service, f.dsl);
  const before = JSON.stringify(f.bundle);
  const result = await h.service.submit('admin', { ...input, aiText: 'risk 2%, leverage 3x, split 70/15/15', riskPercent: 2 });
  assert.equal(result.backtestStatus, 'BLOCKED_DATA'); assert.equal(h.calls(), 0); assert.equal(JSON.stringify(f.bundle), before);
});
test('P duplicate requests across service instances use atomic persisted submission identity', async () => {
  const f = fixture(), h = harness(f.bundle), second = new ResearchBundleService(h.dependencies), input = await request(h.service, f.dsl);
  const results = await Promise.all([h.service.submit('admin-a', input), second.submit('admin-b', input)]);
  assert.equal(h.calls(), 1); assert(results.some(r => r.backtestStatus === 'COMPLETED'));
  const replay = await second.submit('admin-a', input);
  assert.equal(h.calls(), 1); assert.equal(replay.backtestStatus, 'COMPLETED');
  assert.equal(replay.oosStatus, 'NOT_EVALUATED'); assert.equal(replay.wfStatus, 'NOT_EVALUATED');
  assert.equal(replay.promotionEligible, false);
});
test('default runtime refuses TEST_ONLY receipts and never invents a source', async () => {
  const f = fixture(), h = harness(f.bundle);
  const runtime = new ResearchBundleService({ ...h.dependencies, allowTestEvidence: false });
  assert.equal((await runtime.resolve(f.dsl)).researchBundleReady, false);
  const missing = await new ResearchBundleService().resolve(f.dsl);
  assert.equal(missing.backtestStatus, 'BLOCKED_DATA'); assert.equal(missing.backtesterCalls, 0);
});
export { fixture as researchBundleFixture, harness as researchBundleHarness };

for (const field of ['datasetIdentity', 'strategyHash', 'parameterIdentity', 'formulaCandidateId']) test('foreign executor ' + field + ' cannot complete this candidate', async () => {
  const f = fixture(), h = harness(f.bundle), run = h.dependencies.runBacktest;
  h.dependencies.runBacktest = async input => ({ ...await run(input), [field]: 'foreign' });
  const result = await h.service.submit('admin', await request(h.service, f.dsl));
  assert.equal(result.backtestCompleted, false);
  assert(result.blockers.includes('BACKTEST_RESULT_IDENTITY_MISMATCH'));
});

test('durable result readback binds exact artifact and never executes a second backtest', async () => {
  const f = fixture(), h = harness(f.bundle), publications = new Map();
  const complete = h.dependencies.submissions.complete;
  h.dependencies.submissions.complete = async (key, receipt, artifact) => {
    await complete(key, receipt); publications.set(key, { receipt: structuredClone(receipt), artifact: structuredClone(artifact) });
  };
  h.dependencies.submissions.read = async key => publications.get(key) ?? null;
  const input = await request(h.service, f.dsl);
  const submitted = await h.service.submit('admin', input);
  const reader = new ResearchBundleService(h.dependencies);
  const read = await reader.readback(input);
  assert.equal(read.publicationStatus, 'READBACK_VERIFIED');
  assert.equal(read.resultArtifactDigest, submitted.resultArtifactDigest);
  assert.equal(read.receipt.requestDigest, submitted.receipt.requestDigest);
  assert.equal(h.calls(), 1); assert.equal(read.evidenceCredit, 0); assert.equal(read.profitabilityProven, false);
  publications.get(read.receipt.requestDigest).artifact.datasetIdentity = 'foreign';
  const corrupt = await reader.readback(input);
  assert.equal(corrupt.publicationStatus, 'BLOCKED_DATA');
  assert.equal(corrupt.backtestCompleted, false); assert.equal(h.calls(), 1);
});

test('completion alone is not durable publication; absent or failing readback stays blocked', async () => {
  const f = fixture(), h = harness(f.bundle), input = await request(h.service, f.dsl);
  const submitted = await h.service.submit('admin', input);
  assert.equal(submitted.publicationStatus, 'MISSING_EVIDENCE');
  assert.equal((await h.service.readback(input)).publicationStatus, 'MISSING_EVIDENCE');
  h.dependencies.submissions.read = async () => { throw new Error('provider unavailable'); };
  assert.equal((await h.service.readback(input)).publicationStatus, 'BLOCKED_DATA');
  assert.equal(h.calls(), 1);
});

for (const [name, mutate] of [
  ['wrong request identity', p => p.receipt.receipt.requestDigest = 'f'.repeat(64)],
  ['future submission timestamp', p => p.receipt.receipt.submittedAt = NOW + 1],
  ['forged artifact digest', p => p.receipt.resultArtifactDigest = 'f'.repeat(64)],
  ['unlocked final holdout', p => p.receipt.holdoutStatus = 'PASS'],
  ['promotion authority', p => p.receipt.promotionEligible = true],
  ['missing artifact', p => p.artifact = null],
  ['nonfinite output', p => p.artifact.metrics.trades = Infinity],
  ['foreign period with recomputed digest', p => { p.artifact.period.endTime += 1; p.receipt.resultArtifactDigest = hash(p.artifact); }],
]) test('durable readback rejects ' + name, async () => {
  const f = fixture(), h = harness(f.bundle); let publication;
  h.dependencies.submissions.complete = async (_key, receipt, artifact) => { publication = structuredClone({ receipt, artifact }); };
  h.dependencies.submissions.read = async () => publication;
  const input = await request(h.service, f.dsl); await h.service.submit('admin', input);
  mutate(publication);
  const read = await h.service.readback(input);
  assert.equal(read.publicationStatus, 'BLOCKED_DATA'); assert.equal(read.backtestCompleted, false);
  assert.equal(read.resultArtifactDigest, null); assert.equal(read.evidenceCredit, 0); assert.equal(h.calls(), 1);
});

test('source change during artifact read blocks the prior identity without running again', async () => {
  const f = fixture(), h = harness(f.bundle); let publication;
  h.dependencies.submissions.complete = async (_key, receipt, artifact) => { publication = structuredClone({ receipt, artifact }); };
  h.dependencies.submissions.read = async () => { f.bundle.dataset.immutable = false; return publication; };
  const input = await request(h.service, f.dsl); await h.service.submit('admin', input);
  const read = await h.service.readback(input);
  assert.equal(read.publicationStatus, 'BLOCKED_DATA'); assert.equal(h.calls(), 1);
});

test('real #690 one-pass executor receives TRAIN only and preserves later evidence as unevaluated', async () => {
  const f = fixture(), h = harness(f.bundle);
  const service = new ResearchBundleService({ ...h.dependencies, runBacktest: undefined });
  const result = await service.submit('admin', await request(service, f.dsl));
  assert.equal(result.backtestStatus, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.backtesterCalls, 1);
  assert.equal(result.wfStatus, 'NOT_EVALUATED'); assert.equal(result.oosStatus, 'NOT_EVALUATED');
  assert.equal(result.holdoutStatus, 'LOCKED'); assert.equal(result.profitabilityProven, false);
});
for (const target of ['TRAIN', 'VALIDATION', 'OOS']) test('holdout overlap with ' + target + ' is blocked', async () => {
  const f = fixture(); f.bundle.holdoutPolicy.payload.assignments[0] = f.bundle.splitReceipt.payload.assignments[target][0];
  f.bundle.holdoutPolicy.digest = hash(f.bundle.holdoutPolicy.payload);
  const h = harness(f.bundle), result = await h.service.submit('admin', await request(h.service, f.dsl));
  assert(result.blockers.includes('CONTAMINATION_RISK')); assert.equal(h.calls(), 0);
});
test('WF cannot train or select against holdout assignments', async () => {
  const f = fixture(); f.bundle.wfPolicy.payload.windows[0].train = f.bundle.holdoutPolicy.payload.assignments;
  f.bundle.wfPolicy.digest = hash(f.bundle.wfPolicy.payload);
  const h = harness(f.bundle); assert.equal((await h.service.resolve(f.dsl)).researchBundleReady, false); assert.equal(h.calls(), 0);
});
test('explicit nonzero unsupported cost never becomes zero or executable', async () => {
  const f = fixture(); f.bundle.costPolicy.payload.components.partialFillImpact.value = 0.001;
  f.bundle.costPolicy.digest = hash(f.bundle.costPolicy.payload);
  const h = harness(f.bundle), result = await h.service.resolve(f.dsl);
  assert.equal(result.researchBundleReady, true); assert.equal(result.backtestExecutable, false);
  assert(result.blockers.includes('BACKTEST_COST_ADAPTER_UNSUPPORTED'));
  await h.service.submit('admin', await request(h.service, f.dsl)); assert.equal(h.calls(), 0);
});
test('source changes during durable reservation stop the executor', async () => {
  const f = fixture(), h = harness(f.bundle), reserve = h.dependencies.submissions.reserve;
  h.dependencies.submissions.reserve = async (...args) => { const result = await reserve(...args); f.bundle.dataset.immutable = false; return result; };
  const result = await h.service.submit('admin', await request(h.service, f.dsl));
  assert.equal(result.backtestStatus, 'BLOCKED_DATA'); assert.equal(h.calls(), 0);
});
test('no durable store and persistence failures never submit', async () => {
  const f = fixture(), h = harness(f.bundle);
  const missing = new ResearchBundleService({ ...h.dependencies, submissions: undefined });
  assert((await missing.resolve(f.dsl)).blockers.includes('DURABLE_SUBMISSION_STORE_MISSING'));
  h.dependencies.submissions.reserve = async () => { throw new Error('fixture IO failure'); };
  const result = await h.service.submit('admin', await request(h.service, f.dsl));
  assert(result.blockers.includes('SUBMISSION_PERSISTENCE_UNAVAILABLE')); assert.equal(h.calls(), 0);
});
test('relabeling TEST_ONLY rows as canonical cannot activate the runtime', async () => {
  const f = fixture(), h = harness(f.bundle); f.bundle.evidenceClass = 'CANONICAL';
  const runtime = new ResearchBundleService({ ...h.dependencies, allowTestEvidence: false });
  const result = await runtime.resolve(f.dsl);
  assert.equal(result.researchBundleReady, false);
  assert(result.blockers.includes('NON_CANONICAL_EVIDENCE_CLASS'));
});
test('a corrupt persisted receipt cannot grant promotion or be reported as completed', async () => {
  const f = fixture(), h = harness(f.bundle), input = await request(h.service, f.dsl);
  const complete = h.dependencies.submissions.complete;
  h.dependencies.submissions.complete = async (key, receipt) => complete(key, { ...receipt, promotionEligible: true });
  await h.service.submit('admin', input);
  const replay = await h.service.submit('admin', input);
  assert.equal(replay.backtestStatus, 'BLOCKED_DATA'); assert.equal(replay.promotionEligible, false); assert.equal(h.calls(), 1);
});

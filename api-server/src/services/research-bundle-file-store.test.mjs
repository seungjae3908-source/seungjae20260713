import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchBundleFileStore, publishResearchCanonicalBundleSource } from './research-bundle-file-store.service.ts';
import { ResearchBundleService } from './research-bundle.service.ts';
import { researchBundleFixture as fixture, AUTHORITATIVE_NOW_MS as NOW } from './research-bundle.test-fixtures.mjs';
import { buildResearchDatasetIdentity, sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
import { runOnePassCandidateBacktestV1 } from '../../../market-prediction-lab/src/research-tournament-engine-v1.js';

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'research-submission-test-'));
  const f = fixture(); let calls = 0;
  const fresh = () => new ResearchBundleService({ ...createResearchBundleFileStore(root),
    readCanonicalBundle: async () => structuredClone(f.bundle), allowTestEvidence: true, now: () => NOW,
    runBacktest: input => { calls++; return runOnePassCandidateBacktestV1(input); } });
  try {
    const resolved = await fresh().resolve(f.dsl);
    const request = { dsl: f.dsl, bundleDigest: resolved.bundleDigest, strategyIdentityDigest: resolved.strategyIdentityDigest };
    await run({ root, fresh, request, calls: () => calls, f });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function canonicalFixture() {
  const f = fixture(), bundle = structuredClone(f.bundle), dataset = bundle.dataset;
  const oldIdentity = dataset.identity;
  dataset.identity = buildResearchDatasetIdentity({ ...oldIdentity, rows: dataset.rows,
    provider: 'OWNER_PUBLISHED', providerVersion: 'v1', sourceType: 'OWNER_PUBLISHED' });
  const scope = { datasetId: dataset.id, datasetDigest: dataset.identity.datasetDigest,
    market: bundle.strategy.market, symbol: dataset.identity.symbol, timeframe: bundle.strategy.timeframe,
    researchCodeSha: bundle.strategy.researchCodeSha };
  const seal = (id, payload) => ({ id, payload, digest: hash(payload) });
  bundle.evidenceClass = 'CANONICAL';
  bundle.strategy.datasetDigest = scope.datasetDigest;
  dataset.receipt = seal('OWNER_DATASET_RECEIPT', { ...scope,
    datasetIdentityId: dataset.identity.datasetIdentityId, rowCount: dataset.rows.length });
  bundle.splitPolicy = seal('OWNER_SPLIT', { ...bundle.splitPolicy.payload, ...scope });
  bundle.splitReceipt = seal('OWNER_SPLIT_RECEIPT', { ...bundle.splitReceipt.payload, ...scope,
    policyDigest: bundle.splitPolicy.digest });
  const cost = bundle.costPolicy.payload;
  bundle.costPolicy = seal(bundle.costPolicy.id, { ...cost, ...scope,
    components: Object.fromEntries(Object.entries(cost.components).map(([key, value]) =>
      [key, { ...value, ...scope, source: 'OWNER_OBSERVED', provenance: ['OWNER_OBSERVED'] }])) });
  bundle.oosPolicy = seal('OWNER_OOS', { ...bundle.oosPolicy.payload, ...scope,
    splitReceiptDigest: bundle.splitReceipt.digest });
  bundle.wfPolicy = seal('OWNER_WF', { ...bundle.wfPolicy.payload, ...scope });
  bundle.holdoutPolicy = seal('OWNER_HOLDOUT', { ...bundle.holdoutPolicy.payload,
    market: scope.market, symbol: scope.symbol, timeframe: scope.timeframe, researchCodeSha: scope.researchCodeSha });
  const strategy = resolveCanonicalStrategyIdentity(bundle.strategy);
  Object.assign(bundle.modelReference.producerManifest, { strategyIdentity: strategy.identity,
    strategyIdentityDigest: strategy.strategyIdentityDigest, datasetDigest: scope.datasetDigest,
    sourceAttestation: { sourceKind: 'GENUINE_MARKET_DATA', reconstructed: false, synthetic: false,
      shadowDerived: false, finalHoldoutIncluded: false } });
  return { ...f, bundle };
}

test('file publication survives fresh service/store instances and concurrent duplicate admins execute once', async () => withStore(async h => {
  const results = await Promise.all([h.fresh().submit('admin-a', h.request), h.fresh().submit('admin-b', h.request)]);
  const completed = results.find(r => r.backtestCompleted);
  assert(completed, JSON.stringify(results)); assert.equal(h.calls(), 1);
  const replay = await h.fresh().submit('admin-c', h.request);
  assert.equal(replay.backtestCompleted, true); assert.equal(h.calls(), 1);
  const read = await h.fresh().readback({ ...h.request, resultArtifactDigest: completed.resultArtifactDigest });
  assert.equal(read.publicationStatus, 'READBACK_VERIFIED'); assert.equal(read.backtesterCalls, 0);
  assert.equal(read.receipt.modelIdentityDigest, completed.receipt.modelIdentityDigest);
  assert.equal(read.profitabilityProven, false); assert.equal(read.evidenceCredit, 0);
  const names = await readdir(join(h.root, 'submissions', completed.receipt.requestDigest));
  assert.deepEqual(names.sort(), ['completion.json', 'reservation.json']);
  await assert.rejects(createResearchBundleFileStore(h.root).submissions.complete(completed.receipt.requestDigest, completed,
    JSON.parse(await readFile(join(h.root, 'submissions', completed.receipt.requestDigest, 'completion.json'), 'utf8')).artifact), /EEXIST/);
}));

test('writer loss after reservation permanently blocks replay after a fresh service starts', async () => withStore(async h => {
  const store = createResearchBundleFileStore(h.root), reserve = store.submissions.reserve;
  const interrupted = new ResearchBundleService({ readCanonicalBundle: async () => h.f.bundle, now: () => NOW, allowTestEvidence: true,
    submissions: { ...store.submissions, reserve: async (...args) => { await reserve(...args); throw new Error('TEST_ONLY_CRASH_AFTER_SYNC'); } } });
  const first = await interrupted.submit('admin', h.request);
  assert(first.blockers.includes('SUBMISSION_PERSISTENCE_UNAVAILABLE'));
  const retry = await h.fresh().submit('admin', h.request);
  assert.equal(retry.backtestStatus, 'RUNNING'); assert.equal(retry.backtestCompleted, false); assert.equal(h.calls(), 0);
  const read = await h.fresh().readback(h.request);
  assert.equal(read.publicationStatus, 'MISSING_EVIDENCE'); assert(read.blockers.includes('BACKTEST_ARTIFACT_NOT_DURABLY_PUBLISHED'));
}));

for (const [name, mutate] of [
  ['changed result bytes', p => { p.artifact.metrics.trades += 1; }],
  ['forged model identity', p => { p.receipt.receipt.modelIdentityDigest = 'e'.repeat(64); }],
  ['forged submitted time', p => { p.receipt.receipt.submittedAt -= 1; }],
  ['promoted receipt', p => { p.receipt.profitabilityProven = true; }],
]) test('on-disk ' + name + ' fails closed without rerunning', async () => withStore(async h => {
  const submitted = await h.fresh().submit('admin', h.request);
  const path = join(h.root, 'submissions', submitted.receipt.requestDigest, 'completion.json');
  const publication = JSON.parse(await readFile(path, 'utf8')); mutate(publication);
  await writeFile(path, JSON.stringify(publication), 'utf8');
  const read = await h.fresh().readback(h.request);
  assert.equal(read.publicationStatus, 'BLOCKED_DATA'); assert.equal(read.backtestCompleted, false);
  const retry = await h.fresh().submit('admin', h.request);
  assert.equal(retry.backtestCompleted, false); assert.equal(h.calls(), 1);
}));

test('catalog is read only and missing, malformed, wrong-key, TEST_ONLY entries never produce execution', async () => withStore(async h => {
  await mkdir(join(h.root, 'catalog'));
  const storage = createResearchBundleFileStore(h.root), dslDigest = (await h.fresh().resolve(h.request.dsl)).dslDigest;
  assert.equal(await storage.readCanonicalBundle(dslDigest), null);
  await assert.rejects(storage.readCanonicalBundle('../escape'), /KEY_INVALID/);
  const path = join(h.root, 'catalog', dslDigest + '.json');
  await writeFile(path, '{', 'utf8'); await assert.rejects(storage.readCanonicalBundle(dslDigest), SyntaxError);
  await writeFile(path, JSON.stringify({ schemaVersion: 'research-bundle-catalog-entry-v1', dslDigest,
    bundleDigest: hash(h.f.bundle), bundle: h.f.bundle }), 'utf8');
  await assert.rejects(storage.readCanonicalBundle(dslDigest), /CATALOG_BINDING_INVALID/);
  const runtime = new ResearchBundleService(storage), result = await runtime.resolve(h.request.dsl);
  assert.equal(result.backtestExecutable, false); assert.equal(result.backtesterCalls, 0);
  assert(result.blockers.includes('CANONICAL_BUNDLE_SOURCE_UNAVAILABLE'));
  await assert.rejects(createResearchBundleFileStore('relative').readCanonicalBundle(dslDigest), /ROOT_MUST_BE_ABSOLUTE/);
}));

test('offline publisher validates, atomically publishes once, and verifies the existing reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-publisher-test-'));
  try {
    await mkdir(join(root, 'catalog'));
    const f = canonicalFixture();
    const publication = await publishResearchCanonicalBundleSource({ stateRoot: root, dsl: f.dsl,
      bundle: f.bundle, now: () => NOW });
    assert.equal(publication.publicationStatus, 'READBACK_VERIFIED');
    assert.equal(publication.bundleDigest, hash(f.bundle));
    assert.equal(publication.evidenceCredit, 0);
    assert.equal(publication.profitabilityProven, false);
    assert.equal(publication.executionAuthority, 'NONE');
    const envelope = JSON.parse(await readFile(join(root, 'catalog', publication.dslDigest + '.json'), 'utf8'));
    assert.equal(envelope.schemaVersion, 'research-bundle-catalog-entry-v1');
    assert.equal(envelope.dslDigest, publication.dslDigest);
    assert.equal(envelope.bundleDigest, publication.bundleDigest);
    assert.deepEqual(await createResearchBundleFileStore(root).readCanonicalBundle(publication.dslDigest), f.bundle);
    await assert.rejects(publishResearchCanonicalBundleSource({ stateRoot: root, dsl: f.dsl,
      bundle: f.bundle, now: () => NOW }), /CATALOG_ENTRY_EXISTS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline publisher fails closed for missing roots, non-canonical sources and changed identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-publisher-reject-test-'));
  try {
    const f = canonicalFixture();
    await assert.rejects(publishResearchCanonicalBundleSource({ stateRoot: root, dsl: f.dsl,
      bundle: f.bundle, now: () => NOW }), /ENOENT/);
    await mkdir(join(root, 'catalog'));
    const testOnly = fixture();
    await assert.rejects(publishResearchCanonicalBundleSource({ stateRoot: root, dsl: testOnly.dsl,
      bundle: testOnly.bundle, now: () => NOW }), /CATALOG_SOURCE_INVALID/);
    const changed = structuredClone(f.bundle); changed.strategy.strategyId = 'different';
    await assert.rejects(publishResearchCanonicalBundleSource({ stateRoot: root, dsl: f.dsl,
      bundle: changed, now: () => NOW }), /CATALOG_SOURCE_INVALID/);
    assert.deepEqual(await readdir(join(root, 'catalog')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

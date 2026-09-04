import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchBundleFileStore } from './research-bundle-file-store.service.ts';
import { ResearchBundleService } from './research-bundle.service.ts';
import { researchBundleFixture as fixture, AUTHORITATIVE_NOW_MS as NOW } from './research-bundle.test-fixtures.mjs';
import { sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
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

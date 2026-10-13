import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  publishResearchCanonicalBundleSource,
} from './research-bundle-file-store.service.ts';
import {
  publishResearchCanonicalBundleOfflineV1,
} from './research-canonical-bundle-offline-publisher.service.ts';
import {
  researchBundleFixture as fixture,
  AUTHORITATIVE_NOW_MS as NOW,
} from './research-bundle.test-fixtures.mjs';
import {
  buildResearchDatasetIdentity,
  sha256Canonical as hash,
} from '../../../market-prediction-lab/src/research-cache-provenance.js';
import {
  resolveCanonicalStrategyIdentity,
} from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';

function canonicalFixture() {
  const f = fixture();
  const bundle = structuredClone(f.bundle);
  const dataset = bundle.dataset;
  const oldIdentity = dataset.identity;
  dataset.identity = buildResearchDatasetIdentity({
    ...oldIdentity,
    rows: dataset.rows,
    provider: 'OWNER_PUBLISHED',
    providerVersion: 'v1',
    sourceType: 'OWNER_PUBLISHED',
  });
  const scope = {
    datasetId: dataset.id,
    datasetDigest: dataset.identity.datasetDigest,
    market: bundle.strategy.market,
    symbol: dataset.identity.symbol,
    timeframe: bundle.strategy.timeframe,
    researchCodeSha: bundle.strategy.researchCodeSha,
  };
  const seal = (id, payload) => ({ id, payload, digest: hash(payload) });
  bundle.evidenceClass = 'CANONICAL';
  bundle.strategy.datasetDigest = scope.datasetDigest;
  dataset.receipt = seal('OWNER_DATASET_RECEIPT', {
    ...scope,
    datasetIdentityId: dataset.identity.datasetIdentityId,
    rowCount: dataset.rows.length,
  });
  bundle.splitPolicy = seal('OWNER_SPLIT', { ...bundle.splitPolicy.payload, ...scope });
  bundle.splitReceipt = seal('OWNER_SPLIT_RECEIPT', {
    ...bundle.splitReceipt.payload,
    ...scope,
    policyDigest: bundle.splitPolicy.digest,
  });
  const cost = bundle.costPolicy.payload;
  bundle.costPolicy = seal(bundle.costPolicy.id, {
    ...cost,
    ...scope,
    components: Object.fromEntries(Object.entries(cost.components).map(([key, value]) => [
      key,
      { ...value, ...scope, source: 'OWNER_OBSERVED', provenance: ['OWNER_OBSERVED'] },
    ])),
  });
  bundle.oosPolicy = seal('OWNER_OOS', {
    ...bundle.oosPolicy.payload,
    ...scope,
    splitReceiptDigest: bundle.splitReceipt.digest,
  });
  bundle.wfPolicy = seal('OWNER_WF', { ...bundle.wfPolicy.payload, ...scope });
  bundle.holdoutPolicy = seal('OWNER_HOLDOUT', {
    ...bundle.holdoutPolicy.payload,
    market: scope.market,
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    researchCodeSha: scope.researchCodeSha,
  });
  const strategy = resolveCanonicalStrategyIdentity(bundle.strategy);
  Object.assign(bundle.modelReference.producerManifest, {
    strategyIdentity: strategy.identity,
    strategyIdentityDigest: strategy.strategyIdentityDigest,
    datasetDigest: scope.datasetDigest,
    sourceAttestation: {
      sourceKind: 'GENUINE_MARKET_DATA',
      reconstructed: false,
      synthetic: false,
      shadowDerived: false,
      finalHoldoutIncluded: false,
    },
  });
  return { ...f, bundle };
}

async function environment() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'canonical-bundle-publisher-state-'));
  const inputRoot = await mkdtemp(join(tmpdir(), 'canonical-bundle-publisher-input-'));
  await mkdir(join(stateRoot, 'catalog'));
  const f = canonicalFixture();
  const dslPath = join(inputRoot, 'dsl.json');
  const bundlePath = join(inputRoot, 'bundle.json');
  await writeFile(dslPath, JSON.stringify(f.dsl));
  await writeFile(bundlePath, JSON.stringify(f.bundle));
  return {
    stateRoot,
    inputRoot,
    dslPath,
    bundlePath,
    f,
    researchCodeSha: f.bundle.strategy.researchCodeSha,
  };
}

test('offline publisher publishes genuine CANONICAL bundle and durable READBACK_VERIFIED receipt', async () => {
  const env = await environment();
  try {
    const result = await publishResearchCanonicalBundleOfflineV1({
      stateRoot: env.stateRoot,
      inputRoot: env.inputRoot,
      dslPath: env.dslPath,
      bundlePath: env.bundlePath,
      researchCodeSha: env.researchCodeSha,
      validationNow: () => NOW,
    });
    assert.equal(result.status, 'published');
    assert.equal(result.recoveredExistingCatalog, false);
    assert.equal(result.researchCodeSha, env.researchCodeSha);
    assert.equal(result.publication.contract, 'research-canonical-bundle-offline-publication-receipt/v1');
    assert.equal(result.publication.researchCodeSha, env.researchCodeSha);
    assert.equal(result.publication.publisherMode, 'OFFLINE_OWNER_CONTROLLED');
    assert.equal(result.publication.catalogReadbackVerified, true);
    assert.match(result.publication.receiptDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.publication.publicationStatus, 'READBACK_VERIFIED');
    assert.equal(result.publication.evidenceCredit, 0);
    assert.equal(result.publication.profitabilityProven, false);
    assert.equal(result.publication.executionAuthority, 'NONE');
    assert.equal(result.safety.allowTestEvidence, false);
    assert.equal(result.safety.runtimeActivationAllowed, false);
    assert.equal(result.safety.realOrder, false);

    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    const record = JSON.parse(await readFile(result.recordPath, 'utf8'));
    assert.deepEqual(receipt, result.publication);
    assert.equal(record.researchCodeSha, env.researchCodeSha);
    assert.equal(record.dslDigest, result.publication.dslDigest);
    assert.equal(record.bundleDigest, result.publication.bundleDigest);
    assert.equal(record.publicationStatus, 'READBACK_VERIFIED');
    assert.equal(record.evidenceCredit, 0);
    assert.equal(record.profitabilityProven, false);
    assert.equal(record.executionAuthority, 'NONE');
    assert.match(record.inputDigest, /^[0-9a-f]{64}$/);
    assert.match(record.publicationDigest, /^[0-9a-f]{64}$/);
    assert.match(record.recordDigest, /^[0-9a-f]{64}$/);
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
});

test('publisher recovers after catalog publish succeeded before receipt persistence', async () => {
  const env = await environment();
  try {
    const publication = await publishResearchCanonicalBundleSource({
      stateRoot: env.stateRoot,
      dsl: env.f.dsl,
      bundle: env.f.bundle,
      now: () => NOW,
    });
    assert.equal(publication.publicationStatus, 'READBACK_VERIFIED');

    const recovered = await publishResearchCanonicalBundleOfflineV1({
      stateRoot: env.stateRoot,
      inputRoot: env.inputRoot,
      dslPath: env.dslPath,
      bundlePath: env.bundlePath,
      researchCodeSha: env.researchCodeSha,
      validationNow: () => NOW,
    });
    assert.equal(recovered.status, 'verified_existing_catalog');
    assert.equal(recovered.recoveredExistingCatalog, true);
    assert.equal(recovered.publication.dslDigest, publication.dslDigest);
    assert.equal(recovered.publication.bundleDigest, publication.bundleDigest);
    assert.equal(recovered.receiptStatus, 'created');
    assert.equal(recovered.recordStatus, 'created');

    const repeated = await publishResearchCanonicalBundleOfflineV1({
      stateRoot: env.stateRoot,
      inputRoot: env.inputRoot,
      dslPath: env.dslPath,
      bundlePath: env.bundlePath,
      researchCodeSha: env.researchCodeSha,
      validationNow: () => NOW,
    });
    assert.equal(repeated.status, 'verified_existing_catalog');
    assert.equal(repeated.receiptStatus, 'already_present');
    assert.equal(repeated.recordStatus, 'already_present');
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
});

test('TEST_ONLY bundle remains rejected and produces no publication receipt', async () => {
  const env = await environment();
  try {
    const testOnly = fixture();
    await writeFile(env.dslPath, JSON.stringify(testOnly.dsl));
    await writeFile(env.bundlePath, JSON.stringify(testOnly.bundle));
    await assert.rejects(
      publishResearchCanonicalBundleOfflineV1({
        stateRoot: env.stateRoot,
        inputRoot: env.inputRoot,
        dslPath: env.dslPath,
        bundlePath: env.bundlePath,
        researchCodeSha: testOnly.bundle.strategy.researchCodeSha,
        validationNow: () => NOW,
      }),
      /RESEARCH_CATALOG_SOURCE_INVALID/,
    );
    await assert.rejects(readFile(join(env.stateRoot, 'publication-receipts', 'missing.json')), /ENOENT/);
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
});

test('publisher refuses input files outside owner-controlled input root', async () => {
  const env = await environment();
  const outside = join(await mkdtemp(join(tmpdir(), 'canonical-bundle-outside-')), 'bundle.json');
  try {
    await writeFile(outside, JSON.stringify(env.f.bundle));
    await assert.rejects(
      publishResearchCanonicalBundleOfflineV1({
        stateRoot: env.stateRoot,
        inputRoot: env.inputRoot,
        dslPath: env.dslPath,
        bundlePath: outside,
        researchCodeSha: env.researchCodeSha,
        validationNow: () => NOW,
      }),
      /BUNDLE_OUTSIDE_INPUT_ROOT/,
    );
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
    await rm(join(outside, '..'), { recursive: true, force: true });
  }
});

test('tampered existing receipt conflicts instead of being silently replaced', async () => {
  const env = await environment();
  try {
    const first = await publishResearchCanonicalBundleOfflineV1({
      stateRoot: env.stateRoot,
      inputRoot: env.inputRoot,
      dslPath: env.dslPath,
      bundlePath: env.bundlePath,
      researchCodeSha: env.researchCodeSha,
      validationNow: () => NOW,
    });
    const receipt = JSON.parse(await readFile(first.receiptPath, 'utf8'));
    receipt.bundleDigest = 'f'.repeat(64);
    await writeFile(first.receiptPath, JSON.stringify(receipt));
    await assert.rejects(
      publishResearchCanonicalBundleOfflineV1({
        stateRoot: env.stateRoot,
        inputRoot: env.inputRoot,
        dslPath: env.dslPath,
        bundlePath: env.bundlePath,
        researchCodeSha: env.researchCodeSha,
        validationNow: () => NOW,
      }),
      /PUBLICATION_RECEIPT_CONFLICT/,
    );
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
});

test('stale or mismatched research SHA is rejected before catalog publication', async () => {
  const env = await environment();
  try {
    await assert.rejects(
      publishResearchCanonicalBundleOfflineV1({
        stateRoot: env.stateRoot,
        inputRoot: env.inputRoot,
        dslPath: env.dslPath,
        bundlePath: env.bundlePath,
        researchCodeSha: 'f'.repeat(40),
        validationNow: () => NOW,
      }),
      /BUNDLE_RESEARCH_CODE_SHA_MISMATCH/,
    );
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) =>
      readdir(join(env.stateRoot, 'catalog'))), []);
    await assert.rejects(
      readFile(join(env.stateRoot, 'publication-receipts', 'missing.json')),
      /ENOENT/,
    );
  } finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
});

test('production CLI does not import test fixtures or expose validation clock/test-evidence bypasses', async () => {
  const source = await readFile(
    join(process.cwd(), 'api-server', 'scripts', 'publish-research-canonical-bundle.ts'),
    'utf8',
  );
  assert.match(source, /RESEARCH_CODE_SHA/);
  assert.doesNotMatch(source, /test-fixtures|allowTestEvidence|validationNow|--now|TEST_ONLY/);
});

// Regression fixtures exercise real source admission, catalog, publication and
// filesystem code. They are synthetic test inputs, never operating evidence.
async function withPublicationEnvironment(task) {
  const env = await environment();
  try { await task(env); }
  finally {
    await rm(env.stateRoot, { recursive: true, force: true });
    await rm(env.inputRoot, { recursive: true, force: true });
  }
}
function retryInput(env, elapsedMs = 0) {
  return {
    stateRoot: env.stateRoot, inputRoot: env.inputRoot,
    dslPath: env.dslPath, bundlePath: env.bundlePath,
    researchCodeSha: env.researchCodeSha, validationNow: () => NOW + elapsedMs,
  };
}

test('later identical retry preserves the first publication time, digest and durable bytes', () =>
  withPublicationEnvironment(async (env) => {
    const first = await publishResearchCanonicalBundleOfflineV1(retryInput(env));
    const originalReceipt = await readFile(first.receiptPath);
    const originalRecord = await readFile(first.recordPath);
    const second = await publishResearchCanonicalBundleOfflineV1(retryInput(env, 1));
    assert.equal(second.status, 'verified_existing_catalog');
    assert.equal(second.receiptStatus, 'already_present');
    assert.equal(second.recordStatus, 'already_present');
    assert.deepEqual(second.publication, first.publication);
    assert.equal(second.publication.publishedAt, new Date(NOW).toISOString());
    assert.equal(second.publicationDigest, first.publicationDigest);
    assert.equal(second.recordDigest, first.recordDigest);
    assert.deepEqual(await readFile(first.receiptPath), originalReceipt);
    assert.deepEqual(await readFile(first.recordPath), originalRecord);
    assert.equal(second.safety.runtimeActivationAllowed, false);
    assert.equal(second.publication.evidenceCredit, 0);
    assert.equal(second.publication.profitabilityProven, false);
  }));

test('interruption after receipt persistence repairs only its missing companion record', () =>
  withPublicationEnvironment(async (env) => {
    const { unlink } = await import('node:fs/promises');
    const first = await publishResearchCanonicalBundleOfflineV1(retryInput(env));
    const originalReceipt = await readFile(first.receiptPath);
    const originalRecord = await readFile(first.recordPath);
    await unlink(first.recordPath);
    const recovered = await publishResearchCanonicalBundleOfflineV1(retryInput(env, 1));
    assert.equal(recovered.receiptStatus, 'already_present');
    assert.equal(recovered.recordStatus, 'created');
    assert.equal(recovered.recordDigest, first.recordDigest);
    assert.deepEqual(await readFile(first.receiptPath), originalReceipt);
    assert.deepEqual(await readFile(first.recordPath), originalRecord);
  }));

test('concurrent different-clock publishers converge on one immutable receipt and companion', () =>
  withPublicationEnvironment(async (env) => {
    await publishResearchCanonicalBundleSource({
      stateRoot: env.stateRoot, dsl: env.f.dsl, bundle: env.f.bundle, now: () => NOW,
    });
    const outputs = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      publishResearchCanonicalBundleOfflineV1(retryInput(env, index))));
    const winner = outputs.find(output => output.receiptStatus === 'created');
    assert.ok(winner);
    assert.equal(outputs.filter(output => output.receiptStatus === 'created').length, 1);
    assert.equal(outputs.filter(output => output.recordStatus === 'created').length, 1);
    for (const output of outputs) {
      assert.deepEqual(output.publication, winner.publication);
      assert.equal(output.publicationDigest, winner.publicationDigest);
      assert.equal(output.recordDigest, winner.recordDigest);
    }
    const { readdir } = await import('node:fs/promises');
    for (const directory of ['publication-receipts', 'publication-records']) {
      assert.deepEqual(await readdir(join(env.stateRoot, directory)), [winner.publication.dslDigest + '.json']);
    }
  }));

for (const [field, value] of [
  ['dslDigest', 'e'.repeat(64)],
  ['bundleDigest', 'f'.repeat(64)],
  ['researchCodeSha', 'f'.repeat(40)],
  ['evidenceCredit', 1],
  ['executionAuthority', 'LIVE'],
  ['unexpectedApproval', true],
]) {
  test(`rehashed existing receipt cannot alter ${field} on retry`, () =>
    withPublicationEnvironment(async (env) => {
      const first = await publishResearchCanonicalBundleOfflineV1(retryInput(env));
      const { receiptDigest, ...core } = first.publication;
      const changed = { ...core, [field]: value };
      const forged = JSON.stringify({ ...changed, receiptDigest: hash(changed) });
      await writeFile(first.receiptPath, forged);
      const originalRecord = await readFile(first.recordPath);
      await assert.rejects(publishResearchCanonicalBundleOfflineV1(retryInput(env, 1)),
        /PUBLICATION_RECEIPT_CONFLICT/);
      assert.equal(await readFile(first.receiptPath, 'utf8'), forged);
      assert.deepEqual(await readFile(first.recordPath), originalRecord);
    }));
}

test('orphan companion record does not permit inventing a new original publication time', () =>
  withPublicationEnvironment(async (env) => {
    const { unlink } = await import('node:fs/promises');
    const first = await publishResearchCanonicalBundleOfflineV1(retryInput(env));
    const originalRecord = await readFile(first.recordPath);
    await unlink(first.receiptPath);
    await assert.rejects(publishResearchCanonicalBundleOfflineV1(retryInput(env, 1)),
      /PUBLICATION_RECEIPT_MISSING/);
    await assert.rejects(readFile(first.receiptPath), /ENOENT/);
    assert.deepEqual(await readFile(first.recordPath), originalRecord);
  }));

for (const directory of ['publication-receipts', 'publication-records']) {
  test(`publisher refuses symlink ${directory} without writing through it`, () =>
    withPublicationEnvironment(async (env) => {
      const { readdir, symlink } = await import('node:fs/promises');
      const outside = await mkdtemp(join(tmpdir(), 'canonical-publication-outside-'));
      try {
        await symlink(outside, join(env.stateRoot, directory), 'junction');
        await assert.rejects(publishResearchCanonicalBundleOfflineV1(retryInput(env)), /UNSAFE/);
        assert.deepEqual(await readdir(outside), []);
      } finally { await rm(outside, { recursive: true, force: true }); }
    }));
}

test('malformed saved publication is never silently repaired or replaced', () =>
  withPublicationEnvironment(async (env) => {
    const first = await publishResearchCanonicalBundleOfflineV1(retryInput(env));
    const broken = '{"interrupted":';
    await writeFile(first.receiptPath, broken);
    await assert.rejects(publishResearchCanonicalBundleOfflineV1(retryInput(env, 1)), SyntaxError);
    assert.equal(await readFile(first.receiptPath, 'utf8'), broken);
  }));

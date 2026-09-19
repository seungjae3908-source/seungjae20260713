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
  return { stateRoot, inputRoot, dslPath, bundlePath, f };
}

test('offline publisher publishes genuine CANONICAL bundle and durable READBACK_VERIFIED receipt', async () => {
  const env = await environment();
  try {
    const result = await publishResearchCanonicalBundleOfflineV1({
      stateRoot: env.stateRoot,
      inputRoot: env.inputRoot,
      dslPath: env.dslPath,
      bundlePath: env.bundlePath,
      validationNow: () => NOW,
    });
    assert.equal(result.status, 'published');
    assert.equal(result.recoveredExistingCatalog, false);
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
        validationNow: () => NOW,
      }),
      /PUBLICATION_RECEIPT_CONFLICT/,
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
  assert.doesNotMatch(source, /test-fixtures|allowTestEvidence|validationNow|--now|TEST_ONLY/);
});

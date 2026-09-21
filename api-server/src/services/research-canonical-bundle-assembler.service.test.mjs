import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assembleResearchCanonicalBundleV1,
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';
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

async function environment(useCanonical = true) {
  const root = await mkdtemp(join(tmpdir(), 'canonical-bundle-assembler-'));
  const componentsRoot = join(root, 'components');
  await mkdir(componentsRoot);
  const f = useCanonical ? canonicalFixture() : fixture();
  const paths = {};
  for (const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1) {
    const value = key === 'dsl' ? f.dsl : f.bundle[key];
    const path = join(componentsRoot, `${key}.json`);
    await writeFile(path, JSON.stringify(value));
    paths[key] = path;
  }
  return {
    root,
    componentPaths: paths,
    f,
    researchCodeSha: f.bundle.strategy.researchCodeSha,
  };
}

test('assembler accepts only independently canonical-ready components and writes immutable bundle + digest record', async () => {
  const env = await environment(true);
  try {
    const result = await assembleResearchCanonicalBundleV1({
      inputRoot: env.root,
      researchCodeSha: env.researchCodeSha,
      componentPaths: env.componentPaths,
      validationNow: () => NOW,
    });
    assert.equal(result.status, 'assembled');
    assert.equal(result.researchCodeSha, env.researchCodeSha);
    assert.match(result.dslDigest, /^[0-9a-f]{64}$/);
    assert.match(result.bundleDigest, /^[0-9a-f]{64}$/);
    assert.match(result.recordDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.safety.generatedEvidence, false);
    assert.equal(result.safety.allowTestEvidence, false);
    assert.equal(result.safety.executionAuthority, 'NONE');

    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
    const record = JSON.parse(await readFile(result.recordPath, 'utf8'));
    assert.equal(bundle.schemaVersion, 'research-bundle-source-v1');
    assert.equal(bundle.evidenceClass, 'CANONICAL');
    assert.equal(bundle.strategy.researchCodeSha, env.researchCodeSha);
    assert.equal(record.researchBundleReady, true);
    assert.equal(record.componentReadinessVerified, true);
    assert.equal(record.backtestExecutableAtAssembly, false);
    assert.equal(record.durableSubmissionStoreRequired, true);
    assert.equal(result.safety.publisherRevalidationRequired, true);
    assert.equal(result.safety.durableSubmissionStoreBypassed, false);
    assert.equal(record.evidenceCredit, 0);
    assert.equal(record.profitabilityProven, false);
    assert.equal(record.executionAuthority, 'NONE');
    assert.deepEqual(Object.keys(record.componentDigests).sort(), [...RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1].sort());
    assert.equal(Object.values(record.componentDigests).every((value) => /^[0-9a-f]{64}$/.test(value)), true);

    const repeated = await assembleResearchCanonicalBundleV1({
      inputRoot: env.root,
      researchCodeSha: env.researchCodeSha,
      componentPaths: env.componentPaths,
      validationNow: () => NOW,
    });
    assert.equal(repeated.status, 'already_present');
    assert.equal(repeated.bundleDigest, result.bundleDigest);
    assert.equal(repeated.recordDigest, result.recordDigest);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('TEST_ONLY component set is not relabeled CANONICAL by the assembler', async () => {
  const env = await environment(false);
  try {
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: env.researchCodeSha,
        componentPaths: env.componentPaths,
        validationNow: () => NOW,
      }),
      /CANONICAL_BUNDLE_ASSEMBLY_NOT_READY/,
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('component set must be exact: missing and extra keys fail before assembly', async () => {
  const env = await environment(true);
  try {
    const missing = { ...env.componentPaths };
    delete missing.modelReference;
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: env.researchCodeSha,
        componentPaths: missing,
        validationNow: () => NOW,
      }),
      /COMPONENT_SET_INVALID/,
    );
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: env.researchCodeSha,
        componentPaths: { ...env.componentPaths, extra: env.componentPaths.dsl },
        validationNow: () => NOW,
      }),
      /COMPONENT_SET_INVALID/,
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('component files outside owner input root and stale research SHA are rejected', async () => {
  const env = await environment(true);
  const outsideRoot = await mkdtemp(join(tmpdir(), 'canonical-bundle-outside-'));
  const outside = join(outsideRoot, 'dataset.json');
  try {
    await writeFile(outside, JSON.stringify(env.f.bundle.dataset));
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: env.researchCodeSha,
        componentPaths: { ...env.componentPaths, dataset: outside },
        validationNow: () => NOW,
      }),
      /COMPONENT_DATASET_OUTSIDE_INPUT_ROOT/,
    );
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: 'f'.repeat(40),
        componentPaths: env.componentPaths,
        validationNow: () => NOW,
      }),
      /RESEARCH_CODE_SHA_MISMATCH/,
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('tampered existing assembled bundle conflicts instead of being silently replaced', async () => {
  const env = await environment(true);
  try {
    const first = await assembleResearchCanonicalBundleV1({
      inputRoot: env.root,
      researchCodeSha: env.researchCodeSha,
      componentPaths: env.componentPaths,
      validationNow: () => NOW,
    });
    const tampered = JSON.parse(await readFile(first.bundlePath, 'utf8'));
    tampered.strategy.strategyId = 'tampered';
    await writeFile(first.bundlePath, JSON.stringify(tampered));
    await assert.rejects(
      assembleResearchCanonicalBundleV1({
        inputRoot: env.root,
        researchCodeSha: env.researchCodeSha,
        componentPaths: env.componentPaths,
        validationNow: () => NOW,
      }),
      /ASSEMBLED_BUNDLE_CONTENT_CONFLICT/,
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('production assembler CLI has no fixture/test-evidence/time override bypass', async () => {
  const source = await readFile(
    join(process.cwd(), 'api-server', 'scripts', 'assemble-research-canonical-bundle.ts'),
    'utf8',
  );
  assert.match(source, /RESEARCH_CODE_SHA/);
  assert.match(source, /RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT/);
  assert.doesNotMatch(source, /test-fixtures|allowTestEvidence|validationNow|--now|TEST_ONLY/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { sha256 } from "../src/data-quality.js";
import {
  MODEL_REFERENCE_DURABLE_PROVIDER,
  MODEL_REFERENCE_DURABLE_TAG_PREFIX,
  buildModelReferenceDurableReceiptV1,
  modelReferenceDurableSafetyV1,
  validateModelReferenceDurableReceiptV1,
} from "../src/model-reference-durable-store-v1.js";

const RUN_ID = "33150000000";
const TARGET_SHA = "a".repeat(40);
const BUNDLE_BYTES = Buffer.from("exact deterministic future reference bundle bytes", "utf8");
const BUNDLE_DIGEST = sha256(BUNDLE_BYTES);
const RELEASE_ID = "88001";
const ASSET_ID = "99001";
const RECEIPT_ASSET_ID = "99002";
const ASSET_NAME = `prediction-lab-model-reference-evidence-${RUN_ID}-${BUNDLE_DIGEST}.tar.gz`;
const ASSET_REFERENCE = `https://github.com/example/repo/releases/download/${MODEL_REFERENCE_DURABLE_TAG_PREFIX}-${RUN_ID}/${ASSET_NAME}`;

function manifest(group = "crypto-futures-15m", overrides = {}) {
  return {
    status: "VALID",
    referenceProvenanceStatus: "VALID",
    group,
    datasetId: `prediction-lab:${group}:train-validation`,
    datasetDigest: "1".repeat(64),
    strategyIdentityDigest: "2".repeat(64),
    researchCodeSha: TARGET_SHA,
    trainingCodeSha: TARGET_SHA,
    producerSha: TARGET_SHA,
    modelSha: "3".repeat(64),
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
    featureOrderDigest: "4".repeat(64),
    trainDatasetIdentity: `prediction-lab-model-reference:train:${group}`,
    validationDatasetIdentity: `prediction-lab-model-reference:validation:${group}`,
    trainDatasetDigest: "5".repeat(64),
    validationDatasetDigest: "6".repeat(64),
    trainSplitDigest: "5".repeat(64),
    validationSplitDigest: "6".repeat(64),
    trainingInvocationDigest: "a".repeat(64),
    oosExclusionDigest: "b".repeat(64),
    splitIsolationStatus: "PASS",
    rawArtifactDigest: "7".repeat(64),
    artifactIdentity: `prediction-lab-model-reference:${group}:sha256:${"7".repeat(64)}`,
    artifactDigest: "7".repeat(64),
    measuredAt: "2026-08-28T00:00:00.000Z",
    trainSampleN: 1200,
    validationSampleN: 300,
    sourceAttestation: {
      sourceKind: "GENUINE_MARKET_DATA",
      futureOnly: true,
      reconstructed: false,
      historicalReconstruction: false,
      synthetic: false,
      replayDerived: false,
      shadowDerived: false,
      testFixture: false,
      oosIncluded: false,
      finalHoldoutIncluded: false,
      finalHoldoutAccessed: false,
    },
    referenceProvenance: {
      artifactReceiptDigest: "8".repeat(64),
      provenanceDigest: "9".repeat(64),
    },
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return buildModelReferenceDurableReceiptV1({
    repository: "example/repo",
    sourceWorkflowRunId: RUN_ID,
    targetCommitSha: TARGET_SHA,
    releaseId: RELEASE_ID,
    releaseTag: `${MODEL_REFERENCE_DURABLE_TAG_PREFIX}-${RUN_ID}`,
    releaseReference: `https://github.com/example/repo/releases/tag/${MODEL_REFERENCE_DURABLE_TAG_PREFIX}-${RUN_ID}`,
    bundleAsset: {
      assetId: ASSET_ID,
      assetName: ASSET_NAME,
      assetReference: ASSET_REFERENCE,
      outerArtifactDigest: BUNDLE_DIGEST,
      byteLength: BUNDLE_BYTES.length,
      createdAt: "2026-08-28T00:01:00.000Z",
      state: "uploaded",
    },
    receiptAssetName: `prediction-lab-model-reference-receipt-${RUN_ID}.json`,
    referenceManifests: [manifest("crypto-futures-1h"), manifest("crypto-futures-15m")],
    ...overrides,
  });
}

function releaseMetadata(overrides = {}) {
  return {
    id: Number(RELEASE_ID),
    tag_name: `${MODEL_REFERENCE_DURABLE_TAG_PREFIX}-${RUN_ID}`,
    target_commitish: TARGET_SHA,
    immutable: true,
    draft: false,
    assets: [{ id: Number(ASSET_ID) }, { id: Number(RECEIPT_ASSET_ID) }],
    ...overrides,
  };
}

function exactReceiptBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function receiptAssetMetadata(value, overrides = {}) {
  const bytes = exactReceiptBytes(value);
  return {
    id: Number(RECEIPT_ASSET_ID),
    name: value.receiptAssetName,
    browser_download_url: `https://github.com/example/repo/releases/download/${value.releaseTag}/${value.receiptAssetName}`,
    digest: `sha256:${sha256(bytes)}`,
    size: bytes.length,
    state: "uploaded",
    ...overrides,
  };
}

function validationEvidence(value, overrides = {}) {
  return {
    releaseMetadata: releaseMetadata(),
    assetMetadata: assetMetadata(),
    exactBundleBytes: BUNDLE_BYTES,
    receiptAssetMetadata: receiptAssetMetadata(value),
    exactReceiptBytes: exactReceiptBytes(value),
    ...overrides,
  };
}

function assetMetadata(overrides = {}) {
  return {
    id: Number(ASSET_ID),
    name: ASSET_NAME,
    browser_download_url: ASSET_REFERENCE,
    digest: `sha256:${BUNDLE_DIGEST}`,
    size: BUNDLE_BYTES.length,
    state: "uploaded",
    ...overrides,
  };
}

test("actual immutable release and exact asset bytes make the durable receipt VALID", () => {
  const value = receipt();
  const result = validateModelReferenceDurableReceiptV1(value, validationEvidence(value));
  assert.equal(result.valid, true);
  assert.equal(result.status, "VALID");
  assert.equal(result.durableReferenceStore, MODEL_REFERENCE_DURABLE_PROVIDER);
  assert.equal(result.longTermReferenceProven, true);
  assert.equal(result.publicationReceiptProven, true);
  assert.equal(value.expiresAt, null);
  assert.deepEqual(value.references.map((item) => item.group), ["crypto-futures-15m", "crypto-futures-1h"]);
  assert.equal(value.sourceContract.actionsArtifactDigestIsDurableDigest, false);
  assert.equal(value.sourceContract.exactStoredBytesConsumedByTraining, true);
});

test("missing or mutable release state never proves long-term preservation", () => {
  const value = receipt();
  assert.equal(validateModelReferenceDurableReceiptV1(value, {
    ...validationEvidence(value),
    releaseMetadata: null,
  }).status, "MISSING_EVIDENCE");
  const mutable = validateModelReferenceDurableReceiptV1(value, {
    ...validationEvidence(value),
    releaseMetadata: releaseMetadata({ immutable: false }),
  });
  assert.equal(mutable.status, "MISSING_EVIDENCE");
  assert.equal(mutable.longTermReferenceProven, false);
});

test("release, asset, and exact byte substitutions fail closed", async (t) => {
  const value = receipt();
  const cases = [
    ["release target", { releaseMetadata: releaseMetadata({ target_commitish: "b".repeat(40) }) }],
    ["release tag", { releaseMetadata: releaseMetadata({ tag_name: "other-tag" }) }],
    ["asset id", { assetMetadata: assetMetadata({ id: 123 }) }],
    ["asset digest", { assetMetadata: assetMetadata({ digest: `sha256:${"f".repeat(64)}` }) }],
    ["bundle bytes", { exactBundleBytes: Buffer.from("substituted", "utf8") }],
    ["receipt asset digest", { receiptAssetMetadata: receiptAssetMetadata(value, { digest: `sha256:${"e".repeat(64)}` }) }],
    ["receipt bytes", { exactReceiptBytes: Buffer.from("{}\n", "utf8") }],
    ["release membership", { releaseMetadata: releaseMetadata({ assets: [{ id: Number(ASSET_ID) }] }) }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      assert.equal(validateModelReferenceDurableReceiptV1(value, validationEvidence(value, overrides)).status, "IDENTITY_MISMATCH");
    });
  }
});

test("tampered durable receipt digest is rejected", () => {
  const value = structuredClone(receipt());
  value.references[0].modelSha = "f".repeat(64);
  assert.equal(validateModelReferenceDurableReceiptV1(value, validationEvidence(value)).status, "IDENTITY_MISMATCH");
});

test("only VALID genuine future manifests can enter the durable receipt", () => {
  assert.throws(() => receipt({ referenceManifests: [manifest("crypto-futures-15m", { status: "MISSING_EVIDENCE" })] }), /canonically VALID/);
  assert.throws(() => receipt({ referenceManifests: [manifest("crypto-futures-15m", { sourceAttestation: { ...manifest().sourceAttestation, reconstructed: true } })] }), /substitution/);
  assert.throws(() => receipt({ referenceManifests: [manifest("crypto-futures-15m", { researchCodeSha: "b".repeat(40) })] }), /code SHA/);
  assert.throws(() => receipt({ referenceManifests: [manifest("crypto-futures-15m", { producerSha: "b".repeat(40) })] }), /code SHA/);
  assert.throws(() => receipt({ referenceManifests: [manifest("crypto-futures-15m", { validationDatasetDigest: "5".repeat(64) })] }), /distinct/u);
});

test("durable publisher workflow is main-only, immutability-gated, digest-bound, and preserves the #693 package layout", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/prediction-lab-52d-validation.yml", import.meta.url), "utf8");
  const policyWorkflow = await readFile(new URL("../../.github/workflows/prediction-lab-model-reference-durable-policy.yml", import.meta.url), "utf8");
  assert.match(workflow, /publish-durable-reference:/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /durable-policy-preflight:/u);
  assert.match(policyWorkflow, /workflow_call:/u);
  assert.match(policyWorkflow, /\/immutable-releases/u);
  assert.match(policyWorkflow, /PREDICTION_LAB_IMMUTABLE_RELEASE_POLICY_TOKEN/u);
  assert.match(policyWorkflow, /Administration:read/u);
  assert.match(policyWorkflow, /immutable[^\n]+true/u);
  assert.match(workflow, /createRelease/u);
  assert.match(workflow, /draft:\s*true/u);
  assert.match(workflow, /uploadReleaseAsset/u);
  assert.match(workflow, /updateRelease/u);
  assert.match(workflow, /receipt-asset-metadata\.json/u);
  assert.match(workflow, /receiptAssetMetadata/u);
  assert.match(workflow, /exactReceiptBytes/u);
  assert.match(workflow, /gh release verify-asset "\$RELEASE_TAG" "\$DURABLE_ROOT\/\$RECEIPT_NAME"/u);
  assert.match(workflow, /exact release tag already exists/u);
  assert.match(workflow, /prediction-lab-model-reference-evidence-\$\{\{ github\.run_id \}\}/u);
  for (const path of ["reference-manifest.json", "model/exact-model.json", "records/train.jsonl", "records/validation.jsonl"]) {
    assert.match(workflow, new RegExp(path.replace(/[./]/gu, "\\$&"), "u"));
  }
  assert.match(workflow, /DURABLE_REFERENCE_STORE_NOT_READY/u);
  assert.match(workflow, /LONG_TERM_REFERENCE_PROVEN=true/u);
  assert.doesNotMatch(workflow, /Final Holdout/iu);
  assert.doesNotMatch(policyWorkflow, /createRelease|uploadReleaseAsset|updateRelease/u);
});

test("durable receipt keeps all trading safety invariants locked", () => {
  assert.deepEqual(modelReferenceDurableSafetyV1(), {
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
  });
});

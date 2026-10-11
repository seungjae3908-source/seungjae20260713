'use strict';

const assert = require('node:assert/strict');
const nodeTest = require('node:test');
const {
  assertProductionDeployExecutionProvenance,
  assertProductionDeployProvenance,
  assertProductionRuntimeIdentity,
  canonicalizeProductionAccountProviders,
  selectLatestSuccessfulProductionDeploy,
} = require('./production-deploy-provenance.cjs');

const targetSha = '8c53393b6cc11242efd9a3a31aaa7ff74af13bd4';
const staleSha = '916e30b5af4007b4080efbb198585806dd8dd1ea';

function deploy(overrides = {}) {
  return {
    id: 36696880082,
    name: 'Production Deploy',
    path: '.github/workflows/production-deploy.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: targetSha,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-30T09:20:00Z',
    ...overrides,
  };
}

function expectProvenanceFailure(run, expectedCode) {
  assert.throws(
    () => assertProductionDeployProvenance(run, { targetSha, productionDeployRunId: '36696880082' }),
    new RegExp(expectedCode),
  );
}

nodeTest.test('A/B: selects and validates the exact current successful Production Deploy, not an older successful SHA', () => {
  const selected = selectLatestSuccessfulProductionDeploy([
    deploy({ id: 36690000001, head_sha: staleSha, created_at: '2026-09-28T09:20:00Z' }),
    deploy(),
  ]);
  assert.equal(selected.id, 36696880082);
  assert.doesNotThrow(() => assertProductionDeployProvenance(selected, {
    targetSha,
    productionDeployRunId: '36696880082',
  }));
});

nodeTest.test('C: rejects a passed run ID whose head SHA differs from the target', () => {
  expectProvenanceFailure(deploy({ head_sha: staleSha }), 'HEAD_SHA_MISMATCH');
});

nodeTest.test('D: rejects waiting, failed, and cancelled deploy runs', () => {
  expectProvenanceFailure(deploy({ status: 'waiting', conclusion: null }), 'STATUS_MISMATCH');
  expectProvenanceFailure(deploy({ status: 'completed', conclusion: 'failure' }), 'CONCLUSION_MISMATCH');
  expectProvenanceFailure(deploy({ status: 'completed', conclusion: 'cancelled' }), 'CONCLUSION_MISMATCH');
});

nodeTest.test('E/F: rejects a non-production-deploy workflow path and a non-main branch', () => {
  expectProvenanceFailure(deploy({ path: '.github/workflows/other.yml' }), 'WORKFLOW_PATH_MISMATCH');
  expectProvenanceFailure(deploy({ head_branch: 'release' }), 'HEAD_BRANCH_MISMATCH');
});

nodeTest.test('G: rejects a Production runtime identity mismatch', () => {
  assert.throws(() => assertProductionRuntimeIdentity({
    ok: true,
    deploySha: targetSha,
    processDeploySha: staleSha,
    deployMarkerSha: targetSha,
    identityMatch: false,
    identityStatus: 'mismatch',
  }, targetSha), /PRODUCTION_ACCOUNT_QA_IDENTITY_MISMATCH/);
});

nodeTest.test('H: ignores a newer waiting duplicate of the same SHA', () => {
  const selected = selectLatestSuccessfulProductionDeploy([
    deploy({ id: 36696963838, status: 'waiting', conclusion: null, created_at: '2026-09-30T09:30:00Z' }),
    deploy(),
  ]);
  assert.equal(selected.id, 36696880082);
});

nodeTest.test('I: preserves the canonical four-provider ordering', () => {
  assert.deepEqual(
    canonicalizeProductionAccountProviders('toss,kiwoom,upbit,bitget'),
    ['bitget', 'kiwoom', 'toss', 'upbit'],
  );
  assert.equal(canonicalizeProductionAccountProviders('toss,toss'), null);
});

nodeTest.test('J: accepts only the current in-progress official deploy for inline post-deploy QA', () => {
  const inline = deploy({ status: 'in_progress', conclusion: null });
  assert.doesNotThrow(() => assertProductionDeployExecutionProvenance(inline, {
    targetSha,
    productionDeployRunId: '36696880082',
    currentRunId: '36696880082',
    mode: 'inline',
  }));
  assert.throws(() => assertProductionDeployExecutionProvenance(inline, {
    targetSha,
    productionDeployRunId: '36696880082',
    currentRunId: '36696880083',
    mode: 'inline',
  }), /INLINE_RUN_ID_MISMATCH/);
});

nodeTest.test('K: inline post-deploy QA rejects completed, waiting, or failed runs', () => {
  for (const overrides of [
    { status: 'completed', conclusion: 'success' },
    { status: 'waiting', conclusion: null },
    { status: 'completed', conclusion: 'failure' },
  ]) {
    assert.throws(() => assertProductionDeployExecutionProvenance(deploy(overrides), {
      targetSha,
      productionDeployRunId: '36696880082',
      currentRunId: '36696880082',
      mode: 'inline',
    }), /INLINE_STATUS_MISMATCH/);
  }
});

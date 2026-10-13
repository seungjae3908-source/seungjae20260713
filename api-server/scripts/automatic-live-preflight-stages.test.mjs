import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOfflinePreflightStages } from './automatic-live-preflight-stages.mjs';

test('preflight collects independent build, component and release failures instead of stopping at the first', async () => {
  const called = [];
  const result = await collectOfflinePreflightStages(['build-a', 'build-b', 'components', 'release-contracts'].map((id) => ({
    id, run: async () => { called.push(id); if (id !== 'build-b') throw new Error('RAW_SECRET_DETAIL_NOT_ALLOWED'); },
  })));
  assert.deepEqual(called, ['build-a', 'build-b', 'components', 'release-contracts']);
  assert.deepEqual(result.stages.map((row) => row.status), ['FAIL', 'PASS', 'FAIL', 'FAIL']);
  assert.equal(result.ready, false);
  assert.equal(result.productionActivationAttested, false);
  assert.equal(result.financialApiCalls, 0);
  assert.equal(JSON.stringify(result).includes('RAW_SECRET_DETAIL'), false);
});
test('offline success is not a production activation certificate and stages cannot be omitted or duplicated', async () => {
  const result = await collectOfflinePreflightStages([{ id: 'components', run: async () => undefined }]);
  assert.equal(result.ready, true);
  assert.equal(result.productionActivationAttested, false);
  for (const invalid of [[], [{ id: 'same', run() {} }, { id: 'same', run() {} }], [{ id: '../unsafe', run() {} }]]) {
    await assert.rejects(collectOfflinePreflightStages(invalid), /STAGE_CONTRACT_INVALID/u);
  }
});

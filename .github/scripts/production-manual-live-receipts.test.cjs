'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManualReceipt, inspectManualLiveReceipts } = require('./production-manual-live-receipts.cjs');
const sha = 'a'.repeat(40);
const deploy = '2026-10-12T00:00:00Z';
function receipt(kind = 'futures', leverage = '7') {
  return { id: 123, created_at: '2026-10-12T00:01:00Z', user: { login: 'github-actions[bot]', type: 'Bot' },
    body: [kind === 'spot' ? '[PRODUCTION_LIVE_TRADING_GATE]' : '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]',
      `status: ACTIVATED_${kind === 'spot' ? 'SPOT' : 'FUTURES'}_LIVE_LIMITED_MANUAL`, `target_sha: ${sha}`,
      ...(kind === 'spot' ? ['providers: kiwoom,toss,upbit', 'executionAuthority=SPOT_LIVE_LIMITED']
        : ['provider: bitget', `max_leverage: ${leverage}`, 'margin_mode: isolated', 'FUTURES_LIVE_EXECUTION_AUTHORITY=FUTURES_LIVE_LIMITED']),
      'AUTO_TRADING=false', 'LIVE_AUTOMATIC_TRADING_ENABLED=false', 'REAL_ORDER_SUBMITTED=false', 'workflow_run: 100'].join('\n') };
}
test('leverage receipt requires an entire 2..7 field, not a prefix or old 3x ceiling', () => {
  for (const value of ['2', '3', '4', '5', '6', '7']) assert.equal(parseManualReceipt(receipt('futures', value), 'futures', sha, deploy).leverage, value);
  for (const value of ['70', '7x', '8', '1', '7 extra']) assert.equal(parseManualReceipt(receipt('futures', value), 'futures', sha, deploy), null);
});
test('manual receipts reject forgery, stale SHA, duplicate fields and pre-deployment evidence', () => {
  const base = receipt();
  assert.equal(parseManualReceipt({ ...base, user: { login: 'owner', type: 'User' } }, 'futures', sha, deploy), null);
  assert.equal(parseManualReceipt({ ...base, created_at: '2026-10-11T23:59:00Z' }, 'futures', sha, deploy), null);
  assert.equal(parseManualReceipt(base, 'futures', 'b'.repeat(40), deploy), null);
  assert.equal(parseManualReceipt(base, 'futures', sha, 'invalid-date'), null);
  assert.equal(parseManualReceipt(base, 'futures', 'invalid-sha', deploy), null);
  assert.equal(parseManualReceipt({ ...base, body: base.body + '\nmax_leverage: 7' }, 'futures', sha, deploy), null);
});

test('both current receipts are accepted only with successful matching workflow runs', async () => {
  const context = { repo: { owner: 'owner', repo: 'repo' } };
  const spot = receipt('spot');
  const futures = { ...receipt('futures'), id: 124, body: receipt('futures').body.replace('workflow_run: 100', 'workflow_run: 101') };
  let conclusion = 'success';
  let headSha = sha;
  const github = { rest: { actions: { async getWorkflowRun({ run_id }) { return { data: {
    path: `.github/workflows/production-${run_id === 100 ? 'live' : 'futures-live'}-trading-gate.yml`,
    head_sha: headSha, head_branch: 'main', event: 'issue_comment', status: 'completed', conclusion,
    created_at: '2026-10-12T00:00:30Z', updated_at: '2026-10-12T00:01:01Z' } }; } } } };
  const input = { github, context, comments: [spot, futures], targetSha: sha, deploymentCompletedAt: deploy };
  const ready = await inspectManualLiveReceipts(input);
  assert.equal(ready.spot.commentId, 123);
  assert.equal(ready.futures.commentId, 124);
  assert.equal(ready.futures.leverage, '7');
  await assert.rejects(inspectManualLiveReceipts({ ...input, comments: [spot,
    { ...futures, body: futures.body.replace('max_leverage: 7', 'max_leverage: 3') }] }),
  /EXACT_FUTURES_MANUAL_RECEIPT_REQUIRED/);
  conclusion = 'failure';
  await assert.rejects(inspectManualLiveReceipts(input), /EXACT_SPOT_MANUAL_RECEIPT_REQUIRED/);
  conclusion = 'success';
  headSha = 'b'.repeat(40);
  await assert.rejects(inspectManualLiveReceipts(input), /EXACT_SPOT_MANUAL_RECEIPT_REQUIRED/);
});
test('receipt must reference a successful exact-SHA authentic workflow', async () => {
  const context = { repo: { owner: 'owner', repo: 'repo' } };
  let broken = false;
  const github = { rest: { actions: { async getWorkflowRun() { return { data: {
    path: broken ? '.github/workflows/other.yml' : '.github/workflows/production-live-trading-gate.yml',
    head_sha: sha, head_branch: 'main', event: 'issue_comment', status: 'completed', conclusion: 'success',
    created_at: '2026-10-12T00:00:30Z', updated_at: '2026-10-12T00:01:01Z' } }; } } } };
  const input = { github, context, comments: [receipt('spot')], targetSha: sha, deploymentCompletedAt: deploy };
  await assert.rejects(inspectManualLiveReceipts(input), /FUTURES_MANUAL/);
  broken = true;
  await assert.rejects(inspectManualLiveReceipts(input), /SPOT_MANUAL/);
});

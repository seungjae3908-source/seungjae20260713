import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kiwoomReadonlyRecoverySecurityFailures } from '../../api-server/scripts/kiwoom-readonly-recovery-security-contract.mjs';
const recovery = readFileSync('api-server/src/services/trade-order-recovery.service.ts', 'utf8');
const contract = readFileSync('api-server/src/services/kiwoom-readonly-order-recovery.service.ts', 'utf8');
test('security scan requires actual guarded readonly KR/US recovery, not an obsolete unverified-status marker', () => {
  assert.deepEqual(kiwoomReadonlyRecoverySecurityFailures(recovery, contract), []);
});
test('recovery security scan fails when transport, pagination, identity, unknown-cost or mutation guards are changed', () => {
  for (const [source, mutate] of [
    ['recovery', (s) => s.replace('readCompleteKiwoomOrderRows(request,', 'unsafeRead(request,')],
    ['contract', (s) => s.replace("request.method !== 'POST'", "request.method !== 'GET'")],
    ['contract', (s) => s.replace("rows: 'result_list'", "rows: 'result_lsit'")],
    ['contract', (s) => s.replace('seenKeys.has(key)', 'false')],
    ['contract', (s) => s.replace("throw new Error('KIWOOM_ORDER_STATUS_UNKNOWN')", 'return null')],
    ['contract', (s) => s.replace('feeAmount: null, feeCurrency: null', "feeAmount: 0, feeCurrency: 'KRW'")],
    ['contract', (s) => `${s}\nprepareKiwoomOrder(credentials, plan)`],
  ]) {
    assert.ok(kiwoomReadonlyRecoverySecurityFailures(source === 'recovery' ? mutate(recovery) : recovery,
      source === 'contract' ? mutate(contract) : contract).length > 0, `unsafe mutation not rejected: ${mutate}`);
  }
});

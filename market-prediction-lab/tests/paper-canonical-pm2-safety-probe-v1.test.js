import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePaperCanonicalPm2Safety,
  PAPER_CANONICAL_PM2_SAFETY_PROBE_VERSION,
} from '../../ops/check-paper-canonical-pm2-safety.mjs';

function row(overrides = {}) {
  return {
    name: 'stock-app',
    pm2_env: {
      status: 'online',
      LIVE_TRADING: 'false',
      AUTO_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
      executionAuthority: 'NONE',
      SECRET_DATABASE_URL: 'must-never-be-returned',
      ...overrides,
    },
  };
}

test('safe online stock-app is accepted without returning arbitrary PM2 environment', () => {
  const result = validatePaperCanonicalPm2Safety([row()]);
  assert.deepEqual(result, {
    schemaVersion: PAPER_CANONICAL_PM2_SAFETY_PROBE_VERSION,
    processOnline: true,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  });
  assert.equal('SECRET_DATABASE_URL' in result, false);
});

test('missing, duplicate, or offline process fails closed', () => {
  assert.throws(() => validatePaperCanonicalPm2Safety([]), /PAPER_CANONICAL_PM2_PROCESS_AMBIGUOUS_OR_MISSING/);
  assert.throws(() => validatePaperCanonicalPm2Safety([row(), row()]), /PAPER_CANONICAL_PM2_PROCESS_AMBIGUOUS_OR_MISSING/);
  assert.throws(() => validatePaperCanonicalPm2Safety([row({ status: 'stopped' })]), /PAPER_CANONICAL_PM2_PROCESS_NOT_ONLINE/);
});

test('every trading authority elevation is rejected', () => {
  for (const [key, value] of [
    ['LIVE_TRADING', 'true'],
    ['AUTO_TRADING', 'true'],
    ['REAL_ORDER_ENABLED', 'true'],
    ['PRIVATE_TRADING_API_ALLOWED', 'true'],
    ['executionAuthority', 'LIVE'],
  ]) {
    assert.throws(() => validatePaperCanonicalPm2Safety([row({ [key]: value })]));
  }
});

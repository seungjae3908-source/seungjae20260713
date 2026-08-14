import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PROVIDER_BY_MARKET,
  evaluateProviderPredeployReadiness,
  type ProviderPredeployEvidence,
} from './three-provider-predeploy-readiness.service';

function completeEvidence(overrides: Partial<ProviderPredeployEvidence> = {}): ProviderPredeployEvidence {
  return {
    market: 'KR_STOCK',
    provider: 'toss',
    userVaultConfigured: true,
    accountIdentityAvailable: true,
    providerPermissionsChecked: true,
    privateReadContractChecked: true,
    orderContractChecked: true,
    cancelContractChecked: true,
    reconciliationChecked: true,
    idempotencyChecked: true,
    riskGateChecked: true,
    killSwitchChecked: true,
    exactHeadCiChecked: true,
    ...overrides,
  };
}

test('provider authority contract', () => {
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.KR_STOCK, 'toss');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.US_STOCK, 'toss');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.CRYPTO_SPOT, 'upbit');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.CRYPTO_FUTURES, 'bitget');
});

test('wrong provider mapping fails closed', () => {
  const result = evaluateProviderPredeployReadiness(completeEvidence({ provider: 'upbit' }));
  assert.equal(result.readyForPredeployValidation, false);
  assert.deepEqual(result.blockers, ['CANONICAL_PROVIDER_MISMATCH']);
});

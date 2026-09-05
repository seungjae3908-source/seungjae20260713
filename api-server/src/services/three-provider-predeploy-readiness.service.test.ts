import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PROVIDER_BY_MARKET,
  evaluateProviderPredeployReadiness,
  type ProviderPredeployEvidence,
} from './three-provider-predeploy-readiness.service';

const completeEvidence: ProviderPredeployEvidence = {
  market: 'CRYPTO_FUTURES',
  provider: 'bitget',
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
};

test('canonical provider mapping remains fixed', () => {
  assert.deepEqual(CANONICAL_PROVIDER_BY_MARKET, {
    KR_STOCK: 'toss',
    US_STOCK: 'toss',
    CRYPTO_SPOT: 'upbit',
    CRYPTO_FUTURES: 'bitget',
  });
});

test('missing readiness evidence returns explicit blockers', () => {
  const result = evaluateProviderPredeployReadiness({
    ...completeEvidence,
    userVaultConfigured: false,
    accountIdentityAvailable: false,
    riskGateChecked: false,
  });
  assert.equal(result.readyForPredeployValidation, false);
  assert.deepEqual(result.blockers, [
    'USER_VAULT_NOT_CONFIGURED',
    'ACCOUNT_IDENTITY_NOT_AVAILABLE',
    'RISK_GATE_NOT_CHECKED',
  ]);
});

test('complete canonical evidence is predeploy-ready without granting live authority', () => {
  const result = evaluateProviderPredeployReadiness(completeEvidence);
  assert.equal(result.readyForPredeployValidation, true);
  assert.deepEqual(result.blockers, []);
  assert.equal('liveTradingReady' in result, false);
  assert.equal('realAccountConnected' in result, false);
});

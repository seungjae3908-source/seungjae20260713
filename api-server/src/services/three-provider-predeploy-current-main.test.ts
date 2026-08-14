import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerSupportsAction,
  providerSupportsDirection,
  providerSupportsMarket,
} from './canonical-provider-action-contract.service';
import {
  CANONICAL_PROVIDER_BY_MARKET,
  evaluateProviderPredeployReadiness,
  type ProviderPredeployEvidence,
} from './three-provider-predeploy-readiness.service';
import {
  TOSS_ENDPOINTS,
  TOSS_OPENAPI_CONTRACT_AUDITED_AT,
  TOSS_OPENAPI_INTEGRATION_STYLE,
  tossOrderCancelPath,
  tossOrderModifyPath,
  validateTossOrderContract,
} from './toss-openapi-contract.service';

function ready(overrides: Partial<ProviderPredeployEvidence> = {}): ProviderPredeployEvidence {
  return {
    market: 'KR_STOCK',
    provider: 'toss',
    userVaultConfigured: true,
    authenticatedUserScopeVerified: true,
    accountIdentityAvailable: true,
    accountBindingVerified: true,
    providerPermissionsChecked: true,
    privateReadContractChecked: true,
    privateCacheScopeVerified: true,
    serverCredentialFallbackDetected: false,
    credentialPlaintextReturned: false,
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

test('provider authority remains Toss/Toss/Upbit/Bitget with market-safe directions', () => {
  assert.deepEqual(CANONICAL_PROVIDER_BY_MARKET, {
    KR_STOCK: 'toss',
    US_STOCK: 'toss',
    CRYPTO_SPOT: 'upbit',
    CRYPTO_FUTURES: 'bitget',
  });
  assert.equal(providerSupportsMarket('toss', 'KR_STOCK'), true);
  assert.equal(providerSupportsMarket('toss', 'US_STOCK'), true);
  assert.equal(providerSupportsDirection('toss', 'BUY'), true);
  assert.equal(providerSupportsDirection('toss', 'SHORT'), false);
  assert.equal(providerSupportsDirection('upbit', 'SELL'), true);
  assert.equal(providerSupportsDirection('upbit', 'LONG'), false);
  assert.equal(providerSupportsDirection('bitget', 'LONG'), true);
  assert.equal(providerSupportsDirection('bitget', 'SHORT'), true);
  assert.equal(providerSupportsDirection('bitget', 'BUY'), false);
});

test('provider modification semantics do not conflate Upbit cancel-and-new with native modify', () => {
  assert.equal(providerSupportsAction('toss', 'ORDER_MODIFY'), true);
  assert.equal(providerSupportsAction('toss', 'ORDER_CANCEL_REPLACE'), false);
  assert.equal(providerSupportsAction('upbit', 'ORDER_CANCEL_REPLACE'), true);
  assert.equal(providerSupportsAction('upbit', 'ORDER_MODIFY'), false);
  assert.equal(providerSupportsAction('bitget', 'ORDER_MODIFY'), true);
  assert.equal(providerSupportsAction('bitget', 'ORDER_CANCEL_REPLACE'), false);
});

test('predeploy readiness requires per-user scope and forbids server provider credential fallback or plaintext return', () => {
  const mismatch = evaluateProviderPredeployReadiness(ready({ market: 'CRYPTO_SPOT', provider: 'toss' }));
  assert.equal(mismatch.readyForPredeployValidation, false);
  assert.ok(mismatch.blockers.includes('CANONICAL_PROVIDER_MISMATCH'));

  const unsafe = evaluateProviderPredeployReadiness(ready({
    authenticatedUserScopeVerified: false,
    accountBindingVerified: false,
    privateCacheScopeVerified: false,
    serverCredentialFallbackDetected: true,
    credentialPlaintextReturned: true,
  }));
  assert.equal(unsafe.readyForPredeployValidation, false);
  assert.ok(unsafe.blockers.includes('AUTHENTICATED_USER_SCOPE_NOT_VERIFIED'));
  assert.ok(unsafe.blockers.includes('USER_ACCOUNT_BINDING_NOT_VERIFIED'));
  assert.ok(unsafe.blockers.includes('PRIVATE_CACHE_SCOPE_NOT_VERIFIED'));
  assert.ok(unsafe.blockers.includes('SERVER_PROVIDER_CREDENTIAL_FALLBACK_FORBIDDEN'));
  assert.ok(unsafe.blockers.includes('CREDENTIAL_PLAINTEXT_RETURN_FORBIDDEN'));
  assert.equal(unsafe.privateTradingRequestAllowed, false);
  assert.equal(unsafe.liveActivationAllowed, false);
});

test('fully evidenced predeploy contract still grants no private or live authority', () => {
  for (const input of [
    ready(),
    ready({ market: 'US_STOCK', provider: 'toss' }),
    ready({ market: 'CRYPTO_SPOT', provider: 'upbit' }),
    ready({ market: 'CRYPTO_FUTURES', provider: 'bitget' }),
  ]) {
    const result = evaluateProviderPredeployReadiness(input);
    assert.equal(result.readyForPredeployValidation, true);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.privateTradingRequestAllowed, false);
    assert.equal(result.liveActivationAllowed, false);
  }
});

test('Toss contract is REST-only evidence with explicit create/modify/cancel endpoints and fail-closed order validation', () => {
  assert.equal(TOSS_OPENAPI_INTEGRATION_STYLE, 'REST');
  assert.equal(TOSS_OPENAPI_CONTRACT_AUDITED_AT, '2026-08-14');
  assert.equal(TOSS_ENDPOINTS.orders, '/api/v1/orders');
  assert.equal(tossOrderModifyPath('order-1'), '/api/v1/orders/order-1/modify');
  assert.equal(tossOrderCancelPath('order-1'), '/api/v1/orders/order-1/cancel');

  const valid = validateTossOrderContract({
    marketCountry: 'KR',
    symbol: '005930',
    side: 'BUY',
    orderType: 'LIMIT',
    quantity: '1',
    price: '70000',
  });
  assert.equal(valid.valid, true);

  const invalid = validateTossOrderContract({
    marketCountry: 'KR',
    symbol: '005930',
    side: 'BUY',
    orderType: 'MARKET',
    orderAmount: '100000',
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes('TOSS_AMOUNT_ORDER_US_MARKET_ONLY'));
});

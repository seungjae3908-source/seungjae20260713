export type CanonicalTradingProvider = 'toss' | 'upbit' | 'bitget';
export type CanonicalTradingMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export const CANONICAL_PROVIDER_BY_MARKET: Readonly<Record<CanonicalTradingMarket, CanonicalTradingProvider>> = Object.freeze({
  KR_STOCK: 'toss',
  US_STOCK: 'toss',
  CRYPTO_SPOT: 'upbit',
  CRYPTO_FUTURES: 'bitget',
});

export type ProviderPredeployEvidence = {
  market: CanonicalTradingMarket;
  provider: CanonicalTradingProvider;
  userVaultConfigured: boolean;
  accountIdentityAvailable: boolean;
  providerPermissionsChecked: boolean;
  privateReadContractChecked: boolean;
  orderContractChecked: boolean;
  cancelContractChecked: boolean;
  reconciliationChecked: boolean;
  idempotencyChecked: boolean;
  riskGateChecked: boolean;
  killSwitchChecked: boolean;
  exactHeadCiChecked: boolean;
};

export type ProviderPredeployResult = {
  market: CanonicalTradingMarket;
  provider: CanonicalTradingProvider;
  readyForPredeployValidation: boolean;
  blockers: string[];
};

export function evaluateProviderPredeployReadiness(input: ProviderPredeployEvidence): ProviderPredeployResult {
  const blockers: string[] = [];
  if (CANONICAL_PROVIDER_BY_MARKET[input.market] !== input.provider) blockers.push('CANONICAL_PROVIDER_MISMATCH');
  if (!input.userVaultConfigured) blockers.push('USER_VAULT_NOT_CONFIGURED');
  if (!input.accountIdentityAvailable) blockers.push('ACCOUNT_IDENTITY_NOT_AVAILABLE');
  if (!input.providerPermissionsChecked) blockers.push('PROVIDER_PERMISSIONS_NOT_CHECKED');
  if (!input.privateReadContractChecked) blockers.push('PRIVATE_READ_CONTRACT_NOT_CHECKED');
  if (!input.orderContractChecked) blockers.push('ORDER_CONTRACT_NOT_CHECKED');
  if (!input.cancelContractChecked) blockers.push('CANCEL_CONTRACT_NOT_CHECKED');
  if (!input.reconciliationChecked) blockers.push('RECONCILIATION_NOT_CHECKED');
  if (!input.idempotencyChecked) blockers.push('IDEMPOTENCY_NOT_CHECKED');
  if (!input.riskGateChecked) blockers.push('RISK_GATE_NOT_CHECKED');
  if (!input.killSwitchChecked) blockers.push('KILL_SWITCH_NOT_CHECKED');
  if (!input.exactHeadCiChecked) blockers.push('EXACT_HEAD_CI_NOT_CHECKED');
  return {
    market: input.market,
    provider: input.provider,
    readyForPredeployValidation: blockers.length === 0,
    blockers,
  };
}

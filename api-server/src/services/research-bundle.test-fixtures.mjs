// TEST_ONLY #769 sizing fixture. No Paper orders; economic credit: 0.
import { compiledMomentumFormula } from '../../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import { createPaperTradingState } from './paper-trading-core.service.ts';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service.ts';
const AUTHORITATIVE_NOW_MS = Date.parse('2026-08-28T04:30:00.000Z');
const AUTHORITATIVE_RESEARCH_SHA = 'a'.repeat(40);
const AUTHORITATIVE_PAPER_SHA = 'b'.repeat(40);
const AUTHORITATIVE_ACCOUNT_BINDING = 'c'.repeat(64);

function authoritativeSnapshot(
  market,
  observedAtMs = AUTHORITATIVE_NOW_MS - 1_000,
  maximumAgeMs = 30_000,
) {
  const state = createPaperTradingState(10_000, new Date(observedAtMs));
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'authoritative-paper-risk-sizing-test',
    sourceSha: AUTHORITATIVE_PAPER_SHA,
    market,
    currency: market === 'US_STOCK' ? 'USD' : market === 'CRYPTO_FUTURES' ? 'USDT' : 'KRW',
    provenance: ['TEST_AUTHORITATIVE_PAPER_STATE'],
    publisherAccountIdSha256: AUTHORITATIVE_ACCOUNT_BINDING,
    observedAtMs,
    maximumAgeMs,
  });
}

function authoritativeSizingInput(
  market = 'CRYPTO_FUTURES',
  symbol = 'BTCUSDT',
) {
  const observedAtMs = AUTHORITATIVE_NOW_MS - 1_000;
  const snapshot = authoritativeSnapshot(market, observedAtMs);
  const isFutures = market === 'CRYPTO_FUTURES';
  const isStock = market === 'KR_STOCK' || market === 'US_STOCK';
  const quantityStep = isStock ? 1 : 0.001;
  const quantityPrecision = isStock ? 0 : 3;
  return {
    market,
    symbol,
    strategyScope: 'swing',
    side: 'LONG',
    researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
    paperStateSourceSha: AUTHORITATIVE_PAPER_SHA,
    paperAccountId: snapshot.accountId,
    riskPolicy: {
      schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1',
      policyId: 'TEST_EXPLICIT_POLICY',
      policyVersion: 'v1',
      source: 'TEST_EXPLICIT_RISK_POLICY_SOURCE',
      provenance: ['TEST_POLICY_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
      marketScopes: [market],
      strategyScopes: ['swing'],
      symbolScopes: [symbol],
      riskPercent: 0.5,
      requestedLeverage: isFutures ? 2 : 1,
      maximumLeverage: isFutures ? 5 : null,
      marginMode: isFutures ? 'isolated' : 'cash',
    },
    paperStateSnapshot: snapshot,
    contractRulesEvidence: {
      schemaVersion: 'authoritative-paper-contract-rules-evidence-v1',
      ruleVersion: 'TEST_RULES_V1',
      market,
      symbol,
      source: 'TEST_CANONICAL_CONTRACT_RULES',
      provenance: ['TEST_CONTRACT_RULES_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      rules: {
        symbol,
        quantityStep,
        quantityPrecision,
        minimumQuantity: quantityStep,
        minimumNotional: 1,
        maximumLeverage: isFutures ? 50 : null,
        maintenanceMarginRate: isFutures ? 0.005 : null,
        status: 'live',
        updatedAt: new Date(observedAtMs).toISOString(),
        warnings: [],
      },
    },
    marketEvidence: {
      schemaVersion: 'authoritative-paper-market-risk-evidence-v1',
      market,
      symbol,
      entryPrice: 100,
      stopLossPrice: 99,
      source: 'TEST_PUBLIC_MARKET_EVIDENCE',
      provenance: ['TEST_MARKET_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      status: 'live',
    },
    costEvidence: {
      schemaVersion: 'authoritative-paper-risk-cost-evidence-v1',
      market,
      symbol,
      source: 'TEST_EXECUTION_COST_EVIDENCE',
      provenance: ['TEST_COST_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      slippageRate: 0.0005,
      estimatedFundingRate: isFutures ? 0.0001 : 0,
    },
  };
}


export { compiledMomentumFormula, authoritativeSizingInput, AUTHORITATIVE_NOW_MS };

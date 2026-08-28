import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const producerSource = await readFile(new URL(
  '../../api-server/src/services/authoritative-paper-generic-risk-policy-producer.service.ts',
  import.meta.url,
), 'utf8');
const canonicalRiskSource = await readFile(new URL(
  '../../api-server/src/services/trading-risk-engine.service.ts',
  import.meta.url,
), 'utf8');
const consumerSource = await readFile(new URL(
  '../../api-server/src/services/authoritative-paper-risk-sizing-source.service.ts',
  import.meta.url,
), 'utf8');

test('P0 generic risk producer derives financial policy only from canonical TRADING_RISK_POLICY', () => {
  assert.match(producerSource, /TRADING_RISK_POLICY\.riskWarningPercent/u);
  assert.match(producerSource, /TRADING_RISK_POLICY\.maximumRiskPercent/u);
  assert.match(producerSource, /TRADING_RISK_POLICY\.cryptoFuturesAppMaximumLeverage/u);
  assert.match(canonicalRiskSource, /riskWarningPercent:\s*0\.5/u);
  assert.match(canonicalRiskSource, /maximumRiskPercent:\s*1/u);
  assert.match(canonicalRiskSource, /cryptoFuturesAppMaximumLeverage:\s*10/u);
  assert.doesNotMatch(producerSource, /requestedLeverage:\s*(?:[2-9]|[1-9]\d+)/u);
  assert.match(producerSource, /requestedLeverage:\s*1/u);
  assert.match(producerSource, /leverageEscalationAllowed:\s*false/u);
});

test('P0 generic risk producer emits exactly the schema consumed by merged risk sizing source', () => {
  assert.match(producerSource, /authoritative-paper-generic-risk-policy-evidence-v1/u);
  assert.match(consumerSource, /schemaVersion:\s*'authoritative-paper-generic-risk-policy-evidence-v1'/u);
  assert.match(producerSource, /marketScopes:\s*Object\.freeze\(\[request\.market\]\)/u);
  assert.match(producerSource, /strategyScopes:\s*Object\.freeze\(\[request\.strategyScope\.trim\(\)\]\)/u);
  assert.match(producerSource, /genericSymbolFallback:\s*'\*'/u);
  assert.match(producerSource, /researchCodeSha/u);
  assert.match(producerSource, /EXACT_RESEARCH_SHA_REQUIRED/u);
});

test('P0 generic risk producer is cash-only outside futures and conservative isolated 1x for futures', () => {
  assert.match(producerSource, /const futures = request\.market === 'CRYPTO_FUTURES'/u);
  assert.match(producerSource, /maximumLeverage:\s*futures[\s\S]*TRADING_RISK_POLICY\.cryptoFuturesAppMaximumLeverage[\s\S]*:\s*null/u);
  assert.match(producerSource, /marginMode:\s*futures \? 'isolated' as const : 'cash' as const/u);
  assert.doesNotMatch(producerSource, /marginMode:\s*'cross'/u);
  assert.doesNotMatch(producerSource, /BTC|ETH|SOL|005930|AAPL/u);
  assert.match(producerSource, /fabricatedPairPolicyAllowed:\s*false/u);
});

test('P0 generic risk producer remains executionless and fail-closed', () => {
  for (const contract of [
    /executionAuthority:\s*'NONE'/u,
    /privateApiAllowed:\s*false/u,
    /liveTrading:\s*false/u,
    /realOrderAllowed:\s*false/u,
    /financialMutationAllowed:\s*false/u,
  ]) assert.match(producerSource, contract);
  assert.match(producerSource, /AUTHORITATIVE_GENERIC_RISK_POLICY_MARKET_UNSUPPORTED/u);
  assert.match(producerSource, /AUTHORITATIVE_GENERIC_RISK_POLICY_STRATEGY_SCOPE_REQUIRED/u);
  assert.match(producerSource, /AUTHORITATIVE_GENERIC_RISK_POLICY_SYMBOL_SCOPE_INVALID/u);
  assert.match(producerSource, /AUTHORITATIVE_GENERIC_RISK_POLICY_CANONICAL_AUTHORITY_INVALID/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const producerSource = await readFile(new URL(
  '../../api-server/src/services/authoritative-paper-generic-risk-policy-producer.service.ts',
  import.meta.url,
), 'utf8');
const consumerSource = await readFile(new URL(
  '../../api-server/src/services/authoritative-paper-risk-sizing-source.service.ts',
  import.meta.url,
), 'utf8');

test('P0 generic risk producer requires an explicit canonical policy record instead of synthesizing financial choices', () => {
  assert.match(producerSource, /authoritative-paper-generic-risk-policy-record-v1/u);
  assert.match(producerSource, /readCanonicalRecord/u);
  assert.match(producerSource, /explicitCanonicalRecordRequired:\s*true/u);
  assert.match(producerSource, /engineGuardrailsArePolicyEvidence:\s*false/u);
  assert.doesNotMatch(producerSource, /TRADING_RISK_POLICY/u);
  assert.doesNotMatch(producerSource, /riskWarningPercent/u);
  assert.doesNotMatch(producerSource, /cryptoFuturesAppMaximumLeverage/u);
  assert.doesNotMatch(producerSource, /riskPercent:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)/u);
  assert.doesNotMatch(producerSource, /requestedLeverage:\s*1/u);
  assert.doesNotMatch(producerSource, /marginMode:\s*(?:'cash'|'isolated'|'cross')/u);
});

test('P0 generic risk producer fails closed when canonical record evidence is absent or unusable', () => {
  assert.match(producerSource, /RISK_POLICY_CANONICAL_RECORD_MISSING/u);
  assert.match(producerSource, /RISK_POLICY_CANONICAL_RECORD_SOURCE_ERROR/u);
  assert.match(producerSource, /RISK_POLICY_CANONICAL_RECORD_SCHEMA_INVALID/u);
  assert.match(producerSource, /RISK_POLICY_CANONICAL_RECORD_RESEARCH_SHA_MISMATCH/u);
  assert.match(producerSource, /RISK_POLICY_CANONICAL_RECORD_POLICY_EVIDENCE_MISSING/u);
  assert.match(producerSource, /status:\s*'BLOCKED_DATA'/u);
  assert.match(producerSource, /policyEvidence:\s*null/u);
});

test('P0 generic risk producer delegates complete policy validation and sizing to merged #769', () => {
  assert.match(producerSource, /buildAuthoritativePaperRiskSizingEvidence/u);
  assert.match(producerSource, /riskPolicy:\s*policySource\.policyEvidence/u);
  assert.match(producerSource, /canonicalConsumerValidationRequired:\s*true/u);
  assert.match(producerSource, /riskSizingConsumer:\s*'authoritative-paper-risk-sizing-source\.service\.ts'/u);
  assert.match(consumerSource, /RISK_POLICY_MISSING/u);
  assert.match(consumerSource, /RISK_POLICY_RISK_PERCENT_INVALID/u);
  assert.match(consumerSource, /RISK_POLICY_REQUESTED_LEVERAGE_MISSING_OR_INVALID/u);
  assert.match(consumerSource, /RISK_POLICY_MARGIN_MODE_INVALID/u);
  assert.match(consumerSource, /riskPercentDefaultAllowed:\s*false/u);
  assert.match(consumerSource, /leverageDefaultAllowed:\s*false/u);
});

test('P0 generic risk producer preserves identity/provenance without manufacturing policy values', () => {
  assert.match(producerSource, /recordId/u);
  assert.match(producerSource, /recordVersion/u);
  assert.match(producerSource, /persistedAtMs/u);
  assert.match(producerSource, /researchCodeSha/u);
  assert.match(producerSource, /canonicalRecord:/u);
  assert.match(producerSource, /recordVersion:/u);
  assert.match(producerSource, /riskPercentDefaultAllowed:\s*false/u);
  assert.match(producerSource, /requestedLeverageDefaultAllowed:\s*false/u);
  assert.match(producerSource, /marginModeDefaultAllowed:\s*false/u);
  assert.match(producerSource, /maximumLeverageDefaultAllowed:\s*false/u);
  assert.match(producerSource, /wildcardSymbolDefaultAllowed:\s*false/u);
});

test('P0 generic risk producer and bridge remain executionless', () => {
  for (const contract of [
    /executionAuthority:\s*'NONE'/u,
    /privateApiAllowed:\s*false/u,
    /liveTrading:\s*false/u,
    /realOrderAllowed:\s*false/u,
    /financialMutationAllowed:\s*false/u,
  ]) assert.match(producerSource, contract);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_VALIDATION_SCHEMA, sanitizeRuleValidationReport } from './rule-validation-report.service';
import { RULE_VALIDATION_SNAPSHOT } from './rule-validation-report.snapshot';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('the recorded snapshot passes its own validation and has no passing rule', () => {
  const report = sanitizeRuleValidationReport(clone(RULE_VALIDATION_SNAPSHOT));
  assert.ok(report);
  assert.equal(report.schemaVersion, RULE_VALIDATION_SCHEMA);
  assert.equal(report.passedRuleCount, 0);
  assert.equal(report.executionAuthority, 'NONE');
  assert.equal(report.profitabilityProven, false);
});

test('a report claiming execution authority or proven profit is rejected', () => {
  const authority = clone(RULE_VALIDATION_SNAPSHOT) as unknown as Record<string, unknown>;
  authority.executionAuthority = 'LIVE';
  assert.equal(sanitizeRuleValidationReport(authority), null);
  const proven = clone(RULE_VALIDATION_SNAPSHOT) as unknown as Record<string, unknown>;
  proven.profitabilityProven = true;
  assert.equal(sanitizeRuleValidationReport(proven), null);
});

test('the headline pass count cannot disagree with the rows', () => {
  const report = clone(RULE_VALIDATION_SNAPSHOT);
  report.studies[0].rows[0].verdict = 'pass';
  assert.equal(sanitizeRuleValidationReport(report), null);
  report.passedRuleCount = 1;
  assert.ok(sanitizeRuleValidationReport(report));
});

test('non-finite numbers and out-of-range win rates are rejected', () => {
  const nan = clone(RULE_VALIDATION_SNAPSHOT);
  nan.studies[0].rows[0].train!.expectancyPercent = Number.NaN;
  assert.equal(sanitizeRuleValidationReport(nan), null);
  const range = clone(RULE_VALIDATION_SNAPSHOT);
  range.studies[0].rows[0].train!.winRate = 1.2;
  assert.equal(sanitizeRuleValidationReport(range), null);
  const negativeN = clone(RULE_VALIDATION_SNAPSHOT);
  negativeN.studies[0].rows[0].train!.n = -1;
  assert.equal(sanitizeRuleValidationReport(negativeN), null);
});

test('text containing server paths or secrets is rejected', () => {
  const path = clone(RULE_VALIDATION_SNAPSHOT);
  path.studies[0].note = '결과는 /root/ev-research/result.json 에 있음';
  assert.equal(sanitizeRuleValidationReport(path), null);
  const key = clone(RULE_VALIDATION_SNAPSHOT);
  key.summary = 'ghp_abcdef123456';
  assert.equal(sanitizeRuleValidationReport(key), null);
});

test('unknown markets, verdicts and wrong schema versions are rejected', () => {
  const market = clone(RULE_VALIDATION_SNAPSHOT) as unknown as { studies: Array<Record<string, unknown>> };
  market.studies[0].market = 'CRYPTO_FUTURES';
  assert.equal(sanitizeRuleValidationReport(market), null);
  const verdict = clone(RULE_VALIDATION_SNAPSHOT) as unknown as { studies: Array<{ rows: Array<Record<string, unknown>> }> };
  verdict.studies[0].rows[0].verdict = 'great';
  assert.equal(sanitizeRuleValidationReport(verdict), null);
  const schema = clone(RULE_VALIDATION_SNAPSHOT) as unknown as Record<string, unknown>;
  schema.schemaVersion = 'other';
  assert.equal(sanitizeRuleValidationReport(schema), null);
  assert.equal(sanitizeRuleValidationReport(null), null);
  assert.equal(sanitizeRuleValidationReport('text'), null);
});

test('the sanitized output drops unknown fields', () => {
  const report = clone(RULE_VALIDATION_SNAPSHOT) as unknown as Record<string, unknown>;
  report.apiKey = 'should-not-pass-through';
  const result = sanitizeRuleValidationReport(report) as unknown as Record<string, unknown>;
  assert.ok(result);
  assert.equal('apiKey' in result, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleValidationHandler } from './research-rule-validation';

function run(handler: ReturnType<typeof createRuleValidationHandler>) {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const res = {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    status(code: number) { status = code; return res; },
    json(value: unknown) { body = value; return res; },
  };
  handler({} as never, res as never, (() => undefined) as never);
  return { headers, status, body: body as Record<string, unknown> };
}

test('serves the validated snapshot with no-store headers', () => {
  const { headers, status, body } = run(createRuleValidationHandler());
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store, max-age=0');
  assert.equal(body.schemaVersion, 'rule-validation-report-v1');
  assert.equal(body.passedRuleCount, 0);
  assert.equal(body.executionAuthority, 'NONE');
});

test('an invalid snapshot is never served', () => {
  const { status, body } = run(createRuleValidationHandler(() => ({ schemaVersion: 'bad' })));
  assert.equal(status, 503);
  assert.equal(body.error, 'RULE_VALIDATION_UNAVAILABLE');
  assert.equal(body.executionAuthority, 'NONE');
});

test('a loader that throws is reported as unavailable', () => {
  const { status } = run(createRuleValidationHandler(() => { throw new Error('boom'); }));
  assert.equal(status, 503);
});

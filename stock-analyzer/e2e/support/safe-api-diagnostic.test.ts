import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSafeApiDiagnostic } from './safe-api-diagnostic';

function response(status: number, body: unknown) {
  return {
    status: () => status,
    json: async () => body,
  };
}

test('records only allowlisted preview failure fields', async () => {
  const diagnostic = await collectSafeApiDiagnostic(response(503, {
    ok: false,
    error: {
      code: 'JOURNAL_STORAGE_UNAVAILABLE',
      message: '거래일지 저장소를 처리하지 못했습니다.',
      stack: 'must never be copied',
      sql: 'select secret',
    },
    externalAiCalled: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    accessToken: 'must never be copied',
  }), {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
  });

  assert.deepEqual(diagnostic, {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
    status: 503,
    errorCode: 'JOURNAL_STORAGE_UNAVAILABLE',
    safeMessage: '거래일지 저장소를 처리하지 못했습니다.',
    externalAiCalled: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /(?:stack|sql|accessToken|must never|secret)/i);
});

test('unknown error code and message fail closed', async () => {
  const diagnostic = await collectSafeApiDiagnostic(response(500, {
    error: { code: 'PRIVATE_INTERNAL_ERROR', message: 'database password leaked' },
    externalAiCalled: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  }), {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
  });

  assert.equal(diagnostic.errorCode, 'UNRECOGNIZED_ERROR_CODE');
  assert.equal(diagnostic.safeMessage, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_INTERNAL_ERROR|database password leaked/i);
});

test('non-JSON response records status without raw response text', async () => {
  const diagnostic = await collectSafeApiDiagnostic({
    status: () => 502,
    json: async () => { throw new Error('html contained credential'); },
  }, {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
  });

  assert.deepEqual(diagnostic, {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
    status: 502,
    errorCode: 'NON_JSON_RESPONSE',
    safeMessage: null,
    externalAiCalled: null,
    orderSubmitted: null,
    exchangeRequestSent: null,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /html|credential/i);
});

test('successful preview retains only safety booleans', async () => {
  const diagnostic = await collectSafeApiDiagnostic(response(200, {
    ok: true,
    result: { dataset: { representativeTrades: [{ private: 'not copied' }] } },
    externalAiCalled: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  }), {
    testStep: 'regular-ai-preview',
    requestPath: '/api/paper-journal/ai-review/preview',
  });

  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.errorCode, null);
  assert.equal(diagnostic.safeMessage, null);
  assert.equal(diagnostic.externalAiCalled, false);
  assert.equal(diagnostic.orderSubmitted, false);
  assert.equal(diagnostic.exchangeRequestSent, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /representativeTrades|private|not copied/i);
});

test('unrecognized path and step are not copied into diagnostics', async () => {
  const diagnostic = await collectSafeApiDiagnostic(response(401, {
    error: 'LOGIN_REQUIRED',
  }), {
    testStep: 'token=secret-value',
    requestPath: '/api/private?authorization=secret-value',
  });

  assert.equal(diagnostic.testStep, 'unrecognized-step');
  assert.equal(diagnostic.requestPath, 'unrecognized-path');
  assert.equal(diagnostic.errorCode, 'LOGIN_REQUIRED');
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-value|authorization|token=/i);
});

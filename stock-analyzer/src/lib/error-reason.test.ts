import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeError,
  describeErrorText,
  errorCodeOf,
  isChunkLoadError,
  looksLikeDeveloperCode,
} from './error-reason';

test('known codes map to Korean title, reason and action', () => {
  const described = describeError({ code: 'BACKTEST_EXECUTION_FAILED', status: 500 });
  assert.equal(described.code, 'BACKTEST_EXECUTION_FAILED');
  assert.match(described.title, /백테스트/);
  assert.match(described.reason, /[가-힣]/);
  assert.match(described.action, /[가-힣]/);
  assert.equal(described.title.includes('BACKTEST'), false);
});

test('http status and transport failures are normalized', () => {
  assert.equal(errorCodeOf({ status: 503 }), 'HTTP_503');
  assert.equal(errorCodeOf(new TypeError('Failed to fetch')), 'NETWORK_ERROR');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { name: 'AbortError' })), 'REQUEST_TIMEOUT');
  assert.equal(errorCodeOf(new Error('INVALID_STOCK_INFO_RESPONSE')), 'INVALID_STOCK_INFO_RESPONSE');
  assert.equal(errorCodeOf(new Error('사람이 읽는 문장')), null);
  assert.match(describeError({ status: 504 }).title, /시간/);
  assert.match(describeError('HTTP_599').title, /서버/);
});

test('unknown codes fall back to the page-provided title and never surface the raw code', () => {
  const described = describeError(new Error('SOMETHING_ODD_HAPPENED'), { fallbackTitle: '검색기를 실행하지 못했습니다' });
  assert.equal(described.title, '검색기를 실행하지 못했습니다');
  assert.equal(described.code, 'SOMETHING_ODD_HAPPENED');
  assert.equal(describeErrorText(new Error('SOMETHING_ODD_HAPPENED')).includes('SOMETHING_ODD_HAPPENED'), false);
});

test('a Korean server message is used as the reason, a developer message is not', () => {
  assert.equal(
    describeError({ code: 'HTTP_503' }, { message: '재무 제공기관 응답 지연' }).reason,
    '재무 제공기관 응답 지연',
  );
  const developer = describeError({ code: 'HTTP_503' }, { message: 'REQUEST TIMEOUT · unavailable' });
  assert.equal(developer.reason.includes('REQUEST'), false);
});

test('chunk load failures are recognized', () => {
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js')), true);
  assert.equal(isChunkLoadError(new TypeError("'text/html' is not a valid JavaScript MIME type.")), true);
  assert.equal(isChunkLoadError(new Error('boom')), false);
  assert.equal(errorCodeOf(new TypeError('Importing a module script failed.')), 'CHUNK_LOAD_FAILED');
});

test('developer-looking text detection', () => {
  assert.equal(looksLikeDeveloperCode('REST_ONLY'), true);
  assert.equal(looksLikeDeveloperCode('REQUEST TIMEOUT · unavailable'), true);
  assert.equal(looksLikeDeveloperCode('데이터 지연'), false);
  assert.equal(looksLikeDeveloperCode(''), false);
});

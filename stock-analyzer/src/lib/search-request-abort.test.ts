import test from 'node:test';
import assert from 'node:assert/strict';
import { isSearchRequestAbort } from './search-request-abort';

test('search request abort classifier accepts an aborted owning signal', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    isSearchRequestAbort(new TypeError('Failed to fetch'), controller.signal),
    true,
  );
});

test('search request abort classifier accepts AbortError without a signal', () => {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  assert.equal(isSearchRequestAbort(error), true);
});

test('search request abort classifier keeps non-aborted Failed to fetch observable', () => {
  const controller = new AbortController();
  assert.equal(
    isSearchRequestAbort(new TypeError('Failed to fetch'), controller.signal),
    false,
  );
});

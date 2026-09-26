import { expect, test } from '@playwright/test';
import { isSearchRequestAbort } from '../src/lib/search-request-abort';

test('Search cancellation accepts an aborted owning signal', () => {
  const controller = new AbortController();
  controller.abort();

  expect(
    isSearchRequestAbort(new TypeError('Failed to fetch'), controller.signal),
  ).toBe(true);
});

test('Search cancellation accepts AbortError without a signal', () => {
  const error = new Error('request aborted');
  error.name = 'AbortError';

  expect(isSearchRequestAbort(error)).toBe(true);
});

test('Search cancellation keeps non-aborted Failed to fetch observable', () => {
  const controller = new AbortController();

  expect(
    isSearchRequestAbort(new TypeError('Failed to fetch'), controller.signal),
  ).toBe(false);
});

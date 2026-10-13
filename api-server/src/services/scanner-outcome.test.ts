import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveScannerOutcome, type ScannerResponse } from './scanner-signal.types';

type OutcomePage = Pick<ScannerResponse, 'cards' | 'failures' | 'dataState' | 'universe' | 'execution'>;
function page(): OutcomePage {
  return { cards: [], failures: [], dataState: 'complete',
    universe: { totalCount: 1200, cursor: 0, nextCursor: 20, source: 'nasdaq-trader-public-directory', partial: false, stale: false,
      listingStatusCoverage: 'listed-or-unknown' },
    execution: { requestedCount: 20, startedCount: 20, completedCount: 20, dataSuccessCount: 20,
      insufficientDataCount: 0, providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false, cancelled: false,
      duplicate: false, elapsedMs: 1, deadlineMs: 9000, itemTimeoutMs: 4000, maxConcurrency: 6, staleCount: 0, excludedCount: 20 },
  };
}
test('only a completed trusted page can claim zero signals; blocked/partial/stale is missing evidence', () => {
  assert.equal(deriveScannerOutcome(page()), 'VALID_ZERO_SIGNAL');
  for (const mutate of [(p: OutcomePage) => { p.dataState = 'untrusted'; },
    (p: OutcomePage) => { p.dataState = 'stale'; }, (p: OutcomePage) => { p.universe.partial = true; },
    (p: OutcomePage) => { p.execution.partial = true; }, (p: OutcomePage) => { p.execution.cancelled = true; },
    (p: OutcomePage) => { p.execution.completedCount = 19; }]) {
    const p = page(); mutate(p); assert.equal(deriveScannerOutcome(p), 'DATA_QUALITY_REJECT');
  }
});
test('specific mapping, timeout, provider and filter reasons remain distinct', () => {
  const timeout = page(); timeout.execution.timeoutCount = 1;
  assert.equal(deriveScannerOutcome(timeout), 'REQUEST_TIMEOUT');
  const provider = page(); provider.execution.providerErrorCount = 1; provider.execution.dataSuccessCount = 0;
  assert.equal(deriveScannerOutcome(provider), 'PROVIDER_FAILURE');
  const filter = page(); filter.execution.hardFilterRejectedCount = 20;
  assert.equal(deriveScannerOutcome(filter), 'FILTER_TOO_STRICT');
  const mapping = page(); mapping.failures = [{ symbol: 'INVALID', reason: 'symbol_mapping', message: 'SYMBOL_MAPPING_FAILURE' }];
  assert.equal(deriveScannerOutcome(mapping), 'SYMBOL_MAPPING_FAILURE');
});

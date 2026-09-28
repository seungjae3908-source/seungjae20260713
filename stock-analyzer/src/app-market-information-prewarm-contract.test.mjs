import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('futures market-information prewarm is capability-gated', () => {
  const start = appSource.indexOf('async function prewarmPrimaryMarketInformation');
  const end = appSource.indexOf('function DirectAiChartDataPrewarm', start);
  assert.ok(start >= 0 && end > start, 'prewarmPrimaryMarketInformation source must exist');
  const prewarm = appSource.slice(start, end);

  const guardIndex = prewarm.indexOf('if (includeFutures)');
  const futuresIndex = prewarm.indexOf("prefetchMarketInformationRoom(queryClient, '/coins/futures')");
  assert.ok(guardIndex >= 0, 'futures prewarm must have an explicit capability-derived guard');
  assert.ok(futuresIndex > guardIndex, 'futures prewarm must occur only inside the guard');

  assert.match(
    appSource,
    /prewarmPrimaryMarketInformation\(auth\.can\('canAccessFutures'\)\)/,
    'authenticated app must derive futures prewarm permission from canAccessFutures',
  );
  assert.match(
    appSource,
    /\[auth\.isApproved, auth\.membershipLevel\]/,
    'prewarm effect must re-evaluate when membership capability changes',
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('removed market-information rooms are no longer prewarmed', () => {
  assert.doesNotMatch(appSource, /prewarmPrimaryMarketInformation|prefetchMarketInformationRoom|@\/pages\/market-information/);
  assert.match(
    appSource,
    /\[auth\.isApproved, auth\.membershipLevel\]/,
    'route preload effect must re-evaluate when membership capability changes',
  );
});

test('strategy promotion route chunk is preloaded for approved sessions', () => {
  assert.match(
    appSource,
    /const loadStrategyPromotionPage = \(\) => import\('@\/pages\/strategy-promotion'\);/,
    'strategy promotion must expose a reusable lazy loader',
  );
  const effectStart = appSource.indexOf('void Promise.allSettled([');
  const effectEnd = appSource.indexOf(']).catch(() => undefined)', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, 'approved-session route preload effect must exist');
  const routePreloads = appSource.slice(effectStart, effectEnd);
  assert.match(
    routePreloads,
    /loadStrategyPromotionPage\(\)/,
    'strategy promotion chunk must preload before Production route sweeps reach it',
  );
});

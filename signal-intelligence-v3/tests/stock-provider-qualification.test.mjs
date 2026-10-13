import assert from 'node:assert/strict';
import test from 'node:test';

import {
  qualifyStockProviders,
  selectQualifiedStockPriceProvider,
} from '../src/stock-provider-qualification.mjs';

const observedAt = '2026-10-13T06:00:00.000Z';

test('never connects a stock provider from HTTP reachability alone', () => {
  const observations = {
    YAHOO_CHART: { httpStatus: 200, payloadValidated: true, observedAt, usageTermsConfirmed: false },
  };
  assert.equal(selectQualifiedStockPriceProvider({ market: 'US_STOCK', observations }), null);
  const yahoo = qualifyStockProviders(observations).find((row) => row.provider === 'YAHOO_CHART');
  assert.equal(yahoo.actualQueryVerified, true);
  assert.equal(yahoo.connectable, false);
  assert.ok(yahoo.blockers.includes('USAGE_TERMS_NOT_CONFIRMED'));
});

test('represents an unobserved provider as explicit false rather than null', () => {
  const toss = qualifyStockProviders({}).find((row) => row.provider === 'TOSS_INVEST');
  assert.equal(toss.actualQueryVerified, false);
  assert.equal(toss.connectable, false);
});

test('Nasdaq Trader is valid for universe only and cannot be selected as a candle feed', () => {
  const observations = {
    NASDAQ_TRADER: { httpStatus: 200, payloadValidated: true, observedAt, usageTermsConfirmed: true },
  };
  const nasdaq = qualifyStockProviders(observations).find((row) => row.provider === 'NASDAQ_TRADER');
  assert.equal(nasdaq.connectable, true);
  assert.deepEqual(nasdaq.capabilities, ['UNIVERSE']);
  assert.equal(selectQualifiedStockPriceProvider({ market: 'US_STOCK', observations }), null);
});

test('selects an official credentialed provider only after query, credential and terms proof', () => {
  const observations = {
    TOSS_INVEST: {
      httpStatus: 200,
      payloadValidated: true,
      observedAt,
      credentialsReady: true,
      usageTermsConfirmed: true,
    },
  };
  const selected = selectQualifiedStockPriceProvider({ market: 'KR_STOCK', observations });
  assert.equal(selected?.provider, 'TOSS_INVEST');
  assert.equal(selected?.connectable, true);
});

test('does not overstate provider market or timeframe coverage before exact payload validation', () => {
  const observations = {
    TOSS_INVEST: { httpStatus: 200, payloadValidated: true, observedAt, credentialsReady: true, usageTermsConfirmed: true },
    KIWOOM: { httpStatus: 200, payloadValidated: true, observedAt, credentialsReady: true, usageTermsConfirmed: true },
  };
  assert.equal(selectQualifiedStockPriceProvider({ market: 'KR_STOCK', timeframe: '5m', observations })?.provider, 'KIWOOM');
  assert.equal(selectQualifiedStockPriceProvider({ market: 'KR_STOCK', timeframe: '60m', observations })?.provider, 'KIWOOM');
  assert.equal(selectQualifiedStockPriceProvider({ market: 'KR_STOCK', timeframe: '1D', observations })?.provider, 'TOSS_INVEST');
  assert.equal(selectQualifiedStockPriceProvider({ market: 'US_STOCK', timeframe: '5m', observations }), null);
  assert.equal(selectQualifiedStockPriceProvider({ market: 'US_STOCK', timeframe: '60m', observations }), null);
  assert.equal(selectQualifiedStockPriceProvider({ market: 'US_STOCK', timeframe: '1D', observations })?.provider, 'TOSS_INVEST');
});

test('keeps page-internal endpoints disconnected even if they return data', () => {
  const observations = {
    NAVER_PAGE: { httpStatus: 200, payloadValidated: true, observedAt, usageTermsConfirmed: true },
  };
  const naver = qualifyStockProviders(observations).find((row) => row.provider === 'NAVER_PAGE');
  assert.equal(naver.connectable, false);
  assert.ok(naver.blockers.includes('CONNECTOR_NOT_ELIGIBLE'));
});

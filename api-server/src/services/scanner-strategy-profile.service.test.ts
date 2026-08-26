import './strategy-promotion.service.test';
import '../routes/strategy-promotion.smoke.test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getScannerStrategyProfile, listScannerStrategyProfiles } from './scanner-strategy-profile.service';
import { deriveScannerOutcome, type ScannerResponse } from './scanner-signal.types';

function scannerOutcomeFixture(overrides: Partial<ScannerResponse> = {}): ScannerResponse {
  return {
    ok: true, requestId: 'outcome', assetClass: 'stock', market: 'KR', timeframe: '1D',
    cards: [], alerts: [], failures: [],
    execution: {
      requestedCount: 1, startedCount: 1, completedCount: 1, excludedCount: 1,
      providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false,
      cancelled: false, duplicate: false, elapsedMs: 1, deadlineMs: 1_000,
      itemTimeoutMs: 500, maxConcurrency: 1,
    },
    universe: { totalCount: 1, cursor: 0, nextCursor: null, source: 'fixture', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
    dataState: 'complete', message: 'fixture', generatedAt: '2026-08-13T00:00:00.000Z',
    orderSubmitted: false, exchangeRequestSent: false,
    ...overrides,
  };
}

it('classifies valid provider 0-signals separately from operational zeroes', () => {
  const base = scannerOutcomeFixture();
  assert.equal(deriveScannerOutcome(base), 'VALID_ZERO_SIGNAL');
  assert.equal(deriveScannerOutcome({ ...base, universe: { ...base.universe, totalCount: 0 } }), 'UNIVERSE_EMPTY');
  assert.equal(deriveScannerOutcome({ ...base, failures: [{ symbol: '*', reason: 'provider_error', message: 'down' }], execution: { ...base.execution, providerErrorCount: 1, completedCount: 0 }, dataState: 'unavailable' }), 'PROVIDER_FAILURE');
  assert.equal(deriveScannerOutcome({ ...base, failures: [{ symbol: 'BAD', reason: 'symbol_mapping', message: 'symbol map mismatch' }] }), 'SYMBOL_MAPPING_FAILURE');
  assert.equal(deriveScannerOutcome({ ...base, execution: { ...base.execution, timeoutCount: 1, timedOut: true } }), 'REQUEST_TIMEOUT');
  assert.equal(deriveScannerOutcome({ ...base, failures: [{ symbol: 'BAD', reason: 'invalid_data', message: 'bad candle' }], execution: { ...base.execution, dataSuccessCount: 0, insufficientDataCount: 1 } }), 'DATA_QUALITY_REJECT');
  assert.equal(deriveScannerOutcome({ ...base, execution: { ...base.execution, dataSuccessCount: 1, hardFilterRejectedCount: 1 } }), 'FILTER_TOO_STRICT');
});

describe('scanner strategy profiles', () => {
  it('defines four markets times three horizons without execution authority', () => {
    const profiles = listScannerStrategyProfiles();
    assert.equal(profiles.length, 12);
    assert.equal(new Set(profiles.map((profile) => profile.id)).size, 12);
    for (const profile of profiles) {
      assert.equal(profile.executionAuthority, 'NONE');
      assert.equal(profile.calibrationPolicy, 'OOS_CALIBRATION_REQUIRED');
      assert.ok(profile.version);
      assert.ok(profile.primaryTimeframe);
      assert.ok(profile.indicators.length > 0);
      assert.ok(profile.requiredEvidence.length > 0);
      assert.ok(profile.requiredCostComponents.length > 0);
      assert.equal(Object.isFrozen(profile), true);
      assert.equal(Object.isFrozen(profile.requiredEvidence), true);
      assert.equal(Object.isFrozen(profile.requiredCostComponents), true);
    }
  });

  it('keeps same UX horizon but market-specific internal profile', () => {
    const kr = getScannerStrategyProfile('KR_STOCK', 'SCALP');
    const futures = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
    assert.notEqual(kr.id, futures.id);
    assert.notDeepEqual(kr.scannerConditions, futures.scannerConditions);
    assert.notDeepEqual(kr.requiredEvidence, futures.requiredEvidence);
    assert.notDeepEqual(kr.requiredCostComponents, futures.requiredCostComponents);
  });

  it('defines an independent position profile with weekly confirmation', () => {
    const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
    for (const market of markets) {
      const position = getScannerStrategyProfile(market, 'POSITION');
      const swing = getScannerStrategyProfile(market, 'SWING');
      assert.notEqual(position.id, swing.id);
      assert.notDeepEqual(position.indicatorWeights, swing.indicatorWeights);
      assert.ok(position.confirmationTimeframes.includes('1W'), `${market} POSITION must require 1W confirmation`);
    }
  });

  it('requires derivatives evidence before a futures profile can be calibrated', () => {
    const futures = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
    for (const required of ['mark_price', 'index_price', 'funding_rate', 'open_interest', 'basis', 'liquidation_risk']) {
      assert.ok(futures.requiredEvidence.includes(required), `missing futures evidence: ${required}`);
    }
    assert.ok(futures.requiredCostComponents.includes('funding'));
    assert.equal(futures.directionPolicy, 'LONG_SHORT');
  });

  it('keeps stock and spot profiles long-only until a separate short contract exists', () => {
    for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'] as const) {
      for (const horizon of ['SCALP', 'SWING', 'POSITION'] as const) {
        assert.equal(getScannerStrategyProfile(market, horizon).directionPolicy, 'LONG_ONLY');
      }
    }
  });
});
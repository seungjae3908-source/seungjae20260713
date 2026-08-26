import './strategy-promotion.service.test';
import '../routes/strategy-promotion.smoke.test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getScannerProfileEvidenceContract,
  getScannerStrategyProfile,
  listScannerProfileEvidenceContracts,
  listScannerStrategyProfiles,
} from './scanner-strategy-profile.service';
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
    for (const profile of profiles) {
      assert.equal(profile.executionAuthority, 'NONE');
      assert.ok(profile.version);
      assert.ok(profile.primaryTimeframe);
      assert.ok(profile.indicators.length > 0);
      assert.equal(Object.isFrozen(profile), true);
    }
  });

  it('preserves the canonical V1 strategy identities and timeframes', () => {
    const futures = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
    assert.equal(futures.id, 'CRYPTO_FUTURES_SCALP_V1');
    assert.equal(futures.version, 'signal-profile-v1');

    for (const profile of listScannerStrategyProfiles()) {
      assert.match(profile.id, /_V1$/);
      assert.equal(profile.version, 'signal-profile-v1');
      if (profile.horizon === 'POSITION') {
        assert.equal(profile.confirmationTimeframes.includes('1W'), false);
      }
    }
  });

  it('keeps same UX horizon but market-specific internal profile', () => {
    const kr = getScannerStrategyProfile('KR_STOCK', 'SCALP');
    const futures = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
    assert.notEqual(kr.id, futures.id);
    assert.notDeepEqual(kr.scannerConditions, futures.scannerConditions);
  });

  it('defines an independent position profile', () => {
    const position = getScannerStrategyProfile('US_STOCK', 'POSITION');
    const swing = getScannerStrategyProfile('US_STOCK', 'SWING');
    assert.notEqual(position.id, swing.id);
    assert.notDeepEqual(position.indicatorWeights, swing.indicatorWeights);
  });
});

describe('scanner profile evidence contracts', () => {
  it('defines immutable evidence contracts for four markets times three horizons', () => {
    const contracts = listScannerProfileEvidenceContracts();
    assert.equal(contracts.length, 12);
    assert.equal(new Set(contracts.map((contract) => contract.id)).size, 12);
    for (const contract of contracts) {
      assert.equal(contract.version, 'scanner-profile-evidence-v1');
      assert.equal(contract.calibrationPolicy, 'OOS_CALIBRATION_REQUIRED');
      assert.equal(contract.executionAuthority, 'NONE');
      assert.match(contract.strategyProfileId, /_V1$/);
      assert.ok(contract.requiredEvidence.length > 0);
      assert.ok(contract.requiredCostComponents.length > 0);
      assert.equal(Object.isFrozen(contract), true);
      assert.equal(Object.isFrozen(contract.requiredEvidence), true);
      assert.equal(Object.isFrozen(contract.requiredCostComponents), true);
    }
  });

  it('requires weekly evidence for position without changing the V1 runtime timeframe identity', () => {
    for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const) {
      const contract = getScannerProfileEvidenceContract(market, 'POSITION');
      const profile = getScannerStrategyProfile(market, 'POSITION');
      assert.ok(contract.requiredEvidence.includes('weekly_candles'), `${market} POSITION must require weekly evidence`);
      assert.equal(profile.confirmationTimeframes.includes('1W'), false);
      assert.equal(contract.strategyProfileId, profile.id);
    }
  });

  it('requires derivatives evidence and funding cost for futures calibration', () => {
    const futures = getScannerProfileEvidenceContract('CRYPTO_FUTURES', 'SCALP');
    for (const required of ['mark_price', 'index_price', 'funding_rate', 'open_interest', 'basis', 'liquidation_risk']) {
      assert.ok(futures.requiredEvidence.includes(required), `missing futures evidence: ${required}`);
    }
    for (const cost of ['commission', 'spread', 'slippage', 'latency', 'liquidity_impact', 'partial_fill_impact', 'funding']) {
      assert.ok(futures.requiredCostComponents.includes(cost), `missing futures cost: ${cost}`);
    }
    assert.equal(futures.directionPolicy, 'LONG_SHORT');
  });

  it('keeps stock and spot evidence contracts long-only with explicit execution costs', () => {
    for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'] as const) {
      for (const horizon of ['SCALP', 'SWING', 'POSITION'] as const) {
        const contract = getScannerProfileEvidenceContract(market, horizon);
        assert.equal(contract.directionPolicy, 'LONG_ONLY');
        for (const cost of ['commission', 'spread', 'slippage', 'latency', 'liquidity_impact', 'partial_fill_impact']) {
          assert.ok(contract.requiredCostComponents.includes(cost), `${market}/${horizon} missing cost: ${cost}`);
        }
      }
    }
  });
});

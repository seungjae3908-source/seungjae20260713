import './strategy-promotion.service.test';
import '../routes/strategy-promotion.smoke.test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getScannerProfileEvidenceContract,
  getScannerStrategyProfile,
  listScannerProfileEvidenceContracts,
  listScannerStrategyProfiles,
  validateScannerProfileEvidence,
  type ScannerProfileEvidenceValidationInput,
  type ScannerProfileHorizon,
  type ScannerProfileMarket,
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

function readyValidationInput(
  market: ScannerProfileMarket,
  horizon: ScannerProfileHorizon,
  direction: 'LONG' | 'SHORT' = 'LONG',
): ScannerProfileEvidenceValidationInput {
  const profile = getScannerStrategyProfile(market, horizon);
  const contract = getScannerProfileEvidenceContract(market, horizon);
  const evidence = Object.fromEntries(contract.requiredEvidence.map((key) => [key, {
    status: 'READY' as const,
    provenance: `public-evidence:${market}:${horizon}:${key}`,
  }]));
  const costs = Object.fromEntries(contract.requiredCostComponents.map((key) => [key, {
    status: 'READY' as const,
    provenance: `cost-evidence:${market}:${horizon}:${key}`,
    value: key === 'tax' || key === 'funding' ? 0.0001 : 1,
    measured: true,
  }]));
  return {
    market,
    horizon,
    strategyProfileId: profile.id,
    strategyVersion: profile.version,
    direction,
    evidence,
    costs,
    calibration: {
      status: 'READY',
      split: 'OOS',
      heldOut: true,
      provenance: `oos:${market}:${horizon}`,
      strategyProfileId: profile.id,
      strategyVersion: profile.version,
      market,
      horizon,
    },
  };
}

describe('scanner profile fail-closed evidence validation', () => {
  it('validates all 12 market-horizon contracts without identity fallback', () => {
    const markets: ScannerProfileMarket[] = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
    const horizons: ScannerProfileHorizon[] = ['SCALP', 'SWING', 'POSITION'];
    for (const market of markets) {
      for (const horizon of horizons) {
        const longResult = validateScannerProfileEvidence(readyValidationInput(market, horizon, 'LONG'));
        assert.equal(longResult.status, 'READY', `${market}/${horizon}/LONG must satisfy its own contract`);
        assert.equal(longResult.strategyProfileId, `${market}_${horizon}_V1`);
        assert.equal(longResult.executionAuthority, 'NONE');
        if (market === 'CRYPTO_FUTURES') {
          const shortResult = validateScannerProfileEvidence(readyValidationInput(market, horizon, 'SHORT'));
          assert.equal(shortResult.status, 'READY', `${market}/${horizon}/SHORT must be explicitly supported`);
        }
      }
    }
  });

  it('fails closed on strategy identity, version, market and horizon mismatches', () => {
    const base = readyValidationInput('US_STOCK', 'POSITION');
    const wrongId = validateScannerProfileEvidence({ ...base, strategyProfileId: 'US_STOCK_SWING_V1' });
    assert.ok(wrongId.reasons.includes('STRATEGY_PROFILE_ID_MISMATCH'));

    const wrongVersion = validateScannerProfileEvidence({ ...base, strategyVersion: 'signal-profile-v0' });
    assert.ok(wrongVersion.reasons.includes('STRATEGY_PROFILE_VERSION_MISMATCH'));

    const calibration = base.calibration!;
    const wrongCalibration = validateScannerProfileEvidence({
      ...base,
      calibration: { ...calibration, market: 'KR_STOCK', horizon: 'SWING' },
    });
    assert.ok(wrongCalibration.reasons.includes('OOS_MARKET_MISMATCH'));
    assert.ok(wrongCalibration.reasons.includes('OOS_HORIZON_MISMATCH'));
  });

  it('blocks SHORT for stock and spot while preserving futures LONG/SHORT', () => {
    for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'] as const) {
      const result = validateScannerProfileEvidence(readyValidationInput(market, 'SCALP', 'SHORT'));
      assert.equal(result.status, 'NOT_READY');
      assert.ok(result.reasons.includes('DIRECTION_NOT_ALLOWED'));
    }
    assert.equal(validateScannerProfileEvidence(readyValidationInput('CRYPTO_FUTURES', 'SCALP', 'LONG')).status, 'READY');
    assert.equal(validateScannerProfileEvidence(readyValidationInput('CRYPTO_FUTURES', 'SCALP', 'SHORT')).status, 'READY');
  });

  it('blocks POSITION when weekly evidence is missing or stale', () => {
    const base = readyValidationInput('CRYPTO_SPOT', 'POSITION');
    const missingWeekly = { ...base.evidence, weekly_candles: undefined };
    const missing = validateScannerProfileEvidence({ ...base, evidence: missingWeekly });
    assert.ok(missing.reasons.includes('EVIDENCE_NOT_READY:weekly_candles'));

    const staleWeekly = {
      ...base.evidence,
      weekly_candles: { status: 'STALE' as const, provenance: 'public-weekly-candles' },
    };
    const stale = validateScannerProfileEvidence({ ...base, evidence: staleWeekly });
    assert.ok(stale.reasons.includes('EVIDENCE_NOT_READY:weekly_candles'));
  });

  it('requires held-out OOS calibration and exact provenance', () => {
    const base = readyValidationInput('KR_STOCK', 'SWING');
    const calibration = base.calibration!;
    for (const split of ['TRAIN', 'VALIDATION', 'HELD_OUT'] as const) {
      const result = validateScannerProfileEvidence({
        ...base,
        calibration: { ...calibration, split, heldOut: split === 'HELD_OUT' },
      });
      assert.equal(result.status, 'NOT_READY');
      assert.ok(result.reasons.includes('OOS_HELD_OUT_EVIDENCE_REQUIRED'));
    }
    const missingProvenance = validateScannerProfileEvidence({
      ...base,
      calibration: { ...calibration, provenance: null },
    });
    assert.ok(missingProvenance.reasons.includes('OOS_CALIBRATION_PROVENANCE_MISSING'));
  });

  it('blocks missing, invalid, or unmeasured-zero required costs without fabricating zero', () => {
    const base = readyValidationInput('CRYPTO_FUTURES', 'SWING');
    const missingFunding = validateScannerProfileEvidence({
      ...base,
      costs: { ...base.costs, funding: undefined },
    });
    assert.ok(missingFunding.reasons.includes('COST_NOT_READY:funding'));

    const nullLiquidityImpact = validateScannerProfileEvidence({
      ...base,
      costs: {
        ...base.costs,
        liquidity_impact: { status: 'READY', provenance: 'cost:liquidity', value: null, measured: false },
      },
    });
    assert.ok(nullLiquidityImpact.reasons.includes('COST_VALUE_INVALID:liquidity_impact'));

    const unmeasuredZero = validateScannerProfileEvidence({
      ...base,
      costs: {
        ...base.costs,
        partial_fill_impact: { status: 'READY', provenance: 'cost:partial-fill', value: 0, measured: false },
      },
    });
    assert.ok(unmeasuredZero.reasons.includes('COST_ZERO_REQUIRES_MEASUREMENT:partial_fill_impact'));

    const measuredZero = validateScannerProfileEvidence({
      ...base,
      costs: {
        ...base.costs,
        partial_fill_impact: { status: 'READY', provenance: 'measured:partial-fill', value: 0, measured: true },
      },
    });
    assert.equal(measuredZero.status, 'READY');
  });

  it('requires stock tax evidence explicitly', () => {
    for (const market of ['KR_STOCK', 'US_STOCK'] as const) {
      const base = readyValidationInput(market, 'SCALP');
      const result = validateScannerProfileEvidence({ ...base, costs: { ...base.costs, tax: undefined } });
      assert.equal(result.status, 'NOT_READY');
      assert.ok(result.reasons.includes('COST_NOT_READY:tax'));
    }
  });
});

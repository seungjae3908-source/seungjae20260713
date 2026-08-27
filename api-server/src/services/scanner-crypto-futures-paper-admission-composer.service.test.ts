import test from 'node:test';
import assert from 'node:assert/strict';
import type { BitgetFuturesPublicEvidence, BitgetPublicCandle } from './bitget-futures-public-evidence.service';
import { createPaperTradingState } from './paper-trading-core.service';
import type { PaperContractRules, PaperTradingState } from './paper-trading.types';
import type { ScannerCanonicalPaperCandidate } from './scanner-canonical-paper-identity.service';
import type { PercentCostEvidence, SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';
import {
  buildAuthoritativePaperExecutionObservation,
  type AuthoritativePaperRiskPolicyEvidence,
} from './authoritative-paper-callback-owners.service';
import {
  AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
  auditAuthoritativeSupplementalCostSources,
  collectAuthoritativePaperExecutionObservationInput,
  type AuthoritativePaperExecutionSizingEvidence,
} from './authoritative-paper-execution-cost-sources.service';
import { createAuthoritativePaperEvidenceSourceWiring } from './authoritative-paper-evidence-sources.service';
import { buildPaperSimulatedExecutionEvidence } from './paper-simulated-execution-evidence.service';
import {
  composeScannerCryptoFuturesPaperAdmission,
  type ScannerCryptoFuturesPaperExecutionObservation,
} from './scanner-crypto-futures-paper-admission-composer.service';
import { createImmutableSignalSnapshot, type SignalSnapshot } from './signal-performance-learning.service';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const SIGNAL_AT = NOW - 5_000;
const MARKET_AT = NOW - 1_000;
const COST_POLICY = 'canonical-paper-cost-v1';

function candle(timestampMs: number): BitgetPublicCandle {
  return {
    timestampMs,
    open: 99,
    high: 101,
    low: 98,
    close: 100,
    baseVolume: 1_000,
    quoteVolume: 100_000,
  };
}

function candidate(): ScannerCanonicalPaperCandidate {
  return Object.freeze({
    signal: Object.freeze({
      signalId: 'scanner-futures-p0-c5-1',
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      timestampMs: SIGNAL_AT,
      ttlMs: 60 * 60_000,
      expiresAtMs: SIGNAL_AT + 60 * 60_000,
      style: 'SWING',
      timeframe: '1H',
      horizon: 1,
      direction: 'LONG',
      signalDirection: 'LONG',
      strategyIdentity: Object.freeze({
        strategyId: 'canonical-futures-swing-long',
        strategyVersion: 'scanner-profile-v1',
        parameterHash: 'a'.repeat(64),
        researchCodeSha: 'b'.repeat(40),
        costPolicyVersion: COST_POLICY,
      }),
    }),
    executionAuthority: 'NONE',
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function learning(overrides: Partial<SignalSnapshot> = {}): SignalSnapshot {
  const base = createImmutableSignalSnapshot({
    signalId: candidate().signal.signalId,
    timestamp: new Date(SIGNAL_AT).toISOString(),
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    symbolName: 'Bitcoin',
    strategyHorizon: 'SWING',
    direction: 'LONG',
    signalScore: 88,
    displayConfidence: 82,
    referencePrice: 100,
    entryPrice: 100,
    stopLoss: 95,
    target1: 110,
    target2: 115,
    riskReward: 2,
    timeframes: ['1H'],
    strategyProfileVersion: candidate().signal.strategyIdentity.strategyVersion,
    indicatorSnapshot: { source: 'canonical-scanner' },
    indicatorScores: { trend: 80, momentum: 76 },
    patternSnapshot: {},
    volumeContext: { state: 'ready' },
    volatilityContext: { state: 'ready' },
    trendContext: { state: 'ready' },
    marketRegime: 'UPTREND',
    liquidityContext: { state: 'ready' },
    aiValidatorResult: null,
    riskEngineResult: null,
    dataProvenance: ['bitget-public-v2', 'canonical-scanner-runtime'],
    dataTimestamp: new Date(SIGNAL_AT - 1_000).toISOString(),
  });
  return Object.freeze({ ...base, ...overrides }) as SignalSnapshot;
}

function paperState(): PaperTradingState {
  return createPaperTradingState(1_000_000, new Date(NOW - 60_000));
}

function contractRules(overrides: Partial<PaperContractRules> = {}): PaperContractRules {
  return {
    symbol: 'BTCUSDT',
    quantityStep: 0.001,
    quantityPrecision: 3,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    maximumLeverage: 125,
    maintenanceMarginRate: 0.005,
    status: 'live',
    updatedAt: new Date(MARKET_AT).toISOString(),
    warnings: [],
    ...overrides,
  };
}

function publicEvidence(overrides: Partial<BitgetFuturesPublicEvidence> = {}): BitgetFuturesPublicEvidence {
  return {
    provider: 'bitget',
    productType: 'USDT-FUTURES',
    symbol: 'BTCUSDT',
    lastPrice: 100,
    bidPrice: 99.95,
    askPrice: 100.05,
    markPrice: 100,
    indexPrice: 99.98,
    tickerTimestampMs: MARKET_AT,
    fundingRate: 0.0001,
    fundingIntervalHours: 8,
    nextFundingUpdateMs: NOW + 4 * 60 * 60_000,
    openInterest: 10_000_000,
    openInterestTimestampMs: MARKET_AT,
    minTradeNum: 0.001,
    sizeMultiplier: 0.001,
    minTradeUsdt: 5,
    priceStep: 0.01,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    minLeverage: 1,
    maxLeverage: 125,
    candles5m: [candle(NOW - 10 * 60_000)],
    candles1h: [candle(NOW - 2 * 60 * 60_000)],
    benchmarkBtc1h: [candle(NOW - 2 * 60 * 60_000)],
    benchmarkBtc1d: [candle(NOW - 2 * 24 * 60 * 60_000)],
    observedAtMs: NOW,
    dataQuality: 'ready',
    ...overrides,
  };
}

function observedPercent(valuePercent: number, source: string, observedAtMs = MARKET_AT): PercentCostEvidence {
  return Object.freeze({ valuePercent, quality: 'OBSERVED', source, observedAtMs });
}

function supplemental(overrides: Partial<SupplementalExecutionCostEvidence> = {}): SupplementalExecutionCostEvidence {
  return Object.freeze({
    costPolicyId: COST_POLICY,
    observedAtMs: MARKET_AT,
    latency: observedPercent(0.01, 'runtime-latency-observer'),
    liquidityImpact: observedPercent(0.02, 'bitget-depth-impact-observer'),
    partialFillImpact: observedPercent(0.01, 'paper-fill-impact-observer'),
    funding: observedPercent(0.01, 'bitget-current-funding'),
    ...overrides,
  });
}

function observation(overrides: Partial<ScannerCryptoFuturesPaperExecutionObservation> = {}): ScannerCryptoFuturesPaperExecutionObservation {
  return Object.freeze({
    providerProvenance: 'SIMULATED+public-L2+bitget-public-v2:ticker+contracts+funding+open-interest+depth-observation',
    slippage: observedPercent(0.05, 'bitget-depth-slippage-observer'),
    liquidity: Object.freeze({ value: 1_000_000, source: 'bitget-public-depth-notional', observedAtMs: MARKET_AT }),
    partialFill: Object.freeze({ model: 'ORDER_BOOK' as const, source: 'SIMULATED/public-L2:VISIBLE_L2_BOOK_WALK_ONLY', observedAtMs: MARKET_AT }),
    latency: Object.freeze({
      observedRoundTripMs: 20,
      costValuePercent: null,
      source: 'BITGET_PUBLIC_L2_REQUEST_TIMING',
      observedAtMs: MARKET_AT,
    }),
    executionProvenance: Object.freeze({
      evidenceClass: 'SIMULATED' as const,
      marketDataClass: 'public-L2' as const,
      executionMode: 'SIMULATED_EXECUTION_ONLY' as const,
      realFillObserved: false as const,
      realFillClaim: false as const,
      publicDepthIsFillProof: false as const,
      liveSubmittedExecutionSampleCredit: 0 as const,
      liveFillCalibrationStatus: 'BLOCKED_DATA' as const,
    }),
    leverage: 1,
    riskPercent: 0.5,
    marginMode: 'isolated' as const,
    ...overrides,
  });
}

function compose(overrides: Partial<Parameters<typeof composeScannerCryptoFuturesPaperAdmission>[0]> = {}) {
  return composeScannerCryptoFuturesPaperAdmission({
    paperCandidate: candidate(),
    learningSnapshot: learning(),
    paperState: paperState(),
    contractRules: contractRules(),
    publicEvidence: publicEvidence(),
    executionObservation: observation(),
    supplementalCostEvidence: supplemental(),
    nowMs: NOW,
    maxEvidenceAgeMs: 30_000,
    ...overrides,
  });
}

test('P0-C5 composes a READY crypto-futures admission bundle only from authoritative Paper/public evidence', () => {
  const result = compose();
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.riskInput?.accountBalance, 1_000_000);
  assert.equal(result.riskInput?.dataStatus, 'live');
  assert.equal(result.riskInput?.contractRulesStatus, 'live');
  assert.equal(result.riskResult?.allowed, true);
  assert.equal(result.paperEvidence?.provider, 'bitget');
  assert.equal(result.paperEvidence?.minimumOrderQuantity, 0.001);
  assert.equal(result.admissionResult?.status, 'READY');
  assert.ok(result.admissionResult?.bundle?.evidenceDigest);
  assert.equal(result.executionDataEvidence?.executionMode, 'SIMULATED_EXECUTION_ONLY');
  assert.equal(result.executionDataEvidence?.publicL2Only, true);
  assert.equal(result.executionDataEvidence?.realFillClaim, false);
  assert.equal(result.executionDataEvidence?.liveFillCalibrationStatus, 'BLOCKED_DATA');
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.productionMutationAllowed, false);
});

test('P0-C5 refuses to replace missing Paper equity with a synthetic default', () => {
  const state = paperState();
  state.account.equity = 0;
  const result = compose({ paperState: state });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_PAPER_EQUITY_REQUIRED'));
  assert.equal(result.admissionResult, null);
});

test('P0-C5 fails closed when explicit slippage evidence is stale', () => {
  const result = compose({
    executionObservation: observation({
      slippage: observedPercent(0.05, 'stale-depth-slippage', NOW - 60_000),
    }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_SLIPPAGE_EVIDENCE_STALE_OR_FUTURE'));
});

test('P0-C5 fails closed when Paper contract rules disagree with Bitget public contract evidence', () => {
  const result = compose({ contractRules: contractRules({ minimumQuantity: 0.01 }) });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_PUBLIC_PAPER_CONTRACT_MISMATCH'));
});

test('P0-C5 preserves #529 learning-identity fail-closed checks', () => {
  const result = compose({ learningSnapshot: learning({ signalId: 'tampered-signal-id' }) });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.admissionResult?.status, 'BLOCKED');
  assert.ok(result.blockers.includes('LEARNING_SIGNAL_ID_MISMATCH'));
});

test('P0-C5 does not invent supplemental execution costs when the canonical cost policy id mismatches', () => {
  const result = compose({ supplementalCostEvidence: supplemental({ costPolicyId: 'wrong-policy' }) });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_COST_POLICY_ID_MISMATCH'));
});

test('P0-C5 blocks admission when supplemental full-cost evidence is absent even when Paper L2 simulation is valid', () => {
  const result = compose({ supplementalCostEvidence: undefined as never });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_SUPPLEMENTAL_FULL_COST_EVIDENCE_REQUIRED'));
  assert.ok(result.blockers.includes('P0_C5_COST_POLICY_ID_MISMATCH'));
  assert.equal(result.admissionResult, null);
});

test('P0-C5 rejects execution observations that are not explicitly SIMULATED/public-L2', () => {
  const result = compose({
    executionObservation: observation({
      providerProvenance: 'bitget-public-depth-without-simulation-label',
      executionProvenance: Object.freeze({
        evidenceClass: 'SIMULATED',
        marketDataClass: 'public-L2',
        executionMode: 'SIMULATED_EXECUTION_ONLY',
        realFillObserved: false,
        realFillClaim: false,
        publicDepthIsFillProof: false,
        liveSubmittedExecutionSampleCredit: 0,
        liveFillCalibrationStatus: 'BLOCKED_DATA',
      }),
    }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('P0_C5_PROVIDER_PROVENANCE_REQUIRED'));
});

function authoritativeRiskPolicy(observedAtMs = MARKET_AT): AuthoritativePaperRiskPolicyEvidence {
  return Object.freeze({
    schemaVersion: 'authoritative-paper-risk-policy-evidence-v1',
    leverage: 1,
    riskPercent: 0.5,
    marginMode: 'isolated',
    source: 'immutable-paper-risk-policy-v1',
    observedAtMs,
    maximumAgeMs: 30_000,
  });
}

function sizingEvidence(targetQuantity = 2): AuthoritativePaperExecutionSizingEvidence {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
    signalId: 'scanner-futures-p0-c5-1',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    targetQuantity,
    riskPolicy: authoritativeRiskPolicy(),
    source: 'canonical-paper-risk-sizing-result-v1',
    observedAtMs: MARKET_AT,
    maximumAgeMs: 30_000,
  });
}

const executionContext = Object.freeze({
  card: Object.freeze({ signalId: 'scanner-futures-p0-c5-1', symbol: 'BTCUSDT', action: 'LONG' }),
  market: 'CRYPTO_FUTURES' as const,
});

function l2Payload(asks: readonly (readonly [number, number])[] = [[100, 1], [100.1, 2]]) {
  return Object.freeze({
    code: '00000',
    data: Object.freeze({
      ts: String(MARKET_AT),
      b: Object.freeze([[99.9, 3]]),
      a: Object.freeze(asks),
    }),
  });
}

test('Worker D connects valid public L2 to the authoritative callback as SIMULATED with zero Live sample credit', async () => {
  const calls: string[] = [];
  const clock = [MARKET_AT + 10, MARKET_AT + 30];
  const wiring = createAuthoritativePaperEvidenceSourceWiring({
    researchCodeSha: 'a'.repeat(40),
    dependencies: {
      executionSizingEvidenceForCard: async () => sizingEvidence(),
      fetchPublicJson: async (url, request) => {
        calls.push(url.toString());
        assert.equal(request.provider, 'bitget');
        return l2Payload();
      },
      now: () => clock.shift() ?? MARKET_AT + 30,
    },
  });

  const result = await wiring.executionObservationForCard(executionContext);
  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? '', /\/api\/v3\/market\/orderbook\?category=USDT-FUTURES&symbol=BTCUSDT&limit=50/u);
  assert.equal(result.executionProvenance.evidenceClass, 'SIMULATED');
  assert.equal(result.executionProvenance.marketDataClass, 'public-L2');
  assert.equal(result.executionProvenance.realFillObserved, false);
  assert.equal(result.executionProvenance.realFillClaim, false);
  assert.equal(result.executionProvenance.liveSubmittedExecutionSampleCredit, 0);
  assert.equal(result.executionProvenance.liveFillCalibrationStatus, 'BLOCKED_DATA');
  assert.equal(result.latency.observedRoundTripMs, 20);
  assert.equal(result.latency.costValuePercent, null);
});

test('Worker D fails closed on incomplete visible depth and never manufactures fill probability', async () => {
  const clock = [MARKET_AT + 10, MARKET_AT + 30];
  const collected = await collectAuthoritativePaperExecutionObservationInput({
    context: executionContext,
    sizingEvidence: sizingEvidence(2),
    fetchPublicJson: async () => l2Payload([[100, 0.5]]),
    now: () => clock.shift() ?? MARKET_AT + 30,
  });
  assert.ok(collected);
  const raw = buildPaperSimulatedExecutionEvidence({
    ...collected.executionEvidenceInput,
    nowMs: collected.nowMs,
  }) as Readonly<{
    paperSimulation: Readonly<{ status: string; realFillObserved: boolean }>;
    liveGradeFillReadiness: Readonly<{
      submittedExecutionSamples: number | null;
      submittedExecutionSampleCredit: number;
    }>;
    estimated: Readonly<{
      partialFillEstimate: Readonly<{ calibratedFillProbability: number | null }>;
    }>;
  }>;
  assert.equal(raw.paperSimulation.status, 'VETO');
  assert.equal(raw.paperSimulation.realFillObserved, false);
  assert.equal(raw.liveGradeFillReadiness.submittedExecutionSamples, null);
  assert.equal(raw.liveGradeFillReadiness.submittedExecutionSampleCredit, 0);
  assert.equal(raw.estimated.partialFillEstimate.calibratedFillProbability, null);
  assert.throws(
    () => buildAuthoritativePaperExecutionObservation(collected),
    /AUTHORITATIVE_EXECUTION_OBSERVATION_DATA_UNAVAILABLE/u,
  );
});

test('Worker D keeps supplemental full-cost MISSING when only public/reference evidence exists', async () => {
  const audit = auditAuthoritativeSupplementalCostSources({
    publicEvidence: publicEvidence(),
    executionObservation: observation(),
    nowMs: NOW,
    maximumAgeMs: 30_000,
  });
  assert.equal(audit.status, 'MISSING');
  assert.equal(audit.supplementalCostInput, null);
  assert.equal(audit.components.fees.state, 'PRESENT');
  assert.equal(audit.components.spread.state, 'PRESENT');
  assert.equal(audit.components.slippage.state, 'PRESENT');
  assert.equal(audit.components.latency.state, 'REFERENCE_ONLY');
  assert.equal(audit.components.latency.countsAsExecutionCost, false);
  assert.equal(audit.components.liquidityImpact.state, 'REFERENCE_ONLY');
  assert.equal(audit.components.partialFillImpact.state, 'REFERENCE_ONLY');
  assert.equal(audit.components.funding.state, 'REFERENCE_ONLY');
  assert.deepEqual(audit.blockers, [
    'SUPPLEMENTAL_COST_POLICY_EVIDENCE_UNAVAILABLE',
    'SUPPLEMENTAL_COST_OBSERVATION_UNAVAILABLE',
    'LATENCY_COST_EVIDENCE_UNAVAILABLE',
    'LIQUIDITY_IMPACT_COST_EVIDENCE_UNAVAILABLE',
    'PARTIAL_FILL_COST_EVIDENCE_UNAVAILABLE',
    'FUNDING_EXECUTION_COST_EVIDENCE_UNAVAILABLE',
  ]);
  assert.equal(audit.unknownIsZero, false);
  assert.equal(audit.unavailableCostConvertedToZero, false);

  const missing = auditAuthoritativeSupplementalCostSources({ nowMs: NOW });
  for (const component of Object.values(missing.components)) {
    assert.equal(component.state, 'UNAVAILABLE');
    assert.equal(component.value, null);
    assert.notEqual(component.value, 0);
  }

  const fullyObserved = auditAuthoritativeSupplementalCostSources({
    supplemental: supplemental(),
    nowMs: NOW,
  });
  assert.equal(fullyObserved.status, 'PRESENT');
  assert.ok(fullyObserved.supplementalCostInput);

  const futuresFundingMarkedNotApplicable = auditAuthoritativeSupplementalCostSources({
    supplemental: supplemental({
      funding: Object.freeze({
        valuePercent: 0,
        quality: 'NOT_APPLICABLE',
        source: 'unsupported-futures-funding-not-applicable-claim',
        observedAtMs: MARKET_AT,
      }),
    }),
    nowMs: NOW,
  });
  assert.equal(futuresFundingMarkedNotApplicable.status, 'MISSING');
  assert.equal(futuresFundingMarkedNotApplicable.components.funding.state, 'UNAVAILABLE');
  assert.equal(futuresFundingMarkedNotApplicable.components.funding.value, null);
  assert.ok(futuresFundingMarkedNotApplicable.blockers.includes(
    'FUNDING_EXECUTION_COST_EVIDENCE_UNAVAILABLE',
  ));

  const wiring = createAuthoritativePaperEvidenceSourceWiring({
    researchCodeSha: 'a'.repeat(40),
    dependencies: {
      supplementalCostInputForCard: async () => ({
        costPolicyId: COST_POLICY,
        observedAtMs: MARKET_AT,
        latency: observedPercent(0.01, 'observed-latency-cost'),
      }),
      now: () => NOW,
    },
  });
  assert.equal(await wiring.supplementalCostEvidenceForCard(executionContext), null);
});

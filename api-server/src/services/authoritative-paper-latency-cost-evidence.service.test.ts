import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthoritativeSupplementalCostEvidence } from './authoritative-paper-callback-owners.service';
import { auditAuthoritativeSupplementalCostSources } from './authoritative-paper-execution-cost-sources.service';
import {
  AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY,
  bindAuthoritativePaperLatencyToSupplementalCostInput,
  buildAuthoritativePaperLatencyCostEvidence,
  collectAuthoritativePaperLatencyCostEvidence,
  readBitgetPublicLatencyMidpointQuote,
  type AuthoritativePaperLatencyCostInput,
  type PublicMidpointObservation,
  type PublicMidpointQuote,
} from './authoritative-paper-latency-cost-evidence.service';
import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

const nowMs = 2_000_000;
const researchCodeSha = 'a'.repeat(40);
type SupplementalAuditInput = NonNullable<Parameters<typeof auditAuthoritativeSupplementalCostSources>[0]>;

function observation(
  phase: 'PRE' | 'POST',
  midpoint: number,
  observedAtMs: number,
): PublicMidpointObservation {
  return Object.freeze({
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    researchCodeSha,
    observationId: `bitget-public-${phase.toLowerCase()}-${observedAtMs}`,
    midpoint,
    observedAtMs,
    source: `BITGET_PUBLIC_${phase}`,
    evidenceClass: 'PUBLIC_MIDPOINT',
    endpointClass: 'PUBLIC_MARKET',
    privateApiUsed: false,
  });
}

function quote(
  phase: 'PRE' | 'POST',
  midpoint: number,
  observedAtMs: number,
): PublicMidpointQuote {
  return Object.freeze({
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    researchCodeSha,
    observationId: `bitget-public-quote-${phase.toLowerCase()}-${observedAtMs}`,
    bidPrice: midpoint - 0.05,
    askPrice: midpoint + 0.05,
    observedAtMs,
    source: `BITGET_PUBLIC_${phase}_BBO`,
    endpointClass: 'PUBLIC_MARKET',
    privateApiUsed: false,
  });
}

function baseInput(): AuthoritativePaperLatencyCostInput {
  return {
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    researchCodeSha,
    direction: 'LONG',
    requestStartedAtMs: nowMs - 500,
    requestCompletedAtMs: nowMs - 300,
    preRequest: observation('PRE', 100, nowMs - 550),
    postRequest: observation('POST', 100.2, nowMs - 250),
    nowMs,
    maximumAgeMs: 5_000,
    maximumRequestDurationMs: 5_000,
  };
}

function cost(valuePercent: number, source: string): PercentCostEvidence {
  return Object.freeze({ valuePercent, quality: 'ESTIMATED', source, observedAtMs: nowMs - 100 });
}

test('LONG adverse midpoint movement becomes estimated latency cost', () => {
  const result = buildAuthoritativePaperLatencyCostEvidence(baseInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.observedRoundTripMs, 200);
  assert.ok(result.evidence);
  assert.equal(result.evidence.quality, 'ESTIMATED');
  assert.ok(Math.abs(result.evidence.valuePercent - 0.2) < 1e-12);
  assert.equal(result.unknownCostIsZero, false);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.realFillObserved, false);
});

test('SHORT adverse midpoint movement is direction-aware', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    direction: 'SHORT',
    postRequest: observation('POST', 99.8, nowMs - 250),
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.evidence);
  assert.ok(Math.abs(result.evidence.valuePercent - 0.2) < 1e-12);
});

test('favorable measured movement can produce zero without treating missing evidence as zero', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: observation('POST', 99.8, nowMs - 250),
  });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.evidence?.valuePercent, 0);
  assert.equal(result.unknownCostIsZero, false);
});

test('missing pre midpoint fails closed', () => {
  const result = buildAuthoritativePaperLatencyCostEvidence({ ...baseInput(), preRequest: null });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('LATENCY_PRE_REQUEST_MIDPOINT_UNAVAILABLE'));
});

test('missing post midpoint fails closed', () => {
  const result = buildAuthoritativePaperLatencyCostEvidence({ ...baseInput(), postRequest: null });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('LATENCY_POST_REQUEST_MIDPOINT_UNAVAILABLE'));
});

test('stale pre or post evidence fails closed', () => {
  const input = baseInput();
  for (const value of [
    { ...input, preRequest: observation('PRE', 100, nowMs - 20_000) },
    { ...input, postRequest: observation('POST', 100.2, nowMs - 20_000) },
  ]) {
    const result = buildAuthoritativePaperLatencyCostEvidence(value);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.evidence, null);
    assert.equal(result.blockers.some((blocker) => blocker.endsWith('EVIDENCE_STALE')), true);
  }
});

test('future request or midpoint evidence fails closed', () => {
  const input = baseInput();
  const cases = [
    { ...input, requestStartedAtMs: nowMs + 1, requestCompletedAtMs: nowMs + 2 },
    { ...input, preRequest: observation('PRE', 100, nowMs + 1) },
    { ...input, postRequest: observation('POST', 100.2, nowMs + 1) },
  ];
  for (const value of cases) {
    const result = buildAuthoritativePaperLatencyCostEvidence(value);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.evidence, null);
    assert.equal(result.blockers.some((blocker) => blocker.includes('FUTURE')), true);
  }
});

test('pre and post timestamps must actually bracket the measured request', () => {
  const input = baseInput();
  const badPre = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    preRequest: observation('PRE', 100, input.requestStartedAtMs + 1),
  });
  const badPost = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: observation('POST', 100.2, input.requestCompletedAtMs - 1),
  });
  assert.ok(badPre.blockers.includes('LATENCY_PRE_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST'));
  assert.ok(badPost.blockers.includes('LATENCY_POST_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST'));
});

test('request duration over policy fails closed and never becomes percent cost', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    requestStartedAtMs: nowMs - 2_000,
    requestCompletedAtMs: nowMs - 100,
    preRequest: observation('PRE', 100, nowMs - 2_100),
    postRequest: observation('POST', 100.1, nowMs - 50),
    maximumRequestDurationMs: 1_000,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('LATENCY_REQUEST_DURATION_EXCEEDS_POLICY'));
});

test('reused observation identity or timestamp is rejected', () => {
  const input = baseInput();
  const reusedId = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest!, observationId: input.preRequest!.observationId },
  });
  const reusedTimestamp = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    requestStartedAtMs: nowMs - 500,
    requestCompletedAtMs: nowMs - 500,
    postRequest: { ...input.postRequest!, observedAtMs: input.preRequest!.observedAtMs },
  });
  assert.ok(reusedId.blockers.includes('LATENCY_REUSED_MIDPOINT_OBSERVATION'));
  assert.ok(reusedTimestamp.blockers.includes('LATENCY_REUSED_MIDPOINT_OBSERVATION'));
});

test('wrong market, symbol, or research SHA is rejected', () => {
  const input = baseInput();
  const wrongMarket = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    preRequest: { ...input.preRequest!, market: 'CRYPTO_SPOT' as never },
  });
  const wrongSymbol = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest!, symbol: 'ETHUSDT' },
  });
  const wrongSha = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest!, researchCodeSha: 'b'.repeat(40) },
  });
  assert.ok(wrongMarket.blockers.includes('LATENCY_PRE_REQUEST_MARKET_MISMATCH'));
  assert.ok(wrongSymbol.blockers.includes('LATENCY_POST_REQUEST_SYMBOL_MISMATCH'));
  assert.ok(wrongSha.blockers.includes('LATENCY_POST_REQUEST_RESEARCH_SHA_MISMATCH'));
});

test('private or non-public midpoint evidence is rejected', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: {
      ...input.postRequest!,
      endpointClass: 'PRIVATE_ACCOUNT' as never,
      privateApiUsed: true as never,
    },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.privateApiUsed, false);
  assert.ok(result.blockers.includes('LATENCY_POST_REQUEST_PUBLIC_MARKET_EVIDENCE_REQUIRED'));
});

test('public-only collector measures the real request and waits for a bracketing post observation', async () => {
  const clock = [nowMs - 500, nowMs - 300, nowMs];
  let requestCalls = 0;
  let postCalls = 0;
  const result = await collectAuthoritativePaperLatencyCostEvidence({
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    researchCodeSha,
    direction: 'LONG',
    now: () => clock.shift() ?? nowMs,
    readPublicMidpointQuote: async (phase) => {
      if (phase === 'PRE') return quote('PRE', 100, nowMs - 550);
      postCalls += 1;
      return postCalls === 1
        ? quote('POST', 100.1, nowMs - 350)
        : quote('POST', 100.2, nowMs - 250);
    },
    executeMeasuredPublicRequest: async () => {
      requestCalls += 1;
      return Object.freeze({ source: 'BITGET_PUBLIC_L2', ok: true });
    },
    maximumPostObservationAttempts: 3,
    maximumAgeMs: 5_000,
    maximumRequestDurationMs: 5_000,
  });
  assert.equal(requestCalls, 1);
  assert.equal(postCalls, 2);
  assert.equal(result.realMeasuredRequestTiming, true);
  assert.equal(result.requestStartedAtMs, nowMs - 500);
  assert.equal(result.requestCompletedAtMs, nowMs - 300);
  assert.equal(result.evaluatedAtMs, nowMs);
  assert.equal(result.latency.status, 'PRESENT');
  assert.equal(result.latency.observedRoundTripMs, 200);
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.realFillObserved, false);
});

test('Bitget midpoint reader is fixed to the public UTA BBO endpoint', async () => {
  const requestedUrls: URL[] = [];
  const result = await readBitgetPublicLatencyMidpointQuote({
    market: 'CRYPTO_FUTURES',
    symbol: 'btc-usdt',
    researchCodeSha,
    phase: 'PRE',
    attempt: 1,
    fetchPublicJson: async (url, request) => {
      requestedUrls.push(url);
      assert.equal(request.provider, 'bitget');
      return Object.freeze({
        code: '00000',
        data: Object.freeze({
          ts: String(nowMs - 550),
          b: Object.freeze([Object.freeze(['99.9', '10'])]),
          a: Object.freeze([Object.freeze(['100.1', '10'])]),
        }),
      });
    },
  });
  assert.ok(result);
  assert.equal(result.bidPrice, 99.9);
  assert.equal(result.askPrice, 100.1);
  assert.equal(result.endpointClass, 'PUBLIC_MARKET');
  assert.equal(result.privateApiUsed, false);
  const requestedUrl = requestedUrls[0];
  assert.ok(requestedUrl);
  assert.equal(requestedUrl.origin, 'https://api.bitget.com');
  assert.equal(requestedUrl.pathname, '/api/v3/market/orderbook');
  assert.equal(requestedUrl.searchParams.get('category'), 'USDT-FUTURES');
  assert.equal(requestedUrl.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(requestedUrl.searchParams.get('limit'), '1');
});

test('latency adapter feeds only latency into the canonical supplemental audit', () => {
  const latency = buildAuthoritativePaperLatencyCostEvidence(baseInput());
  const liquidityImpact = cost(0.02, 'INDEPENDENT_LIQUIDITY_IMPACT');
  const partialFillImpact = cost(0.03, 'INDEPENDENT_PARTIAL_FILL_IMPACT');
  const funding = cost(0.04, 'HOLDING_HORIZON_FUNDING');
  const source = Object.freeze({
    costPolicyId: 'fixture-cost-v1',
    observedAtMs: nowMs - 100,
    liquidityImpact,
    partialFillImpact,
    funding,
    nowMs,
    maximumAgeMs: 5_000,
  });
  const binding = bindAuthoritativePaperLatencyToSupplementalCostInput({
    sourceSupplementalCostInput: source,
    latency,
  });
  assert.equal(binding.status, 'PRESENT');
  assert.equal(binding.supplementalCostInput?.latency, latency.evidence);
  assert.equal(binding.supplementalCostInput?.liquidityImpact, liquidityImpact);
  assert.equal(binding.supplementalCostInput?.partialFillImpact, partialFillImpact);
  assert.equal(binding.supplementalCostInput?.funding, funding);
  assert.equal(binding.otherCostComponentsChanged, false);
  assert.equal(binding.fullCostReadyEvaluated, false);

  const audit = auditAuthoritativeSupplementalCostSources({
    publicEvidence: {
      bidPrice: 99.9,
      askPrice: 100.1,
      takerFeeRate: 0.0006,
      fundingRate: 0.0001,
      tickerTimestampMs: nowMs - 100,
      observedAtMs: nowMs - 100,
    } as unknown as NonNullable<SupplementalAuditInput['publicEvidence']>,
    executionObservation: {
      slippage: cost(0.05, 'VISIBLE_L2_BOOK_WALK_ONLY'),
      latency: { observedRoundTripMs: 200, source: 'OBSERVED_REQUEST_DURATION', observedAtMs: nowMs - 100 },
      liquidity: { value: 10, source: 'PUBLIC_L2_DEPTH', observedAtMs: nowMs - 100 },
      partialFill: { model: 'ORDER_BOOK', source: 'PUBLIC_L2', observedAtMs: nowMs - 100 },
    } as unknown as NonNullable<SupplementalAuditInput['executionObservation']>,
    supplemental: binding.supplementalCostInput,
    nowMs,
    maximumAgeMs: 5_000,
  });
  assert.equal(audit.fullCostReady, true);
  assert.equal(audit.components.latency.value, latency.evidence?.valuePercent);
  const supplemental = buildAuthoritativeSupplementalCostEvidence(audit.supplementalCostInput!);
  assert.deepEqual(supplemental.latency, latency.evidence);
  assert.deepEqual(supplemental.liquidityImpact, liquidityImpact);
  assert.deepEqual(supplemental.partialFillImpact, partialFillImpact);
  assert.deepEqual(supplemental.funding, funding);
});

test('blocked latency remains null and keeps canonical fullCostReady false without changing other owners', () => {
  const blockedLatency = buildAuthoritativePaperLatencyCostEvidence({ ...baseInput(), postRequest: null });
  const liquidityImpact = cost(0.02, 'INDEPENDENT_LIQUIDITY_IMPACT');
  const partialFillImpact = cost(0.03, 'INDEPENDENT_PARTIAL_FILL_IMPACT');
  const funding = cost(0.04, 'HOLDING_HORIZON_FUNDING');
  const binding = bindAuthoritativePaperLatencyToSupplementalCostInput({
    sourceSupplementalCostInput: {
      costPolicyId: 'fixture-cost-v1',
      observedAtMs: nowMs - 100,
      liquidityImpact,
      partialFillImpact,
      funding,
      nowMs,
      maximumAgeMs: 5_000,
    },
    latency: blockedLatency,
  });
  assert.equal(binding.status, 'BLOCKED_DATA');
  assert.equal(binding.latencyStatus, 'BLOCKED_DATA');
  assert.equal(binding.supplementalCostInput?.latency, null);
  assert.equal(binding.supplementalCostInput?.liquidityImpact, liquidityImpact);
  assert.equal(binding.supplementalCostInput?.partialFillImpact, partialFillImpact);
  assert.equal(binding.supplementalCostInput?.funding, funding);

  const audit = auditAuthoritativeSupplementalCostSources({
    supplemental: binding.supplementalCostInput,
    nowMs,
    maximumAgeMs: 5_000,
  });
  assert.equal(audit.fullCostReady, false);
  assert.ok(audit.blockers.includes('LATENCY_COST_EVIDENCE_UNAVAILABLE'));
  assert.equal(audit.unknownIsZero, false);
});

test('safety contract remains simulation-only, public-only, and cost-owner isolated', () => {
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.publicMarketDataOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.observedRequestDurationRequired, true);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.distinctPrePostObservationRequired, true);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.requestDurationMayBeUsedAsPercentCost, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.spreadMayBeUsedAsLatencyCost, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.bookWalkMayBeUsedAsLatencyCost, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.liquidityImpactMayBeUsedAsLatencyCost, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.partialFillMayBeUsedAsLatencyCost, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.otherCostComponentsMutable, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.riskSizingPolicyMutable, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.causalExecutionClaimAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.privateApiAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.liveTrading, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.orderSubmissionAllowed, false);
});

// @ts-nocheck
// Test-only reuse of existing Natural lifecycle fixtures. No publication or runtime credit.
import { createHash } from 'node:crypto';
import { createRecurringPaperLoopState, runRecurringPaperCycle } from '../../../market-prediction-lab/src/recurring-paper-loop-v1.js';
import { FOUR_MARKET_EXECUTION_PROFILES } from '../../../market-prediction-lab/src/four-market-execution-v2.js';
import { AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION, createNaturalPaperTriggerBoundSettlementCostProducer } from '../../../market-prediction-lab/src/natural-paper-trigger-bound-settlement-cost-producer-v1.js';
import { advanceNaturalPaperPositionLifecycle } from '../../../market-prediction-lab/src/natural-paper-position-settlement-lifecycle-v1.js';
import { manualPaperEvidenceSha256 } from './manual-paper-canonical-contract.service';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const T0 = 1_800_000_000_000;
const SHA = "b".repeat(40);
const identity = Object.freeze({
  candidateId: `paper-candidate-v1:${"c".repeat(64)}`,
  strategyFamily: "natural-lifecycle",
  strategyId: "natural-lifecycle-v1",
  strategyVersion: "v1",
  parameterHash: "parameter-hash-v1",
  parameterDigest: "parameter-hash-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "execution-v1",
  accountMode: "PAPER",
});
function ledger() {
  return {
    status: "READY",
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: 1_000_000,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function execution(now = T0) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT;
  return {
    marketAdapterIdentity: profile.marketAdapter,
    strategyIdentity: identity,
    costPolicy: {
      version: "cost-v1",
      commissionRate: 0.001,
      taxRate: 0,
      spreadRate: 0,
      slippageRate: 0,
      latencyRate: 0,
      liquidityImpactRate: 0,
      partialFillImpactRate: 0,
      fundingRate: 0,
    },
    executionPolicy: {
      version: "execution-v1",
      fillModel: "TOP_OF_BOOK",
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill: true,
      maxParticipationRate: 1,
    },
    dataEvidence: {
      provider: profile.provider,
      publicOnly: true,
      dataQuality: "READY",
      provenance: "public-lifecycle-fixture",
      asOfMs: now - 1,
      maxAgeMs: 60_000,
      quoteEvidence: { available: true, bid: 99, ask: 100, asOfMs: now - 1, maxAgeMs: 60_000 },
      marketStatus: "TRADABLE",
      tickSize: 1,
      minOrderNotional: 1,
    },
  };
}

function candidate(id = "entry-1", overrides = {}) {
  const signalTimestampMs = T0 - 2;
  const base = {
    testOnly: true,
    candidateId: identity.candidateId,
    naturalEvidence: { provenanceClass: "TEST_ONLY", testOnly: true },
    signal: {
      signalId: id,
      market: "CRYPTO_SPOT",
      symbol: `CRYPTO_SPOT:${id}`,
      timestampMs: signalTimestampMs,
      style: "SWING",
      timeframe: "1h",
      horizon: 4,
      expiresAtMs: T0 + 4 * 3_600_000,
      direction: "BUY",
      strategyIdentity: identity,
      learningSnapshot: {
        signalId: id,
        timestamp: new Date(signalTimestampMs).toISOString(),
        market: "CRYPTO_SPOT",
        symbol: `CRYPTO_SPOT:${id}`,
        strategyHorizon: "SWING",
        direction: "BUY",
        entryPrice: 100,
        stopLoss: 95,
        target1: 105,
        target2: 110,
        timeframes: ["1h"],
        strategyProfileVersion: identity.strategyVersion,
        immutable: true,
        executionAuthority: "NONE",
      },
    },
    riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: {
      status: "READY",
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.01,
      riskRewardRatio: 1.5,
      sampleSize: 30,
      costPolicyId: "cost-v1",
      executionAuthority: "NONE",
    },
    execution: execution(),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    quote: { bid: 99, ask: 100, bidSize: 10, askSize: 10, asOfMs: T0 - 1, maxAgeMs: 60_000 },
  };
  return {
    ...base,
    ...overrides,
    signal: { ...base.signal, ...(overrides.signal ?? {}) },
  };
}

function naturalEvidence(observationId, observedAtMs) {
  return {
    provenanceClass: "NATURAL_FORWARD",
    synthetic: false,
    replay: false,
    testOnly: false,
    backfill: false,
    historical: false,
    duplicate: false,
    observationId,
    source: "public-natural-fixture",
    provenance: "future-natural-cycle-fixture",
    observedAtMs,
  };
}

function harness() {
  let settlementMutations = 0;
  let savedState = null;
  return {
    state: createRecurringPaperLoopState({ identity, ledger: ledger(), createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { return current; },
      async applySettlement({ ledger: current, settlement }) {
        settlementMutations += 1;
        return {
          ...current,
          knownEquityKrw: current.knownEquityKrw + settlement.netPnl,
          totalEquityKrw: current.totalEquityKrw + settlement.netPnl,
        };
      },
    },
    learningAdapter: {
      async persistSignal() {},
      async persistOutcome() {},
    },
    stateStore: {
      async save({ state }) { savedState = state; },
    },
    getSettlementMutations: () => settlementMutations,
    getSavedState: () => savedState,
  };
}

function cycle(id, time) {
  return { cycleId: id, evaluatedAtMs: time, identity };
}

function run(h, input) {
  return runRecurringPaperCycle({
    ...input,
    ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter,
    stateStore: h.stateStore,
  });
}

function costEvidence(now) {
  const component = (name, value = 0) => ({
    status: "PRESENT",
    valuePercent: value,
    quality: ["tax", "funding"].includes(name) ? "NOT_APPLICABLE" : name === "commission" ? "DOCUMENTED" : "OBSERVED",
    source: `test-only-${name}-producer`,
    provenance: "contract-fixture-runtime-credit-zero",
    policyIdentity: { version: "cost-v1" },
    observedAtMs: now - 1,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  });
  return {
    schemaVersion: "authoritative-paper-execution-cost-sources-v1",
    status: "PRESENT",
    fullCostReady: true,
    maximumAgeMs: 60_000,
    components: {
      commission: component("commission", 0.1),
      tax: component("tax"),
      spread: component("spread"),
      slippage: component("slippage"),
      funding: component("funding"),
      latency: component("latency"),
      liquidityImpact: component("liquidity-impact"),
      partialFillImpact: component("partial-fill-impact"),
    },
    supplementalCostInput: { costPolicyId: "cost-v1" },
    costPolicyIdentity: { version: "cost-v1" },
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  };
}

function authoritativeTriggerSettlementEvidence(position, trigger, triggerObservation, evaluatedAtMs) {
  const sourceIdentity = "CANONICAL_PUBLIC_SETTLEMENT_AGGREGATOR_V1";
  const provenanceId = sha256(`settlement:${position.positionId}:${trigger.exitTriggerId}`);
  const positionIdentity = {
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    signalTimeframe: position.sample.identity.timeframe,
    horizon: position.sample.identity.horizon,
    direction: position.direction,
    candidateId: position.candidateId,
    strategyFamily: position.strategyFamily,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    accountMode: position.accountMode,
  };
  const exitExecutionIdentity = {
    exitTriggerId: trigger.exitTriggerId,
    triggerObservationId: trigger.triggerObservationId,
    triggeredAtMs: trigger.triggeredAtMs,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    entryId: position.paperSampleId,
    provider: triggerObservation.settlementInput.exitExecution.dataEvidence.provider,
    market: position.market,
    symbol: position.symbol,
    timeframe: position.sample.identity.timeframe,
    horizon: position.sample.identity.horizon,
    direction: position.direction,
    candidateId: position.candidateId,
    strategyFamily: position.strategyFamily,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha,
    accountMode: position.accountMode,
    costPolicyVersion: position.costPolicyVersion,
    sourceIdentity,
    provenanceId,
    exitExecutionDigest: sha256(stableJson(triggerObservation.settlementInput.exitExecution)),
  };
  exitExecutionIdentity.exitExecutionId = sha256(stableJson(exitExecutionIdentity));
  const maximumAgeMs = 60_000;
  const observedAtMs = evaluatedAtMs - 1;
  const settlementCostEvidence = structuredClone(triggerObservation.settlementCostEvidence);
  settlementCostEvidence.exitTriggerId = trigger.exitTriggerId;
  settlementCostEvidence.sourceIdentity = sourceIdentity;
  settlementCostEvidence.provenanceId = provenanceId;
  settlementCostEvidence.positionIdentity = positionIdentity;
  settlementCostEvidence.exitExecutionIdentity = exitExecutionIdentity;
  settlementCostEvidence.exitExecutionId = exitExecutionIdentity.exitExecutionId;
  settlementCostEvidence.projectedFundingRealized = false;
  for (const [name, component] of Object.entries(settlementCostEvidence.components)) {
    component.sourceIdentity = `CANONICAL_${name.toUpperCase()}_SOURCE_V1`;
    component.provenanceId = sha256(`settlement:${name}:${trigger.exitTriggerId}`);
    component.positionIdentity = positionIdentity;
    component.exitExecutionIdentity = exitExecutionIdentity;
    component.observedAtMs = observedAtMs;
    component.freshness = { observedAtMs, maximumAgeMs };
    if (name === "funding") {
      component.realized = false;
      component.projectedIsRealized = false;
    }
  }
  return {
    schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
    status: "PRESENT",
    fullCostReady: true,
    sourceIdentity,
    provenanceId,
    positionIdentity,
    exitExecutionIdentity,
    exitExecutionId: exitExecutionIdentity.exitExecutionId,
    freshness: { observedAtMs, maximumAgeMs },
    settlementInput: {
      ...structuredClone(triggerObservation.settlementInput),
      exitTriggerId: trigger.exitTriggerId,
      exitExecutionId: exitExecutionIdentity.exitExecutionId,
    },
    settlementCostEvidence,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    synthetic: false,
    replay: false,
    backfill: false,
    duplicate: false,
    historical: false,
    testOnly: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function observation(position, id, now, bar, overrides = {}) {
  const base = {
    observationId: id,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    candidateId: position.candidateId,
    strategyFamily: position.strategyFamily,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    accountMode: position.accountMode,
    publicOnly: true,
    source: "public-market-fixture",
    provenance: "test-only natural lifecycle observation",
    observedAtMs: now,
    maxAgeMs: 60_000,
    bar,
    naturalEvidence: { provenanceClass: "TEST_ONLY", testOnly: true },
    settlementCostEvidence: costEvidence(now),
    settlementInput: {
      exitExecution: execution(now + 1),
      exitBar: { ...bar, timestampMs: now },
      exitQuote: { bid: bar.close, ask: bar.close + 1, last: bar.close, bidSize: 10, askSize: 10, asOfMs: now, maxAgeMs: 60_000 },
      pathBars: [],
      fundingEvidence: { complete: true, payments: [] },
    },
  };
  return { ...base, ...overrides };
}

async function open(h, id = "entry-1", candidateOverrides = {}) {
  return run(h, {
    state: h.state,
    cycle: cycle(`open-${id}`, T0),
    candidates: [candidate(id, candidateOverrides)],
  });
}

export async function manualCanonicalFixture(paperState, options = {}) {
  const paperAccountId = paperState.account.id;
  const h = harness();
  const c = candidate('manual-contract', { signal: { symbol: 'KRW-BTC' } });
  if (options.executionCostPolicy) c.execution.costPolicy = { ...c.execution.costPolicy, ...options.executionCostPolicy };
  if (options.futuresEvidence) {
    c.signal.market = 'CRYPTO_FUTURES';
    c.signal.symbol = 'BTCUSDT';
    c.signal.direction = options.direction;
    c.signal.signalDirection = 'BUY';
    c.order.direction = options.direction;
    c.execution.marketAdapterIdentity = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_FUTURES.marketAdapter;
    c.execution.dataEvidence = { ...c.execution.dataEvidence, ...options.futuresEvidence };
    c.signal.learningSnapshot.market = c.signal.market;
    c.signal.learningSnapshot.direction = c.signal.direction;
  }
  c.signal.learningSnapshot.symbol = c.signal.symbol;
  const opened = await run(h, { state: h.state, cycle: cycle('manual-open', T0), candidates: [c] });
  const p = opened.state.positions[0];
  const canonicalIdentity = {
    candidateId: p.candidateId, strategyId: p.strategyId, parameterHash: p.parameterHash,
    market: p.market, symbol: p.symbol, timeframe: p.sample.identity.timeframe,
    side: options.direction ?? 'LONG', leverage: p.accountingEvidence?.leverage ?? c.order.quantity, parameterDigest: p.parameterDigest,
    signalDirection: p.sample.identity.signalDirection, accountMode: p.accountMode, researchCodeSha: p.researchCodeSha,
  };
  const entryCostEvidence = costEvidence(T0);
  for (const [name, component] of Object.entries(entryCostEvidence.components)) {
    component.valuePercent = c.execution.costPolicy[`${name}Rate`] * 100;
    component.identity = canonicalIdentity;
    component.paperSampleId = p.paperSampleId;
    component.positionId = p.positionId;
  }
  // Controlled verification stub, never a genuine published validation receipt.
  const validationReceipt = {
    receiptId: 'contract-fixture-receipt', receiptVersion: 'v1',
    source: 'TEST_ONLY_OWNER_READER_STUB', provenance: 'contract fixture; runtime evidence credit zero',
    status: 'VALIDATED', observedAtMs: T0, maximumAgeMs: entryCostEvidence.maximumAgeMs,
    identity: canonicalIdentity, datasetDigest: manualPaperEvidenceSha256(c), resultArtifactDigest: manualPaperEvidenceSha256(p.sample),
    synthetic: false, replay: false, backfill: false, historical: false, testOnly: false,
  };
  const evidence = {
    authenticatedAccountId: 'contract-fixture-account', paperAccountId, paperStateSha256: manualPaperEvidenceSha256(paperState), candidate: c, position: p,
    entryCostEvidence, validationReceipt,
    receiptVerification: { ownerId: 'TEST_ONLY_OWNER_READER_STUB', source: validationReceipt.source,
      provenance: validationReceipt.provenance, verifiedAtMs: T0, readbackVerified: true, validationPassed: true,
      receiptSha256: manualPaperEvidenceSha256(validationReceipt) },
  };
  if (options.entryOnly) return { evidence, canonicalIdentity, now: new Date(T0) };
  const nowMs = T0 + 1000;
  const raw = observation(p, 'manual-exit', nowMs, options.exitBar ?? { open: 100, high: 106, low: 99, close: 105 });
  // Freeze the actual lifecycle trigger before invoking the canonical cost producer.
  raw.settlementCostEvidence = null;
  const pending = advanceNaturalPaperPositionLifecycle({ position: p, observation: raw, evaluatedAtMs: nowMs });
  const pendingPosition = pending.position;
  const trigger = pendingPosition.lifecycle.pendingExit;
  const complete = observation(pendingPosition, 'manual-costs', nowMs, raw.bar);
  complete.settlementInput.exitExecution.costPolicy = { ...c.execution.costPolicy };
  for (const [name, component] of Object.entries(complete.settlementCostEvidence.components)) {
    component.valuePercent = c.execution.costPolicy[`${name}Rate`] * 100;
  }
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence() {
      const value = authoritativeTriggerSettlementEvidence(pendingPosition, trigger, complete, nowMs);
      if (options.omitExitComponent) delete value.settlementCostEvidence.components[options.omitExitComponent];
      return value;
    },
  });
  const bound = await producer({ position: pendingPosition, observation: raw, evaluatedAtMs: nowMs });
  const exitEvidence = { ...evidence, position: pendingPosition, settlement: { observation: bound.observation, trigger } };
  return { evidence, exitEvidence, canonicalIdentity, now: new Date(T0), exitNow: new Date(nowMs), bound };
}


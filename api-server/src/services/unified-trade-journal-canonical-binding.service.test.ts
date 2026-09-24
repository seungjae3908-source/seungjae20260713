import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import {
  bindCanonicalResearchToUnifiedJournal,
  readCanonicalResearchOwnerStateForJournalBinding,
} from './unified-trade-journal-canonical-binding.service';
import { manualPaperEvidenceSha256 } from './manual-paper-canonical-contract.service';
import type { PaperTradingState } from './paper-trading.types';

const NOW = new Date('2026-09-24T10:20:00.000Z');
const NOW_MS = NOW.getTime();
const SOURCE_SHA = 'a'.repeat(40);
const DATASET_DIGEST = 'b'.repeat(64);
const RESULT_DIGEST = 'c'.repeat(64);
const VERIFIED_AT_MS = NOW_MS - 120_000;

const identity = {
  candidateId: 'candidate-authenticated-1',
  strategyId: 'strategy-authenticated-1',
  parameterHash: 'parameter-hash-1',
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  side: 'LONG' as const,
  leverage: 2,
  parameterDigest: 'parameter-digest-1',
  signalDirection: 'LONG',
  accountMode: 'PAPER' as const,
  researchCodeSha: SOURCE_SHA,
};

function validationReceipt() {
  const receipt = {
    identity,
    receiptId: 'receipt-1',
    receiptVersion: 'v1',
    source: 'forward-observer',
    provenance: 'authenticated-owner-readback',
    status: 'VALIDATED' as const,
    observedAtMs: VERIFIED_AT_MS - 1_000,
    maximumAgeMs: 60_000,
    synthetic: false as const,
    replay: false as const,
    backfill: false as const,
    historical: false as const,
    testOnly: false as const,
    datasetDigest: DATASET_DIGEST,
    resultArtifactDigest: RESULT_DIGEST,
  };
  return {
    receipt,
    verification: {
      ownerId: 'paper-owner',
      source: 'paper-state-publisher',
      provenance: 'immutable-snapshot',
      verifiedAtMs: VERIFIED_AT_MS,
      readbackVerified: true as const,
      validationPassed: true as const,
      receiptSha256: manualPaperEvidenceSha256(receipt),
    },
  };
}

function syncedJournalPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'journal-1',
    tradeId: 'trade-authenticated-1',
    source: 'APP_PAPER',
    status: 'open',
    symbol: 'BTCUSDT',
    side: 'long',
    currency: 'USDT',
    filledAt: '2026-09-24T10:00:00.000Z',
    closedAt: null,
    entryPrice: 100,
    exitPrice: null,
    initialQuantity: 1,
    closedQuantity: 0,
    remainingQuantity: 1,
    entryFee: 0.1,
    exitFee: 0,
    tax: 0,
    grossPnl: 0,
    strategyName: 'breakout',
    timeframe: '15m',
    ...overrides,
  };
}

function canonicalLineage(settlementMode: 'none'|'valid'|'invalid'|'invalid-cost'|'invalid-net' = 'none') {
  const component = (name: string) => ({
    status: 'PRESENT',
    source: `public:${name}`,
    provenance: `authenticated:${name}`,
    quality: name === 'tax' || name === 'funding' ? 'NOT_APPLICABLE' : 'OBSERVED',
    valuePercent: name === 'tax' || name === 'funding' ? 0 : 0.01,
    observedAtMs: VERIFIED_AT_MS - 2_000,
  });
  const components = {
    commission: component('commission'),
    tax: component('tax'),
    spread: component('spread'),
    slippage: component('slippage'),
    funding: component('funding'),
    latency: component('latency'),
    liquidityImpact: component('liquidityImpact'),
    partialFillImpact: component('partialFillImpact'),
  };
  const fullCost = {
    schemaVersion: 'natural-paper-settlement-full-cost-v1',
    status: settlementMode === 'invalid-cost' ? 'BLOCKED_DATA' : 'PRESENT',
    fullCostReady: settlementMode !== 'invalid-cost',
    components,
    costPolicyIdentity: { version: 'cost-v1' },
    exitTriggerId: 'exit-trigger-1',
    exitExecutionId: 'exit-execution-1',
    evidenceDigest: manualPaperEvidenceSha256({
      components,
      exitTriggerId: 'exit-trigger-1',
      exitExecutionId: 'exit-execution-1',
      policy: 'cost-v1',
    }),
    blockers: settlementMode === 'invalid-cost' ? ['PAPER_POSITION_SETTLEMENT_COST_EVIDENCE_MISSING'] : [],
    unknownIsZero: false,
    naturalSampleCredit: 0,
    executionAuthority: 'NONE',
  };
  const canonicalGrossPnl = 0;
  const canonicalNetPnl = settlementMode === 'invalid-net' ? -0.2 : -0.1;
  const settlementIdentity = {
    candidateId: identity.candidateId,
    entryId: 'paper-sample-1',
    positionId: 'natural-position-1',
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    side: identity.side,
    parameterDigest: identity.parameterDigest,
    accountMode: identity.accountMode,
    costEvidenceDigest: fullCost.evidenceDigest,
    netPnl: canonicalNetPnl,
    netReturnPercent: -0.1,
  };
  const settlement = {
    settlementId: manualPaperEvidenceSha256(settlementIdentity),
    settlementIdentity,
    candidateId: identity.candidateId,
    strategyId: identity.strategyId,
    parameterHash: identity.parameterHash,
    parameterDigest: identity.parameterDigest,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    accountMode: identity.accountMode,
    researchCodeSha: identity.researchCodeSha,
    positionId: 'natural-position-1',
    entryId: 'paper-sample-1',
    entryDirection: identity.side,
    exitTriggerId: settlementMode === 'invalid' ? 'forged-trigger' : fullCost.exitTriggerId,
    exitExecutionId: fullCost.exitExecutionId,
    grossPnl: canonicalGrossPnl,
    netPnl: canonicalNetPnl,
    netReturnPercent: -0.1,
    lifecycleEvidence: { costEvidence: fullCost },
  };
  return {
    identity,
    naturalPositionId: 'natural-position-1',
    paperSampleId: 'paper-sample-1',
    sample: {},
    entryCostEvidence: {},
    validationReceipt: validationReceipt(),
    ...(settlementMode === 'none' ? {} : { settlement, fullCost }),
    naturalSampleCredit: 0 as const,
    executionAuthority: 'NONE' as const,
  };
}

function ownerState(options: {
  canonical?: boolean;
  entryPrice?: number;
  grossPnl?: number;
  settlementMode?: 'none'|'valid'|'invalid'|'invalid-cost'|'invalid-net';
} = {}) {
  const canonical = options.canonical ?? true;
  const entryPrice = options.entryPrice ?? 100;
  const grossPnl = options.grossPnl ?? 0;
  return {
    journal: [{
      id: 'journal-1',
      tradeId: 'trade-authenticated-1',
      orderId: 'order-1',
      positionId: 'manual-position-1',
      symbol: 'BTCUSDT',
      side: 'long',
      orderType: 'market',
      strategyName: 'breakout',
      submittedAt: '2026-09-24T09:59:59.000Z',
      filledAt: '2026-09-24T10:00:00.000Z',
      closedAt: null,
      entryPrice,
      entryReferencePrice: entryPrice,
      stopLossPrice: 95,
      takeProfitPrice1: 110,
      takeProfitPrice2: null,
      exitPrice: null,
      initialQuantity: 1,
      closedQuantity: 0,
      remainingQuantity: 1,
      leverage: 2,
      notionalValue: 100,
      requiredMargin: 50,
      entryFee: 0.1,
      exitFee: 0,
      slippageCost: 0,
      fundingCost: 0,
      grossPnl,
      netPnl: grossPnl - 0.1,
      rMultiple: null,
      exitReason: null,
      dataStatusAtEntry: 'READY',
      marketRegimeAtEntry: 'TREND',
      riskBlocked: false,
      warnings: [],
      ruleViolation: false,
      status: 'open',
      note: '',
      ...(canonical ? { canonicalPaper: canonicalLineage(options.settlementMode ?? 'none') } : {}),
    }],
  } as unknown as PaperTradingState;
}

test('missing authenticated owner readback keeps APP_PAPER binding unavailable', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload()], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'NOT_AVAILABLE',
    sourceSha: SOURCE_SHA,
    reason: 'PAPER_STATE_OWNER_READBACK_UNAVAILABLE',
  }, NOW_MS);
  assert.equal(result.trades[0]?.canonicalResearchBinding.status, 'NOT_AVAILABLE');
  assert.equal(result.canonicalResearchBinding.verifiedTradeCount, 0);
  assert.equal(result.canonicalResearchBinding.profitabilityCredit, 0);
});

test('client-side forged canonicalPaper self-claim is never trusted without owner lineage', () => {
  const forged = syncedJournalPayload({
    canonicalPaper: canonicalLineage(),
  });
  const journal = buildUnifiedTradeJournal([forged], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ canonical: false }),
  }, NOW_MS);
  assert.equal(result.trades[0]?.canonicalResearchBinding.status, 'NOT_AVAILABLE');
  assert.equal(result.trades[0]?.canonicalResearchBinding.reason, 'CANONICAL_PAPER_LINEAGE_NOT_PRESENT');
  assert.equal(result.trades[0]?.canonicalResearchBinding.candidateId, null);
});

test('authenticated owner state plus genuine validation receipt verifies candidate binding', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload()], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState(),
  }, NOW_MS);
  const value = result.trades[0]?.canonicalResearchBinding;
  assert.equal(value?.status, 'VERIFIED');
  assert.equal(value?.candidateId, identity.candidateId);
  assert.equal(value?.strategyId, identity.strategyId);
  assert.equal(value?.researchCodeSha, SOURCE_SHA);
  assert.equal(value?.settlementBindingVerified, false);
  assert.equal(value?.fullCostBindingVerified, false);
  assert.equal(value?.fullCostEvidenceDigest, null);
  assert.equal(value?.fullCostComponentCount, 0);
  assert.equal(value?.netPnlBindingVerified, false);
  assert.equal(value?.canonicalNetPnl, null);
  assert.equal(value?.netPnlEvidenceDigest, null);
  assert.equal(value?.executionAuthority, 'NONE');
  assert.equal(value?.profitabilityCredit, 0);
  assert.equal(result.canonicalResearchBinding.status, 'VERIFIED');
  assert.equal(result.canonicalResearchBinding.verifiedTradeCount, 1);
});

test('synced journal economic identity mismatch fails closed', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload()], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ entryPrice: 101 }),
  }, NOW_MS);
  assert.equal(result.trades[0]?.canonicalResearchBinding.status, 'MISMATCH');
  assert.equal(result.trades[0]?.canonicalResearchBinding.reason, 'SYNCED_JOURNAL_OWNER_STATE_MISMATCH');
  assert.equal(result.canonicalResearchBinding.mismatchTradeCount, 1);
});

test('synced journal gross PnL tampering fails closed before candidate binding', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload({ grossPnl: 5 })], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ grossPnl: 0 }),
  }, NOW_MS);
  assert.equal(result.trades[0]?.canonicalResearchBinding.status, 'MISMATCH');
  assert.equal(result.trades[0]?.canonicalResearchBinding.reason, 'SYNCED_JOURNAL_OWNER_STATE_MISMATCH');
});

test('only full canonical settlement identity sets settlementBindingVerified', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload()], { range: 'ALL' }, NOW);
  const valid = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ settlementMode: 'valid' }),
  }, NOW_MS);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.status, 'VERIFIED');
  assert.equal(valid.trades[0]?.canonicalResearchBinding.settlementBindingVerified, true);
  assert.ok(valid.trades[0]?.canonicalResearchBinding.settlementId);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.triggerBindingVerified, true);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.exitTriggerId, 'exit-trigger-1');
  assert.equal(valid.trades[0]?.canonicalResearchBinding.exitExecutionId, 'exit-execution-1');
  assert.equal(valid.trades[0]?.canonicalResearchBinding.fullCostBindingVerified, true);
  assert.match(valid.trades[0]?.canonicalResearchBinding.fullCostEvidenceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.fullCostComponentCount, 8);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.netPnlBindingVerified, true);
  assert.equal(valid.trades[0]?.canonicalResearchBinding.canonicalNetPnl, -0.1);
  assert.match(valid.trades[0]?.canonicalResearchBinding.netPnlEvidenceDigest ?? '', /^[0-9a-f]{64}$/u);

  const invalid = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ settlementMode: 'invalid' }),
  }, NOW_MS);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.status, 'VERIFIED');
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.settlementBindingVerified, false);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.settlementId, null);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.triggerBindingVerified, false);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.exitTriggerId, null);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.exitExecutionId, null);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.fullCostBindingVerified, false);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.fullCostEvidenceDigest, null);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.fullCostComponentCount, 0);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.netPnlBindingVerified, false);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.canonicalNetPnl, null);
  assert.equal(invalid.trades[0]?.canonicalResearchBinding.netPnlEvidenceDigest, null);

  const invalidCost = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ settlementMode: 'invalid-cost' }),
  }, NOW_MS);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.settlementBindingVerified, true);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.triggerBindingVerified, true);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.fullCostBindingVerified, false);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.fullCostEvidenceDigest, null);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.fullCostComponentCount, 0);
  assert.equal(invalidCost.trades[0]?.canonicalResearchBinding.netPnlBindingVerified, false);

  const invalidNet = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: SOURCE_SHA,
    state: ownerState({ settlementMode: 'invalid-net' }),
  }, NOW_MS);
  assert.equal(invalidNet.trades[0]?.canonicalResearchBinding.settlementBindingVerified, true);
  assert.equal(invalidNet.trades[0]?.canonicalResearchBinding.fullCostBindingVerified, true);
  assert.equal(invalidNet.trades[0]?.canonicalResearchBinding.netPnlBindingVerified, false);
  assert.equal(invalidNet.trades[0]?.canonicalResearchBinding.canonicalNetPnl, null);
  assert.equal(invalidNet.trades[0]?.canonicalResearchBinding.netPnlEvidenceDigest, null);
});

test('owner lineage bound to a different deploy SHA cannot verify', () => {
  const journal = buildUnifiedTradeJournal([syncedJournalPayload()], { range: 'ALL' }, NOW);
  const result = bindCanonicalResearchToUnifiedJournal(journal, {
    status: 'PRESENT',
    sourceSha: 'd'.repeat(40),
    state: ownerState(),
  }, NOW_MS);
  assert.equal(result.trades[0]?.canonicalResearchBinding.status, 'MISMATCH');
  assert.equal(result.trades[0]?.canonicalResearchBinding.reason, 'CANONICAL_PAPER_OWNER_LINEAGE_MISMATCH');
});

test('missing exact DEPLOY_SHA returns fail-closed readback without calling state reader', async () => {
  let calls = 0;
  const result = await readCanonicalResearchOwnerStateForJournalBinding({
    authenticatedAccountId: 'user-1',
    nowMs: NOW_MS,
    env: {},
    readState: async () => {
      calls += 1;
      return ownerState();
    },
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.reason, 'PAPER_STATE_EXACT_DEPLOY_SHA_UNAVAILABLE');
  assert.equal(calls, 0);
});

import { createHash } from "node:crypto";

const SCHEMA_VERSION = "authoritative-natural-paper-account-ledger-v1";
const ENTRY_EVIDENCE_VERSION = "authoritative-natural-paper-entry-accounting-v1";
const MARKET = "CRYPTO_FUTURES";
const CURRENCY = "USDT";
const EPSILON = 1e-8;

export const AUTHORITATIVE_NATURAL_PAPER_ACCOUNTING_CONTRACT = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  market: MARKET,
  currency: CURRENCY,
  authenticatedSeedRequired: true,
  exactAccountBindingRequired: true,
  syntheticSeedAllowed: false,
  recurringLedgerDerivationAllowed: false,
  entryMarginReservationRequired: true,
  settlementMarginReleaseRequired: true,
  nativeCostAccountingRequired: true,
  fxEvidenceRequiredForKrwReporting: true,
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  financialMutationAllowed: false,
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateDigestSha256(state) {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function accountError(code) {
  return Object.assign(new Error(code), { code });
}

export function isAuthoritativeNaturalPaperAccountError(error) {
  return typeof error?.code === "string" && error.code.startsWith("AUTHORITATIVE_NATURAL_PAPER_");
}

function validatePaperState(state) {
  if (!state || state.schemaVersion !== 1 || !state.account) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_STATE_INVALID");
  }
  const account = state.account;
  for (const value of [
    account.initialBalance,
    account.cashBalance,
    account.realizedPnl,
    account.unrealizedPnl,
    account.equity,
    account.usedMargin,
    account.availableMargin,
  ]) {
    if (!finite(value)) throw accountError("AUTHORITATIVE_NATURAL_PAPER_ACCOUNT_VALUE_INVALID");
  }
  if (!positive(account.initialBalance) || !positive(account.equity) || !nonEmpty(account.id)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ACCOUNT_IDENTITY_INVALID");
  }
  if (!Array.isArray(state.orders)
    || !Array.isArray(state.positions)
    || !Array.isArray(state.fills)
    || !Array.isArray(state.journal)
    || !Array.isArray(state.processedEventIds)
    || !state.riskState) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_STATE_COLLECTION_INVALID");
  }
  if ([
    state.riskState.dailyRealizedPnl,
    state.riskState.weeklyRealizedPnl,
    state.riskState.consecutiveLosses,
  ].some((value) => !finite(value))) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_RISK_STATE_INVALID");
  }
}

function openPositions(state) {
  return state.positions.filter((position) => position?.status !== "closed");
}

function pendingOrders(state) {
  return state.orders.filter((order) => order?.status === "pending");
}

function validateCleanAuthenticatedSeed(snapshot, expectedPublisherAccountIdSha256, expectedSourceSha, nowMs) {
  if (!snapshot || snapshot.schemaVersion !== "paper-trading-state-snapshot-v2"
    || snapshot.immutable !== true
    || snapshot.executionAuthority !== "NONE"
    || snapshot.privateApiAllowed !== false
    || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SNAPSHOT_CONTRACT_INVALID");
  }
  if (snapshot.market !== MARKET || snapshot.currency !== CURRENCY) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SNAPSHOT_MARKET_CURRENCY_MISMATCH");
  }
  if (!digest(expectedPublisherAccountIdSha256)
    || snapshot.publisherAccountIdSha256 !== expectedPublisherAccountIdSha256) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ACCOUNT_BINDING_MISMATCH");
  }
  if (!immutableSha(expectedSourceSha) || snapshot.sourceSha !== expectedSourceSha) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SOURCE_SHA_MISMATCH");
  }
  if (!digest(snapshot.stateDigestSha256)
    || !finite(nowMs)
    || nowMs <= 0
    || !finite(snapshot.observedAtMs)
    || snapshot.observedAtMs <= 0
    || !finite(snapshot.stateUpdatedAtMs)
    || snapshot.stateUpdatedAtMs <= 0
    || !positive(snapshot.maximumAgeMs)
    || snapshot.observedAtMs > nowMs
    || snapshot.stateUpdatedAtMs > snapshot.observedAtMs
    || nowMs - snapshot.stateUpdatedAtMs > snapshot.maximumAgeMs) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SNAPSHOT_STALE_OR_INVALID");
  }
  validatePaperState(snapshot.state);
  const currentOpenPositionCount = openPositions(snapshot.state).length;
  if (snapshot.paperStateSchemaVersion !== snapshot.state.schemaVersion
    || snapshot.accountId !== snapshot.state.account.id
    || !finite(snapshot.equity)
    || snapshot.equity !== snapshot.state.account.equity
    || !Number.isInteger(snapshot.openPositionCount)
    || snapshot.openPositionCount < 0
    || snapshot.openPositionCount !== currentOpenPositionCount
    || snapshot.stateDigestSha256 !== stateDigestSha256(snapshot.state)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SNAPSHOT_INTEGRITY_MISMATCH");
  }
  if (currentOpenPositionCount !== 0
    || pendingOrders(snapshot.state).length !== 0
    || Math.abs(snapshot.state.account.usedMargin) > EPSILON
    || Math.abs(snapshot.state.account.unrealizedPnl) > EPSILON) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SEED_NOT_FLAT");
  }
  return snapshot;
}

function accountProjection(ledger) {
  const state = ledger.paperState;
  const active = ledger.reservations.filter((reservation) => reservation.status === "OPEN");
  const usedMargin = active.reduce((sum, reservation) => sum + reservation.requiredMargin, 0);
  state.account.usedMargin = usedMargin;
  state.account.unrealizedPnl = 0;
  state.account.equity = state.account.cashBalance;
  state.account.availableMargin = state.account.equity - state.account.usedMargin;
  if (!finite(state.account.availableMargin)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_AVAILABLE_MARGIN_INVALID");
  }
  return state;
}

function touchPaperState(ledger, evaluatedAtMs) {
  const at = new Date(evaluatedAtMs).toISOString();
  ledger.paperState.account.updatedAt = at;
  ledger.paperState.updatedAt = at;
}

function dayKey(atMs) {
  return new Date(atMs).toISOString().slice(0, 10);
}

function weekKey(atMs) {
  const date = new Date(atMs);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function updateRiskState(state, netPnl, evaluatedAtMs) {
  const nextDay = dayKey(evaluatedAtMs);
  const nextWeek = weekKey(evaluatedAtMs);
  const risk = state.riskState;
  risk.dailyRealizedPnl = risk.dayKey === nextDay ? risk.dailyRealizedPnl + netPnl : netPnl;
  risk.weeklyRealizedPnl = risk.weekKey === nextWeek ? risk.weeklyRealizedPnl + netPnl : netPnl;
  risk.dayKey = nextDay;
  risk.weekKey = nextWeek;
  risk.consecutiveLosses = netPnl < 0 ? risk.consecutiveLosses + 1 : 0;
}

function entryEvidence(position) {
  const sample = position?.sample;
  const evidence = position?.accountingEvidence;
  if (!sample || sample.status !== "OPEN" || sample.identity?.market !== MARKET
    || !nonEmpty(position?.positionId) || !nonEmpty(position?.paperSampleId)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ENTRY_POSITION_INVALID");
  }
  if (!evidence || evidence.schemaVersion !== ENTRY_EVIDENCE_VERSION
    || evidence.settlementCurrency !== CURRENCY
    || !positive(evidence.leverage)
    || !positive(evidence.entryNotional)
    || !positive(evidence.quantity)
    || !positive(evidence.fillPrice)
    || !nonNegative(evidence.immediateCost)
    || !nonEmpty(evidence.marginMode)
    || !digest(evidence.parityFingerprint)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ENTRY_ACCOUNTING_EVIDENCE_INVALID");
  }
  if (Math.abs(evidence.entryNotional - sample.fill.notional) > Math.max(EPSILON, sample.fill.notional * 1e-9)
    || Math.abs(evidence.quantity - sample.fill.filledQuantity) > EPSILON
    || Math.abs(evidence.fillPrice - sample.fill.fillPrice) > Math.max(EPSILON, sample.fill.fillPrice * 1e-9)
    || Math.abs(evidence.immediateCost - sample.fill.costs.immediateCost) > Math.max(EPSILON, (sample.fill.costs.immediateCost || 1) * 1e-9)
    || evidence.parityFingerprint !== sample.parityFingerprint) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ENTRY_ACCOUNTING_PARITY_MISMATCH");
  }
  return evidence;
}

function projectedPosition(position, evidence, evaluatedAtMs) {
  const sample = position.sample;
  return {
    id: `natural_${position.positionId}`,
    naturalPaperSampleId: position.paperSampleId,
    naturalPaperPositionId: position.positionId,
    symbol: sample.identity.symbol,
    side: sample.identity.executionDirection === "LONG" ? "long" : "short",
    entryPrice: evidence.fillPrice,
    currentPrice: evidence.fillPrice,
    quantity: evidence.quantity,
    remainingQuantity: evidence.quantity,
    leverage: evidence.leverage,
    notionalValue: evidence.entryNotional,
    requiredMargin: evidence.entryNotional / evidence.leverage,
    unrealizedPnl: 0,
    realizedPnl: -evidence.immediateCost,
    totalFees: evidence.immediateCost,
    totalSlippage: 0,
    totalFunding: 0,
    openedAt: new Date(evaluatedAtMs).toISOString(),
    closedAt: null,
    status: "open",
    orderId: `natural_order_${position.paperSampleId}`,
    strategyName: sample.identity.strategyId,
    warnings: [],
  };
}

function validateFxEvidence(evidence, settlement, cycle) {
  if (!evidence || evidence.status === "MISSING" || evidence.status === "UNAVAILABLE") return null;
  if (evidence.status !== "READY"
    || evidence.sourceCurrency !== CURRENCY
    || !positive(evidence.fxRateToKrw)
    || !finite(evidence.netPnlKrw)
    || !nonEmpty(evidence.source)
    || !nonEmpty(evidence.version)
    || !finite(evidence.asOfMs)
    || !positive(evidence.maxAgeMs)
    || evidence.asOfMs > cycle.evaluatedAtMs
    || cycle.evaluatedAtMs - evidence.asOfMs > evidence.maxAgeMs) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_FX_EVIDENCE_INVALID");
  }
  const expected = settlement.netPnl * evidence.fxRateToKrw;
  if (Math.abs(expected - evidence.netPnlKrw) > Math.max(1e-6, Math.abs(expected) * 1e-9)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_FX_CONVERSION_MISMATCH");
  }
  return Object.freeze({
    sourceCurrency: CURRENCY,
    fxRateToKrw: evidence.fxRateToKrw,
    netPnlKrw: evidence.netPnlKrw,
    source: evidence.source,
    version: evidence.version,
    asOfMs: evidence.asOfMs,
    maxAgeMs: evidence.maxAgeMs,
  });
}

export function isAuthoritativeNaturalPaperLedger(value) {
  return value?.schemaVersion === SCHEMA_VERSION;
}

export function validateAuthoritativeNaturalPaperLedger(
  value,
  { expectedPublisherAccountIdSha256 = null, expectedSourceSha = null } = {},
) {
  if (!isAuthoritativeNaturalPaperLedger(value)
    || value.status !== "READY"
    || value.market !== MARKET
    || value.baseCurrency !== CURRENCY
    || value.executionAuthority !== "NONE"
    || value.privateApiAllowed !== false
    || value.liveTrading !== false
    || value.financialMutationAllowed !== false) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_LEDGER_INVALID");
  }
  if (!value.accountBinding
    || !digest(value.accountBinding.publisherAccountIdSha256)
    || !immutableSha(value.accountBinding.sourceSha)
    || !digest(value.accountBinding.seedStateDigestSha256)
    || !nonEmpty(value.accountBinding.accountId)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_LEDGER_BINDING_INVALID");
  }
  if (expectedPublisherAccountIdSha256 != null
    && value.accountBinding.publisherAccountIdSha256 !== expectedPublisherAccountIdSha256) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_ACCOUNT_BINDING_MISMATCH");
  }
  if (expectedSourceSha != null && value.accountBinding.sourceSha !== expectedSourceSha) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_SOURCE_SHA_MISMATCH");
  }
  if (!Array.isArray(value.reservations)
    || !Array.isArray(value.appliedEntryIds)
    || !Array.isArray(value.appliedSettlementIds)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_LEDGER_COLLECTION_INVALID");
  }
  validatePaperState(value.paperState);
  const active = value.reservations.filter((reservation) => reservation?.status === "OPEN");
  for (const reservation of active) {
    if (!nonEmpty(reservation.paperSampleId)
      || !nonEmpty(reservation.positionId)
      || !positive(reservation.requiredMargin)
      || !positive(reservation.entryNotional)
      || !nonNegative(reservation.entryCost)
      || !positive(reservation.quantity)) {
      throw accountError("AUTHORITATIVE_NATURAL_PAPER_RESERVATION_INVALID");
    }
  }
  const expectedUsedMargin = active.reduce((sum, reservation) => sum + reservation.requiredMargin, 0);
  if (Math.abs(value.paperState.account.usedMargin - expectedUsedMargin) > Math.max(EPSILON, expectedUsedMargin * 1e-9)) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_MARGIN_RECONCILIATION_FAILED");
  }
  if (value.paperState.account.availableMargin < -EPSILON) {
    throw accountError("AUTHORITATIVE_NATURAL_PAPER_NEGATIVE_AVAILABLE_MARGIN");
  }
  return value;
}

export function createAuthoritativeNaturalPaperLedgerFromSnapshot({
  snapshot,
  expectedPublisherAccountIdSha256,
  expectedSourceSha,
  nowMs = Date.now(),
} = {}) {
  const validated = validateCleanAuthenticatedSeed(
    snapshot,
    expectedPublisherAccountIdSha256,
    expectedSourceSha,
    nowMs,
  );
  const paperState = clone(validated.state);
  paperState.account.usedMargin = 0;
  paperState.account.unrealizedPnl = 0;
  paperState.account.equity = paperState.account.cashBalance;
  paperState.account.availableMargin = paperState.account.equity;
  const ledger = {
    schemaVersion: SCHEMA_VERSION,
    status: "READY",
    market: MARKET,
    baseCurrency: CURRENCY,
    accountBinding: {
      publisherAccountIdSha256: validated.publisherAccountIdSha256,
      sourceSha: validated.sourceSha,
      seedStateDigestSha256: validated.stateDigestSha256,
      accountId: validated.accountId,
      seededAtMs: nowMs,
      seedObservedAtMs: validated.observedAtMs,
    },
    initialEquity: paperState.account.equity,
    paperState,
    reservations: [],
    appliedEntryIds: [],
    appliedSettlementIds: [],
    totalEntryCost: 0,
    totalExitCost: 0,
    totalFundingCost: 0,
    reportingKrw: {
      status: "UNAVAILABLE",
      currentEquityKrw: null,
      lastFxEvidence: null,
    },
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    ...safetyEnvelope(),
  };
  accountProjection(ledger);
  return Object.freeze(validateAuthoritativeNaturalPaperLedger(ledger, {
    expectedPublisherAccountIdSha256,
    expectedSourceSha,
  }));
}

export function paperStateFromAuthoritativeNaturalPaperLedger(
  ledger,
  { expectedPublisherAccountIdSha256 = null, expectedSourceSha = null } = {},
) {
  validateAuthoritativeNaturalPaperLedger(ledger, {
    expectedPublisherAccountIdSha256,
    expectedSourceSha,
  });
  return Object.freeze(clone(ledger.paperState));
}

export function createAuthoritativeNaturalPaperLedgerAdapter({
  accountingEvidenceForSettlement = async () => ({ status: "MISSING" }),
} = {}) {
  if (typeof accountingEvidenceForSettlement !== "function") {
    throw new TypeError("accountingEvidenceForSettlement must be a function");
  }
  return Object.freeze({
    async applyEntry({ ledger, position, cycle } = {}) {
      validateAuthoritativeNaturalPaperLedger(ledger);
      if (!finite(cycle?.evaluatedAtMs) || cycle.evaluatedAtMs <= 0) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_ENTRY_CYCLE_INVALID");
      }
      if (ledger.appliedEntryIds.includes(position?.paperSampleId)) return Object.freeze(clone(ledger));
      const evidence = entryEvidence(position);
      const requiredMargin = evidence.entryNotional / evidence.leverage;
      const requiredCapital = requiredMargin + evidence.immediateCost;
      if (!finite(requiredMargin) || requiredMargin <= 0
        || requiredCapital > ledger.paperState.account.availableMargin + EPSILON) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_INSUFFICIENT_MARGIN");
      }
      const next = clone(ledger);
      next.paperState.account.cashBalance -= evidence.immediateCost;
      next.paperState.account.realizedPnl -= evidence.immediateCost;
      next.paperState.positions.push(projectedPosition(position, evidence, cycle.evaluatedAtMs));
      next.reservations.push({
        paperSampleId: position.paperSampleId,
        positionId: position.positionId,
        projectedPositionId: `natural_${position.positionId}`,
        status: "OPEN",
        entryNotional: evidence.entryNotional,
        requiredMargin,
        entryCost: evidence.immediateCost,
        quantity: evidence.quantity,
        leverage: evidence.leverage,
        marginMode: evidence.marginMode,
        openedAtMs: cycle.evaluatedAtMs,
      });
      next.appliedEntryIds.push(position.paperSampleId);
      next.totalEntryCost += evidence.immediateCost;
      accountProjection(next);
      touchPaperState(next, cycle.evaluatedAtMs);
      return Object.freeze(validateAuthoritativeNaturalPaperLedger(next));
    },

    async applySettlement({ ledger, position, settlement, settlementId, cycle } = {}) {
      validateAuthoritativeNaturalPaperLedger(ledger);
      if (!nonEmpty(settlementId) || !finite(cycle?.evaluatedAtMs) || cycle.evaluatedAtMs <= 0) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_SETTLEMENT_IDENTITY_INVALID");
      }
      if (ledger.appliedSettlementIds.includes(settlementId)) return Object.freeze(clone(ledger));
      if (settlement?.status !== "SETTLED" || settlement.market !== MARKET
        || !finite(settlement.netPnl)
        || !nonNegative(settlement.entryCost)
        || !nonNegative(settlement.exitCost)
        || !finite(settlement.fundingCost)
        || !positive(settlement.quantity)) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_SETTLEMENT_INVALID");
      }
      const reservation = ledger.reservations.find((row) => row.paperSampleId === settlement.paperSampleId && row.status === "OPEN");
      if (!reservation || reservation.positionId !== position?.positionId) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_RESERVATION_NOT_FOUND");
      }
      if (Math.abs(reservation.quantity - settlement.quantity) > EPSILON
        || Math.abs(reservation.entryNotional - settlement.entryNotional) > Math.max(EPSILON, settlement.entryNotional * 1e-9)
        || Math.abs(reservation.entryCost - settlement.entryCost) > Math.max(EPSILON, (settlement.entryCost || 1) * 1e-9)) {
        throw accountError("AUTHORITATIVE_NATURAL_PAPER_SETTLEMENT_PARITY_MISMATCH");
      }
      const fxEvidence = validateFxEvidence(
        await accountingEvidenceForSettlement(settlement, cycle),
        settlement,
        cycle,
      );
      const next = clone(ledger);
      const nextReservation = next.reservations.find((row) => row.paperSampleId === settlement.paperSampleId && row.status === "OPEN");
      nextReservation.status = "SETTLED";
      nextReservation.settlementId = settlementId;
      nextReservation.settledAtMs = settlement.settledAtMs;
      const projection = next.paperState.positions.find((row) => row?.id === reservation.projectedPositionId);
      if (!projection) throw accountError("AUTHORITATIVE_NATURAL_PAPER_PROJECTED_POSITION_NOT_FOUND");
      const cashDelta = settlement.netPnl + reservation.entryCost;
      next.paperState.account.cashBalance += cashDelta;
      next.paperState.account.realizedPnl += cashDelta;
      projection.currentPrice = settlement.exitFillPrice;
      projection.remainingQuantity = 0;
      projection.notionalValue = 0;
      projection.requiredMargin = 0;
      projection.realizedPnl = settlement.netPnl;
      projection.totalFees = reservation.entryCost + settlement.exitCost;
      projection.totalFunding = settlement.fundingCost;
      projection.closedAt = new Date(settlement.settledAtMs).toISOString();
      projection.status = "closed";
      next.appliedSettlementIds.push(settlementId);
      next.totalExitCost += settlement.exitCost;
      next.totalFundingCost += settlement.fundingCost;
      updateRiskState(next.paperState, settlement.netPnl, cycle.evaluatedAtMs);
      accountProjection(next);
      touchPaperState(next, cycle.evaluatedAtMs);
      next.reportingKrw = fxEvidence == null
        ? { status: "UNAVAILABLE", currentEquityKrw: null, lastFxEvidence: null }
        : {
          status: "READY",
          currentEquityKrw: next.paperState.account.equity * fxEvidence.fxRateToKrw,
          lastFxEvidence: fxEvidence,
        };
      return Object.freeze(validateAuthoritativeNaturalPaperLedger(next));
    },
  });
}

export function authoritativeNaturalPaperAccountingSummary(ledger) {
  validateAuthoritativeNaturalPaperLedger(ledger);
  return Object.freeze({
    schemaVersion: "authoritative-natural-paper-accounting-summary-v1",
    market: MARKET,
    currency: CURRENCY,
    initialEquity: ledger.initialEquity,
    currentEquity: ledger.paperState.account.equity,
    cashBalance: ledger.paperState.account.cashBalance,
    usedMargin: ledger.paperState.account.usedMargin,
    availableMargin: ledger.paperState.account.availableMargin,
    openReservations: ledger.reservations.filter((row) => row.status === "OPEN").length,
    settledReservations: ledger.reservations.filter((row) => row.status === "SETTLED").length,
    totalEntryCost: ledger.totalEntryCost,
    totalExitCost: ledger.totalExitCost,
    totalFundingCost: ledger.totalFundingCost,
    reportingKrwStatus: ledger.reportingKrw.status,
    currentEquityKrw: ledger.reportingKrw.currentEquityKrw,
    accountBindingVerified: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  });
}

export const AUTHORITATIVE_NATURAL_PAPER_ENTRY_ACCOUNTING_EVIDENCE_VERSION = ENTRY_EVIDENCE_VERSION;

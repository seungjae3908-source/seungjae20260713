function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function assertSafety(value, code) {
  if (value?.simulatedOnly !== true
    || value?.liveOrderAllowed !== false
    || value?.privateTradingApiAllowed !== false
    || value?.orderSubmitted !== false
    || value?.exchangeRequestSent !== false) throw new Error(code);
}

function validateLedger(ledger) {
  if (!ledger || !["READY", "PARTIAL"].includes(ledger.status)) throw new Error("PAPER_SIM_LEDGER_NOT_USABLE");
  if (ledger.initialCapitalKrw !== 1_000_000 || ledger.baseCurrency !== "KRW") throw new Error("PAPER_SIM_LEDGER_CAPITAL_CONTRACT_MISMATCH");
  if (!finite(ledger.knownEquityKrw)) throw new Error("PAPER_SIM_LEDGER_KNOWN_EQUITY_REQUIRED");
  if (ledger.status === "READY" && !finite(ledger.totalEquityKrw)) throw new Error("PAPER_SIM_LEDGER_TOTAL_EQUITY_REQUIRED");
  if (ledger.status === "PARTIAL" && ledger.totalEquityKrw != null) throw new Error("PAPER_SIM_LEDGER_PARTIAL_EQUITY_FABRICATED");
  assertSafety(ledger, "PAPER_SIM_LEDGER_SAFETY_VIOLATION");
}

function validateAccountingEvidence(evidence) {
  if (!evidence || evidence.status === "MISSING") return Object.freeze({ status: "MISSING" });
  if (evidence.status !== "READY") throw new Error("PAPER_SIM_ACCOUNTING_EVIDENCE_INVALID");
  if (!finite(evidence.netPnlKrw)) throw new Error("PAPER_SIM_ACCOUNTING_KRW_PNL_REQUIRED");
  if (!nonEmpty(evidence.source) || !nonEmpty(evidence.version) || !finite(evidence.asOfMs)) {
    throw new Error("PAPER_SIM_ACCOUNTING_PROVENANCE_REQUIRED");
  }
  return Object.freeze({
    status: "READY",
    netPnlKrw: evidence.netPnlKrw,
    source: evidence.source,
    version: evidence.version,
    asOfMs: evidence.asOfMs,
  });
}

function normalizePendingAccounting(ledger) {
  return Array.isArray(ledger.pendingAccounting) ? [...ledger.pendingAccounting] : [];
}

export function createSimulatedPaperLedgerAdapter({ accountingEvidenceForSettlement } = {}) {
  const converter = accountingEvidenceForSettlement ?? (async () => ({ status: "MISSING" }));
  if (typeof converter !== "function") throw new TypeError("accountingEvidenceForSettlement must be a function");

  return Object.freeze({
    async applyEntry({ ledger, position }) {
      validateLedger(ledger);
      if (!position || position.lifecycleState !== "OPEN" || !nonEmpty(position.positionId)) {
        throw new Error("PAPER_SIM_OPEN_POSITION_REQUIRED");
      }
      assertSafety(position.sample, "PAPER_SIM_ENTRY_SAMPLE_SAFETY_VIOLATION");
      return Object.freeze({ ...structuredClone(ledger), ...safetyEnvelope() });
    },

    async applySettlement({ ledger, settlement, settlementId, cycle }) {
      validateLedger(ledger);
      if (!settlement || settlement.status !== "SETTLED" || !finite(settlement.netPnl)) {
        throw new Error("PAPER_SIM_SETTLEMENT_REQUIRED");
      }
      if (!nonEmpty(settlementId) || !finite(cycle?.evaluatedAtMs)) throw new Error("PAPER_SIM_SETTLEMENT_IDENTITY_REQUIRED");
      assertSafety(settlement, "PAPER_SIM_SETTLEMENT_SAFETY_VIOLATION");

      const accounting = validateAccountingEvidence(await converter(settlement, cycle));
      const applied = Array.isArray(ledger.appliedSettlementIds) ? [...ledger.appliedSettlementIds] : [];
      if (applied.includes(settlementId)) return Object.freeze({ ...structuredClone(ledger), ...safetyEnvelope() });
      const pendingAccounting = normalizePendingAccounting(ledger).filter((row) => row.settlementId !== settlementId);

      if (accounting.status !== "READY") {
        pendingAccounting.push(Object.freeze({
          settlementId,
          market: settlement.market,
          netPnl: settlement.netPnl,
          settledAtMs: settlement.settledAtMs,
          reason: "KRW_ACCOUNTING_EVIDENCE_MISSING",
        }));
        return Object.freeze({
          ...structuredClone(ledger),
          status: "PARTIAL",
          totalEquityKrw: null,
          pendingAccounting: Object.freeze(pendingAccounting),
          appliedSettlementIds: Object.freeze(applied),
          ...safetyEnvelope(),
        });
      }

      const knownEquityKrw = ledger.knownEquityKrw + accounting.netPnlKrw;
      applied.push(settlementId);
      return Object.freeze({
        ...structuredClone(ledger),
        status: pendingAccounting.length === 0 ? "READY" : "PARTIAL",
        knownEquityKrw,
        totalEquityKrw: pendingAccounting.length === 0 ? knownEquityKrw : null,
        pendingAccounting: Object.freeze(pendingAccounting),
        appliedSettlementIds: Object.freeze(applied),
        lastAccountingEvidence: accounting,
        ...safetyEnvelope(),
      });
    },
  });
}

function learningRecord(kind, payload) {
  const signalId = payload?.sample?.identity?.signalId ?? payload?.position?.signalId ?? null;
  const settlementId = payload?.settlement?.settlementId ?? null;
  const key = kind === "signal" ? `paper-signal:${signalId}` : `paper-outcome:${settlementId}`;
  if (!nonEmpty(kind === "signal" ? signalId : settlementId)) throw new Error("PAPER_SIM_LEARNING_ID_REQUIRED");
  const value = Object.freeze({
    schemaVersion: 1,
    kind,
    key,
    cycleId: payload?.cycle?.cycleId ?? null,
    signalId,
    settlementId,
    market: payload?.sample?.identity?.market ?? payload?.settlement?.market ?? null,
    strategyId: payload?.identity?.strategyId ?? payload?.settlement?.strategyId ?? null,
    strategyVersion: payload?.identity?.strategyVersion ?? payload?.settlement?.strategyVersion ?? null,
    recordedAtMs: payload?.cycle?.evaluatedAtMs ?? null,
    sample: kind === "signal" ? structuredClone(payload.sample) : null,
    settlement: kind === "outcome" ? structuredClone(payload.settlement) : null,
    ...safetyEnvelope(),
  });
  return Object.freeze({ key, value });
}

export function createSimulatedPaperLearningAdapter({ learningStore } = {}) {
  if (!learningStore || typeof learningStore.putIfAbsent !== "function") {
    throw new Error("PAPER_SIM_LEARNING_STORE_REQUIRED");
  }
  async function persist(kind, payload) {
    const record = learningRecord(kind, payload);
    assertSafety(record.value, "PAPER_SIM_LEARNING_SAFETY_VIOLATION");
    const result = await learningStore.putIfAbsent(record);
    if (!result || typeof result.inserted !== "boolean") throw new Error("PAPER_SIM_LEARNING_STORE_RESULT_INVALID");
    return Object.freeze({ key: record.key, inserted: result.inserted });
  }
  return Object.freeze({
    persistSignal: (payload) => persist("signal", payload),
    persistOutcome: (payload) => persist("outcome", payload),
  });
}

export function createMemoryPaperLearningStore() {
  const records = new Map();
  return Object.freeze({
    async putIfAbsent({ key, value }) {
      if (!nonEmpty(key)) throw new Error("PAPER_SIM_LEARNING_KEY_REQUIRED");
      if (records.has(key)) return Object.freeze({ inserted: false });
      records.set(key, structuredClone(value));
      return Object.freeze({ inserted: true });
    },
    snapshot() {
      return Object.freeze([...records.entries()].map(([key, value]) => Object.freeze({ key, value: structuredClone(value) })));
    },
  });
}

import { createHash } from "node:crypto";

export const MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION =
  "member-auto-trading-paper-handoff-v1";

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const FORBIDDEN_PUBLIC_EVIDENCE_KEY =
  /(credential|secret|access[_-]?key|api[_-]?key|passphrase|authorization|cookie|account[_-]?id|balance|equity)/iu;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function unsafeEvidenceKey(value) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_EVIDENCE_KEY.test(key)) return key;
    if (child && typeof child === "object") {
      const nested = unsafeEvidenceKey(child);
      if (nested) return `${key}.${nested}`;
    }
  }
  return null;
}

function safeEnvelope(candidate) {
  return candidate?.executionAuthority === "NONE"
    && candidate?.simulatedOnly === true
    && candidate?.liveOrderAllowed === false
    && candidate?.privateTradingApiAllowed === false
    && candidate?.orderSubmitted === false
    && candidate?.exchangeRequestSent === false;
}

function allowedDirection(market, direction) {
  if (CASH_MARKETS.has(market)) return direction === "BUY";
  return market === "CRYPTO_FUTURES" && (direction === "LONG" || direction === "SHORT");
}

function candidateBlockers(candidate, market, evaluatedAtMs) {
  const signal = candidate?.signal;
  const identity = candidate?.paperIdentity;
  const strategy = signal?.strategyIdentity;
  const execution = candidate?.execution;
  const dataEvidence = execution?.dataEvidence;
  const blockers = [];

  if (!MARKETS.has(market) || signal?.market !== market || identity?.market !== market) {
    blockers.push("HANDOFF_MARKET_IDENTITY_MISMATCH");
  }
  if (!nonEmpty(signal?.signalId) || identity?.signalId !== signal.signalId) {
    blockers.push("HANDOFF_SIGNAL_ID_MISMATCH");
  }
  if (!nonEmpty(signal?.symbol) || identity?.symbol !== signal.symbol) {
    blockers.push("HANDOFF_SYMBOL_MISMATCH");
  }
  if (!nonEmpty(signal?.timeframe) || identity?.timeframe !== signal.timeframe) {
    blockers.push("HANDOFF_TIMEFRAME_MISMATCH");
  }
  if (!Number.isSafeInteger(signal?.horizon) || signal.horizon <= 0 || identity?.horizon !== signal.horizon) {
    blockers.push("HANDOFF_HORIZON_MISMATCH");
  }
  const direction = signal?.signalDirection ?? signal?.direction;
  if (!nonEmpty(direction) || identity?.direction !== direction || !allowedDirection(market, direction)) {
    blockers.push("HANDOFF_DIRECTION_INVALID");
  }

  if (!nonEmpty(strategy?.strategyId) || identity?.strategyId !== strategy.strategyId) {
    blockers.push("HANDOFF_STRATEGY_ID_MISMATCH");
  }
  if (!nonEmpty(strategy?.strategyVersion) || identity?.strategyVersion !== strategy.strategyVersion) {
    blockers.push("HANDOFF_STRATEGY_VERSION_MISMATCH");
  }
  if (!nonEmpty(strategy?.parameterHash) || identity?.parameterHash !== strategy.parameterHash) {
    blockers.push("HANDOFF_PARAMETER_HASH_MISMATCH");
  }
  if (!immutableSha(strategy?.researchCodeSha)
    || String(identity?.researchCodeSha ?? "").toLowerCase() !== strategy.researchCodeSha.toLowerCase()) {
    blockers.push("HANDOFF_RESEARCH_SHA_MISMATCH");
  }

  const costPolicyVersion = identity?.costPolicyVersion;
  if (!nonEmpty(costPolicyVersion)
    || execution?.costPolicy?.version !== costPolicyVersion
    || candidate?.profitEvidence?.costPolicyId !== costPolicyVersion) {
    blockers.push("HANDOFF_COST_POLICY_MISMATCH");
  }
  if (!safeEnvelope(candidate) || identity?.executionAuthority !== "NONE") {
    blockers.push("HANDOFF_EXECUTION_AUTHORITY_FORBIDDEN");
  }

  if (dataEvidence?.publicOnly !== true || dataEvidence?.dataQuality !== "READY"
    || !nonEmpty(dataEvidence?.provenance)) {
    blockers.push("HANDOFF_PUBLIC_DATA_EVIDENCE_REQUIRED");
  }
  if (!finite(dataEvidence?.asOfMs) || dataEvidence.asOfMs <= 0 || dataEvidence.asOfMs > evaluatedAtMs) {
    blockers.push("HANDOFF_DATA_TIMESTAMP_INVALID");
  } else if (!positive(dataEvidence?.maxAgeMs)
    || evaluatedAtMs - dataEvidence.asOfMs > dataEvidence.maxAgeMs) {
    blockers.push("HANDOFF_DATA_STALE");
  }

  for (const [name, value] of [
    ["dataEvidence", dataEvidence],
    ["order", candidate?.order],
    ["quote", candidate?.quote],
    ["learningSnapshot", signal?.learningSnapshot],
    ["riskEvidence", candidate?.riskEvidence],
  ]) {
    const unsafe = unsafeEvidenceKey(value);
    if (unsafe) blockers.push(`HANDOFF_PRIVATE_FIELD_FORBIDDEN:${name}.${unsafe}`);
  }

  return [...new Set(blockers)];
}

function safeEntry(candidate, cycleId, evaluatedAtMs) {
  const signal = candidate.signal;
  const identity = candidate.paperIdentity;
  const direction = signal.signalDirection ?? signal.direction;
  const payload = {
    cycleId,
    evaluatedAtMs,
    identity: {
      signalId: identity.signalId,
      candidateId: identity.candidateId ?? signal.strategyIdentity?.candidateId ?? null,
      market: identity.market,
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      horizon: identity.horizon,
      direction: identity.direction,
      regime: identity.regime ?? signal.regime ?? null,
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      parameterHash: identity.parameterHash,
      researchCodeSha: String(identity.researchCodeSha).toLowerCase(),
      costPolicyVersion: identity.costPolicyVersion,
      executionAuthority: "NONE",
    },
    signal: {
      signalId: signal.signalId,
      market: signal.market,
      symbol: signal.symbol,
      timestampMs: signal.timestampMs ?? null,
      expiresAtMs: signal.expiresAtMs ?? null,
      ttlMs: signal.ttlMs ?? null,
      style: signal.style ?? null,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction,
      regime: signal.regime ?? null,
      strategyIdentity: clone(signal.strategyIdentity),
      learningSnapshot: clone(signal.learningSnapshot ?? null),
    },
    profitEvidence: clone(candidate.profitEvidence),
    riskEvidence: clone(candidate.riskEvidence ?? null),
    execution: {
      marketAdapterIdentity: clone(candidate.execution?.marketAdapterIdentity ?? null),
      costPolicy: clone(candidate.execution?.costPolicy ?? null),
      executionPolicy: clone(candidate.execution?.executionPolicy ?? null),
      dataEvidence: clone(candidate.execution?.dataEvidence),
    },
    simulatedOrder: clone(candidate.order ?? null),
    publicQuote: clone(candidate.quote ?? null),
    safety: {
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
  };
  return deepFreeze({
    handoffId: `paper-auto-handoff:sha256:${digest(payload)}`,
    ...payload,
  });
}

export function buildMemberAutoTradingPaperHandoff({
  cycleId,
  evaluatedAtMs,
  lanes = [],
} = {}) {
  if (!nonEmpty(cycleId)) throw new TypeError("cycleId is required");
  if (!finite(evaluatedAtMs) || evaluatedAtMs <= 0) throw new TypeError("evaluatedAtMs is required");
  if (!Array.isArray(lanes)) throw new TypeError("lanes must be an array");

  const entries = [];
  const blockers = [];
  for (const lane of lanes) {
    const market = lane?.market;
    const candidates = lane?.result?.candidates;
    if (!MARKETS.has(market) || !Array.isArray(candidates)) {
      blockers.push(`HANDOFF_LANE_INVALID:${String(market ?? "UNKNOWN")}`);
      continue;
    }
    for (const candidate of candidates) {
      const candidateIssues = candidateBlockers(candidate, market, evaluatedAtMs);
      if (candidateIssues.length > 0) {
        blockers.push(...candidateIssues.map((code) => `${market}:${code}`));
        continue;
      }
      entries.push(safeEntry(candidate, cycleId, evaluatedAtMs));
    }
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION,
      status: "BLOCKED_DATA",
      cycleId,
      evaluatedAtMs,
      entries: [],
      entryCount: 0,
      blockers: [...new Set(blockers)].sort(),
      safety: {
        executionAuthority: "NONE",
        publicDataOnly: true,
        simulatedOnly: true,
        liveTrading: false,
        privateTradingApiAllowed: false,
        orderSubmitted: false,
      },
    });
  }

  const bySignal = new Map();
  for (const entry of entries) {
    const previous = bySignal.get(entry.identity.signalId);
    if (!previous) {
      bySignal.set(entry.identity.signalId, entry);
      continue;
    }
    if (canonical(previous) !== canonical(entry)) {
      return deepFreeze({
        schemaVersion: MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION,
        status: "BLOCKED_DATA",
        cycleId,
        evaluatedAtMs,
        entries: [],
        entryCount: 0,
        blockers: [`HANDOFF_SIGNAL_ID_CONFLICT:${entry.identity.signalId}`],
        safety: {
          executionAuthority: "NONE",
          publicDataOnly: true,
          simulatedOnly: true,
          liveTrading: false,
          privateTradingApiAllowed: false,
          orderSubmitted: false,
        },
      });
    }
  }

  const uniqueEntries = [...bySignal.values()]
    .sort((left, right) => left.identity.signalId.localeCompare(right.identity.signalId));
  const core = {
    schemaVersion: MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION,
    status: "READY",
    cycleId,
    evaluatedAtMs,
    entries: uniqueEntries,
    entryCount: uniqueEntries.length,
    blockers: [],
    safety: {
      executionAuthority: "NONE",
      publicDataOnly: true,
      simulatedOnly: true,
      liveTrading: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
    },
  };
  return deepFreeze({
    ...core,
    handoffDigest: digest(core),
  });
}

function handoffSafetyValid(value) {
  return value?.executionAuthority === "NONE"
    && value?.publicDataOnly === true
    && value?.simulatedOnly === true
    && value?.liveTrading === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false;
}

function entrySafetyValid(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false;
}

function validatePersistedEntry(entry, cycleId, evaluatedAtMs, nowMs) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("HANDOFF_ENTRY_REQUIRED");
  }
  if (entry.cycleId !== cycleId || entry.evaluatedAtMs !== evaluatedAtMs) {
    throw new Error("HANDOFF_ENTRY_CYCLE_MISMATCH");
  }
  if (!entrySafetyValid(entry.safety)) throw new Error("HANDOFF_ENTRY_SAFETY_INVALID");
  const identity = entry.identity;
  const signal = entry.signal;
  if (!identity || !signal || identity.signalId !== signal.signalId
    || identity.market !== signal.market || identity.symbol !== signal.symbol
    || identity.timeframe !== signal.timeframe || identity.horizon !== signal.horizon
    || identity.direction !== signal.direction
    || !allowedDirection(identity.market, identity.direction)
    || identity.executionAuthority !== "NONE") {
    throw new Error("HANDOFF_ENTRY_IDENTITY_INVALID");
  }
  if (!immutableSha(identity.researchCodeSha)
    || identity.researchCodeSha !== String(signal.strategyIdentity?.researchCodeSha ?? "").toLowerCase()
    || identity.strategyId !== signal.strategyIdentity?.strategyId
    || identity.strategyVersion !== signal.strategyIdentity?.strategyVersion
    || identity.parameterHash !== signal.strategyIdentity?.parameterHash
    || identity.costPolicyVersion !== entry.execution?.costPolicy?.version
    || identity.costPolicyVersion !== entry.profitEvidence?.costPolicyId) {
    throw new Error("HANDOFF_ENTRY_STRATEGY_IDENTITY_INVALID");
  }

  const risk = entry.riskEvidence;
  if (risk?.status !== "APPROVED" || risk?.source !== "TRADING_RISK_ENGINE"
    || risk?.allowed !== true || risk?.simulatedOnly !== true || risk?.executionAuthority !== "NONE"
    || !Array.isArray(risk?.blockCodes) || risk.blockCodes.length !== 0
    || !positive(risk?.recommendedQuantity) || !finite(risk?.evaluatedAtMs)
    || risk.evaluatedAtMs > nowMs) {
    throw new Error("HANDOFF_RISK_EVIDENCE_INVALID");
  }

  const evidence = entry.execution?.dataEvidence;
  if (evidence?.publicOnly !== true || evidence?.dataQuality !== "READY"
    || !nonEmpty(evidence?.provenance) || !finite(evidence?.asOfMs) || !positive(evidence?.maxAgeMs)) {
    throw new Error("HANDOFF_ENTRY_PUBLIC_EVIDENCE_INVALID");
  }
  if (evidence.asOfMs > nowMs || nowMs - evidence.asOfMs > evidence.maxAgeMs) {
    throw new Error("HANDOFF_ENTRY_STALE");
  }
  for (const [name, value] of [
    ["dataEvidence", evidence],
    ["simulatedOrder", entry.simulatedOrder],
    ["publicQuote", entry.publicQuote],
    ["learningSnapshot", entry.signal?.learningSnapshot],
    ["riskEvidence", entry.riskEvidence],
  ]) {
    const unsafe = unsafeEvidenceKey(value);
    if (unsafe) throw new Error(`HANDOFF_PRIVATE_FIELD_FORBIDDEN:${name}.${unsafe}`);
  }

  const { handoffId, ...payload } = entry;
  const expected = `paper-auto-handoff:sha256:${digest(payload)}`;
  if (handoffId !== expected) throw new Error("HANDOFF_ENTRY_DIGEST_MISMATCH");
}

export function validateMemberAutoTradingPaperHandoff(value, nowMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MEMBER_AUTO_TRADING_HANDOFF_REQUIRED");
  }
  if (value.schemaVersion !== MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION
    || !nonEmpty(value.cycleId)
    || !finite(value.evaluatedAtMs)
    || value.evaluatedAtMs <= 0
    || !handoffSafetyValid(value.safety)
    || !Array.isArray(value.entries)
    || !Array.isArray(value.blockers)) {
    throw new Error("MEMBER_AUTO_TRADING_HANDOFF_CONTRACT_INVALID");
  }
  if (!finite(nowMs) || nowMs <= 0 || nowMs < value.evaluatedAtMs) {
    throw new Error("MEMBER_AUTO_TRADING_HANDOFF_TIME_INVALID");
  }

  if (value.status === "BLOCKED_DATA") {
    if (value.entryCount !== 0 || value.entries.length !== 0 || value.blockers.length === 0) {
      throw new Error("MEMBER_AUTO_TRADING_BLOCKED_HANDOFF_INVALID");
    }
    return deepFreeze(clone(value));
  }
  if (value.status !== "READY" || value.entryCount !== value.entries.length || value.blockers.length !== 0) {
    throw new Error("MEMBER_AUTO_TRADING_READY_HANDOFF_INVALID");
  }

  const signalIds = new Set();
  for (const entry of value.entries) {
    validatePersistedEntry(entry, value.cycleId, value.evaluatedAtMs, nowMs);
    if (signalIds.has(entry.identity.signalId)) throw new Error("HANDOFF_DUPLICATE_SIGNAL_ID");
    signalIds.add(entry.identity.signalId);
  }
  const { handoffDigest, ...core } = value;
  if (!/^[0-9a-f]{64}$/u.test(String(handoffDigest ?? "")) || handoffDigest !== digest(core)) {
    throw new Error("MEMBER_AUTO_TRADING_HANDOFF_DIGEST_MISMATCH");
  }
  return deepFreeze(clone(value));
}

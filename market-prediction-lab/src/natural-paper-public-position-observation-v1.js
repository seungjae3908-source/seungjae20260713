import { createHash } from "node:crypto";

export const NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION =
  "natural-paper-public-position-observation-v1";

export const NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT = Object.freeze({
  version: NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION,
  publicDataOnly: true,
  openPositionsOnly: true,
  canonicalFreshnessPolicyRequired: true,
  fullCostAuthority: false,
  riskPolicyAuthority: false,
  settlementAuthority: false,
  syntheticObservationAllowed: false,
  replayCreditAllowed: false,
  backfillCreditAllowed: false,
  privateApi: false,
  liveTrading: false,
  orderAuthority: false,
  executionAuthority: "NONE",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = "OPEN";
const NATURAL_FORWARD = "NATURAL_FORWARD";
const CRYPTO_MARKETS = new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const SUPPORTED_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STATUS = Object.freeze({
  PRESENT: "PRESENT",
  STALE: "STALE",
  MISSING: "MISSING",
  WRONG_SYMBOL: "WRONG_SYMBOL",
  WRONG_MARKET: "WRONG_MARKET",
  WRONG_POSITION: "WRONG_POSITION",
  INVALID: "INVALID",
});

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactSha(value) {
  return nonEmpty(value) && /^[0-9a-f]{40}$/iu.test(value);
}

function digest64(value) {
  return nonEmpty(value) && /^[0-9a-f]{64}$/iu.test(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function frozenClone(value) {
  return value == null ? value : deepFreeze(structuredClone(value));
}

function result(status, {
  market,
  openPositionCount = null,
  observations = null,
  blocker = null,
  sourceType = null,
  provider = null,
  diagnostic = null,
} = {}) {
  return Object.freeze({
    schemaVersion: NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION,
    status,
    market: market ?? null,
    openPositionCount,
    observationCount: Array.isArray(observations) ? observations.length : null,
    observations: Array.isArray(observations) ? Object.freeze(observations) : null,
    blocker,
    sourceType,
    provider,
    diagnostic: diagnostic ? deepFreeze(structuredClone(diagnostic)) : null,
    publicOnly: true,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
  });
}

function fail(status, blocker, context = {}) {
  return result(status, { ...context, observations: null, blocker });
}

function positionIdentity(position) {
  const sample = position?.sample?.identity ?? {};
  const identity = {
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    signalId: position?.signalId ?? sample.signalId,
    market: position?.market ?? sample.market,
    symbol: position?.symbol ?? sample.symbol,
    direction: position?.direction ?? sample.executionDirection,
    strategyId: position?.strategyId ?? sample.strategyId,
    strategyVersion: position?.strategyVersion ?? sample.strategyVersion,
    parameterHash: position?.parameterHash ?? sample.parameterHash,
    researchCodeSha: position?.researchCodeSha ?? sample.researchCodeSha,
    costPolicyVersion: position?.costPolicyVersion ?? position?.sample?.profitEvidence?.costPolicyId,
  };
  if ([
    identity.positionId,
    identity.paperSampleId,
    identity.signalId,
    identity.market,
    identity.symbol,
    identity.direction,
    identity.strategyId,
    identity.strategyVersion,
    identity.parameterHash,
    identity.costPolicyVersion,
  ].some((value) => !nonEmpty(value)) || !exactSha(identity.researchCodeSha)) return null;
  return Object.freeze({
    ...identity,
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
  });
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return [
    "positionId",
    "paperSampleId",
    "signalId",
    "market",
    "symbol",
    "direction",
    "strategyId",
    "strategyVersion",
    "parameterHash",
    "researchCodeSha",
    "costPolicyVersion",
  ].every((key) => String(left[key] ?? "") === String(right[key] ?? ""));
}

function validRiskPolicyIdentity(value, researchCodeSha) {
  return Boolean(value
    && nonEmpty(value.policyId)
    && nonEmpty(value.policyVersion)
    && nonEmpty(value.source)
    && exactSha(value.researchCodeSha)
    && value.researchCodeSha.toLowerCase() === researchCodeSha
    && digest64(value.identityDigest));
}

function validatePositionBinding({ position, binding, cycleIdentity, accountIdentity }) {
  const identity = positionIdentity(position);
  if (!identity) return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_POSITION_IDENTITY_MISSING" });
  if (position?.lifecycleState !== OPEN || position?.sample?.status !== OPEN) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_POSITION_NOT_OPEN" });
  }
  if (!positiveInteger(position.entryTimestampMs)) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_ENTRY_TIMESTAMP_MISSING" });
  }
  if (!binding || !sameIdentity(binding.positionIdentity, identity)) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_BINDING_POSITION_MISMATCH" });
  }
  if (!cycleIdentity || !digest64(cycleIdentity.identityDigest) || !nonEmpty(cycleIdentity.cycleId)
    || binding?.cycleIdentity?.identityDigest !== cycleIdentity.identityDigest
    || binding?.cycleIdentity?.cycleId !== cycleIdentity.cycleId) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH" });
  }
  if (!accountIdentity || !digest64(accountIdentity.identityDigest)
    || binding?.accountIdentity?.identityDigest !== accountIdentity.identityDigest
    || binding.accountBound !== true) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISMATCH" });
  }
  if (!binding.entryProvenance
    || binding.entryProvenance.schemaVersion !== "paper-evidence-provenance-v1"
    || !digest64(binding.entryProvenance.evidenceSnapshotDigest)) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_ENTRY_PROVENANCE_MISSING" });
  }
  if (!binding.costPolicyIdentity
    || !nonEmpty(binding.costPolicyIdentity.version)
    || binding.costPolicyIdentity.version !== identity.costPolicyVersion) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_COST_POLICY_IDENTITY_MISMATCH" });
  }
  if (!validRiskPolicyIdentity(binding.riskPolicyIdentity, identity.researchCodeSha)) {
    return Object.freeze({ ok: false, blocker: "POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISSING_OR_MISMATCH" });
  }
  return Object.freeze({ ok: true, identity });
}

function authorityFor(authority, market) {
  const lane = authority?.[market];
  if (!lane
    || !nonEmpty(lane.provider)
    || !nonEmpty(lane.timeframe)
    || !positiveInteger(lane.intervalMs)
    || !positiveInteger(lane.maxAgeMs)) return null;
  const closeOffsetMs = lane.closeOffsetMs ?? lane.intervalMs;
  if (!positiveInteger(closeOffsetMs)) return null;
  return Object.freeze({ ...lane, closeOffsetMs });
}

function providerOf(snapshot) {
  return snapshot?.source ?? snapshot?.provider ?? null;
}

function normalizedClosedFrames(snapshot, lane, nowMs) {
  if (!Array.isArray(snapshot?.candles)) return null;
  const byTimestamp = new Map();
  for (const row of snapshot.candles) {
    if (!positiveInteger(row?.timestamp)
      || !finite(row?.open)
      || !finite(row?.high)
      || !finite(row?.low)
      || !finite(row?.close)
      || row.open <= 0
      || row.high <= 0
      || row.low <= 0
      || row.close <= 0
      || row.high < Math.max(row.open, row.close)
      || row.low > Math.min(row.open, row.close)
      || row.high < row.low) return null;
    const existing = byTimestamp.get(row.timestamp);
    const comparable = Object.freeze({
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    });
    if (existing && stableSerialize(existing) !== stableSerialize(comparable)) return null;
    byTimestamp.set(row.timestamp, comparable);
  }
  return [...byTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((bar) => Object.freeze({
      ...bar,
      sourceObservedAtMs: bar.timestamp + lane.closeOffsetMs,
    }))
    .filter((bar) => bar.sourceObservedAtMs <= nowMs);
}

function frameDigest({ provider, market, symbol, timeframe, frame }) {
  return hash({
    provider,
    market,
    symbol,
    timeframe,
    sourceObservedAtMs: frame.sourceObservedAtMs,
    open: frame.open,
    high: frame.high,
    low: frame.low,
    close: frame.close,
  });
}

function cryptoSequenceGap(frames, intervalMs) {
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].timestamp - frames[index - 1].timestamp !== intervalMs) return true;
  }
  return false;
}

function observationCursor(position) {
  const lastObservedAtMs = position?.lifecycle?.mark?.lastObservedAtMs;
  if (lastObservedAtMs == null) return position.entryTimestampMs;
  return positiveInteger(lastObservedAtMs) ? lastObservedAtMs : null;
}

function selectNewFrames({ position, frames, lane, market, nowMs }) {
  const cursor = observationCursor(position);
  if (!positiveInteger(cursor)) {
    return Object.freeze({ status: STATUS.INVALID, blocker: "POSITION_OBSERVATION_CURSOR_INVALID", frames: null });
  }
  if (frames.length === 0) {
    return Object.freeze({ status: STATUS.MISSING, blocker: "POSITION_OBSERVATION_PUBLIC_FRAME_MISSING", frames: null });
  }
  const anchorIndex = frames.findLastIndex((frame) => frame.sourceObservedAtMs <= cursor);
  if (anchorIndex < 0) {
    return Object.freeze({ status: STATUS.MISSING, blocker: "POSITION_OBSERVATION_SEQUENCE_ANCHOR_MISSING", frames: null });
  }
  const selected = frames.filter((frame) => frame.sourceObservedAtMs > cursor);
  if (selected.length > 0 && selected[0].timestamp < cursor) {
    return Object.freeze({ status: STATUS.MISSING, blocker: "POSITION_OBSERVATION_PARTIAL_FRAME_AT_CURSOR", frames: null });
  }
  if (selected.length === 0) {
    const latest = frames.at(-1);
    if (nowMs - latest.sourceObservedAtMs > lane.maxAgeMs) {
      return Object.freeze({ status: STATUS.STALE, blocker: "POSITION_OBSERVATION_STALE", frames: null });
    }
    return Object.freeze({ status: STATUS.PRESENT, blocker: null, frames: Object.freeze([]) });
  }
  if (nowMs - selected[0].sourceObservedAtMs > lane.maxAgeMs) {
    return Object.freeze({ status: STATUS.STALE, blocker: "POSITION_OBSERVATION_STALE", frames: null });
  }
  if (CRYPTO_MARKETS.has(market)) {
    const sequence = anchorIndex >= 0 ? [frames[anchorIndex], ...selected] : selected;
    if (cryptoSequenceGap(sequence, lane.intervalMs)) {
      return Object.freeze({ status: STATUS.INVALID, blocker: "POSITION_OBSERVATION_INTERVAL_GAP", frames: null });
    }
  }
  return Object.freeze({ status: STATUS.PRESENT, blocker: null, frames: Object.freeze(selected) });
}

async function collectSnapshot({
  market,
  symbol,
  lane,
  nowMs,
  signal,
  collectYahoo,
  collectUpbit,
  collectBitget,
  bitgetClient,
}) {
  const startTime = nowMs - (market.endsWith("STOCK") ? 180 * DAY_MS : 60 * DAY_MS);
  if (market === "KR_STOCK" || market === "US_STOCK") {
    return collectYahoo({ market, symbol, startTime, endTime: nowMs, signal });
  }
  if (market === "CRYPTO_SPOT") {
    return collectUpbit({ symbol, startTime, endTime: nowMs, signal, maxPages: 4 });
  }
  if (market === "CRYPTO_FUTURES") {
    return collectBitget({
      client: bitgetClient,
      market,
      symbol,
      timeframe: lane.timeframe,
      startTime,
      endTime: nowMs,
      maxCandles: 500,
    });
  }
  return null;
}

function buildObservation({
  position,
  binding,
  identity,
  cycleIdentity,
  accountIdentity,
  lane,
  provider,
  frame,
}) {
  const sourceDigest = frameDigest({
    provider,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: lane.timeframe,
    frame,
  });
  const sourceType = "PUBLIC_CLOSED_CANDLE";
  const provenance = `${NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION}:${provider}:${identity.market}:${identity.symbol}:${lane.timeframe}`;
  const observationId = hash({ positionId: identity.positionId, sourceDigest });
  const riskPolicyIdentity = binding.riskPolicyIdentity;
  const costPolicyId = identity.costPolicyVersion;
  const processed = new Set(Array.isArray(position?.lifecycle?.processedObservationIds)
    ? position.lifecycle.processedObservationIds
    : []);
  if (processed.has(observationId)) return null;
  const observation = {
    schemaVersion: NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION,
    observationId,
    sourceType,
    provider,
    source: provider,
    provenance,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: lane.timeframe,
    observedAt: frame.sourceObservedAtMs,
    observedAtMs: frame.sourceObservedAtMs,
    sourceObservedAt: frame.sourceObservedAtMs,
    sourceObservedAtMs: frame.sourceObservedAtMs,
    sourceDigest,
    evidenceRef: `public-frame:${sourceDigest}`,
    publicOnly: true,
    maxAgeMs: lane.maxAgeMs,
    positionId: identity.positionId,
    paperSampleId: identity.paperSampleId,
    entryId: identity.paperSampleId,
    signalId: identity.signalId,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
    riskPolicyId: riskPolicyIdentity.policyId,
    riskPolicyVersion: riskPolicyIdentity.policyVersion,
    riskPolicySource: riskPolicyIdentity.source,
    riskPolicyIdentity: frozenClone(riskPolicyIdentity),
    riskPolicyIdentityDigest: riskPolicyIdentity.identityDigest,
    costPolicyId,
    costPolicyVersion: identity.costPolicyVersion,
    costPolicyIdentity: frozenClone(binding.costPolicyIdentity),
    cycleId: cycleIdentity.cycleId,
    cycleIdentity: frozenClone(cycleIdentity),
    cycleIdentityDigest: cycleIdentity.identityDigest,
    accountIdentity: frozenClone(accountIdentity),
    accountIdentityDigest: accountIdentity.identityDigest,
    direction: identity.direction,
    entryTimestamp: position.entryTimestampMs,
    entryTimestampMs: position.entryTimestampMs,
    observationTimestamp: frame.sourceObservedAtMs,
    observationTimestampMs: frame.sourceObservedAtMs,
    entryEvidenceDigest: binding.entryProvenance.evidenceSnapshotDigest,
    bar: Object.freeze({
      open: frame.open,
      high: frame.high,
      low: frame.low,
      close: frame.close,
    }),
    naturalEvidence: Object.freeze({
      provenanceClass: NATURAL_FORWARD,
      observationId,
      source: provider,
      provenance,
      observedAtMs: frame.sourceObservedAtMs,
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
    }),
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    executionAuthority: "NONE",
  };
  return deepFreeze(observation);
}

export function createNaturalPaperPublicPositionObservationProducer({
  authority,
  collectYahoo,
  collectUpbit,
  collectBitget,
  bitgetClient,
  clock = Date.now,
} = {}) {
  if (!authority || typeof authority !== "object") throw new TypeError("canonical Paper provider authority is required");
  if (typeof collectYahoo !== "function" || typeof collectUpbit !== "function" || typeof collectBitget !== "function") {
    throw new TypeError("canonical public market collectors are required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  return Object.freeze({
    async collect({ market, openPositions, positionBindings, cycleIdentity, accountIdentity, signal } = {}) {
      if (!SUPPORTED_MARKETS.has(market)) {
        return fail(STATUS.WRONG_MARKET, "POSITION_OBSERVATION_MARKET_UNSUPPORTED", { market });
      }
      if (!Array.isArray(openPositions) || !Array.isArray(positionBindings)) {
        return fail(STATUS.MISSING, "POSITION_OBSERVATION_OPEN_POSITION_STATE_MISSING", { market });
      }
      const lane = authorityFor(authority, market);
      if (!lane) {
        return fail(STATUS.MISSING, "POSITION_OBSERVATION_FRESHNESS_POLICY_MISSING", {
          market,
          openPositionCount: openPositions.length,
        });
      }
      if (openPositions.length === 0) {
        return result(STATUS.PRESENT, {
          market,
          openPositionCount: 0,
          observations: [],
          sourceType: "PUBLIC_CLOSED_CANDLE",
          provider: lane.provider,
          diagnostic: { reason: "NO_OPEN_POSITIONS" },
        });
      }
      const nowMs = clock();
      if (!positiveInteger(nowMs)) {
        return fail(STATUS.INVALID, "POSITION_OBSERVATION_CLOCK_INVALID", {
          market,
          openPositionCount: openPositions.length,
        });
      }

      const observations = [];
      for (const position of openPositions) {
        const identity = positionIdentity(position);
        if (!identity || identity.market !== market) {
          return fail(identity?.market && identity.market !== market ? STATUS.WRONG_MARKET : STATUS.WRONG_POSITION,
            identity?.market && identity.market !== market
              ? "POSITION_OBSERVATION_POSITION_MARKET_MISMATCH"
              : "POSITION_OBSERVATION_POSITION_IDENTITY_MISSING", {
              market,
              openPositionCount: openPositions.length,
              provider: lane.provider,
            });
        }
        const matches = positionBindings.filter((binding) => binding?.positionIdentity?.positionId === identity.positionId);
        if (matches.length !== 1) {
          return fail(STATUS.WRONG_POSITION,
            matches.length === 0
              ? "POSITION_OBSERVATION_POSITION_BINDING_MISSING"
              : "POSITION_OBSERVATION_POSITION_BINDING_AMBIGUOUS", {
              market,
              openPositionCount: openPositions.length,
              provider: lane.provider,
            });
        }
        const binding = matches[0];
        const validated = validatePositionBinding({ position, binding, cycleIdentity, accountIdentity });
        if (!validated.ok) {
          return fail(STATUS.WRONG_POSITION, validated.blocker, {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }

        let snapshot;
        try {
          snapshot = await collectSnapshot({
            market,
            symbol: identity.symbol,
            lane,
            nowMs,
            signal,
            collectYahoo,
            collectUpbit,
            collectBitget,
            bitgetClient,
          });
        } catch (error) {
          return fail(STATUS.MISSING, "POSITION_OBSERVATION_PUBLIC_SOURCE_UNAVAILABLE", {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
            diagnostic: { sourceError: String(error?.code ?? error?.message ?? "PUBLIC_SOURCE_FAILED").slice(0, 160) },
          });
        }
        if (!snapshot || snapshot.market !== market) {
          return fail(STATUS.WRONG_MARKET, "POSITION_OBSERVATION_PUBLIC_SOURCE_MARKET_MISMATCH", {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }
        if (snapshot.symbol !== identity.symbol) {
          return fail(STATUS.WRONG_SYMBOL, "POSITION_OBSERVATION_PUBLIC_SOURCE_SYMBOL_MISMATCH", {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }
        if (snapshot.timeframe !== lane.timeframe || providerOf(snapshot) !== lane.provider) {
          return fail(STATUS.INVALID, "POSITION_OBSERVATION_PUBLIC_SOURCE_CONTRACT_MISMATCH", {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }
        const frames = normalizedClosedFrames(snapshot, lane, nowMs);
        if (!frames) {
          return fail(STATUS.INVALID, "POSITION_OBSERVATION_PUBLIC_FRAME_INVALID", {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }
        const selection = selectNewFrames({ position, frames, lane, market, nowMs });
        if (selection.status !== STATUS.PRESENT) {
          return fail(selection.status, selection.blocker, {
            market,
            openPositionCount: openPositions.length,
            provider: lane.provider,
          });
        }
        for (const frame of selection.frames) {
          const observation = buildObservation({
            position,
            binding,
            identity,
            cycleIdentity,
            accountIdentity,
            lane,
            provider: lane.provider,
            frame,
          });
          if (observation) observations.push(observation);
        }
      }

      const ids = observations.map((row) => row.observationId);
      if (new Set(ids).size !== ids.length) {
        return fail(STATUS.INVALID, "POSITION_OBSERVATION_DUPLICATE_FRAME", {
          market,
          openPositionCount: openPositions.length,
          provider: lane.provider,
        });
      }
      observations.sort((left, right) => left.observedAtMs - right.observedAtMs
        || left.positionId.localeCompare(right.positionId));
      return result(STATUS.PRESENT, {
        market,
        openPositionCount: openPositions.length,
        observations,
        sourceType: "PUBLIC_CLOSED_CANDLE",
        provider: lane.provider,
        diagnostic: { reason: observations.length > 0 ? "PUBLIC_FRAMES_PRESENT" : "NO_NEW_CLOSED_FRAME" },
      });
    },
  });
}

export function wrapPaperForwardProviderWithNaturalPositionObservations({ provider, producer } = {}) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") {
    throw new TypeError("canonical Paper public evidence provider is required");
  }
  if (!producer || typeof producer.collect !== "function") {
    throw new TypeError("Natural public Position observation producer is required");
  }
  return Object.freeze({
    async collectPublicEvidence(input = {}) {
      const base = await provider.collectPublicEvidence(input);
      if (base?.status !== "READY" || !Array.isArray(input.openPositions)) return base;
      const produced = await producer.collect(input);
      const diagnostic = Object.freeze({
        schemaVersion: NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_VERSION,
        status: produced.status,
        openPositionCount: produced.openPositionCount,
        observationCount: produced.observationCount,
        blocker: produced.blocker,
        sourceType: produced.sourceType,
        provider: produced.provider,
        publicOnly: true,
        executionAuthority: "NONE",
      });
      if (produced.status !== STATUS.PRESENT) {
        return Object.freeze({
          ...base,
          status: "BLOCKED_DATA",
          candidates: Object.freeze([]),
          exits: Object.freeze([]),
          blocker: produced.blocker ?? "POSITION_OBSERVATION_PRODUCER_BLOCKED",
          positionObservationSource: diagnostic,
        });
      }
      return Object.freeze({
        ...base,
        positionObservations: Object.freeze(produced.observations.map((row) => frozenClone(row))),
        positionObservationSource: diagnostic,
      });
    },
  });
}

export const NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_STATUS = STATUS;

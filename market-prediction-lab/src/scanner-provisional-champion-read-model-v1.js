import { PROVISIONAL_CHAMPION_SAFETY } from "./provisional-champion-selector-v1.js";

export const SCANNER_PROVISIONAL_CHAMPION_READ_MODEL_VERSION = "scanner-provisional-champion-read-model-v1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function unique(values) { return [...new Set(values)].sort(); }

function safety() {
  return Object.freeze({
    ...PROVISIONAL_CHAMPION_SAFETY,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
  });
}

function decision(card, champion, context) {
  const blockers = [];
  const identity = champion.strategyIdentity;
  if (card?.strategyIdentityDigest !== champion.strategyIdentityDigest) blockers.push("STRATEGY_IDENTITY_MISMATCH");
  if (card?.market !== identity.market) blockers.push("MARKET_MISMATCH");
  if (card?.direction !== identity.direction) blockers.push("DIRECTION_MISMATCH");
  if (card?.timeframe !== identity.timeframe) blockers.push("TIMEFRAME_MISMATCH");
  if (!nonEmpty(card?.symbol) || !nonEmpty(card?.observedAt) || !nonEmpty(card?.expiresAt)) blockers.push("MANDATORY_DATA_MISSING");
  if (card?.dataCompleteness !== "COMPLETE") blockers.push("MANDATORY_DATA_INCOMPLETE");

  const now = Date.parse(context.now ?? "");
  const observedAt = Date.parse(card?.observedAt ?? "");
  const expiresAt = Date.parse(card?.expiresAt ?? "");
  if (!Number.isFinite(now) || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
    || observedAt > now || expiresAt <= now) blockers.push("STALE_MANDATORY_DATA");
  if (context.providerAvailable !== true || card?.providerAvailable !== true) blockers.push("PROVIDER_UNAVAILABLE");
  if (!finite(card?.liquidity) || card.liquidity < context.minimumLiquidity) blockers.push("INVALID_LIQUIDITY");
  if (card?.riskEvidence?.status !== "PASS") blockers.push("INVALID_RISK_EVIDENCE");
  if (![card?.entry, card?.stop, card?.target].every(finite)) blockers.push("ENTRY_RISK_PLAN_INCOMPLETE");
  if (!finite(card?.riskReward) || card.riskReward < context.minimumRiskReward) blockers.push("UNACCEPTABLE_RISK_REWARD");

  const resolvedBlockers = unique(blockers);
  if (resolvedBlockers.length > 0) {
    return deepFreeze({
      symbol: card?.symbol ?? null,
      advisoryState: "NO_TRADE",
      blockers: resolvedBlockers,
      championState: "PROVISIONAL",
      strategyIdentityDigest: champion.strategyIdentityDigest,
      safety: safety(),
    });
  }
  return deepFreeze({
    symbol: card.symbol,
    advisoryState: "ADVISORY",
    blockers: [],
    championState: "PROVISIONAL",
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    strategyIdentityDigest: champion.strategyIdentityDigest,
    validationState: "PROVISIONAL_ONLY",
    evidenceState: "HARD_GATES_PASSED",
    market: identity.market,
    direction: identity.direction,
    timeframe: identity.timeframe,
    strategyHealthStatus: card.strategyHealthStatus ?? null,
    regimeCompatibility: card.regimeCompatibility ?? null,
    dataCompleteness: card.dataCompleteness,
    freshness: "CURRENT",
    liquidity: card.liquidity,
    entry: card.entry,
    stop: card.stop,
    target: card.target,
    riskReward: card.riskReward,
    sourceCard: structuredClone(card),
    safety: safety(),
  });
}

export function consumeProvisionalChampionForScanner({ registry, cards = [], context = {} } = {}) {
  const rows = Array.isArray(cards) ? cards : [];
  if (registry == null) {
    return deepFreeze({
      schemaVersion: SCANNER_PROVISIONAL_CHAMPION_READ_MODEL_VERSION,
      status: "NO_TRADE",
      mode: "PROVISIONAL_CHAMPION",
      championState: "UNAVAILABLE",
      cards: [],
      decisions: [],
      blockers: ["CHAMPION_REGISTRY_UNAVAILABLE"],
      safety: safety(),
    });
  }
  if (registry.status === "NONE" && registry.currentProvisionalChampion === "NONE") {
    return Object.freeze({
      schemaVersion: SCANNER_PROVISIONAL_CHAMPION_READ_MODEL_VERSION,
      status: "LEGACY_UNCHANGED",
      mode: "CURRENT_OR_LEGACY",
      championState: "NONE",
      cards: rows,
      decisions: [],
      blockers: [],
      safety: safety(),
    });
  }
  const champion = registry.currentProvisionalChampion;
  const registrySafe = registry.status === "PROVISIONAL_CHAMPION"
    && champion?.championState === "PROVISIONAL"
    && registry.currentValidatedChampion === "NONE"
    && registry.validatedChampion === false
    && registry.profitabilityProven === false
    && registry.liveTradingEligible === false
    && registry.executionAuthority === "NONE"
    && champion?.strategyIdentity != null
    && /^[0-9a-f]{64}$/u.test(champion?.strategyIdentityDigest ?? "");
  if (!registrySafe) {
    return deepFreeze({
      schemaVersion: SCANNER_PROVISIONAL_CHAMPION_READ_MODEL_VERSION,
      status: "NO_TRADE",
      mode: "PROVISIONAL_CHAMPION",
      championState: "INVALID",
      cards: [],
      decisions: [],
      blockers: ["CHAMPION_REGISTRY_SAFETY_INVALID"],
      safety: safety(),
    });
  }

  const resolvedContext = Object.freeze({
    now: context.now ?? null,
    providerAvailable: context.providerAvailable === true,
    minimumLiquidity: finite(context.minimumLiquidity) && context.minimumLiquidity >= 0 ? context.minimumLiquidity : 0,
    minimumRiskReward: finite(context.minimumRiskReward) && context.minimumRiskReward > 0 ? context.minimumRiskReward : 1.5,
  });
  const decisions = rows.map((card) => decision(card, champion, resolvedContext));
  const advisoryCards = decisions.filter((row) => row.advisoryState === "ADVISORY");
  const providerBlocked = resolvedContext.providerAvailable !== true
    || decisions.some((row) => row.blockers.includes("PROVIDER_UNAVAILABLE"));
  return deepFreeze({
    schemaVersion: SCANNER_PROVISIONAL_CHAMPION_READ_MODEL_VERSION,
    status: providerBlocked ? "NO_TRADE" : advisoryCards.length > 0 ? "ADVISORY_CANDIDATES" : "VALID_EMPTY",
    mode: "PROVISIONAL_CHAMPION",
    championState: "PROVISIONAL",
    cards: advisoryCards,
    decisions,
    blockers: providerBlocked ? ["PROVIDER_UNAVAILABLE"] : [],
    safety: safety(),
  });
}

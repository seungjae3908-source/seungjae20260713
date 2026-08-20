export const CANONICAL_SCANNER_PAPER_FORWARD_SOURCE_CONTRACT = Object.freeze({
  version: "canonical-scanner-paper-forward-source-v1",
  publicDataOnly: true,
  simulatedOnly: true,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  orderSubmitted: false,
  exchangeRequestSent: false,
  productionMutationAllowed: false,
  profitabilityClaimAllowed: false,
  explicitZeroStatus: "VALID_NO_TRADE",
});

const DEFAULT_REQUIRED_MARKETS = Object.freeze(["CRYPTO_FUTURES"]);

function freeze(value) { return Object.freeze(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function safetyEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false;
}
function sourceSummary({ market, status, blocker = null, candidateCount = 0, explicitZero = false }) {
  return freeze({
    version: CANONICAL_SCANNER_PAPER_FORWARD_SOURCE_CONTRACT.version,
    market,
    status,
    blocker,
    candidateCount,
    exitCount: 0,
    explicitZero,
    ...CANONICAL_SCANNER_PAPER_FORWARD_SOURCE_CONTRACT,
  });
}
function blockBase(base, market, blocker, sourceStatus) {
  return freeze({
    ...base,
    status: "BLOCKED_DATA",
    candidates: freeze([]),
    exits: freeze([]),
    blocker,
    canonicalScannerSource: sourceSummary({ market, status: sourceStatus, blocker }),
  });
}
function validateCandidate(candidate, market, seen) {
  if (!candidate || typeof candidate !== "object") return "CANONICAL_SCANNER_CANDIDATE_INVALID";
  if (!nonEmpty(candidate?.signal?.signalId)) return "CANONICAL_SCANNER_SIGNAL_ID_REQUIRED";
  if (candidate?.signal?.market !== market) return "CANONICAL_SCANNER_MARKET_MISMATCH";
  if (!safetyEnvelope(candidate)) return "CANONICAL_SCANNER_SAFETY_ENVELOPE_INVALID";
  if (seen.has(candidate.signal.signalId)) return "CANONICAL_SCANNER_DUPLICATE_SIGNAL_ID";
  seen.add(candidate.signal.signalId);
  return null;
}

export function wrapPaperForwardProviderWithCanonicalScannerSource({
  provider,
  source,
  requiredMarkets = DEFAULT_REQUIRED_MARKETS,
} = {}) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") {
    throw new TypeError("base Paper provider is required");
  }
  if (!source || typeof source.collect !== "function") {
    throw new TypeError("canonical Scanner Paper source is required");
  }
  if (!Array.isArray(requiredMarkets) || requiredMarkets.length === 0
    || requiredMarkets.some((market) => !nonEmpty(market))) {
    throw new TypeError("requiredMarkets must be a non-empty market list");
  }
  const required = new Set(requiredMarkets);

  return freeze({
    async collectPublicEvidence(input) {
      const base = await provider.collectPublicEvidence(input);
      const market = input?.market;
      if (!required.has(market) || base?.status !== "READY") return base;

      let scanner;
      try {
        scanner = await source.collect({
          market,
          openPositions: input?.openPositions ?? [],
          signal: input?.signal,
          cycle: input?.cycle,
          attempt: input?.attempt,
        });
      } catch (error) {
        const detail = String(error?.code ?? error?.message ?? "CANONICAL_SCANNER_SOURCE_FAILED").slice(0, 160);
        return blockBase(base, market, `CANONICAL_SCANNER_SOURCE_FAILED:${detail}`, "BLOCKED");
      }

      if (!scanner || typeof scanner !== "object") {
        return blockBase(base, market, "CANONICAL_SCANNER_SOURCE_INVALID", "BLOCKED");
      }
      if (!Array.isArray(scanner.candidates)) {
        return blockBase(base, market, "CANONICAL_SCANNER_CANDIDATES_REQUIRED", "BLOCKED");
      }
      if (Array.isArray(scanner.exits) && scanner.exits.length > 0) {
        return blockBase(base, market, "CANONICAL_SCANNER_EXIT_SOURCE_NOT_AUTHORIZED", "BLOCKED");
      }

      if (scanner.status === "VALID_NO_TRADE") {
        if (scanner.candidates.length !== 0) {
          return blockBase(base, market, "VALID_NO_TRADE_WITH_CANDIDATES_FORBIDDEN", "BLOCKED");
        }
        return freeze({
          ...base,
          candidates: freeze([...(base.candidates ?? [])]),
          exits: freeze([...(base.exits ?? [])]),
          canonicalScannerSource: sourceSummary({
            market,
            status: "VALID_NO_TRADE",
            candidateCount: 0,
            explicitZero: true,
          }),
        });
      }

      if (scanner.status !== "READY") {
        const blocker = nonEmpty(scanner.blocker) ? scanner.blocker : "CANONICAL_SCANNER_SOURCE_BLOCKED";
        return blockBase(base, market, blocker, "BLOCKED");
      }
      if (scanner.candidates.length === 0) {
        return blockBase(base, market, "CANONICAL_SCANNER_READY_WITHOUT_EVIDENCE", "BLOCKED");
      }

      const seen = new Set((base.candidates ?? [])
        .map((candidate) => candidate?.signal?.signalId)
        .filter(nonEmpty));
      for (const candidate of scanner.candidates) {
        const blocker = validateCandidate(candidate, market, seen);
        if (blocker) return blockBase(base, market, blocker, "BLOCKED");
      }

      return freeze({
        ...base,
        candidates: freeze([...(base.candidates ?? []), ...scanner.candidates]),
        exits: freeze([...(base.exits ?? [])]),
        canonicalScannerSource: sourceSummary({
          market,
          status: "READY",
          candidateCount: scanner.candidates.length,
          explicitZero: false,
        }),
      });
    },
  });
}

const PROVIDER_PRIORITY = Object.freeze([
  "REQUIRED_PROVIDER_FAILURE",
  "FALLBACK_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "BAD_RESPONSE",
  "INSUFFICIENT_HISTORY",
  "OPTIONAL_ENRICHMENT_MISSING",
  "FALLBACK_USED",
]);

const REJECT_PRIORITY = Object.freeze([
  "DATA_STALE",
  "MISSING_HISTORY",
  "INVALID_CANDLE",
  "LOW_TURNOVER",
  "LOW_DOLLAR_VOLUME",
  "SPREAD_TOO_WIDE",
  "HARD_RISK_BLOCK",
  "REGIME_MISMATCH",
  "NO_SETUP",
  "SOFT_SCORE_LOW",
  "COST_NOT_EVIDENCED",
  "INSUFFICIENT_SAMPLE",
  "UNCALIBRATED_PROBABILITY",
  "NEGATIVE_NET_EV",
  "EV_UNCERTAIN",
]);

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function rankedReasons(reasons, priority) {
  const order = new Map(priority.map((reason, index) => [reason, index]));
  return unique(reasons).sort((left, right) => (
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
  ));
}

export function primarySecondaryReasons(reasons, priority = REJECT_PRIORITY) {
  const ordered = rankedReasons(reasons, priority);
  return Object.freeze({
    primaryRejectReason: ordered[0] ?? null,
    secondaryRejectReasons: Object.freeze(ordered.slice(1)),
  });
}

export function classifyProviderFailure(error, {
  required = true,
  fallbackAttempted = false,
  fallbackSucceeded = false,
} = {}) {
  if (fallbackSucceeded) return "FALLBACK_USED";
  const status = Number(error?.status ?? error?.details?.status);
  const text = String(error?.code ?? error?.message ?? error ?? "").toUpperCase();
  if (!required || /DART_NOT_CONFIGURED|FINNHUB_NOT_CONFIGURED|OPTIONAL/u.test(text)) {
    return "OPTIONAL_ENRICHMENT_MISSING";
  }
  if (fallbackAttempted) return "FALLBACK_FAILED";
  if (status === 429 || /(?:HTTP_|^|\D)429(?:\D|$)|RATE_LIMIT/u.test(text)) return "RATE_LIMITED";
  if (error?.name === "AbortError" || /TIMEOUT|DEADLINE|ABORT/u.test(text)) return "TIMEOUT";
  if (/INSUFFICIENT|MISSING_HISTORY|NO_CANONICAL_CANDLES/u.test(text)) return "INSUFFICIENT_HISTORY";
  if ((status >= 400 && status <= 599) || /HTTP_[45]\d\d|INVALID_RESPONSE|BAD_RESPONSE/u.test(text)) return "BAD_RESPONSE";
  return "REQUIRED_PROVIDER_FAILURE";
}

export function providerFailureDiagnostic(error, options) {
  const classification = classifyProviderFailure(error, options);
  return Object.freeze({
    classification,
    required: options?.required !== false,
    countsAsRequiredFailure: !["OPTIONAL_ENRICHMENT_MISSING", "FALLBACK_USED"].includes(classification),
  });
}

export function canonicalHardRejectReasons(card) {
  const reasons = [];
  if (!Number.isFinite(card?.price) || card.price <= 0) reasons.push("INVALID_CANDLE");
  if (card?.listingStatus !== "LISTED") reasons.push("HARD_RISK_BLOCK");
  if (card?.dataState === "stale") reasons.push("DATA_STALE");
  if (card?.dataState === "insufficient" || card?.dataState === "unavailable") reasons.push("MISSING_HISTORY");
  if (card?.dataState === "untrusted" || card?.dataQuality?.state === "DATA_UNTRUSTED") reasons.push("HARD_RISK_BLOCK");
  if (card?.dataQuality?.issues?.some((issue) => issue?.severity === "blocking")) reasons.push("HARD_RISK_BLOCK");
  if (Number.isFinite(card?.spreadPercent) && card.spreadPercent > (card?.assetClass === "stock" ? 1 : 0.8)) reasons.push("SPREAD_TOO_WIDE");
  if (Number.isFinite(card?.tradingValue) && card.tradingValue <= 0) reasons.push(card?.market === "US" ? "LOW_DOLLAR_VOLUME" : "LOW_TURNOVER");
  if (Number.isFinite(card?.volume) && card.volume < 0) reasons.push("INVALID_CANDLE");
  return Object.freeze(rankedReasons(reasons, REJECT_PRIORITY));
}

function candidateKey(card) {
  return [
    card?.market ?? "UNKNOWN",
    card?.symbol ?? card?.ticker ?? "UNKNOWN",
    card?.signalId ?? "NO_SIGNAL_ID",
  ].join(":");
}

export function separateInternalAndDisplayCandidates(internalCards = [], displayCards = []) {
  const internal = new Map();
  const display = new Map();
  for (const card of internalCards) internal.set(candidateKey(card), card);
  for (const card of displayCards) display.set(candidateKey(card), card);
  return Object.freeze({
    internalCards: Object.freeze([...internal.values()]),
    displayCards: Object.freeze([...display.values()]),
    internalCandidateCount: internal.size,
    displayCandidateCount: display.size,
    evidencePreserved: [...display.keys()].every((key) => internal.has(key)) && internal.size >= display.size,
  });
}

export function nextCoverageCursor({ cursor, batchLength, totalCount }) {
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const length = Number.isInteger(batchLength) && batchLength >= 0 ? batchLength : 0;
  const total = Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : 0;
  const next = Math.min(total, start + length);
  return next < total ? next : null;
}

function directoryLines(text) {
  return String(text ?? "").replace(/^\uFEFF/u, "").split(/\r?\n/u).filter(Boolean);
}

function usAssetType(name, etf) {
  if (String(etf).toUpperCase() === "Y") return "ETF";
  if (/\bETN\b|EXCHANGE TRADED NOTE/u.test(name)) return "ETN";
  if (/\bREIT\b|REAL ESTATE INVESTMENT TRUST/u.test(name)) return "REIT";
  if (/\bADR\b|AMERICAN DEPOSITARY/u.test(name)) return "ADR";
  return "STOCK";
}

function normalizedUsSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\$/gu, "-");
}

export function parseNasdaqTraderDirectories({ nasdaqText, otherText } = {}) {
  const rows = [];
  const exclusions = {};
  const exclude = (reason) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const parse = (text, exchangeFor) => {
    const lines = directoryLines(text);
    if (lines.length < 2) throw new Error("NASDAQ_TRADER_DIRECTORY_BAD_RESPONSE");
    const headers = lines[0].split("|");
    let rawCount = 0;
    for (const line of lines.slice(1)) {
      if (/^File Creation Time(?::|\|)/u.test(line)) continue;
      rawCount += 1;
      const cells = line.split("|");
      const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
      const symbol = normalizedUsSymbol(row.Symbol ?? row["ACT Symbol"] ?? row["NASDAQ Symbol"]);
      const name = String(row["Security Name"] ?? "").trim();
      if (String(row["Test Issue"] ?? "N").toUpperCase() === "Y") { exclude("TEST_ISSUE"); continue; }
      if (!symbol || !/^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/u.test(symbol)) { exclude("SYMBOL_UNSUPPORTED"); continue; }
      if (!name) { exclude("MISSING_NAME"); continue; }
      if (/\b(?:WARRANTS?|RIGHTS?|UNITS?)\b/iu.test(name)) { exclude("UNSUPPORTED_SECURITY_TYPE"); continue; }
      rows.push({
        ticker: symbol,
        name,
        market: "US",
        currency: "USD",
        assetType: usAssetType(name, row.ETF),
        exchange: exchangeFor(row),
        listingStatus: "LISTED",
        source: "nasdaq-trader-public-directory",
      });
    }
    return rawCount;
  };
  const nasdaqRaw = parse(nasdaqText, () => "NASDAQ");
  const otherRaw = parse(otherText, (row) => ({ A: "NYSE_AMERICAN", N: "NYSE", P: "NYSE_ARCA", Z: "CBOE" }[String(row.Exchange).toUpperCase()] ?? "US"));
  const deduped = new Map();
  for (const row of rows) {
    if (deduped.has(row.ticker)) { exclude("DUPLICATE_SYMBOL"); continue; }
    deduped.set(row.ticker, row);
  }
  const entries = [...deduped.values()].sort((left, right) => left.ticker.localeCompare(right.ticker));
  return Object.freeze({
    source: "nasdaq-trader-public-directory",
    rawTotal: nasdaqRaw + otherRaw,
    eligibleTotal: entries.length,
    entries: Object.freeze(entries),
    exclusionReasons: Object.freeze(exclusions),
    partial: false,
  });
}

function retryable(error) {
  const classification = classifyProviderFailure(error);
  return ["RATE_LIMITED", "TIMEOUT"].includes(classification)
    || Number(error?.status) >= 500;
}

export async function withPublicProviderRetry(operation, {
  maxAttempts = 3,
  baseBackoffMs = 250,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === maxAttempts) throw error;
      const retryAfterMs = Number(error?.retryAfterMs ?? error?.details?.retryAfterMs);
      await sleep(Number.isFinite(retryAfterMs) ? Math.min(30_000, Math.max(0, retryAfterMs)) : baseBackoffMs * attempt);
    }
  }
  throw lastError;
}

export function providerClassificationPriority() {
  return PROVIDER_PRIORITY;
}

export function rejectReasonPriority() {
  return REJECT_PRIORITY;
}
